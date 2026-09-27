#!/usr/bin/env node
// rein-scan: the spending policy an agent wallet's own history supports, and
// what it holds with no on-chain limit and what it could lose under that policy.
//
//   rein-scan 0xAgentWallet                  Base, report to the terminal
//   rein-scan 0xAgentWallet --chain ethereum
//   rein-scan 0xAgentWallet --out ./report   also writes report.md, report.json,
//                                            trail.jsonl and the Turnkey,
//                                            Coinbase CDP and Privy policy JSON
//   rein-scan --sample                       a made-up wallet, no network
//   rein-scan --batch wallets.csv --out reports
//                                            every wallet in the CSV, one
//                                            folder each, then the totals
//
// Other flags: --json (the report as JSON), --naive (bounds from the raw
// maximum instead of the robust estimator), --max-pages N (history pages of
// 50 to read, default 20), --api URL (any Blockscout instance), --pause MS
// (between wallets in a batch, default 2000).
//
// Reads public chain data from a Blockscout explorer. Signs nothing.
const fs = require("fs");
const path = require("path");
const { scan, scanHistory, exportPolicy, exportFleet, markdown, summary, CHAINS } = require("./index");
const { sampleHistory } = require("./sample");
const { aggregate, publicMarkdown, privateCsv, loadReports, loadLabels } = require("./aggregate");

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function parse(argv) {
  const opts = { chain: "base", robust: true, out: null, json: false, sample: false, maxPages: 20, api: null, address: null, batch: null, pause: 2000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--chain") opts.chain = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "--naive") opts.robust = false;
    else if (a === "--sample") opts.sample = true;
    else if (a === "--max-pages") opts.maxPages = Number(argv[++i]);
    else if (a === "--api") opts.api = argv[++i];
    else if (a === "--batch") opts.batch = argv[++i];
    else if (a === "--pause") opts.pause = Number(argv[++i]);
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (!a.startsWith("-")) opts.address = a;
    else throw new Error(`unknown flag ${a}`);
  }
  return opts;
}

const USAGE = `usage: rein-scan <address> [--chain ${Object.keys(CHAINS).join("|")}] [--out dir] [--json] [--naive]
       rein-scan --sample
       rein-scan --batch wallets.csv --out dir [--chain ...] [--pause ms]`;

function writeReport(report, dir) {
  fs.mkdirSync(path.join(dir, "export"), { recursive: true });
  fs.writeFileSync(path.join(dir, "report.md"), markdown(report));
  fs.writeFileSync(path.join(dir, "report.json"), `${JSON.stringify(summary(report), null, 2)}\n`);
  if (report.trail) fs.writeFileSync(path.join(dir, "trail.jsonl"), report.trail.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const exported = exportPolicy(report);
  if (exported) {
    for (const [vendor, body] of Object.entries(exported)) {
      fs.writeFileSync(path.join(dir, "export", `${vendor}.json`), `${JSON.stringify(body, null, 2)}\n`);
    }
  }
}

/// The addresses in a wallets CSV (address,label,team,contact; a header row
/// or blank lines are fine), each once, in file order.
function readWallets(file) {
  const seen = new Set();
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const address = line.split(",")[0].trim();
    if (!ADDRESS.test(address) || seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    out.push(address);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// Scans every wallet in opts.batch into opts.out/<address>/, one at a time
/// with a pause between them so a free explorer is not hammered, retrying a
/// failed wallet once. Failures go to errors.json rather than stopping the
/// run. Ends with summary.md (public totals, no addresses) and
/// summary-private.csv (per wallet, with the CSV's labels and contacts).
async function runBatch(opts, { scanOne = (a) => scan(a, opts), log = console.error } = {}) {
  const wallets = readWallets(opts.batch);
  if (!wallets.length) throw new Error(`no addresses found in ${opts.batch}`);
  fs.mkdirSync(opts.out, { recursive: true });
  const errors = [];
  const compiled = [];
  for (const [i, address] of wallets.entries()) {
    if (i) await sleep(opts.pause);
    let report = null;
    for (let attempt = 1; attempt <= 2 && !report; attempt++) {
      try {
        report = await scanOne(address);
      } catch (err) {
        if (attempt === 2) errors.push({ address, error: err.message });
        else {
          log(`  ${address}: ${err.message}; retrying once`);
          await sleep(opts.pause * 2.5);
        }
      }
    }
    if (report) {
      writeReport(report, path.join(opts.out, address.toLowerCase()));
      compiled.push(report);
      log(`[${i + 1}/${wallets.length}] ${address}: ${report.verdict}`);
    } else log(`[${i + 1}/${wallets.length}] ${address}: failed twice, skipped`);
  }
  fs.writeFileSync(path.join(opts.out, "errors.json"), `${JSON.stringify(errors, null, 2)}\n`);
  const reports = loadReports(opts.out);
  const totals = aggregate(reports);
  fs.writeFileSync(path.join(opts.out, "summary.md"), publicMarkdown(totals));
  fs.writeFileSync(path.join(opts.out, "summary-private.csv"), privateCsv(reports, loadLabels(opts.batch)));
  const fleet = exportFleet(compiled);
  if (fleet) fs.writeFileSync(path.join(opts.out, "turnkey-fleet.json"), `${JSON.stringify(fleet, null, 2)}\n`);
  log(`scanned ${reports.length} of ${wallets.length}; wrote ${opts.out}/summary.md (public) and summary-private.csv (keep private)`);
  return { wallets: wallets.length, scanned: reports.length, errors, totals, fleet };
}

async function main(argv) {
  const opts = parse(argv);
  if (opts.batch) {
    if (!opts.out) throw new Error("--batch needs --out <dir>");
    const { errors } = await runBatch(opts);
    return errors.length ? 1 : 0;
  }
  if (opts.help || (!opts.address && !opts.sample)) {
    console.error(USAGE);
    return opts.help ? 0 : 2;
  }
  if (!opts.sample) console.error(`reading ${opts.address} on ${opts.api || CHAINS[opts.chain]?.name || opts.chain}...`);
  const report = opts.sample ? scanHistory(sampleHistory(), opts) : await scan(opts.address, opts);

  if (opts.out) {
    writeReport(report, opts.out);
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

module.exports = { main, parse, runBatch, readWallets, writeReport };
