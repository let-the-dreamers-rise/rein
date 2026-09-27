// rein watch: the policy a wallet's history supports, held against every new
// transaction it sends, with an alert the moment one falls outside it.
//
// The scan answers "what should this wallet be allowed to do". This answers
// "did it just do something else", for a wallet that runs on any engine:
// nothing here needs the wallet to move to Rein, and nothing signs or spends.
//
//   const { watch } = require("./scan/watch");
//   await watch("0xAgent", { chain: "base", webhook: "https://hooks.slack.com/..." });
//
// Each poll reads the newest page of the wallet's history, turns it into
// trail rows exactly as the scan does, and replays every row seen so far
// through the policy with the contract's own window arithmetic, so a burst
// that crosses the hourly ceiling is caught on the call that crosses it.
// Only rows that arrived after the watch started are reported.
const { fetchHistory, toTrail, CHAINS } = require("./blockscout");
const { evaluate } = require("./evaluate");
const { scanHistory, describe, namer } = require("./index");
const codes = require("../scripts/codes");

const KEEP = 2000; // rows of history kept for window state; far more than any hour holds

const key = (r) => `${r.tx}:${r.derived ? "d" : "c"}:${r.token}:${r.payee}:${r.amount}`;
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// Reads a policy from what `rein scan --out` or `--json` wrote, or from a
/// bare on-chain policy object.
function policyFrom(json) {
  const p = json?.policy?.onchain || json?.onchain || json;
  if (!p || !p.agent || !p.tokens || !Array.isArray(p.payees)) throw new Error("that file holds no compiled policy (expected report.json from rein scan)");
  return p;
}

function alertText(result, { address, chainName, explorer, name }) {
  const r = result.row;
  const why = codes.explain(codes.NAMES.indexOf(result.reason)) || result.reason;
  return (
    `Rein: ${short(address)} on ${chainName} did something outside its policy: ${describe(r, name)}. ` +
    `${result.reason}: ${why}.${explorer && r.tx ? ` ${explorer}/tx/${r.tx}` : ""}`
  );
}

async function post(webhook, text, fetchImpl) {
  // Slack reads `text`, Discord reads `content`; each ignores the other.
  const res = await fetchImpl(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, content: text }) });
  if (!res.ok) throw new Error(`webhook answered ${res.status}`);
}

/// Watches until `polls` polls have run (forever by default). Resolves with
/// every alert raised. `policy` is optional: without one, the wallet's full
/// history is scanned first and the compiled policy is the one watched.
async function watch(address, opts = {}) {
  const {
    chain = "base",
    api,
    policy: given,
    interval = 60_000,
    polls = Infinity,
    webhook,
    fetch: fetchImpl = globalThis.fetch,
    log = console.error,
    onAlert,
    sleep: wait = sleep,
  } = opts;
  const c = CHAINS[chain];
  const chainName = c ? c.name : api || chain;
  const explorer = c ? c.explorer : api ? api.replace(/\/$/, "") : null;

  const first = await fetchHistory(address, { chain, api, fetch: fetchImpl, maxPages: given ? 2 : opts.maxPages ?? 20, pause: opts.pause ?? 200 });
  let policy = given;
  if (!policy) {
    const report = scanHistory(first);
    if (!report.policy) throw new Error(`${address} has ${report.verdict}; nothing to watch against yet`);
    policy = report.policy.onchain;
    log(`compiled a policy from ${report.history.calls} calls over ${report.history.days} day(s): ${report.policy.sentences.join("; ")}.`);
  }

  let rows = toTrail(first).rows;
  const seen = new Set(rows.map(key));
  // A token transfer is only a side effect if no call of the wallet's own
  // explains it. The transactions page and the transfers page of one poll
  // can reach back to different times, so remember every call's hash.
  const calls = new Set(rows.filter((r) => !r.derived).map((r) => r.tx));
  let tokens = toTrail(first).tokens;
  let history = first;
  const alerts = [];
  log(`watching ${first.address} on ${chainName}${webhook ? ", alerts to the webhook" : ""}. ${rows.length} past row(s) loaded for window state.`);

  for (let n = 0; n < polls; n++) {
    await wait(interval);
    let latest;
    try {
      latest = await fetchHistory(address, { chain, api, fetch: fetchImpl, maxPages: 1, pause: 0 });
    } catch (err) {
      log(`poll failed (${err.message}); trying again next time`);
      continue;
    }
    const trail = toTrail(latest);
    tokens = { ...tokens, ...trail.tokens };
    history = { ...latest, transactions: [...latest.transactions, ...history.transactions].slice(0, KEEP), tokenTransfers: [...latest.tokenTransfers, ...history.tokenTransfers].slice(0, KEEP) };
    for (const r of trail.rows) if (!r.derived) calls.add(r.tx);
    const fresh = trail.rows.filter((r) => !seen.has(key(r)) && !(r.derived && calls.has(r.tx)));
    if (!fresh.length) continue;
    for (const r of fresh) seen.add(key(r));
    const freshKeys = new Set(fresh.map(key));
    rows = [...rows, ...fresh].sort((a, b) => a.ts - b.ts).slice(-KEEP);

    const name = namer(history, tokens);
    for (const result of evaluate(policy, rows).results) {
      if (!freshKeys.has(key(result.row))) continue;
      if (result.reason === "OK") {
        log(`ok  ${describe(result.row, name)}`);
        continue;
      }
      const text = alertText(result, { address: first.address, chainName, explorer, name });
      alerts.push({ reason: result.reason, tx: result.row.tx, text });
      log(`ALERT  ${text}`);
      if (onAlert) onAlert(text, result);
      if (webhook) await post(webhook, text, fetchImpl).catch((err) => log(`could not post the alert: ${err.message}`));
    }
  }
  return { policy, alerts };
}

module.exports = { watch, policyFrom, alertText };
