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
const { ensureGuard } = require("./protect");
const { CHAINS } = require("./blockscout");

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
      if (!calls.length) return { unreadable: "it carries no calls" };
      const from = ethers.getAddress(send.from);
      const txs = calls.map((c) => ({ from, to: c.to, data: c.data || "0x", value: String(c.value ?? 0) }));
      // Several calls under one signature are judged together, as one payment.
      return { tx: txs.length > 1 ? { from, calls: txs } : txs[0], chainId: caip2(send.caip2) };
    }
    // A typed-data signature (x402, Permit): Turnkey's viem signer sends it as
    // a raw payload whose encoding says it is EIP-712, and the payload is the
    // typed data itself, so Rein can read what it moves.
    const raw = i.signRawPayloadIntentV2;
    if (raw && raw.encoding === "PAYLOAD_ENCODING_EIP712") {
      if (!isAddress(raw.signWith)) return { unreadable: "it signs with a key id, not a wallet address Rein guards" };
      const td = JSON.parse(raw.payload);
      if (!td || !td.primaryType || !td.message || !td.types) return { unreadable: "its EIP-712 payload isn't typed data Rein can read" };
      const chainId = td.domain?.chainId != null ? Number(td.domain.chainId) : null;
      return { tx: { from: ethers.getAddress(raw.signWith), domain: td.domain, types: td.types, primaryType: td.primaryType, message: td.message }, chainId };
    }
    if (raw && raw.encoding === "PAYLOAD_ENCODING_EIP7702_AUTHORIZATION") return { unreadable: "it hands the wallet's code to a contract (EIP-7702), which isn't a payment" };
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
  // A vote goes to the organization the activity lives in: a sub-organization,
  // when an app gives each user one.
  const vote = (kind) => (fingerprint, org = organizationId) =>
    post(`/public/v1/submit/${kind}_activity`, { type: `ACTIVITY_TYPE_${kind.toUpperCase()}_ACTIVITY`, timestampMs: String(Date.now()), organizationId: org, parameters: { fingerprint } });
  return {
    waiting: async () => (await post("/public/v1/query/list_activities", { organizationId, filterByStatus: ["ACTIVITY_STATUS_CONSENSUS_NEEDED"], filterByType: SIGNING, paginationOptions: { limit: "100" } })).activities || [],
    get: async (activityId, org = organizationId) => (await post("/public/v1/query/get_activity", { organizationId: org, activityId })).activity || null,
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
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/// One pass over the signing requests waiting on Rein. Returns what it did:
/// { approved, rejected, held, left } as lists of activity ids.
async function tick({ client, organizationId, env = process.env, webhook = null, fetch: fetchImpl = globalThis.fetch, log = () => {}, now = () => Math.floor(Date.now() / 1000), learn = true, cohort = null, activities = null }) {
  const file = statePath(organizationId, env);
  const state = loadState(file);
  const done = { approved: [], rejected: [], held: [], left: [] };
  const tell = (text) => webhook && fetchImpl(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, content: text }) }).catch(() => {});
  // Polling reads what is waiting in one organization; a Turnkey webhook hands
  // over activities from any of its sub-organizations, fresh from Turnkey.
  const given = activities != null;
  const waiting = given ? activities.filter(Boolean) : await client.waiting();
  for (const a of waiting) {
    const org = a.organizationId || organizationId;
    if (given && a.status && a.status !== "ACTIVITY_STATUS_CONSENSUS_NEEDED") {
      delete state.activities[a.id]; // signed, rejected or expired in Turnkey
      continue;
    }
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
      // A wallet Rein hasn't seen: learn its limits from its history (or start
      // it from the cohort, or in learning mode), so a platform with many
      // wallets sets nothing up per wallet.
      if (learn) {
        try {
          const chain = Object.keys(CHAINS).find((k) => CHAINS[k].chainId === r.chainId) || "base";
          await ensureGuard(r.tx.from, { chain, env, fetch: fetchImpl, cohort });
          guard = loadGuard(r.tx.from, env).guard;
          log(`set up a guard for ${r.tx.from}`);
        } catch (err) {
          leave(`Rein couldn't set up a guard for ${r.tx.from}: ${err.message}`);
          continue;
        }
      } else {
        leave(`Rein has no guard for ${r.tx.from} on this machine (rein guard ${r.tx.from} sets one up)`);
        continue;
      }
    }
    if (guard.chainId && r.chainId && guard.chainId !== r.chainId) {
      leave(`it is for chain ${r.chainId}, and ${guard.wallet}'s limits were learned on chain ${guard.chainId}`);
      continue;
    }
    if (seen?.status === "held") {
      const h = (guard.holds || []).find((x) => x.id === seen.hold);
      if (h && h.status === "waiting" && h.until > now()) continue; // a person hasn't decided yet
      if (!h || h.status === "denied" || h.until <= now()) {
        await client.reject(a.fingerprint, org);
        delete state.activities[a.id];
        done.rejected.push(a.id);
        log(`rejected ${a.id}: ${h ? "a person refused it" : "nobody approved it in time"}`);
        continue;
      }
      // approved: the check below lets it through once
    }
    const v = check(r.tx, { env, wallet: r.tx.from, now: now(), fetch: fetchImpl, enforced: true });
    if (v.allow) {
      await client.approve(a.fingerprint, org);
      delete state.activities[a.id];
      done.approved.push(a.id);
      log(`approved ${a.id}: ${v.explanation}`);
    } else if (v.refused) {
      await client.reject(a.fingerprint, org);
      delete state.activities[a.id];
      done.rejected.push(a.id);
      log(`rejected ${a.id}: a person refused this payment`);
    } else if (v.held) {
      state.activities[a.id] = { status: "held", hold: v.held, wallet: guard.wallet, org, at: new Date(now() * 1000).toISOString() };
      done.held.push(a.id);
      log(`holding ${a.id} for a person: ${v.explanation} (rein guard ${guard.wallet} --allow ${v.held})`);
    } else leave(v.explanation);
  }
  // Forget what Turnkey no longer has waiting (signed, rejected, or expired there).
  if (!given) {
    const live = new Set(waiting.map((a) => a.id));
    for (const id of Object.keys(state.activities)) if (!live.has(id)) delete state.activities[id];
  }
  saveState(state, file);
  return done;
}

/// Activities Rein is holding for a person, fetched again from Turnkey, so a
/// decision made since (rein guard --allow / --deny) reaches Turnkey.
async function recheck({ client, organizationId, env = process.env, ...rest }) {
  const state = loadState(statePath(organizationId, env));
  const held = Object.entries(state.activities).filter(([, x]) => x.status === "held");
  if (!held.length) return { approved: [], rejected: [], held: [], left: [] };
  const fresh = await Promise.all(held.map(([id, x]) => client.get(id, x.org || organizationId).catch(() => ({ id, status: "ACTIVITY_STATUS_GONE" }))));
  return tick({ client, organizationId, env, ...rest, activities: fresh });
}

/// For an app with a sub-organization per user, where polling each one can't
/// scale: a webhook endpoint on the parent organization gets ACTIVITY_UPDATES
/// for the parent and every sub-organization. The webhook is only a doorbell:
/// Rein reads the activity again from Turnkey, signed with its own key, and
/// judges that, so a forged delivery can't make it approve anything.
function turnkeyWebhookHandler({ client, organizationId, env = process.env, log = () => {}, ...rest }) {
  let queue = Promise.resolve();
  // A flood of deliveries can't pile up without end: each activity is
  // queued once, and past MAX_WAITING the sender is told to try later.
  const MAX_WAITING = 200;
  const waiting = new Set();
  const handle = async (a) => {
    const fresh = await client.get(a.id, a.organizationId || organizationId);
    if (!fresh || fresh.status !== "ACTIVITY_STATUS_CONSENSUS_NEEDED" || !SIGNING.includes(fresh.type)) return null;
    return tick({ client, organizationId, env, log, ...rest, activities: [fresh] });
  };
  const handler = async (req, res) => {
    const send = (code, body) => {
      if (res.headersSent) return;
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      return await receive(req, send);
    } catch {
      return send(400, { error: "Rein couldn't read that delivery" });
    }
  };
  const ID = /^[A-Za-z0-9_-]{1,128}$/;
  const receive = async (req, send) => {
    if (req.method !== "POST") return send(404, { error: "POST a Turnkey ACTIVITY_UPDATES delivery" });
    let body;
    try {
      let raw = "";
      for await (const c of req) if ((raw += c).length > 1e6) throw new Error("too large");
      body = JSON.parse(raw);
    } catch (err) {
      return send(400, { error: `not JSON: ${err.message}` });
    }
    const a = body?.activity || body?.data?.activity || body?.data || body;
    // Only the id and organization are used, and only to read the activity
    // again from Turnkey: anything else in a delivery is never trusted.
    if (typeof a?.id !== "string" || !ID.test(a.id) || (a.organizationId != null && (typeof a.organizationId !== "string" || !ID.test(a.organizationId)))) return send(200, { ignored: true });
    if ((a.status && a.status !== "ACTIVITY_STATUS_CONSENSUS_NEEDED") || (a.type && !SIGNING.includes(a.type))) return send(200, { ignored: true });
    if (waiting.has(a.id)) return send(202, { checking: a.id });
    if (waiting.size >= MAX_WAITING) return send(503, { error: "busy; Turnkey will deliver again" });
    waiting.add(a.id);
    send(202, { checking: a.id });
    // One at a time: the guard's hourly totals and the held list stay consistent.
    const { id, organizationId: org } = a;
    queue = queue
      .then(() => handle({ id, organizationId: org }))
      .catch((err) => log(`could not check ${id}: ${String(err?.message ?? err)}`))
      .finally(() => waiting.delete(id));
  };
  handler.idle = () => queue;
  // The periodic re-check runs in the same line, so it never overwrites
  // what a delivery just wrote to the state file.
  handler.run = (fn) => {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
  };
  return handler;
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
function turnkeySetup({ webhookUrl = null } = {}) {
  // Once, in the parent organization: a webhook for the parent and every
  // sub-organization under it, so Rein needn't poll each one.
  if (webhookUrl) {
    return {
      vendor: "turnkey",
      steps: [
        {
          step: "tell Rein about signing requests in this organization and every sub-organization under it",
          returns: "webhook",
          request: activity("ACTIVITY_TYPE_CREATE_WEBHOOK_ENDPOINT", "create_webhook_endpoint", { url: webhookUrl, name: "Rein co-signer", subscriptions: [{ eventType: "ACTIVITY_UPDATES" }] }),
        },
      ],
    };
  }
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
  if (typeof b.method !== "string" || !PAYMENT_METHODS.includes(b.method)) return { refuse: `Rein co-signs payments (${PAYMENT_METHODS.join(", ")}); ${typeof b.method === "string" ? b.method.slice(0, 40) : "this"} is not one` };
  if (b.method === "eth_signTypedData_v4") {
    const td = b.params?.typed_data || {};
    const ids = [caip2(b.caip2), td.domain?.chainId != null ? Number(td.domain.chainId) : null].filter((x) => x != null);
    if (new Set(ids).size > 1) return { refuse: `it names two chains (${ids.join(" and ")})` };
    return { walletId: m[1], tx: { domain: td.domain, types: td.types, primaryType: td.primary_type ?? td.primaryType, message: td.message }, chainId: ids[0] ?? null };
  }
  const t = b.params?.transaction || {};
  if (typeof t.to !== "string" || !isAddress(t.to)) return { refuse: "the transaction has no recipient Rein can read" };
  if (t.data != null && (typeof t.data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(t.data))) return { refuse: "its calldata isn't hex" };
  let value;
  try {
    if (t.value != null && typeof t.value !== "string" && typeof t.value !== "number") throw new Error("not a number");
    value = BigInt(t.value ?? 0);
    if (value < 0n) throw new Error("negative");
  } catch {
    return { refuse: "its value isn't a whole number of wei" };
  }
  if (t.authorization_list || t.authorizationList || Number(t.type) === 4) return { refuse: "it hands the wallet's code to a contract (EIP-7702), which isn't a payment" };
  if (t.input != null && t.input !== t.data) return { refuse: "it carries calldata in a field Rein doesn't read" };
  const ids = [caip2(b.caip2), t.chain_id != null ? Number(t.chain_id) : null].filter((x) => x != null);
  if (new Set(ids).size > 1) return { refuse: `it names two chains (${ids.join(" and ")})` };
  return { walletId: m[1], tx: { to: t.to, data: t.data || "0x", value: value.toString() }, chainId: ids[0] ?? null };
}

/// POST /sign with the exact request the agent will send to Privy ({ method,
/// url, body, headers }). 200 { signature } to add to its
/// privy-authorization-signature header; 202 { held, next } while a person
/// decides; 403 { reason, explanation } when Rein won't sign.
function privyHandler({ env = process.env, appId, appSecret, key, token = null, fetch: fetchImpl = globalThis.fetch, log = () => {}, learn = true, cohort = null }) {
  const addresses = new Map();
  const walletAddress = async (id) => {
    if (!addresses.has(id)) {
      const res = await fetchImpl(`${PRIVY}/v1/wallets/${id}`, { headers: { "privy-app-id": appId, authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}` } });
      if (!res.ok) throw new Error(`Privy didn't find wallet ${id} (${res.status})`);
      addresses.set(id, ethers.getAddress((await res.json()).address));
    }
    return addresses.get(id);
  };
  const expected = token ? Buffer.from(`Bearer ${token}`) : null;
  const tokenOk = (h) => {
    if (!expected) return true;
    const got = Buffer.from(typeof h === "string" ? h : "");
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  };
  const deeper = (v, n = 0) => n > 32 || (v && typeof v === "object" && Object.values(v).some((x) => deeper(x, n + 1)));
  return async (req, res) => {
    const send = (code, body) => {
      if (res.headersSent) return;
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    // One malformed request must never stop the co-signer: every payment
    // that needs its key would wait until someone restarts it.
    try {
      return await serve(req, send);
    } catch (err) {
      log(`couldn't read a request: ${String(err?.message ?? err).slice(0, 200)}`);
      return send(400, { error: "Rein couldn't read that request" });
    }
  };
  async function serve(req, send) {
    if (req.method !== "POST" || req.url !== "/sign") return send(404, { error: "POST /sign" });
    if (!tokenOk(req.headers.authorization)) return send(401, { error: "wrong or missing bearer token" });
    let request;
    try {
      let raw = "";
      for await (const c of req) if ((raw += c).length > 256e3) throw new Error("too large");
      request = JSON.parse(raw);
    } catch (err) {
      return send(400, { error: `not a JSON request: ${err.message}` });
    }
    if (deeper(request)) return send(400, { error: "nested too deeply to be a Privy request" });
    const refuse = (explanation, reason = "NOT_A_PAYMENT") => (log(`refused: ${explanation}`), send(403, { allow: false, reason, explanation }));
    if (request?.headers?.["privy-app-id"] !== appId) return refuse(`this co-signer serves Privy app ${appId} only`, "WRONG_APP");
    const r = readPrivyRequest(request);
    if (r.refuse) return refuse(r.refuse);
    let address;
    let guard;
    try {
      address = await walletAddress(r.walletId);
    } catch (err) {
      return refuse(`Rein has no guard for that wallet (${err.message})`, "GUARD_ERROR");
    }
    try {
      guard = loadGuard(address, env).guard;
    } catch (err) {
      if (!learn) return refuse(`Rein has no guard for that wallet (${err.message})`, "GUARD_ERROR");
      // First sight of this wallet: learn it, as the Turnkey co-signer does.
      try {
        const chain = Object.keys(CHAINS).find((k) => CHAINS[k].chainId === r.chainId) || "base";
        await ensureGuard(address, { chain, env, fetch: fetchImpl, cohort });
        guard = loadGuard(address, env).guard;
        log(`set up a guard for ${address}`);
      } catch (e) {
        return refuse(`Rein couldn't set up a guard for that wallet (${e.message})`, "GUARD_ERROR");
      }
    }
    if (guard.chainId && r.chainId && guard.chainId !== r.chainId) return refuse(`it is for chain ${r.chainId}, and this wallet's limits were learned on chain ${guard.chainId}`, "WRONG_CHAIN");
    const v = check(r.tx, { env, wallet: address, fetch: fetchImpl, enforced: true });
    if (v.allow) {
      log(`signed for ${address}: ${v.explanation}`);
      return send(200, { ...v, signature: sign.privySignature(request, key) });
    }
    log(`${v.held ? "holding" : "refused"} for ${address}: ${v.explanation}`);
    return send(v.held ? 202 : 403, v);
  }
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
  const o = { cmd: argv[0], vendor: null, learn: true, cohort: null, listen: null, webhookUrl: null, organization: null, agentUser: null, send: false, every: 3, once: false, webhook: process.env.REIN_WEBHOOK || null, port: Number(process.env.PORT) || 8788, vars: {} };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--organization") o.organization = argv[++i];
    else if (a === "--agent-user") o.agentUser = argv[++i];
    else if (a === "--send") o.send = true;
    else if (a === "--every") o.every = Number(argv[++i]);
    else if (a === "--once") o.once = true;
    else if (a === "--cohort") o.cohort = argv[++i];
    else if (a === "--no-learn") o.learn = false;
    else if (a === "--host") o.host = argv[++i];
    else if (a === "--listen") o.listen = Number(argv[++i]);
    else if (a === "--webhook-url") o.webhookUrl = argv[++i];
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
       rein cosign turnkey --organization <org id> [--webhook URL] [--every 3] [--once] [--cohort cohort.json] [--no-learn]
                                               run the co-signer (needs REIN_TURNKEY_PUBLIC_KEY/PRIVATE_KEY). A wallet it
                                               hasn't seen gets limits learned from its history, else the cohort's, else
                                               learning mode; --no-learn leaves those for a person instead
       rein cosign turnkey --organization <parent org id> --listen <port> [same flags]
                                               for an app with a sub-organization per user: judge what Turnkey's
                                               webhook reports, from any sub-organization, instead of polling
       rein cosign setup turnkey --organization <parent org id> --webhook-url https://… [--send]
                                               point that webhook at the co-signer (once, in the parent)
       rein cosign setup privy --wallet <wallet id> --policy <learned policy id> --agent-key <key> --admin-key <key> [--send]
                                               keys are base64 P-256 public keys (needs REIN_PRIVY_PUBLIC_KEY, and
                                               PRIVY_APP_ID/SECRET plus the wallet owner's PRIVY_AUTHORIZATION_KEY to --send)
       rein cosign privy [--port 8788] [--host 127.0.0.1] [--cohort cohort.json] [--no-learn]
                                               run the co-signer (needs REIN_PRIVY_AUTH_KEY, PRIVY_APP_ID/SECRET;
                                               REIN_COSIGN_TOKEN (32+ characters) is required as a bearer token)`;

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
    if (missing.length) log(`Showing the requests with ${missing.map((k) => need[k]).join(", ")} left as placeholders.`);
    // Three different P-256 keys, or the quorum is a quorum of one.
    const keys = { "--agent-key": o.vars.agent_key, "--admin-key": o.vars.admin_key, REIN_PRIVY_PUBLIC_KEY: pub };
    for (const [flag, k] of Object.entries(keys)) {
      if (k == null) continue;
      let ok = false;
      try {
        ok = crypto.createPublicKey({ key: Buffer.from(k, "base64"), format: "der", type: "spki" }).asymmetricKeyDetails?.namedCurve === "prime256v1";
      } catch {
        ok = false;
      }
      if (!ok) throw new Error(`${flag} isn't a P-256 public key in base64 DER (what Privy calls an authorization key's public half)`);
    }
    const given = Object.values(keys).filter(Boolean);
    if (new Set(given).size !== given.length) throw new Error("the agent, admin and Rein keys must be three different keys: any two of them sign for the wallet");
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
    if (o.webhookUrl) {
      if (!/^https:\/\//.test(o.webhookUrl)) throw new Error("--webhook-url must be an https URL Turnkey can reach");
      if (o.send && !o.organization) throw new Error("--send needs --organization (the parent organization)");
      const { apply } = require("./apply");
      const ids = await apply(turnkeySetup({ webhookUrl: o.webhookUrl }), { vars: { turnkey_organization_id: o.organization }, send: o.send, env, fetch: fetchImpl, log });
      log("");
      log(o.send ? `Turnkey now tells Rein about signing requests in ${o.organization} and every sub-organization under it (webhook ${ids["webhook.id"]}).` : "Nothing was sent. Add --send to make this request.");
      log(`Run the co-signer where that URL points: rein cosign turnkey --organization ${o.organization || "<parent org id>"} --listen <port>`);
      log("Each sub-organization still needs Rein's user and policy: rein cosign setup turnkey --organization <sub-org id> --agent-user <user id>,");
      log("best run when the app creates the sub-organization, while its own key is still in the root quorum.");
      return 0;
    }
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
    const cohort = o.cohort ? JSON.parse(fs.readFileSync(o.cohort, "utf8")) : null;
    const run = () => tick({ client, organizationId: o.organization, env, webhook: o.webhook, fetch: fetchImpl, log, learn: o.learn, cohort });
    if (o.listen) {
      keepRunning(log);
      const handler = turnkeyWebhookHandler({ client, organizationId: o.organization, env, webhook: o.webhook, fetch: fetchImpl, log, learn: o.learn, cohort });
      const server = http.createServer(handler);
      await new Promise((r, j) => {
        server.once("error", (err) => j(err.code === "EADDRINUSE" ? new Error(`port ${o.listen} is already in use; stop whatever holds it or pass another --listen port`) : err));
        server.listen(o.listen, r);
      });
      log(`Rein co-signer for Turnkey organization ${o.organization} and its sub-organizations: webhook on port ${o.listen}; held payments re-checked every ${o.every}s.`);
      for (;;) {
        await new Promise((r) => setTimeout(r, o.every * 1000));
        await handler.run(() => recheck({ client, organizationId: o.organization, env, webhook: o.webhook, fetch: fetchImpl, log, learn: o.learn, cohort })).catch((err) => log(`could not re-check held payments: ${err.message}`));
      }
    }
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
    const need = ["REIN_PRIVY_AUTH_KEY", "PRIVY_APP_ID", "PRIVY_APP_SECRET", "REIN_COSIGN_TOKEN"].filter((k) => !env[k]);
    if (need.length) throw new Error(`set ${need.join(", ")}${need.includes("REIN_COSIGN_TOKEN") ? " (REIN_COSIGN_TOKEN: a secret of 32+ characters your agent sends as a bearer token; openssl rand -hex 32 makes one)" : ""}`);
    if (env.REIN_COSIGN_TOKEN.length < 32) throw new Error("REIN_COSIGN_TOKEN must be at least 32 characters (openssl rand -hex 32 makes one)");
    const cohort = o.cohort ? JSON.parse(fs.readFileSync(o.cohort, "utf8")) : null;
    keepRunning(log);
    const server = http.createServer(privyHandler({ env, appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET, key: env.REIN_PRIVY_AUTH_KEY, token: env.REIN_COSIGN_TOKEN || null, fetch: fetchImpl, log, learn: o.learn, cohort }));
    await new Promise((r, j) => {
      server.once("error", (err) => j(err.code === "EADDRINUSE" ? new Error(`port ${o.port} is already in use; stop whatever holds it or pass --port`) : err));
      // This machine only, unless --host says otherwise.
      server.listen(o.port, o.host || "127.0.0.1", r);
    });
    log(`Rein co-signer for Privy app ${env.PRIVY_APP_ID} on ${o.host || "127.0.0.1"}:${o.port}: POST /sign (bearer token required).`);
    return null; // runs until stopped
  }
  throw new Error(`unknown cosign command ${o.cmd}`);
}

/// A long-running co-signer logs a stray rejection instead of exiting: while
/// it is down, every payment that needs its key waits.
function keepRunning(log) {
  if (keepRunning.on) return;
  keepRunning.on = true;
  process.on("unhandledRejection", (err) => log(`kept running after an error: ${String(err?.message ?? err).slice(0, 200)}`));
}

module.exports = { main, tick, recheck, turnkeyWebhookHandler, readActivity, turnkeyClient, turnkeySetup, readPrivyRequest, privyHandler, privySetup, keygen, parse, USAGE, SIGNING };
