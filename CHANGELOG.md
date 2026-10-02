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

### Fixed in the Safe check before release (security review, 2 October)
These all read "Looks normal" or lost an alert before the fix.
- A fake transfer of a worthless token "from" the Safe no longer counts as having paid that address in USDC or anything else. It only counts for that same token.
- Lookalikes are caught when they match 3 characters at one end and 5 at the other, not only exactly 4 and 4.
- A queued transaction that pays a gas refund (gasPrice above 0) is "Don't sign yet". Safe{Wallet} never sets one, and it can pay any amount of any token to anyone.
- ETH sent along with a contract call is read as a payment.
- `increaseAllowance`, Permit2 approvals and `setApprovalForAll` are read as approvals, and each payout in a Disperse batch as a payment.
- A call to a contract the Safe has never used is "Check first", because Rein can't read who it pays.
- Small first payments to one new address across the queue are added up, so thirty payments of $990 count as one of $29,700.
- When a flood of fake transfers pushes real payees out of the history Rein reads, the report says so.
- Reports always show the address next to the explorer's label, since a label is chosen by the address's owner. Slack links and Discord @everyone in that text no longer act.
- An alert that fails to post is tried again on the next check. A single run exits 1 when something shouldn't be signed, 2 when Rein couldn't check the Safe, and 3 when it couldn't post the alert.
- `scan/safe-action.yml` pins Rein's version, asks for no repository access, and fails the run (so GitHub emails you) when Rein can't check or can't post.

### Also
- `rein --version`.
- SECURITY.md and issue templates.
- /terms and /privacy on the site.

## 0.1.0 (1 October 2026)

First npm release: `scan`, `apply` (Privy, Turnkey, Coinbase CDP), `watch`, `guard`, `try`, the Claude plugin and the MCP server.
