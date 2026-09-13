// The guardian's half of Rein v2. The compiler marks learned habits as
// monitor-only because the contract cannot enforce time of day or per-payee
// amounts. This module evaluates those habits against a decoded call the way
// the compiler evaluated the trail, so a guardian key (which can stop the
// agent and can never spend) has something concrete to watch.
//
//   const monitor = require("./client/monitor");
//   const broken = monitor.flags(policy, { ts, kind: "transfer", token: "USDT", payee: "Supplier B", amount: 300 });
//   if (broken.length) await account.connect(guardian).tripBreaker(agent, reason);
//
// The bands below mirror v2/compile.py exactly. If they drift, the guardian
// reads the world differently from the compiler and the sentences stop
// meaning what they say; test/monitor.test.js pins the boundaries.
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function bandHour(ts) {
  const h = new Date(ts * 1000).getUTCHours();
  return h < 6 ? "night" : h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

function bandDay(ts) {
  const d = new Date(ts * 1000).getUTCDate();
  return d <= 3 ? "start of the month" : d <= 15 ? "first half of the month" : "second half of the month";
}

function weekday(ts) {
  return WEEKDAYS[new Date(ts * 1000).getUTCDay()];
}

function bandAmount(a) {
  return a < 100 ? "under 100" : a < 500 ? "100 to 500" : a < 2000 ? "500 to 2,000" : "2,000 and over";
}

// What the compiler observed about a call: the same vocabulary, so a learned
// sentence can be checked against a live call with plain equality.
function observe(call) {
  return {
    hour: bandHour(call.ts),
    day: bandDay(call.ts),
    weekday: weekday(call.ts),
    token: call.token || "-",
    amount: bandAmount(Number(call.amount)),
    payee: call.payee,
  };
}

// A sentence fires when every condition holds. `self` is the compiler's pin:
// "pay" for payee rules (always holds on a payment), the payee's name for
// amount rules. A fired sentence is broken when the outcome differs.
function flags(policy, call) {
  if (call.kind !== "transfer" && call.kind !== "transferFrom") return [];
  const obs = observe(call);
  const out = [];
  for (const s of policy.sentences || []) {
    if (s.kind !== "learned" || !s.rule) continue;
    const fires = s.rule.conditions.every(([name, value]) =>
      name === "self" ? (s.rule.predicts === "payee" ? true : obs.payee === value) : obs[name] === value
    );
    if (!fires) continue;
    const actual = s.rule.predicts === "payee" ? obs.payee : obs.amount;
    if (actual !== s.rule.outcome) out.push({ sentence: s.text, expected: s.rule.outcome, actual });
  }
  return out;
}

module.exports = { bandHour, bandDay, weekday, bandAmount, observe, flags };
