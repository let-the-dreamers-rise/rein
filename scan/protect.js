// Rein in one line, for an agent that signs with viem (and so for Coinbase
// AgentKit, GOAT and ElizaOS, which all hand a viem wallet client around):
//
//   const { protect } = require("rein-wallet");
//   const wallet = protect(createWalletClient({ account, chain: base, transport: http() }));
//
// Every sendTransaction, writeContract, signTransaction and signTypedData is
// checked before it is signed. A payment outside the agent's habits throws a
// ReinHeld error that says why, with the id a person approves it with:
//   npx rein-wallet guard 0xAgent --allow <id>
// Everything else on the client passes straight through.
//
// The first call sets the guard up, once:
//   - a wallet with 20 or more transactions of its own gets limits learned
//     from its history, as `rein guard` would;
//   - a newer one starts in learning mode: small payments in stablecoins go
//     through and the addresses they go to become trusted; anything bigger,
//     any other token, and any address that only looks like one it has paid
//     waits for a person. Run `npx rein-wallet guard 0xAgent` once it has more
//     history, and its own limits replace the starter ones.
const { ethers } = require("ethers");
const { fetchHistory, toTrail, CHAINS } = require("./blockscout");
const guardLib = require("./guard");

// Stablecoins a starter guard knows, by chain: address, symbol, decimals.
const STABLES = {
  base: [
    ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USDC", 6],
    ["0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", "USDbC", 6],
    ["0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", "USDT", 6],
    ["0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", "EURC", 6],
    ["0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", "DAI", 18],
  ],
  "base-sepolia": [["0x036CbD53842c5426634e7929541eC2318f3dCF7e", "USDC", 6]],
  ethereum: [
    ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "USDC", 6],
    ["0xdAC17F958D2ee523a2206206994597C13D831ec7", "USDT", 6],
    ["0x6B175474E89094C44Da98b954EedeAC495271d0F", "DAI", 18],
  ],
};

const CHAIN_BY_ID = Object.fromEntries(Object.entries(CHAINS).map(([k, c]) => [c.chainId, k]));

class ReinHeld extends Error {
  constructor(verdict) {
    super(`Rein held this ${verdict.amount != null ? `payment of ${verdict.amount} ${verdict.token}` : "transaction"}: ${verdict.explanation}${verdict.held ? `. A person can let it through once with: npx rein-wallet guard ${verdict.wallet} --allow ${verdict.held}` : ""}`);
    this.name = "ReinHeld";
    this.verdict = verdict;
    this.reason = verdict.reason;
    this.held = verdict.held || null;
  }
}

/// The guard a wallet with too little history starts from. Amounts are in
/// each stablecoin's own units, so roughly dollars.
function starterGuard(wallet, { chain = "base", perPayment = 25, perHour = 100, perDay = 250, paid = [] } = {}) {
  const stables = STABLES[chain] || [];
  const addresses = stables.map(([a]) => ethers.getAddress(a));
  return {
    version: 2,
    wallet: ethers.getAddress(wallet),
    chain,
    chainId: CHAINS[chain]?.chainId ?? null,
    learnedAt: new Date().toISOString(),
    learnedFrom: { calls: 0, starter: true },
    learning: true,
    policy: {
      agent: { windowSeconds: 3600, maxCallsPerWindow: 10, maxNativePerCall: 0, maxNativePerWindow: 0, expiry: 0 },
      targets: addresses,
      selectors: Object.fromEntries(addresses.map((a) => [a, ["transfer"]])),
      payees: [],
      transferPayees: [],
      spenders: [],
      tokens: Object.fromEntries(addresses.map((a) => [a, { windowSeconds: 3600, maxPerWindow: perHour, maxApproval: 0, maxPerDay: perDay }])),
    },
    paid,
    sentences: [
      `Learning: payments of up to ${perPayment} in ${stables.map((s) => s[1]).join(", ") || "stablecoins"} go through, and the addresses they go to become trusted`,
      `At most ${perHour} an hour and ${perDay} a day in each`,
      "Anything bigger, any other token or contract, and any address that only looks like one it has paid waits for a person",
    ],
    withheld: [],
    tokens: Object.fromEntries(stables.map(([a, symbol, decimals]) => [ethers.getAddress(a), { symbol, decimals }])),
    ledger: [],
    pending: [],
    holds: [],
    newPayeeCap: perPayment,
    webhook: null,
  };
}

/// Makes sure `wallet` has a guard on this machine, learning one from its
/// history if it has enough, or starting it in learning mode. Returns where
/// it is saved and how it was made.
async function ensureGuard(wallet, { chain = "base", api, env = process.env, fetch: fetchImpl = globalThis.fetch, starter = {} } = {}) {
  const file = guardLib.guardPath(wallet, env);
  try {
    guardLib.loadGuard(file, env);
    return { file, made: "existing" };
  } catch {
    // none yet, or one from an older version: make it below
  }
  let history = null;
  try {
    history = await fetchHistory(wallet, { chain, api, fetch: fetchImpl });
  } catch {
    // offline or rate-limited: a starter guard needs no history
  }
  if (history) {
    try {
      const { guard } = guardLib.learn(history);
      guardLib.saveGuard({ ...guard, newPayeeCap: starter.perPayment ?? 0 }, file);
      return { file, made: "learned" };
    } catch {
      // too few calls of its own: start it learning, remembering who it has paid
    }
  }
  const paid = history ? [...new Set(toTrail(history, { payments: true }).rows.filter((r) => !r.derived && r.payee && r.kind !== "approve").map((r) => r.payee))] : [];
  guardLib.saveGuard(starterGuard(wallet, { chain, paid, ...starter }), file);
  return { file, made: "starter" };
}

/// What the client is about to sign, as check() reads it.
function toCheck(method, args) {
  const a = args[0] || {};
  if (method === "signTypedData") return { domain: a.domain, types: a.types, primaryType: a.primaryType, message: a.message };
  if (method === "writeContract") {
    const data = new ethers.Interface(a.abi).encodeFunctionData(a.functionName, a.args || []);
    return { to: a.address, data, value: String(a.value ?? 0) };
  }
  return { to: a.to, data: a.data || "0x", value: String(a.value ?? 0) };
}

const CHECKED = new Set(["sendTransaction", "writeContract", "signTransaction", "signTypedData"]);

/// Wraps a viem wallet client so nothing leaves it unchecked.
function protect(client, opts = {}) {
  const wallet = opts.wallet || client?.account?.address;
  if (!wallet) throw new Error("protect needs a wallet client with an account (or { wallet: 0x… })");
  const chain = opts.chain || CHAIN_BY_ID[client?.chain?.id] || "base";
  let ready = null;
  const setup = () => (ready ||= ensureGuard(wallet, { ...opts, chain }));
  return new Proxy(client, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (!CHECKED.has(prop) || typeof orig !== "function") return orig;
      return async (...args) => {
        await setup();
        const v = guardLib.check(toCheck(prop, args), { wallet, env: opts.env, now: opts.now });
        if (!v.allow) throw new ReinHeld(v);
        return orig.apply(target, args);
      };
    },
  });
}

module.exports = { protect, ensureGuard, starterGuard, ReinHeld, STABLES };
