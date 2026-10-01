// rein cosign: Rein as the second key, enforced by the wallet vendor.
//
//   npx rein-wallet cosign keygen
//   npx rein-wallet cosign setup turnkey --organization <org id> --agent-user <user id> --send
//   npx rein-wallet cosign turnkey --organization <org id> --webhook "$SLACK_WEBHOOK_URL"
//   npx rein-wallet cosign privy --port 8788
//
// `check` runs inside the agent's own process, so an agent that has been
// talked into it can skip the check. This moves the check out of the agent's
// reach. The wallet vendor's own policy engine lets the agent sign alone
// inside the limits Rein learned (the policy `rein apply turnkey.json` puts
// there), and requires a second approval, from Rein's co-signer, for
// everything else. Normal payments never touch Rein, so a Rein outage can't
// stop them; the rest wait in Turnkey until Rein approves them.
//
// The co-signer reads each signing request waiting on it, runs it through the
// same guard `check` uses (the wallet's learned payees, and its hourly and
// daily totals), and approves what fits. Anything else is
// held for a person, posted to Slack, and approved or refused in Turnkey once
// they decide (rein guard --allow / --deny, or rein approvals). A request it
// can't read, such as a raw signature, is left for a person to approve in
// Turnkey itself.
//
// Privy works the other way round: the agent collects the signatures before
// it sends a request, so the co-signer is a small HTTP service. The agent
// signs alone inside its learned limits (an "agent alone" key quorum held to
// the policy `rein apply privy.json` wrote); for anything else it sends the
// request to `rein cosign privy`, which signs it as the second key of the
// wallet's owner quorum only if the guard allows it, and holds it otherwise.
// Rein signs wallet RPC requests only: never a change to the wallet, its
// owner or its policies.
//
// Rein's key lives only where the co-signer runs. The agent must not be able
// to read it, must not be in the organization's root quorum, and must have no
// other policy that lets it sign alone; any of those would let it around the
// second key.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const sign = require("./sign");
const { check, loadGuard, home } = require("./guard");

const http = require("http");

const TURNKEY = "https://api.turnkey.com";
const PRIVY = "https://api.privy.io";
const SIGNING = [
  "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
  "ACTIVITY_TYPE_ETH_SEND_TRANSACTION",
  "ACTIVITY_TYPE_ETH_SEND_TRANSACTION_V2",
  "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
  "ACTIVITY_TYPE_SIGN_RAW_PAYLOADS",
];
const isAddress = (x) => typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x);
const caip2 = (c) => (/^eip155:\d+$/.test(c || "") ? Number(c.split(":")[1]) : null);

/// What a waiting Turnkey activity asks to sign, as { tx, chainId }, or
/// { unreadable } saying why Rein can't judge it.
function readActivity(a) {
  const i = a.intent || {};
  try {
    if (i.signTransactionIntentV2) {
      const { signWith, unsignedTransaction } = i.signTransactionIntentV2;
      if (!isAddress(signWith)) return { unreadable: "it signs with a key id, not a wallet address Rein guards" };
      const raw = unsignedTransaction.startsWith("0x") ? unsignedTransaction : `0x${unsignedTransaction}`;
      const t = ethers.Transaction.from(raw);
      if (t.type === 4 || t.authorizationList?.length) return { unreadable: "it hands the wallet's code to a contract (EIP-7702), which isn't a payment" };
      return { tx: { from: ethers.getAddress(signWith), to: t.to, data: t.data, value: t.value.toString() }, chainId: t.chainId ? Number(t.chainId) : null };
    }
    const send = i.ethSendTransactionIntent || i.ethSendTransactionIntentV2;
    if (send) {
      const calls = send.calls || [{ to: send.to, value: send.value, data: send.data }];
      if (calls.length !== 1) return { unreadable: `it batches ${calls.length} calls, and Rein checks one at a time` };
      const c = calls[0];
      return { tx: { from: ethers.getAddress(send.from), to: c.to, data: c.data || "0x", value: String(c.value ?? 0) }, chainId: caip2(send.caip2) };
    }
  } catch (err) {
    return { unreadable: `Rein couldn't decode it (${err.message})` };
  }
  return { unreadable: "it asks for a raw signature, which doesn't say what it moves" };
}

/// Turnkey's API as the co-signer uses it, stamped with Rein's own key.
function turnkeyClient({ organizationId, publicKey, privateKey, fetch: fetchImpl = globalThis.fetch }) {
  sign.turnkeyKey(publicKey, privateKey); // a mismatched pair fails here, not as a 401
  const post = async (p, body) => {
    const text = JSON.stringify(body);
    const res = await fetchImpl(`${TURNKEY}${p}`, { method: "POST", headers: { "content-type": "application/json", "X-Stamp": sign.turnkeyStamp(text, { publicKey, privateKey }) }, body: text });
    const out = await res.text();
    if (!res.ok) throw new Error(`Turnkey ${p} answered ${res.status}: ${out.slice(0, 300)}`);
    return out ? JSON.parse(out) : {};
  };
  const vote = (kind) => (fingerprint) =>
    post(`/public/v1/submit/${kind}_activity`, { type: `ACTIVITY_TYPE_${kind.toUpperCase()}_ACTIVITY`, timestampMs: String(Date.now()), organizationId, parameters: { fingerprint } });
  return {
    waiting: async () => (await post("/public/v1/query/list_activities", { organizationId, filterByStatus: ["ACTIVITY_STATUS_CONSENSUS_NEEDED"], filterByType: SIGNING, paginationOptions: { limit: "100" } })).activities || [],
    approve: vote("approve"),
    reject: vote("reject"),
  };
}

const statePath = (org, env) => path.join(home(env), "cosign", `turnkey-${org}.json`);
function loadState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { activities: {} };
  }
}
function saveState(state, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/// One pass over the signing requests waiting on Rein. Returns what it did:
/// { approved, rejected, held, left } as lists of activity ids.
async function tick({ client, organizationId, env = process.env, webhook = null, fetch: fetchImpl = globalThis.fetch, log = () => {}, now = () => Math.floor(Date.now() / 1000) }) {
  const file = statePath(organizationId, env);
  const state = loadState(file);
  const done = { approved: [], rejected: [], held: [], left: [] };
  const tell = (text) => webhook && fetchImpl(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, content: text }) }).catch(() => {});
  const waiting = await client.waiting();
  for (const a of waiting) {
    if (a.canApprove === false) continue; // already voted, or not Rein's to vote on
    const seen = state.activities[a.id];
    if (seen?.status === "left") continue;
    const leave = (why) => {
      state.activities[a.id] = { status: "left", why, at: new Date(now() * 1000).toISOString() };
      done.left.push(a.id);
      log(`left ${a.id} for a person: ${why}`);
      tell(`Rein can't judge a signing request waiting in Turnkey (${a.id}): ${why}. Approve or reject it in Turnkey.`);
    };
    const r = readActivity(a);
    if (r.unreadable) {
      leave(r.unreadable);
      continue;
    }
    let guard;
    try {
      guard = loadGuard(r.tx.from, env).guard;
    } catch {
      leave(`Rein has no guard for ${r.tx.from} on this machine (rein guard ${r.tx.from} sets one up)`);
      continue;
    }
    if (guard.chainId && r.chainId && guard.chainId !== r.chainId) {
      leave(`it is for chain ${r.chainId}, and ${guard.wallet}'s limits were learned on chain ${guard.chainId}`);
      continue;
    }
    if (seen?.status === "held") {
      const h = (guard.holds || []).find((x) => x.id === seen.hold);
      if (h && h.status === "waiting" && h.until > now()) continue; // a person hasn't decided yet
      if (!h || h.status === "denied" || h.until <= now()) {
        await client.reject(a.fingerprint);
        delete state.activities[a.id];
        done.rejected.push(a.id);
        log(`rejected ${a.id}: ${h ? "a person refused it" : "nobody approved it in time"}`);
        continue;
      }
      // approved: the check below lets it through once
    }
    const v = check(r.tx, { env, wallet: r.tx.from, now: now(), fetch: fetchImpl });
    if (v.allow) {
      await client.approve(a.fingerprint);
      delete state.activities[a.id];
      done.approved.push(a.id);
      log(`approved ${a.id}: ${v.explanation}`);
    } else if (v.refused) {
      await client.reject(a.fingerprint);
      delete state.activities[a.id];
      done.rejected.push(a.id);
      log(`rejected ${a.id}: a person refused this payment`);
    } else if (v.held) {
      state.activities[a.id] = { status: "held", hold: v.held, wallet: guard.wallet, at: new Date(now() * 1000).toISOString() };
      done.held.push(a.id);
      log(`holding ${a.id} for a person: ${v.explanation} (rein guard ${guard.wallet} --allow ${v.held})`);
    } else leave(v.explanation);
  }
  // Forget what Turnkey no longer has waiting (signed, rejected, or expired there).
  const live = new Set(waiting.map((a) => a.id));
  for (const id of Object.keys(state.activities)) if (!live.has(id)) delete state.activities[id];
  saveState(state, file);
  return done;
}

// -- setup ---------------------------------------------------------------------------

const activity = (type, p, parameters) => ({
  method: "POST",
  url: `${TURNKEY}/public/v1/submit/${p}`,
  body: { type, timestampMs: "{{now_ms}}", organizationId: "{{turnkey_organization_id}}", parameters },
});

/// The Turnkey requests that make Rein the second key: a user holding only
/// Rein's public key, and a policy letting the agent sign outside its learned
/// limits only when that user approves too. The learned limits themselves
/// come from `rein apply turnkey.json`, which lets the agent sign alone.
function turnkeySetup() {
  return {
    vendor: "turnkey",
    steps: [
      {
        step: "create Rein's co-signer: an API-only user that holds only Rein's public key",
        returns: "cosigner",
        request: activity("ACTIVITY_TYPE_CREATE_API_ONLY_USERS", "create_api_only_users", {
          apiOnlyUsers: [{ userName: "Rein co-signer", userTags: [], apiKeys: [{ apiKeyName: "Rein co-signer", publicKey: "{{rein_public_key}}" }] }],
        }),
      },
      {
        step: "let the agent sign outside its learned limits only when Rein co-signs",
        returns: "policy",
        request: activity("ACTIVITY_TYPE_CREATE_POLICY_V3", "create_policy", {
          policyName: "Rein: second key outside the learned limits",
          effect: "EFFECT_ALLOW",
          consensus: "approvers.any(user, user.id == '{{turnkey_agent_user_id}}') && approvers.any(user, user.id == '{{cosigner.id}}')",
          condition: `activity.type in [${SIGNING.map((t) => `'${t}'`).join(", ")}]`,
          notes: "Written by Rein. Inside the learned limits the agent signs alone (the compiled policy); anything else waits for Rein's co-signer, which approves what fits the agent's hourly and daily limits and holds the rest for a person.",
        }),
      },
    ],
  };
}


// -- Privy ---------------------------------------------------------------------------

const PAYMENT_METHODS = ["eth_sendTransaction", "eth_signTransaction", "eth_signTypedData_v4"];

/// What a Privy request asks Rein to co-sign: { walletId, tx, chainId }, or
/// { refuse } saying why Rein won't sign it at all.
function readPrivyRequest(r) {
  const m = /^https:\/\/api\.privy\.io\/v1\/wallets\/([A-Za-z0-9_-]+)\/rpc$/.exec(r?.url || "");
  if (r?.method !== "POST" || !m) return { refuse: "Rein co-signs wallet RPC requests only, never a change to a wallet, its owner or its policies" };
  const b = r.body || {};
  if (!PAYMENT_METHODS.includes(b.method)) return { refuse: `Rein co-signs payments (${PAYMENT_METHODS.join(", ")}); ${b.method || "this"} is not one` };
  if (b.method === "eth_signTypedData_v4") {
    const td = b.params?.typed_data || {};
    const ids = [caip2(b.caip2), td.domain?.chainId != null ? Number(td.domain.chainId) : null].filter((x) => x != null);
    if (new Set(ids).size > 1) return { refuse: `it names two chains (${ids.join(" and ")})` };
    return { walletId: m[1], tx: { domain: td.domain, types: td.types, primaryType: td.primary_type ?? td.primaryType, message: td.message }, chainId: ids[0] ?? null };
  }
  const t = b.params?.transaction || {};
  if (!t.to) return { refuse: "the transaction has no recipient" };
  if (t.authorization_list || t.authorizationList || Number(t.type) === 4) return { refuse: "it hands the wallet's code to a contract (EIP-7702), which isn't a payment" };
  if (t.input != null && t.input !== t.data) return { refuse: "it carries calldata in a field Rein doesn't read" };
  const ids = [caip2(b.caip2), t.chain_id != null ? Number(t.chain_id) : null].filter((x) => x != null);
  if (new Set(ids).size > 1) return { refuse: `it names two chains (${ids.join(" and ")})` };
  return { walletId: m[1], tx: { to: t.to, data: t.data || "0x", value: BigInt(t.value ?? 0).toString() }, chainId: ids[0] ?? null };
}

/// POST /sign with the exact request the agent will send to Privy ({ method,
/// url, body, headers }). 200 { signature } to add to its
/// privy-authorization-signature header; 202 { held, next } while a person
/// decides; 403 { reason, explanation } when Rein won't sign.
function privyHandler({ env = process.env, appId, appSecret, key, token = null, fetch: fetchImpl = globalThis.fetch, log = () => {} }) {
  const addresses = new Map();
  const walletAddress = async (id) => {
    if (!addresses.has(id)) {
      const res = await fetchImpl(`${PRIVY}/v1/wallets/${id}`, { headers: { "privy-app-id": appId, authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}` } });
      if (!res.ok) throw new Error(`Privy didn't find wallet ${id} (${res.status})`);
      addresses.set(id, ethers.getAddress((await res.json()).address));
    }
    return addresses.get(id);
  };
  return async (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/sign") return send(404, { error: "POST /sign" });
    if (token && req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "wrong or missing bearer token" });
    let request;
    try {
      let raw = "";
      for await (const c of req) if ((raw += c).length > 1e6) throw new Error("too large");
      request = JSON.parse(raw);
    } catch (err) {
      return send(400, { error: `not a JSON request: ${err.message}` });
    }
    const refuse = (explanation, reason = "NOT_A_PAYMENT") => (log(`refused: ${explanation}`), send(403, { allow: false, reason, explanation }));
    if (request?.headers?.["privy-app-id"] !== appId) return refuse(`this co-signer serves Privy app ${appId} only`, "WRONG_APP");
    const r = readPrivyRequest(request);
    if (r.refuse) return refuse(r.refuse);
    let address;
    let guard;
    try {
      address = await walletAddress(r.walletId);
      guard = loadGuard(address, env).guard;
    } catch (err) {
      return refuse(`Rein has no guard for that wallet (${err.message})`, "GUARD_ERROR");
    }
    if (guard.chainId && r.chainId && guard.chainId !== r.chainId) return refuse(`it is for chain ${r.chainId}, and this wallet's limits were learned on chain ${guard.chainId}`, "WRONG_CHAIN");
    const v = check(r.tx, { env, wallet: address, fetch: fetchImpl });
    if (v.allow) {
      log(`signed for ${address}: ${v.explanation}`);
      return send(200, { ...v, signature: sign.privySignature(request, key) });
    }
    log(`${v.held ? "holding" : "refused"} for ${address}: ${v.explanation}`);
    return send(v.held ? 202 : 403, v);
  };
}

/// The Privy requests that make Rein the second key. Two key quorums: the
/// agent alone, held to the learned policy; and the wallet's new owner, any
/// two of the agent, Rein and the platform's admin. Then the wallet: owned by
/// the second, with the first as a signer under the learned policy.
function privySetup() {
  const q = (name, keys, threshold) => ({ method: "POST", url: `${PRIVY}/v1/key_quorums`, body: { display_name: name, public_keys: keys, authorization_threshold: threshold } });
  return {
    vendor: "privy",
    steps: [
      { step: "a key quorum for the agent alone", returns: "agent_quorum", request: q("Agent alone (Rein's learned limits)", ["{{agent_key}}"], 1) },
      { step: "a key quorum to own the wallet: any two of the agent, Rein and your admin key", returns: "owner_quorum", request: q("Rein second key", ["{{agent_key}}", "{{rein_key}}", "{{admin_key}}"], 2) },
      {
        step: "the wallet: owned by that quorum; the agent alone may sign only inside the learned policy",
        request: {
          method: "PATCH",
          url: `${PRIVY}/v1/wallets/{{privy_wallet_id}}`,
          body: { owner_id: "{{owner_quorum.id}}", policy_ids: [], additional_signers: [{ signer_id: "{{agent_quorum.id}}", override_policy_ids: ["{{privy_policy_id}}"] }] },
        },
      },
    ],
  };
}

/// One P-256 key for Rein's co-signer, in the formats Turnkey (hex) and Privy
/// (base64 DER) each take.
function keygen() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const publicKey = ecdh.getPublicKey("hex", "compressed");
  const privateKey = ecdh.getPrivateKey("hex").padStart(64, "0");
  const k = sign.turnkeyKey(publicKey, privateKey);
  return {
    publicKey,
    privateKey,
    privyPublicKey: crypto.createPublicKey(k).export({ format: "der", type: "spki" }).toString("base64"),
    privyPrivateKey: k.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

// -- command line --------------------------------------------------------------------

function parse(argv) {
  const o = { cmd: argv[0], vendor: null, organization: null, agentUser: null, send: false, every: 3, once: false, webhook: process.env.REIN_WEBHOOK || null, port: Number(process.env.PORT) || 8788, vars: {} };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--organization") o.organization = argv[++i];
    else if (a === "--agent-user") o.agentUser = argv[++i];
    else if (a === "--send") o.send = true;
    else if (a === "--every") o.every = Number(argv[++i]);
    else if (a === "--once") o.once = true;
    else if (a === "--webhook") o.webhook = argv[++i];
    else if (a === "--port") o.port = Number(argv[++i]);
    else if (a === "--wallet") o.vars.privy_wallet_id = argv[++i];
    else if (a === "--agent-key") o.vars.agent_key = argv[++i];
    else if (a === "--admin-key") o.vars.admin_key = argv[++i];
    else if (a === "--policy") o.vars.privy_policy_id = argv[++i];
    else if (a === "-h" || a === "--help") o.help = true;
    else if (!a.startsWith("-") && !o.vendor) o.vendor = a;
    else throw new Error(`unknown flag ${a}`);
  }
  return o;
}

const USAGE = `usage: rein cosign keygen                      a key for Rein's co-signer, for Turnkey and for Privy
       rein cosign setup turnkey --organization <org id> --agent-user <user id> [--send]
                                               make Rein the second key (needs REIN_TURNKEY_PUBLIC_KEY, and
                                               TURNKEY_API_PUBLIC_KEY/PRIVATE_KEY of an admin to --send)
       rein cosign turnkey --organization <org id> [--webhook URL] [--every 3] [--once]
                                               run the co-signer (needs REIN_TURNKEY_PUBLIC_KEY/PRIVATE_KEY)
       rein cosign setup privy --wallet <wallet id> --policy <learned policy id> --agent-key <key> --admin-key <key> [--send]
                                               keys are base64 P-256 public keys (needs REIN_PRIVY_PUBLIC_KEY, and
                                               PRIVY_APP_ID/SECRET plus the wallet owner's PRIVY_AUTHORIZATION_KEY to --send)
       rein cosign privy [--port 8788]         run the co-signer (needs REIN_PRIVY_AUTH_KEY, PRIVY_APP_ID/SECRET;
                                               REIN_COSIGN_TOKEN, if set, is required as a bearer token)`;

async function main(argv, { log = console.log, env = process.env, fetch: fetchImpl = globalThis.fetch } = {}) {
  const o = parse(argv);
  if (o.help || !o.cmd) {
    console.error(USAGE);
    return o.help ? 0 : 2;
  }
  if (o.cmd === "keygen") {
    const k = keygen();
    log("Rein's co-signer key. Keep the private half only where the co-signer runs: if the agent can read it, it can approve itself.");
    log("");
    log("For Turnkey:");
    log(`  REIN_TURNKEY_PUBLIC_KEY=${k.publicKey}`);
    log(`  REIN_TURNKEY_PRIVATE_KEY=${k.privateKey}`);
    log("For Privy (the same key):");
    log(`  REIN_PRIVY_PUBLIC_KEY=${k.privyPublicKey}`);
    log(`  REIN_PRIVY_AUTH_KEY=${k.privyPrivateKey}`);
    return 0;
  }
  if (o.cmd === "setup" && o.vendor === "privy") {
    const pub = env.REIN_PRIVY_PUBLIC_KEY;
    if (!pub) throw new Error("set REIN_PRIVY_PUBLIC_KEY (rein cosign keygen makes one)");
    const need = { privy_wallet_id: "--wallet", privy_policy_id: "--policy", agent_key: "--agent-key", admin_key: "--admin-key" };
    const missing = Object.keys(need).filter((k) => !o.vars[k]);
    if (o.send && missing.length) throw new Error(`--send needs ${missing.map((k) => need[k]).join(", ")}`);
    const { apply } = require("./apply");
    await apply(privySetup(), { vars: { ...o.vars, rein_key: pub }, send: o.send, env, fetch: fetchImpl, log });
    log("");
    log(o.send ? "Rein is the second key on that wallet." : "Nothing was sent. Add --send to make these requests.");
    log("How the agent signs now:");
    log("  inside its learned limits, with its own key alone (the agent-alone quorum);");
    log("  for anything else, POST the exact Privy request to rein cosign privy's /sign, and add the signature it returns");
    log("  to its own in privy-authorization-signature (comma-separated). A 202 means a person is deciding: retry later.");
    log("Keep REIN_PRIVY_AUTH_KEY only where the co-signer runs, and the admin key away from the agent.");
    return 0;
  }
  if (o.cmd === "setup") {
    if (o.vendor !== "turnkey") throw new Error("rein cosign setup takes turnkey or privy");
    const pub = env.REIN_TURNKEY_PUBLIC_KEY;
    if (!pub) throw new Error("set REIN_TURNKEY_PUBLIC_KEY (rein cosign keygen makes one)");
    if (o.send && (!o.organization || !o.agentUser)) throw new Error("--send needs --organization and --agent-user");
    const { apply } = require("./apply");
    const ids = await apply(turnkeySetup(), {
      vars: { turnkey_organization_id: o.organization, turnkey_agent_user_id: o.agentUser, rein_public_key: pub },
      send: o.send,
      env,
      fetch: fetchImpl,
      log,
    });
    log("");
    log(o.send ? `Rein is the second key (co-signer user ${ids["cosigner.id"]}, policy ${ids["policy.id"]}).` : "Nothing was sent. Add --send to make these requests.");
    log("Check three things, or the agent can get around it:");
    log("  1. The agent's user is not in the root quorum.");
    log("  2. No other policy lets the agent sign alone, apart from the learned limits (rein apply turnkey.json).");
    log("  3. REIN_TURNKEY_PRIVATE_KEY is only where the co-signer runs: rein cosign turnkey --organization " + (o.organization || "<org id>"));
    return 0;
  }
  if (o.cmd === "turnkey") {
    if (!o.organization) throw new Error("--organization is required");
    if (!env.REIN_TURNKEY_PUBLIC_KEY || !env.REIN_TURNKEY_PRIVATE_KEY) throw new Error("set REIN_TURNKEY_PUBLIC_KEY and REIN_TURNKEY_PRIVATE_KEY (rein cosign keygen)");
    const client = turnkeyClient({ organizationId: o.organization, publicKey: env.REIN_TURNKEY_PUBLIC_KEY, privateKey: env.REIN_TURNKEY_PRIVATE_KEY, fetch: fetchImpl });
    const run = () => tick({ client, organizationId: o.organization, env, webhook: o.webhook, fetch: fetchImpl, log });
    if (o.once) {
      const d = await run();
      log(`approved ${d.approved.length}, rejected ${d.rejected.length}, holding ${d.held.length}, left for a person ${d.left.length}`);
      return 0;
    }
    log(`Rein co-signer on Turnkey organization ${o.organization}, checking every ${o.every}s.`);
    for (;;) {
      await run().catch((err) => log(`could not check: ${err.message}`));
      await new Promise((r) => setTimeout(r, o.every * 1000));
    }
  }
  if (o.cmd === "privy") {
    const need = ["REIN_PRIVY_AUTH_KEY", "PRIVY_APP_ID", "PRIVY_APP_SECRET"].filter((k) => !env[k]);
    if (need.length) throw new Error(`set ${need.join(", ")}`);
    const server = http.createServer(privyHandler({ env, appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET, key: env.REIN_PRIVY_AUTH_KEY, token: env.REIN_COSIGN_TOKEN || null, fetch: fetchImpl, log }));
    await new Promise((r) => server.listen(o.port, r));
    log(`Rein co-signer for Privy app ${env.PRIVY_APP_ID} on port ${o.port}: POST /sign${env.REIN_COSIGN_TOKEN ? " (bearer token required)" : ""}.`);
    return null; // runs until stopped
  }
  throw new Error(`unknown cosign command ${o.cmd}`);
}

module.exports = { main, tick, readActivity, turnkeyClient, turnkeySetup, readPrivyRequest, privyHandler, privySetup, keygen, parse, USAGE, SIGNING };
