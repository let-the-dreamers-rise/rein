# rein-scan

Paste an agent wallet's address. Get back the spending policy its own history
supports, what one injected instruction could move from it today, what it
could move under that policy, and how much of its recent honest work the
policy would have refused.

```bash
node scan/cli.js 0xAgentWallet                 # Base
node scan/cli.js 0xAgentWallet --chain ethereum
node scan/cli.js 0xAgentWallet --out report    # plus report.json, trail.jsonl, export/{turnkey,coinbase,privy}.json
node scan/cli.js --sample                      # a made-up wallet, no network
```

In Claude, the same scan is the `rein_scan_wallet` tool, or `/rein:scan 0x…`
with the plugin. It needs no Rein account and no key: it reads public chain
data and signs nothing.

## What it does

```
history (Blockscout API v2, keyless)  ->  trail
  -> compile the first 80%   (scan/compile.js, a port of v2/compile.py, robust mode)
  -> replay the last 20%     (scan/evaluate.js, the contract's own checks and windows)
  -> exposure before and after, priced where the explorer knows a price
  -> Turnkey, Coinbase CDP and Privy policy JSON (v2/export.js)
```

- **The compiler is a port, not a rewrite.** `test/scan.test.js` holds it to
  the committed v2 policy and, where Python and nyaya are installed, to
  `compile.py --robust` run fresh. CI runs both.
- **Robust by default.** Ceilings come from the 99th percentile after
  outliers are set aside, and nothing reaches an allowlist without 4 calls
  across 3 distinct days. Whatever falls short is listed as withheld for a
  human, not silently dropped. `--naive` uses the raw maximum instead.
- **Outflows are what count.** A token leaving the wallet without the wallet
  calling `transfer` itself (a router pulling it in a swap, a smart wallet
  moving it through its entry point) is charged to that token's hourly
  ceiling, the way ReinAccountV3 meters the balance sheet, but it is not a
  call and its recipient does not become a payee.
- **Amounts are compiled in millionths of a token**, so an ETH ceiling is not
  rounded up to a whole ETH.

## What it does not say

- A public history has no instructions in it, so intent hashes are not
  checked. An agent running on Rein supplies one per call.
- Native coin leaving a contract wallet through internal transactions, and
  NFTs, are not read.
- The coverage number is measured against the wallet's own recent calls. A
  first-time payee is refused on purpose: that is the policy asking a human.
- Exported vendor JSON follows each vendor's public docs and has not been
  submitted to their APIs.

## The sample

`--sample` and `rein_scan_wallet` with address `sample` run on
[`sample.js`](sample.js): sixty days of a made-up operations agent on Base,
written out as Blockscout's API would return it. It uses the real Base USDC,
WETH and Uniswap router addresses so the report reads like a real one; every
report it produces is labelled synthetic.
