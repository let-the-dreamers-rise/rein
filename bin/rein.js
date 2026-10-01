#!/usr/bin/env node
// One command for everything Rein does from a terminal.
//
//   npx rein-wallet scan 0xAgentWallet
//
//   rein guard 0x…           learn the wallet's limits from its history and
//                            hold every payment to them with rein.check(tx)
//   rein fleet wallets.txt   what a second key would have held across many
//                            agent wallets, posted to Slack (shadow mode)
//   rein try                 a hijacked agent against a real Rein account, in a
//                            sandbox inside this process
//   rein scan 0x…            the policy a wallet's history supports, and what it
//                            holds with no on-chain limit (scan/cli.js)
//   rein watch 0x…           alert when that wallet steps outside the policy
//   rein apply plan.json     put an exported policy on Privy, Turnkey or
//                            Coinbase CDP
//   rein mcp [--sandbox]     the MCP server, for Claude and any MCP client
//   rein api [--sandbox]     the HTTP API
//
// Reading and watching sign nothing and need no key.
const USAGE = `rein: a wallet your agent can operate and cannot drain.

  rein guard <address> [--chain base|base-sepolia|ethereum] [--webhook URL]
      Learns the wallet's payees and hourly limits from its own history, shows
      what they would have allowed over the last 30 days, and saves them. Then
      one line before your agent signs holds every payment to them:
        const verdict = require("rein-wallet").check(tx)   // { allow, reason }
      Run it again to keep the limits current: they tighten on their own, and
      anything wider waits for rein guard <address> --approve.
      A payment outside the limits is held: rein guard <address> --allow <id>
      lets it through once. --new-payee-cap N lets small first payments through.
      A new wallet with little history: --cohort cohort.json (from rein fleet --out)
      starts it from the limits its sibling wallets share.

  rein approvals --public-url URL --webhook <Slack URL>
      Posts each held payment to Slack with a link to approve or refuse it.
      Needs REIN_APPROVAL_SECRET, kept where the agent can't read it.

  rein fleet <wallets.txt> [--since 30d] [--webhook URL] [--out dir]
      Shadow mode for many agent wallets: learns each one's limits from its
      history before --since, and reports to the terminal and Slack every
      payment since that a second key would have held for a person to approve.
      Wallets too new to learn from are held to what three or more others share;
      --out also saves that as cohort.json. Read-only.
      rein fleet --sample shows it on made-up wallets, one drained and one brand new.

  rein try
      A hijacked agent against a real Rein account on a private chain inside
      this process: one honest payment, then five ways to drain it. No keys.

  rein scan <address> [--chain base|base-sepolia|ethereum] [--out dir]
      The spending policy the wallet's own history supports, what it holds with
      no on-chain limit, and Turnkey / Coinbase CDP / Privy policy JSON.
      rein scan --sample runs a made-up wallet with no network.
      rein scan --batch wallets.csv --out reports scans many.

  rein watch <address> [--chain ...] [--policy report.json] [--webhook URL] [--every seconds]
      Holds every new transaction the wallet sends against that policy and
      alerts (to the terminal, and to a Slack or Discord webhook) the moment one
      falls outside it. With --since 20m it checks once and exits instead (1 with
      --fail-on-alert if anything fell outside), for cron or a scheduled
      GitHub Action, so nothing has to stay running.

  rein apply <report>/export/<privy|turnkey|coinbase>.json [ids] [--send]
      Puts the scanned policy on the wallet engine it was written for, in
      order, feeding each created id to the next request. Prints the requests
      unless --send. Ids and credentials, by engine:
        privy     --wallet <wallet id>        PRIVY_APP_ID, PRIVY_APP_SECRET
        turnkey   --organization <org id>     TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY
                  --agent-user <user id>      (or --agent-tag <tag id> for turnkey-fleet.json)
        coinbase  (the scanned address)       CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET

  rein mcp --sandbox
      The MCP server with a funded sandbox account. Without --sandbox it reads
      REIN_RPC_URL, REIN_ACCOUNT and the rest from the environment.

  rein api --sandbox
      The same, as an HTTP API with a bearer key.

Nothing here signs or spends unless you give it an agent key.
More: github.com/let-the-dreamers-rise/rein/blob/main/QUICKSTART.md`;

function parseWatch(argv) {
  const o = { address: null, chain: "base", api: null, policyFile: null, webhook: process.env.REIN_WEBHOOK || null, every: 60, once: false, since: null, failOnAlert: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--chain") o.chain = argv[++i];
    else if (a === "--api") o.api = argv[++i];
    else if (a === "--policy") o.policyFile = argv[++i];
    else if (a === "--webhook") o.webhook = argv[++i];
    else if (a === "--every") o.every = Number(argv[++i]);
    else if (a === "--once") o.once = true;
    else if (a === "--since") o.since = argv[++i];
    else if (a === "--fail-on-alert") o.failOnAlert = true;
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
    case "guard":
      return require("../scan/guard").main(rest);
    case "fleet":
      return require("../scan/fleet").main(rest);
    case "approvals":
      return require("../scan/approvals").main(rest);
    case "try":
      await require("./try").runTry();
      return 0;
    case "scan":
      return require("../scan/cli").main(rest);
    case "watch": {
      const o = parseWatch(rest);
      if (o.help || !o.address) {
        console.error("usage: rein watch <address> [--chain base] [--policy report.json] [--webhook URL] [--every seconds | --since 20m] [--fail-on-alert]");
        return o.help ? 0 : 2;
      }
      const { watch, policyFrom, parseSince } = require("../scan/watch");
      const policy = o.policyFile ? policyFrom(JSON.parse(require("fs").readFileSync(o.policyFile, "utf8"))) : undefined;
      const since = o.since != null ? parseSince(o.since) : undefined;
      const { alerts } = await watch(o.address, { chain: o.chain, api: o.api, policy, webhook: o.webhook, interval: o.every * 1000, polls: o.once ? 1 : Infinity, since });
      return o.failOnAlert && alerts.length ? 1 : 0;
    }
    case "apply": {
      const o = parseApply(rest);
      if (o.help || !o.file) {
        console.error("usage: rein apply <report>/export/<privy|turnkey|coinbase>.json [--wallet id | --organization id --agent-user id] [--send]");
        return o.help ? 0 : 2;
      }
      const plan = JSON.parse(require("fs").readFileSync(o.file, "utf8"));
      if (!plan.steps) throw new Error(`${o.file} is not an export from this version of rein scan; scan again`);
      const ids = await require("../scan/apply").apply(plan, { vars: o.vars, send: o.send });
      if (o.send) console.error(`\nThe policy is on the wallet. ${Object.entries(ids).map(([k, v]) => `${k.replace(/\.id$/, "")}: ${v}`).join(", ")}`);
      else console.error("\nNothing was sent. Add --send to make these requests.");
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
