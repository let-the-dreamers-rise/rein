// A made-up agent wallet on Base, written out as the Blockscout API would
// return it, so the scanner can be tried and tested with no network.
//
// It is SYNTHETIC and says so in every report it produces. The token and
// router addresses are the real Base ones (USDC, WETH, Uniswap SwapRouter02)
// so the report reads like a real one; the agent and everyone it pays are
// addresses derived from fixed strings, and belong to nobody.
//
// Sixty days of an operations agent: it pays an inference API, a data vendor
// and a contractor in USDC most days, tops up WETH through Uniswap every few
// days (an approve, then a swap that pulls USDC through the router), tips a
// bounty address in ETH now and then, and once, on day 51, pays an address it
// has never paid before. One transaction reverts.
const { ethers } = require("ethers");

const USDC = { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", name: "USD Coin", decimals: 6, rate: 1.0 };
const WETH = { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", name: "Wrapped Ether", decimals: 18, rate: 3000 };
const ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";
const ETH_RATE = 3000;

const who = (label) => ethers.getAddress(ethers.dataSlice(ethers.id(`rein sample: ${label}`), 12));
const AGENT = who("agent");
const POOL = who("usdc-weth pool");
const PAYEES = {
  inference: { address: who("inference api"), name: "Inference API" },
  data: { address: who("data vendor"), name: "Data vendor" },
  contractor: { address: who("contractor"), name: null },
  bounty: { address: who("bounty"), name: null },
  stranger: { address: who("first-time payee"), name: null },
};

const ERC20 = new ethers.Interface([
  "function transfer(address to, uint256 value)",
  "function approve(address spender, uint256 value)",
]);
// SwapRouter02's exactInputSingle, sending what it buys back to the agent.
const SWAP = new ethers.Interface(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96))"]);

// A small deterministic generator: the same sample on every machine.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const START = Date.UTC(2026, 6, 1, 0, 0, 0) / 1000; // 1 July 2026
const DAY_MS = 86400 * 1000;
const DAYS = 60;

function addressParam(address, name = null, isContract = false) {
  return { hash: address, name, is_contract: isContract, is_verified: isContract, implementation_name: null, private_tags: [], public_tags: [], watchlist_names: [], reputation: "ok" };
}
const tokenInfo = (t) => ({ address_hash: t.address, symbol: t.symbol, name: t.name, decimals: String(t.decimals), type: "ERC-20", exchange_rate: String(t.rate), holders_count: "1000", total_supply: "0", reputation: "ok" });

function build() {
  const rand = rng(4471);
  const txs = [];
  const transfers = [];
  let block = 32_000_000;
  let n = 0;
  const hash = () => ethers.id(`rein sample tx ${n++}`);
  const iso = (ts) => new Date(ts * 1000).toISOString().replace(".000Z", ".000000Z");

  function tx({ ts, to, input = "0x", value = 0n, status = "ok", method = null, tokenTransfers = [] }) {
    block += 1 + Math.floor(rand() * 400);
    const h = hash();
    txs.push({
      hash: h, timestamp: iso(ts), block_number: block, status, result: status === "ok" ? "success" : "Reverted",
      from: addressParam(AGENT), to: addressParam(to.address || to, to.name || null, Boolean(to.contract)),
      value: value.toString(), raw_input: input, method, type: 2, token_transfers: null,
    });
    for (const t of tokenTransfers) {
      transfers.push({
        transaction_hash: h, timestamp: iso(ts), block_hash: ethers.id(`block ${block}`), log_index: 0, type: "token_transfer",
        from: addressParam(AGENT), to: addressParam(t.to, t.name || null, Boolean(t.contract)),
        token: tokenInfo(t.token), total: { decimals: String(t.token.decimals), value: t.raw.toString() }, method: t.method || "transfer",
      });
    }
    return h;
  }

  const pay = (ts, payee, dollars) => {
    const raw = ethers.parseUnits(dollars.toFixed(2), 6);
    tx({ ts, to: { address: USDC.address, name: "USD Coin", contract: true }, input: ERC20.encodeFunctionData("transfer", [payee.address, raw]), method: "transfer",
      tokenTransfers: [{ to: payee.address, name: payee.name, token: USDC, raw }] });
  };

  for (let d = 0; d < DAYS; d++) {
    const day = START + d * 86400;
    const at = (h) => day + Math.floor(h * 3600 + rand() * 1800);
    // Inference API: two or three bills a working day.
    if (d % 7 < 5) for (let i = 0; i < 2 + Math.floor(rand() * 2); i++) pay(at(9 + i * 3), PAYEES.inference, 20 + rand() * 60);
    // Data vendor: every other day.
    if (d % 2 === 0) pay(at(14), PAYEES.data, 40 + rand() * 40);
    // Contractor: weekly, larger.
    if (d % 7 === 4) pay(at(17), PAYEES.contractor, 400 + rand() * 250);
    // WETH top-up every four days: approve the router for the swap, then swap.
    if (d % 4 === 1) {
      const dollars = 150 + rand() * 100;
      const raw = ethers.parseUnits(dollars.toFixed(2), 6);
      tx({ ts: at(11), to: { address: USDC.address, name: "USD Coin", contract: true }, input: ERC20.encodeFunctionData("approve", [ROUTER, raw]), method: "approve" });
      tx({ ts: at(11.2), to: { address: ROUTER, name: "SwapRouter02", contract: true }, input: SWAP.encodeFunctionData("exactInputSingle", [[USDC.address, WETH.address, 500, AGENT, raw, 0, 0]]), method: "exactInputSingle",
        tokenTransfers: [{ to: POOL, name: "Uniswap V3: USDC-WETH", contract: true, token: USDC, raw, method: "exactInputSingle" }] });
    }
    // An ETH tip to the bounty address, weekly.
    if (d % 7 === 2) tx({ ts: at(19), to: PAYEES.bounty.address, value: ethers.parseEther((0.01 + rand() * 0.01).toFixed(4)) });
  }
  // Day 51: an address it has never paid before, once.
  pay(START + 51 * 86400 + 13 * 3600, PAYEES.stranger, 180);
  // Day 40: a payment that reverted and moved nothing.
  tx({ ts: START + 40 * 86400 + 10 * 3600, to: { address: USDC.address, contract: true }, input: ERC20.encodeFunctionData("transfer", [PAYEES.inference.address, 5_000_000_000n]), status: "error", method: "transfer" });

  // Newest first, as the explorer returns them.
  txs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  transfers.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return {
    info: { hash: AGENT, is_contract: false, coin_balance: ethers.parseEther("2.3").toString(), exchange_rate: String(ETH_RATE), reputation: "ok" },
    transactions: txs,
    tokenTransfers: transfers,
    tokenBalances: [
      { value: ethers.parseUnits("18500", 6).toString(), token_id: null, token: tokenInfo(USDC) },
      { value: ethers.parseUnits("1.2", 18).toString(), token_id: null, token: tokenInfo(WETH) },
    ],
  };
}

/// The history as fetchHistory() would have returned it.
function sampleHistory() {
  const b = build();
  return { chain: "base", address: AGENT, ...b, truncated: false, fetchedAt: "2026-09-01T00:00:00.000Z", synthetic: true };
}

/// The sample under an address-poisoning attack, the way one looked on a real
/// Base agent wallet on 1 Oct 2026: fake "USDC" tokens emit transfers from the
/// wallet to addresses that start and end like the ones it really pays, so a
/// careless agent (or a careless limit-learner) copies the wrong one.
function poisonedSampleHistory(n = 24) {
  const h = sampleHistory();
  const look = (a, mid) => ethers.getAddress(`0x${a.slice(2, 6)}${mid.repeat(32 / mid.length)}${a.slice(-4)}`.toLowerCase());
  const fake = (symbol, address) => ({ address_hash: address, symbol, name: symbol, decimals: "6", type: "ERC-20", exchange_rate: null, reputation: "ok" });
  const tokens = [fake("USDС", "0x4facd9f600000000000000000000000000000001"), fake("USDC", "0x08cfbc7300000000000000000000000000000002")];
  const last = Date.parse(h.transactions[0].timestamp);
  // As on the real wallet: one large payment to an address it had never paid,
  // and then the poisoners copy that address.
  const big = who("treasury it never paid before");
  const template = h.transactions.find((t) => (t.raw_input || "").startsWith("0xa9059cbb"));
  h.transactions.push({
    ...template,
    hash: ethers.id("rein sample: the big first payment"),
    timestamp: new Date(last - 9 * DAY_MS).toISOString(),
    raw_input: ERC20.encodeFunctionData("transfer", [big, ethers.parseUnits("12500", 6)]),
  });
  h.transactions.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const real = [big, PAYEES.inference.address, PAYEES.data.address];
  for (let i = 0; i < n; i++) {
    h.tokenTransfers.push({
      transaction_hash: ethers.id(`rein sample poison ${i}`),
      timestamp: new Date(last - i * 8 * 3600 * 1000).toISOString(),
      block_number: 1,
      from: { hash: AGENT },
      to: { hash: look(real[i % 3], i % 2 ? "9" : "e") },
      token: tokens[i % 2],
      total: { value: String(Math.round(40 + (i * 37) % 160) * 1e6), decimals: "6" },
    });
  }
  return h;
}

/// A fetch() that serves the sample as a Blockscout instance would, pages and
/// all, so the network half of the scanner is exercised too. `asOf`, if
/// given, is called on every request and hides anything later than the time
/// it returns, so a test can let the wallet's history grow between polls.
function sampleFetch({ pageSize = 50, asOf = null } = {}) {
  const all = build();
  const visible = () => {
    if (!asOf) return all;
    const cutoff = new Date(asOf() * 1000).toISOString();
    return { ...all, transactions: all.transactions.filter((t) => t.timestamp <= cutoff), tokenTransfers: all.tokenTransfers.filter((t) => t.timestamp <= cutoff) };
  };
  const page = (items, url) => {
    const start = Number(url.searchParams.get("items_count") || 0);
    const slice = items.slice(start, start + pageSize);
    const next = start + pageSize < items.length ? { items_count: start + pageSize } : null;
    return { items: slice, next_page_params: next };
  };
  return async (href) => {
    const url = new URL(href);
    const b = visible();
    const path = url.pathname.replace(/^\/api\/v2/, "");
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (path === `/addresses/${AGENT}`) return json(b.info);
    if (path === `/addresses/${AGENT}/transactions`) return json(page(b.transactions, url));
    if (path === `/addresses/${AGENT}/token-transfers`) return json(page(b.tokenTransfers, url));
    if (path === `/addresses/${AGENT}/token-balances`) return json(b.tokenBalances);
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

/// A fetch() that serves any histories shaped like sampleHistory()'s (the
/// fleet sample's wallets, say), keyed by address.
function historiesFetch(histories, { pageSize = 50 } = {}) {
  const by = new Map(histories.map((h) => [h.address.toLowerCase(), h]));
  return async (href) => {
    const url = new URL(href);
    const m = /^\/api\/v2\/addresses\/(0x[0-9a-fA-F]{40})(\/[a-z-]+)?$/.exec(url.pathname);
    const h = m && by.get(m[1].toLowerCase());
    if (!h) return { ok: false, status: 404, json: async () => ({}) };
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    const start = Number(url.searchParams.get("items_count") || 0);
    const page = (items) => json({ items: items.slice(start, start + pageSize), next_page_params: start + pageSize < items.length ? { items_count: start + pageSize } : null });
    if (!m[2]) return json({ ...h.info, hash: h.address });
    if (m[2] === "/transactions") return page(h.transactions);
    if (m[2] === "/token-transfers") return page(h.tokenTransfers);
    if (m[2] === "/token-balances") return json(h.tokenBalances);
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

module.exports = { sampleHistory, poisonedSampleHistory, sampleFetch, historiesFetch, AGENT, PAYEES, USDC, WETH, ROUTER, POOL, START };
