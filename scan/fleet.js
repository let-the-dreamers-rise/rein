// rein fleet: shadow mode for a platform's agent wallets.
//
//   npx rein-wallet fleet wallets.txt --webhook "$SLACK_WEBHOOK_URL"
//
// For each wallet, Rein learns its limits from the history before a cut-off
// (30 days ago by default), then replays everything since through the same
// judgement `check` uses, and reports every payment a second key would have
// held for a person to approve: a first payment to an address the agent had
// never paid, a payee it doesn't pay often enough to trust, a swap that sent
// its output elsewhere, more in an hour or a day than its history supports.
//
// Nothing is integrated, signed or held: it reads public chain data and says
// what would have happened. Run it once over 30 days to see what a second key
// would have caught, or every 15 minutes with `--since 30m` (cron, or the
// GitHub Action in scan/watch-action.yml with this command) to get each new
// one in Slack as it happens.
const fs = require("fs");
const path = require("path");
const { fetchHistory, toTrail, CHAINS } = require("./blockscout");
const { NATIVE } = require("./evaluate");
const { describe, namer, money } = require("./index");
const { readWallets } = require("./cli");
const { parseSince } = require("./watch");
const { learn, judge, WORDS } = require("./guard");
const { readRouterCall, strangers } = require("./moves");

const DAY = 86400;
const KEEP = 2 * DAY;

const HELD_WORDS = {
  ...WORDS,
  NEW_ADDRESS: "the first payment this agent ever made to that address",
};

/// The history as it stood before `since`.
const before = (history, since) => ({
  ...history,
  transactions: history.transactions.filter((t) => Date.parse(t.timestamp) / 1000 < since),
  tokenTransfers: history.tokenTransfers.filter((t) => Date.parse(t.timestamp) / 1000 < since),
});

/// What a second key would have held in one wallet's history since `since`.
/// Returns { address, status, learnedFrom, checked, held: [...] }; status is
/// "ok", or "too new" when there is too little before `since` to learn from.
function shadow(history, { since }) {
  const { rows, tokens } = toTrail(history, { payments: true });
  const name = namer(history, tokens);
  const after = rows.filter((r) => r.ts >= since);
  const base = { address: history.address, checked: after.length, held: [], learnedFrom: 0 };
  if (!after.length) return { ...base, status: "quiet" };
  let guard;
  try {
    guard = learn(before(history, since)).guard;
  } catch (err) {
    return { ...base, status: "too new", note: err.message };
  }
  base.learnedFrom = guard.learnedFrom.calls;
  const raw = new Map(history.transactions.map((t) => [t.hash, t.raw_input || "0x"]));
  const paidBefore = new Set(rows.filter((r) => r.ts < since && r.payee && r.kind !== "approve").map((r) => r.payee));

  const held = [];
  const skipped = new Set(); // held payments never left, so they don't use up later limits
  let from = 0;
  for (let i = rows.findIndex((r) => r.ts >= since); i < rows.length; i++) {
    const r = rows[i];
    while (rows[from].ts <= r.ts - KEEP) from++;
    const ledger = rows.slice(from, i).filter((x) => !skipped.has(x));
    let reason;
    if (r.kind === "call" && raw.has(r.tx)) {
      const call = readRouterCall(raw.get(r.tx));
      const bad = call && strangers(call, guard.wallet, r.target);
      if (bad) reason = "RECIPIENT_NOT_SELF";
    }
    reason ||= judge(guard, ledger, [r], r.ts);
    if (reason === "OK") {
      if (r.payee && r.kind !== "approve" && !r.derived) paidBefore.add(r.payee);
      continue;
    }
    if (reason === "PAYEE_NOT_ALLOWED" && !paidBefore.has(r.payee)) reason = "NEW_ADDRESS";
    if (r.payee && r.kind !== "approve" && !r.derived) paidBefore.add(r.payee);
    skipped.add(r);
    held.push({
      when: new Date(r.ts * 1000).toISOString(),
      tx: r.tx || null,
      what: describe(r, name),
      reason,
      why: HELD_WORDS[reason] || reason,
      ...(r.token ? { amount: r.amount, token: r.token === NATIVE ? "ETH" : name(r.token) } : {}),
      ...(r.payee ? { payee: r.payee } : {}),
    });
  }
  return { ...base, status: "ok", held };
}

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/// Totals across the fleet, by token.
function totals(results) {
  const by = {};
  for (const h of results.flatMap((r) => r.held)) if (h.amount != null) by[h.token] = (by[h.token] || 0) + Number(h.amount);
  return Object.entries(by).map(([t, v]) => `${money(v)} ${t}`);
}

/// The Slack message: a headline, then the held payments, newest first.
function slackText(results, { sinceLabel, explorer, limit = 15 }) {
  const held = results.flatMap((r) => r.held.map((h) => ({ ...h, wallet: r.address }))).sort((a, b) => b.when.localeCompare(a.when));
  const wallets = results.filter((r) => r.held.length).length;
  const sum = totals(results);
  const lines = [
    held.length
      ? `*Rein shadow mode:* ${held.length} payment${held.length === 1 ? "" : "s"} from ${wallets} of ${results.length} agent wallet${results.length === 1 ? "" : "s"} would have waited for a person's approval ${sinceLabel}${sum.length ? ` (${sum.join(", ")})` : ""}.`
      : `*Rein shadow mode:* nothing from ${results.length} agent wallet${results.length === 1 ? "" : "s"} would have been held ${sinceLabel}.`,
  ];
  for (const h of held.slice(0, limit)) {
    const link = h.tx && explorer ? ` <${explorer}/tx/${h.tx}|tx>` : "";
    lines.push(`• ${h.when.slice(0, 16).replace("T", " ")}  ${short(h.wallet)}  ${h.what}: ${h.why}${link}`);
  }
  if (held.length > limit) lines.push(`…and ${held.length - limit} more in the report.`);
  const young = results.filter((r) => r.status === "too new").length;
  if (young) lines.push(`${young} wallet${young === 1 ? " has" : "s have"} too little history to learn from yet.`);
  lines.push("Nothing was held: this is what a second key would have done. Read-only, from public chain data.");
  return lines.join("\n");
}

function markdownReport(results, { sinceLabel }) {
  const L = [`# Rein shadow mode`, "", slackText(results, { sinceLabel, limit: 0 }).split("\n")[0].replace(/\*/g, "**"), ""];
  L.push("| wallet | status | learned from | checked since | would have held |", "|---|---|---:|---:|---:|");
  for (const r of results) L.push(`| ${r.address} | ${r.status} | ${r.learnedFrom} | ${r.checked} | ${r.held.length} |`);
  for (const r of results.filter((x) => x.held.length)) {
    L.push("", `## ${r.address}`, "", "| when (UTC) | what | why | tx |", "|---|---|---|---|");
    for (const h of r.held) L.push(`| ${h.when.slice(0, 16).replace("T", " ")} | ${h.what} | ${h.why} | ${h.tx || ""} |`);
  }
  return `${L.join("\n")}\n`;
}

function parse(argv) {
  const o = { file: null, chain: "base", api: null, since: "30d", webhook: process.env.REIN_WEBHOOK || null, out: null, sample: false, always: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--chain") o.chain = argv[++i];
    else if (a === "--api") o.api = argv[++i];
    else if (a === "--since") o.since = argv[++i];
    else if (a === "--webhook") o.webhook = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--sample") o.sample = true;
    else if (a === "--always") o.always = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (!a.startsWith("-")) o.file = a;
    else throw new Error(`unknown flag ${a}`);
  }
  return o;
}

const USAGE = `usage: rein fleet <wallets.txt> [--since 30d] [--chain base|base-sepolia|ethereum] [--webhook URL] [--out dir]
       rein fleet --sample             Rein's made-up sample wallet, and a copy of it that got drained
  wallets.txt: one address per line (a CSV's first column works).
  --since 30m from cron posts only when something would have been held (add --always to post every run).`;

async function main(argv, { log = console.log, fetch: fetchImpl = globalThis.fetch, histories } = {}) {
  const o = parse(argv);
  if (o.help || (!o.file && !o.sample && !histories)) {
    console.error(USAGE);
    return o.help ? 0 : 2;
  }
  let list;
  if (histories) list = histories;
  else if (o.sample) list = sampleFleet();
  else list = readWallets(o.file);
  if (!list.length) throw new Error(`no addresses found in ${o.file}`);

  const latest = (h) => Math.max(...h.transactions.map((t) => Date.parse(t.timestamp) / 1000));
  const results = [];
  for (const [i, item] of list.entries()) {
    let history = item;
    if (typeof item === "string") {
      log(`(${i + 1}/${list.length}) reading ${item}…`);
      try {
        history = await fetchHistory(item, { chain: o.chain, api: o.api, fetch: fetchImpl });
      } catch (err) {
        results.push({ address: item, status: "error", note: err.message, checked: 0, held: [], learnedFrom: 0 });
        continue;
      }
    }
    // A sample's clock is its own last day; a live wallet's is now.
    const since = parseSince(o.since, history.synthetic ? latest(history) : Date.now() / 1000);
    results.push(shadow(history, { since }));
  }

  const unit = { s: "seconds", m: "minutes", h: "hours", d: "days" };
  const m = /^(\d+)([smhd])$/.exec(o.since);
  const sinceLabel = m ? `in the last ${m[1]} ${Number(m[1]) === 1 ? unit[m[2]].slice(0, -1) : unit[m[2]]}` : `since ${o.since}`;
  const explorer = CHAINS[o.chain]?.explorer || null;
  const text = slackText(results, { sinceLabel, explorer });
  log("");
  log(text.replace(/\*/g, "").replace(/<[^|>]+\|tx>/g, ""));
  if (o.out) {
    fs.mkdirSync(o.out, { recursive: true });
    fs.writeFileSync(path.join(o.out, "fleet.json"), `${JSON.stringify({ since: o.since, results }, null, 2)}\n`);
    fs.writeFileSync(path.join(o.out, "fleet.md"), markdownReport(results, { sinceLabel }));
    log(`\nWrote ${path.join(o.out, "fleet.md")} and fleet.json`);
  }
  const anyHeld = results.some((r) => r.held.length);
  if (o.webhook && (anyHeld || o.always)) {
    const res = await fetchImpl(o.webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, content: text }) });
    if (!res.ok) throw new Error(`the webhook answered ${res.status}`);
    log("Posted to the webhook.");
  }
  return 0;
}

/// The sample wallet, and a copy of it whose last week includes a drain: a
/// run of payments to an address it had never paid.
function sampleFleet() {
  const { sampleHistory, AGENT, USDC } = require("./sample");
  const honest = sampleHistory();
  const drained = JSON.parse(JSON.stringify(honest));
  const { ethers } = require("ethers");
  drained.address = ethers.getAddress("0x5a3e5a3e5a3e5a3e5a3e5a3e5a3e5a3e5a3e5a3e");
  const swap = (x) => (x && x.hash && x.hash.toLowerCase() === AGENT.toLowerCase() ? { ...x, hash: drained.address } : x);
  const me = (hex) => hex && hex.split(AGENT.slice(2).toLowerCase()).join(drained.address.slice(2).toLowerCase());
  for (const t of drained.transactions) (t.from = swap(t.from)), (t.raw_input = me(t.raw_input));
  for (const t of drained.tokenTransfers) (t.from = swap(t.from)), (t.to = swap(t.to));
  const last = Math.max(...drained.transactions.map((t) => Date.parse(t.timestamp)));
  const thief = { hash: "0x7777777777777777777777777777777777777777" };
  for (let i = 0; i < 3; i++) {
    const ts = new Date(last - (3 - i) * 3600 * 1000).toISOString();
    const hash = `0x${"d".repeat(63)}${i}`;
    drained.transactions.push({ hash, timestamp: ts, from: { hash: drained.address }, to: { hash: USDC.address }, value: "0", status: "ok", raw_input: transferData(thief.hash, 900 * 1e6), method: "transfer" });
  }
  drained.transactions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return [honest, drained];
}

function transferData(to, raw) {
  const { ethers } = require("ethers");
  return new ethers.Interface(["function transfer(address,uint256)"]).encodeFunctionData("transfer", [to, BigInt(raw)]);
}

module.exports = { shadow, slackText, markdownReport, main, parse, sampleFleet, USAGE };
