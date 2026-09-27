#!/usr/bin/env node
// One command for everything Rein does from a terminal.
//
//   npx github:let-the-dreamers-rise/rein scan 0xAgentWallet
//
//   rein scan 0x…            the policy a wallet's history supports, and what it
//                            holds with no on-chain limit (scan/cli.js)
//   rein watch 0x…           alert when that wallet steps outside the policy
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

module.exports = { main, parseWatch };
