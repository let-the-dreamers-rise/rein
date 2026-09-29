// rein guard: limits learned from a wallet's own history, checked before
// every payment the agent signs.
//
//   npx rein-wallet guard 0xAgentWallet          learn the limits, replay the
//                                                last 30 days, save, done
//
//   const rein = require("rein-wallet");
//   const verdict = rein.check(tx);              { allow, reason, explanation }
//   if (!verdict.allow) throw new Error(verdict.explanation);
//
// The limits are the scan's (scan/index.js): payees the agent pays often,
// the contracts and functions it calls, an hourly ceiling per token from its
// own busiest hours, and a call rate. They are saved as a small JSON file,
// and `check` holds each payment to them off chain, with the contract's own
// window arithmetic (scan/evaluate.js), before the agent's wallet signs. A
// payment `check` allows counts toward the hour, whether or not it is sent.
//
// Running `guard` again keeps the limits current. A limit may only tighten
// on its own; anything that would widen it (a new payee, a higher ceiling)
// is held as a proposal until the owner runs `guard --approve`. Otherwise an
// attacker could grow the limit with patient small payments.
//
// Nothing here signs, spends or holds a key. For limits no code path can
// skip, the same policy runs in a ReinAccountV3 contract.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const { fetchHistory, toTrail, CHAINS, NO_CALLDATA, SELECTOR_NAMES, ERC20 } = require("./blockscout");
const { evaluate, NATIVE } = require("./evaluate");
const { scanHistory, describe, namer, money } = require("./index");
const codes = require("../scripts/codes");

const DAY = 86400;
const KEEP_SECONDS = 2 * DAY; // ledger kept for window state; longer than any window the compiler writes
const VERSION = 1;

// -- where guards live ----------------------------------------------------------

const home = (env = process.env) => env.REIN_HOME || path.join(os.homedir(), ".rein");
const guardPath = (wallet, env) => path.join(home(env), "guards", `${wallet.toLowerCase()}.json`);

function saveGuard(g, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(g, null, 2)}\n`);
  return file;
}

/// A guard by wallet address, file path, or object. With nothing given,
/// REIN_GUARD_FILE, or else the one guard saved on this machine.
function loadGuard(which, env = process.env) {
  if (which && typeof which === "object") return { guard: which, file: null };
  let file;
  if (!which && env.REIN_GUARD_FILE) file = env.REIN_GUARD_FILE;
  else if (!which) {
    const dir = path.join(home(env), "guards");
    const all = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
    if (all.length !== 1) {
      throw new Error(all.length ? `${all.length} guarded wallets on this machine; say which (check(tx, { wallet }))` : "no guarded wallet on this machine yet: run npx rein-wallet guard 0xYourAgentWallet");
    }
    file = path.join(dir, all[0]);
  } else if (/^0x[0-9a-fA-F]{40}$/.test(which)) {
    file = guardPath(which, env);
    if (!fs.existsSync(file)) throw new Error(`${which} is not guarded yet: run npx rein-wallet guard ${which}`);
  } else file = which;
  const guard = JSON.parse(fs.readFileSync(file, "utf8"));
  if (guard.version !== VERSION || !guard.policy) throw new Error(`${file} is not a Rein guard file`);
  return { guard, file };
}

// -- learning -------------------------------------------------------------------

/// Learns the limits from a history (as fetchHistory returns it). Returns the
/// guard to save, and the replay: a policy learned only from before the last
/// `days` days, held against what the wallet did in those days.
function learn(history, { days = 30 } = {}) {
  const trail = { payments: true };
  const { rows, tokens } = toTrail(history, trail);
  if (rows.filter((r) => !r.derived).length < 2) {
    throw new Error(`${history.address} has ${rows.length} outgoing payment(s) on record; the guard needs its habits, and there are none to read yet`);
  }
  const last = rows[rows.length - 1].ts;
  const since = last - days * DAY;
  const before = rows.filter((r) => r.ts < since).length;
  // A replay needs something to learn from and something to hold it against.
  // A wallet younger than that is split 80/20 instead, and says so.
  const byTime = before >= 10 && before < rows.length;
  const replay = scanHistory(history, { trail, train: byTime ? before / rows.length : 0.8, expiryDays: 0 });
  const current = scanHistory(history, { trail, train: 1, expiryDays: 0 });
  if (!current.policy) throw new Error(`${history.address}: ${current.verdict}`);

  const name = namer(history, tokens);
  const recent = rows.filter((r) => r.ts >= (byTime ? since : rows[Math.round(rows.length * 0.8)]?.ts ?? last));
  const paid = recent.filter((r) => r.kind === "transfer" || r.kind === "transferFrom");
  const totals = {};
  for (const r of paid) totals[r.token] = (totals[r.token] || 0) + Number(r.amount || 0);

  const now = Math.floor(Date.now() / 1000);
  const guard = {
    version: VERSION,
    wallet: history.address,
    chain: history.chain,
    chainId: CHAINS[history.chain]?.chainId ?? null,
    learnedAt: new Date().toISOString(),
    learnedFrom: { calls: current.history.calls, from: current.history.from, to: current.history.to },
    policy: current.policy.onchain,
    sentences: current.policy.sentences,
    withheld: current.policy.withheld,
    tokens: Object.fromEntries(Object.entries(tokens).map(([a, t]) => [a, { symbol: t.symbol || null, decimals: t.decimals ?? 18 }])),
    ledger: rows.filter((r) => r.ts > now - KEEP_SECONDS).map(ledgerRow),
    pending: [],
    webhook: null,
  };
  return {
    guard,
    replay: {
      byTime,
      days,
      since: new Date((byTime ? since : recent[0]?.ts ?? last) * 1000).toISOString(),
      learnedFrom: replay.policy ? replay.policy.compiledFrom : 0,
      sentences: replay.policy ? replay.policy.sentences : [],
      allowed: replay.coverage ? replay.coverage.allowed : 0,
      total: replay.coverage ? replay.coverage.total : 0,
      blocked: replay.coverage ? replay.coverage.refusedExamples : [],
      reasons: replay.coverage ? replay.coverage.reasons : {},
      payments: paid.length,
      payees: new Set(paid.map((r) => r.payee)).size,
      totals: Object.entries(totals).map(([t, v]) => `${money(v)} ${t === NATIVE ? "ETH" : name(t)}`),
    },
  };
}

const ledgerRow = (r) => ({ ts: r.ts, target: r.target, selector: r.selector, kind: r.kind, token: r.token, payee: r.payee, amount: r.amount, value: r.value || 0, ...(r.derived ? { derived: true } : {}) });

// -- keeping it current -----------------------------------------------------------

/// Merges freshly learned limits into the ones in force. Anything tighter is
/// applied now; anything wider becomes a proposal the owner has to approve.
function evolve(old, fresh) {
  const p = JSON.parse(JSON.stringify(old.policy));
  const n = fresh.policy;
  const applied = [];
  const proposed = [];
  const list = (key, label) => {
    const before = new Set(p[key]);
    const after = new Set(n[key]);
    const gone = [...before].filter((x) => !after.has(x));
    const added = [...after].filter((x) => !before.has(x));
    if (gone.length) {
      p[key] = p[key].filter((x) => after.has(x));
      applied.push(`removed ${gone.length} ${label}${gone.length === 1 ? "" : "s"} the agent no longer uses: ${gone.join(", ")}`);
    }
    for (const x of added) proposed.push({ what: `add ${label} ${x}`, path: [key], add: x });
  };
  list("payees", "payee");
  list("targets", "contract");
  for (const [t, sels] of Object.entries(n.selectors)) {
    const had = new Set(p.selectors[t] || []);
    for (const s of sels) if (!had.has(s) && p.targets.includes(t)) proposed.push({ what: `allow ${s} on ${t}`, path: ["selectors", t], add: s });
  }
  for (const t of Object.keys(p.selectors)) if (!p.targets.includes(t)) delete p.selectors[t];
  const number = (obj, nobj, key, label, at) => {
    if (nobj[key] == null || obj[key] == null || nobj[key] === obj[key]) return;
    if (nobj[key] < obj[key]) {
      applied.push(`${label}: ${money(obj[key])} → ${money(nobj[key])}`);
      obj[key] = nobj[key];
    } else proposed.push({ what: `${label}: ${money(obj[key])} → ${money(nobj[key])}`, path: at, key, value: nobj[key] });
  };
  number(p.agent, n.agent, "maxCallsPerWindow", "calls an hour", ["agent"]);
  number(p.agent, n.agent, "maxNativePerCall", "ETH per call", ["agent"]);
  number(p.agent, n.agent, "maxNativePerWindow", "ETH an hour", ["agent"]);
  for (const [t, tp] of Object.entries(n.tokens)) {
    const sym = fresh.tokens[t]?.symbol || t;
    if (!p.tokens[t]) {
      proposed.push({ what: `allow ${sym}: at most ${money(tp.maxPerWindow)} an hour`, path: ["tokens"], key: t, value: tp });
      continue;
    }
    number(p.tokens[t], tp, "maxPerWindow", `${sym} an hour`, ["tokens", t]);
    number(p.tokens[t], tp, "maxApproval", `${sym} approvals`, ["tokens", t]);
  }
  for (const t of Object.keys(p.tokens)) {
    if (!n.tokens[t]) {
      applied.push(`removed ${old.tokens[t]?.symbol || t}, which the agent no longer pays in`);
      delete p.tokens[t];
    }
  }
  return { policy: p, applied, proposed };
}

function approve(g) {
  const p = g.policy;
  for (const x of g.pending) {
    let obj = p;
    for (const k of x.path) obj = obj[k] ||= Array.isArray(obj) ? [] : k === "selectors" ? {} : [];
    if (x.add != null) {
      if (!obj.includes(x.add)) obj.push(x.add);
    } else obj[x.key] = x.value;
  }
  const n = g.pending.length;
  g.pending = [];
  return n;
}

// -- checking a payment -------------------------------------------------------------

function units(raw, decimals) {
  return Number(ethers.formatUnits(BigInt(raw), decimals));
}

/// A payment as a trail row. Takes an EVM transaction ({ to, data, value })
/// or an x402 payment requirement ({ payTo, asset, amount | maxAmountRequired },
/// in the token's smallest units).
function toRow(tx, guard, now) {
  const decimalsOf = (token) => guard.tokens[token]?.decimals ?? 18;
  if (tx.payTo) {
    const token = ethers.getAddress(tx.asset);
    const raw = tx.amount ?? tx.maxAmountRequired;
    if (raw == null) throw new Error("an x402 payment needs amount (or maxAmountRequired) in the token's smallest units");
    return { ts: now, target: token, selector: "transfer", kind: "transfer", token, payee: ethers.getAddress(tx.payTo), amount: units(raw, decimalsOf(token)), value: 0 };
  }
  if (!tx.to) throw new Error("check needs a transaction ({ to, data, value }) or an x402 payment ({ payTo, asset, amount })");
  const to = ethers.getAddress(tx.to);
  const value = units(tx.value ?? 0, 18);
  const data = tx.data || tx.input || "0x";
  const base = { ts: now, target: to, value };
  if (data === "0x" || data.length < 10) {
    return value > 0 ? { ...base, selector: NO_CALLDATA, kind: "transfer", token: NATIVE, payee: to, amount: value } : { ...base, selector: NO_CALLDATA, kind: "call", token: null, payee: null, amount: 0 };
  }
  const sel = data.slice(0, 10).toLowerCase();
  const known = SELECTOR_NAMES[sel];
  if (known) {
    try {
      const a = ERC20.decodeFunctionData(known, data);
      if (known === "transferFrom") return { ...base, selector: known, kind: known, token: to, payee: ethers.getAddress(a[1]), amount: units(a[2], decimalsOf(to)) };
      return { ...base, selector: known, kind: known, token: to, payee: ethers.getAddress(a[0]), amount: units(a[1], decimalsOf(to)) };
    } catch {
      // a colliding selector: an ordinary call
    }
  }
  return { ...base, selector: sel, kind: "call", token: null, payee: null, amount: 0 };
}

const WORDS = {
  PAYEE_NOT_ALLOWED: "this agent has never paid that address often enough for it to be trusted",
  TOKEN_PER_WINDOW: "that would take this agent past its hourly limit for this token",
  TARGET_NOT_ALLOWED: "this agent does not normally call that contract",
  SELECTOR_NOT_ALLOWED: "this agent does not normally call that function",
  TOKEN_NOT_ALLOWED: "this agent does not normally pay in that token",
  CALL_RATE: "this agent has already made as many payments this hour as it normally does",
  NATIVE_PER_CALL: "more ETH in one payment than this agent normally sends",
  NATIVE_PER_WINDOW: "that would take this agent past its hourly ETH limit",
  APPROVAL_TOO_LARGE: "a larger allowance than this agent normally grants",
};

/// Holds one payment to the saved limits. Synchronous and local: no network.
/// An allowed payment is recorded, so the next check sees the hour it used.
function check(tx, opts = {}) {
  const { guard, file } = loadGuard(opts.wallet || opts.guard || tx.from || null, opts.env);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const row = toRow(tx, guard, now);
  const ledger = guard.ledger.filter((r) => r.ts > now - KEEP_SECONDS);
  const result = evaluate(guard.policy, [...ledger, row]).results.find((x) => x.row === row);
  const reason = result.reason;
  const allow = reason === "OK";
  const sym = row.token === NATIVE ? "ETH" : guard.tokens[row.token]?.symbol || row.token;
  const verdict = {
    allow,
    reason,
    explanation: allow ? "inside this agent's usual payees and hourly limit" : WORDS[reason] || codes.explain(codes.NAMES.indexOf(reason)) || reason,
    wallet: guard.wallet,
    ...(row.payee ? { payee: row.payee } : {}),
    ...(row.token ? { amount: row.amount, token: sym } : {}),
  };
  const tp = row.token && guard.policy.tokens[row.token];
  if (tp) {
    const spent = [...ledger, ...(allow ? [row] : [])].filter((r) => r.token === row.token && r.ts > now - tp.windowSeconds && r.kind !== "approve").reduce((a, r) => a + Number(r.amount || 0), 0);
    verdict.leftThisHour = Math.max(0, Number((tp.maxPerWindow - spent).toFixed(6)));
  }
  if (opts.record !== false && file) {
    if (allow) guard.ledger = [...ledger, ledgerRow(row)];
    else guard.blocked = [...(guard.blocked || []), { at: new Date(now * 1000).toISOString(), ...verdict }].slice(-100);
    saveGuard(guard, file);
  }
  if (!allow && guard.webhook && opts.alert !== false) alert(guard, verdict, opts.fetch);
  return verdict;
}

function alert(guard, v, fetchImpl = globalThis.fetch) {
  const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const text = `Rein blocked a payment from ${short(guard.wallet)}: ${v.amount != null ? `${money(v.amount)} ${v.token}` : "a call"}${v.payee ? ` to ${v.payee}` : ""}. ${v.reason}: ${v.explanation}.`;
  // Fire and forget: a slow webhook must never hold up the agent's answer.
  Promise.resolve()
    .then(() => fetchImpl(guard.webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, content: text }) }))
    .catch(() => {});
  return text;
}

/// What is left this hour, per token, under the saved limits.
function budget(which, { env, now = Math.floor(Date.now() / 1000) } = {}) {
  const { guard } = loadGuard(which, env);
  const ledger = guard.ledger.filter((r) => r.ts > now - KEEP_SECONDS);
  const tokens = {};
  for (const [t, tp] of Object.entries(guard.policy.tokens)) {
    const spent = ledger.filter((r) => r.token === t && r.ts > now - tp.windowSeconds && r.kind !== "approve").reduce((a, r) => a + Number(r.amount || 0), 0);
    tokens[guard.tokens[t]?.symbol || t] = { token: t, limitPerHour: tp.maxPerWindow, leftThisHour: Math.max(0, Number((tp.maxPerWindow - spent).toFixed(6))) };
  }
  const calls = guard.policy.agent.maxCallsPerWindow;
  const used = ledger.filter((r) => r.ts > now - guard.policy.agent.windowSeconds && !r.derived).length;
  return { wallet: guard.wallet, tokens, ...(calls ? { callsLeftThisHour: Math.max(0, calls - used) } : {}), waitingForApproval: guard.pending.length };
}

/// The guard as the MCP server's client: the same tools, answered from the
/// saved limits. It checks; the agent's own wallet signs.
function guardClient(which, env = process.env) {
  const { guard, file } = loadGuard(which, env);
  const w = file || guard;
  const bySymbol = Object.fromEntries(Object.entries(guard.tokens).map(([a, t]) => [String(t.symbol || a).toUpperCase(), a]));
  const tokenOf = (t) => {
    const s = String(t || "").trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(s)) return ethers.getAddress(s);
    if (bySymbol[s.toUpperCase()]) return bySymbol[s.toUpperCase()];
    throw new Error(`this wallet does not pay in ${s}; it knows ${Object.keys(bySymbol).join(", ") || "no tokens"}`);
  };
  const client = {
    check(args) {
      const payee = String(args.payee || "").trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(payee)) throw new Error("in guard mode the payee is a 0x address");
      const asset = tokenOf(args.token);
      const decimals = guard.tokens[asset]?.decimals ?? 18;
      const amount = ethers.parseUnits(String(args.amount), decimals).toString();
      const v = check({ payTo: payee, asset, amount }, { guard: w, env });
      return { ...v, next: v.allow ? "Allowed and counted against this hour. Sign and send it with your own wallet now." : "Do not send it. Tell the person why, or pay less or later." };
    },
    pay() {
      return {
        paid: false,
        mode: "guard",
        message: "Guard mode: Rein checks, your wallet signs. Call rein_check_payment first; if it allows the payment, send it with your own wallet. Rein never holds this wallet's key.",
      };
    },
    budget: () => budget(w, { env }),
    policy: () => {
      const g = loadGuard(w, env).guard;
      return { wallet: g.wallet, chain: g.chain, learnedAt: g.learnedAt, limits: g.sentences, policy: g.policy, waitingForApproval: g.pending.map((x) => x.what) };
    },
  };
  const info = {
    mode: "guard: Rein checks each payment against limits learned from this wallet's own history; the wallet's own signer sends it",
    wallet: guard.wallet,
    chain: guard.chain,
    limits: guard.sentences,
    tokens: Object.keys(bySymbol),
    howToPay: "Call rein_check_payment with the payee address, amount and token. Send only what it allows, with your own wallet.",
  };
  return { client, info, sandbox: false, guard: true };
}

// -- the command ------------------------------------------------------------------------

function parse(argv) {
  const o = { address: null, chain: "base", api: null, days: 30, webhook: process.env.REIN_WEBHOOK || null, out: null, approve: false, sample: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--chain") o.chain = argv[++i];
    else if (a === "--api") o.api = argv[++i];
    else if (a === "--days") o.days = Number(argv[++i]);
    else if (a === "--webhook") o.webhook = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--approve") o.approve = true;
    else if (a === "--sample") o.sample = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (!a.startsWith("-")) o.address = a;
    else throw new Error(`unknown flag ${a}`);
  }
  return o;
}

const USAGE = `usage: rein guard <address> [--chain base|base-sepolia|ethereum] [--days 30] [--webhook URL] [--out file]
       rein guard <address> --approve     accept the widenings the last update proposed
       rein guard --sample                try it on Rein's made-up sample wallet`;

async function main(argv, { log = console.log, fetch: fetchImpl, env = process.env } = {}) {
  const o = parse(argv);
  if (o.help || (!o.address && !o.sample)) {
    console.error(USAGE);
    return o.help ? 0 : 2;
  }
  let history;
  if (o.sample) {
    const { sampleHistory } = require("./sample");
    history = sampleHistory();
  } else {
    if (!/^0x[0-9a-fA-F]{40}$/.test(o.address)) throw new Error(`"${o.address}" is not a 0x address`);
    if (o.approve) {
      const { guard, file } = loadGuard(o.address, env);
      const n = approve(guard);
      saveGuard(guard, file);
      log(n ? `Approved ${n} change${n === 1 ? "" : "s"}. The wider limits are in force.` : "Nothing was waiting for approval.");
      return 0;
    }
    log(`Reading ${o.address}'s history on ${CHAINS[o.chain]?.name || o.api || o.chain}…`);
    history = await fetchHistory(o.address, { chain: o.chain, api: o.api, fetch: fetchImpl });
  }

  const { guard, replay } = learn(history, { days: o.days });
  const file = o.out || guardPath(guard.wallet, env);
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  const short = `${guard.wallet.slice(0, 6)}…${guard.wallet.slice(-4)}`;
  log("");
  log(`Rein guard for ${short}${history.synthetic ? " (Rein's made-up sample wallet)" : ""}`);
  log("");
  const window = replay.byTime ? `Its last ${replay.days} days` : `Its most recent ${replay.total} calls`;
  log(`${window}: ${replay.payments} payment${replay.payments === 1 ? "" : "s"}${replay.totals.length ? `, ${replay.totals.join(" and ")}` : ""}, to ${replay.payees} address${replay.payees === 1 ? "" : "es"}.`);
  log(`Limits learned only from before ${replay.since.slice(0, 10)} (${replay.learnedFrom} calls) would have allowed ${replay.allowed} of its ${replay.total} calls.`);
  if (replay.blocked.length) {
    log("They would have blocked:");
    for (const b of replay.blocked) log(`  ${b.when.slice(0, 16).replace("T", " ")}  ${b.what}  ${b.reason}`);
  }
  log("");

  if (existing && existing.version === VERSION) {
    const { policy, applied, proposed } = evolve(existing, guard);
    guard.policy = policy;
    guard.webhook = o.webhook ?? existing.webhook ?? null;
    guard.pending = proposed;
    guard.ledger = [...new Map([...existing.ledger, ...guard.ledger].map((r) => [JSON.stringify(r), r])).values()];
    log(applied.length ? "Tightened on its own:" : "Nothing needed tightening.");
    for (const a of applied) log(`  ${a}`);
    if (proposed.length) {
      log("Would widen, so it waits for you (rein guard " + guard.wallet + " --approve):");
      for (const x of proposed) log(`  ${x.what}`);
    }
  } else {
    guard.webhook = o.webhook || null;
    log(`Limits now in force, learned from all ${guard.learnedFrom.calls} calls:`);
    for (const s of guard.sentences) log(`  ${s}`);
  }
  saveGuard(guard, file);
  log("");
  log(`Saved to ${file}`);
  log("");
  log(`Guard is on. Hold every payment to these limits with one line before your agent signs:`);
  log("");
  log(`  const verdict = require("rein-wallet").check(tx);   // { allow, reason, explanation }`);
  log("");
  log(`  tx is the transaction about to be signed, or an x402 payment ({ payTo, asset, amount }).`);
  log(`  For an MCP agent: rein-wallet mcp --guard ${guard.wallet}${o.out ? ` (with REIN_GUARD_FILE=${file})` : ""}`);
  if (guard.webhook) log(`  Blocked payments are posted to your webhook.`);
  else log(`  Add --webhook <Slack or Discord URL> to be told about every blocked payment.`);
  log(`  Run this command again any time: limits tighten on their own, and anything wider waits for you.`);
  return 0;
}

module.exports = { learn, check, budget, guardClient, evolve, approve, loadGuard, saveGuard, guardPath, toRow, main, parse, USAGE };
