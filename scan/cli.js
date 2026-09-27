#!/usr/bin/env node
// rein-scan: the spending policy an agent wallet's own history supports, and
// what it could lose with and without it.
//
//   rein-scan 0xAgentWallet                  Base, report to the terminal
//   rein-scan 0xAgentWallet --chain ethereum
//   rein-scan 0xAgentWallet --out ./report   also writes report.md, report.json,
//                                            trail.jsonl and the Turnkey,
//                                            Coinbase CDP and Privy policy JSON
//   rein-scan --sample                       a made-up wallet, no network
//
// Other flags: --json (the report as JSON), --naive (bounds from the raw
// maximum instead of the robust estimator), --max-pages N (history pages of
// 50 to read, default 20), --api URL (any Blockscout instance).
//
// Reads public chain data from a Blockscout explorer. Signs nothing.
const fs = require("fs");
const path = require("path");
const { scan, scanHistory, exportPolicy, markdown, summary, CHAINS } = require("./index");
const { sampleHistory } = require("./sample");

function parse(argv) {
  const opts = { chain: "base", robust: true, out: null, json: false, sample: false, maxPages: 20, api: null, address: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--chain") opts.chain = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "--naive") opts.robust = false;
    else if (a === "--sample") opts.sample = true;
    else if (a === "--max-pages") opts.maxPages = Number(argv[++i]);
    else if (a === "--api") opts.api = argv[++i];
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (!a.startsWith("-")) opts.address = a;
    else throw new Error(`unknown flag ${a}`);
  }
  return opts;
}

const USAGE = `usage: rein-scan <address> [--chain ${Object.keys(CHAINS).join("|")}] [--out dir] [--json] [--naive]
       rein-scan --sample`;

async function main(argv) {
  const opts = parse(argv);
  if (opts.help || (!opts.address && !opts.sample)) {
    console.error(USAGE);
    return opts.help ? 0 : 2;
  }
  if (!opts.sample) console.error(`reading ${opts.address} on ${opts.api || CHAINS[opts.chain]?.name || opts.chain}...`);
  const report = opts.sample ? scanHistory(sampleHistory(), opts) : await scan(opts.address, opts);

  if (opts.out) {
    fs.mkdirSync(path.join(opts.out, "export"), { recursive: true });
    fs.writeFileSync(path.join(opts.out, "report.md"), markdown(report));
    fs.writeFileSync(path.join(opts.out, "report.json"), `${JSON.stringify(summary(report), null, 2)}\n`);
    if (report.trail) fs.writeFileSync(path.join(opts.out, "trail.jsonl"), report.trail.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const exported = exportPolicy(report);
    if (exported) {
      for (const [vendor, body] of Object.entries(exported)) {
        fs.writeFileSync(path.join(opts.out, "export", `${vendor}.json`), `${JSON.stringify(body, null, 2)}\n`);
      }
    }
    console.error(`wrote ${opts.out}/report.md, report.json, trail.jsonl and export/`);
  }
  process.stdout.write(opts.json ? `${JSON.stringify(summary(report), null, 2)}\n` : markdown(report));
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`rein-scan: ${err.message}`);
      process.exit(1);
    }
  );
}

module.exports = { main, parse };
