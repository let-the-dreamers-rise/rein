// Where the MCP server and the HTTP API get their ReinClient: either the
// sandbox (a funded account on a chain inside this process, nothing to
// configure) or a real account named by the environment.
//
// The sandbox is only ever chosen on purpose -- `--sandbox` or REIN_SANDBOX=1
// -- never as a fallback for a missing variable. A server that quietly
// "pays" on a pretend chain because someone forgot REIN_RPC_URL would be
// worse than one that refuses to start.
const { ReinClient } = require("./account");

function pairs(value) {
  const out = {};
  for (const pair of (value || "").split(",")) {
    const idx = pair.indexOf(":");
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

function wantsSandbox(argv = process.argv, env = process.env) {
  return argv.includes("--sandbox") || /^(1|true|yes)$/i.test(env.REIN_SANDBOX || "");
}

function fromEnv(env = process.env) {
  const tokens = {};
  for (const [symbol, address] of Object.entries(pairs(env.REIN_TOKENS))) tokens[symbol.toUpperCase()] = address;
  return {
    rpcUrl: env.REIN_RPC_URL,
    account: env.REIN_ACCOUNT,
    agentKey: env.REIN_AGENT_PRIVATE_KEY || null,
    agentAddress: env.REIN_AGENT_ADDRESS || null,
    intentSalt: env.REIN_INTENT_SALT || null,
    tokens,
    payees: pairs(env.REIN_PAYEES),
  };
}

/// `--guard 0x…`, REIN_GUARD=0x… or REIN_GUARD_FILE=path: a wallet guarded
/// with `rein guard`, checked against its saved limits (scan/guard.js).
function wantsGuard(argv = process.argv, env = process.env) {
  const i = argv.indexOf("--guard");
  if (i >= 0) return argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[i + 1] : env.REIN_GUARD_FILE || env.REIN_GUARD || "";
  return env.REIN_GUARD_FILE || env.REIN_GUARD || null;
}

/// Resolves to { client, info, sandbox }. `info` is what rein_about returns.
async function openClient({ argv = process.argv, env = process.env } = {}) {
  const guarded = wantsGuard(argv, env);
  if (guarded != null) return require("../../scan/guard").guardClient(env.REIN_GUARD_FILE || guarded || null, env);
  if (wantsSandbox(argv, env)) {
    // Required lazily: the in-process EVM is only loaded by people using it.
    const { startSandbox } = require("../sandbox");
    const sb = await startSandbox();
    return { client: new ReinClient(sb.clientConfig), info: sb.info, sandbox: true };
  }

  const c = fromEnv(env);
  if (!c.rpcUrl) throw new Error("REIN_RPC_URL is not set. To try Rein with nothing configured, start the server with --sandbox");
  if (!c.account) throw new Error("REIN_ACCOUNT is not set");
  if (!c.agentKey && !c.agentAddress) {
    throw new Error("set REIN_AGENT_PRIVATE_KEY to spend, or REIN_AGENT_ADDRESS to run read-only");
  }
  const client = new ReinClient(c);
  return {
    client,
    sandbox: false,
    info: {
      network: c.rpcUrl,
      account: c.account,
      agentKey: client.agent,
      readOnly: client.readOnly,
      tokens: c.tokens,
      payees: c.payees,
    },
  };
}

module.exports = { wantsGuard, openClient, wantsSandbox, fromEnv, pairs };
