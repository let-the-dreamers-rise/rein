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
const SWAP_SELECTOR = "0x04e45aaf"; // exactInputSingle

// A small deterministic generator: the same sample on every machine.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const START = Date.UTC(2026, 6, 1, 0, 0, 0) / 1000; // 1 July 2026
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
      tx({ ts: at(11.2), to: { address: ROUTER, name: "SwapRouter02", contract: true }, input: SWAP_SELECTOR + "00".repeat(224), method: "exactInputSingle",
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

/// A fetch() that serves the sample as a Blockscout instance would, pages and
/// all, so the network half of the scanner is exercised too.
function sampleFetch({ pageSize = 50 } = {}) {
  const b = build();
  const page = (items, url) => {
    const start = Number(url.searchParams.get("items_count") || 0);
    const slice = items.slice(start, start + pageSize);
    const next = start + pageSize < items.length ? { items_count: start + pageSize } : null;
    return { items: slice, next_page_params: next };
  };
  return async (href) => {
    const url = new URL(href);
    const path = url.pathname.replace(/^\/api\/v2/, "");
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (path === `/addresses/${AGENT}`) return json(b.info);
    if (path === `/addresses/${AGENT}/transactions`) return json(page(b.transactions, url));
    if (path === `/addresses/${AGENT}/token-transfers`) return json(page(b.tokenTransfers, url));
    if (path === `/addresses/${AGENT}/token-balances`) return json(b.tokenBalances);
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

module.exports = { sampleHistory, sampleFetch, AGENT, PAYEES, USDC, WETH, ROUTER, POOL };
