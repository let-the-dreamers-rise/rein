# Security

Rein watches payments, so a hole in it matters. Thank you for looking.

## Reporting a vulnerability

Please report it privately with GitHub's **Report a vulnerability** button on
this repository's Security tab. If that button isn't there, open an issue that
says only that you have a security report and how to reach you. Leave out the
details, and we'll set up a private channel.

We'll acknowledge it within 3 days and tell you what we'll do about it.

## What counts

- Rein saying "Looks normal" for a queued transaction it should have flagged:
  a lookalike, a delegatecall or a payee change it misses.
- Anything that lets someone make Rein's co-signer approve a payment outside
  the learned limits.
- The site's relay (`web/api/safe.js`) reaching anything other than Safe's
  public read paths.
- A way to get code into the `rein-wallet` npm package that isn't in this
  repository.

## What Rein is not

Rein only reads. It never holds keys or funds, and it never proposes, signs or
executes a transaction. The in-process guard (`protect()`, `check()`) is
advisory: it runs inside the agent's own code, and an agent whose code is taken
over can skip it. The enforced version is the co-signer on Turnkey or Privy.
