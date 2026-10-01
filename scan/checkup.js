// The one-minute answer for an agent wallet, for the web page and
// `rein checkup`: is something attacking it, what does it normally do, and
// what would Rein have held in its last 30 days. Then ask() answers "would
// Rein let this payment through?" from the same learned habits, instantly.
//
// Pure: it takes a history fetchHistory() returned and touches no files and
// no network, so the browser runs exactly what the command line runs.
const { ethers } = require("ethers");
const { toTrail, holdings } = require("./blockscout");
const { NATIVE } = require("./evaluate");
const { namer, money } = require("./index");
const { learn, check, decide, looksLike, WORDS, COHORT_UNTIL } = require("./guard");
const { shadow } = require("./fleet");

const DAY = 86400;
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs, max = 4) => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`);

function checkup(history, { days = 30 } = {}) {
  const { rows, tokens, ignored = [] } = toTrail(history, { payments: true });
  const name = namer(history, tokens);
  const own = rows.filter((r) => !r.derived);
  const held = holdings(history);
  const usd = held.reduce((a, h) => a + (h.usd || 0), 0);
  const base = {
    address: history.address,
    chain: history.chain,
    synthetic: Boolean(history.synthetic),
    calls: own.length,
    days: new Set(rows.map((r) => new Date(r.ts * 1000).toISOString().slice(0, 10))).size,
    holdsUsd: Math.round(usd),
  };

  // Habits, learned from all of it. Too little history: say so, plainly.
  let guard = null;
  let tooNew = null;
  try {
    guard = learn(history).guard;
  } catch (err) {
    tooNew = own.length < COHORT_UNTIL
      ? `It has made ${plural(own.length, "transaction")} of its own. Rein needs ${COHORT_UNTIL} to learn its habits; until then a platform's other wallets lend it theirs.`
      : err.message;
  }

  // Someone trying to trick it: transfers it never sent, in fake tokens, to
  // addresses dressed up as ones it really pays.
  const realPayees = [...new Set(own.filter((r) => r.payee && r.kind !== "approve").map((r) => r.payee))];
  const pairs = new Map();
  for (const x of ignored) {
    const real = x.payee && realPayees.find((p) => looksLike(p, x.payee));
    if (real && !pairs.has(x.payee.toLowerCase())) pairs.set(x.payee.toLowerCase(), { fake: x.payee, real, realName: name(real) });
  }
  const attack = ignored.length
    ? {
        fakeTransfers: ignored.length,
        fakeTokens: [...new Set(ignored.map((x) => x.token).filter(Boolean))],
        lookalikes: [...pairs.values()],
      }
    : null;

  // What a second key would have held in its last `days` days of activity,
  // judged by limits learned only from what came before.
  const last = rows.length ? rows[rows.length - 1].ts : Math.floor(Date.now() / 1000);
  const since = last - days * DAY;
  const s = shadow(history, { since });
  const recent = s.held.map((h) => ({ when: h.when, what: h.what, why: h.why, reason: h.reason, tx: h.tx }));

  // The single payment a person would most want to have been asked about:
  // the largest first-ever payment to an address it had never paid. Rein
  // holds a first payment like that whatever the agent's limits are.
  const firsts = firstPayments(rows, tokens, history);
  const biggest = firsts[0] ? { ...firsts[0], payeeName: name(firsts[0].payee), symbol: name(firsts[0].token) } : null;

  const habits = guard ? habitsOf(guard, name, base) : [];
  const out = {
    ...base,
    biggest,
    firstPaymentsOver100: firsts.length,
    headlineParts: headline({ biggest, attack, guard, tooNew, held: recent, checked: s.checked, status: s.status, days }),
    attack,
    habits,
    tooNew,
    recent: { days, checked: s.checked, held: recent, status: s.status, note: s.note || null },
    guard,
    name,
  };
  out.headline = out.headlineParts.join(" ");
  return out;
}

const STABLES = /^(USDC|USDbC|USDT|DAI|USDS|EURC|PYUSD)$/i;

/// Every first-ever payment over $100 to an address the wallet had never
/// paid, largest first, in today's dollars.
function firstPayments(rows, tokens, history) {
  const rate = (t) => (t === NATIVE ? (history.info?.exchange_rate != null ? Number(history.info.exchange_rate) : null) : tokens[t]?.rate ?? (STABLES.test(tokens[t]?.symbol || "") ? 1 : null));
  const paid = new Set();
  const out = [];
  for (const r of rows) {
    if (r.derived || !r.payee || !(r.kind === "transfer" || r.kind === "transferFrom")) continue;
    const key = r.payee.toLowerCase();
    if (!paid.has(key)) {
      const usd = rate(r.token) != null ? Number(r.amount) * rate(r.token) : null;
      if (usd != null && usd >= 100) out.push({ when: new Date(r.ts * 1000).toISOString(), tx: r.tx || null, payee: r.payee, token: r.token, amount: Number(r.amount), usd: Math.round(usd) });
    }
    paid.add(key);
  }
  return out.sort((a, b) => b.usd - a.usd);
}

const dollars = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 2)}M` : n >= 1e4 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n).toLocaleString("en-US")}`);
const day = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/// What the agent normally does, in sentences a person reads in one pass.
function habitsOf(guard, name, base) {
  const p = guard.policy;
  const sym = (t) => guard.tokens[t]?.symbol || name(t);
  const out = [`Learned from its ${plural(base.calls, "transaction")} over ${plural(base.days, "day")}.`];
  if (p.transferPayees.length) out.push(`Pays ${plural(p.transferPayees.length, "address", "addresses")}: ${list(p.transferPayees.map(name))}.`);
  else out.push("Has never paid anyone directly.");
  for (const [t, tp] of Object.entries(p.tokens)) {
    out.push(`Sends at most ${money(tp.maxPerWindow)} ${sym(t)} in an hour${tp.maxPerDay != null ? ` and ${money(tp.maxPerDay)} in a day` : ""}.`);
    if (tp.maxApproval) out.push(`Lets a contract spend at most ${money(tp.maxApproval)} ${sym(t)} at a time.`);
  }
  out.push(p.agent.maxNativePerWindow ? `Sends at most ${money(p.agent.maxNativePerWindow)} ETH an hour.` : "Sends no ETH.");
  out.push(`Makes at most ${plural(p.agent.maxCallsPerWindow, "transaction")} an hour.`);
  return out;
}

function headline({ biggest, attack, guard, tooNew, held, checked, status, days }) {
  const parts = [];
  if (biggest && biggest.usd >= 1000) {
    const to = biggest.payeeName.startsWith("0x") ? short(biggest.payee) : biggest.payeeName;
    parts.push(`Rein would have held this payment: on ${day(biggest.when)} this wallet sent ${money(biggest.amount)} ${biggest.symbol} (${dollars(biggest.usd)}) to ${to}, an address it had never paid before.`);
  }
  if (attack) {
    parts.push(attack.lookalikes.length
      ? `Someone is trying to trick this wallet: ${plural(attack.fakeTransfers, "fake transfer")} point it at addresses dressed up as ones it really pays.`
      : `Someone is spamming this wallet with ${plural(attack.fakeTransfers, "fake transfer")} in tokens it never used.`);
  }
  if (!guard) parts.push(tooNew || "Rein couldn't learn this wallet's habits.");
  else if (status === "quiet" || !checked) parts.push(`Rein learned its habits. It has done nothing in the ${days} days before its last transaction to check against them.`);
  else if (!held.length) parts.push(`Rein learned its habits, and all ${checked} of its recent transactions fit them, so Rein would have stayed out of the way.`);
  else parts.push(`Rein learned its habits and would have held ${held.length} of its last ${checked} transactions for a person to approve.`);
  return parts;
}

// -- asking about one payment ------------------------------------------------

/// Reads "send 500 USDC to 0x…", "pay Inference API 12.5", "0x… 40 usdc".
/// Payee by address or by a name the wallet's history gives it; token by
/// symbol, else the token this agent pays in most.
function parsePayment(c, text) {
  const g = c.guard;
  if (!g) throw new Error("Rein hasn't learned this wallet's habits, so there is nothing to check a payment against yet");
  let rest = String(text || "");
  let payee = (rest.match(/0x[0-9a-fA-F]{40}/) || [])[0];
  if (payee) rest = rest.replace(payee, " ");
  else {
    const named = g.policy.transferPayees.map((a) => ({ a, n: String(c.name(a)) })).filter((x) => !x.n.startsWith("0x"));
    const hit = named.sort((x, y) => y.n.length - x.n.length).find((x) => rest.toLowerCase().includes(x.n.toLowerCase()));
    if (!hit) throw new Error('say who gets it: a 0x address, or the name of one it pays (like "send 40 USDC to 0x…")');
    payee = hit.a;
    rest = rest.replace(new RegExp(hit.n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ");
  }
  payee = ethers.getAddress(payee.toLowerCase());
  const m = rest.replace(/,(?=\d{3})/g, "").match(/(?:^|[^\w.])\$?(\d+(?:\.\d+)?)\s*(k)?\b/i);
  if (!m) throw new Error('say how much, like "send 40 USDC to 0x…"');
  const amount = m[1] * (m[2] ? 1000 : 1);
  const symbols = Object.entries(g.tokens).map(([a, t]) => ({ a, s: String(t.symbol || "").toUpperCase() }));
  const word = (rest.match(/\b(eth|[a-z][a-z0-9]{1,9})\b/gi) || []).map((w) => w.toUpperCase());
  let token = symbols.find((t) => word.includes(t.s))?.a;
  if (!token && word.includes("ETH")) token = NATIVE;
  if (!token) token = Object.keys(g.policy.tokens)[0] || symbols[0]?.a || NATIVE;
  const decimals = token === NATIVE ? 18 : g.tokens[token]?.decimals ?? 18;
  const raw = ethers.parseUnits(String(Number(amount.toFixed(Math.min(decimals, 6)))), decimals);
  const tx = token === NATIVE ? { to: payee, value: raw.toString(), data: "0x" } : { payTo: payee, asset: token, amount: raw.toString() };
  return { tx, payee, token, amount, symbol: token === NATIVE ? "ETH" : g.tokens[token]?.symbol || short(token) };
}

/// Rein's answer to one payment, from the habits it learned. A held payment
/// can be approved once with approve(), as a person would from Slack.
function ask(c, text, { now } = {}) {
  let p;
  try {
    p = parsePayment(c, text);
  } catch (err) {
    return { understood: false, answer: `Rein didn't catch that: ${err.message}.` };
  }
  const v = check(p.tx, { guard: c.guard, now, env: {} });
  const who = c.name(p.payee);
  const what = `${money(p.amount)} ${p.symbol} to ${who.startsWith("0x") ? short(p.payee) : who}`;
  let answer;
  if (v.reason === "APPROVED") answer = `Goes through, this once: a person approved ${what}. The next payment like it waits for a person again.`;
  else if (v.allow) answer = `Goes through. ${what} fits this agent's habits${v.leftThisHour != null ? `, with ${money(v.leftThisHour)} ${p.symbol} left in its hour` : ""}. Nobody is bothered.`;
  else if (v.refused) answer = `Refused: a person already said no to ${what}.`;
  else if (v.held) answer = `Held for a person: ${p.token === NATIVE && v.reason === "TARGET_NOT_ALLOWED" ? "this agent has never sent ETH to that address" : v.explanation}. The agent can't send ${what} on its own; the owner gets one message with Approve and Refuse.`;
  else answer = `Blocked: ${v.explanation}.`;
  return { understood: true, payment: { ...p, what }, verdict: v, answer, held: v.held || null };
}

/// A person's yes to one held payment, as the Slack button gives it.
function approve(c, id, now) {
  return decide(c.guard, id, "approved", now);
}

/// A person's no: the agent can't retry it while the hold lasts.
function refuse(c, id, now) {
  return decide(c.guard, id, "denied", now);
}

/// One-click questions that show each kind of answer on this wallet.
function examples(c) {
  const g = c.guard;
  if (!g) return [];
  const [t] = Object.keys(g.policy.tokens);
  const payees = g.policy.transferPayees;
  if (!t || !payees.length) return [];
  const sym = g.tokens[t]?.symbol || "USDC";
  const tp = g.policy.tokens[t];
  const top = payees.find((a) => !String(c.name(a)).startsWith("0x")) || payees[0];
  const label = (a) => (String(c.name(a)).startsWith("0x") ? a : c.name(a));
  const usual = Math.max(1, Math.round(tp.maxPerWindow / 20));
  const fake = c.attack?.lookalikes[0]?.fake || ethers.getAddress(`0x${top.slice(2, 6)}${"7".repeat(32)}${top.slice(-4)}`.toLowerCase());
  const big = Math.round(tp.maxPerDay != null ? tp.maxPerDay * 2 : tp.maxPerWindow * 3);
  const stranger = ethers.getAddress(ethers.dataSlice(ethers.id(`a stranger for ${c.address}`), 12));
  return [
    { label: "A normal payment", text: `Send ${usual} ${sym} to ${label(top)}` },
    { label: "Same payee, far more", text: `Send ${big} ${sym} to ${label(top)}` },
    { label: "A lookalike address", text: `Send ${usual} ${sym} to ${fake}` },
    { label: "Someone new", text: `Send 500 ${sym} to ${stranger}` },
  ];
}

/// The checkup without the learned guard and naming function, for JSON.
function summary(c) {
  const { guard, name, ...rest } = c;
  return rest;
}

/// A fake token's name, flagged when it hides lookalike letters.
const fakeName = (t) => (/^[\x20-\x7E]*$/.test(t) ? `"${t}"` : `"${t}" (spelled with a lookalike letter)`);

/// The checkup as plain text, for a terminal.
function text(c) {
  const L = [c.headline, ""];
  if (c.synthetic) L.push("(Rein's made-up sample wallet, not a real one.)", "");
  if (c.attack) {
    L.push(`Being tricked: ${plural(c.attack.fakeTransfers, "fake transfer")} in ${list(c.attack.fakeTokens.map(fakeName))}, which Rein ignores.`);
    for (const x of c.attack.lookalikes.slice(0, 5)) L.push(`  ${x.fake} pretends to be ${x.realName.startsWith("0x") ? x.real : `${x.realName} (${x.real})`}`);
    L.push("");
  }
  if (c.biggest) L.push(`Its biggest first payment to a new address: ${money(c.biggest.amount)} ${c.biggest.symbol} (${dollars(c.biggest.usd)}) to ${c.biggest.payee} on ${day(c.biggest.when)}${c.biggest.tx ? `, tx ${c.biggest.tx}` : ""}. Rein holds a first payment like that for a person.`, "");
  if (c.habits.length) L.push("What it normally does:", ...c.habits.map((h) => `  ${h}`), "");
  if (c.recent.held.length) {
    L.push(`What Rein would have held in its last ${c.recent.days} days:`);
    for (const h of c.recent.held.slice(0, 10)) L.push(`  ${h.when.slice(0, 16).replace("T", " ")}  ${h.what}: ${h.why}`);
    if (c.recent.held.length > 10) L.push(`  …and ${c.recent.held.length - 10} more`);
    L.push("");
  }
  return L.join("\n");
}

const USAGE = `rein checkup <address> [--chain base|base-sepolia|ethereum] [--ask "send 500 USDC to 0x…"] [--json]
  In seconds: is someone trying to trick this agent wallet, what does it
  normally do, and what would Rein have held in its last 30 days. Then ask
  about any payment, in plain words. Reads public history; signs nothing.
  rein checkup --sample shows it on a made-up wallet under attack.`;

function parse(argv) {
  const o = { address: null, chain: "base", api: null, sample: false, json: false, ask: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--chain") o.chain = argv[++i];
    else if (a === "--api") o.api = argv[++i];
    else if (a === "--sample") o.sample = true;
    else if (a === "--json") o.json = true;
    else if (a === "--ask") o.ask.push(argv[++i]);
    else if (a === "-h" || a === "--help") o.help = true;
    else if (!a.startsWith("-")) o.address = a;
    else throw new Error(`unknown flag ${a}`);
  }
  return o;
}

async function main(argv, { log = console.log, fetch: fetchImpl = globalThis.fetch, input = process.stdin } = {}) {
  const o = parse(argv);
  if (o.help || (!o.address && !o.sample)) {
    log(USAGE);
    return o.help ? 0 : 2;
  }
  let history;
  if (o.sample) history = require("./sample").poisonedSampleHistory();
  else {
    if (!/^0x[0-9a-fA-F]{40}$/.test(o.address)) throw new Error(`"${o.address}" isn't a wallet address: it should be 0x and 40 hex characters`);
    const { fetchHistory } = require("./blockscout");
    history = await fetchHistory(o.address, { chain: o.chain, api: o.api, fetch: fetchImpl });
  }
  const c = checkup(history);
  if (o.json) {
    log(JSON.stringify({ ...summary(c), answers: o.ask.map((q) => { const a = ask(c, q); return { question: q, answer: a.answer, allow: a.verdict?.allow ?? null, reason: a.verdict?.reason ?? null }; }) }, null, 2));
    return 0;
  }
  log(text(c));
  const questions = o.ask.length ? o.ask : examples(c).map((e) => e.text);
  if (questions.length) {
    log(o.ask.length ? "Your payments:" : "Asked about a few payments, Rein says:");
    for (const q of questions) log(`  > ${q}\n    ${ask(c, q).answer}`);
    log("");
  }
  const who = c.address;
  if (c.guard) {
    log("Switch it on:");
    log(`  One agent:          const wallet = require("rein-wallet").protect(walletClient)   (viem, AgentKit, GOAT, ElizaOS)`);
    log(`                      or npx rein-wallet guard ${who}${o.chain !== "base" ? ` --chain ${o.chain}` : ""}, then check(tx) before signing`);
    log("  Many agent wallets: npx rein-wallet fleet wallets.txt   (what a second key would have held, read-only)");
    log("");
  }
  // At a terminal, keep answering, like a chat.
  if (c.guard && !o.ask.length && input && input.isTTY) {
    const rl = require("readline").createInterface({ input, output: process.stdout });
    const next = () => new Promise((r) => rl.question('Ask about a payment (like "send 500 USDC to 0x…"), or press Enter to stop: ', r));
    for (let q = await next(); q && q.trim(); q = await next()) log(`  ${ask(c, q).answer}\n`);
    rl.close();
  }
  return 0;
}

module.exports = { checkup, ask, approve, refuse, examples, parsePayment, summary, text, main, parse, USAGE };
