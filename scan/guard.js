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
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const { fetchHistory, toTrail, CHAINS, NO_CALLDATA, SELECTOR_NAMES, ERC20 } = require("./blockscout");
const { evaluate, NATIVE } = require("./evaluate");
const { scanHistory, describe, namer, money } = require("./index");
const codes = require("../scripts/codes");
const { readRouterCall, strangers, readTypedData } = require("./moves");
const { guardFromCohort } = require("./cohort");

const DAY = 86400;
const KEEP_SECONDS = 2 * DAY; // ledger kept for window state; longer than any window the compiler writes
const HOUR = 3600;
const COHORT_UNTIL = 20; // calls of its own before a new wallet's own limits replace its cohort's
const VERSION = 2; // 2: payees split from approval spenders, a daily ceiling, swaps and signatures read

// -- where guards live ----------------------------------------------------------

const home = (env = process.env) => env.REIN_HOME || path.join(os.homedir(), ".rein");
const guardPath = (wallet, env) => path.join(home(env), "guards", `${wallet.toLowerCase()}.json`);

// A guard file is read and written by every check, possibly from several
// processes at once, so it is written to a temporary file and renamed into
// place (a reader sees the old file or the new one, never half of one), and
// each check holds a lock from read to write, so two checks can't both spend
// the same hour.
function saveGuard(g, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(g, null, 2)}\n`);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return file;
    } catch (err) {
      // Windows refuses to replace a file another process has open for a moment.
      if (i >= 50 || (err.code !== "EPERM" && err.code !== "EACCES" && err.code !== "EBUSY")) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      sleep(10);
    }
  }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function withLock(file, fn, { waitMs = 5000, staleMs = 30000 } = {}) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) fs.rmSync(lock, { force: true }); // left by a crashed process
      } catch {
        // gone already
      }
      if (Date.now() > until) throw new Error(`another check has held ${lock} for ${waitMs / 1000}s`);
      sleep(5);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
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
  if (guard.version !== VERSION || !guard.policy) {
    throw new Error(guard.version < VERSION ? `${file} was written by an older rein-wallet: run npx rein-wallet guard ${guard.wallet} again` : `${file} is not a Rein guard file`);
  }
  return { guard, file };
}

// -- learning -------------------------------------------------------------------

/// Learns the limits from a history (as fetchHistory returns it). Returns the
/// guard to save, and the replay: a policy learned only from before the last
/// `days` days, held against what the wallet did in those days.
function learn(history, { days = 30 } = {}) {
  const trail = { payments: true };
  const { rows, tokens, ignored } = toTrail(history, trail);
  const own = rows.filter((r) => !r.derived).length;
  if (own < COHORT_UNTIL) {
    throw new Error(`${history.address} has ${own} call${own === 1 ? "" : "s"} of its own on record; the guard needs ${COHORT_UNTIL} to learn its habits from`);
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

  // The on-chain policy lets a wallet transfer to anyone it may approve,
  // because the contract checks both against one list. The guard keeps them
  // apart: an allowance to a router is not permission to send it money,
  // since anyone can sweep tokens left in a router.
  const { admitted } = current.compiled.bounds;
  // requireIntent is a Rein-account (on-chain) rule; check() has no intent to
  // verify, so the guard file doesn't claim it.
  const { requireIntent, ...agent } = current.policy.onchain.agent;
  const policy = { ...current.policy.onchain, agent, transferPayees: [...admitted.payees].sort(), spenders: [...admitted.spenders].sort() };
  for (const [t, tp] of Object.entries(policy.tokens)) tp.maxPerDay = dailyCeiling(rows, t, tp.maxPerWindow);

  const now = Math.floor(Date.now() / 1000);
  const guard = {
    version: VERSION,
    wallet: history.address,
    chain: history.chain,
    chainId: CHAINS[history.chain]?.chainId ?? null,
    learnedAt: new Date().toISOString(),
    learnedFrom: { calls: current.history.calls, from: current.history.from, to: current.history.to },
    policy,
    sentences: [...current.policy.sentences, ...Object.entries(policy.tokens).map(([t, tp]) => `${name(t)}: at most ${money(tp.maxPerDay)} a day`)],
    withheld: current.policy.withheld,
    tokens: Object.fromEntries(Object.entries(tokens).map(([a, t]) => [a, { symbol: t.symbol || null, decimals: t.decimals ?? 18 }])),
    ledger: rows.filter((r) => r.ts > now - KEEP_SECONDS).map(ledgerRow),
    pending: [],
    holds: [],
    newPayeeCap: 0,
    webhook: null,
  };
  return {
    guard,
    ignored,
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

/// The most the wallet moved of a token in any 24 hours, with the same 25%
/// headroom the hourly ceiling gets, and never less than one full hour. Without
/// it an attacker who stays under the hourly ceiling could take 24 of them a day.
function dailyCeiling(rows, token, hourly) {
  const out = rows.filter((r) => r.token === token && r.kind !== "approve").sort((a, b) => a.ts - b.ts);
  let best = 0;
  let sum = 0;
  let j = 0;
  for (let i = 0; i < out.length; i++) {
    sum += Number(out[i].amount || 0);
    while (out[i].ts - out[j].ts >= DAY) sum -= Number(out[j++].amount || 0);
    best = Math.max(best, sum);
  }
  return Number(Math.max(hourly, best * 1.25).toFixed(6));
}

function readCohort(file) {
  if (!fs.existsSync(file)) throw new Error(`no cohort file at ${file} (rein fleet <wallets.txt> --out dir writes dir/cohort.json)`);
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  if (c.kind !== "rein-cohort") throw new Error(`${file} is not a Rein cohort (rein fleet --out writes cohort.json)`);
  return c;
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
  list("transferPayees", "payee");
  list("spenders", "approval spender");
  list("targets", "contract");
  for (const [t, sels] of Object.entries(n.selectors)) {
    const had = new Set(p.selectors[t] || []);
    for (const s of sels) if (!had.has(s) && p.targets.includes(t)) proposed.push({ what: `allow ${s} on ${t}`, path: ["selectors", t], add: s });
  }
  for (const t of Object.keys(p.selectors)) if (!p.targets.includes(t)) delete p.selectors[t];
  p.payees = union(p);
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
    number(p.tokens[t], tp, "maxPerDay", `${sym} a day`, ["tokens", t]);
  }
  for (const t of Object.keys(p.tokens)) {
    if (!n.tokens[t]) {
      applied.push(`removed ${old.tokens[t]?.symbol || t}, which the agent no longer pays in`);
      delete p.tokens[t];
    }
  }
  return { policy: p, applied, proposed };
}

// The list the on-chain evaluator checks payees and spenders against.
const union = (p) => [...new Set([...p.transferPayees, ...p.spenders])].sort();

function approve(g) {
  const p = g.policy;
  for (const x of g.pending) {
    let obj = p;
    for (const k of x.path) obj = obj[k] ||= Array.isArray(obj) ? [] : k === "selectors" ? {} : [];
    if (x.add != null) {
      if (!obj.includes(x.add)) obj.push(x.add);
    } else obj[x.key] = x.value;
  }
  p.payees = union(p);
  const n = g.pending.length;
  g.pending = [];
  return n;
}

// -- checking a payment -------------------------------------------------------------

function units(raw, decimals) {
  let n;
  try {
    n = BigInt(raw);
  } catch {
    n = -1n;
  }
  // A negative amount would add to what is left of the hour instead of taking from it.
  if (n < 0n || (typeof raw === "string" && !/^(0x[0-9a-fA-F]+|\d+)$/.test(raw.trim()))) {
    throw new Error(`"${raw}" isn't an amount: it must be a whole, non-negative number of the token's smallest units`);
  }
  return Number(ethers.formatUnits(n, decimals));
}

/// A payment as a trail row. Takes an EVM transaction ({ to, data, value })
/// or an x402 payment requirement ({ payTo, asset, amount | maxAmountRequired },
/// in the token's smallest units).
function toRow(tx, guard, now) {
  if (!tx || typeof tx !== "object") throw new Error("check needs a transaction, an x402 payment or a typed-data signature, and got nothing");
  const decimalsOf = (token) => guard.tokens[token]?.decimals ?? 18;
  if (tx.payTo) {
    const token = ethers.getAddress(tx.asset);
    const raw = tx.amount ?? tx.maxAmountRequired;
    if (raw == null) throw new Error("an x402 payment needs amount (or maxAmountRequired) in the token's smallest units");
    return { ts: now, target: token, selector: "transfer", kind: "transfer", token, payee: ethers.getAddress(tx.payTo), amount: units(raw, decimalsOf(token)), value: 0 };
  }
  if (!tx.to) throw new Error("check needs a transaction ({ to, data, value }), an x402 payment ({ payTo, asset, amount }) or a typed-data signature ({ domain, types, primaryType, message })");
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

const isTyped = (tx) => tx && tx.primaryType && tx.message && tx.types;

/// Everything one transaction or signature would move, as rows the policy is
/// held to: the call itself, and for a router swap, the tokens it spends.
/// Returns { rows } or { block: { reason, explanation, payee? } }.
function toRows(tx, guard, now) {
  const decimalsOf = (token) => guard.tokens[token]?.decimals ?? 18;
  if (isTyped(tx)) {
    const moves = readTypedData(tx);
    if (!moves) return { block: { reason: "SIGNATURE_NOT_UNDERSTOOD", explanation: `Rein can't tell what a signature of type ${tx.primaryType} lets someone move, so it is blocked` } };
    return {
      rows: moves.map((m) => ({ ts: now, target: m.token, selector: m.kind, kind: m.kind, token: m.token, payee: m.payee, amount: units(m.raw, decimalsOf(m.token)), value: 0, signed: true })),
    };
  }
  const row = toRow(tx, guard, now);
  if (row.kind !== "call") return { rows: [row] };
  const r = readRouterCall(tx.data || tx.input);
  if (!r) return { rows: [row] };
  const bad = strangers(r, guard.wallet, row.target);
  if (bad) return { block: { reason: "RECIPIENT_NOT_SELF", explanation: "this swap sends what it buys to an address other than this wallet", payee: bad[0] } };
  if (r.unreadable) return { block: { reason: "SWAP_NOT_UNDERSTOOD", explanation: "Rein can't read every step of this router call, so it can't tell who it pays" } };
  // What the router will pull from the wallet counts toward the hour like a payment.
  const spends = r.spends.map((x) => ({ ts: now, target: x.token, selector: "transfer", kind: "transfer", token: x.token, payee: row.target, amount: units(x.raw, decimalsOf(x.token)), value: 0, derived: true }));
  return { rows: [row, ...spends] };
}

/// Same first four and last four hex characters, different address: what a
/// poisoner generates so a hurried copy from history picks theirs.
const looksLike = (a, b) => {
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  return x !== y && x.slice(2, 6) === y.slice(2, 6) && x.slice(-4) === y.slice(-4);
};

const WORDS = {
  LOOKALIKE_PAYEE: "this address starts and ends like one the agent pays, but it is a different address: the mark of address poisoning",
  PAYEE_NOT_ALLOWED: "this agent has never paid that address often enough for it to be trusted",
  SPENDER_NOT_ALLOWED: "this agent has never given that address an allowance often enough for it to be trusted",
  NOT_A_PAYEE: "this agent only gives that address allowances; it has never paid it directly, and tokens sent to a router can be taken by anyone",
  TOKEN_PER_WINDOW: "that would take this agent past its hourly limit for this token",
  TOKEN_PER_DAY: "that would take this agent past its daily limit for this token",
  OUTFLOW_EXCEEDED: "the tokens this swap spends would take this agent past its hourly limit, or it doesn't normally spend that token",
  TARGET_NOT_ALLOWED: "this agent does not normally call that contract",
  SELECTOR_NOT_ALLOWED: "this agent does not normally call that function",
  TOKEN_NOT_ALLOWED: "this agent does not normally pay in that token",
  CALL_RATE: "this agent has already made as many payments this hour as it normally does",
  NATIVE_PER_CALL: "more ETH in one payment than this agent normally sends",
  NATIVE_PER_WINDOW: "that would take this agent past its hourly ETH limit",
  APPROVAL_TOO_LARGE: "a larger allowance than this agent normally grants",
  RECIPIENT_NOT_SELF: "this swap sends what it buys to an address other than this wallet",
  SWAP_NOT_UNDERSTOOD: "Rein can't read every step of this router call, so it can't tell who it pays",
  SIGNATURE_NOT_UNDERSTOOD: "Rein can't tell what this signature lets someone move",
};

/// The reason the guard refuses `rows` on top of `ledger`, or "OK".
function judge(guard, ledger, rows, now) {
  const p = guard.policy;
  const payees = new Set(p.transferPayees);
  const spenders = new Set(p.spenders);
  for (const r of rows) {
    if (r.derived) continue;
    if ((r.kind === "transfer" || r.kind === "transferFrom") && r.token !== NATIVE && !payees.has(r.payee)) return spenders.has(r.payee) ? "NOT_A_PAYEE" : "PAYEE_NOT_ALLOWED";
    if (r.kind === "approve" && !spenders.has(r.payee)) return "SPENDER_NOT_ALLOWED";
  }
  // A signature is not a call: it is held to the token limits, not to the
  // contracts and functions the agent calls.
  const policy = { ...p, targets: [...new Set([...p.targets, ...rows.filter((r) => r.signed).map((r) => r.target)])], selectors: { ...p.selectors } };
  for (const r of rows.filter((x) => x.signed)) policy.selectors[r.target] = [...new Set([...(p.selectors[r.target] || []), r.selector])];
  const { results } = evaluate(policy, [...ledger, ...rows]);
  for (const r of rows) {
    const reason = results.find((x) => x.row === r).reason;
    if (reason !== "OK") return reason;
  }
  for (const t of new Set(rows.filter((r) => r.token && r.token !== NATIVE && r.kind !== "approve").map((r) => r.token))) {
    const cap = p.tokens[t]?.maxPerDay;
    if (cap == null) continue;
    if (spentSince(ledger, rows, t, now - DAY) > cap + 1e-9) return "TOKEN_PER_DAY";
  }
  return "OK";
}

const spentSince = (ledger, rows, token, since) =>
  [...ledger, ...rows].filter((r) => r.token === token && r.ts > since && r.kind !== "approve").reduce((a, r) => a + Number(r.amount || 0), 0);

/// The same payment asked for again gives the same fingerprint, so an
/// approval lets through that payment, not whatever the agent asks next.
function fingerprint(tx) {
  const lower = (x) => (typeof x === "string" ? x.toLowerCase() : x);
  const norm = isTyped(tx)
    ? { primaryType: tx.primaryType, domain: tx.domain, message: tx.message }
    : tx.payTo
      ? { payTo: lower(tx.payTo), asset: lower(tx.asset), amount: String(tx.amount ?? tx.maxAmountRequired) }
      : { to: lower(tx.to), data: lower(tx.data || tx.input || "0x"), value: String(tx.value ?? 0) };
  const text = JSON.stringify(norm, (k, v) => (typeof v === "bigint" ? v.toString() : typeof v === "string" ? v.toLowerCase() : v));
  return crypto.createHash("sha256").update(text).digest("hex");
}

/// Decides a hold. `decision` is "approved" or "denied"; an approval lets
/// that one payment through once, within the hour.
function decide(guard, id, decision, now = Math.floor(Date.now() / 1000)) {
  const h = (guard.holds || []).find((x) => x.id === id && x.until > now);
  if (!h) throw new Error(`no hold ${id} is waiting on ${guard.wallet}`);
  if (h.status !== "waiting") throw new Error(`hold ${id} was already ${h.status}`);
  h.status = decision;
  h.decidedAt = new Date(now * 1000).toISOString();
  h.until = decision === "approved" ? now + HOUR : h.until;
  return h;
}

/// Holds one payment to the saved limits before the agent signs it.
/// Synchronous and local: no network. Takes a transaction ({ to, data,
/// value }), an x402 payment ({ payTo, asset, amount }) or an EIP-712
/// signature request ({ domain, types, primaryType, message }). An allowed
/// payment is recorded, so the next check sees the hour it used.
///
/// It never throws: anything that stops it checking (no guard file, a file it
/// can't read, a transaction it can't parse) comes back as a block, so a
/// `catch` around it can't turn an error into a payment.
function check(tx, opts = {}) {
  try {
    const { guard, file } = loadGuard(opts.wallet || opts.guard || tx?.from || null, opts.env);
    return file ? withLock(file, () => checkOnce(tx, opts, file)) : checkOnce(tx, opts, null, guard);
  } catch (err) {
    return { allow: false, reason: "GUARD_ERROR", explanation: `Rein could not check this payment, so it is blocked: ${err.message}` };
  }
}

function checkOnce(tx, opts, file, given) {
  // Read again under the lock: another process may have spent the hour since.
  const guard = file ? loadGuard(file, opts.env).guard : given;
  // Never earlier than the last payment on record: a clock that runs behind
  // another process's must not slip a payment into an hour already spent.
  const now = Math.max(opts.now ?? Math.floor(Date.now() / 1000), ...guard.ledger.map((r) => r.ts));
  const ledger = guard.ledger.filter((r) => r.ts > now - KEEP_SECONDS);
  const { rows, block } = toRows(tx, guard, now);
  const main = rows ? rows[0] : null;
  let reason = block ? block.reason : judge(guard, ledger, rows, now);
  // An address that starts and ends like one the agent pays, but isn't it.
  const lookalike = reason === "PAYEE_NOT_ALLOWED" && rows.some((r) => r.payee && guard.policy.transferPayees.some((p) => looksLike(p, r.payee)));
  if (lookalike) reason = "LOOKALIKE_PAYEE";
  let allow = reason === "OK";
  // The first payment to a new address, if it is small, goes through and
  // counts toward the hour and the day like any other. Only the first: a
  // second payment to that address waits for a person, and new addresses
  // together get at most three times the cap a day, so an attacker can't
  // take the daily ceiling in small pieces.
  let first = null;
  const firsts = (guard.firstPayments || []).filter((f) => f.ts > now - 30 * DAY);
  if (reason === "PAYEE_NOT_ALLOWED" && guard.newPayeeCap > 0 && rows.every((r) => r.derived || r.kind === "call" || Number(r.amount) <= guard.newPayeeCap)) {
    const extra = rows.map((r) => r.payee).filter(Boolean);
    const amount = rows.filter((r) => !r.derived && r.kind !== "call").reduce((a, r) => a + Number(r.amount), 0);
    const seen = extra.some((p) => firsts.some((f) => f.payee.toLowerCase() === p.toLowerCase()));
    const today = firsts.filter((f) => f.ts > now - DAY).reduce((a, f) => a + f.amount, 0);
    const widened = { ...guard, policy: { ...guard.policy, transferPayees: [...guard.policy.transferPayees, ...extra], payees: [...guard.policy.payees, ...extra] } };
    if (!seen && today + amount <= guard.newPayeeCap * 3 && judge(widened, ledger, rows, now) === "OK") {
      reason = "OK";
      allow = true;
      first = { payee: extra[0], ts: now, amount };
    }
  }
  // Anything else outside the limits is held: a person can let this exact
  // payment through once, and the agent's retry then passes.
  let hold = null;
  let approved = null;
  let refused = null;
  if (!allow && reason !== "GUARD_ERROR") {
    const fp = fingerprint(tx);
    guard.holds = (guard.holds || []).filter((h) => h.until > now);
    approved = guard.holds.find((h) => h.fp === fp && h.status === "approved" && !h.used);
    // A payment a person refused stays refused until the hold runs out,
    // rather than asking them again on every retry.
    refused = approved ? null : guard.holds.find((h) => h.fp === fp && h.status === "denied");
    if (approved) {
      approved.used = new Date(now * 1000).toISOString();
      allow = true;
    } else if (!refused) {
      hold = guard.holds.find((h) => h.fp === fp && h.status === "waiting");
      if (!hold) {
        hold = { id: crypto.randomBytes(4).toString("hex"), fp, at: new Date(now * 1000).toISOString(), until: now + DAY, status: "waiting", reason };
        guard.holds.push(hold);
        hold.isNew = true;
      }
    }
  }
  const sym = (t) => (t === NATIVE ? "ETH" : guard.tokens[t]?.symbol || t);
  const paid = rows ? rows.find((r) => r.token && r.kind !== "call") : null;
  const verdict = {
    allow,
    reason: approved ? "APPROVED" : reason,
    explanation: approved
      ? `outside this agent's usual limits (${reason}), and a person approved this payment`
      : allow
        ? "inside this agent's usual payees and limits"
        : block?.explanation || WORDS[reason] || codes.explain(codes.NAMES.indexOf(reason)) || reason,
    wallet: guard.wallet,
    ...(block?.payee ? { payee: block.payee } : main?.payee ? { payee: main.payee } : {}),
    ...(paid ? { amount: paid.amount, token: sym(paid.token) } : {}),
  };
  if (hold) {
    Object.assign(hold, { what: verdict.amount != null ? `${money(verdict.amount)} ${verdict.token}${verdict.payee ? ` to ${verdict.payee}` : ""}` : `a call to ${tx.to || "a contract"}`, explanation: verdict.explanation });
    verdict.held = hold.id;
    verdict.next = `Held for a person to approve. Don't retry another way. Tell the person, and retry this same payment once it is approved (rein-wallet guard ${guard.wallet} --allow ${hold.id}).`;
  }
  if (refused) {
    verdict.refused = refused.id;
    verdict.next = "A person refused this payment. Don't retry it, or try it another way.";
  }
  const tp = paid && guard.policy.tokens[paid.token];
  if (tp) {
    const mine = allow ? rows : [];
    verdict.leftThisHour = Math.max(0, Number((tp.maxPerWindow - spentSince(ledger, mine, paid.token, now - tp.windowSeconds)).toFixed(6)));
    if (tp.maxPerDay != null) verdict.leftToday = Math.max(0, Number((tp.maxPerDay - spentSince(ledger, mine, paid.token, now - DAY)).toFixed(6)));
  }
  if (opts.record !== false && file) {
    if (allow) guard.ledger = [...ledger, ...rows.map(ledgerRow)];
    if (first) guard.firstPayments = [...firsts, first];
    else guard.blocked = [...(guard.blocked || []), { at: new Date(now * 1000).toISOString(), ...verdict }].slice(-100);
  }
  const isNew = hold && hold.isNew;
  if (hold) delete hold.isNew;
  if (opts.record !== false && file) saveGuard(guard, file);
  // A hold already announced isn't announced again on every retry.
  if (!allow && !refused && guard.webhook && opts.alert !== false && (!hold || isNew) && !guard.approvals) alert(guard, verdict, opts.fetch);
  return verdict;
}

function alert(guard, v, fetchImpl = globalThis.fetch) {
  const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const what = `${v.amount != null ? `${money(v.amount)} ${v.token}` : "a call"}${v.payee ? ` to ${v.payee}` : ""}`;
  const text = v.held
    ? `Rein is holding a payment from ${short(guard.wallet)}: ${what}. Why: ${v.explanation}.\nTo let this one payment through: npx rein-wallet guard ${guard.wallet} --allow ${v.held}\nTo refuse it: npx rein-wallet guard ${guard.wallet} --deny ${v.held}`
    : `Rein blocked a payment from ${short(guard.wallet)}: ${what}. ${v.reason}: ${v.explanation}.`;
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
    const today = spentSince(ledger, [], t, now - DAY);
    tokens[guard.tokens[t]?.symbol || t] = {
      token: t,
      limitPerHour: tp.maxPerWindow,
      leftThisHour: Math.max(0, Number((tp.maxPerWindow - spent).toFixed(6))),
      ...(tp.maxPerDay != null ? { limitPerDay: tp.maxPerDay, leftToday: Math.max(0, Number((tp.maxPerDay - today).toFixed(6))) } : {}),
    };
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
      const said = String(args.amount ?? "").trim();
      const places = said.split(".")[1]?.length || 0;
      if (!/^\d+(\.\d+)?$/.test(said) || places > decimals) {
        throw new Error(`"${said}" isn't an amount: write it in normal units with at most ${decimals} decimal places, like "250" or "12.50"`);
      }
      const amount = ethers.parseUnits(said, decimals).toString();
      const v = check({ payTo: payee, asset, amount }, { guard: w, env });
      return { ...v, next: v.next || (v.allow ? "Allowed and counted against this hour. Sign and send it with your own wallet now." : "Do not send it. Tell the person why, or pay less or later.") };
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
    limit: "Rein sees only the payments checked here. A payment sent without checking first is not held to these limits, so check every one.",
  };
  return { client, info, sandbox: false, guard: true };
}

/// Widening is the one thing an attacker inside the agent wants, and most
/// agents can run shell commands. So `--approve` shows what it would widen and
/// waits for a person to type the wallet's last four characters at a terminal;
/// a command run by an agent, with no terminal on its input, is refused.
function approveAtKeyboard(address, { log, env, input }) {
  const { guard, file } = loadGuard(address, env);
  if (!guard.pending.length) {
    log("Nothing is waiting for approval.");
    return 0;
  }
  log(`Approving widens ${guard.wallet}'s limits:`);
  for (const x of guard.pending) log(`  ${x.what}`);
  if (!confirmed(guard, { log, input })) return 1;
  const n = approve(guard);
  saveGuard(guard, file);
  log(`Approved ${n} change${n === 1 ? "" : "s"}. The wider limits are in force.`);
  return 0;
}

/// --allow / --deny one held payment, at the keyboard like --approve.
function decideAtKeyboard(address, id, decision, { log, env, input, now }) {
  const { guard, file } = loadGuard(address, env);
  const h = (guard.holds || []).find((x) => x.id === id);
  if (!h) throw new Error(`no hold ${id} on ${guard.wallet}; rein-wallet guard ${guard.wallet} --holds lists them`);
  log(`${decision === "approved" ? "Letting through" : "Refusing"} ${h.what} (held because ${h.explanation}).`);
  if (decision === "approved" && !confirmed(guard, { log, input })) return 1;
  // Refusing can't help an attacker, so it needs no keyboard.
  withLock(file, () => {
    const fresh = loadGuard(file, env).guard;
    decide(fresh, id, decision, now);
    saveGuard(fresh, file);
  });
  log(decision === "approved" ? "Approved. The agent's next try of this same payment, within the hour, goes through once." : "Refused. It stays blocked.");
  return 0;
}

function listHolds(address, { log, env }) {
  const { guard } = loadGuard(address, env);
  const now = Math.floor(Date.now() / 1000);
  const live = (guard.holds || []).filter((h) => h.until > now);
  if (!live.length) log("No held payments.");
  for (const h of live) log(`  ${h.id}  ${h.status.padEnd(8)}  ${h.at.slice(0, 16).replace("T", " ")}  ${h.what}  (${h.reason})`);
  return 0;
}

/// One line from the terminal. Node leaves stdin non-blocking once it has
/// looked at isTTY, so a plain read fails with EAGAIN; read the terminal
/// itself where there is one, and wait on stdin otherwise.
function readLine() {
  let fd = 0;
  let opened = false;
  if (process.platform !== "win32") {
    try {
      fd = fs.openSync("/dev/tty", "r");
      opened = true;
    } catch {
      fd = 0;
    }
  }
  const buf = Buffer.alloc(64);
  let n;
  for (;;) {
    try {
      n = fs.readSync(fd, buf, 0, 64, null);
      break;
    } catch (err) {
      if (err.code !== "EAGAIN") throw err;
      sleep(50);
    }
  }
  if (opened) fs.closeSync(fd);
  return buf.toString("utf8", 0, n);
}

function confirmed(guard, { log, input }) {
  const want = guard.wallet.slice(-4).toLowerCase();
  let typed = input;
  if (typed == null) {
    if (!process.stdin.isTTY) {
      log("Refused: approving needs a person at a terminal, and this command has no terminal on its input.");
      return false;
    }
    process.stdout.write("Type the last four characters of the wallet address to approve: ");
    const asked = Date.now();
    typed = readLine();
    // Typed before the question was asked: a script, not a person reading it.
    if (Date.now() - asked < 300) {
      log("\nNot approved: that answer was already waiting before the question. Type it after the prompt.");
      return false;
    }
  }
  if (String(typed).trim().toLowerCase() !== want) {
    log("Not approved: that didn't match.");
    return false;
  }
  return true;
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
    else if (a === "--allow") o.allow = argv[++i];
    else if (a === "--deny") o.deny = argv[++i];
    else if (a === "--holds") o.holds = true;
    else if (a === "--new-payee-cap") o.newPayeeCap = Number(argv[++i]);
    else if (a === "--cohort") o.cohort = argv[++i];
    else if (a === "--sample") o.sample = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (!a.startsWith("-")) o.address = a;
    else throw new Error(`unknown flag ${a}`);
  }
  return o;
}

const USAGE = `usage: rein guard <address> [--chain base|base-sepolia|ethereum] [--api <Blockscout URL>] [--days 30] [--webhook URL] [--out file]
       rein guard <address> --approve     accept the widenings the last update proposed
       rein guard <address> --holds       payments held for a person to approve
       rein guard <address> --allow <id>  let one held payment through (--deny <id> refuses it)
       --new-payee-cap N                  let a first payment to a new address through when it is N tokens or less
       --cohort cohort.json               start a new wallet from the limits its siblings share (rein fleet --out writes it)
       rein guard --sample                try it on Rein's made-up sample wallet`;

async function main(argv, { log = console.log, fetch: fetchImpl, env = process.env, input, now } = {}) {
  const o = parse(argv);
  if (o.help || (!o.address && !o.sample)) {
    console.error(USAGE);
    return o.help ? 0 : 2;
  }
  // Read before the network, so a wrong path fails first and plainly.
  const cohort = o.cohort ? readCohort(o.cohort) : null;
  let history;
  if (o.sample) {
    const { sampleHistory } = require("./sample");
    history = sampleHistory();
  } else {
    if (!/^0x[0-9a-fA-F]{40}$/.test(o.address)) throw new Error(`"${o.address}" is not a 0x address`);
    if (o.approve) return approveAtKeyboard(o.address, { log, env, input });
    if (o.allow) return decideAtKeyboard(o.address, o.allow, "approved", { log, env, input, now });
    if (o.deny) return decideAtKeyboard(o.address, o.deny, "denied", { log, env, input, now });
    if (o.holds) return listHolds(o.address, { log, env });
    log(`Reading ${o.address}'s history on ${CHAINS[o.chain]?.name || o.api || o.chain}…`);
    try {
      history = await fetchHistory(o.address, { chain: o.chain, api: o.api, fetch: fetchImpl });
    } catch (err) {
      // A brand-new wallet the explorer hasn't seen yet can still start from its cohort.
      if (!(cohort && /has no record/.test(err.message))) throw err;
      history = { chain: o.chain, address: ethers.getAddress(o.address), info: null, transactions: [], tokenTransfers: [], tokenBalances: [] };
    }
  }

  let learned = null;
  let failure = null;
  try {
    learned = learn(history, { days: o.days });
  } catch (err) {
    failure = err;
  }
  const wallet = ethers.getAddress(history.address);
  const file = o.out || guardPath(wallet, env);
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  const own = learned ? learned.guard.learnedFrom.calls : toTrail(history, { payments: true }).rows.filter((r) => !r.derived).length;
  // A new wallet starts from what its siblings share, and keeps to it until it
  // has enough history of its own; then its own limits replace it, tightening
  // on their own and widening only with your approval, like any update.
  const onCohort = own < COHORT_UNTIL && (cohort || existing?.fromCohort);
  if (!learned && !onCohort) {
    throw new Error(`${failure.message}. A new wallet can start from the limits its platform's other wallets share: rein fleet <their addresses> --out dir, then rein guard ${wallet} --cohort dir/cohort.json`);
  }
  const short = `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
  log("");
  log(`Rein guard for ${short}${history.synthetic ? " (Rein's made-up sample wallet)" : ""}`);
  log("");
  let guard;
  if (onCohort) {
    guard = cohort ? guardFromCohort(cohort, wallet, { chain: history.chain, chainId: CHAINS[history.chain]?.chainId ?? null }) : JSON.parse(JSON.stringify(existing));
    const now = Math.floor(Date.now() / 1000);
    guard.ledger = toTrail(history, { payments: true }).rows.filter((r) => r.ts > now - KEEP_SECONDS).map(ledgerRow);
    log(`It has ${own} call${own === 1 ? "" : "s"} of its own, too few to learn from (it needs ${COHORT_UNTIL}), so it is held to the limits ${guard.learnedFrom.cohort} sibling wallets share until then.`);
  } else {
    const { replay } = learned;
    guard = learned.guard;
    if (learned.ignored.length) {
      const payees = [...new Set(learned.ignored.map((x) => x.payee).filter(Boolean))];
      log(`Ignored ${learned.ignored.length} transfer${learned.ignored.length === 1 ? "" : "s"} this wallet never sent: someone else's contract made ${learned.ignored.length === 1 ? "it" : "them"} look like payments from it${payees.length ? `, to ${payees.slice(0, 3).map((a) => `${a.slice(0, 6)}…${a.slice(-4)}`).join(", ")}${payees.length > 3 ? ` and ${payees.length - 3} more` : ""}` : ""}. That is how address poisoning works, and none of them is trusted.`);
      log("");
    }
    const window = replay.byTime ? `Its last ${replay.days} days` : `Its most recent ${replay.total} calls`;
    log(`${window}: ${replay.payments} payment${replay.payments === 1 ? "" : "s"}${replay.totals.length ? `, ${replay.totals.join(" and ")}` : ""}, to ${replay.payees} address${replay.payees === 1 ? "" : "es"}.`);
    log(`Limits learned only from before ${replay.since.slice(0, 10)} (${replay.learnedFrom} calls) would have allowed ${replay.allowed} of its ${replay.total} calls.`);
    if (replay.blocked.length) {
      log("They would have blocked:");
      for (const b of replay.blocked) log(`  ${b.when.slice(0, 16).replace("T", " ")}  ${b.what}  ${b.reason}`);
    }
    if (existing?.fromCohort) log(`It now has ${own} calls of its own, so its own limits take over from the shared ones.`);
  }
  log("");

  if (existing && existing.version === VERSION) {
    const { policy, applied, proposed } = evolve(existing, guard);
    guard.policy = policy;
    guard.webhook = o.webhook ?? existing.webhook ?? null;
    guard.newPayeeCap = o.newPayeeCap ?? existing.newPayeeCap ?? 0;
    guard.holds = existing.holds || [];
    guard.approvals = existing.approvals || null;
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
    guard.newPayeeCap = o.newPayeeCap ?? 0;
    log(guard.fromCohort ? `Limits now in force, shared by ${guard.learnedFrom.cohort} sibling wallets:` : `Limits now in force, learned from all ${guard.learnedFrom.calls} calls:`);
    for (const s of guard.sentences) log(`  ${s}`);
  }
  saveGuard(guard, file);
  log("");
  log(`Saved to ${file}`);
  log("");
  log(`Guard is on. Hold every payment to these limits with one line before your agent signs:`);
  log("");
  log(`  const verdict = require("rein-wallet").check(tx, { wallet: "${guard.wallet}" });   // { allow, reason, explanation }`);
  log("");
  log(`  tx is the transaction about to be signed, or an x402 payment ({ payTo, asset, amount }).`);
  log(`  For an MCP agent: rein-wallet mcp --guard ${guard.wallet}${o.out ? ` (with REIN_GUARD_FILE=${file})` : ""}`);
  if (guard.webhook) log(`  Blocked payments are posted to your webhook.`);
  else log(`  Add --webhook <Slack or Discord URL> to be told about every blocked payment.`);
  log(`  Run this command again any time: limits tighten on their own, and anything wider waits for you.`);
  return 0;
}

module.exports = { looksLike, COHORT_UNTIL, withLock, home, judge, WORDS, decide, fingerprint, learn, check, budget, guardClient, evolve, approve, loadGuard, saveGuard, guardPath, toRow, toRows, main, parse, USAGE };
