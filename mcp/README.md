# Rein for agents

Three ways to let an agent spend from a Rein account without letting it decide
how much. All three sit on the same rule: **ask first, and a refusal is free.**

`simulate()` is an on-chain view call that returns the exact code `execute()`
would revert with. It costs no gas and leaves no trace. So an agent can find out
whether it is allowed to do something before it tries, and abstain with a reason
instead of discovering the boundary by hitting it.

---

## 0. The sandbox

Every surface below takes `--sandbox` (or `REIN_SANDBOX=1`): a Rein account
holding 50,000 test USDC, with a policy already written, on a private EVM
chain inside the server's own process. Nothing to configure and no real money,
so it is the way to try Rein before you have an account. The sandbox is only
ever used when asked for; a server missing `REIN_RPC_URL` refuses to start
rather than falling back to it.

```bash
npm run sandbox                                   # the MCP server, sandboxed
npm run api:sandbox                               # the HTTP API, sandboxed; prints a key
claude mcp add rein -- node /path/to/rein/mcp/rein-mcp.js --sandbox
```

The chain is `@ethereumjs/vm` behind the JSON-RPC methods ethers uses
([`sandbox/chain.js`](sandbox/chain.js)); the account is `ReinAccountV3` with
the bytecode in [`sandbox/contracts.json`](sandbox/contracts.json), which the
test suite checks against a fresh compile. The one-file build that the Claude
Code plugin and the Claude Desktop extension ship is in [`../plugin`](../plugin).
Install steps for each client are in [QUICKSTART.md](../QUICKSTART.md).

---

## 1. MCP server

Stdio JSON-RPC, no MCP SDK to install.

```bash
claude mcp add rein -- node /path/to/rein/mcp/rein-mcp.js
```

Or in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "rein": {
      "command": "node",
      "args": ["/path/to/rein/mcp/rein-mcp.js"],
      "env": {
        "REIN_RPC_URL": "https://sepolia.base.org",
        "REIN_ACCOUNT": "0x...",
        "REIN_AGENT_PRIVATE_KEY": "0x...",
        "REIN_TOKENS": "USDC:0x...",
        "REIN_PAYEES": "acme:0x...,northwind:0x...",
        "REIN_INTENT_SALT": "something-only-the-owner-knows"
      }
    }
  }
}
```

### Tools

| Tool | What it does |
|---|---|
| `rein_about` | Start here: which account, which network, who may be paid, the limits. |
| `rein_check_payment` | May I pay this person? Free, no gas, no trace. Returns the reason and the budget left. |
| `rein_pay` | Pay, recording the instruction behind it. Refuses rather than failing. |
| `rein_budget` | What is still spendable this window, per token, plus calls left. |
| `rein_policy` | The policy in force, in words. |
| `rein_explain_refusal` | Turn a refusal code into plain English. |
| `rein_scan_wallet` | Any agent wallet's public history in; the policy it supports, what it holds with no on-chain limit, and what it could lose under that policy. Needs no account. See [`../scan`](../scan/README.md). |

They take payees, amounts and reasons. No ABI encoding, no wei: `"12.50"` means
twelve dollars fifty. A payee is an address or a name from `REIN_PAYEES`
(`"acme"`); the name only saves typing an address, and the payee allowlist on
chain still decides who may be paid.

`rein_pay` requires a `because` — the instruction the agent believes it is acting
on. A hash of it is recorded on chain with the payment, so an owner reviewing an
incident can join the chain to their own prompt logs. The agent cannot spend
without saying what it thinks it was told.

### Read-only mode

Leave out `REIN_AGENT_PRIVATE_KEY` and set `REIN_AGENT_ADDRESS` instead. The
server answers every question and cannot spend. Useful for giving a monitoring
agent, or a model you are still evaluating, visibility without authority.

---

## 2. HTTP API

```bash
REIN_API_TOKENS="book-keeper:$(openssl rand -hex 32)" npm run api
```

| | |
|---|---|
| `POST /v1/check` | `{ payee, amount, token, because }` |
| `POST /v1/pay` | same |
| `GET /v1/budget` | |
| `GET /v1/policy` | |

Bearer token in `Authorization`. Tokens are held as SHA-256 digests and compared
in constant time, so neither a log line nor a heap dump hands over the ability to
spend, and a wrong token cannot be walked byte by byte. Per-caller rate limits;
paying is limited six times harder than asking, because asking is free on chain
and an agent that checks before acting should not be punished for it. Binds to
loopback and refuses to start without a token.

A policy refusal is a **200** with `allowed: false` and a reason. A 4xx means the
request itself was wrong. Those are different things and an agent should treat
them differently.

---

## 3. Direct, from JavaScript

```js
const rein = require("./client/rein");

const why = rein.intent("pay supplier invoice 4471");
const data = usdc.interface.encodeFunctionData("transfer", [supplier, amount]);

const verdict = await rein.check(account, agent.address, usdcAddress, 0n, data, why);
if (!verdict.ok) return abstain(verdict.why);     // free: no gas, no revert

const { tx } = await rein.act(account, agentSigner, usdcAddress, 0n, data, why);
```

---

## A note on the instruction hash

Set `REIN_INTENT_SALT`. Without it the commitment is `keccak256(instruction)`,
and instructions are short and formulaic — "pay supplier invoice 4471" is
recoverable by anyone willing to enumerate invoice numbers. With a salt the
commitment is `keccak256(salt || instruction)`: still binding for the owner, who
knows the salt, and meaningless to everyone else.

Use the same salt for the life of the account, or the trail stops joining up.
