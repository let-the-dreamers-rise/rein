// The wallet scanner: paste an agent's address, get the spending policy its
// own history supports, what one injected instruction could move today, what
// it could move under that policy, and how much of its honest work the policy
// would have refused.
//
// The pipeline is v2's, pointed at a public wallet instead of a simulated one:
//
//   history (Blockscout)  ->  trail  ->  compile (first 80%, robust)
//                                    ->  replay the last 20% through it
//                                    ->  exposure, before and after
//                                    ->  Turnkey / Coinbase CDP / Privy JSON
//
// Nothing here signs, deploys or spends. It reads public chain data.
const { ethers } = require("ethers");
const { compileTrail, HEADROOM } = require("./compile");
const { evaluate, NATIVE } = require("./evaluate");
const { fetchHistory, toTrail, holdings, CHAINS, NO_CALLDATA } = require("./blockscout");
const exporter = require("../v2/export");

const DAY = 86400;
const THIN_CALLS = 20;

const round = (x, dp = 2) => (x == null ? null : Math.round(x * 10 ** dp) / 10 ** dp);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

function money(x) {
  if (x == null) return "?";
  if (Math.abs(x) >= 1e15) return x.toExponential(2);
  return x.toLocaleString("en-US", { maximumFractionDigits: Math.abs(x) < 1 ? 6 : 2 });
}

/// The contract holds native value as agent-level caps, not a token policy;
/// the compiler sees ETH sends as moves of a token called "native" so it can
/// bound them, and this moves that bound to where the contract keeps it.
function nativeToAgent(onchain) {
  const policy = JSON.parse(JSON.stringify(onchain));
  const n = policy.tokens[NATIVE];
  if (n) {
    policy.agent.maxNativePerWindow = n.maxPerWindow;
    policy.agent.maxNativePerCall = n.maxPerWindow;
    delete policy.tokens[NATIVE];
  }
  return policy;
}

function labelFor(address, labels, tokens) {
  if (address === NATIVE) return "ETH";
  const t = tokens[address];
  if (t?.symbol) return t.symbol;
  return labels[address] || `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function collectLabels(history) {
  const labels = {};
  const note = (p) => {
    if (!p?.hash) return;
    const name = p.ens_domain_name || p.name || p.metadata?.tags?.[0]?.name || null;
    if (name) labels[p.hash.toLowerCase()] = name;
  };
  for (const tx of history.transactions) note(tx.to);
  for (const t of history.tokenTransfers) note(t.to);
  const out = {};
  for (const [k, v] of Object.entries(labels)) out[ethers.getAddress(k)] = v;
  return out;
}

function unscale(compiled, scale) {
  for (const [token, t] of Object.entries(compiled.bounds.tokens)) {
    const k = scale(token);
    for (const f of ["max_per_call", "max_per_hour", "ceiling_per_hour", "max_approval"]) t[f] /= k;
  }
  for (const [token, t] of Object.entries(compiled.onchain.tokens)) {
    const k = scale(token);
    t.maxPerWindow /= k;
    t.maxApproval /= k;
  }
}

/// Everything below works on a history already fetched, so it is the same
/// code whether the history came from the network or from a saved file.
function scanHistory(history, { robust = true, train = 0.8 } = {}) {
  const { rows, tokens, unknownDecimals } = toTrail(history);
  const labels = collectLabels(history);
  const name = (a) => labelFor(a, labels, tokens);
  const held = holdings(history);
  const priced = held.filter((h) => h.usd != null);
  const chain = CHAINS[history.chain];
  const report = {
    address: history.address,
    chain: chain ? chain.name : history.chain,
    explorer: chain ? `${chain.explorer}/address/${history.address}` : null,
    scannedAt: history.fetchedAt,
    isContract: Boolean(history.info?.is_contract),
    history: {
      calls: rows.filter((r) => !r.derived).length,
      derivedOutflows: rows.filter((r) => r.derived).length,
      from: rows.length ? new Date(rows[0].ts * 1000).toISOString() : null,
      to: rows.length ? new Date(rows[rows.length - 1].ts * 1000).toISOString() : null,
      days: new Set(rows.map((r) => new Date(r.ts * 1000).toISOString().slice(0, 10))).size,
      truncated: Boolean(history.truncated),
    },
    holdings: held.map((h) => ({ ...h, symbol: h.symbol || name(h.token) })),
    synthetic: Boolean(history.synthetic),
    caveats: history.synthetic
      ? ["SYNTHETIC: this is Rein's made-up sample wallet (scan/sample.js), not a real one. Every number below describes that sample."]
      : [],
  };

  // -- today: nothing on chain stands between the key and the balance -------
  //
  // Said as what the chain shows, not as what will happen. A wallet whose key
  // lives in Privy, Turnkey or Coinbase CDP may have a signing policy in front
  // of it that no explorer can see, and a report that claims otherwise is the
  // report its first reader dismisses.
  report.exposureToday = {
    to: "no on-chain limit",
    usd: priced.length ? round(sum(priced.map((h) => h.usd))) : null,
    unpriced: held.filter((h) => h.usd == null).map((h) => h.symbol || name(h.token)),
    sentence:
      "Nothing on chain limits where this wallet's holdings can go. If the agent acts on one injected instruction, every token it holds can be sent to any address, one transaction each, unless a signing policy kept off chain refuses it.",
  };
  report.caveats.push("A signing policy held off chain (Privy, Turnkey, CDP) is invisible to this scan.");

  if (rows.length < 2) {
    report.verdict = "not enough history to compile a policy from";
    report.caveats.push(`Found ${rows.length} outgoing call(s). A policy needs the wallet's habits, and there are none to read yet.`);
    return report;
  }

  // -- compile from the past, measure on the recent -------------------------
  // The compiler rounds every ceiling up to a whole unit, which is right for
  // the dollar stablecoins it was written for and absurd for ETH, where one
  // whole unit is thousands of dollars. So it works in millionths of each
  // token, and the results come back in whole tokens.
  const scale = (token) => (token ? 10 ** Math.min(6, token === NATIVE ? 18 : tokens[token]?.decimals ?? 18) : 1);
  const scaled = rows.map((r) => ({ ...r, amount: Number(r.amount || 0) * scale(r.token), orig: r }));
  const compiled = compileTrail(scaled, { robust, train });
  const coverage = evaluate(nativeToAgent(compiled.onchain), compiled.heldout);
  for (const x of coverage.refused) x.row = x.row.orig;
  unscale(compiled, scale);
  const policy = nativeToAgent(compiled.onchain);
  report.policy = {
    estimator: robust ? "robust: 99th percentile after outliers, allowlists need 4+ calls across 3+ days" : "maximum observed",
    compiledFrom: compiled.split.train,
    heldOut: compiled.split.heldout,
    onchain: policy,
    sentences: sentences(compiled.bounds, policy, name),
    withheld: robust ? withheldLines(compiled.withheld, name) : [],
  };
  report.coverage = {
    allowed: coverage.allowed,
    total: coverage.total,
    reasons: coverage.reasons,
    refusedExamples: coverage.refused.slice(0, 5).map((x) => ({
      when: new Date(x.row.ts * 1000).toISOString(),
      what: describe(x.row, name),
      reason: x.reason,
      tx: x.row.tx,
    })),
  };

  // -- under the policy: bounded by the ceilings, capped by the balance -----
  const perToken = [];
  for (const h of held) {
    const ceiling = h.token === NATIVE ? policy.agent.maxNativePerWindow : policy.tokens[h.token]?.maxPerWindow || 0;
    const perHour = Math.min(h.amount, ceiling);
    const perDay = Math.min(h.amount, ceiling * 24);
    const rate = h.amount ? (h.usd ?? null) / h.amount : null;
    perToken.push({
      symbol: h.symbol || name(h.token),
      held: h.amount,
      perHour,
      perDay,
      usdPerHour: rate != null ? round(perHour * rate) : null,
      usdPerDay: rate != null ? round(perDay * rate) : null,
    });
  }
  const payees = policy.payees.length;
  report.exposureUnderPolicy = {
    to: payees ? `only the ${payees} address${payees === 1 ? "" : "es"} the wallet already pays` : "nobody: no payee has enough history to be admitted",
    usdPerHour: perToken.some((t) => t.usdPerHour != null) ? round(sum(perToken.map((t) => t.usdPerHour || 0))) : null,
    usdPerDay: perToken.some((t) => t.usdPerDay != null) ? round(sum(perToken.map((t) => t.usdPerDay || 0))) : null,
    tokens: perToken,
    sentence:
      "Under the compiled policy the same instruction is refused unless it pays someone the wallet already pays, inside a ceiling its own busiest hours set. " +
      "An attacker who can steer payments to an allowed payee still gets the ceiling, every hour, until someone notices.",
  };

  // -- caveats: said once, plainly ---------------------------------------------
  if (report.history.calls < THIN_CALLS || report.history.days < 3) {
    report.caveats.push(`Thin history: ${report.history.calls} calls over ${report.history.days} day(s). The policy is only as good as the habits it was learned from.`);
  }
  if (report.history.truncated) report.caveats.push("History was cut off at the page limit; the oldest calls were not read.");
  if (report.isContract) {
    report.caveats.push("This is a contract wallet. Calls it makes through an entry point or a module do not appear as its own transactions, so its policy is drawn from what left it rather than what it called.");
  }
  if (unknownDecimals.length) report.caveats.push(`Decimals unknown for ${unknownDecimals.length} token(s); 18 assumed.`);
  report.caveats.push("Intent hashes are not checked: a public history carries no instructions. An agent running on Rein supplies one per call.");
  report.caveats.push("Native coin leaving a contract wallet through internal transactions, and NFTs, are not read.");

  report.verdict =
    `${report.exposureToday.usd != null ? `$${money(report.exposureToday.usd)}` : "Everything it holds"} has no on-chain limit on where it can go. ` +
    `Under a policy compiled from its own history: ${report.exposureUnderPolicy.usdPerHour != null ? `$${money(report.exposureUnderPolicy.usdPerHour)} an hour` : "the ceilings below"}, ${report.exposureUnderPolicy.to}, ` +
    `and ${coverage.allowed} of its ${coverage.total} most recent calls would still have gone through.`;

  report.trail = rows;
  report.tokens = tokens;
  report.compiled = { bounds: compiled.bounds, split: compiled.split, onchain: policy };
  return report;
}

function describe(r, name) {
  if (r.kind === "call") return `call ${r.method || r.selector} on ${name(r.target)}`;
  const verb = r.derived ? "outflow of" : r.kind === "approve" ? "approve" : "pay";
  return `${verb} ${money(r.amount)} ${name(r.token)} ${r.kind === "approve" ? "for" : "to"} ${name(r.payee)}`;
}

function sentences(b, policy, name) {
  const out = [];
  if (policy.targets.length) out.push(`Calls only ${policy.targets.map(name).join(", ")}`);
  if (policy.payees.length) out.push(`Pays or approves only ${policy.payees.map(name).join(", ")}`);
  for (const [token, tp] of Object.entries(policy.tokens)) {
    const t = b.tokens[token];
    out.push(
      `${name(token)}: at most ${money(tp.maxPerWindow)} an hour (busiest hour seen ${money(t.max_per_hour)}, ${Math.round((HEADROOM - 1) * 100)}% headroom); approvals up to ${money(tp.maxApproval)}`
    );
  }
  if (policy.agent.maxNativePerWindow) out.push(`ETH: at most ${money(policy.agent.maxNativePerWindow)} an hour`);
  else out.push("Sends no ETH");
  out.push(`At most ${policy.agent.maxCallsPerWindow} calls an hour`);
  if (policy.agent.expiry) out.push(`Lapses on ${new Date(policy.agent.expiry * 1000).toISOString().slice(0, 10)}, so somebody looks at it again`);
  return out;
}

function withheldLines(withheld, name) {
  const out = [];
  for (const [kind, items] of Object.entries(withheld || {})) {
    for (const i of items) {
      const what = i.target ? `${i.name} on ${name(i.target)}` : name(i.name);
      out.push({ kind, what, calls: i.calls, days: i.days });
    }
  }
  return out;
}

/// The policy in the JSON each wallet engine takes. Shapes as in v2/export.js,
/// with the same caveat: schema-shaped, not yet run against the vendors' APIs.
function exportPolicy(report) {
  if (!report.compiled) return null;
  // A plain ETH send has no function to allowlist; the vendor engines bound
  // it by value, which the native ceiling in the agent policy already says.
  const src = report.compiled.onchain;
  const selectors = Object.fromEntries(
    Object.entries(src.selectors)
      .map(([t, s]) => [t, s.filter((x) => x !== NO_CALLDATA)])
      .filter(([, s]) => s.length)
  );
  const oc = { ...src, selectors, targets: src.targets.filter((t) => selectors[t]) };
  // The vendors take native value in wei.
  const wei = (eth) => ethers.parseEther(eth.toFixed(9)).toString();
  oc.agent = { ...src.agent, maxNativePerCall: wei(src.agent.maxNativePerCall), maxNativePerWindow: wei(src.agent.maxNativePerWindow) };
  const plain = (n) => (Number.isInteger(n) ? BigInt(n).toString() : n.toFixed(6).replace(/\.?0+$/, ""));
  const policy = {
    onchain: {
      ...oc,
      tokens: Object.fromEntries(
        Object.entries(oc.tokens).map(([t, v]) => [t, { ...v, maxPerWindow: plain(v.maxPerWindow), maxApproval: plain(v.maxApproval) }])
      ),
    },
  };
  const map = {};
  for (const [address, t] of Object.entries(report.tokens)) map[address] = { address, decimals: t.decimals ?? 18 };
  for (const a of [...oc.targets, ...oc.payees]) map[a] ||= { address: a };
  const f = exporter.facts(policy, map);
  return {
    turnkey: exporter.turnkey(f, "approvers.any(user, user.id == '<AGENT_USER_ID>')"),
    coinbase: exporter.coinbase(f),
    privy: exporter.privy(f),
  };
}

async function scan(address, opts = {}) {
  const history = await fetchHistory(address, opts);
  return scanHistory(history, opts);
}

function markdown(r) {
  const L = [];
  L.push(`# Rein wallet report: ${r.address}${r.synthetic ? " (synthetic sample)" : ""}`, "");
  L.push(`${r.chain}${r.isContract ? ", contract wallet" : ""}. ${r.history.calls} calls and ${r.history.derivedOutflows} other outflows over ${r.history.days} day(s), ${r.history.from?.slice(0, 10) ?? "?"} to ${r.history.to?.slice(0, 10) ?? "?"}.`, "");
  L.push(`**${r.verdict}**`, "");
  L.push("## Today: no on-chain limit", "", r.exposureToday.sentence, "");
  L.push("| holds | amount | USD |", "|---|---:|---:|");
  for (const h of r.holdings) L.push(`| ${h.symbol} | ${money(h.amount)} | ${h.usd != null ? money(round(h.usd)) : "?"} |`);
  if (!r.policy) {
    L.push("", ...r.caveats.map((c) => `- ${c}`), "");
    return L.join("\n");
  }
  L.push("", "## Under the policy its own history supports", "", r.exposureUnderPolicy.sentence, "");
  L.push("| token | per hour | per day | USD per hour |", "|---|---:|---:|---:|");
  for (const t of r.exposureUnderPolicy.tokens) L.push(`| ${t.symbol} | ${money(t.perHour)} | ${money(t.perDay)} | ${t.usdPerHour != null ? money(t.usdPerHour) : "?"} |`);
  L.push("", `Recipients: ${r.exposureUnderPolicy.to}.`, "");
  L.push("## The policy", "", `Compiled from the first ${r.policy.compiledFrom} calls (${r.policy.estimator}).`, "");
  for (const s of r.policy.sentences) L.push(`- ${s}`);
  if (r.policy.withheld.length) {
    L.push("", "### Seen, but not admitted without a human", "", "| what | kind | calls | days |", "|---|---|---:|---:|");
    for (const w of r.policy.withheld) L.push(`| ${w.what} | ${w.kind} | ${w.calls} | ${w.days} |`);
  }
  L.push("", "## Would it have got in the way?", "");
  L.push(`Replayed the ${r.coverage.total} most recent calls, which the compiler never saw, through the policy with the contract's own rules: **${r.coverage.allowed} of ${r.coverage.total} allowed**.`);
  if (r.coverage.refusedExamples.length) {
    L.push("", "| when | what | refused with |", "|---|---|---|");
    for (const x of r.coverage.refusedExamples) L.push(`| ${x.when.slice(0, 16).replace("T", " ")} | ${x.what} | ${x.reason} |`);
  }
  L.push("", "## What this does not say", "", ...r.caveats.map((c) => `- ${c}`), "");
  L.push("Generated by `rein-scan` from public chain data. Nothing was signed or sent. github.com/let-the-dreamers-rise/rein", "");
  return L.join("\n");
}

/// The report without the bulky parts, for an MCP tool result or an API body.
function summary(r) {
  const { trail, tokens, compiled, ...rest } = r;
  void trail;
  void tokens;
  void compiled;
  return rest;
}

module.exports = { scan, scanHistory, exportPolicy, markdown, summary, CHAINS };
