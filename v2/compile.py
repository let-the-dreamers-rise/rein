#!/usr/bin/env python3
"""Compile a Rein policy from an agent's own intent trail.

Input: the trail `scripts/v2/demo.js` exports from the chain, one call per
line, decoded: when, which contract, which function, which token, who was
paid, how much, and the instruction behind it.

Output, in --out:

  policy.json   what goes on chain: allowlists, windows, ceilings, and the
                evidence behind each, plus the sentences and the split
  policy.md     the same policy as a page a person reads before signing

Two kinds of sentence come out, and they are labelled:

  bounds    what the agent never exceeded in the training window, with
            headroom. These map one-to-one onto Rein's on-chain policy.
  learned   conditional habits found by the nyaya synthesiser ("pays
            Payroll at the start of the month, in the morning"). Rein's
            contract cannot enforce time or per-payee amounts today, so
            these are marked monitor-only: they are what a guardian watches.

The trail is split in time. Bounds and rules come from the first part; the
last part is held out and replayed on chain by the demo script, so the
coverage number is measured on calls the compiler never saw.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
NYAYA = os.environ.get("NYAYA_PATH", os.path.join(HERE, "..", "..", "nyaya"))
sys.path.insert(0, NYAYA)
try:
    from nyaya import synthesis
except ImportError:  # pragma: no cover
    sys.exit("nyaya not found: set NYAYA_PATH to a checkout of github.com/let-the-dreamers-rise/nyaya")

WINDOW = 3600
HEADROOM = 1.25
MIN_SUPPORT = 4
MIN_PRECISION = 0.9

# --- robust mode (--robust) -------------------------------------------------
#
# The default estimator for every enforced bound is a raw extremum: the largest
# amount, the largest hour, the largest approval the agent was ever seen to
# make. A raw max is the worst available estimator here, because the policy is
# learned from behaviour and behaviour is what an attacker controls. One
# anomalous call -- injected, or merely unusual -- sets the ceiling for good,
# and a longer observation window does not dilute it. Measured on the committed
# trail: one call takes the hourly ceiling from 4,002 to 40,307.
#
# The allowlists are worse still: the counts are computed and then discarded by
# `sorted(set(...))`, so a single observation permanently admits a payee.
#
# Robust mode changes three things and nothing else:
#
#   1. bounds come from an upper quantile of the observations rather than the
#      maximum, so moving a ceiling costs a share of the window rather than one
#      call;
#   2. nothing reaches an allowlist without support across several distinct
#      days, so a single burst cannot admit a principal;
#   3. whatever fails those tests is not silently dropped -- it is reported as
#      withheld, for a human to confirm by hand. Which is the part that actually
#      survives a patient attacker.
ROBUST_QUANTILE = 0.99
APPROVAL_QUANTILE = 0.95
MIN_CALLS_ONCHAIN = 4
MIN_DAYS_ONCHAIN = 3
DEFAULT_EXPIRY_DAYS = 90

# A quantile is not enough on its own, and finding that out is worth recording.
# Approvals are rare -- four of them in the committed trail -- and the 95th
# percentile of five observations sits between the fourth and the fifth, so a
# single poisoned approval of a trillion still dragged the ceiling to 800
# billion. Quantiles resist contamination in proportion to sample size, and the
# samples that matter most here are the smallest ones.
#
# So outliers are rejected explicitly first, against the median, which needs no
# sample size to be meaningful. Anything more than OUTLIER_FACTOR times the
# median is not used to draw a line -- and it is not silently discarded either:
# it is reported as withheld, because an unusually large hour is either an
# attack or a real quarter-end, and only the owner knows which.
#
# One rule does not fit both distributions, and pretending otherwise is how a
# security control ends up refusing honest work. Hourly totals are heavy-tailed
# by nature -- a payroll hour really is ten times an ordinary one -- so judging
# them against the median rejects the busiest legitimate hours and collapses the
# ceiling. Approvals are a handful of observations where no tail exists to
# measure. So: judge against the upper tail when there is enough data to have
# one, and against the median when there is not.
OUTLIER_FACTOR = 10.0   # small samples, measured against the median
TAIL_FACTOR = 3.0       # larger samples, measured against the 95th percentile
TAIL_MIN_SAMPLES = 10


# --- bands: the vocabulary the synthesiser is allowed to speak -------------

def _when(ts):
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc)


def band_hour(ts):
    h = _when(ts).hour
    return "night" if h < 6 else "morning" if h < 12 else "afternoon" if h < 18 else "evening"


def band_day(ts):
    d = _when(ts).day
    return "start of the month" if d <= 3 else "first half of the month" if d <= 15 else "second half of the month"


def weekday(ts):
    return _when(ts).strftime("%A")


def band_amount(a):
    return "under 100" if a < 100 else "100 to 500" if a < 500 else "500 to 2,000" if a < 2000 else "2,000 and over"


def money(x):
    return f"{x:,.0f}" if float(x).is_integer() else f"{x:,.2f}"


# --- bounds: what the agent never exceeded ----------------------------------

def rolling_max(points, window):
    """Largest sum of `value` over any span of `window` seconds. Points are (ts, value)."""
    points = sorted(points)
    best = 0.0
    total = 0.0
    lo = 0
    for hi, (ts, value) in enumerate(points):
        total += value
        while points[lo][0] <= ts - window:
            total -= points[lo][1]
            lo += 1
        best = max(best, total)
    return best


def rolling_sums(points, window):
    """Every window total, not only the largest. `rolling_max` is max of these."""
    points = sorted(points)
    totals = []
    total = 0.0
    lo = 0
    for ts, value in points:
        total += value
        while points[lo][0] <= ts - window:
            total -= points[lo][1]
            lo += 1
        totals.append(total)
    return totals


def quantile(values, q):
    """Linear-interpolated quantile. Empty is zero; one value is that value."""
    xs = sorted(values)
    if not xs:
        return 0.0
    if len(xs) == 1:
        return xs[0]
    pos = q * (len(xs) - 1)
    lo = math.floor(pos)
    hi = math.ceil(pos)
    if lo == hi:
        return xs[int(pos)]
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)


def reject_outliers(values, factor=OUTLIER_FACTOR):
    """Split observations into those that may draw a line and those too large to.

    The median is the reference because it is the one summary a single extreme
    observation cannot move. Under three observations nothing is rejected --
    there is no shape to be an outlier against yet, and refusing to guess is
    better than guessing confidently from two points.
    """
    positive = sorted(v for v in values if v > 0)
    if len(positive) < 3:
        return list(values), []
    if len(positive) >= TAIL_MIN_SAMPLES:
        limit = quantile(positive, 0.95) * TAIL_FACTOR
    else:
        limit = quantile(positive, 0.5) * factor
    if limit <= 0:
        return list(values), []
    kept = [v for v in values if v <= limit]
    dropped = [v for v in values if v > limit]
    # If everything looks extreme relative to the median, the median is not
    # telling us anything useful; keep the lot rather than bound on nothing.
    return (kept or list(values)), dropped


def support_by(rows, key):
    """Per distinct value: how many calls, and across how many distinct days.

    Days matter more than calls. A burst of twenty payments in one afternoon is
    one decision an attacker made once; the same twenty spread over three weeks
    is a habit. Counting calls alone lets a single injected session buy its way
    onto an allowlist.
    """
    calls = collections.Counter()
    days = collections.defaultdict(set)
    for r in rows:
        value = r[key]
        calls[value] += 1
        days[value].add(_when(r["ts"]).date())
    return calls, {k: len(v) for k, v in days.items()}


def _admit(calls, days):
    """Split principals into those the policy may enforce and those a human
    must confirm. Returns (admitted, withheld) where withheld carries counts."""
    admitted, withheld = [], []
    for value in sorted(calls):
        if calls[value] >= MIN_CALLS_ONCHAIN and days.get(value, 0) >= MIN_DAYS_ONCHAIN:
            admitted.append(value)
        else:
            withheld.append({"name": value, "calls": calls[value], "days": days.get(value, 0)})
    return admitted, withheld


def bounds(rows, robust=False):
    moves = [r for r in rows if r["kind"] in ("transfer", "transferFrom")]
    approvals = [r for r in rows if r["kind"] == "approve"]
    targets = collections.Counter(r["target"] for r in rows)
    selectors = collections.defaultdict(collections.Counter)
    for r in rows:
        selectors[r["target"]][r["selector"]] += 1
    payees = collections.Counter(r["payee"] for r in moves)
    spenders = collections.Counter(r["payee"] for r in approvals)
    tokens = {}
    outliers = {}
    for token in sorted({r["token"] for r in rows if r["token"]}):
        t_moves = [r for r in moves if r["token"] == token]
        t_appr = [r for r in approvals if r["token"] == token]
        amounts = [float(r["amount"]) for r in t_moves]
        appr_amounts = [float(r["amount"]) for r in t_appr]
        hourly = rolling_sums([(r["ts"], float(r["amount"])) for r in t_moves], WINDOW)
        hour_max = max(hourly) if hourly else 0.0

        if robust:
            # The ceiling comes from the 99th percentile of the hours the agent
            # actually worked, after the hours too large to be typical have been
            # set aside -- so neither one outlying hour nor a handful of them
            # defines the line.
            hourly_kept, hourly_out = reject_outliers(hourly)
            amounts_kept, amounts_out = reject_outliers(amounts)
            appr_kept, appr_out = reject_outliers(appr_amounts)
            outliers[token] = {"hours": len(hourly_out), "payments": len(amounts_out),
                               "approvals": len(appr_out),
                               "largest_ignored": max(hourly_out + amounts_out + appr_out, default=0.0)}
            hour_stat = quantile(hourly_kept, ROBUST_QUANTILE)
            per_call = quantile(amounts_kept, ROBUST_QUANTILE)
            appr_amounts = appr_kept
            # An approval is a standing invitation to be drained, so it gets a
            # tighter quantile than a payment does, and it is refused outright
            # unless approving is a settled habit rather than a one-off.
            #
            # No headroom, deliberately. A spend window needs slack because the
            # agent cannot control how its hour lines up with the window; an
            # approval does not, because `approve()` sets an absolute figure and
            # the agent can always ask for exactly the amount it needs. Headroom
            # here would only widen the standing invitation.
            approval = (math.ceil(quantile(appr_amounts, APPROVAL_QUANTILE))
                        if len(t_appr) >= MIN_CALLS_ONCHAIN else 0.0)
        else:
            hour_stat = hour_max
            per_call = max(amounts, default=0.0)
            approval = max(appr_amounts, default=0.0)

        tokens[token] = {
            "moves": len(t_moves),
            "max_per_call": per_call,
            # Always the true observed maximum, whatever the ceiling is drawn
            # from: the sentence a human reads should say what really happened.
            "max_per_hour": hour_max,
            "ceiling_per_hour": math.ceil(hour_stat * HEADROOM) if t_moves else 0,
            "approvals": len(t_appr),
            "max_approval": approval,
        }

    call_points = [(r["ts"], 1.0) for r in rows]
    if robust:
        calls_per_hour = int(quantile(reject_outliers(rolling_sums(call_points, WINDOW))[0], ROBUST_QUANTILE))
        native_max = quantile(reject_outliers([float(r.get("value") or 0) for r in rows])[0], ROBUST_QUANTILE)
    else:
        calls_per_hour = int(rolling_max(call_points, WINDOW))
        native_max = max([float(r.get("value") or 0) for r in rows], default=0.0)

    b = {
        "calls": len(rows),
        "targets": dict(targets),
        "selectors": {t: dict(c) for t, c in selectors.items()},
        "payees": dict(payees),
        "spenders": dict(spenders),
        "tokens": tokens,
        "calls_per_hour": calls_per_hour,
        "calls_cap": math.ceil(calls_per_hour * 1.5),
        "native_max": native_max,
        "intents": sum(1 for r in rows if r.get("intent")),
    }
    if robust:
        b["support"], b["admitted"], b["withheld"] = _principals(rows, moves, approvals, selectors)
        b["outliers"] = outliers
    return b


def _principals(rows, moves, approvals, selectors):
    """Who and what has earned a place in an enforced policy, and who has not."""
    support, admitted, withheld = {}, {}, {}

    for label, rowset, key in (("targets", rows, "target"), ("payees", moves, "payee"),
                               ("spenders", approvals, "payee")):
        calls, days = support_by(rowset, key)
        support[label] = {v: {"calls": calls[v], "days": days.get(v, 0)} for v in calls}
        admitted[label], withheld[label] = _admit(calls, days)

    sel_admitted, sel_withheld = {}, []
    for target, counts in selectors.items():
        rows_for_target = [r for r in rows if r["target"] == target]
        calls, days = support_by(rows_for_target, "selector")
        keep, drop = _admit(calls, days)
        if keep:
            sel_admitted[target] = keep
        for d in drop:
            sel_withheld.append(dict(d, target=target))
    admitted["selectors"] = sel_admitted
    withheld["selectors"] = sel_withheld

    return support, admitted, withheld


# --- learned: the synthesiser over the same trail ---------------------------

def _context(r):
    return {"hour": band_hour(r["ts"]), "day": band_day(r["ts"]), "weekday": weekday(r["ts"]),
            "token": r["token"] or "-"}


def examples_payee(rows):
    out = []
    for r in rows:
        if r["kind"] not in ("transfer", "transferFrom"):
            continue
        obs = dict(_context(r), self="pay", amount=band_amount(float(r["amount"])))
        out.append((obs, r["payee"]))
    return out


def examples_amount(rows):
    out = []
    for r in rows:
        if r["kind"] not in ("transfer", "transferFrom"):
            continue
        obs = dict(_context(r), self=r["payee"])
        out.append((obs, band_amount(float(r["amount"]))))
    return out


def _phrase(name, value):
    if name == "hour":
        return f"in the {value}"
    if name == "day":
        return f"at the {value}" if value.startswith("start") else f"in the {value}"
    if name == "weekday":
        return f"on {value}s"
    if name == "amount":
        return f"when the amount is {value}"
    if name == "token":
        return f"in {value}"
    return f"when {name} is {value}"


def _phrases(rule):
    return [_phrase(n, v) for n, v in rule.conditions if n != "self"]


def render_payee(rule, support, precision):
    tail = ", ".join(_phrases(rule))
    text = f"Pays {rule.outcome}" + (f" {tail}" if tail else "")
    return _sentence(text, support, precision, rule, "payee")


def render_amount(rule, support, precision):
    self_ = dict(rule.conditions)["self"]
    tail = ", ".join(_phrases(rule))
    text = f"{self_} receives {rule.outcome}" + (f" {tail}" if tail else "")
    return _sentence(text, support, precision, rule, "amount")


def _sentence(text, support, precision, rule, predicts):
    # `rule` is the machine-readable form a guardian evaluates (client/monitor.js):
    # the sentence fires when every condition holds, and is broken when it fires
    # and the outcome differs. Bands are the ones defined at the top of this file.
    return {"text": text, "kind": "learned", "enforced": "monitor only",
            "evidence": {"fired on": int(support), "right": int(round(precision * support))},
            "rule": {"conditions": [[n, v] for n, v in rule.conditions], "predicts": predicts,
                     "outcome": rule.outcome}}


def learned(rows):
    out = []
    for examples, render in ((examples_payee(rows), render_payee), (examples_amount(rows), render_amount)):
        if not examples:
            continue
        for rule in synthesis.synthesise(examples, 3, MIN_SUPPORT, MIN_PRECISION):
            # Separate-and-conquer scores each rule on what earlier rules left
            # behind; a person reads the sentence alone, so re-score on everything.
            support, precision = synthesis._score(examples, rule.conditions, rule.outcome)
            if precision < MIN_PRECISION or support < MIN_SUPPORT:
                continue
            if len(rule.conditions) <= 1:  # only `self`: no condition, no habit
                continue
            out.append(render(rule, support, precision))
    return sorted(out, key=lambda s: -s["evidence"]["fired on"])


# --- the policy --------------------------------------------------------------

def bound_sentences(b, robust=False):
    n = b["calls"]
    ev = lambda k: {"fired on": k, "right": k}  # noqa: E731
    out = []
    out.append({"text": "Calls only " + ", ".join(sorted(b["targets"])), "kind": "bound",
                "enforced": "target allowlist", "evidence": ev(n), "key": "targets"})
    for target, sels in sorted(b["selectors"].items()):
        k = sum(sels.values())
        out.append({"text": f"On {target}, calls only " + ", ".join(sorted(sels)), "kind": "bound",
                    "enforced": "selector allowlist", "evidence": ev(k), "key": f"selectors:{target}"})
    if robust:
        # One sentence per payee, carrying that payee's OWN support.
        #
        # The default path prints a single "Pays only A, B, C" line whose
        # evidence is `sum(b["payees"].values())` -- the total across every
        # payee. So a payee observed once renders to the human signing the
        # policy as "81 of 81". The evidence column is the product; a number
        # that does not belong to the claim beside it is worse than no number.
        for label, key in (("Pays", "payees"), ("Approves", "spenders")):
            for name in b["admitted"][key]:
                s = b["support"][key][name]
                out.append({"text": f"{label} {name}", "kind": "bound",
                            "enforced": "payee allowlist", "evidence": ev(s["calls"]),
                            "days": s["days"], "key": f"{key}:{name}"})
    else:
        moves = sum(b["payees"].values())
        if moves:
            out.append({"text": "Pays only " + ", ".join(sorted(b["payees"])), "kind": "bound",
                        "enforced": "payee allowlist", "evidence": ev(moves), "key": "payees"})
        appr = sum(b["spenders"].values())
        if appr:
            out.append({"text": "Approves only " + ", ".join(sorted(b["spenders"])), "kind": "bound",
                        "enforced": "payee allowlist", "evidence": ev(appr), "key": "spenders"})
    for token, t in sorted(b["tokens"].items()):
        if t["moves"]:
            out.append({"text": f"Never moves more than {money(t['max_per_hour'])} {token} in any hour; "
                                f"ceiling {money(t['ceiling_per_hour'])} with {int((HEADROOM - 1) * 100)}% headroom",
                        "kind": "bound", "enforced": "rolling spend window", "evidence": ev(t["moves"]),
                        "key": f"window:{token}"})
        out.append({"text": (f"Never approves more than {money(t['max_approval'])} {token}" if t["approvals"]
                             else f"Never approves any {token}"),
                    "kind": "bound", "enforced": "approval ceiling",
                    "evidence": ev(t["approvals"] if t["approvals"] else n), "key": f"approval:{token}"})
    out.append({"text": f"Makes at most {b['calls_per_hour']} calls in an hour; cap {b['calls_cap']}",
                "kind": "bound", "enforced": "call rate", "evidence": ev(n), "key": "rate"})
    if b["native_max"] == 0:
        out.append({"text": "Never sends native value", "kind": "bound", "enforced": "native ceiling of zero",
                    "evidence": ev(n), "key": "native"})
    out.append({"text": "Every call carries the instruction behind it", "kind": "bound",
                "enforced": "intent required", "evidence": ev(b["intents"]), "key": "intent"})
    return out


def onchain(b, robust=False, expiry=0):
    if robust:
        targets = b["admitted"]["targets"]
        selectors = b["admitted"]["selectors"]
        payees = sorted(set(b["admitted"]["payees"]) | set(b["admitted"]["spenders"]))
    else:
        targets = sorted(b["targets"])
        selectors = {t: sorted(s) for t, s in b["selectors"].items()}
        payees = sorted(set(b["payees"]) | set(b["spenders"]))
    return {
        "agent": {"windowSeconds": WINDOW, "maxCallsPerWindow": max(1, b["calls_cap"]),
                  "maxNativePerCall": 0, "maxNativePerWindow": 0, "requireIntent": True,
                  "expiry": expiry},
        "targets": targets,
        "selectors": selectors,
        "payees": payees,
        "tokens": {t: {"windowSeconds": WINDOW, "maxPerWindow": v["ceiling_per_hour"], "maxApproval": v["max_approval"]}
                   for t, v in b["tokens"].items() if v["moves"] or v["approvals"]},
    }


def markdown(policy):
    lines = ["# The compiled policy", "",
             f"Compiled from {policy['split']['train']} shadow-mode calls; {policy['split']['heldout']} later calls held out for measurement.",
             "", "| what the agent does | evidence | enforced by |", "|---|---|---|"]
    for s in policy["sentences"]:
        e = s["evidence"]
        lines.append(f"| {s['text']} | {e['right']} of {e['fired on']} | {s['enforced']} |")
    lines += ["", "## On chain", "", "```json", json.dumps(policy["onchain"], indent=2), "```", "",
              "Learned sentences marked *monitor only* are habits the synthesiser found that the",
              "contract cannot enforce today (time of day, per-payee amounts). They are what a",
              "guardian watches for, and the honest boundary of what v2 can promise."]

    withheld = policy.get("withheld")
    if withheld:
        rows = []
        for name in sorted(withheld):
            for item in withheld[name]:
                what = f"{item['target']}.{item['name']}" if "target" in item else item["name"]
                rows.append(f"| {what} | {name} | {item['calls']} | {item['days']} |")
        if rows:
            lines += ["", "## Withheld, pending a human", "",
                      "Seen in the trail, and **not** in the policy above: too few calls, or too few",
                      "distinct days, to tell a habit apart from a single decision somebody made once.",
                      "A policy learned from behaviour is written by whoever controls behaviour, so a",
                      "principal that appears rarely is exactly the one that should cost a signature",
                      "rather than being admitted silently.", "",
                      f"Admitted automatically at {MIN_CALLS_ONCHAIN}+ calls across {MIN_DAYS_ONCHAIN}+ distinct days.", "",
                      "| what | kind | calls | days |", "|---|---|---|---|"] + rows
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("trail", nargs="?")
    ap.add_argument("--train", type=float, default=0.8, help="share of the trail, in time order, to compile from")
    ap.add_argument("--out", default=os.path.join(HERE, "out"))
    ap.add_argument("--robust", action="store_true",
                    help="draw bounds from an upper quantile instead of the maximum, require support "
                         "across several distinct days before anything is allowlisted, and report what "
                         "was withheld for a human to confirm")
    ap.add_argument("--expiry-days", type=int, default=None,
                    help="how long the compiled policy is good for; default 0 (never), "
                         f"or {DEFAULT_EXPIRY_DAYS} days under --robust")
    ap.add_argument("--check", action="store_true", help="exit 0 if python and nyaya are usable, without compiling")
    args = ap.parse_args(argv)
    if args.check:
        print(f"compiler ok: python {sys.version.split()[0]}, nyaya from {os.path.dirname(synthesis.__file__)}")
        return 0
    if not args.trail:
        ap.error("a trail file is required (or --check)")

    with open(args.trail, encoding="utf-8") as handle:
        rows = [json.loads(line) for line in handle if line.strip()]
    rows.sort(key=lambda r: r["ts"])
    cut = int(round(len(rows) * args.train))
    train, heldout = rows[:cut], rows[cut:]

    # A policy compiled from the past stops describing the present. Under
    # --robust it lapses on its own, so somebody has to look at it again;
    # `expiry: 0` is a decision never to revisit, and it is the wrong default
    # for a business that hires suppliers.
    expiry_days = args.expiry_days if args.expiry_days is not None else (DEFAULT_EXPIRY_DAYS if args.robust else 0)
    expiry = int(train[-1]["ts"] + expiry_days * 86400) if (expiry_days and train) else 0

    b = bounds(train, robust=args.robust)
    sentences = bound_sentences(b, robust=args.robust) + learned(train)
    policy = {"split": {"train": len(train), "heldout": len(heldout), "cut_index": cut},
              "window_seconds": WINDOW, "headroom": HEADROOM,
              "bounds": b, "onchain": onchain(b, robust=args.robust, expiry=expiry),
              "sentences": sentences}
    if args.robust:
        policy["estimator"] = {"bounds": f"quantile {ROBUST_QUANTILE}", "approvals": f"quantile {APPROVAL_QUANTILE}",
                               "min_calls": MIN_CALLS_ONCHAIN, "min_days": MIN_DAYS_ONCHAIN,
                               "expiry_days": expiry_days}
        policy["withheld"] = b["withheld"]

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "policy.json"), "w", encoding="utf-8") as handle:
        json.dump(policy, handle, indent=1)
    with open(os.path.join(args.out, "policy.md"), "w", encoding="utf-8") as handle:
        handle.write(markdown(policy))

    print(f"  compiled from {len(train)} calls, {len(heldout)} held out")
    for s in sentences:
        e = s["evidence"]
        print(f"  {s['text']:<78} {e['right']:>4} of {e['fired on']:<4} {s['enforced']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
