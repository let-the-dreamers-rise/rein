#!/usr/bin/env node
// Rein as an MCP server: the whole account, reachable by any agent that speaks
// Model Context Protocol, over stdio, with no SDK to install.
//
// This file is the protocol; mcp/lib/account.js is the money. It is written
// against the raw JSON-RPC framing rather than an SDK on purpose -- the repo's
// promise is that a stranger can read the thing that guards their money, and
// one more dependency in that path is one more thing they have to trust.
//
// Try it with nothing configured -- a funded account on a chain inside this
// process, the policy already written:
//
//   claude mcp add rein -- node /path/to/rein/mcp/rein-mcp.js --sandbox
//
// Or point it at a real account with these in the environment:
//
//   REIN_RPC_URL             the chain the account lives on
//   REIN_ACCOUNT             the ReinAccount address
//   REIN_AGENT_PRIVATE_KEY   optional. Without it the server is read-only:
//                            it can answer questions and cannot spend.
//   REIN_AGENT_ADDRESS       optional, for read-only use without a key
//   REIN_TOKENS              "USDC:0x...,USDT:0x..."
//   REIN_PAYEES              optional address book, "acme:0x...,northwind:0x..."
//   REIN_INTENT_SALT         optional but recommended: salts the instruction
//                            commitment so it is not readable by strangers

const readline = require("readline");
const { openClient, wantsGuard } = require("./lib/config");
const { NAMES, explain } = require("../scripts/codes");

const PROTOCOL_VERSION = "2024-11-05";
const SERVER = { name: "rein", version: require("../package.json").version };

// The descriptions below are the real interface. A model decides whether to
// check before paying based on what these say, so they state the two facts that
// change its behaviour: checking is free, and a refusal comes with a reason it
// can act on. An agent that knows both will abstain and explain instead of
// retrying blindly, which is the entire behaviour this account was built to buy.
const PAYEE = {
  type: "string",
  description: 'The recipient: an address (0x...), or a payee name from rein_about such as "acme".',
};

const TOOLS = [
  {
    name: "rein_about",
    description:
      "Start here. Which Rein account you are operating, on which network, who you may pay, and the limits the account enforces on you. " +
      "In the sandbox it also says what to try. Call this once before your first payment and whenever a person asks what you are allowed to do.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "rein_check_payment",
    description:
      "Ask whether a payment would be allowed, WITHOUT making it. This is free: a read-only check that costs no gas and moves nothing. " +
      "Always call this before rein_pay. If it refuses, you get the exact reason (for example PAYEE_NOT_ALLOWED or TOKEN_PER_WINDOW) and how much budget is left, " +
      "so you can pay a smaller amount, wait for the window to roll, or tell the person why you are not going to do it. Do not retry a refused payment unchanged, and do not look for another route around it: the refusal is the owner's decision, not an obstacle.",
    inputSchema: {
      type: "object",
      properties: {
        payee: PAYEE,
        amount: { type: "string", description: 'Amount in normal units, e.g. "250" or "12.50". Not wei.' },
        token: { type: "string", description: 'Token symbol (e.g. "USDC") or address.' },
        because: {
          type: "string",
          description:
            "The instruction you are acting on, in one sentence, e.g. 'pay supplier invoice 4471'. A hash of this is recorded on chain with the payment so the owner can later join it to your logs.",
        },
      },
      required: ["payee", "amount", "token", "because"],
    },
  },
  {
    name: "rein_pay",
    description:
      "Make a payment from the Rein account. The account checks the owner's policy first and refuses if the payment is outside it; a refusal costs nothing and returns the reason. " +
      "You must say what instruction you are acting on in `because` -- it is recorded with the payment. Never invent a reason you were not given.",
    inputSchema: {
      type: "object",
      properties: {
        payee: PAYEE,
        amount: { type: "string", description: "Amount in normal units, not wei." },
        token: { type: "string", description: 'Token symbol (e.g. "USDC") or address.' },
        because: { type: "string", description: "The instruction behind this payment, in one sentence." },
      },
      required: ["payee", "amount", "token", "because"],
    },
  },
  {
    name: "rein_budget",
    description:
      "What this agent key can still spend right now: remaining amount per token in the current rolling window, calls left, whether the key is active, and whether a guardian has stopped it. " +
      "Call this before planning any sequence of payments, so you plan inside the budget instead of discovering it one refusal at a time.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "rein_policy",
    description:
      "The spending policy in force for this agent: window length, ceilings, expiry, and whether stating a reason is required. Use it to explain to a person what you are and are not permitted to do.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "rein_scan_wallet",
    description:
      "Scan any agent wallet's public history and report the spending policy that history supports: who it pays, how much an hour, " +
      "what it holds with no on-chain limit on where it can go, what it could move under the compiled policy, and how many of its " +
      "recent calls that policy would have refused. Read-only public chain data; it signs and spends nothing, and needs no Rein account. " +
      'Pass address "sample" for Rein\'s made-up example wallet, which needs no network.',
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: 'The wallet address (0x...), or "sample".' },
        chain: { type: "string", enum: ["base", "base-sepolia", "ethereum"], description: "Default base." },
      },
      required: ["address"],
    },
  },
  {
    name: "rein_explain_refusal",
    description:
      "Turn a Rein refusal code or name into plain words. Useful when another tool surfaced a raw code and you want to explain it to a person.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", description: 'A code number or name, e.g. "13" or "PAYEE_NOT_ALLOWED".' } },
      required: ["code"],
    },
  },
];

// With --guard, Rein checks payments the agent makes with its own wallet: it
// doesn't pay, and an allowed check is counted against the hour, because the
// agent is about to sign it.
const GUARD_TOOLS = TOOLS.filter((t) => t.name !== "rein_pay").map((t) =>
  t.name !== "rein_check_payment"
    ? t
    : {
        ...t,
        description:
          "Call this before you sign any payment with your wallet. It answers allow or block with the reason, from limits learned from this wallet's own history. " +
          "An allowed payment is counted against this hour and day, so call it once per payment, right before you sign. " +
          "If it blocks, the reason says why (for example PAYEE_NOT_ALLOWED or TOKEN_PER_WINDOW); a payment that is held waits for a person to approve it, so tell them and retry the same payment later. Do not look for another way to make it.",
      }
);

// Opened on first use rather than at startup, so a misconfigured server still
// answers initialize and tools/list and can explain what is wrong through the
// tool result, where the person will actually see it. A failed open is not
// cached: fixing the environment and calling again should work.
let opening = null;
function rein() {
  if (!opening) {
    opening = openClient().catch((err) => {
      opening = null;
      throw err;
    });
  }
  return opening;
}

async function callTool(name, args) {
  switch (name) {
    case "rein_about":
      return (await rein()).info;
    case "rein_check_payment":
      return (await rein()).client.check(args);
    case "rein_pay":
      return (await rein()).client.pay(args);
    case "rein_budget":
      return (await rein()).client.budget();
    case "rein_policy":
      return (await rein()).client.policy();
    case "rein_scan_wallet": {
      // Required here rather than at the top: the scanner is not needed to
      // answer any other tool, and a server that only pays should not load it.
      const { scan, scanHistory, markdown } = require("../scan");
      const addr = String(args.address || "").trim();
      const report =
        addr.toLowerCase() === "sample"
          ? scanHistory(require("../scan/sample").sampleHistory())
          : await scan(addr, { chain: args.chain || "base" });
      return markdown(report);
    }
    case "rein_explain_refusal": {
      const raw = String(args.code).trim();
      const code = /^\d+$/.test(raw) ? Number(raw) : NAMES.indexOf(raw.toUpperCase());
      if (code < 0) return { code: raw, known: false, explanation: `no Rein refusal is called "${raw}"` };
      return { code, name: NAMES[code] ?? `UNKNOWN(${code})`, explanation: explain(code) || "the call was permitted" };
    }
    default:
      throw new Error(`no such tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;

  // Notifications carry no id and expect no answer.
  if (id === undefined || id === null) return;

  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER,
      });

    case "ping":
      return reply(id, {});

    case "tools/list":
      return reply(id, { tools: wantsGuard() ? GUARD_TOOLS : TOOLS });

    case "tools/call": {
      const toolName = params?.name;
      try {
        const result = await callTool(toolName, params?.arguments || {});
        return reply(id, {
          content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
          isError: false,
        });
      } catch (err) {
        // A refusal is not an error, but a misconfiguration is, and the agent
        // should be able to tell them apart from the text alone.
        return reply(id, {
          content: [{ type: "text", text: `rein could not answer: ${err.message}` }],
          isError: true,
        });
      }
    }

    default:
      return fail(id, -32601, `method not found: ${method}`);
  }
}

function main() {
  // stdout is the protocol. Anything a dependency prints there would corrupt
  // the stream, so ordinary logging goes to stderr for the life of the process.
  console.log = console.error;
  console.info = console.error;

  // Start the sandbox chain while the client is still shaking hands, so the
  // first tool call does not wait for four deployments. A real-account
  // misconfiguration is left for the first tool call to report.
  rein().catch(() => {});
  let queue = Promise.resolve();
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return fail(null, -32700, "parse error");
    }
    // One message at a time, in the order they arrived. Two payments in flight
    // from one key would race for the same nonce, and a budget read that
    // overtakes the payment before it would report money that is already gone.
    queue = queue.then(() => handle(msg)).catch((err) => fail(msg.id ?? null, -32603, err.message));
  });
  rl.on("close", () => queue.then(() => process.exit(0)));
}

if (require.main === module) main();

module.exports = { TOOLS, handle, callTool, rein, main };
