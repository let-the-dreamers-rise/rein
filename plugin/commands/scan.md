---
description: Scan an agent wallet -- the spending policy its own history supports, what it holds with no on-chain limit, and what it could lose under that policy
argument-hint: <address> [base|base-sepolia|ethereum]
---

Call `rein_scan_wallet` with the address and chain in the arguments below (chain defaults to base; with no address, use "sample" and say it is Rein's made-up example wallet).

Then tell the user, in this order and in plain sentences:

1. What the wallet holds with no on-chain limit on where it can go, and that a signing policy kept off chain (Privy, Turnkey, CDP) would not show up in the scan.
2. What it could lose per hour and per day under the policy its own history supports, and to whom.
3. How many of its recent calls that policy would have refused, and what the refusals were. A refusal of a first-time payee is the policy asking a human, not a bug; say so.
4. What was seen but withheld from the policy for a human to confirm.
5. The caveats the report lists, briefly. Do not claim more than the report does.

Offer to show the full report. Nothing here signs or spends; say that only if asked.

Arguments: $ARGUMENTS
