// The bounds half of v2/compile.py, in JavaScript, so a policy can be compiled
// from a wallet's history with nothing but node: no Python, no nyaya.
//
// It is a port, not a reinterpretation. Every constant, estimator and
// admission rule is the one in v2/compile.py, and test/scan.test.js runs both
// on the committed trail and fails if a single bound differs. What is left
// out is the other half -- the habits the nyaya synthesiser learns -- because
// those are monitor-only and the contract cannot enforce them anyway.
//
// One addition. A row may be marked `derived`: value that left the wallet
// without the wallet calling transfer() itself (a router pulling tokens in a
// swap, a smart wallet moving funds through its entry point). It counts toward
// what the wallet spends -- which is what ReinAccountV3 meters -- but not
// toward how many calls it makes. The v2 trail has no such rows, so the two
// compilers agree on it exactly.

const WINDOW = 3600;
const HEADROOM = 1.25;
const ROBUST_QUANTILE = 0.99;
const APPROVAL_QUANTILE = 0.95;
const MIN_CALLS_ONCHAIN = 4;
const MIN_DAYS_ONCHAIN = 3;
const DEFAULT_EXPIRY_DAYS = 90;
const OUTLIER_FACTOR = 10.0;
const TAIL_FACTOR = 3.0;
const TAIL_MIN_SAMPLES = 10;

const byTsThenValue = (a, b) => a[0] - b[0] || a[1] - b[1];
const utcDay = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

function rollingSums(points, window) {
  const pts = [...points].sort(byTsThenValue);
  const totals = [];
  let total = 0;
  let lo = 0;
  for (const [ts, value] of pts) {
    total += value;
    while (pts[lo][0] <= ts - window) {
      total -= pts[lo][1];
      lo += 1;
    }
    totals.push(total);
  }
  return totals;
}

const rollingMax = (points, window) => Math.max(0, ...rollingSums(points, window));

function quantile(values, q) {
  const xs = [...values].sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  if (xs.length === 1) return xs[0];
  const pos = q * (xs.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return xs[pos];
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

function rejectOutliers(values, factor = OUTLIER_FACTOR) {
  const positive = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (positive.length < 3) return [[...values], []];
  const limit =
    positive.length >= TAIL_MIN_SAMPLES ? quantile(positive, 0.95) * TAIL_FACTOR : quantile(positive, 0.5) * factor;
  if (limit <= 0) return [[...values], []];
  const kept = values.filter((v) => v <= limit);
  const dropped = values.filter((v) => v > limit);
  return [kept.length ? kept : [...values], dropped];
}

function count(rows, key) {
  const out = {};
  for (const r of rows) out[r[key]] = (out[r[key]] || 0) + 1;
  return out;
}

function supportBy(rows, key) {
  const calls = {};
  const days = {};
  for (const r of rows) {
    const v = r[key];
    calls[v] = (calls[v] || 0) + 1;
    (days[v] ||= new Set()).add(utcDay(r.ts));
  }
  return [calls, Object.fromEntries(Object.entries(days).map(([k, s]) => [k, s.size]))];
}

function admit(calls, days) {
  const admitted = [];
  const withheld = [];
  for (const value of Object.keys(calls).sort()) {
    if (calls[value] >= MIN_CALLS_ONCHAIN && (days[value] || 0) >= MIN_DAYS_ONCHAIN) admitted.push(value);
    else withheld.push({ name: value, calls: calls[value], days: days[value] || 0 });
  }
  return [admitted, withheld];
}

function principals(calls, paid, approvals, selectors) {
  const support = {};
  const admitted = {};
  const withheld = {};
  for (const [label, rowset, key] of [
    ["targets", calls, "target"],
    ["payees", paid, "payee"],
    ["spenders", approvals, "payee"],
  ]) {
    const [c, d] = supportBy(rowset, key);
    support[label] = Object.fromEntries(Object.keys(c).map((v) => [v, { calls: c[v], days: d[v] || 0 }]));
    [admitted[label], withheld[label]] = admit(c, d);
  }
  const selAdmitted = {};
  const selWithheld = [];
  for (const target of Object.keys(selectors)) {
    const [c, d] = supportBy(calls.filter((r) => r.target === target), "selector");
    const [keep, drop] = admit(c, d);
    if (keep.length) selAdmitted[target] = keep;
    for (const x of drop) selWithheld.push({ ...x, target });
  }
  admitted.selectors = selAdmitted;
  withheld.selectors = selWithheld;
  return { support, admitted, withheld };
}

/// What the wallet never exceeded, with headroom. `rows` are trail rows in
/// the v2/compile.py shape: { ts, target, selector, kind, token, payee, amount, value }.
function bounds(rows, { robust = true } = {}) {
  // A call is something the wallet signed; a derived row is value that left
  // it as a side effect of one. Allowlists and the call rate are about calls.
  const calls = rows.filter((r) => !r.derived);
  const moves = rows.filter((r) => r.kind === "transfer" || r.kind === "transferFrom");
  // Who a derived outflow went to (a pool, a router) is not a payee the
  // wallet chose, so it does not earn a place on the payee allowlist.
  const paid = moves.filter((r) => !r.derived);
  const approvals = rows.filter((r) => r.kind === "approve");
  const targets = count(calls, "target");
  const selectors = {};
  for (const r of calls) {
    selectors[r.target] ||= {};
    selectors[r.target][r.selector] = (selectors[r.target][r.selector] || 0) + 1;
  }
  const tokens = {};
  const outliers = {};
  for (const token of [...new Set(rows.map((r) => r.token).filter(Boolean))].sort()) {
    const tMoves = moves.filter((r) => r.token === token);
    const tAppr = approvals.filter((r) => r.token === token);
    const amounts = tMoves.map((r) => Number(r.amount));
    let apprAmounts = tAppr.map((r) => Number(r.amount));
    const hourly = rollingSums(tMoves.map((r) => [r.ts, Number(r.amount)]), WINDOW);
    const hourMax = hourly.length ? Math.max(...hourly) : 0;

    let hourStat;
    let perCall;
    let approval;
    if (robust) {
      const [hourlyKept, hourlyOut] = rejectOutliers(hourly);
      const [amountsKept, amountsOut] = rejectOutliers(amounts);
      const [apprKept, apprOut] = rejectOutliers(apprAmounts);
      outliers[token] = {
        hours: hourlyOut.length,
        payments: amountsOut.length,
        approvals: apprOut.length,
        largest_ignored: Math.max(0, ...hourlyOut, ...amountsOut, ...apprOut),
      };
      hourStat = quantile(hourlyKept, ROBUST_QUANTILE);
      perCall = quantile(amountsKept, ROBUST_QUANTILE);
      apprAmounts = apprKept;
      approval = tAppr.length >= MIN_CALLS_ONCHAIN ? Math.ceil(quantile(apprAmounts, APPROVAL_QUANTILE)) : 0;
    } else {
      hourStat = hourMax;
      perCall = Math.max(0, ...amounts);
      approval = Math.max(0, ...apprAmounts);
    }
    tokens[token] = {
      moves: tMoves.length,
      max_per_call: perCall,
      max_per_hour: hourMax,
      ceiling_per_hour: tMoves.length ? Math.ceil(hourStat * HEADROOM) : 0,
      approvals: tAppr.length,
      max_approval: approval,
    };
  }

  const callPoints = calls.map((r) => [r.ts, 1]);
  let callsPerHour;
  let nativeMax;
  if (robust) {
    callsPerHour = Math.trunc(quantile(rejectOutliers(rollingSums(callPoints, WINDOW))[0], ROBUST_QUANTILE));
    nativeMax = quantile(rejectOutliers(calls.map((r) => Number(r.value || 0)))[0], ROBUST_QUANTILE);
  } else {
    callsPerHour = Math.trunc(rollingMax(callPoints, WINDOW));
    nativeMax = Math.max(0, ...calls.map((r) => Number(r.value || 0)));
  }

  const b = {
    calls: calls.length,
    targets,
    selectors,
    payees: count(paid, "payee"),
    spenders: count(approvals, "payee"),
    tokens,
    calls_per_hour: callsPerHour,
    calls_cap: Math.ceil(callsPerHour * 1.5),
    native_max: nativeMax,
    intents: calls.filter((r) => r.intent).length,
  };
  if (robust) {
    Object.assign(b, principals(calls, paid, approvals, selectors));
    b.outliers = outliers;
  }
  return b;
}

/// The policy as Rein's contract takes it: the same shape as `onchain` in
/// v2/out/policy.json, so v2/export.js can turn it into vendor policy JSON.
function onchain(b, { robust = true, expiry = 0 } = {}) {
  let targets;
  let selectors;
  let payees;
  if (robust) {
    targets = b.admitted.targets;
    selectors = b.admitted.selectors;
    payees = [...new Set([...b.admitted.payees, ...b.admitted.spenders])].sort();
  } else {
    targets = Object.keys(b.targets).sort();
    selectors = Object.fromEntries(Object.entries(b.selectors).map(([t, s]) => [t, Object.keys(s).sort()]));
    payees = [...new Set([...Object.keys(b.payees), ...Object.keys(b.spenders)])].sort();
  }
  return {
    agent: {
      windowSeconds: WINDOW,
      maxCallsPerWindow: Math.max(1, b.calls_cap),
      maxNativePerCall: 0,
      maxNativePerWindow: 0,
      requireIntent: true,
      expiry,
    },
    targets,
    selectors,
    payees,
    tokens: Object.fromEntries(
      Object.entries(b.tokens)
        .filter(([, v]) => v.moves || v.approvals)
        .map(([t, v]) => [t, { windowSeconds: WINDOW, maxPerWindow: v.ceiling_per_hour, maxApproval: v.max_approval }])
    ),
  };
}

/// Split in time, compile from the first part, and keep the rest for
/// measuring -- the same split v2/compile.py makes.
function compileTrail(rows, { train = 0.8, robust = true, expiryDays } = {}) {
  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  const cut = Math.round(sorted.length * train);
  const trainRows = sorted.slice(0, cut);
  const heldout = sorted.slice(cut);
  const days = expiryDays ?? (robust ? DEFAULT_EXPIRY_DAYS : 0);
  const expiry = days && trainRows.length ? Math.trunc(trainRows[trainRows.length - 1].ts + days * 86400) : 0;
  const b = bounds(trainRows, { robust });
  return {
    split: { train: trainRows.length, heldout: heldout.length, cut_index: cut },
    window_seconds: WINDOW,
    headroom: HEADROOM,
    bounds: b,
    onchain: onchain(b, { robust, expiry }),
    ...(robust
      ? {
          estimator: {
            bounds: `quantile ${ROBUST_QUANTILE}`,
            approvals: `quantile ${APPROVAL_QUANTILE}`,
            min_calls: MIN_CALLS_ONCHAIN,
            min_days: MIN_DAYS_ONCHAIN,
            expiry_days: days,
          },
          withheld: b.withheld,
        }
      : {}),
    trainRows,
    heldout,
  };
}

module.exports = {
  bounds,
  onchain,
  compileTrail,
  rollingSums,
  quantile,
  rejectOutliers,
  WINDOW,
  HEADROOM,
  MIN_CALLS_ONCHAIN,
  MIN_DAYS_ONCHAIN,
};
