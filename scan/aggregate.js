#!/usr/bin/env node
// Turn a folder of rein-scan reports into the numbers for the public report,
// plus a private CSV for outreach. `rein-scan --batch` runs this for you at
// the end; it can also be run on its own over any folder of reports.
//
//   node scan/aggregate.js reports/ [--wallets wallets.csv] [--out summary]
//
// reports/   one sub-folder per wallet, as written by `rein-scan <addr> --out reports/<addr>`
//            (each holds report.json). Loose *.json files from `--json` also work.
// wallets.csv  optional: address,label[,team,contact] -- joined into the private CSV only.
// --out      prefix for <prefix>.md (public numbers, no addresses) and
//            <prefix>-private.csv (per wallet, for outreach; never publish it).
//
// Synthetic sample reports are counted separately and never enter the totals.
// Depends on nothing but node.
const fs = require("fs");
const path = require("path");

function args(argv) {
  const o = { dir: null, wallets: null, out: "summary" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--wallets") o.wallets = argv[++i];
    else if (argv[i] === "--out") o.out = argv[++i];
    else o.dir = argv[i];
  }
  if (!o.dir) {
    console.error("usage: node scan/aggregate.js <reports-dir> [--wallets wallets.csv] [--out prefix]");
    process.exit(2);
  }
  return o;
}

function loadReports(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const file = fs.statSync(p).isDirectory() ? path.join(p, "report.json") : name.endsWith(".json") ? p : null;
    if (!file || !fs.existsSync(file)) continue;
    try {
      const r = JSON.parse(fs.readFileSync(file, "utf8"));
      // errors.json and anything else that is not a scan report sit alongside.
      if (r && typeof r === "object" && r.address && r.verdict) out.push(r);
    } catch (e) {
      console.error(`skipped ${file}: ${e.message}`);
    }
  }
  return out;
}

function loadLabels(file) {
  const map = new Map();
  if (!file) return map;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const [address, label = "", team = "", contact = ""] = line.split(",").map((s) => s.trim());
    if (/^0x[0-9a-fA-F]{40}$/.test(address || "") && !map.has(address.toLowerCase())) map.set(address.toLowerCase(), { label, team, contact });
  }
  return map;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const usd = (x) => (x == null ? "?" : `$${Math.round(x).toLocaleString("en-US")}`);
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "?");
const csv = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function aggregate(reports) {
  const real = reports.filter((r) => !r.synthetic);
  const compiled = real.filter((r) => r.policy && r.coverage);
  const thin = compiled.filter((r) => r.caveats.some((c) => c.startsWith("Thin history")));
  const priced = compiled.filter((r) => r.exposureToday.usd != null && r.exposureUnderPolicy.usdPerHour != null);

  const reasons = {};
  for (const r of compiled) for (const [k, n] of Object.entries(r.coverage.reasons || {})) reasons[k] = (reasons[k] || 0) + n;

  const allowed = sum(compiled.map((r) => r.coverage.allowed));
  const total = sum(compiled.map((r) => r.coverage.total));
  const perWalletCoverage = compiled.filter((r) => r.coverage.total).map((r) => r.coverage.allowed / r.coverage.total);
  // Share of today's exposure still reachable in one hour, and in one day, under the policy.
  const hourShare = priced.filter((r) => r.exposureToday.usd > 0).map((r) => r.exposureUnderPolicy.usdPerHour / r.exposureToday.usd);
  const dayShare = priced.filter((r) => r.exposureToday.usd > 0).map((r) => (r.exposureUnderPolicy.usdPerDay ?? 0) / r.exposureToday.usd);

  return {
    scanned: reports.length,
    synthetic: reports.length - real.length,
    real: real.length,
    tooLittleHistory: real.length - compiled.length,
    compiled: compiled.length,
    thin: thin.length,
    contractWallets: compiled.filter((r) => r.isContract).length,
    noPayeeAdmitted: compiled.filter((r) => r.policy.onchain.payees.length === 0).length,
    withheldAnything: compiled.filter((r) => (r.policy.withheld || []).length > 0).length,
    exposureToday: { total: sum(priced.map((r) => r.exposureToday.usd)), median: median(priced.map((r) => r.exposureToday.usd)), n: priced.length },
    underPolicyPerHour: { total: sum(priced.map((r) => r.exposureUnderPolicy.usdPerHour)), median: median(priced.map((r) => r.exposureUnderPolicy.usdPerHour)) },
    medianHourShare: median(hourShare),
    medianDayShare: median(dayShare),
    coverage: { allowed, total, medianPerWallet: median(perWalletCoverage), perfect: perWalletCoverage.filter((c) => c === 1).length, of: perWalletCoverage.length },
    reasons,
  };
}

function publicMarkdown(a) {
  const L = [];
  L.push("# Scan totals (public: no addresses)", "");
  if (a.synthetic) L.push(`> ${a.synthetic} synthetic sample report(s) were found and left out of every number below.`, "");
  L.push(`- Wallets scanned: **${a.real}** real; ${a.tooLittleHistory} had too little history to compile a policy; **${a.compiled}** compiled (${a.thin} of them on thin history, ${a.contractWallets} contract wallets).`);
  L.push(`- Held with no on-chain limit on where it can go: **${usd(a.exposureToday.total)}** across the ${a.exposureToday.n} wallets with priced holdings (median wallet ${usd(a.exposureToday.median)}). A signing policy kept off chain (Privy, Turnkey, CDP) would not show up here.`);
  L.push(`- Under a policy compiled from each wallet's own history: **${usd(a.underPolicyPerHour.total)} an hour** in total, to payees each wallet already pays (median wallet ${usd(a.underPolicyPerHour.median)} an hour).`);
  if (a.medianHourShare != null) L.push(`- Median wallet: ${pct(a.medianHourShare, 1)} of its balance reachable in the first hour under the policy, ${pct(a.medianDayShare, 1)} in a day, against all of it with no on-chain limit.`);
  L.push(`- Honest recent calls still allowed: **${a.coverage.allowed} of ${a.coverage.total}** pooled (median wallet ${a.coverage.medianPerWallet == null ? "?" : pct(a.coverage.medianPerWallet, 1)}; ${a.coverage.perfect} of ${a.coverage.of} wallets at 100%).`);
  L.push(`- Wallets where the policy withheld something for a human: ${a.withheldAnything} of ${a.compiled}. Wallets where no payee had enough history to be admitted: ${a.noPayeeAdmitted}.`);
  const rs = Object.entries(a.reasons).sort((x, y) => y[1] - x[1]);
  if (rs.length) L.push("", "Why the policy refused honest calls:", "", "| reason | calls |", "|---|---:|", ...rs.map(([k, n]) => `| ${k} | ${n} |`));
  L.push("", "Every number travels with its denominator. Holdings without an explorer price are not in the dollar totals.", "");
  return L.join("\n");
}

function privateCsv(reports, labels) {
  const head = ["address", "label", "team", "contact", "chain", "today_usd", "policy_usd_per_hour", "coverage", "payees_admitted", "withheld", "thin", "synthetic", "verdict", "explorer"];
  const rows = [head.join(",")];
  for (const r of reports) {
    const l = labels.get((r.address || "").toLowerCase()) || {};
    rows.push(
      [
        r.address, l.label, l.team, l.contact, r.chain,
        r.exposureToday?.usd, r.exposureUnderPolicy?.usdPerHour,
        r.coverage ? `${r.coverage.allowed}/${r.coverage.total}` : "",
        r.policy ? r.policy.onchain.payees.length : "",
        r.policy ? (r.policy.withheld || []).length : "",
        (r.caveats || []).some((c) => c.startsWith("Thin history")) ? "yes" : "",
        r.synthetic ? "yes" : "",
        r.verdict, r.explorer,
      ].map(csv).join(",")
    );
  }
  return rows.join("\n") + "\n";
}

if (require.main === module) {
  const o = args(process.argv.slice(2));
  const reports = loadReports(o.dir);
  if (!reports.length) {
    console.error(`no report.json found under ${o.dir}`);
    process.exit(1);
  }
  const a = aggregate(reports);
  fs.writeFileSync(`${o.out}.md`, publicMarkdown(a));
  fs.writeFileSync(`${o.out}-private.csv`, privateCsv(reports, loadLabels(o.wallets)));
  process.stdout.write(publicMarkdown(a));
  console.error(`wrote ${o.out}.md (public) and ${o.out}-private.csv (keep private)`);
}

module.exports = { aggregate, publicMarkdown, privateCsv, loadReports, loadLabels };
