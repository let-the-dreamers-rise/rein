---
description: Scan an agent wallet -- the spending policy its own history supports, what it holds with no on-chain limit, and what it could lose under that policy
argument-hint: <address> [base|base-sepolia|ethereum]
---

Call `rein_scan_wallet` with the address and chain in the arguments below (chain defaults to base; with no address, use "sample" and say it is Rein's made-up example wallet).

Then tell the user, in this order and in plain sentences:

1. What the wallet holds with no on-chain limit on where it can go, and that a signing policy kept off chain (Privy, Turnkey, CDP) would not show up in the scan.
2. What it could lose per hour and per day under the policy its own history supports, and to whom.
3. How many of its recent calls that policy would have refused, and what the refusals were. A refusal of a first-time payee is the policy asking a human, not a bug; say so.
4. What the compiler saw but withheld from the policy for a human to confirm (the report's `withheld` list). If that list is empty, say nothing was withheld; do not repeat the refusals from step 3 here.
5. The caveats the report lists, briefly. Do not claim more than the report does.

6. One line on what they can do next, for a real wallet: `npx rein-wallet scan <address> --out report` writes this policy as Privy, Turnkey and Coinbase CDP requests, `rein apply report/export/<privy|turnkey|coinbase>.json` puts it on that wallet engine, and `rein watch <address> --webhook <Slack URL>` alerts when the wallet steps outside it.

Offer to show the full report. Nothing here signs or spends; say that only if asked.

Arguments: $ARGUMENTS
