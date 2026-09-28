# rein-scan

Paste an agent wallet's address. Get back the spending policy its own history
supports, what one injected instruction could move from it today, what it
could move under that policy, and how much of its recent honest work the
policy would have refused.

With nothing installed: `npx github:let-the-dreamers-rise/rein scan 0xAgentWallet`.
From a clone:

```bash
node scan/cli.js 0xAgentWallet                 # Base
node scan/cli.js 0xAgentWallet --chain ethereum
node scan/cli.js 0xAgentWallet --out report    # plus report.json, trail.jsonl, export/{turnkey,coinbase,privy}.json
node scan/cli.js --sample                      # a made-up wallet, no network
node scan/cli.js --batch wallets.csv --out reports   # many wallets, then the totals
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

## Putting the policy on the wallet

`--out report` writes `report/export/{privy,turnkey,coinbase}.json`: each is
the ordered list of API requests that create the policy on that engine and
attach it, with `{{placeholders}}` for your own ids.

```bash
rein apply report/export/privy.json --wallet <privy wallet id>          # prints the requests
PRIVY_APP_ID=… PRIVY_APP_SECRET=… \
rein apply report/export/privy.json --wallet <privy wallet id> --send   # makes them

TURNKEY_API_PUBLIC_KEY=… TURNKEY_API_PRIVATE_KEY=… \
rein apply report/export/turnkey.json --organization <org id> --agent-user <agent's API user id> --send

CDP_API_KEY_ID=… CDP_API_KEY_SECRET=… CDP_WALLET_SECRET=… \
rein apply report/export/coinbase.json --send
```

Without `--send` nothing leaves the machine. With it, each request goes in
order and the id it creates feeds the next:

- **Privy:** the rolling spend window, then the policy that references it,
  then the attach to the wallet (a Privy wallet holds one policy, so this
  replaces any other).
- **Turnkey:** the ERC-20 interface upload, so the policy can read transfer
  arguments, then the policy. Each request is stamped with your API key,
  as Turnkey's SDK stamps it. If your organization needs more approvers,
  `rein apply` stops and names the activity to approve.
- **Coinbase CDP:** the account policy, then the attach to the scanned
  account. Each request carries a JWT from your API key, and the attach a
  second one from your Wallet Secret over the body, as the CDP SDK does.

[`sign.js`](sign.js) holds the signing; `test/scan.test.js` checks it the way
the vendors verify it, and it was checked against both SDKs' own output.
Credentials are read from the environment and only ever leave as a signed
request. `--batch` also writes
`turnkey-fleet.json`: one Turnkey policy holding every scanned agent's limits,
keyed by the address it signs from, so a fleet fits under a small policy cap.

## Watching

```bash
rein watch 0xAgentWallet                          # compiles the policy, then polls every minute
rein watch 0xAgentWallet --policy report/report.json --webhook "$SLACK_WEBHOOK_URL"
```

[`watch.js`](watch.js) reads the newest page of the wallet's history on every
poll, replays everything seen so far through the policy with the contract's
window arithmetic, and alerts on each new transaction the policy would have
refused: to the terminal, and as `{"text", "content"}` to a Slack or Discord
webhook (`--webhook` or `REIN_WEBHOOK`). Only transactions after the watch
started are reported. It works for a wallet on any engine; nothing moves to
Rein and nothing is signed. On a wallet that already runs Rein, the contract
refuses these calls instead; the watch is for the wallets that do not yet.

## Many wallets

`--batch wallets.csv --out reports` scans every address in a CSV with columns
`address,label,team,contact` (a header row is fine; only the address is
needed). It goes one wallet at a time with a two-second pause (`--pause MS`),
retries a failed wallet once, writes `reports/<address>/` for each exactly as
a single scan's `--out` does, and records wallets that failed twice in
`reports/errors.json`. Then it runs [`aggregate.js`](aggregate.js) over the
folder:

- `reports/summary.md`: totals with their denominators and no addresses, for
  publishing.
- `reports/summary-private.csv`: one row per wallet with the CSV's labels and
  contacts, for outreach. Never publish it.

The synthetic sample is never counted in the totals. `node scan/aggregate.js
reports --wallets wallets.csv --out summary` reruns the totals on their own.

## What it does not say

- **No on-chain limit is not the same as no limit.** A key held in Privy,
  Turnkey or Coinbase CDP may sit behind a signing policy that no explorer
  can see. The report says what the chain shows and puts this caveat on every
  real scan.
- A public history has no instructions in it, so intent hashes are not
  checked. An agent running on Rein supplies one per call.
- Native coin leaving a contract wallet through internal transactions, and
  NFTs, are not read.
- The coverage number is measured against the wallet's own recent calls. A
  first-time payee is refused on purpose: that is the policy asking a human.
- The vendor exports are checked against each vendor's SDK source and API
  spec, not yet against a live account. Privy's rules for smart wallets (user
  operations) are the least certain part.

## The sample

`--sample` and `rein_scan_wallet` with address `sample` run on
[`sample.js`](sample.js): sixty days of a made-up operations agent on Base,
written out as Blockscout's API would return it. It uses the real Base USDC,
WETH and Uniswap router addresses so the report reads like a real one; every
report it produces is labelled synthetic.
