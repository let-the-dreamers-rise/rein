# Changelog

## 0.1.1 (2 October 2026)

Rein now leads with the Safe payee check. Before the last signature, it checks each payment waiting in a Safe multisig against who that Safe has actually paid, and how much. The agent-wallet tools from 0.1.0 are still here, with fixes.

**Upgrade from 0.1.0 if you use `guard` or `check()`:** in 0.1.0, a negative payment amount could raise an agent's remaining budget instead of being refused. That's fixed here.

### New: the Safe check
- `npx rein-wallet safe 0xYourSafe [--chain ethereum]` marks each queued transaction "Don't sign yet", "Check first" or "Looks normal (this isn't a guarantee)", with a reason:
  - **Don't sign yet:** a lookalike of an owner, a past payee, a contract the Safe uses or a spender it approved; a payee seen only in fake transfers; or a delegatecall to anything but Safe's MultiSend.
  - **Check first:** a first payment of $1,000 or more; more than 3× the most the Safe has paid that payee; a change to owners, threshold, modules or guard; or an approval to a new spender.
  - Batches count as one payment, so splitting a payment doesn't get it under the line.
- It reads Safe's public gateway, so it needs no API key, plus Blockscout for the Safe's history. ETH paid through internal transactions counts as paid.
- `--webhook URL --every 300` posts each flagged transaction once to Slack, Discord or Telegram. `scan/safe-action.yml` does the same from a GitHub Action, with no server.
- The website has /safe: paste a Safe, or try a made-up poisoned one. It also works inside Safe{Wallet} as a custom Safe App (`https://rein-nine.vercel.app/safe/`), where it opens on the Safe you're in.

### New: agent wallets
- `npx rein-wallet 0x…` gives a one-screen checkup: the biggest first payment to a new address, dated address-poisoning evidence, habits, and what would have been held. You can then ask about any payment in plain words.
- `protect(walletClient)`: one line for viem agents.
- `rein fleet`: a shadow report across many wallets, including how many are being address-poisoned.
- `rein cosign`: Rein as a second key on Turnkey (including one webhook for every sub-org, and x402/EIP-712 payloads and batches) or Privy. **Tested only against stand-ins for both vendors.**
- Payments held for a person go to Slack with Approve and Refuse links.

### Fixed
- The guard learns payees only from payments the wallet sent itself, so poisoned history can't teach it a lookalike.
- The guard reads swaps and signatures, keeps payees and spenders apart, and adds a learned daily cap.
- About 15 issues from the 1 October all-sides test.
- An Ethereum Safe pasted with Base selected now says which chain to try.

### Also
- `rein --version`.
- SECURITY.md and issue templates.
- /terms and /privacy on the site.

## 0.1.0 (1 October 2026)

First npm release: `scan`, `apply` (Privy, Turnkey, Coinbase CDP), `watch`, `guard`, `try`, the Claude plugin and the MCP server.
