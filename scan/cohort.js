// Cohort limits: a starting point for wallets too new to learn from.
//
// A platform's new agent wallet has no history, so it has nothing of its own
// to learn from. Its siblings do. The cohort template keeps what most of the
// platform's established wallets share: the contracts and payees at least half
// of them use, and the median of their hourly and daily ceilings. A new wallet
// starts there, and `rein guard` replaces it with the wallet's own limits once
// it has enough history.
const { ethers } = require("ethers");
const { money } = require("./index");

const median = (xs) => {
  const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/// What at least `share` of the guards have in `pick(guard)`, and at least two.
function common(guards, pick, share) {
  const count = new Map();
  for (const g of guards) for (const x of new Set(pick(g))) count.set(x, (count.get(x) || 0) + 1);
  const need = Math.max(2, Math.ceil(guards.length * share));
  return [...count].filter(([, n]) => n >= need).map(([x]) => x).sort();
}

/// A template from learned guards (as `learn` returns them). Needs three.
function cohortFrom(guards, { share = 0.5 } = {}) {
  if (guards.length < 3) throw new Error(`a cohort needs at least 3 wallets with history to learn from; got ${guards.length}`);
  const targets = common(guards, (g) => g.policy.targets, share);
  const selectors = {};
  for (const t of targets) {
    const s = common(guards.filter((g) => g.policy.targets.includes(t)), (g) => g.policy.selectors[t] || [], share);
    if (s.length) selectors[t] = s;
  }
  const transferPayees = common(guards, (g) => g.policy.transferPayees, share);
  const spenders = common(guards, (g) => g.policy.spenders, share);
  const tokens = {};
  const meta = {};
  for (const t of common(guards, (g) => Object.keys(g.policy.tokens), share)) {
    const tps = guards.map((g) => g.policy.tokens[t]).filter(Boolean);
    tokens[t] = {
      windowSeconds: 3600,
      maxPerWindow: median(tps.map((x) => x.maxPerWindow)),
      maxApproval: median(tps.map((x) => x.maxApproval)) ?? 0,
      maxPerDay: median(tps.map((x) => x.maxPerDay)),
    };
    meta[t] = guards.map((g) => g.tokens[t]).find(Boolean) || { symbol: null, decimals: 18 };
  }
  const agents = guards.map((g) => g.policy.agent);
  return {
    kind: "rein-cohort",
    version: 1,
    learnedFrom: guards.length,
    policy: {
      agent: {
        windowSeconds: 3600,
        maxCallsPerWindow: Math.max(1, Math.round(median(agents.map((a) => a.maxCallsPerWindow)))),
        maxNativePerCall: median(agents.map((a) => a.maxNativePerCall)) ?? 0,
        maxNativePerWindow: median(agents.map((a) => a.maxNativePerWindow)) ?? 0,
        expiry: 0,
      },
      targets,
      selectors,
      transferPayees,
      spenders,
      payees: [...new Set([...transferPayees, ...spenders])].sort(),
      tokens,
    },
    tokens: meta,
  };
}

/// A guard for `wallet` that starts from the cohort's limits.
function guardFromCohort(cohort, wallet, { chain = "base", chainId = null, version = 2 } = {}) {
  if (cohort.kind !== "rein-cohort") throw new Error("that file is not a Rein cohort (rein fleet --out writes one)");
  const p = JSON.parse(JSON.stringify(cohort.policy));
  const sym = (t) => cohort.tokens[t]?.symbol || t;
  const sentences = [
    `Starts from the limits ${cohort.learnedFrom} sibling wallets share, until this wallet has history of its own`,
    p.transferPayees.length ? `Pays only ${p.transferPayees.length} address${p.transferPayees.length === 1 ? "" : "es"} most of them pay` : "Pays nobody without a person's approval",
    ...Object.entries(p.tokens).map(([t, tp]) => `${sym(t)}: at most ${money(tp.maxPerWindow)} an hour and ${money(tp.maxPerDay)} a day`),
    `At most ${p.agent.maxCallsPerWindow} calls an hour`,
  ];
  return {
    version,
    wallet: ethers.getAddress(wallet),
    chain,
    chainId,
    learnedAt: new Date().toISOString(),
    learnedFrom: { calls: 0, cohort: cohort.learnedFrom },
    fromCohort: true,
    policy: p,
    sentences,
    withheld: [],
    tokens: cohort.tokens,
    ledger: [],
    pending: [],
    holds: [],
    newPayeeCap: 0,
    webhook: null,
  };
}

module.exports = { cohortFrom, guardFromCohort, median };
