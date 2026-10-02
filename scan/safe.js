// rein safe: a second look at a Safe's queue before the last signature.
//
//   npx rein-wallet safe 0xYourSafe --webhook "$SLACK_OR_DISCORD_WEBHOOK_URL"
//
// On a multisig, one person proposes a payment and the others sign what the
// screen shows them. None of them pasted the address, so a lookalike (address
// poisoning) or a first-ever payment to a stranger is easy to sign. Rein reads
// the Safe's queued transactions from Safe's transaction service and checks
// each payee against what that Safe has actually paid before, from public
// chain data. It flags:
//   - a payee that starts and ends like one the Safe has paid, or like an
//     owner, but is a different address (address poisoning);
//   - a payee that only ever appears in fake transfers made to look like the
//     Safe sent them;
//   - a first payment to an address it has never paid, over --min-usd;
//   - a payment more than 3× the most it has paid that payee;
//   - a delegatecall to anything but Safe's own MultiSend, and changes to
//     the Safe's owners, threshold, modules or guard.
// It holds no key and signs nothing: it can only warn. Each flagged
// transaction is posted once.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { fetchHistory, fetchEthPaid, toTrail, CHAINS } = require("./blockscout");
const { NATIVE } = require("./evaluate");
const { namer, money } = require("./index");
const { looksLike, home } = require("./guard");

const SAFE_API = "https://api.safe.global/tx-service";
// Safe's client gateway, which the Safe{Wallet} app itself reads: public, no key.
const SAFE_GATEWAY = "https://safe-client.safe.global";
const SHORT = { base: "base", ethereum: "eth", "base-sepolia": "basesep" };
// Safe's own batching contracts (v1.3.0 and v1.4.1): a delegatecall to these
// is how the Safe app sends several calls at once.
const MULTISEND = new Set(
  ["0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761", "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D", "0x998739BFdAAdde7C933B942a68053933098f9EDa", "0xA1dabEF33b3B82c7814B6D82A79e50F4AC44102B", "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526", "0x9641d764fc13c8B624c04430C7356C1C7C8102e2"].map((a) => a.toLowerCase()),
);
const CONTROL = new Set(["addOwnerWithThreshold", "removeOwner", "swapOwner", "changeThreshold", "enableModule", "disableModule", "setGuard", "setModuleGuard", "setFallbackHandler"]);
const STABLES = /^(USDC|USDbC|USDT|DAI|USDS|EURC|PYUSD)$/i;
const ERC20 = new ethers.Interface(["function transfer(address to, uint256 value)", "function approve(address spender, uint256 value)", "function transferFrom(address from, address to, uint256 value)", "function increaseAllowance(address spender, uint256 value)", "function setApprovalForAll(address operator, bool approved)"]);
// Permit2's allowance (token, spender, amount, expiration) and Disperse's
// payouts (a payroll Safe's usual batch): each moves money to an address in
// its arguments, not to the contract called.
const PERMIT2 = new ethers.Interface(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);
const DISPERSE = new ethers.Interface(["function disperseEther(address[] recipients, uint256[] values)", "function disperseToken(address token, address[] recipients, uint256[] values)", "function disperseTokenSimple(address token, address[] recipients, uint256[] values)"]);
const MULTI = new ethers.Interface(["function multiSend(bytes transactions)"]);

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/// A lookalike as poisoners make them: the same first and last characters,
/// not only exactly four and four (wallets show 3 to 6 at each end). A
/// random pair matches 7 hex characters about once in 268 million.
function looksAlike(a, b) {
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  if (x === y || x.length !== 42 || y.length !== 42) return false;
  if (looksLike(x, y)) return true;
  let p = 0;
  while (p < 40 && x[2 + p] === y[2 + p]) p++;
  let q = 0;
  while (q < 40 && x[41 - q] === y[41 - q]) q++;
  return (p >= 3 && q >= 4) || (p >= 4 && q >= 3) || q >= 6 || (p >= 6 && q >= 2);
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dollars = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n).toLocaleString("en-US")}`);

// -- Safe's transaction service ---------------------------------------------------

function safeApi(chain, { url = null, apiKey = null, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!url && !apiKey) return safeGateway(chain, { fetch: fetchImpl });
  const base = (url || (SHORT[chain] ? `${SAFE_API}/${SHORT[chain]}/api` : null))?.replace(/\/$/, "");
  if (!base) throw new Error(`Safe's transaction service has no "${chain}"; pass --safe-api <url>`);
  if (!url && !apiKey) throw new Error("Safe's transaction service needs an API key: get one free at developer.safe.global and set SAFE_API_KEY (or pass --safe-api for your own service)");
  const get = async (p) => {
    const res = await fetchImpl(`${base}${p}`, { headers: { accept: "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) } });
    if (res.status === 404) throw new Error("Safe's transaction service has no Safe at that address on this chain");
    if (!res.ok) throw new Error(`Safe's transaction service answered ${res.status}`);
    return res.json();
  };
  return {
    info: (safe) => get(`/v1/safes/${safe}/`),
    queue: async (safe, nonce) => (await get(`/v1/safes/${safe}/multisig-transactions/?executed=false&nonce__gte=${nonce}&ordering=nonce&limit=100`)).results || [],
    // The Safe's own recent executed transactions: the contracts it calls and
    // the spenders it approves, which a lookalike may copy.
    executed: async (safe) => (await get(`/v1/safes/${safe}/multisig-transactions/?executed=true&ordering=-nonce&limit=100`)).results || [],
  };
}

/// The same, from Safe's client gateway, shaped like the transaction service's
/// answers. No key needed, so a Safe's owners set up nothing but the webhook.
function safeGateway(chain, { url = SAFE_GATEWAY, fetch: fetchImpl = globalThis.fetch } = {}) {
  const chainId = CHAINS[chain]?.chainId;
  if (!chainId) throw new Error(`unknown chain "${chain}"`);
  const base = `${url.replace(/\/$/, "")}/v1/chains/${chainId}`;
  const get = async (p) => {
    const res = await fetchImpl(p.startsWith("http") ? p : `${base}${p}`, { headers: { accept: "application/json" } });
    if (res.status === 404) throw new Error(`there is no Safe at that address on ${CHAINS[chain].name}${chain === "base" ? " (on Ethereum? choose Ethereum, or add --chain ethereum)" : chain === "ethereum" ? " (on Base? choose Base, or add --chain base)" : ""}`);
    if (!res.ok) throw new Error(`Safe's gateway answered ${res.status}`);
    return res.json();
  };
  const value = (x) => (x && typeof x === "object" ? x.value : x);
  return {
    info: async (safe) => {
      const i = await get(`/safes/${safe}`);
      return { nonce: i.nonce, threshold: i.threshold, owners: (i.owners || []).map(value) };
    },
    queue: async (safe) => {
      // The gateway pages the queue 20 at a time; read up to 5 pages.
      const ids = [];
      let page = await get(`/safes/${safe}/transactions/queued`);
      for (let n = 1; ; n++) {
        for (const x of page.results || []) if (x.type === "TRANSACTION" && x.transaction?.id && !ids.includes(x.transaction.id)) ids.push(x.transaction.id);
        if (!page.next || n >= 5) break;
        page = await get(page.next);
      }
      const out = [];
      for (const id of ids) out.push(await detail(id));
      return out;
    },
    executed: async (safe) => {
      // Contract calls only (a plain transfer's payee is already in the
      // history), the most recent 25, from up to 3 pages.
      const ids = [];
      let page = await get(`/safes/${safe}/transactions/history`);
      for (let n = 1; ; n++) {
        for (const x of page.results || []) if (x.type === "TRANSACTION" && x.transaction?.id && x.transaction.txInfo?.type === "Custom" && ids.length < 25) ids.push(x.transaction.id);
        if (!page.next || n >= 3 || ids.length >= 25) break;
        page = await get(page.next);
      }
      const out = [];
      for (const id of ids) out.push(await detail(id));
      return out;
    },
  };
  async function detail(id) {
    const d = await get(`/transactions/${id}`);
    const t = d.txData || {};
    const e = d.detailedExecutionInfo || {};
    return {
      nonce: e.nonce,
      safeTxHash: e.safeTxHash || id,
      to: value(t.to),
      value: t.value || "0",
      data: t.hexData || "0x",
      operation: t.operation || 0,
      dataDecoded: t.dataDecoded || null,
      // Who the Safe pays for gas when the transaction runs, and how much: a
      // queued transaction can pay any amount of any token to refundReceiver.
      safeTxGas: e.safeTxGas || "0",
      baseGas: e.baseGas || "0",
      gasPrice: e.gasPrice || "0",
      gasToken: value(e.gasToken) || ethers.ZeroAddress,
      refundReceiver: value(e.refundReceiver) || ethers.ZeroAddress,
      confirmations: e.confirmations || [],
      confirmationsRequired: e.confirmationsRequired,
      isExecuted: d.txStatus === "SUCCESS",
      // What the gateway knows of the token a plain transfer moves.
      tokens: d.txInfo?.transferInfo?.tokenAddress ? [{ address: d.txInfo.transferInfo.tokenAddress, symbol: d.txInfo.transferInfo.tokenSymbol, decimals: d.txInfo.transferInfo.decimals }] : [],
    };
  }
}

// -- reading a queued transaction -------------------------------------------------

/// The calls a queued Safe transaction makes: one, or each call of a MultiSend.
function callsOf(tx) {
  const to = ethers.getAddress(tx.to);
  const op = Number(tx.operation || 0);
  if (op === 1) {
    if (!MULTISEND.has(to.toLowerCase())) return { calls: [], danger: `it hands control of the Safe to the contract ${to} for one call (a delegatecall), which can move anything` };
    try {
      const [packed] = MULTI.decodeFunctionData("multiSend", tx.data);
      return { calls: unpackMultiSend(packed) };
    } catch {
      return { calls: [], danger: "it batches calls Rein can't read" };
    }
  }
  return { calls: [{ to, value: BigInt(tx.value || 0), data: tx.data || "0x", operation: 0 }] };
}

/// MultiSend's packed bytes: operation (1), to (20), value (32), length (32), data.
function unpackMultiSend(hex) {
  const b = ethers.getBytes(hex);
  const out = [];
  let i = 0;
  while (i < b.length) {
    const operation = b[i];
    const to = ethers.getAddress(ethers.hexlify(b.slice(i + 1, i + 21)));
    const value = BigInt(ethers.hexlify(b.slice(i + 21, i + 53)));
    const len = Number(BigInt(ethers.hexlify(b.slice(i + 53, i + 85))));
    const data = ethers.hexlify(b.slice(i + 85, i + 85 + len));
    out.push({ to, value, data, operation });
    i += 85 + len;
  }
  return out;
}

/// What one call moves: { kind, token, payee, raw } or a plain contract call.
function moveOf(c) {
  if (c.data && c.data !== "0x" && c.data.length >= 10) {
    for (const iface of [ERC20, PERMIT2]) {
      try {
        const d = iface.parseTransaction({ data: c.data });
        if (!d) continue;
        if (iface === PERMIT2) return { kind: "approve", token: ethers.getAddress(d.args[0]), payee: ethers.getAddress(d.args[1]), raw: BigInt(d.args[2]) };
        if (d.name === "transfer") return { kind: "transfer", token: c.to, payee: ethers.getAddress(d.args[0]), raw: d.args[1] };
        if (d.name === "transferFrom") return { kind: "transfer", token: c.to, payee: ethers.getAddress(d.args[1]), raw: d.args[2] };
        if (d.name === "approve" || d.name === "increaseAllowance") return { kind: "approve", token: c.to, payee: ethers.getAddress(d.args[0]), raw: d.args[1] };
        if (d.name === "setApprovalForAll") return d.args[1] ? { kind: "approve", token: c.to, payee: ethers.getAddress(d.args[0]), raw: ethers.MaxUint256 } : { kind: "call", target: c.to, selector: c.data.slice(0, 10) };
      } catch {
        // not this kind of call
      }
    }
    return { kind: "call", target: c.to, selector: c.data.slice(0, 10) };
  }
  return { kind: "transfer", token: NATIVE, payee: c.to, raw: c.value };
}

/// Every move one call makes: Disperse's payouts one by one, and ETH sent
/// along with calldata as a payment to the contract or address called.
function movesOf(c) {
  let out = null;
  if (c.data && c.data.length >= 10) {
    try {
      const d = DISPERSE.parseTransaction({ data: c.data });
      if (d) {
        const token = d.name === "disperseEther" ? NATIVE : ethers.getAddress(d.args[0]);
        const [to, raw] = d.name === "disperseEther" ? [d.args[0], d.args[1]] : [d.args[1], d.args[2]];
        out = to.map((payee, i) => ({ kind: "transfer", token, payee: ethers.getAddress(payee), raw: BigInt(raw[i] ?? 0) }));
      }
    } catch {
      out = null;
    }
  }
  out ||= [moveOf(c)];
  const v = BigInt(c.value || 0);
  if (v > 0n && !out.some((m) => m.token === NATIVE)) out.push({ kind: "transfer", token: NATIVE, payee: c.to, raw: v });
  return out;
}

// -- what the Safe has done -------------------------------------------------------

/// What Rein knows about a Safe from its public history: who it has paid, the
/// largest it has sent in each token, who it has approved, and the addresses
/// that appear only in fake transfers made to look like it sent them.
function habits(history, { owners = [], ethPaid = [], executed = [], safe = null } = {}) {
  const { rows, tokens, ignored = [] } = toTrail(history, { payments: true });
  const own = rows.filter((r) => !r.derived);
  const paid = new Map();
  const largest = {};
  const spenders = new Set();
  for (const r of own) {
    if (!r.payee) continue;
    if (r.kind === "approve") spenders.add(r.payee.toLowerCase());
    else if (r.kind === "transfer" || r.kind === "transferFrom") {
      paid.set(r.payee.toLowerCase(), (paid.get(r.payee.toLowerCase()) || 0) + 1);
      // The most it has paid each payee in each token.
      if (r.token) {
        const k = `${r.payee.toLowerCase()}:${r.token.toLowerCase()}`;
        largest[k] = Math.max(largest[k] || 0, Number(r.amount));
      }
    }
  }
  // The contracts the Safe's own executed transactions called, and the
  // spenders they approved: Safe's service has them, the explorer doesn't.
  const called = new Set();
  for (const tx of executed) {
    let calls = [];
    try {
      calls = callsOf(tx).calls;
    } catch {
      continue;
    }
    for (const c of calls) {
      const to = c.to.toLowerCase();
      if (MULTISEND.has(to) || (safe && to === safe.toLowerCase())) continue;
      const m = moveOf(c);
      if (m.kind === "approve") {
        spenders.add(m.payee.toLowerCase());
        called.add(to);
      } else if (m.kind === "call") called.add(to);
      else if (m.token !== NATIVE) called.add(to);
    }
  }
  // ETH a Safe pays goes out as internal transactions, read separately.
  for (const e of ethPaid) {
    const key = e.payee.toLowerCase();
    paid.set(key, (paid.get(key) || 0) + 1);
    const k = `${key}:${NATIVE.toLowerCase()}`;
    largest[k] = Math.max(largest[k] || 0, e.amount);
  }
  // How often it pays someone for the first time: a grants or payroll Safe
  // does it every week, and a first payment there is no news.
  const seen = new Set();
  let firsts = 0;
  let counted = 0;
  for (const r of own) {
    if (!r.payee || r.kind === "approve" || !(r.kind === "transfer" || r.kind === "transferFrom")) continue;
    counted += 1;
    if (!seen.has(r.payee.toLowerCase())) firsts += 1;
    seen.add(r.payee.toLowerCase());
  }
  const newShare = counted >= 10 ? firsts / counted : null;
  // A Safe never calls a token itself (its owners send execTransaction), so
  // the explorer filter reads a payment in an unpriced token, a DAO's own
  // governance token say, as possible poisoning. Unless the payee looks like
  // another address, count it as a real payment.
  // Anyone can emit such a transfer "from" the Safe for a few cents, so it
  // only counts as having paid that address in that same token: it never
  // vouches for a payment in USDC, and never makes a lookalike's twin.
  const realIgnored = ignored.filter((x) => /is unpriced/.test(x.why) && x.payee && ![...paid.keys(), ...ignored.map((y) => y.payee && y.payee.toLowerCase())].some((p) => p && looksAlike(p, x.payee)));
  const paidIn = new Set();
  const unpricedToken = new Map(ignored.map((x) => [x.tx, null]));
  for (const t of history.tokenTransfers || []) if (unpricedToken.has(t.transaction_hash) && (t.token?.address_hash || t.token?.address)) unpricedToken.set(t.transaction_hash, String(t.token.address_hash || t.token.address).toLowerCase());
  for (const x of realIgnored) if (unpricedToken.get(x.tx)) paidIn.add(`${x.payee.toLowerCase()}:${unpricedToken.get(x.tx)}`);
  const fake = ignored.filter((x) => !realIgnored.includes(x));
  const fakes = new Set(fake.map((x) => x.payee && x.payee.toLowerCase()).filter(Boolean));
  const rate = (t) => (t === NATIVE ? (history.info?.exchange_rate != null ? Number(history.info.exchange_rate) : null) : tokens[t]?.rate ?? (STABLES.test(tokens[t]?.symbol || "") ? 1 : null));
  // Names an attacker can't choose for the payee: none from the transfers Rein ignored.
  const ignoredTx = new Set(ignored.map((x) => x.tx));
  const name = namer({ ...history, tokenTransfers: (history.tokenTransfers || []).filter((t) => !ignoredTx.has(t.transaction_hash)) }, tokens);
  return { paid, paidIn, largest, spenders, called, fakes, tokens, rate, owners: owners.map((o) => ethers.getAddress(o)), name, payments: own.length + ethPaid.length + realIgnored.length, newShare, ignored: fake, truncated: Boolean(history.truncated) };
}

/// A token's symbol, decimals and dollar rate: from the Safe's own history,
/// else from what Safe's service said about the queued transfer.
function tokenInfo(token, h, tx) {
  if (token === NATIVE) return { symbol: "ETH", decimals: 18, rate: h.rate(NATIVE) };
  const known = h.tokens[token] || h.tokens[ethers.getAddress(token)];
  const told = (tx.tokens || []).find((t) => t.address && t.address.toLowerCase() === token.toLowerCase());
  const symbol = known?.symbol || told?.symbol || short(token);
  const rate = h.rate(token) ?? (STABLES.test(symbol) && told ? 1 : null);
  return { symbol, decimals: known?.decimals ?? (told?.decimals != null ? Number(told.decimals) : null), rate };
}

function describe(raw, info) {
  const amount = info.decimals != null ? Number(ethers.formatUnits(raw, info.decimals)) : null;
  const usd = amount != null && info.rate != null ? amount * info.rate : null;
  return `${amount != null ? money(amount) : "an unknown amount of"} ${info.symbol}${usd != null && usd >= 1 && !STABLES.test(info.symbol) ? ` (${dollars(usd)})` : ""}`;
}

/// An address the Safe really uses that `addr` starts and ends like, and
/// what it is to the Safe: { twin, what } or null.
function twinOf(addr, h) {
  const a = addr.toLowerCase();
  const pools = [
    [h.owners.map((o) => o.toLowerCase()), "one of the Safe's owners"],
    [[...h.paid.keys()], "an address the Safe has paid"],
    [[...(h.called || [])], "a contract the Safe has used"],
    [[...h.spenders], "an address the Safe has let spend its tokens"],
  ];
  for (const [list, what] of pools) {
    const twin = list.find((x) => x !== a && looksAlike(x, a));
    if (twin) return { twin: ethers.getAddress(twin), what };
  }
  return null;
}
const lookalikeWhy = (addr, t, h) => {
  const label = h.name(t.twin);
  return `${addr} starts and ends like ${label.startsWith("0x") ? t.twin : `${label} (${t.twin})`}, ${t.what}, but it is a different address: the mark of address poisoning. Check every character before signing`;
};

/// The findings for one queued transaction: [{ level: "danger" | "warn", why }].
function judge(tx, h, { safe, minUsd = 1000 }) {
  const found = [];
  const { calls, danger } = callsOf(tx);
  if (danger) found.push({ level: "danger", why: danger });
  // A gas refund pays (gas used + baseGas) × gasPrice of gasToken to
  // refundReceiver (or whoever executes it) when the transaction runs.
  // Safe{Wallet} proposes with gasPrice 0; anything else can drain the Safe.
  if (BigInt(tx.gasPrice || 0) > 0n) {
    const token = tx.gasToken && tx.gasToken !== ethers.ZeroAddress ? ethers.getAddress(tx.gasToken) : NATIVE;
    const to = tx.refundReceiver && tx.refundReceiver !== ethers.ZeroAddress ? ethers.getAddress(tx.refundReceiver) : "whoever executes it";
    const info = tokenInfo(token, h, tx);
    // The Safe pays (gas used + baseGas) × gasPrice, so baseGas alone sets the floor.
    const least = BigInt(tx.baseGas || 0) * BigInt(tx.gasPrice);
    found.push({ level: "danger", why: `it pays a gas refund of at least ${describe(least, info)} (gasPrice ${tx.gasPrice}, baseGas ${tx.baseGas || 0}) to ${to} when it runs. Safe{Wallet} never sets this; don't sign it` });
  }
  const what = [];
  const pays = new Map();
  const moves = [];
  for (const c of calls) {
    if (c.operation === 1) found.push({ level: "danger", why: `one of its calls is a delegatecall to ${c.to}, which can move anything the Safe holds` });
    for (const m of movesOf(c)) moves.push([c, m]);
  }
  for (const [c, m] of moves) {
    if (m.kind === "call") {
      if (c.to.toLowerCase() === safe.toLowerCase()) {
        let name = null;
        try {
          name = tx.dataDecoded?.method || new ethers.Interface(["function addOwnerWithThreshold(address,uint256)", "function removeOwner(address,address,uint256)", "function swapOwner(address,address,address)", "function changeThreshold(uint256)", "function enableModule(address)", "function disableModule(address,address)", "function setGuard(address)", "function setFallbackHandler(address)"]).parseTransaction({ data: c.data })?.name;
        } catch {
          name = null;
        }
        if (name && CONTROL.has(name)) found.push({ level: "warn", why: `it changes who controls the Safe (${name})` });
        what.push(name ? `${name} on the Safe` : "a call to the Safe itself");
      } else {
        what.push(`a call to ${label(c.to, h)}`);
        const t = twinOf(c.to, h);
        const target = c.to.toLowerCase();
        if (t) found.push({ level: "danger", why: `it calls ${lookalikeWhy(c.to, t, h)}` });
        else if (!(h.called || new Set()).has(target) && !h.paid.has(target) && !h.spenders.has(target) && !h.tokens[c.to]) found.push({ level: "warn", why: `it calls ${c.to}, which this Safe has never used, and Rein can't read who that call pays` });
      }
      continue;
    }
    const info = tokenInfo(m.token, h, tx);
    if (m.kind === "approve") {
      what.push(`let ${label(m.payee, h)} spend ${m.raw === ethers.MaxUint256 ? `all its ${info.symbol}` : describe(m.raw, info, h)}`);
      const spender = m.payee.toLowerCase();
      const t = twinOf(m.payee, h);
      if (t) found.push({ level: "danger", why: `it lets ${m.payee} spend the Safe's ${info.symbol}, and ${lookalikeWhy(m.payee, t, h)}` });
      else if (h.fakes.has(spender)) found.push({ level: "danger", why: `it lets ${m.payee} spend the Safe's ${info.symbol}, an address that has only ever appeared in fake transfers made to look like the Safe sent them: address poisoning` });
      else if (!h.spenders.has(spender) && !h.paid.has(spender) && !(h.called || new Set()).has(spender)) found.push({ level: "warn", why: `it lets ${m.payee} spend the Safe's ${info.symbol}, and the Safe has never approved or used that address before` });
      continue;
    }
    what.push(`pay ${describe(m.raw, info, h)} to ${label(m.payee, h)}`);
    // Several calls to one payee in one batch are judged as one payment, so
    // splitting it can't slip under the dollar line.
    const k = `${m.payee.toLowerCase()}:${m.token.toLowerCase()}`;
    const p = pays.get(k) || { payee: m.payee, token: m.token, info, raw: 0n };
    p.raw += m.raw;
    pays.set(k, p);
  }
  for (const p of pays.values()) {
    const { payee, info } = p;
    const key = payee.toLowerCase();
    const amount = info.decimals != null ? Number(ethers.formatUnits(p.raw, info.decimals)) : null;
    const usd = amount != null && info.rate != null ? amount * info.rate : null;
    const shown = describe(p.raw, info, h);
    const twin = twinOf(payee, h);
    if (twin) {
      found.push({ level: "danger", why: lookalikeWhy(payee, twin, h) });
    } else if (h.fakes.has(key)) {
      found.push({ level: "danger", why: `${payee} has only ever appeared in fake transfers made to look like the Safe sent them: address poisoning` });
    } else if (!h.paid.has(key) && !(h.paidIn || new Set()).has(`${key}:${p.token.toLowerCase()}`) && (usd == null || usd >= minUsd)) {
      const tail = usd != null ? `, and this is ${dollars(usd)}` : `, and Rein can't price ${info.symbol}`;
      if (h.newShare != null && h.newShare >= 0.5) {
        // Normal for this Safe: say so, but don't raise an alert.
        found.push({ level: "info", why: `the Safe has never paid ${payee} before${tail}; it pays new addresses often (${Math.round(h.newShare * 100)}% of its payments were first payments)` });
      } else if (!h.payments) {
        found.push({ level: "warn", why: `the Safe has no payment history yet, so every payee is new${tail}. Confirm the address with the payee through another channel` });
      } else {
        found.push({ level: "warn", why: `the Safe has never paid ${payee} before${tail}. Confirm the address with the payee through another channel` });
      }
    }
    const top = h.largest[`${key}:${p.token.toLowerCase()}`];
    if (top && amount != null && amount > 3 * top && (usd == null || usd >= minUsd)) {
      found.push({ level: "warn", why: `${shown} is more than 3× the most this Safe has ever paid ${h.name(payee)} in ${info.symbol} (${money(top)})` });
    }
  }
  // First payments under the dollar line, kept so the whole queue can be
  // summed per payee: thirty payments of $990 are one $29,700 payment.
  const small = [...pays.values()].filter((p) => !h.paid.has(p.payee.toLowerCase()) && !twinOf(p.payee, h)).map((p) => {
    const amount = p.info.decimals != null ? Number(ethers.formatUnits(p.raw, p.info.decimals)) : null;
    return { payee: p.payee.toLowerCase(), usd: amount != null && p.info.rate != null ? amount * p.info.rate : null };
  });
  return { what: what.join(", then ") || "nothing Rein can read", found, small };
}

/// How a report names an address: always the address itself, with the
/// explorer's label (which its owner chose) after it.
function label(a, h) {
  const n = h.name(a);
  return n.startsWith("0x") ? a : `${a} ("${n.replace(/[<>|*_`~\[\]()@]/g, "")}")`;
}

// -- one pass ---------------------------------------------------------------------

const statePath = (safe, env) => path.join(home(env), "safes", `${safe.toLowerCase()}.json`);
function loadState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { posted: {} };
  }
}
function saveState(state, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/// Reads the queue and judges each pending transaction. Returns
/// { safe, threshold, owners, nonce, queue: [{ nonce, safeTxHash, signed, needed, what, found }], fresh }
/// where `fresh` are the flagged ones not posted before.
async function watchOnce(address, { chain = "base", api = null, safeApi: given = null, apiKey = null, safeUrl = null, fetch: fetchImpl = globalThis.fetch, env = process.env, minUsd = 1000, history = null, ethPaid = null, executed = null, remember = true, defer = false } = {}) {
  const safe = ethers.getAddress(address);
  const service = given || safeApi(chain, { url: safeUrl, apiKey, fetch: fetchImpl });
  const info = await service.info(safe);
  const nonce = Number(info.nonce || 0);
  const pending = await service.queue(safe, nonce);
  const hist = history || (await fetchHistory(safe, { chain, api, fetch: fetchImpl }));
  // Best effort: without it a usual ETH payee reads as new, which only adds a flag.
  const eth = ethPaid || (history ? [] : await fetchEthPaid(safe, { chain, api, fetch: fetchImpl }).catch(() => []));
  // Best effort too: the contracts and spenders the Safe has used, so a
  // lookalike of one is caught (the Request Finance theft approved one).
  const done = executed || (service.executed ? await service.executed(safe).catch(() => []) : []);
  const h = habits(hist, { owners: info.owners || [], ethPaid: eth, executed: done, safe });
  const queue = pending
    .filter((t) => !t.isExecuted && Number(t.nonce) >= nonce)
    .map((t) => ({
      nonce: Number(t.nonce),
      safeTxHash: t.safeTxHash,
      signed: (t.confirmations || []).length,
      needed: Number(t.confirmationsRequired || info.threshold || 0),
      proposer: t.proposer || null,
      ...judge(t, h, { safe, minUsd }),
    }));
  const owed = new Map();
  for (const q of queue) {
    for (const s of q.small || []) {
      const o = owed.get(s.payee) || { usd: 0, n: 0 };
      if (s.usd != null) o.usd += s.usd;
      o.n += 1;
      owed.set(s.payee, o);
    }
  }
  for (const q of queue) {
    for (const s of q.small || []) {
      const o = owed.get(s.payee);
      if (o.n > 1 && o.usd >= minUsd && s.usd != null && s.usd < minUsd) q.found.push({ level: "warn", why: `${o.n} transactions in the queue pay ${ethers.getAddress(s.payee)}, which the Safe has never paid, ${dollars(o.usd)} in all. Confirm the address with the payee through another channel` });
    }
  }
  for (const q of queue) delete q.small;
  // What was already posted, so each flagged transaction is posted once. A web
  // page passes remember: false and keeps nothing.
  const file = remember ? statePath(safe, env) : null;
  const state = file ? loadState(file) : { posted: {} };
  const alarms = (q) => q.found.filter((f) => f.level !== "info");
  const fresh = queue.filter((q) => alarms(q).length && state.posted[q.safeTxHash] !== alarms(q).map((f) => f.why).join("|"));
  for (const q of fresh) state.posted[q.safeTxHash] = alarms(q).map((f) => f.why).join("|");
  // Forget what has left the queue (executed or replaced).
  const live = new Set(queue.map((q) => q.safeTxHash));
  for (const k of Object.keys(state.posted)) if (!live.has(k)) delete state.posted[k];
  // With defer, the caller saves only once the alert has really been posted,
  // so a webhook that fails is tried again on the next check.
  const commit = () => file && saveState(state, file);
  if (!defer) commit();
  return { safe, chain, threshold: Number(info.threshold || 0), owners: info.owners || [], nonce, payments: h.payments, poisoning: h.ignored.length, truncated: h.truncated, queue, fresh, ...(defer ? { commit } : {}) };
}

function text(r, { only = null } = {}) {
  const L = [];
  const list = only || r.queue;
  if (!only) {
    L.push(`Safe ${r.safe} on ${CHAINS[r.chain]?.name || r.chain}: ${r.threshold} of ${r.owners.length} owners sign. Rein knows ${plural(r.payments, "payment")} it has made${r.poisoning ? `, and ignored ${plural(r.poisoning, "fake transfer")} made to look like it sent them (address poisoning)` : ""}.`);
    if (r.truncated) L.push("Rein read only the newest part of this Safe's history (a flood of fake transfers can push real payees out of it), so a usual payee may read as new.");
    if (!list.length) L.push("Nothing is waiting to be signed.");
  }
  for (const q of list) {
    const mark = q.found.some((f) => f.level === "danger") ? "DON'T SIGN YET" : q.found.some((f) => f.level === "warn") ? "Check first" : "Looks normal (this isn't a guarantee)";
    L.push(`#${q.nonce} (${q.signed} of ${q.needed} signed): ${q.what}. ${mark}${q.found.length ? ":" : "."}`);
    for (const f of q.found) L.push(`  - ${f.why}.`);
  }
  return L.join("\n");
}

function alertText(r) {
  const n = r.fresh.length;
  return [`*Rein, before you sign:* ${plural(n, "transaction")} in the queue of Safe ${short(r.safe)} need${n === 1 ? "s" : ""} a second look.`, text(r, { only: r.fresh })].join("\n");
}

/// A made-up Safe under attack, for the web page's one-click demo and
/// `rein safe --sample`: Rein's sample wallet's history, poisoned, with four
/// payments waiting to be signed.
function sampleSafe() {
  const { poisonedSampleHistory, AGENT, PAYEES, USDC } = require("./sample");
  const history = poisonedSampleHistory();
  const inf = PAYEES.inference.address;
  const fake = ethers.getAddress(`0x${inf.slice(2, 6)}${"9".repeat(32)}${inf.slice(-4)}`.toLowerCase());
  const owners = ["safe sample owner a", "safe sample owner b", "safe sample owner c"].map((l) => ethers.getAddress(ethers.dataSlice(ethers.id(l), 12)));
  const pay = (to, n) => ({ to: USDC.address, value: "0", data: ERC20.encodeFunctionData("transfer", [to, ethers.parseUnits(String(n), 6)]), operation: 0 });
  const queue = [
    { nonce: 41, safeTxHash: "0x41", confirmations: [{}], confirmationsRequired: 2, ...pay(inf, 15) },
    { nonce: 42, safeTxHash: "0x42", confirmations: [{}], confirmationsRequired: 2, ...pay(fake, 48000) },
    { nonce: 43, safeTxHash: "0x43", confirmations: [], confirmationsRequired: 2, ...pay(ethers.getAddress(ethers.dataSlice(ethers.id("safe sample: new contractor"), 12)), 6500) },
    { nonce: 44, safeTxHash: "0x44", confirmations: [], confirmationsRequired: 2, to: AGENT, value: "0", operation: 0, data: new ethers.Interface(["function addOwnerWithThreshold(address,uint256)"]).encodeFunctionData("addOwnerWithThreshold", [ethers.getAddress(ethers.dataSlice(ethers.id("safe sample: unknown owner"), 12)), 1]) },
  ];
  return { address: AGENT, chain: "base", history, safeApi: { info: async () => ({ nonce: 41, threshold: 2, owners }), queue: async () => queue } };
}

// -- command line ---------------------------------------------------------------------

const USAGE = `usage: rein safe <safe address> [--chain base|ethereum|base-sepolia] [--webhook URL] [--every 300] [--min-usd 1000] [--json]
       rein safe --sample          a made-up Safe under attack, with no network
  Reads the Safe's queued transactions and checks each payee against what the Safe has paid before.
  Flags lookalike addresses (address poisoning), first payments to new addresses over --min-usd,
  amounts far above its usual, delegatecalls and changes to owners or threshold. Holds no key.
  Reads the queue from Safe's public gateway; with SAFE_API_KEY (developer.safe.global) or --safe-api <url>
  it uses Safe's transaction service instead.
  --webhook posts each flagged transaction once to Slack, Discord or Telegram; --every keeps watching.`;

function parse(argv) {
  const o = { address: null, chain: "base", api: null, safeUrl: null, webhook: process.env.REIN_WEBHOOK || null, every: 0, minUsd: 1000, json: false, sample: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--chain") o.chain = argv[++i];
    else if (a === "--api") o.api = argv[++i];
    else if (a === "--safe-api") o.safeUrl = argv[++i];
    else if (a === "--webhook") o.webhook = argv[++i];
    else if (a === "--every") o.every = Number(argv[++i]);
    else if (a === "--min-usd") o.minUsd = Number(argv[++i]);
    else if (a === "--json") o.json = true;
    else if (a === "--sample") o.sample = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (!a.startsWith("-") && !o.address) o.address = a;
    else throw new Error(`unknown flag ${a}`);
  }
  if (!o.help && !o.address && !o.sample) throw new Error("which Safe? rein safe 0x… (or rein safe --sample to see one under attack)");
  if (o.address && !ethers.isAddress(o.address)) throw new Error(`${o.address} isn't an address`);
  if (!Number.isFinite(o.minUsd) || o.minUsd < 0) throw new Error("--min-usd takes a number of dollars");
  if (o.webhook && !/^https:\/\//.test(o.webhook)) throw new Error("--webhook must be an https URL");
  return o;
}

async function post(webhook, textBody, fetchImpl) {
  // Slack reads "text", Discord "content", Telegram's sendMessage "text" (with chat_id in the URL).
  // Slack reads <…> as links and mentions, Discord pings on @everyone: the
  // report carries text from the chain, so neither may act on it.
  const slack = textBody.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const res = await fetchImpl(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: slack, content: textBody.slice(0, 2000), allowed_mentions: { parse: [] } }) });
  if (!res.ok) throw new Error(`the webhook answered ${res.status}`);
}

async function main(argv, { log = console.log, env = process.env, fetch: fetchImpl = globalThis.fetch } = {}) {
  const o = parse(argv);
  if (o.help) {
    log(USAGE);
    return 0;
  }
  const demo = o.sample ? sampleSafe() : null;
  const run = async () => {
    const r = demo
      ? await watchOnce(demo.address, { safeApi: demo.safeApi, history: demo.history, minUsd: o.minUsd, remember: false })
      : await watchOnce(o.address, { chain: o.chain, api: o.api, safeUrl: o.safeUrl, apiKey: env.SAFE_API_KEY || null, fetch: fetchImpl, env, minUsd: o.minUsd, defer: true });
    if (demo && !o.json) log("(Rein's made-up sample Safe, not a real one.)");
    if (o.json) log(JSON.stringify(r, null, 2));
    else log(text(r));
    let posted = true;
    if (o.webhook && r.fresh.length) posted = await post(o.webhook, alertText(r), fetchImpl).then(() => true, (err) => (log(`could not post the alert: ${err.message}`), false));
    if (posted && r.commit) r.commit();
    if (!posted) r.alertFailed = true;
    return r;
  };
  if (!o.every) {
    const r = await run();
    if (r.alertFailed) return 3;
    return r.queue.some((q) => q.found.some((f) => f.level === "danger")) ? 1 : 0;
  }
  log(`Watching Safe ${o.address}'s queue every ${o.every}s.`);
  for (;;) {
    await run().catch((err) => log(`could not check: ${err.message}`));
    await new Promise((res) => setTimeout(res, o.every * 1000));
  }
}

module.exports = { main, parse, watchOnce, sampleSafe, judge, habits, callsOf, unpackMultiSend, safeApi, safeGateway, text, alertText, USAGE };
