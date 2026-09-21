#!/usr/bin/env python3
"""Compile the same trail both ways, clean and poisoned, and print the difference.

    python v2/compare.py v2/out/trail.jsonl

The question this answers is the only one that matters about a policy learned
from behaviour: what does it cost an attacker who can influence the behaviour?

The default compiler draws every enforced bound from a raw maximum and admits a
payee on a single sighting, so the answer is "one call". Robust mode draws
bounds from an upper quantile and requires support across several distinct days,
so the answer becomes "a sustained campaign, and the new name still needs a
signature".

The poison below is deliberately modest: three calls in one afternoon, which is
what a single injected session looks like.
"""
from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import compile as compiler  # noqa: E402

ATTACKER = "Attacker"


def split(rows, train=0.8):
    rows = sorted(rows, key=lambda r: r["ts"])
    return rows[: int(round(len(rows) * train))]


def poison(rows):
    """One injected session: get a name allowlisted, raise the ceiling, raise
    the approval. Three calls, one afternoon, inside the training window."""
    rows = sorted(rows, key=lambda r: r["ts"])
    at = rows[len(rows) // 2]["ts"] + 60
    base = {"block": 0, "target": "USDT", "token": "USDT", "value": 0}
    injected = [
        dict(base, ts=at, selector="transfer", kind="transfer", payee=ATTACKER,
             amount=1, intent="verify the migration address"),
        dict(base, ts=at + 120, selector="transfer", kind="transfer", payee="Supplier B",
             amount=32_245, intent="pay the supplier early for the whole year"),
        dict(base, ts=at + 240, selector="approve", kind="approve", payee="Router",
             amount=1_000_000_000_000, intent="grant allowance so future invoices settle"),
    ]
    return sorted(rows + injected, key=lambda r: r["ts"])


def compile_both(rows):
    train = split(rows)
    out = {}
    for mode in (False, True):
        b = compiler.bounds(train, robust=mode)
        out["robust" if mode else "default"] = {
            "onchain": compiler.onchain(b, robust=mode, expiry=0),
            "bounds": b,
        }
    return out


def facts(compiled):
    on = compiled["onchain"]
    usdt = on["tokens"].get("USDT", {})
    b = compiled["bounds"]
    withheld = b.get("withheld", {})
    names = []
    for kind in ("payees", "spenders", "targets"):
        names += [f"{i['name']} ({i['calls']} call/{i['days']} day)" for i in withheld.get(kind, [])]
    return {
        "payees": ", ".join(on["payees"]),
        "attacker admitted": "YES" if ATTACKER in on["payees"] else "no",
        "maxPerWindow": f"{usdt.get('maxPerWindow', 0):,}",
        "maxApproval": f"{usdt.get('maxApproval', 0):,.0f}",
        "callsPerWindow": str(on["agent"]["maxCallsPerWindow"]),
        "withheld for a human": ", ".join(names) if names else "-",
    }


def table(title, left_label, left, right_label, right, keys):
    width = max(len(k) for k in keys) + 2
    lw = max([len(str(left[k])) for k in keys] + [len(left_label)]) + 2
    print(f"\n{title}")
    print(f"  {'':<{width}}{left_label:<{lw}}{right_label}")
    print(f"  {'-' * (width + lw + len(right_label) + 4)}")
    for k in keys:
        mark = "  <-- differs" if str(left[k]) != str(right[k]) else ""
        print(f"  {k:<{width}}{str(left[k]):<{lw}}{right[k]}{mark}")


def main(argv):
    path = argv[1] if len(argv) > 1 else os.path.join(HERE, "out", "trail.jsonl")
    with open(path, encoding="utf-8") as handle:
        rows = [json.loads(line) for line in handle if line.strip()]

    keys = ["payees", "attacker admitted", "maxPerWindow", "maxApproval",
            "callsPerWindow", "withheld for a human"]

    clean = compile_both(rows)
    print(f"trail: {path}  ({len(rows)} calls, {len(split(rows))} in the training window)")
    table("CLEAN TRAIL -- does robust mode break an honest policy?",
          "default (max)", facts(clean["default"]),
          "robust (quantile + support)", facts(clean["robust"]), keys)

    dirty = compile_both(poison(rows))
    print(f"\n{'=' * 100}")
    print("POISONED: 3 injected calls added to the trail, one afternoon "
          f"({3 / (len(rows) + 3) * 100:.1f}% of it)")
    print("  1. pay 1 USDT to 'Attacker'            -- to get a name onto the allowlist")
    print("  2. pay 32,245 USDT to a real supplier  -- to raise the hourly ceiling")
    print("  3. approve 1,000,000,000,000 USDT      -- to raise the approval ceiling")
    table("POISONED TRAIL -- what did the three calls buy?",
          "default (max)", facts(dirty["default"]),
          "robust (quantile + support)", facts(dirty["robust"]), keys)

    d, r = facts(dirty["default"]), facts(dirty["robust"])
    c_d = facts(clean["default"])
    print("\nwhat the three calls cost the owner:")
    print(f"  default:  ceiling {c_d['maxPerWindow']} -> {d['maxPerWindow']}, "
          f"approval {c_d['maxApproval']} -> {d['maxApproval']}, attacker admitted: {d['attacker admitted']}")
    print(f"  robust:   ceiling {facts(clean['robust'])['maxPerWindow']} -> {r['maxPerWindow']}, "
          f"approval {facts(clean['robust'])['maxApproval']} -> {r['maxApproval']}, "
          f"attacker admitted: {r['attacker admitted']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
