#!/usr/bin/env node
// One command for everything Rein does from a terminal.
//
//   npx github:let-the-dreamers-rise/rein scan 0xAgentWallet
//
//   rein scan 0x…            the policy a wallet's history supports, and what it
//                            holds with no on-chain limit (scan/cli.js)
//   rein watch 0x…           alert when that wallet steps outside the policy
//   rein apply plan.json     put an exported policy on Privy (or print it for
//                            Turnkey and Coinbase CDP)
//   rein mcp [--sandbox]     the MCP server, for Claude and any MCP client
//   rein api [--sandbox]     the HTTP API
//
// Reading and watching sign nothing and need no key.
const USAGE = `rein: a wallet your agent can operate and cannot drain.

  rein scan <address> [--chain base|base-sepolia|ethereum] [--out dir]
      The spending policy the wallet's own history supports, what it holds with
      no on-chain limit, and Turnkey / Coinbase CDP / Privy policy JSON.
      rein scan --sample runs a made-up wallet with no network.
      rein scan --batch wallets.csv --out reports scans many.

  rein watch <address> [--chain ...] [--policy report.json] [--webhook URL] [--every seconds]
      Holds every new transaction the wallet sends against that policy and
      alerts (to the terminal, and to a Slack or Discord webhook) the moment one
      falls outside it.

  rein apply <report>/export/privy.json --wallet <privy wallet id> [--send]
      Puts the scanned policy on the wallet engine it was written for: creates
      the spend window, the policy, and attaches it. Prints the requests
      unless --send (Privy: PRIVY_APP_ID and PRIVY_APP_SECRET). For Turnkey
      (--organization, --agent-user) and Coinbase CDP (--account) it prints
      the bodies to submit with their SDK.

  rein mcp --sandbox
      The MCP server with a funded sandbox account. Without --sandbox it reads
      REIN_RPC_URL, REIN_ACCOUNT and the rest from the environment.

  rein api --sandbox
      The same, as an HTTP API with a bearer key.

Nothing here signs or spends unless you give it an agent key.
More: github.com/let-the-dreamers-rise/rein/blob/main/QUICKSTART.md`;

function parseWatch(argv) {
  const o = { address: null, chain: "base", api: null, policyFile: null, webhook: process.env.REIN_WEBHOOK || null, every: 60, once: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--chain") o.chain = argv[++i];
    else if (a === "--api") o.api = argv[++i];
    else if (a === "--policy") o.policyFile = argv[++i];
    else if (a === "--webhook") o.webhook = argv[++i];
    else if (a === "--every") o.every = Number(argv[++i]);
    else if (a === "--once") o.once = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (!a.startsWith("-")) o.address = a;
    else throw new Error(`unknown flag ${a}`);
  }
  return o;
}

const APPLY_FLAGS = {
  "--wallet": "privy_wallet_id",
  "--organization": "turnkey_organization_id",
  "--agent-user": "turnkey_agent_user_id",
  "--agent-tag": "turnkey_agent_user_tag_id",
  "--account": "cdp_account_address",
};

function parseApply(argv) {
  const o = { file: null, send: false, vars: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (APPLY_FLAGS[a]) o.vars[APPLY_FLAGS[a]] = argv[++i];
    else if (a === "--send") o.send = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (!a.startsWith("-")) o.file = a;
    else throw new Error(`unknown flag ${a}`);
  }
  return o;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "scan":
      return require("../scan/cli").main(rest);
    case "watch": {
      const o = parseWatch(rest);
      if (o.help || !o.address) {
        console.error("usage: rein watch <address> [--chain base] [--policy report.json] [--webhook URL] [--every seconds]");
        return o.help ? 0 : 2;
      }
      const { watch, policyFrom } = require("../scan/watch");
      const policy = o.policyFile ? policyFrom(JSON.parse(require("fs").readFileSync(o.policyFile, "utf8"))) : undefined;
      await watch(o.address, { chain: o.chain, api: o.api, policy, webhook: o.webhook, interval: o.every * 1000, polls: o.once ? 1 : Infinity });
      return 0;
    }
    case "apply": {
      const o = parseApply(rest);
      if (o.help || !o.file) {
        console.error("usage: rein apply <report>/export/privy.json --wallet <id> [--send]");
        return o.help ? 0 : 2;
      }
      const plan = JSON.parse(require("fs").readFileSync(o.file, "utf8"));
      if (!plan.steps) throw new Error(`${o.file} is not an export from this version of rein scan; scan again`);
      const ids = await require("../scan/apply").apply(plan, { vars: o.vars, send: o.send });
      if (o.send) console.error(`\nThe policy is on the wallet. ${Object.entries(ids).map(([k, v]) => `${k.replace(/\.id$/, "")}: ${v}`).join(", ")}`);
      else console.error(`\nNothing was sent. ${plan.vendor === "privy" ? "Add --send to make these requests." : "Submit these with the vendor's SDK or CLI."}`);
      return 0;
    }
    case "mcp":
      require("../mcp/rein-mcp").main();
      return null; // runs until stdin closes
    case "api":
      require("../api/server").main();
      return null;
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.error(USAGE);
      return cmd ? 0 : 2;
    default:
      // `rein 0x…` is the scan most people mean.
      if (/^0x[0-9a-fA-F]{40}$/.test(cmd)) return require("../scan/cli").main(argv);
      console.error(`rein: unknown command "${cmd}"\n\n${USAGE}`);
      return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code != null) process.exit(code);
    },
    (err) => {
      console.error(`rein: ${err.message}`);
      process.exit(1);
    }
  );
}

module.exports = { main, parseWatch, parseApply };
