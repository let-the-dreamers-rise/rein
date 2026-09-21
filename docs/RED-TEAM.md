# Red team: what breaks, what is fixed, what is still open

Written 19 September 2026, against the repo as it stood that morning (56 tests,
v2 shipped, three testnets live). Everything below is either demonstrated by a
test in this repo or marked as reasoning. Where something is unverified it says
so.

---

## 1. The finding that matters: the policy does not bind a router

**Severity: critical. Present in v1 and v2, on every deployed account.**

`CalldataGuard.classify()` understands four selectors: `transfer`, `approve`,
`transferFrom`, `increaseAllowance`. Every other selector on an allowlisted
contract returns `Kind.Other`, and `Kind.Other` skips *all three* of the checks
that bound value:

- the token policy (no ceiling applies),
- the payee allowlist (the recipient is never looked at),
- the rolling spend window (nothing is charged).

The README lists this under "Only four selectors carry semantics" as a
limitation. It is not a limitation. It is the whole product failing open on the
most ordinary agent there is, because the thing an agent is most often
allowlisted for is a router, and every router takes a recipient argument.

The demo's own compiled policy allowlists `Router.swapExact`.

### Demonstrated

`contracts/test/DrainRouter.sol` is a router that does what routers do: spends
the caller's allowance and sends the proceeds to the `recipient` argument.
`test/router-hole.test.js` runs it against a real `ReinAccount` under a policy
whose owner believes they have capped exposure at 600 USDT an hour:

```
the router hole
  ReinAccount (v1/v2, as shipped)
    + lets a compromised agent drain the account through an allowlisted router
    + repeats without limit, so the hourly ceiling bounds nothing
```

Ten laps move **5,000 USDT to an address that is not on the payee list**, and
`remainingToken()` reads **600 the entire time**. Every call was permitted. The
agent never touched a refusal.

The same hole swallows: bridges, vault deposits, `permit` (EIP-2612),
`transferWithAuthorization` (EIP-3009), `transferAndCall`, fee-on-transfer
tokens, rebasing tokens, and any token with two addresses where only one is
allowlisted.

### The fix: stop reading calldata, read the balance sheet

`contracts/ReinAccountV3.sol`. A decoder can only understand the encodings it
was taught, and an attacker picks the encoding. A balance cannot be talked out
of anything. v3 keeps the calldata check — it is cheap, and it is what makes a
refusal legible *before* gas — and then adds a second check after the call:

1. snapshot `balanceOf(account)` for every guarded token, and the native balance,
2. make the call,
3. snapshot again, charge whatever left that the calldata did not declare,
4. if it does not fit in the window, revert the whole thing,
5. hold every watched spender's standing allowance to the owner's ceiling,
   however it got there.

So the two halves now say different things on purpose:

| | |
|---|---|
| `simulate()` | what the policy **believes** this call will do. Free, before gas. Unchanged. |
| `execute()` | that, plus a refusal if **reality disagreed**. |

An honest agent sees no difference — there is a regression test for exactly
that. An agent that found an encoding the decoder cannot read gets reverted by
arithmetic on the balance sheet, which is not a thing that can be prompt-injected.

```
ReinAccountV3 (metering the balance sheet)
  + charges the undeclared outflow to the window and then refuses
  + bounds a ten-lap attack to one window instead of the whole balance
  + refuses an opaque call outright when nothing is being metered
  + refuses a token ceiling that is not backed by a meter
  + still allows and prices an ordinary declared payment exactly as before
```

Same attack, same policy: **500 lost instead of 5,000**, and the second lap is
refused with `OUTFLOW_EXCEEDED`. The loss is now bounded by the number the owner
actually wrote, which is what that number was always supposed to mean.

Two supporting decisions:

- **Fail closed by default.** `meteringRequired` is on for every newly configured
  agent. An opaque call on an unmetered agent is refused with `UNMETERED_CALL`
  rather than guessed at. Turning it off is an explicit owner call.
- **The invariant is enforced at configuration time.** `setTokenPolicy` refuses a
  ceiling on a token that is not being metered. A ceiling nobody is watching is
  the false comfort this version exists to remove.

### Cost

Two `balanceOf` staticcalls in the common case (one guarded token), plus two more
per watched spender for the allowance ceiling. Roughly 5–25k gas on a payment.
For a payments product that is the right trade; it is stated here rather than
hidden because on a high-frequency agent it is not nothing.

---

## 2. Rein cannot be an x402 payer, which is the market the pitch names

**Severity: high, and it is a product gap rather than a vulnerability.**

x402's `exact` scheme on EVM settles by a facilitator calling
`transferWithAuthorization` on the token with a signature the payer produced
off-chain. An EOA signs with its private key. **A contract cannot sign anything.**
`ReinAccount` has no `isValidSignature`, no ERC-1271, no ERC-4337 support — so a
ReinAccount simply cannot be the payer in an x402 payment. The agent's own EOA
would be the payer and Rein would not be in the path at all.

This matters because the application names x402 sellers and AgentKit projects as
the first fifty users.

### The way through, and it is already live

[ERC-7598](https://eips.ethereum.org/EIPS/eip-7598) extends ERC-3009 so that when
the payer is a contract, the token routes the signature to the payer's ERC-1271
`isValidSignature` instead of `ecrecover`. It is **already shipped in USDC's
FiatTokenV2_2**.

`contracts/lib/Erc3009Gate.sol` and the ERC-3009 section of `ReinAccountV3`
implement it:

- `authorizeTransfer(...)` runs the full policy check on a proposed ERC-3009
  transfer, charges the window, and records the exact EIP-712 digest the token
  will compute,
- `isValidSignature(digest, _)` returns the magic value only for a digest the
  policy approved and only while the agent is still active, unexpired and
  untripped,
- `simulateAuthorization(...)` is the free view-call twin, same as `simulate()`.

This works against **unmodified USDC and unmodified x402 facilitators**.

And it buys a property nothing else in agent payments has: **the check is live at
settlement, not at signing.** The token comes back and asks the account at the
moment the money moves. So tripping the breaker, revoking the agent or letting
the key expire **stops payments that are already in flight**. A signature from an
EOA can never offer that — once signed, it is redeemable.

### Prior art you should know about before you pitch this

This exact concept — a policy-gated x402 payer via ERC-1271 plus ERC-7598 — was
posted publicly as [x402 issue #2641](https://github.com/x402-foundation/x402/issues/2641)
on 16 June 2026 by `junbeomlee`, with a working Circom/Groth16 proof-of-concept
that additionally keeps the amount private. It has no maintainer replies and no
linked implementation.

So: the idea is not yours alone, it is three months old in public, and the
version in that issue is more advanced on privacy than anything here. What you
have that it does not is a live, verified, multi-chain contract and a compiler
that writes the policy. Do not claim novelty on the mechanism. Claim shipping.

**Status: implemented and compiling; NOT yet tested against a real ERC-3009
token or a real facilitator.** That is the next test to write, and until it is
written this is a design, not a result.

---

## 3. The intent hash leaks the thing it was meant to protect

**Severity: medium. Privacy, and it is currently negative-value.**

`intent = keccak256("pay supplier invoice 4471")`, unsalted, emitted publicly in
`IntentExecuted` on every call.

Instructions are short and formulaic. An unsalted keccak of a formulaic string
is recoverable by anyone willing to enumerate the format — invoice numbers,
amounts, supplier names. So the hash is not a commitment that hides anything; it
is a searchable index of the business's payment instructions, published forever.

Combined with the compiled policy page, which names Payroll and Suppliers A, B
and C and states the hourly ceiling, **Rein currently makes a business's payment
graph more legible than an ordinary wallet would**, not less. For an enterprise
treasury that is a procurement blocker on its own.

**Fixed in the client** (`mcp/lib/account.js`): the commitment is
`keccak256(salt || instruction)` with a per-account salt from
`REIN_INTENT_SALT`. Binding for the owner, who knows the salt; meaningless to
everyone else; still joins to the prompt log. Tested.

The contract needs no change — it never cared what the bytes were. What needs to
change is the README, which currently teaches the unsalted form.

---

## 4. The threat model moves risk, it does not remove it

Worth saying plainly in the pitch before an investor says it for you.

`ownerExecute` is unrestricted. The product's real claim is therefore not "your
money is safe" but **"your exposure to a compromised *agent* is bounded, and your
exposure to a compromised *owner key* is unchanged."** That is a genuinely
valuable trade — agent keys are the ones exposed to prompt injection, and there
are a lot more of them — but it is a trade, and the README's "cannot drain"
framing oversells it.

A guardian key that leaks was also a permanent denial of service: trip, owner
resets, trip again, forever, at one transaction per stop. v3 adds a per-guardian
cooldown (`guardianTripCooldown`, default 15 minutes; the owner is never rate
limited).

Also hardened in v3, all lower severity: bounded returndata copy
(`BoundedCall`) so a hostile allowlisted target cannot out-of-gas the account
with a returndata bomb; an optional per-agent gas limit on the outbound call;
and ERC-721/ERC-1155 receiver hooks so the account can hold what it is paid in.

### Not looked at, and someone should

Fixed-reset windows rather than sliding ones (a burst across a boundary can move
nearly two windows' worth in a short interval); window state is not reset when
`configureAgent` tightens a policy; CREATE2 factory behaviour when
`createAccount` returns an already-existing account; selector collisions against
real-world contracts. These are reasoned concerns, **not demonstrated** — I ran
out of room before writing tests for them.

---

## 5. Is "compile the policy from behaviour" actually a differentiator?

**Verdict: it is a port of a mature, well-understood pattern — not an invention.
That is survivable, but only if you stop presenting it as new and start
inheriting what the pattern already learned.**

AWS IAM Access Analyzer has generated least-privilege IAM policies from observed
CloudTrail activity for years. The shape is identical: run wide, observe, emit a
narrower policy. The same pattern exists in Kubernetes network-policy generation
from observed traffic, and in AppArmor/SELinux complain-mode profiling.

What that mature version has already learned, and what it costs you:

| What AWS found | What Rein currently does |
|---|---|
| The generated policy is **a draft, not a deliverable**; human review before promotion is the documented workflow | Compiles bounds straight into enforced on-chain policy |
| Anything used **less often than the observation window** is missing from the policy | 25% headroom on an observed max, and no distinguished "never seen" state |
| Generated policies are **over-specific to the environment they were observed in** and need parameterising | Same risk, unexamined |

Sources: [AWS Security Blog on policy generation](https://aws.amazon.com/blogs/security/iam-access-analyzer-makes-it-easier-to-implement-least-privilege-permissions-by-generating-iam-policies-based-on-access-activity), [Access Analyzer features](https://aws.amazon.com/iam/access-analyzer/features/).

### What survives, and it is not nothing

Two things are genuinely yours and neither is the learning:

1. **Enforcement the observed party cannot reach.** An IAM policy is enforced by
   the same cloud the workload runs in. A Rein policy is enforced by a chain that
   does not care what the agent believes. Nobody has put the generated-policy
   pattern behind an enforcement boundary the subject cannot influence.
2. **Denominators.** Coverage and catch rate, printed with the counts. AWS does
   not publish a number for how good a generated policy is. Neither does anyone
   in agent wallets. "The product is the number, not the engine" is the right
   line and it is defensible.

### The part that worries me most

A policy learned from behaviour is written by whoever controls behaviour during
the observation window. If an attacker can inject prompts during shadow mode —
and prompt injection is the threat the whole product exists to answer — then the
attacker writes the policy, and every bound after that is one they chose. A raw
observed max with headroom added is the single worst estimator for this, because
**one poisoned call sets the ceiling permanently**.

It was a raw max. Checked against the code, every enforced bound in
`v2/compile.py` is a raw extremum:

```python
"max_per_call":     max([float(r["amount"]) for r in t_moves], default=0.0),
"ceiling_per_hour": math.ceil(hour_max * HEADROOM),   # hour_max = rolling_max(...)
"max_approval":     max([float(r["amount"]) for r in t_appr], default=0.0),
```

`MIN_SUPPORT = 4` exists, but it is passed only to the synthesiser inside
`learned()`, so it guards the monitor-only habits and nothing that goes on
chain. And the allowlist computes per-payee counts and then discards them at
`sorted(set(b["payees"]) | ...)`, so **one sighting permanently admits a
payee.** The same discarded counts made the payee sentence in `policy.md` show
the *total* across all payees as its evidence ("81 of 81"), so a payee seen
once would sit under the same count as payees seen dozens of times, in front of
the person signing the policy.

Measured by injecting three calls into one afternoon of the committed trail
(2.6% of it): the hourly ceiling went from 4,002 to 40,413, the approval ceiling
from 500 to a trillion, and a name that appeared once went onto the allowlist.

### Fixed, behind a flag

`python v2/compile.py <trail> --robust` changes three things:

1. bounds come from an upper quantile after rejecting outliers, rather than
   the maximum. Outliers are judged against the upper tail when there is
   enough data to have one, and against the median when there is not --
   approvals are rare, and a quantile of five observations cannot reject a
   poisoned fifth;
2. nothing reaches an allowlist without at least four calls across at least
   three distinct days, so one injected session cannot admit a principal;
3. anything that fails that test is **reported as withheld for a human**, not
   silently dropped, and every payee carries its own evidence count.

`npm run v2:compare` shows both, clean and poisoned:

| | default | `--robust` |
|---|---|---|
| clean trail: hourly ceiling | 4,002 | 3,801 |
| clean trail: withheld | none | none |
| poisoned: attacker admitted | **yes** | no, withheld (1 call, 1 day) |
| poisoned: hourly ceiling | **40,413** | 3,801, unmoved |
| poisoned: approval ceiling | **1,000,000,000,000** | 500, unmoved |

On an honest trail it comes out about 5% tighter than the default and withholds
nothing; on
the poisoned one it neutralises all three calls. The default path is unchanged,
byte for byte, so CI still reproduces the committed policy. 18 tests in
`v2/test_compile.py` pin both properties.

What it does not fix: a patient attacker who spreads calls across days still
buys a place on the allowlist eventually. Minimum support raises the cost; only
human confirmation for every *new* payee removes it, which is what AWS learned
to do, and which the withheld list is the first half of.

---

## 6. An agent can now actually use this

The integration was previously `require()` of a JS file inside a git repo. Three
ways now, all tested:

**MCP server** — `npm run mcp`, dependency-free, stdio JSON-RPC:

```bash
claude mcp add rein -- node /path/to/rein/mcp/rein-mcp.js
```

Tools: `rein_check_payment`, `rein_pay`, `rein_budget`, `rein_policy`,
`rein_explain_refusal`. They speak in payees, amounts and reasons — no ABI
encoding — and every refusal carries the remaining budget, because an agent told
only "no" retries, while an agent told "no, and you have 350 left this hour" can
decide to pay less or wait.

The tool *descriptions* are the real interface: they tell the model that checking
is free and that a refusal is the owner's decision rather than an obstacle to
route around. That is how you get a model to abstain and explain instead of
hammering the boundary.

`rein_pay` requires a `because`. The agent cannot spend without stating what it
thinks it was told.

**HTTP API** — `npm run api`. Bearer tokens stored as SHA-256 digests and
compared in constant time, per-caller rate limits (paying limited 6x harder than
asking), 64 KB body cap, loopback-only by default, and it refuses to start
without a token. 11 tests.

**JS client** — `client/rein.js`, unchanged.

Read-only mode: with no agent key, the server answers questions and cannot spend.

---

## 7. Honest status

84 JavaScript tests and 18 compiler tests pass, up from 56. Still **not
audited**, and a test count is not an audit.

Done: the router hole found, demonstrated and fixed in v3; the compiler found
poisonable by a single call and fixed behind `--robust`; the catch rate given
its baseline (8 of 10 refused by the wide policy before compiling, 2 of 10
attributable), and the in-bounds drain added to the demo, where it succeeds;
ERC-1271/ERC-7598 x402 payer path implemented; salted intent commitments;
guardian cooldown; returndata bound; token receivers; MCP server; HTTP API
with auth.

Not done, in the order I would do it:

1. **The held-out set is a chronological slice of one seeded generator.** A
   coverage of 22 of 22 on that is close to guaranteed and n = 22 is not a
   sample. It needs a genuinely different period -- a quarter-end, a new
   supplier, a volume change -- before it measures anything.
2. **Test the x402 path against a real ERC-3009 token and facilitator.** Until
   then it is a design.
3. **v3 has not been audited, deployed or reviewed by anyone but its author.**
   Do not deploy it to anything holding real money. It is the right
   architecture; it is not yet trustworthy code.
4. **Make `--robust` the default**, once it has run against one real trail.
5. Run the compiler over one real agent's trail. A coverage number below 100%
   from a stranger's logs is worth more than 22 of 22 from a seeded generator.
