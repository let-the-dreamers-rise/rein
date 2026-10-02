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
//
// A wallet too new to learn from is checked against its siblings: once three
// or more wallets in the list have history, Rein keeps what most of them share
// (cohort.js) and holds the newcomers to that. `--out` saves it as
// cohort.json, which `rein guard <new wallet> --cohort cohort.json` uses.
const fs = require("fs");
const path = require("path");
const { fetchHistory, toTrail, CHAINS } = require("./blockscout");
const { NATIVE } = require("./evaluate");
const { describe, namer, money } = require("./index");
const { readWallets } = require("./cli");
const { parseSince } = require("./watch");
const { learn, judge, WORDS, COHORT_UNTIL, looksLike } = require("./guard");
const { cohortFrom, guardFromCohort } = require("./cohort");
const { readRouterCall, strangers } = require("./moves");

const DAY = 86400;
const KEEP = 2 * DAY;

const HELD_WORDS = {
  ...WORDS,
  NEW_ADDRESS: "the first payment this agent ever made to that address",
  NEW_ADDRESS_OVER_100: "a first-ever payment of over $100 to an address this agent had never paid",
  BURST: "more in one hour than three times this agent's busiest hour before",
};

const STABLES = /^(USDC|USDbC|USDT|DAI|USDS|EURC|PYUSD)$/i;

// Public RPCs to fall back on when the explorer's RPC turns a reader away.
const PUBLIC_RPC = { base: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"] };

/// The numbers an outreach note quotes, by two plain rules anyone can check
/// on a block explorer: a first-ever payment over $100 to an address the
/// wallet had never paid, and an hour in which it sent more than 3× its own
/// busiest hour before `since`. Dollar values use today's prices.
function measure(rows, tokens, history, since) {
  const rate = (t) => (t === NATIVE ? (history.info?.exchange_rate != null ? Number(history.info.exchange_rate) : null) : tokens[t]?.rate ?? (STABLES.test(tokens[t]?.symbol || "") ? 1 : null));
  const isPayment = (r) => !r.derived && r.payee && (r.kind === "transfer" || r.kind === "transferFrom") && Number(r.amount) > 0;
  const paid = new Set();
  const peak = {}; // token -> busiest hour before since
  const hours = {}; // `${token}:${hour}` -> total, before since
  const firstOver100 = [];
  const after = [];
  for (const r of rows) {
    if (!isPayment(r)) continue;
    if (r.ts < since) {
      const k = `${r.token}:${Math.floor(r.ts / 3600)}`;
      hours[k] = (hours[k] || 0) + Number(r.amount);
      peak[r.token] = Math.max(peak[r.token] || 0, hours[k]);
    } else {
      after.push(r);
      const usd = rate(r.token) != null ? Number(r.amount) * rate(r.token) : null;
      if (!paid.has(r.payee) && usd != null && usd > 100) firstOver100.push(r);
    }
    paid.add(r.payee);
  }
  const later = {};
  for (const r of after) {
    const k = `${r.token}:${Math.floor(r.ts / 3600)}`;
    (later[k] ||= { token: r.token, total: 0, rows: [] }).total += Number(r.amount);
    later[k].rows.push(r);
  }
  const bursts = Object.values(later).filter((h) => peak[h.token] > 0 && h.total > 3 * peak[h.token]);
  const flagged = new Set([...firstOver100, ...bursts.flatMap((h) => h.rows)]);
  const out = { payments: after.length, firstOver100: firstOver100.length, burstHours: new Set(bursts.map((h) => h.rows[0].ts - (h.rows[0].ts % 3600))).size, wouldHold: flagged.size };
  // Which rows, and by which rule, for a wallet too new for the full guard.
  const first = new Set(firstOver100);
  Object.defineProperty(out, "rows", { value: [...flagged].sort((a, b) => a.ts - b.ts).map((r) => ({ row: r, reason: first.has(r) ? "NEW_ADDRESS" : "BURST" })) });
  return out;
}

/// The history as it stood before `since`.
const before = (history, since) => ({
  ...history,
  transactions: history.transactions.filter((t) => Date.parse(t.timestamp) / 1000 < since),
  tokenTransfers: history.tokenTransfers.filter((t) => Date.parse(t.timestamp) / 1000 < since),
});

/// What a second key would have held in one wallet's history since `since`.
/// Returns { address, status, learnedFrom, checked, held: [...] }; status is
/// "ok", "cohort" when it was too new and `cohort` stood in for its own
/// history, "simple rules" when there is too little before `since` to learn
/// from (a first payment over $100 to a new address, or a burst, is held), or
/// "quiet". `guard` is the guard it was judged by (left out of reports).
function shadow(history, { since, cohort = null }) {
  const { rows, tokens, ignored = [] } = toTrail(history, { payments: true });
  const name = namer(history, tokens);
  const after = rows.filter((r) => r.ts >= since);
  const lastActive = rows.length ? new Date(rows[rows.length - 1].ts * 1000).toISOString() : null;
  // Address poisoning: transfers it never sent, to addresses that start and
  // end like ones it really pays.
  const real = [...new Set(rows.filter((r) => !r.derived && r.payee && r.kind !== "approve").map((r) => r.payee))];
  const fakes = ignored.filter((x) => x.payee && real.some((p) => looksLike(p, x.payee)));
  const poisoned = fakes.length ? { fakeTransfers: fakes.length, lookalikes: new Set(fakes.map((x) => x.payee)).size, last: fakes.map((x) => x.when).filter(Boolean).sort().pop() || null } : null;
  const base = { address: history.address, checked: after.length, held: [], learnedFrom: 0, lastActive, poisoned, measured: measure(rows, tokens, history, since) };
  if (!after.length) return { ...base, status: "quiet" };
  let guard;
  let status = "ok";
  try {
    guard = learn(before(history, since)).guard;
  } catch (err) {
    // Too little history for its own limits and no cohort: the two simple
    // rules still hold a first big payment to a new address, or a burst.
    if (!cohort) {
      const held = base.measured.rows.map(({ row: r, reason }) => ({
        when: new Date(r.ts * 1000).toISOString(),
        tx: r.tx || null,
        what: describe(r, name),
        reason,
        why: HELD_WORDS[reason === "NEW_ADDRESS" ? "NEW_ADDRESS_OVER_100" : reason],
        amount: r.amount,
        token: r.token === NATIVE ? "ETH" : name(r.token),
        payee: r.payee,
      }));
      return { ...base, status: "simple rules", held, note: err.message };
    }
  }
  // As `rein guard` does: a cohort stands in until the wallet has enough of its own.
  if (cohort && (!guard || guard.learnedFrom.calls < COHORT_UNTIL)) {
    guard = guardFromCohort(cohort, history.address, { chain: history.chain });
    status = "cohort";
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
    if (reason === "PAYEE_NOT_ALLOWED" && [...guard.policy.transferPayees, ...paidBefore].some((p) => looksLike(p, r.payee))) reason = "LOOKALIKE_PAYEE";
    else if (reason === "PAYEE_NOT_ALLOWED" && !paidBefore.has(r.payee)) reason = "NEW_ADDRESS";
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
  return { ...base, status, held, guard };
}

/// Shadow every wallet; then, if three or more had enough history, build their
/// cohort and check the ones with too little against it.
function shadowFleet(entries) {
  const results = entries.map(({ history, since, error }) => (error ? error : shadow(history, { since })));
  const grown = (r) => r.status === "ok" && r.guard.learnedFrom.calls >= COHORT_UNTIL;
  const learned = results.filter(grown).map((r) => r.guard);
  let cohort = null;
  if (learned.length >= 3) {
    cohort = cohortFrom(learned);
    for (const [i, r] of results.entries()) if (r.status === "simple rules" || (r.status === "ok" && !grown(r))) results[i] = shadow(entries[i].history, { since: entries[i].since, cohort });
  }
  return { results: results.map(({ guard, ...r }) => r), cohort };
}

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/// Totals across the fleet, by token.
function totals(results) {
  const by = {};
  for (const h of results.flatMap((r) => r.held)) if (h.amount != null) by[h.token] = (by[h.token] || 0) + Number(h.amount);
  return Object.entries(by).map(([t, v]) => `${money(v)} ${t}`);
}

/// [W], [P], [N], [B], [H] across the fleet.
function fleetNumbers(results) {
  const m = results.map((r) => r.measured).filter(Boolean);
  const add = (k) => m.reduce((a, x) => a + x[k], 0);
  return { wallets: m.length, payments: add("payments"), firstOver100: add("firstOver100"), burstHours: add("burstHours"), wouldHold: add("wouldHold"), poisoned: results.filter((r) => r.poisoned).length };
}

function numbersLine(results, sinceLabel) {
  const n = fleetNumbers(results);
  const share = n.payments ? ` (${Math.round((100 * n.wouldHold) / n.payments)}%)` : "";
  const held = results.reduce((a, r) => a + r.held.length, 0);
  const tail = held > n.wouldHold ? ` The full guard held ${held}, above.` : "";
  return `${n.wallets} wallet${n.wallets === 1 ? "" : "s"} read. ${n.payments} payment${n.payments === 1 ? "" : "s"} ${sinceLabel}: ${n.firstOver100} first-ever payment${n.firstOver100 === 1 ? "" : "s"} over $100 to an address that wallet had never paid, and ${n.burstHours} hour${n.burstHours === 1 ? "" : "s"} where a wallet sent more than 3× its own earlier peak. By those two simple rules, ${n.wouldHold} of the ${n.payments} payment${n.payments === 1 ? "" : "s"}${share} would have waited.${tail}`;
}

/// The Slack message: a headline, then the held payments, newest first.
function slackText(results, { sinceLabel, explorer, limit = 15 }) {
  const held = results.flatMap((r) => r.held.map((h) => ({ ...h, wallet: r.address }))).sort((a, b) => b.when.localeCompare(a.when));
  const wallets = results.filter((r) => r.held.length).length;
  const sum = totals(results);
  const quiet = results.filter((r) => r.status === "quiet");
  const n = results.length;
  const lines = [
    held.length
      ? `*Rein shadow mode:* ${held.length} payment${held.length === 1 ? "" : "s"} or approval${held.length === 1 ? "" : "s"} from ${wallets} of ${n} agent wallet${n === 1 ? "" : "s"} would have waited for a person ${sinceLabel}${sum.length ? ` (${sum.join(", ")})` : ""}.`
      : quiet.length === n
        ? `*Rein shadow mode:* ${n === 1 ? "this agent wallet" : `none of the ${n} agent wallets`} made a transaction ${sinceLabel}, so there was nothing to hold.`
        : `*Rein shadow mode:* everything the ${n - quiet.length} active agent wallet${n - quiet.length === 1 ? "" : "s"} did ${sinceLabel} fit ${n - quiet.length === 1 ? "its" : "their"} habits; nothing would have been held.`,
  ];
  for (const h of held.slice(0, limit)) {
    const link = h.tx && explorer ? ` <${explorer}/tx/${h.tx}|tx>` : "";
    lines.push(`• ${h.when.slice(0, 16).replace("T", " ")}  ${short(h.wallet)}  ${h.what}: ${h.why}${link}`);
  }
  if (held.length > limit) lines.push(`…and ${held.length - limit} more in the report.`);
  const poisoned = results.filter((r) => r.poisoned);
  if (poisoned.length) lines.push(`Being address-poisoned: ${poisoned.length} of ${n} wallet${n === 1 ? "" : "s"} received fake transfers from addresses dressed up as ones they pay (${poisoned.slice(0, 5).map((r) => `${short(r.address)}, ${r.poisoned.fakeTransfers}, latest ${r.poisoned.last ? r.poisoned.last.slice(0, 10) : "unknown"}`).join("; ")}${poisoned.length > 5 ? ` and ${poisoned.length - 5} more` : ""}). Rein ignores those transfers and holds any payment to a lookalike.`);
    if (quiet.length) lines.push(`Quiet ${sinceLabel}: ${quiet.slice(0, 5).map((r) => `${short(r.address)} (last active ${r.lastActive ? r.lastActive.slice(0, 10) : "never"})`).join(", ")}${quiet.length > 5 ? ` and ${quiet.length - 5} more` : ""}.`);
  const simple = results.filter((r) => r.status === "simple rules").length;
  if (simple) lines.push(`${simple} wallet${simple === 1 ? " has" : "s have"} too little history for limits of ${simple === 1 ? "its" : "their"} own, so ${simple === 1 ? "it was" : "they were"} held to the two simple rules: a first payment over $100 to a new address, or 3× its busiest hour.`);
  const young = results.filter((r) => r.status === "too new").length;
  const cohort = results.filter((r) => r.status === "cohort").length;
  if (cohort) lines.push(`${cohort} new wallet${cohort === 1 ? " was" : "s were"} held to the limits the others share, having too little history of ${cohort === 1 ? "its" : "their"} own.`);
  if (young) lines.push(`${young} wallet${young === 1 ? " has" : "s have"} too little history to learn from yet${cohort ? "" : " (three or more wallets with history give new ones a shared starting point)"}.`);
  lines.push("Nothing was held: this is what a second key would have done. Read-only, from public chain data.");
  return lines.join("\n");
}

function markdownReport(results, { sinceLabel }) {
  const L = [`# Rein shadow mode`, "", slackText(results, { sinceLabel, limit: 0 }).split("\n")[0].replace(/\*/g, "**"), "", numbersLine(results, sinceLabel), ""];
  L.push("| wallet | status | learned from | checked since | would have held | payments | first-ever over $100 | hours over 3× peak |", "|---|---|---:|---:|---:|---:|---:|---:|");
  for (const r of results) L.push(`| ${r.address} | ${r.status} | ${r.learnedFrom} | ${r.checked} | ${r.held.length} | ${r.measured?.payments ?? ""} | ${r.measured?.firstOver100 ?? ""} | ${r.measured?.burstHours ?? ""} |`);
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
    else if (a === "--olas") o.olas = Number(argv[++i]);
    else if (a === "--rpc") o.rpc = argv[++i];
    else if (a === "-h" || a === "--help") o.help = true;
    else if (!a.startsWith("-")) o.file = a;
    else throw new Error(`unknown flag ${a}`);
  }
  return o;
}

const USAGE = `usage: rein fleet <wallets.txt> [--since 30d] [--chain base|base-sepolia|ethereum] [--webhook URL] [--out dir]
       rein fleet --sample             Rein's made-up sample wallets: one drained, one brand new
       rein fleet --olas 20 [--rpc URL]  the newest 20 deployed Olas agent services' wallets on Base
  wallets.txt: one address per line (a CSV's first column works).
  --since 30m from cron posts only when something would have been held (add --always to post every run).`;

async function main(argv, { log = console.log, fetch: fetchImpl = globalThis.fetch, histories } = {}) {
  const o = parse(argv);
  if (o.help || (!o.file && !o.sample && !o.olas && !histories)) {
    console.error(USAGE);
    return o.help ? 0 : 2;
  }
  let list;
  if (histories) list = histories;
  else if (o.sample) list = sampleFleet();
  else if (o.olas) {
    log(`Reading the newest ${o.olas} deployed Olas services on ${CHAINS[o.chain]?.name || o.chain}…`);
    list = await olasWallets(o.olas, { chain: o.chain, api: o.api, rpc: o.rpc, fetch: fetchImpl });
    if (o.out) fs.mkdirSync(o.out, { recursive: true }), fs.writeFileSync(path.join(o.out, "wallets.txt"), `${list.join("\n")}\n`);
  } else list = readWallets(o.file);
  if (!list.length) throw new Error(`no addresses found in ${o.file || "the registry"}`);

  const latest = (h) => Math.max(...h.transactions.map((t) => Date.parse(t.timestamp) / 1000));
  const entries = [];
  for (const [i, item] of list.entries()) {
    let history = item;
    if (typeof item === "string") {
      log(`(${i + 1}/${list.length}) reading ${item}…`);
      try {
        history = await fetchHistory(item, { chain: o.chain, api: o.api, fetch: fetchImpl });
      } catch (err) {
        entries.push({ error: { address: item, status: "error", note: err.message, checked: 0, held: [], learnedFrom: 0 } });
        continue;
      }
    }
    // A sample's clock is its own last day; a live wallet's is now.
    entries.push({ history, since: parseSince(o.since, history.synthetic ? latest(history) : Date.now() / 1000) });
  }
  const { results, cohort } = shadowFleet(entries);

  const unit = { s: "seconds", m: "minutes", h: "hours", d: "days" };
  const m = /^(\d+)([smhd])$/.exec(o.since);
  const sinceLabel = m ? `in the last ${m[1]} ${Number(m[1]) === 1 ? unit[m[2]].slice(0, -1) : unit[m[2]]}` : `since ${o.since}`;
  const explorer = CHAINS[o.chain]?.explorer || null;
  const text = slackText(results, { sinceLabel, explorer });
  log("");
  log(text.replace(/\*/g, "").replace(/<[^|>]+\|tx>/g, ""));
  log("");
  log(numbersLine(results, sinceLabel));
  if (o.out) {
    fs.mkdirSync(o.out, { recursive: true });
    fs.writeFileSync(path.join(o.out, "fleet.json"), `${JSON.stringify({ since: o.since, numbers: fleetNumbers(results), results }, null, 2)}\n`);
    fs.writeFileSync(path.join(o.out, "fleet.md"), markdownReport(results, { sinceLabel }));
    if (cohort) fs.writeFileSync(path.join(o.out, "cohort.json"), `${JSON.stringify(cohort, null, 2)}\n`);
    log(`\nWrote ${path.join(o.out, "fleet.md")}, fleet.json${cohort ? " and cohort.json (rein guard <new wallet> --cohort cohort.json starts a new wallet from it)" : ""}`);
  }
  const anyHeld = results.some((r) => r.held.length);
  if (o.webhook && (anyHeld || o.always)) {
    const res = await fetchImpl(o.webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, content: text }) });
    if (!res.ok) throw new Error(`the webhook answered ${res.status}`);
    log("Posted to the webhook.");
  }
  return 0;
}

// -- public agent wallets -------------------------------------------------------------

// Olas registers every agent service on chain; each one's Safe is the wallet
// the agent pays from. ServiceRegistryL2 on Base.
const OLAS = { base: "0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE" };
const OLAS_ABI = new (require("ethers").Interface)([
  "function totalSupply() view returns (uint256)",
  "function getService(uint256 serviceId) view returns ((uint96 securityDeposit, address multisig, bytes32 configHash, uint32 threshold, uint32 maxNumAgentInstances, uint32 numAgentInstances, uint8 state, uint32[] agentIds))",
]);
const DEPLOYED = 4;

/// The multisigs of the newest `n` deployed Olas services, newest first,
/// read through the explorer's JSON-RPC endpoint.
async function olasWallets(n, { chain = "base", api = null, rpc = null, fetch: fetchImpl = globalThis.fetch } = {}) {
  const registry = OLAS[chain];
  if (!registry) throw new Error(`Olas's registry is read on ${Object.keys(OLAS).join(", ")} only`);
  // The explorer's RPC first, then a public one: the explorer rate-limits
  // some addresses from the first request.
  const rpcs = [rpc || `${(api || CHAINS[chain].api).replace(/\/$/, "")}/api/eth-rpc`, ...(rpc ? [] : PUBLIC_RPC[chain] || [])];
  let at = 0;
  let id = 0;
  const failures = [];
  const call = async (fn, args = []) => {
    for (;;) {
      const url = rpcs[at];
      try {
        const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "eth_call", params: [{ to: registry, data: OLAS_ABI.encodeFunctionData(fn, args) }, "latest"] }) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.error || body.result == null) throw new Error(`answered ${res.status}${body.error ? `: ${body.error.message}` : ""}`);
        return OLAS_ABI.decodeFunctionResult(fn, body.result);
      } catch (err) {
        failures.push(`${url} ${err.message}`);
        if (++at >= rpcs.length) throw new Error(`couldn't read Olas's registry: ${failures.join("; ")}. Pass --rpc <a Base RPC URL> to use your own.`);
      }
    }
  };
  const total = Number((await call("totalSupply"))[0]);
  const out = [];
  for (let s = total; s >= 1 && out.length < n && total - s < n * 5; s--) {
    const [svc] = await call("getService", [s]);
    if (Number(svc.state) === DEPLOYED && svc.multisig !== "0x0000000000000000000000000000000000000000" && !out.includes(svc.multisig)) out.push(svc.multisig);
  }
  return out;
}

/// The sample wallet; a copy of it whose last week includes a drain (a run of
/// payments to an address it had never paid); a twin that behaves; and a new
/// wallet a few days old, whose third payment goes somewhere the others never pay.
function sampleFleet() {
  const { sampleHistory, AGENT, USDC, PAYEES } = require("./sample");
  const { ethers } = require("ethers");
  const honest = sampleHistory();
  const copyAs = (hex) => {
    const h = JSON.parse(JSON.stringify(honest));
    h.address = ethers.getAddress(`0x${hex.repeat(40 / hex.length)}`);
    const swap = (x) => (x && x.hash && x.hash.toLowerCase() === AGENT.toLowerCase() ? { ...x, hash: h.address } : x);
    const me = (raw) => raw && raw.split(AGENT.slice(2).toLowerCase()).join(h.address.slice(2).toLowerCase());
    for (const t of h.transactions) (t.from = swap(t.from)), (t.raw_input = me(t.raw_input));
    for (const t of h.tokenTransfers) (t.from = swap(t.from)), (t.to = swap(t.to));
    return h;
  };
  const last = Math.max(...honest.transactions.map((t) => Date.parse(t.timestamp)));
  const pay = (h, i, hoursAgo, to, amount) =>
    h.transactions.push({ hash: ethers.id(`rein sample: ${h.address} ${i}`), timestamp: new Date(last - hoursAgo * 3600 * 1000).toISOString(), from: { hash: h.address }, to: { hash: USDC.address }, value: "0", status: "ok", raw_input: transferData(to, amount * 1e6), method: "transfer" });

  const drained = copyAs("5a3e");
  for (let i = 0; i < 3; i++) pay(drained, `d${i}`, 3 - i, "0x7777777777777777777777777777777777777777", 900);
  drained.transactions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const twin = copyAs("7e1f");

  const fresh = copyAs("ae70");
  fresh.transactions = [];
  fresh.tokenTransfers = [];
  const known = PAYEES.inference.address;
  pay(fresh, "a1", 50, known, 40);
  pay(fresh, "a2", 26, known, 35);
  pay(fresh, "a3", 2, "0x8888888888888888888888888888888888888888", 500);
  pay(fresh, "a4", 0, known, 30);
  fresh.transactions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return [honest, drained, twin, fresh];
}

function transferData(to, raw) {
  const { ethers } = require("ethers");
  return new ethers.Interface(["function transfer(address,uint256)"]).encodeFunctionData("transfer", [to, BigInt(raw)]);
}

module.exports = { olasWallets, measure, fleetNumbers, shadow, shadowFleet, slackText, markdownReport, main, parse, sampleFleet, USAGE };
