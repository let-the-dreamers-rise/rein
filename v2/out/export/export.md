# The compiled policy, exported

10 bounds and 4 learned habits compiled by Rein v2. The bounds go into the wallet you already use; the table says what each engine can hold and what falls back to Rein's own account or its guardian.

| bound | Turnkey | Coinbase CDP | Privy |
|---|---|---|---|
| target allowlist | yes | yes | yes |
| selector allowlist | yes (data[0..4]) | yes with ABI, else contract only | yes with ABI |
| payee allowlist | yes (contract_call_args) | yes (evmData) | yes (calldata) |
| rolling spend window | no: stateless; per-call only | no: per-call ceiling instead | yes (stateful aggregation) |
| approval ceiling | yes | yes | yes |
| call rate | no | no | no (sum only) |
| native ceiling of zero | yes | yes | yes |
| intent required | no | no | no |
| refusal code to the agent before gas | no (deny) | no (reject) | no (deny) |
| monitor-only habits | no | no | no: guardian stays with Rein |

Shapes follow each vendor's public policy docs (September 2026). These files are schema-shaped exports; they have not been submitted to the vendors' APIs, and per-window totals are only expressible on Privy. Rein's own account enforces all ten and returns the refusal code to the agent for free.
