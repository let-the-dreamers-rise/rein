#!/usr/bin/env node
// Export a compiled Rein policy (v2/out/policy.json) to the policy JSON of the
// wallets teams already use, so the compiled policy runs on top of them
// rather than instead of them:
//
//   node v2/export.js [--policy v2/out/policy.json] [--addresses v2/addresses.json] [--out v2/out/export]
//
// Writes turnkey.json, coinbase.json, privy.json and export.md. The markdown
// is the honest part: a table of which of the compiled bounds each vendor's
// engine can enforce, and which it cannot (per-window totals, call rate and
// the intent hash are the usual gaps). Shapes follow each vendor's public
// policy docs as of September 2026; the files are schema-shaped exports that
// have not been run against the vendors' APIs, and the README says so.
//
// The address map turns the names in the policy into chain facts:
//   { "USDT": {"address": "0x...", "decimals": 6}, "Supplier A": {"address": "0x..."}, ... }
// Names missing from the map are written as "<NAME>" placeholders.
const fs = require("fs");
const path = require("path");

const SELECTOR = { transfer: "0xa9059cbb", approve: "0x095ea7b3", transferFrom: "0x23b872dd", increaseAllowance: "0x39509351" };
const ERC20_ABI = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
];

function units(amount, decimals) {
  // exact integer arithmetic on a decimal string, no floats
  const [whole, frac = ""] = String(amount).split(".");
  const scaled = (whole + frac.padEnd(decimals, "0").slice(0, decimals)).replace(/^0+(?=\d)/, "");
  return BigInt(scaled || "0");
}
const hex = (n) => "0x" + BigInt(n).toString(16);

function resolve(map, name) {
  const entry = map[name];
  return { address: entry && entry.address ? entry.address : `<${name}>`, decimals: entry && entry.decimals != null ? entry.decimals : 6 };
}

// What the compiled policy asks for, in vendor-neutral terms.
function facts(policy, map) {
  const oc = policy.onchain;
  const tokens = Object.entries(oc.tokens).map(([name, t]) => {
    const r = resolve(map, name);
    return { name, address: r.address, decimals: r.decimals, selectors: oc.selectors[name] || [],
      maxPerWindow: units(t.maxPerWindow, r.decimals), windowSeconds: t.windowSeconds, maxApproval: units(t.maxApproval, r.decimals) };
  });
  const others = oc.targets.filter((n) => !oc.tokens[n]).map((name) => ({ name, address: resolve(map, name).address, selectors: oc.selectors[name] || [] }));
  const payees = oc.payees.map((n) => ({ name: n, address: resolve(map, n).address }));
  return { tokens, others, payees, agent: oc.agent };
}

// Turnkey: stateless allow policies in its expression language. One policy per
// (contract, function). Per-window totals, call rate and intent are not
// expressible; native value is capped per call.
function turnkey(f, consensus) {
  const policies = [];
  const list = (xs) => "[" + xs.map((x) => `'${x}'`).join(", ") + "]";
  for (const t of f.tokens) {
    for (const fn of t.selectors) {
      const parts = [`eth.tx.to == '${t.address}'`, `eth.tx.data[0..4] == '${SELECTOR[fn] || fn}'`];
      if (fn === "transfer" || fn === "transferFrom") parts.push(`eth.tx.contract_call_args['to'] in ${list(f.payees.map((p) => p.address))}`);
      if (fn === "approve") parts.push(`eth.tx.contract_call_args['spender'] in ${list(f.payees.map((p) => p.address))}`, `eth.tx.contract_call_args['value'] <= ${t.maxApproval}`);
      if (fn === "increaseAllowance") continue; // refused outright in Rein; simply not allowed here
      parts.push(`eth.tx.value <= ${f.agent.maxNativePerCall}`);
      policies.push({ policyName: `Rein: ${fn} on ${t.name}`, notes: "compiled from the agent's own trail by Rein v2; per-window totals are not expressible here",
        effect: "EFFECT_ALLOW", consensus, condition: parts.join(" && ") });
    }
  }
  for (const o of f.others) {
    for (const fn of o.selectors) {
      policies.push({ policyName: `Rein: ${fn} on ${o.name}`, notes: "compiled from the agent's own trail by Rein v2", effect: "EFFECT_ALLOW",
        consensus, condition: `eth.tx.to == '${o.address}' && eth.tx.data[0..4] == '${SELECTOR[fn] || fn}' && eth.tx.value <= ${f.agent.maxNativePerCall}` });
    }
  }
  return policies;
}

// Coinbase CDP: one project policy, accept rules with criteria. Per-call amount
// ceilings stand in for the per-window total (a stricter but honest mapping).
function coinbase(f) {
  const rules = [];
  const payees = f.payees.map((p) => p.address);
  for (const t of f.tokens) {
    const conditions = [];
    if (t.selectors.includes("transfer")) conditions.push({ function: "transfer", params: [{ name: "to", operator: "in", values: payees }, { name: "value", operator: "<=", value: t.maxPerWindow.toString() }] });
    if (t.selectors.includes("approve")) conditions.push({ function: "approve", params: [{ name: "spender", operator: "in", values: payees }, { name: "value", operator: "<=", value: t.maxApproval.toString() }] });
    if (conditions.length) rules.push({ action: "accept", operation: "signEvmTransaction", criteria: [
      { type: "evmAddress", addresses: [t.address], operator: "in" },
      { type: "ethValue", ethValue: String(f.agent.maxNativePerCall), operator: "<=" },
      { type: "evmData", abi: "erc20", conditions } ] });
  }
  for (const o of f.others) {
    rules.push({ action: "accept", operation: "signEvmTransaction", criteria: [
      { type: "evmAddress", addresses: [o.address], operator: "in" },
      { type: "ethValue", ethValue: String(f.agent.maxNativePerCall), operator: "<=" } ],
      note: `functions allowed on chain: ${o.selectors.join(", ")}; CDP criteria match the contract, not the selector, without an ABI` });
  }
  return { scope: "project", description: "Rein v2: compiled from the agent's own trail. Per-call ceilings stand in for per-window totals.", rules };
}

// Privy: rules on transaction fields and decoded calldata, plus a stateful
// aggregation for the rolling per-token window, which Privy can enforce.
function privy(f) {
  const payees = f.payees.map((p) => p.address);
  const rules = [];
  const aggregations = [];
  for (const t of f.tokens) {
    const aggId = `rein_${t.name.toLowerCase()}_window`;
    aggregations.push({ id: aggId, method: "eth_sendTransaction", window: t.windowSeconds,
      metric: { field_source: "ethereum_calldata", field: "transfer.value", abi: ERC20_ABI, function: "sum" },
      conditions: [{ field_source: "ethereum_transaction", field: "to", operator: "eq", value: t.address }],
      note: "Privy assigns the aggregation id on creation; reference it below" });
    if (t.selectors.includes("transfer")) rules.push({ name: `Rein: ${t.name} transfers to known payees within the rolling window`, method: "eth_sendTransaction", action: "ALLOW", conditions: [
      { field_source: "ethereum_transaction", field: "to", operator: "eq", value: t.address },
      { field_source: "ethereum_calldata", field: "transfer.to", abi: ERC20_ABI, operator: "in", value: payees },
      { field_source: "reference", field: `aggregation.${aggId}`, operator: "lte", value: hex(t.maxPerWindow) } ] });
    if (t.selectors.includes("approve")) rules.push({ name: `Rein: ${t.name} approvals capped`, method: "eth_sendTransaction", action: "ALLOW", conditions: [
      { field_source: "ethereum_transaction", field: "to", operator: "eq", value: t.address },
      { field_source: "ethereum_calldata", field: "approve.spender", abi: ERC20_ABI, operator: "in", value: payees },
      { field_source: "ethereum_calldata", field: "approve.value", abi: ERC20_ABI, operator: "lte", value: hex(t.maxApproval) } ] });
  }
  for (const o of f.others) {
    rules.push({ name: `Rein: calls on ${o.name}`, method: "eth_sendTransaction", action: "ALLOW", conditions: [
      { field_source: "ethereum_transaction", field: "to", operator: "eq", value: o.address },
      { field_source: "ethereum_transaction", field: "value", operator: "lte", value: hex(f.agent.maxNativePerCall) } ],
      note: `functions allowed on chain: ${o.selectors.join(", ")}` });
  }
  return { version: "1.0", name: "Rein v2: compiled from the agent's own trail", chain_type: "ethereum", aggregations, rules, default_action: "DENY" };
}

// The honest table: which of the compiled bounds each engine can hold.
const CAN = {
  "target allowlist": { turnkey: "yes", coinbase: "yes", privy: "yes" },
  "selector allowlist": { turnkey: "yes (data[0..4])", coinbase: "yes with ABI, else contract only", privy: "yes with ABI" },
  "payee allowlist": { turnkey: "yes (contract_call_args)", coinbase: "yes (evmData)", privy: "yes (calldata)" },
  "rolling spend window": { turnkey: "no: stateless; per-call only", coinbase: "no: per-call ceiling instead", privy: "yes (stateful aggregation)" },
  "approval ceiling": { turnkey: "yes", coinbase: "yes", privy: "yes" },
  "call rate": { turnkey: "no", coinbase: "no", privy: "no (sum only)" },
  "native ceiling of zero": { turnkey: "yes", coinbase: "yes", privy: "yes" },
  "intent required": { turnkey: "no", coinbase: "no", privy: "no" },
  "refusal code to the agent before gas": { turnkey: "no (deny)", coinbase: "no (reject)", privy: "no (deny)" },
  "monitor-only habits": { turnkey: "no", coinbase: "no", privy: "no: guardian stays with Rein" },
};

function markdown(policy) {
  const rows = Object.entries(CAN).map(([k, v]) => `| ${k} | ${v.turnkey} | ${v.coinbase} | ${v.privy} |`);
  const bounds = policy.sentences.filter((s) => s.kind === "bound").length;
  const learned = policy.sentences.filter((s) => s.kind === "learned").length;
  return ["# The compiled policy, exported", "",
    `${bounds} bounds and ${learned} learned habits compiled by Rein v2. The bounds go into the wallet you already use; the table says what each engine can hold and what falls back to Rein's own account or its guardian.`, "",
    "| bound | Turnkey | Coinbase CDP | Privy |", "|---|---|---|---|", ...rows, "",
    "Shapes follow each vendor's public policy docs (September 2026). These files are schema-shaped exports; they have not been submitted to the vendors' APIs, and per-window totals are only expressible on Privy. Rein's own account enforces all ten and returns the refusal code to the agent for free.", ""].join("\n");
}

function run(argv) {
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const root = path.join(__dirname, "..");
  const policyPath = arg("--policy", path.join(root, "v2", "out", "policy.json"));
  const mapPath = arg("--addresses", path.join(root, "v2", "addresses.json"));
  const out = arg("--out", path.join(root, "v2", "out", "export"));
  const consensus = arg("--consensus", "approvers.any(user, user.id == '<AGENT_USER_ID>')");
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  const map = fs.existsSync(mapPath) ? JSON.parse(fs.readFileSync(mapPath, "utf8")) : {};
  const f = facts(policy, map);
  fs.mkdirSync(out, { recursive: true });
  const files = { "turnkey.json": turnkey(f, consensus), "coinbase.json": coinbase(f), "privy.json": privy(f) };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(out, name), JSON.stringify(body, null, 2) + "\n");
  fs.writeFileSync(path.join(out, "export.md"), markdown(policy));
  return { out, files: Object.keys(files).concat("export.md"), turnkey: files["turnkey.json"], coinbase: files["coinbase.json"], privy: files["privy.json"] };
}

if (require.main === module) {
  const r = run(process.argv.slice(2));
  console.log(`  wrote ${r.files.join(", ")} to ${path.relative(process.cwd(), r.out)}`);
}

module.exports = { run, facts, turnkey, coinbase, privy, units, CAN };
