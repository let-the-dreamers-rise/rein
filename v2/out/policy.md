# The compiled policy

Compiled from 89 shadow-mode calls; 22 later calls held out for measurement.

| what the agent does | evidence | enforced by |
|---|---|---|
| Calls only Router, USDT | 89 of 89 | target allowlist |
| On Router, calls only swapExact | 4 of 4 | selector allowlist |
| On USDT, calls only approve, transfer | 85 of 85 | selector allowlist |
| Pays only Payroll, Supplier A, Supplier B, Supplier C | 81 of 81 | payee allowlist |
| Approves only Router | 4 of 4 | payee allowlist |
| Never moves more than 3,201 USDT in any hour; ceiling 4,002 with 25% headroom | 81 of 81 | rolling spend window |
| Never approves more than 500 USDT | 4 of 4 | approval ceiling |
| Makes at most 2 calls in an hour; cap 3 | 89 of 89 | call rate |
| Never sends native value | 89 of 89 | native ceiling of zero |
| Every call carries the instruction behind it | 89 of 89 | intent required |
| Pays Supplier B on Tuesdays | 21 of 22 | monitor only |
| Pays Supplier A when the amount is 100 to 500 | 21 of 21 | monitor only |
| Supplier A receives 100 to 500 in the morning | 21 of 21 | monitor only |
| Pays Supplier C when the amount is 500 to 2,000 | 5 of 5 | monitor only |

## On chain

```json
{
  "agent": {
    "windowSeconds": 3600,
    "maxCallsPerWindow": 3,
    "maxNativePerCall": 0,
    "maxNativePerWindow": 0,
    "requireIntent": true,
    "expiry": 0
  },
  "targets": [
    "Router",
    "USDT"
  ],
  "selectors": {
    "USDT": [
      "approve",
      "transfer"
    ],
    "Router": [
      "swapExact"
    ]
  },
  "payees": [
    "Payroll",
    "Router",
    "Supplier A",
    "Supplier B",
    "Supplier C"
  ],
  "tokens": {
    "USDT": {
      "windowSeconds": 3600,
      "maxPerWindow": 4002,
      "maxApproval": 500.0
    }
  }
}
```

Learned sentences marked *monitor only* are habits the synthesiser found that the
contract cannot enforce today (time of day, per-payee amounts). They are what a
guardian watches for, and the honest boundary of what v2 can promise.
