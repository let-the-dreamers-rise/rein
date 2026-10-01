// A wallet's public history, from a Blockscout explorer, as a Rein trail.
//
// Blockscout's API v2 is keyless and runs for Base, Base Sepolia and Ethereum
// under the same paths, so one adapter covers them. Field names follow its
// published OpenAPI spec (github.com/blockscout/blockscout-api-v2-swagger);
// where the spec and the live API have been known to disagree (a token's
// address is `address_hash` in some versions and `address` in others) both
// are read.
//
// What becomes a trail row:
//
//   every successful transaction the wallet sent -- one call each, with the
//   ERC-20 transfer/approve/transferFrom arguments decoded from raw input, a
//   plain ETH send as a move of the native coin, anything else as a call;
//
//   every ERC-20 transfer out of the wallet that no such call explains --
//   a router pulling tokens in a swap, or a smart wallet moving funds through
//   its entry point -- as a `derived` outflow: counted against what the wallet
//   spends, which is what ReinAccountV3 meters, but not as a call.
//
// Not covered, and the report says so: native coin leaving a smart wallet
// through internal transactions, and NFTs.
const { ethers } = require("ethers");
const { NATIVE } = require("./evaluate");

const CHAINS = {
  base: { name: "Base", chainId: 8453, api: "https://base.blockscout.com", explorer: "https://base.blockscout.com" },
  "base-sepolia": { name: "Base Sepolia", chainId: 84532, api: "https://base-sepolia.blockscout.com", explorer: "https://base-sepolia.blockscout.com" },
  ethereum: { name: "Ethereum", chainId: 1, api: "https://eth.blockscout.com", explorer: "https://eth.blockscout.com" },
};

const ERC20 = new ethers.Interface([
  "function transfer(address to, uint256 value)",
  "function approve(address spender, uint256 value)",
  "function transferFrom(address from, address to, uint256 value)",
  "function increaseAllowance(address spender, uint256 added)",
]);
const SELECTOR_NAMES = {
  "0xa9059cbb": "transfer",
  "0x095ea7b3": "approve",
  "0x23b872dd": "transferFrom",
  "0x39509351": "increaseAllowance",
};
const NO_CALLDATA = "(none)";

const lower = (a) => (a ? String(a).toLowerCase() : null);
const tokenAddress = (t) => ethers.getAddress(t.address_hash || t.address);
const seconds = (iso) => Math.floor(Date.parse(iso) / 1000);
const isErc20 = (t) => !t.type || t.type === "ERC-20";

// Tokens that are what their symbol says, by address. Anyone can deploy a
// token called "USDC" (or "ÚSDС"), so a symbol proves nothing.
const KNOWN_TOKENS = {
  base: [
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
    "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", // USDbC
    "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", // EURC
    "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", // USDT
    "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", // DAI
    "0x4200000000000000000000000000000000000006", // WETH
    "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", // cbBTC
  ],
  "base-sepolia": ["0x036CbD53842c5426634e7929541eC2318f3dCF7e", "0x4200000000000000000000000000000000000006"],
  ethereum: [
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
    "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
    "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
    "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c", // EURC
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
  ],
};
const PLAIN = /^[\x20-\x7E]*$/; // printable ASCII: no lookalike letters, no invisible ones

/// Why a transfer out of the wallet, in a transaction the wallet didn't
/// send, is not to be believed, or null if it can be. Address poisoning mints
/// a fake "USDC" and emits Transfer events "from" the victim to an address
/// that looks like one it pays, so the victim's history seems to show it
/// paying the attacker. A real payment the wallet signed for someone else to
/// submit (x402, a smart wallet's user operation) moves a real token.
function poisoned(t, { chain, interacted }) {
  const tok = t.token || {};
  const address = tokenAddress(tok);
  if (BigInt(t.total?.value || 0) === 0n) return "moves nothing";
  if (!PLAIN.test(tok.symbol || "") || !PLAIN.test(tok.name || "")) return `its token's name hides lookalike characters (${tok.symbol})`;
  if (tok.reputation && tok.reputation !== "ok") return `the explorer marks its token ${tok.reputation}`;
  const known = (KNOWN_TOKENS[chain] || []).some((a) => a.toLowerCase() === address.toLowerCase());
  if (known || interacted.has(address.toLowerCase()) || tok.exchange_rate != null) return null;
  return `its token (${tok.symbol || address}) is unpriced, and this wallet never called it`;
}

// -- fetching ---------------------------------------------------------------

async function getJson(url, fetchImpl, { tries = 4 } = {}) {
  for (let i = 1; ; i++) {
    const res = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (res.status === 404) return null;
    if (res.ok) return res.json();
    // Busy or rate-limited: wait and ask again, as the explorer asks.
    if ((res.status === 429 || res.status >= 500) && i < tries) {
      const after = Number(res.headers?.get?.("retry-after"));
      await new Promise((r) => setTimeout(r, Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 1000 * 2 ** (i - 1)));
      continue;
    }
    const hint =
      res.status === 403
        ? " (refused: a proxy or firewall on this network may block the explorer; --api <Blockscout URL> points Rein at another one)"
        : res.status === 429
          ? " (rate-limited: try again in a minute, or point --api at your own Blockscout)"
          : "";
    throw new Error(`${url} answered ${res.status}${hint}`);
  }
}

async function paged(base, path, query, { fetchImpl, maxPages, pause }) {
  const items = [];
  let params = null;
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ ...query, ...(params || {}) });
    const body = await getJson(`${base}/api/v2${path}?${qs}`, fetchImpl);
    if (!body) break;
    items.push(...(body.items || []));
    params = body.next_page_params;
    if (!params) return { items, truncated: false };
    if (pause) await new Promise((r) => setTimeout(r, pause));
  }
  return { items, truncated: Boolean(params) };
}

/// Everything the scanner reads about one address, as Blockscout returns it.
/// `maxPages` bounds the walk: 50 items a page, newest first.
async function fetchHistory(address, { chain = "base", api, fetch: fetchImpl = globalThis.fetch, maxPages = 20, pause = 200 } = {}) {
  const c = CHAINS[chain];
  if (!c && !api) throw new Error(`unknown chain "${chain}". Known: ${Object.keys(CHAINS).join(", ")}, or pass an explorer URL`);
  const base = (api || c.api).replace(/\/$/, "");
  const addr = ethers.getAddress(address);
  const opts = { fetchImpl, maxPages, pause };

  const info = await getJson(`${base}/api/v2/addresses/${addr}`, fetchImpl);
  if (!info) throw new Error(`the explorer has no record of ${addr} on ${c ? c.name : base}`);
  const txs = await paged(base, `/addresses/${addr}/transactions`, { filter: "from" }, opts);
  const transfers = await paged(base, `/addresses/${addr}/token-transfers`, { filter: "from", type: "ERC-20" }, opts);
  const balances = (await getJson(`${base}/api/v2/addresses/${addr}/token-balances`, fetchImpl)) || [];

  return {
    chain: c ? chain : base,
    address: addr,
    info,
    transactions: txs.items,
    tokenTransfers: transfers.items,
    tokenBalances: balances,
    truncated: txs.truncated || transfers.truncated,
    fetchedAt: new Date().toISOString(),
  };
}

// -- turning it into a trail -----------------------------------------------

function tokenBook(history) {
  const book = {};
  const add = (t) => {
    if (!t || !(t.address_hash || t.address) || !isErc20(t)) return;
    const a = tokenAddress(t);
    book[a] ||= { address: a, symbol: t.symbol || null, name: t.name || null, decimals: t.decimals != null ? Number(t.decimals) : null, rate: t.exchange_rate != null ? Number(t.exchange_rate) : null };
  };
  for (const b of history.tokenBalances) add(b.token);
  for (const t of history.tokenTransfers) add(t.token);
  for (const tx of history.transactions) for (const t of tx.token_transfers || []) add(t.token);
  return book;
}

function units(raw, decimals) {
  return Number(ethers.formatUnits(BigInt(raw), decimals ?? 18));
}

/// `payments: true` reads a token transfer the wallet authorized in someone
/// else's transaction (an x402 / EIP-3009 payment a facilitator submitted, or
/// a smart wallet's call through an entry point) as a payment it chose, with
/// its payee, rather than as a side effect. The guard wants that; the on-chain
/// policy, which only sees the wallet's own calls, does not.
function toTrail(history, { payments = false } = {}) {
  const me = lower(history.address);
  const book = tokenBook(history);
  const rows = [];
  const explained = new Set(); // tx hashes whose token outflow a decoded call already accounts for
  const unknownDecimals = new Set();
  const decimalsOf = (token) => {
    const d = book[token]?.decimals;
    if (d == null) unknownDecimals.add(token);
    return d ?? 18;
  };

  for (const tx of history.transactions) {
    if (lower(tx.from?.hash) !== me) continue;
    if (tx.status && tx.status !== "ok") continue; // a reverted call moved nothing
    if (!tx.to?.hash) continue; // contract creation
    const ts = seconds(tx.timestamp);
    const to = ethers.getAddress(tx.to.hash);
    const input = tx.raw_input || "0x";
    const value = Number(ethers.formatEther(BigInt(tx.value || 0)));
    const base = { ts, block: tx.block_number ?? tx.block ?? null, tx: tx.hash, target: to, value, intent: null };

    if (input === "0x" || input.length < 10) {
      if (value > 0) rows.push({ ...base, selector: NO_CALLDATA, kind: "transfer", token: NATIVE, payee: to, amount: value });
      else rows.push({ ...base, selector: NO_CALLDATA, kind: "call", token: null, payee: null, amount: 0 });
      continue;
    }

    const sel = input.slice(0, 10).toLowerCase();
    const known = SELECTOR_NAMES[sel];
    if (known) {
      try {
        const args = ERC20.decodeFunctionData(known, input);
        const token = to;
        if (known === "transfer") {
          rows.push({ ...base, selector: known, kind: "transfer", token, payee: ethers.getAddress(args[0]), amount: units(args[1], decimalsOf(token)) });
          explained.add(tx.hash);
        } else if (known === "transferFrom") {
          rows.push({ ...base, selector: known, kind: "transferFrom", token, payee: ethers.getAddress(args[1]), amount: units(args[2], decimalsOf(token)) });
          explained.add(tx.hash);
        } else {
          rows.push({ ...base, selector: known, kind: known, token, payee: ethers.getAddress(args[0]), amount: units(args[1], decimalsOf(token)) });
        }
        continue;
      } catch {
        // A contract with a colliding selector and different arguments: an
        // ordinary call, which is also how Rein's decoder fails (closed).
      }
    }
    rows.push({ ...base, selector: sel, kind: "call", token: null, payee: null, amount: 0, method: tx.method || null });
  }

  // The wallet's own transactions, and how far back they were read: a
  // transfer older than that may belong to a call that was never loaded.
  const own = new Set(history.transactions.filter((tx) => lower(tx.from?.hash) === me).map((tx) => tx.hash));
  const ownSince = Math.min(...history.transactions.filter((tx) => lower(tx.from?.hash) === me).map((tx) => seconds(tx.timestamp)));

  // Contracts the wallet itself has called: a token among them is one it uses.
  const interacted = new Set(history.transactions.filter((tx) => lower(tx.from?.hash) === me && tx.to?.hash).map((tx) => lower(tx.to.hash)));
  const ignored = [];
  for (const t of history.tokenTransfers) {
    if (lower(t.from?.hash) !== me || !isErc20(t.token || {})) continue;
    if (explained.has(t.transaction_hash)) continue;
    if (!own.has(t.transaction_hash)) {
      const why = poisoned(t, { chain: history.chain, interacted });
      if (why) {
        ignored.push({ tx: t.transaction_hash, token: t.token?.symbol || null, payee: t.to?.hash ? ethers.getAddress(t.to.hash) : null, when: t.timestamp || null, why });
        continue;
      }
    }
    const authorized = payments && !own.has(t.transaction_hash) && (own.size === 0 || seconds(t.timestamp) >= ownSince);
    const token = tokenAddress(t.token);
    const decimals = t.total?.decimals != null ? Number(t.total.decimals) : decimalsOf(token);
    rows.push({
      ts: seconds(t.timestamp),
      block: t.block_number ?? null,
      tx: t.transaction_hash,
      target: token,
      selector: "transfer",
      kind: "transfer",
      token,
      payee: ethers.getAddress(t.to.hash),
      amount: units(t.total?.value || 0, decimals),
      value: 0,
      intent: null,
      ...(authorized ? {} : { derived: true }),
    });
  }

  rows.sort((a, b) => a.ts - b.ts);
  return { rows, tokens: book, unknownDecimals: [...unknownDecimals], ignored };
}

/// What the wallet holds now, in each token's own units and, where the
/// explorer knows a price, in dollars. Airdropped junk (lookalike names,
/// tokens the explorer flags, unpriced tokens this wallet never used) is left
/// out and counted in `junk`, so a phishing "token" never shows as a holding.
function holdings(history) {
  const out = [];
  const me = lower(history.address);
  const used = new Set(history.transactions.filter((tx) => lower(tx.from?.hash) === me && tx.to?.hash).map((tx) => lower(tx.to.hash)));
  const coin = history.info?.coin_balance;
  if (coin != null) {
    const amount = Number(ethers.formatEther(BigInt(coin)));
    const rate = history.info.exchange_rate != null ? Number(history.info.exchange_rate) : null;
    out.push({ token: NATIVE, symbol: "ETH", amount, usd: rate != null ? amount * rate : null });
  }
  for (const b of history.tokenBalances) {
    if (!b.token || !isErc20(b.token)) continue;
    const decimals = b.token.decimals != null ? Number(b.token.decimals) : 18;
    const amount = units(b.value || 0, decimals);
    if (amount === 0) continue;
    const rate = b.token.exchange_rate != null ? Number(b.token.exchange_rate) : null;
    const address = tokenAddress(b.token);
    const known = (KNOWN_TOKENS[history.chain] || []).some((a) => a.toLowerCase() === address.toLowerCase());
    const junk = !PLAIN.test(b.token.symbol || "") || !PLAIN.test(b.token.name || "")
      || (b.token.reputation && b.token.reputation !== "ok")
      || (rate == null && !known && !used.has(address.toLowerCase()));
    if (junk) { out.junk = (out.junk || 0) + 1; continue; }
    out.push({ token: address, symbol: b.token.symbol || null, amount, usd: rate != null ? amount * rate : null });
  }
  return out;
}

module.exports = { fetchHistory, toTrail, holdings, tokenBook, poisoned, KNOWN_TOKENS, CHAINS, NO_CALLDATA, SELECTOR_NAMES, ERC20 };
