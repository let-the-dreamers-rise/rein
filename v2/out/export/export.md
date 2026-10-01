# The compiled policy, exported

10 bounds and 4 learned habits compiled by Rein v2. The bounds go into the wallet you already use; the table says what each engine can hold and what falls back to Rein's own account, its guardian, or `rein watch`.

| bound | Turnkey | Coinbase CDP | Privy |
|---|---|---|---|
| target allowlist | yes | yes | yes |
| selector allowlist | yes (data[0..10]) | yes with ABI, else contract only | yes with ABI |
| payee allowlist | yes (after the ABI upload) | yes (evmData) | yes (calldata) |
| per-transaction cap | yes | yes | yes |
| rolling spend window | yes (velocity controls; Rein does not write them yet) | no: per transaction only | yes (aggregation, signing requests only) |
| approval ceiling | yes | yes | yes |
| call rate | no | no | no (sum only) |
| native ceiling of zero | yes | yes | yes |
| intent required | no | no | no |
| refusal code to the agent before gas | no (deny) | no (reject) | no (deny) |
| monitor-only habits | no | no | no: guardian stays with Rein |

Each file is an ordered list of API requests: run them in order, filling each `{{…}}` with your own id or with what an earlier step returned. Endpoints, field names and value formats were checked against each vendor's SDK source and API spec (September 2026). They have not yet been run against the live APIs; Privy's user-operation rules for smart wallets are the least certain part.
