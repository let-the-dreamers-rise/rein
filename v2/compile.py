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


def bounds(rows):
    moves = [r for r in rows if r["kind"] in ("transfer", "transferFrom")]
    approvals = [r for r in rows if r["kind"] == "approve"]
    targets = collections.Counter(r["target"] for r in rows)
    selectors = collections.defaultdict(collections.Counter)
    for r in rows:
        selectors[r["target"]][r["selector"]] += 1
    payees = collections.Counter(r["payee"] for r in moves)
    spenders = collections.Counter(r["payee"] for r in approvals)
    tokens = {}
    for token in sorted({r["token"] for r in rows if r["token"]}):
        t_moves = [r for r in moves if r["token"] == token]
        t_appr = [r for r in approvals if r["token"] == token]
        hour_max = rolling_max([(r["ts"], float(r["amount"])) for r in t_moves], WINDOW)
        tokens[token] = {
            "moves": len(t_moves),
            "max_per_call": max([float(r["amount"]) for r in t_moves], default=0.0),
            "max_per_hour": hour_max,
            "ceiling_per_hour": math.ceil(hour_max * HEADROOM) if t_moves else 0,
            "approvals": len(t_appr),
            "max_approval": max([float(r["amount"]) for r in t_appr], default=0.0),
        }
    calls_per_hour = int(rolling_max([(r["ts"], 1.0) for r in rows], WINDOW))
    return {
        "calls": len(rows),
        "targets": dict(targets),
        "selectors": {t: dict(c) for t, c in selectors.items()},
        "payees": dict(payees),
        "spenders": dict(spenders),
        "tokens": tokens,
        "calls_per_hour": calls_per_hour,
        "calls_cap": math.ceil(calls_per_hour * 1.5),
        "native_max": max([float(r.get("value") or 0) for r in rows], default=0.0),
        "intents": sum(1 for r in rows if r.get("intent")),
    }


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
    return _sentence(text, support, precision)


def render_amount(rule, support, precision):
    self_ = dict(rule.conditions)["self"]
    tail = ", ".join(_phrases(rule))
    text = f"{self_} receives {rule.outcome}" + (f" {tail}" if tail else "")
    return _sentence(text, support, precision)


def _sentence(text, support, precision):
    return {"text": text, "kind": "learned", "enforced": "monitor only",
            "evidence": {"fired on": int(support), "right": int(round(precision * support))}}


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

def bound_sentences(b):
    n = b["calls"]
    ev = lambda k: {"fired on": k, "right": k}  # noqa: E731
    out = []
    out.append({"text": "Calls only " + ", ".join(sorted(b["targets"])), "kind": "bound",
                "enforced": "target allowlist", "evidence": ev(n), "key": "targets"})
    for target, sels in sorted(b["selectors"].items()):
        k = sum(sels.values())
        out.append({"text": f"On {target}, calls only " + ", ".join(sorted(sels)), "kind": "bound",
                    "enforced": "selector allowlist", "evidence": ev(k), "key": f"selectors:{target}"})
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


def onchain(b):
    return {
        "agent": {"windowSeconds": WINDOW, "maxCallsPerWindow": max(1, b["calls_cap"]),
                  "maxNativePerCall": 0, "maxNativePerWindow": 0, "requireIntent": True, "expiry": 0},
        "targets": sorted(b["targets"]),
        "selectors": {t: sorted(s) for t, s in b["selectors"].items()},
        "payees": sorted(set(b["payees"]) | set(b["spenders"])),
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
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("trail")
    ap.add_argument("--train", type=float, default=0.8, help="share of the trail, in time order, to compile from")
    ap.add_argument("--out", default=os.path.join(HERE, "out"))
    args = ap.parse_args(argv)

    with open(args.trail, encoding="utf-8") as handle:
        rows = [json.loads(line) for line in handle if line.strip()]
    rows.sort(key=lambda r: r["ts"])
    cut = int(round(len(rows) * args.train))
    train, heldout = rows[:cut], rows[cut:]

    b = bounds(train)
    sentences = bound_sentences(b) + learned(train)
    policy = {"split": {"train": len(train), "heldout": len(heldout), "cut_index": cut},
              "window_seconds": WINDOW, "headroom": HEADROOM,
              "bounds": b, "onchain": onchain(b), "sentences": sentences}

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
