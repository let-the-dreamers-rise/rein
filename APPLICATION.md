# Rein — Whitechain Builders Program application

**A smart account an autonomous agent can operate and cannot drain.**

| | |
| --- | --- |
| Project | Rein |
| Applicant | Ashwin Goyal — individual, Bhopal, India (IST) |
| Team size | 1 |
| Repository | https://github.com/let-the-dreamers-rise/rein (MIT) |
| Demo | https://rein-nine.vercel.app (page + 90s video) |
| Status | **deployed and verified on Whitechain Sepolia (1874)** |
| Request | USD 32,000 over 16 weeks, 4 gates — first tranche USD 4,000, retroactive — plus the program's subsidized Hacken audit coverage |
| Open source | Yes, MIT, all deliverables |

---

## 1. Verify it before you read anything else

**Live demo page, with a 90-second silent video of the run:**
https://rein-nine.vercel.app

Everything below is already on your chain. Two links, thirty seconds:

**A payment the policy allowed** — status 1
https://explorer.testnet.whitechain.io/tx/0x4804895518b38ac2f2ed5f12902941e764fdaf7648f896ae47ba9170145271fa

**The same agent, one minute later, trying to send the balance to an address it was told to use — refused on chain**, status 0, reverting with `PolicyViolation(13)` = `PAYEE_NOT_ALLOWED`
https://explorer.testnet.whitechain.io/tx/0xe41fcc7f83d45d9cda5e55605cd95ef45f5211d0fa9580367bffaa855f8ca291

The contract that refused it, source verified on your Blockscout:
https://explorer.testnet.whitechain.io/address/0x33f2B6ae5F03642726b22Fef18ae44EAdf278521#code

Factory (deterministic, CREATE2):
https://explorer.testnet.whitechain.io/address/0x30F0bAB7ed9064f07c1aa7B3BFBC6d8ea25fA316#code

That second transaction is the whole project. The agent genuinely wanted to make
that call. The chain would not let it.

## 2. What it is

Giving an AI agent a wallet is currently all-or-nothing. Either it holds a key,
and one poisoned document empties the account, or it does not, and a human
approves every payment — which removes the reason to use an agent.

Rein is a smart account where the owner writes a spending policy and **the chain
enforces it**, so the agent holds a key that can only produce calls the contract
is willing to make:

- target and function allowlists, per agent key
- a payee allowlist — the agent cannot invent a recipient mid-session
- rolling spend windows, native and per-token, cumulative across every call
- a call-rate limit and an expiry
- an approval ceiling on `approve()`; `increaseAllowance()` refused outright
- **guardian keys that can stop an agent and can never spend** — safe for a
  monitoring bot to hold
- every call carries a hash of the instruction behind it, logged on chain

Two structural properties do the real work:

**An agent can never call its own account.** `target == address(this)` is refused,
and every path that widens a policy is owner-only — including one routed through
an allowlisted contract that calls back. There is a test for that.

**Refusals are legible before they cost anything.** `simulate()` is a free view
call returning the exact code `execute()` would revert with. A well-built agent
asks whether an action is covered and declines the task cleanly instead of
discovering the boundary by hitting it. The test suite runs every scenario
through both paths and fails if they ever disagree — a divergence would teach the
agent the wrong lesson.

## 3. What I measured about your chain first

I did not write this proposal and then look for a chain. These are from your
live testnet this week:

| finding | value |
| --- | --- |
| OP Stack predeploys present | 19 / 19 |
| WETH predeploy naming | `Wrapped WhiteBIT Coin` / `WWBT` — **correct**, and the thing custom-gas-token deployments most often get wrong |
| Permit2, Multicall3, Safe 1.4.1, CREATE2 deployer, Safe Singleton Factory | all present |
| **EntryPoint v0.6 and v0.7** | **both deployed** |
| EntryPoint deposits | **1.0 WBT and 0.5 WBT** — round smoke-test amounts, no paymaster operating |
| Account-abstraction documentation | **none** — no page on paymasters, bundlers, session keys or ERC-4337 |

You deployed the account layer and nothing is using it. That is the gap this
fills, and it is why the milestones below are about making the account layer
*usable* rather than about inventing a new one.

## 4. Honest positioning against what already exists

I am not claiming a new category, and you should not fund anyone who does.

**ERC-7579 Smart Sessions** (Rhinestone and Biconomy) already ships session-level
and action-level policies including value limits, across every major smart
account, with a Safe adapter. I read their `ERC20SpendingLimitPolicy` line by
line. It is careful work — it accumulates `approve` and `increaseAllowance`
against one shared ceiling and fails closed on unknown selectors. An earlier
version of *my* contract got that exact case wrong; theirs did not.

So Rein's contribution is not "a better permission standard." It is three things:

1. **It runs on Whitechain today, verified, with clickable evidence.** Nothing in
   the 7579 ecosystem is deployed or documented on 1874.
2. **`simulate()` as a first-class interface.** Existing policies return
   pass/fail to a bundler. Rein returns a typed reason to the *agent*, free,
   before gas — so abstention becomes a designed behaviour rather than a failed
   transaction. I have not found this elsewhere.
3. **A guardian role that can stop and cannot spend**, which is what makes
   automated monitoring safe to deploy.

Where ERC-7579 is the better home for this, M1 below moves it there rather than
competing with it.

## 5. Current state — all of it built before any funding

- `ReinAccount`, `ReinFactory`, `CalldataGuard` — Paris EVM (no PUSH0), 11.3 KB
  deployed, well under the size limit
- **36 tests passing**, including: no permitted call can widen its own policy; no
  escalation routed through an allowlisted contract; no re-entry; cumulative
  budgets a batch cannot dodge; guardians that stop but cannot start; and an
  assertion that `simulate()` and `execute()` never disagree
- deployed and Blockscout-verified on 1874, with the two transactions above
- a one-command prompt-injection demo that runs on your chain

One bug worth naming, because of how it was found. The first demo run showed an
empty instruction being *allowed*: `keccak256("")` is a valid-looking hash, so
refusing only the zero hash let an agent satisfy the intent requirement while
recording nothing. Later, an adversarial test showed `increaseAllowance` could
drip past the approval ceiling because its argument is a delta, not a total —
while the README claimed an infinite approve was unreachable. Both are fixed,
both have regression tests, and both are written up in the repository. I would
rather show you those than a clean first run.

## 6. Milestones

| # | Weeks | Deliverable | Gate | USD |
| --- | --- | --- | --- | --- |
| M0 | done | Deployed, verified, 36 tests, on-chain allowed/refused evidence, public MIT repo | You reproduce the two transactions above and clone-and-test in ten minutes | **4,000** (retroactive) |
| M1 | 1–4 | ERC-7579 module form of the policy, tested with Rhinestone ModuleKit across Safe, Kernel and Nexus; the account-abstraction documentation Whitechain currently lacks, contributed to your docs | Module installs and enforces on all three account types on 1874; docs merged or published | 8,000 |
| M2 | 5–9 | TypeScript SDK, and an agent adapter that calls `simulate()` before acting and surfaces refusals in plain words; policy console to write, revoke and watch the intent trail; reference integration with two other Builders Program teams | A third-party agent runs bounded on 1874 without me writing its code | 12,000 |
| M3 | 10–16 | Security audit via **the program's subsidized Hacken coverage** rather than a cash line, all findings resolved publicly, public testnet bounty round, and mainnet deployment on day one | Audit report and remediation published; contracts live on mainnet at launch | 8,000 |
| | | | **Total cash** | **32,000** |

Stop, pause, resize or reject at any gate; unspent authority is not owed to me.

**On the audit.** A permission layer that has not been audited is a permission
layer nobody should trust with a treasury, so M3 does not ship without one. I am
not asking for cash to buy it: your program page offers subsidized Hacken audit
coverage, and Hacken already audits WhiteBIT, so the sensible thing is to use
what you already have rather than have you pay twice. If that coverage is not
available for a project this size, tell me and I will re-scope M3 with an audit
line instead of quietly shipping unaudited.

## 7. Why this helps the ecosystem rather than one app

It is a primitive, not a product. Every agent-operated application on Whitechain
needs this layer, and each one that uses it adds transactions and addresses to
your chain. It competes with nothing on your announced roadmap — not WhiteSwap,
not WB Soul, not the Distribution or Token Launch Platforms.

And it is aimed at the step your distribution thesis depends on. Funding an agent
requires a human to move money to it; on Whitechain that is a WhiteBIT withdrawal
straight onto the L2 with no third-party bridge. The factory is CREATE2, so an
account address can be shown to a user and funded *before* the account exists.

## 8. What this does not do

- **The intent hash is a commitment, not a proof.** The contract cannot verify
  the hash matches the instruction the agent actually received. What you get is
  that the agent signed something before spending, and your prompt logs join to
  the chain on that key.
- **It bounds the blast radius; it does not make the agent's decisions good.** An
  agent can still waste its whole budget on a permitted but foolish payment.
- **Only four ERC-20 selectors carry semantics.** A token exposing `permit` or
  `transferAndCall` is outside what the policy understands. Selector collisions
  fail closed — a false rejection, deliberately chosen over a false approval.
- **It assumes the owner is not compromised.** Use a multisig owner for anything
  that matters; the account does not care what kind of address its owner is.
- **Not audited.** 36 tests is not an audit. That is M3.
- **Agent-operated payments are early.** I am not going to tell you a large
  market exists today. The case is that the primitive should exist before the
  agents arrive, not after, and that it costs a fraction of one incident.

## 9. Me

Solo builder, final-year B.Tech CS, VIT Bhopal. I ship and I measure honestly —
the section above exists because I would rather you find the limits from me than
from an auditor.

My other current work is an agent for the ARC-AGI-3 benchmark, where the
interesting part is the same idea as this one: a world model that abstains when a
situation falls outside what it has actually learned, and a guarded execution
loop that halts the moment reality diverges from prediction. In that work I ran
leave-one-game-out validation on one of my own features, measured AUC 0.489 —
worse than a coin flip — and deleted it. `simulate()` is that same instinct moved
on chain.

I also maintain an independent conformance suite for Bitcoin's BIP 360, which
found and responsibly disclosed divergences in the official reference
implementation.

## 10. One question

I am an individual in India without a registered company. Can tranches be paid to
an individual, or does the program need an entity? Either answer works — I would
just rather know at week zero than at milestone 1, so that if incorporation is
needed I start it this week and it never delays a delivery.

---

**Contact** — Ashwin Goyal · github.com/let-the-dreamers-rise
