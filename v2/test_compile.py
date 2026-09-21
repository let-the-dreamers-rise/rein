#!/usr/bin/env python3
"""Tests for the compiler's two estimators.

    python -m unittest discover -s v2 -p 'test_*.py'

Two properties are worth pinning, and they pull against each other:

  1. robust mode must not break an honest policy. A security control that
     refuses legitimate payments gets turned off in month two, and then it
     protects nothing at all.
  2. robust mode must make a small injected session stop buying anything. The
     policy is learned from behaviour, so an attacker who can influence
     behaviour during the observation window is writing the policy.

The third test is the one that protects the repo's CI: the default path must
stay byte-identical, because the committed policy is reproduced on every push.
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import compile as compiler  # noqa: E402
import compare  # noqa: E402

TRAIL = os.path.join(HERE, "out", "trail.jsonl")


def load():
    with open(TRAIL, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


class Quantile(unittest.TestCase):
    def test_edges(self):
        self.assertEqual(compiler.quantile([], 0.5), 0.0)
        self.assertEqual(compiler.quantile([7], 0.99), 7)
        self.assertEqual(compiler.quantile([0, 10], 0.5), 5)

    def test_max_of_rolling_sums_equals_rolling_max(self):
        # The default path depends on this: rolling_sums was introduced to get
        # the whole distribution, and its maximum must still be the old answer.
        points = [(t * 600, float(t % 7)) for t in range(60)]
        self.assertEqual(max(compiler.rolling_sums(points, 3600)),
                         compiler.rolling_max(points, 3600))


class RejectOutliers(unittest.TestCase):
    def test_too_few_to_judge(self):
        kept, dropped = compiler.reject_outliers([1.0, 1_000_000.0])
        self.assertEqual(dropped, [])  # two points have no shape to be odd against

    def test_small_sample_uses_the_median(self):
        # Five approvals, one poisoned. A 95th percentile of five observations
        # sits between the fourth and fifth and barely moves; the median does.
        kept, dropped = compiler.reject_outliers([500.0, 500.0, 500.0, 500.0, 1e12])
        self.assertEqual(dropped, [1e12])
        self.assertEqual(max(kept), 500.0)

    def test_large_sample_keeps_a_genuine_heavy_tail(self):
        # A payroll hour really is much larger than an ordinary one. Judged
        # against the median it would be thrown away and the ceiling would
        # collapse; judged against the upper tail it survives.
        ordinary = [100.0] * 40
        busy = [3000.0] * 4
        kept, dropped = compiler.reject_outliers(ordinary + busy)
        self.assertEqual(dropped, [])
        self.assertIn(3000.0, kept)

    def test_large_sample_still_rejects_a_spike(self):
        kept, dropped = compiler.reject_outliers([100.0] * 40 + [3000.0] * 4 + [500_000.0])
        self.assertEqual(dropped, [500_000.0])


class CleanTrail(unittest.TestCase):
    def setUp(self):
        self.both = compare.compile_both(load())

    def test_robust_admits_the_same_payees(self):
        self.assertEqual(self.both["default"]["onchain"]["payees"],
                         self.both["robust"]["onchain"]["payees"])

    def test_robust_withholds_nothing_from_an_honest_trail(self):
        withheld = self.both["robust"]["bounds"]["withheld"]
        self.assertEqual([], withheld["payees"])
        self.assertEqual([], withheld["targets"])

    def test_robust_ceiling_stays_close_to_the_default(self):
        d = self.both["default"]["onchain"]["tokens"]["USDT"]["maxPerWindow"]
        r = self.both["robust"]["onchain"]["tokens"]["USDT"]["maxPerWindow"]
        # Tighter, but not so much tighter that honest work starts failing.
        self.assertLessEqual(r, d)
        self.assertGreater(r, d * 0.9)

    def test_robust_does_not_loosen_the_approval_ceiling(self):
        d = self.both["default"]["onchain"]["tokens"]["USDT"]["maxApproval"]
        r = self.both["robust"]["onchain"]["tokens"]["USDT"]["maxApproval"]
        self.assertLessEqual(r, d)


class PoisonedTrail(unittest.TestCase):
    """Three injected calls in one afternoon: 2.6% of the trail."""

    def setUp(self):
        rows = load()
        self.clean = compare.compile_both(rows)
        self.dirty = compare.compile_both(compare.poison(rows))

    def usdt(self, which, mode):
        return which[mode]["onchain"]["tokens"]["USDT"]

    def test_default_admits_the_attacker_on_one_sighting(self):
        self.assertIn(compare.ATTACKER, self.dirty["default"]["onchain"]["payees"])

    def test_default_ceiling_is_moved_by_one_call(self):
        before = self.usdt(self.clean, "default")["maxPerWindow"]
        after = self.usdt(self.dirty, "default")["maxPerWindow"]
        self.assertGreater(after, before * 5)

    def test_default_approval_is_moved_by_one_call(self):
        self.assertGreaterEqual(self.usdt(self.dirty, "default")["maxApproval"], 1e12)

    def test_robust_refuses_the_attacker_and_says_why(self):
        self.assertNotIn(compare.ATTACKER, self.dirty["robust"]["onchain"]["payees"])
        withheld = self.dirty["robust"]["bounds"]["withheld"]["payees"]
        self.assertEqual([compare.ATTACKER], [w["name"] for w in withheld])

    def test_robust_ceiling_is_unmoved(self):
        self.assertEqual(self.usdt(self.clean, "robust")["maxPerWindow"],
                         self.usdt(self.dirty, "robust")["maxPerWindow"])

    def test_robust_approval_is_unmoved(self):
        self.assertEqual(self.usdt(self.clean, "robust")["maxApproval"],
                         self.usdt(self.dirty, "robust")["maxApproval"])


class Evidence(unittest.TestCase):
    def test_each_payee_carries_its_own_count_not_the_total(self):
        # The default path prints one "Pays only A, B, C" line whose evidence is
        # the sum across every payee, so a payee seen once reads as "81 of 81"
        # to whoever signs the policy.
        train = compare.split(load())
        b = compiler.bounds(train, robust=True)
        lines = [s for s in compiler.bound_sentences(b, robust=True)
                 if s["enforced"] == "payee allowlist"]
        counts = {s["text"]: s["evidence"]["fired on"] for s in lines}
        self.assertGreater(len(counts), 1)
        self.assertNotEqual(len(set(counts.values())), 1)  # not all the same number
        self.assertEqual(counts["Pays Payroll"], b["payees"]["Payroll"])


class DefaultUnchanged(unittest.TestCase):
    def test_committed_policy_still_reproduces(self):
        # The repo's CI fails if the compiled policy does not reproduce byte for
        # byte. Robust mode must never touch that path.
        train = compare.split(load())
        b = compiler.bounds(train, robust=False)
        with open(os.path.join(HERE, "out", "policy.json"), encoding="utf-8") as handle:
            committed = json.load(handle)
        self.assertEqual(committed["onchain"], compiler.onchain(b, robust=False, expiry=0))


if __name__ == "__main__":
    unittest.main()
