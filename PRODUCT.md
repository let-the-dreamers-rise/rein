# Rein

**One line.** A smart account an autonomous agent can operate and cannot drain.

**What it is.** Chain-agnostic Solidity. A human owns the account; an agent
holds a key that can only produce calls the on-chain policy admits: target,
function and payee allowlists, rolling spend windows, call rate, approval
ceiling, expiry, a guardian breaker, and an intent hash on every call.
`simulate()` returns the same refusal code `execute()` reverts with, for
free, so an agent can ask before acting. Live on Base Sepolia and Whitechain
Sepolia, same bytecode, verified. 49 tests. Not audited.

**Who it is for.** Developers and small teams who give an AI agent a wallet
to pay suppliers, APIs (x402), or contractors, and who cannot accept that one
injected line in a PDF empties the account. Secondary: treasuries and
merchants who need a receipt that the agent was inside an attested policy.

**Register.** Brand. This is the marketing site: the visitor is deciding in
ninety seconds whether a stranger's contract can hold their money. It has to
feel like a bank's precision delivered with an engineer's honesty, and it has
to show the thing working rather than describe it.

**Voice, three physical words.** Bounded. Legible. Unhurried.

**Scene.** A developer at a desk at eleven at night, laptop, deciding whether
to route $50,000 of USDC through this. They want to read the refusal codes,
click through to the verified contract, and not be sold to. Light theme:
this is read like a term sheet, not like a terminal.

**What the site must do.**
1. State the promise in one sentence and prove it in the same fold (the
   on-chain run with six refusals, replayable, linked to the transactions).
2. Explain the mechanism in three real steps.
3. List what the chain enforces, exactly.
4. Say what it does not do, in the same voice, on the same page.
5. Point to Rein v2 (policy compiled from the agent's own behaviour) as in
   development, never as shipped.
6. Link the verified source on both chains and the repository.

**What it must not do.** Fake sign-up forms with no backend, testimonials
that do not exist, logos of companies that are not customers, the word
"audited", any metric that is not on chain.

**Color strategy.** Committed. One saturated colour carries the identity:
hazard orange, the colour of a boundary you are not meant to cross, on a
chroma-zero off-white with near-black ink. Green is reserved for the one
allowed payment. Reference: safety tape, not a fintech gradient.

**Type.** Bricolage Grotesque for display and body, in weight contrast;
JetBrains Mono for the on-chain transcript and addresses, because the
transcript is a real terminal artefact, not a costume.

**Deploy.** `web/` is the static root, served at rein-nine.vercel.app.
