// Replay a wallet's calls through a compiled policy with the contract's own
// rules, off chain, to say how much of its honest work the policy would have
// allowed.
//
// The order of checks and the window arithmetic follow ReinAccountV3
// (_checkScopeAndNative, _checkTokenMove, _readWindow/_commitWindow): windows
// are tumbling, starting at the first charge after the last one lapsed, and a
// refused call charges nothing. Two things are deliberately not checked:
//
//   - the intent hash, because a public wallet's history carries no
//     instructions; an agent integrated with Rein would supply one;
//   - the guardian breaker, because nothing trips it in a replay.
//
// A row marked `derived` (value that left as a side effect of another call,
// like a router pulling tokens) is not a call: it is charged to its token's
// window the way v3's balance meter charges it, and refused with
// OUTFLOW_EXCEEDED if the window cannot take it.
const NATIVE = "native";

function evaluate(policy, rows) {
  const agent = policy.agent;
  const targets = new Set(policy.targets);
  const payees = new Set(policy.payees);
  const selectors = Object.fromEntries(Object.entries(policy.selectors).map(([t, s]) => [t, new Set(s)]));
  const callWindow = { start: -Infinity, spent: 0, calls: 0 };
  const tokenWindows = {};

  const read = (w, seconds, now) => (now >= w.start + seconds ? { spent: 0, calls: 0 } : w);
  const commit = (w, seconds, now, add) => {
    if (now >= w.start + seconds) Object.assign(w, { start: now, spent: add, calls: 1 });
    else Object.assign(w, { spent: w.spent + add, calls: w.calls + 1 });
  };
  const tokenPolicy = (token) => policy.tokens[token];
  const tokenWindow = (token) => (tokenWindows[token] ||= { start: -Infinity, spent: 0, calls: 0 });

  function check(r) {
    const now = r.ts;
    const amount = Number(r.amount || 0);

    if (r.derived) {
      const tp = tokenPolicy(r.token);
      if (!tp) return "OUTFLOW_EXCEEDED";
      const w = read(tokenWindow(r.token), tp.windowSeconds, now);
      if (w.spent + amount > tp.maxPerWindow) return "OUTFLOW_EXCEEDED";
      commit(tokenWindow(r.token), tp.windowSeconds, now, amount);
      return "OK";
    }

    if (agent.expiry && now > agent.expiry) return "AGENT_EXPIRED";
    if (!targets.has(r.target)) return "TARGET_NOT_ALLOWED";
    if (!selectors[r.target] || !selectors[r.target].has(r.selector)) return "SELECTOR_NOT_ALLOWED";

    const value = r.token === NATIVE ? amount : Number(r.value || 0);
    if (value > agent.maxNativePerCall) return "NATIVE_PER_CALL";
    const cw = read(callWindow, agent.windowSeconds, now);
    if (cw.calls + 1 > agent.maxCallsPerWindow) return "CALL_RATE";
    if (cw.spent + value > agent.maxNativePerWindow) return "NATIVE_PER_WINDOW";

    const isMove = (r.kind === "transfer" || r.kind === "transferFrom") && r.token !== NATIVE;
    const isApprove = r.kind === "approve";
    if (isMove || isApprove) {
      const tp = tokenPolicy(r.token);
      if (!tp) return "TOKEN_NOT_ALLOWED";
      if (!payees.has(r.payee)) return "PAYEE_NOT_ALLOWED";
      if (isApprove) {
        if (amount > tp.maxApproval) return "APPROVAL_TOO_LARGE";
      } else {
        if (amount > tp.maxPerWindow) return "TOKEN_PER_WINDOW";
        const w = read(tokenWindow(r.token), tp.windowSeconds, now);
        if (w.spent + amount > tp.maxPerWindow) return "TOKEN_PER_WINDOW";
        commit(tokenWindow(r.token), tp.windowSeconds, now, amount);
      }
    }
    commit(callWindow, agent.windowSeconds, now, value);
    return "OK";
  }

  const results = [...rows].sort((a, b) => a.ts - b.ts).map((r) => ({ row: r, reason: check(r) }));
  const refused = results.filter((x) => x.reason !== "OK");
  const reasons = {};
  for (const x of refused) reasons[x.reason] = (reasons[x.reason] || 0) + 1;
  return { total: results.length, allowed: results.length - refused.length, refused, reasons, results };
}

module.exports = { evaluate, NATIVE };
