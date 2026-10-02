#!/usr/bin/env node
// Export a compiled Rein policy (v2/out/policy.json) to the policy JSON of the
// wallets teams already use, so the compiled policy runs on top of them
// rather than instead of them:
//
//   node v2/export.js [--policy v2/out/policy.json] [--addresses v2/addresses.json] [--out v2/out/export]
//
//   [--chain-id 8453] [--agent 0x...] [--smart]
//
// Writes turnkey.json, coinbase.json and privy.json, each an ordered list of
// the API requests that put the policy on that engine (create, then attach),
// with {{placeholders}} for the ids only the wallet's owner has or an earlier
// step returns. And export.md, the honest part: which of the compiled bounds
// each engine can hold (per-window totals, call rate and the intent hash are
// the usual gaps). Endpoints, fields and value formats follow each vendor's
// SDK source and API spec as of September 2026; they have not yet been run
// against the live APIs, and the README says so.
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

// What the compiled policy asks for, in vendor-neutral terms. `bounds` (the
// compiler's observed maxima) gives each token a per-transaction cap: the
// largest single payment seen plus the compiler's headroom, never more than
// the window. Engines that cannot hold a window at least hold that.
function facts(policy, map) {
  const oc = policy.onchain;
  const headroom = policy.headroom || 1.25;
  const tokens = Object.entries(oc.tokens).map(([name, t]) => {
    const r = resolve(map, name);
    const maxPerWindow = units(t.maxPerWindow, r.decimals);
    const seen = policy.bounds?.tokens?.[name]?.max_per_call;
    const perCall = seen != null ? units(Math.ceil(seen * headroom * 1e6) / 1e6, r.decimals) : maxPerWindow;
    return { name, label: map[name]?.symbol || name, address: r.address, decimals: r.decimals, selectors: oc.selectors[name] || [],
      maxPerWindow, maxPerCall: perCall < maxPerWindow ? perCall : maxPerWindow, windowSeconds: t.windowSeconds, maxApproval: units(t.maxApproval, r.decimals) };
  });
  const others = oc.targets.filter((n) => !oc.tokens[n]).map((name) => ({ name, address: resolve(map, name).address, selectors: oc.selectors[name] || [] }));
  const payees = oc.payees.map((n) => ({ name: n, address: resolve(map, n).address }));
  // Plain ETH sends: no function to allowlist, so the recipient and the
  // native cap are the whole rule. Capped per transaction, in wei.
  const nativeTo = (oc.nativeTo || []).map((n) => resolve(map, n).address);
  const nativePerCall = units(oc.agent.maxNativePerCall || 0, 18);
  return { tokens, others, payees, nativeTo, nativePerCall, agent: oc.agent };
}

// Where the policy runs. `chainId` scopes every rule to one chain; `smart`
// says the agent is a smart wallet that signs user operations rather than
// transactions; `agent` is the agent's address where an engine keys on it.
const NETWORKS = { 1: "ethereum", 8453: "base", 84532: "base-sepolia" };
function target(o = {}) {
  const chainId = o.chainId ?? 8453;
  return { chainId, network: NETWORKS[chainId] || null, smart: Boolean(o.smart), agent: o.agent || null };
}

// Values the user fills in, or that an earlier step returns. Written the same
// way in every file so a script (or `rein apply`) can fill them in.
const fill = (name) => `{{${name}}}`;
const lc = (a) => (/^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a);

// -- Turnkey ------------------------------------------------------------------
//
// Expressions over one transaction. Turnkey's velocity controls can hold
// spend windows now, but Rein does not write them yet. The
// decoded call arguments are only there once the contract's ABI is uploaded,
// so each token gets a create_smart_contract_interface step first. Addresses
// are compared lowercase, and eth.tx.data carries its 0x, so a selector is
// data[0..10]. Everything goes in ONE policy (branches joined with ||) so a
// fleet fits under a small policy cap; `branches` lets a fleet export key
// several agents' limits by their signing address in the same policy.
function turnkeyBranches(f, t) {
  const payees = "[" + f.payees.map((p) => `'${lc(p.address)}'`).join(", ") + "]";
  const out = [];
  const base = [`eth.tx.chain_id == ${t.chainId}`];
  for (const tok of f.tokens) {
    for (const fn of tok.selectors) {
      const c = [...base, `eth.tx.to == '${lc(tok.address)}'`, `eth.tx.data[0..10] == '${SELECTOR[fn] || fn}'`, "eth.tx.value == 0"];
      if (fn === "transfer") c.push(`eth.tx.contract_call_args['to'] in ${payees}`, `eth.tx.contract_call_args['value'] <= ${tok.maxPerCall}`);
      else if (fn === "transferFrom") c.push(`eth.tx.contract_call_args['to'] in ${payees}`, `eth.tx.contract_call_args['value'] <= ${tok.maxPerCall}`);
      else if (fn === "approve") c.push(`eth.tx.contract_call_args['spender'] in ${payees}`, `eth.tx.contract_call_args['value'] <= ${tok.maxApproval}`);
      else if (fn === "increaseAllowance") continue; // refused outright in Rein; simply not allowed here
      out.push({ what: `${fn} on ${tok.label}`, condition: c.join(" && ") });
    }
  }
  for (const o of f.others) {
    for (const fn of o.selectors) {
      const sel = /^0x[0-9a-f]{8}$/i.test(fn) ? fn : SELECTOR[fn];
      const c = [...base, `eth.tx.to == '${lc(o.address)}'`, `eth.tx.value <= ${f.nativePerCall}`];
      if (sel) c.push(`eth.tx.data[0..10] == '${sel.toLowerCase()}'`);
      out.push({ what: `${fn} on ${o.name}`, condition: c.join(" && ") });
    }
  }
  if (f.nativeTo.length && f.nativePerCall > 0n) {
    out.push({ what: "ETH to known recipients", condition: [...base, `eth.tx.to in [${f.nativeTo.map((a) => `'${lc(a)}'`).join(", ")}]`, "eth.tx.data == '0x'", `eth.tx.value <= ${f.nativePerCall}`].join(" && ") });
  }
  return out;
}

const ERC20_ABI_JSON = JSON.stringify(ERC20_ABI.concat([
  { type: "function", name: "transferFrom", stateMutability: "nonpayable", inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
]));

function turnkeyActivity(type, path, parameters) {
  return { method: "POST", url: `https://api.turnkey.com/public/v1/submit/${path}`, auth: "X-Stamp: the request body signed with your Turnkey API key (rein apply does this)",
    body: { type, timestampMs: fill("now_ms"), organizationId: fill("turnkey_organization_id"), parameters } };
}

/// `agents`: [{ address, facts }] for a fleet, keyed by each agent's signing
/// address; or pass one agent's facts as `f`.
function turnkey(f, consensus, o = {}, agents = null) {
  const t = target(o);
  const tokens = new Map();
  const fleet = agents || [{ address: t.agent, facts: f }];
  for (const a of fleet) for (const tok of a.facts.tokens) if (/^0x[0-9a-fA-F]{40}$/.test(tok.address)) tokens.set(lc(tok.address), tok.label);
  const branches = [];
  for (const a of fleet) {
    for (const b of turnkeyBranches(a.facts, t)) {
      const who = a.address && fleet.length > 1 ? `wallet_account.address == '${lc(a.address)}' && ` : "";
      branches.push({ what: `${a.address && fleet.length > 1 ? `${a.address.slice(0, 8)}: ` : ""}${b.what}`, condition: `(${who}${b.condition})` });
    }
  }
  const steps = [...tokens].map(([address, name]) => ({
    step: `upload the ERC-20 interface for ${name}, so the policy can read transfer and approve arguments`,
    request: turnkeyActivity("ACTIVITY_TYPE_CREATE_SMART_CONTRACT_INTERFACE", "create_smart_contract_interface", {
      smartContractAddress: address, smartContractInterface: ERC20_ABI_JSON, type: "SMART_CONTRACT_INTERFACE_TYPE_ETHEREUM", label: `${name} (Rein)`.slice(0, 64) }),
  }));
  steps.push({
    step: `create one allow policy covering ${branches.length} kind(s) of call${fleet.length > 1 ? ` for ${fleet.length} agents` : ""}; anything it does not allow is denied`,
    returns: "policy",
    request: turnkeyActivity("ACTIVITY_TYPE_CREATE_POLICY_V3", "create_policy", {
      policyName: fleet.length > 1 ? `Rein: ${fleet.length} agents, compiled` : "Rein: compiled from the agent's history",
      effect: "EFFECT_ALLOW",
      notes: "Written by Rein from the agents' own transaction history. This policy holds per-transaction caps; hourly totals need a Turnkey velocity control, which Rein does not write yet, so rein watch covers them.",
      consensus,
      condition: branches.map((b) => b.condition).join(" || ") || "false",
    }),
  });
  return { vendor: "turnkey", covers: branches.map((b) => b.what), fill: ["turnkey_organization_id", "now_ms"], steps };
}

// -- Coinbase CDP -------------------------------------------------------------
//
// An account policy (a project can hold only one project policy), rules in
// order, first match decides, unmatched is rejected. One rule per function
// per operation: the conditions inside one evmData criterion must all hold,
// so transfer and approve cannot share one. No spend windows server side.
function coinbase(f, o = {}) {
  const t = target(o);
  const ops = t.smart ? ["prepareUserOperation", "sendUserOperation"] : ["signEvmTransaction", "sendEvmTransaction"];
  const withNetwork = (op) => op !== "signEvmTransaction" && t.network;
  const payees = f.payees.map((p) => p.address);
  const rules = [];
  for (const op of ops) {
    const scope = withNetwork(op) ? [{ type: "evmNetwork", networks: [t.network], operator: "in" }] : [];
    for (const tok of f.tokens) {
      for (const fn of tok.selectors) {
        let params;
        if (fn === "transfer") params = [{ name: "to", operator: "in", values: payees }, { name: "value", operator: "<=", value: tok.maxPerCall.toString() }];
        else if (fn === "approve") params = [{ name: "spender", operator: "in", values: payees }, { name: "value", operator: "<=", value: tok.maxApproval.toString() }];
        else continue; // transferFrom and increaseAllowance are left denied
        rules.push({ action: "accept", operation: op, criteria: [...scope,
          { type: "evmAddress", addresses: [tok.address], operator: "in" },
          { type: "ethValue", ethValue: "0", operator: "<=" },
          { type: "evmData", abi: "erc20", conditions: [{ function: fn, params }] }] });
      }
    }
    for (const oth of f.others) {
      rules.push({ action: "accept", operation: op, criteria: [...scope,
        { type: "evmAddress", addresses: [oth.address], operator: "in" },
        { type: "ethValue", ethValue: f.nativePerCall.toString(), operator: "<=" }] });
    }
    if (f.nativeTo.length && f.nativePerCall > 0n) {
      rules.push({ action: "accept", operation: op, criteria: [...scope,
        { type: "evmAddress", addresses: f.nativeTo, operator: "in" },
        { type: "ethValue", ethValue: f.nativePerCall.toString(), operator: "<=" }] });
    }
  }
  const agent = t.agent || fill("cdp_account_address");
  return {
    vendor: "coinbase",
    fill: t.agent ? [] : ["cdp_account_address"],
    limits: { rules: rules.length, maxRules: 100 },
    steps: [
      { step: `create an account policy with ${rules.length} accept rule(s); anything else is rejected`, returns: "policy",
        request: { method: "POST", url: "https://api.cdp.coinbase.com/platform/v2/policy-engine/policies", auth: "Authorization: Bearer <JWT signed with your CDP API key> (rein apply does this)",
          body: { scope: "account", description: "Rein compiled policy", rules } } },
      { step: "attach it to the agent's account",
        request: { method: "PUT", url: `https://api.cdp.coinbase.com/platform/v2/evm/accounts/${agent}`, auth: "Authorization: Bearer <JWT>, plus X-Wallet-Auth from your Wallet Secret (rein apply does this)",
          body: { accountPolicy: fill("policy.id") } } },
    ],
  };
}

// -- Privy ----------------------------------------------------------------------
//
// Rules on the transaction and its decoded calldata, plus a rolling window per
// token, which Privy holds as a separate aggregation created first and then
// referenced by id. Aggregations only see signing requests, so every rule is
// written for eth_signTransaction (or eth_signUserOperation for a smart
// wallet): an agent using eth_sendTransaction would bypass the window. A
// wallet holds exactly one policy, so this is the whole policy, attached last.
const PRIVY = "https://api.privy.io/v1";
const PRIVY_AUTH = "Basic <app id>:<app secret>, plus the privy-app-id header";

function privy(f, o = {}) {
  const t = target(o);
  const method = t.smart ? "eth_signUserOperation" : "eth_signTransaction";
  const payees = f.payees.map((p) => p.address);
  const chain = { field_source: "ethereum_transaction", field: "chain_id", operator: "eq", value: String(t.chainId) };
  const steps = [];
  const rules = [];
  for (const tok of f.tokens) {
    const slug = tok.label.replace(/[^A-Za-z0-9]/g, "").slice(0, 12).toLowerCase() || "token";
    const aggName = `rein ${slug} window`;
    const aggKey = `aggregation_${slug}`;
    const to = { field_source: "ethereum_transaction", field: "to", operator: "eq", value: tok.address };
    if (tok.selectors.includes("transfer")) {
      steps.push({ step: `create the rolling ${tok.windowSeconds / 3600}-hour ${tok.label} window`, returns: aggKey,
        request: { method: "POST", url: `${PRIVY}/aggregations`, auth: PRIVY_AUTH, body: {
          name: aggName, method,
          metric: { field_source: "ethereum_calldata", field: "transfer.value", abi: ERC20_ABI, function: "sum" },
          window: { type: "rolling", seconds: Math.min(259200, Math.max(3600, tok.windowSeconds)) },
          conditions: [to] } } });
      rules.push({ name: `${tok.label} to known payees, per tx and per window`.slice(0, 50), method, action: "ALLOW", conditions: [chain, to,
        { field_source: "ethereum_calldata", field: "transfer.to", abi: ERC20_ABI, operator: "in", value: payees },
        { field_source: "ethereum_calldata", field: "transfer.value", abi: ERC20_ABI, operator: "lte", value: hex(tok.maxPerCall) },
        { field_source: "reference", field: `aggregation.${fill(`${aggKey}.id`)}`, operator: "lte", value: hex(tok.maxPerWindow) }] });
    }
    if (tok.selectors.includes("approve")) rules.push({ name: `${tok.label} approvals, capped`.slice(0, 50), method, action: "ALLOW", conditions: [chain, to,
      { field_source: "ethereum_calldata", field: "approve.spender", abi: ERC20_ABI, operator: "in", value: payees },
      { field_source: "ethereum_calldata", field: "approve.value", abi: ERC20_ABI, operator: "lte", value: hex(tok.maxApproval) }] });
  }
  // Privy can only tell one function on a contract from another by decoding
  // its arguments with the ABI, which Rein doesn't write yet. A rule on `to`
  // alone would allow every function on a router, including a swap paid out
  // to someone else, so other contracts are left out: closed, not open.
  const leftOut = f.others.map((oth) => ({ contract: oth.name, address: oth.address, functions: oth.selectors,
    why: "Privy can only limit which function is called with the contract's ABI, so Rein leaves it out rather than allow every function on it. Add an ABI rule by hand, or have a person approve these calls." }));
  if (f.nativeTo.length && f.nativePerCall > 0n) {
    rules.push({ name: "ETH to known recipients", method, action: "ALLOW", conditions: [chain,
      { field_source: "ethereum_transaction", field: "to", operator: "in", value: f.nativeTo },
      { field_source: "ethereum_transaction", field: "value", operator: "lte", value: hex(f.nativePerCall) }] });
  }
  steps.push({ step: `create the policy: ${rules.length} allow rule(s), nothing else allowed`, returns: "policy",
    request: { method: "POST", url: `${PRIVY}/policies`, auth: PRIVY_AUTH, body: { version: "1.0", name: "Rein compiled policy", chain_type: "ethereum", rules } } });
  steps.push({ step: "attach it to the agent's wallet (a wallet holds one policy, so this replaces any other)",
    request: { method: "PATCH", url: `${PRIVY}/wallets/${fill("privy_wallet_id")}`, auth: `${PRIVY_AUTH}; a wallet with an owner also needs privy-authorization-signature`,
      body: { policy_ids: [fill("policy.id")] } } });
  return { vendor: "privy", method, fill: ["privy_wallet_id"], steps, ...(leftOut.length ? { leftOut } : {}) };
}

// The honest table: which of the compiled bounds each engine can hold.
const CAN = {
  "target allowlist": { turnkey: "yes", coinbase: "yes", privy: "yes" },
  "selector allowlist": { turnkey: "yes (data[0..10])", coinbase: "yes with ABI, else contract only", privy: "yes with ABI" },
  "payee allowlist": { turnkey: "yes (after the ABI upload)", coinbase: "yes (evmData)", privy: "yes (calldata)" },
  "per-transaction cap": { turnkey: "yes", coinbase: "yes", privy: "yes" },
  "rolling spend window": { turnkey: "yes (velocity controls; Rein does not write them yet)", coinbase: "no: per transaction only", privy: "yes (aggregation, signing requests only)" },
  "approval ceiling": { turnkey: "yes", coinbase: "yes", privy: "yes" },
  "call rate": { turnkey: "no", coinbase: "no", privy: "no (sum only)" },
  "native ceiling of zero": { turnkey: "yes", coinbase: "yes", privy: "yes" },
  "intent required": { turnkey: "no", coinbase: "no", privy: "no" },
  "refusal code to the agent before gas": { turnkey: "no (deny)", coinbase: "no (reject)", privy: "no (deny)" },
  "monitor-only habits": { turnkey: "no", coinbase: "no", privy: "no: guardian stays with Rein" },
};

function markdown(policy) {
  const rows = Object.entries(CAN).map(([k, v]) => `| ${k} | ${v.turnkey} | ${v.coinbase} | ${v.privy} |`);
  const bounds = (policy.sentences || []).filter((s) => s.kind === "bound").length;
  const learned = (policy.sentences || []).filter((s) => s.kind === "learned").length;
  return ["# The compiled policy, exported", "",
    `${bounds} bounds and ${learned} learned habits compiled by Rein v2. The bounds go into the wallet you already use; the table says what each engine can hold and what falls back to Rein's own account, its guardian, or \`rein watch\`.`, "",
    "| bound | Turnkey | Coinbase CDP | Privy |", "|---|---|---|---|", ...rows, "",
    "Each file is an ordered list of API requests: run them in order, filling each `{{…}}` with your own id or with what an earlier step returned. " +
    "Endpoints, field names and value formats were checked against each vendor's SDK source and API spec (September 2026). " +
    "They have not yet been run against the live APIs; Privy's user-operation rules for smart wallets are the least certain part.", ""].join("\n");
}

function run(argv) {
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const root = path.join(__dirname, "..");
  const policyPath = arg("--policy", path.join(root, "v2", "out", "policy.json"));
  const mapPath = arg("--addresses", path.join(root, "v2", "addresses.json"));
  const out = arg("--out", path.join(root, "v2", "out", "export"));
  const consensus = arg("--consensus", "approvers.any(user, user.id == '{{turnkey_agent_user_id}}')");
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  const map = fs.existsSync(mapPath) ? JSON.parse(fs.readFileSync(mapPath, "utf8")) : {};
  const f = facts(policy, map);
  fs.mkdirSync(out, { recursive: true });
  const o = { chainId: Number(arg("--chain-id", 8453)), smart: argv.includes("--smart"), agent: arg("--agent", null) };
  const files = { "turnkey.json": turnkey(f, consensus, o), "coinbase.json": coinbase(f, o), "privy.json": privy(f, o) };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(out, name), JSON.stringify(body, null, 2) + "\n");
  fs.writeFileSync(path.join(out, "export.md"), markdown(policy));
  return { out, files: Object.keys(files).concat("export.md"), turnkey: files["turnkey.json"], coinbase: files["coinbase.json"], privy: files["privy.json"] };
}

if (require.main === module) {
  const r = run(process.argv.slice(2));
  console.log(`  wrote ${r.files.join(", ")} to ${path.relative(process.cwd(), r.out)}`);
}

module.exports = { run, facts, turnkey, coinbase, privy, units, CAN, NETWORKS };
