// rein apply: put an exported policy on the wallet engine it was written for.
//
//   rein apply report/export/privy.json --wallet <privy wallet id>          prints the requests
//   rein apply report/export/privy.json --wallet <privy wallet id> --send   makes them
//
// Each export is an ordered list of requests (see v2/export.js). This fills
// in the {{placeholders}}: the ids you pass, and the id each earlier step
// returned (the window before the policy that references it, the policy
// before the wallet it is attached to). Without --send it only prints, as
// curl, so the requests can be read, or run by hand, first.
//
// Credentials come from the environment, named as each vendor's SDK names
// them, and never leave this machine except as the signed request:
//
//   Privy         PRIVY_APP_ID, PRIVY_APP_SECRET (Basic auth), and
//                 PRIVY_AUTHORIZATION_KEY when the wallet has an owner whose
//                 signature a change needs
//   Turnkey       TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY (each request stamped)
//   Coinbase CDP  CDP_API_KEY_ID, CDP_API_KEY_SECRET, and CDP_WALLET_SECRET for
//                 the attach (a JWT per request; see scan/sign.js)
const sign = require("./sign");

const HOLE = /\{\{([^}]+)\}\}/g;

function fillIn(value, vars) {
  if (typeof value === "string") return value.replace(HOLE, (m, k) => (vars[k] != null ? String(vars[k]) : m));
  if (Array.isArray(value)) return value.map((v) => fillIn(v, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillIn(v, vars)]));
  return value;
}

const holes = (value) => [...new Set([...JSON.stringify(value).matchAll(HOLE)].map((m) => m[1]))];

function curl(req, headers) {
  const h = Object.entries(headers).map(([k, v]) => ` \\\n  -H "${k}: ${v}"`).join("");
  return `curl -X ${req.method} '${req.url}'${h} \\\n  -d '${JSON.stringify(req.body).replace(/'/g, "'\\''")}'`;
}

// The `rein apply` flag that fills each id only the wallet's owner has.
const FLAG = {
  privy_wallet_id: "--wallet",
  turnkey_organization_id: "--organization",
  turnkey_agent_user_id: "--agent-user",
  turnkey_agent_user_tag_id: "--agent-tag",
  cdp_account_address: "--account",
};

const NEEDS = {
  privy: ["PRIVY_APP_ID", "PRIVY_APP_SECRET"],
  turnkey: ["TURNKEY_API_PUBLIC_KEY", "TURNKEY_API_PRIVATE_KEY"],
  coinbase: ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET"],
};

/// The headers one request needs, signed over the exact body that is sent.
function authHeaders(vendor, req, body, env) {
  const h = { "content-type": "application/json" };
  if (vendor === "privy") {
    const out = { ...h, "privy-app-id": env.PRIVY_APP_ID, authorization: `Basic ${Buffer.from(`${env.PRIVY_APP_ID}:${env.PRIVY_APP_SECRET}`).toString("base64")}` };
    // A wallet that has an owner changes only with the owner's signature.
    if (env.PRIVY_AUTHORIZATION_KEY && req.method === "PATCH" && /\/wallets\//.test(req.url)) {
      out["privy-authorization-signature"] = sign.privySignature({ method: req.method, url: req.url, body: JSON.parse(body), headers: { "privy-app-id": env.PRIVY_APP_ID } }, env.PRIVY_AUTHORIZATION_KEY);
    }
    return out;
  }
  if (vendor === "turnkey") {
    return { ...h, "X-Stamp": sign.turnkeyStamp(body, { publicKey: env.TURNKEY_API_PUBLIC_KEY, privateKey: env.TURNKEY_API_PRIVATE_KEY }) };
  }
  if (vendor === "coinbase") {
    const out = { ...h, authorization: `Bearer ${sign.cdpJwt({ keyId: env.CDP_API_KEY_ID, keySecret: env.CDP_API_KEY_SECRET, method: req.method, url: req.url })}` };
    if (sign.cdpNeedsWalletAuth(req.method, req.url)) {
      if (!env.CDP_WALLET_SECRET) throw new Error("attaching a policy to a CDP account needs CDP_WALLET_SECRET (CDP portal, Server Wallet)");
      out["X-Wallet-Auth"] = sign.cdpWalletJwt({ walletSecret: env.CDP_WALLET_SECRET, method: req.method, url: req.url, body: req.body });
    }
    return out;
  }
  throw new Error(`no signer for ${vendor}`);
}

/// The id a step created, where each vendor puts it. Turnkey answers with an
/// activity, which a policy needing more approvers leaves pending.
function created(vendor, body) {
  if (vendor !== "turnkey") return { id: body.id };
  const a = body.activity || {};
  if (a.status && a.status !== "ACTIVITY_STATUS_COMPLETED") return { pending: a.status, activityId: a.id };
  const r = a.result || {};
  return { id: r.createPolicyResult?.policyId || r.createSmartContractInterfaceResult?.smartContractInterfaceId || r.createApiOnlyUsersResult?.userIds?.[0] };
}

/// Runs (or, without `send`, prints) a plan. Resolves with the ids created.
async function apply(plan, { vars = {}, send = false, env = process.env, fetch: fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const known = { ...vars };
  const vendor = plan.vendor;
  if (!NEEDS[vendor]) throw new Error(`unknown vendor ${vendor}`);
  const unset = NEEDS[vendor].filter((k) => !env[k]);
  if (send && unset.length) throw new Error(`set ${unset.join(" and ")}`);

  // What the user must supply before anything is sent.
  const missing = holes(plan.steps.map((s) => s.request)).filter((k) => known[k] == null && k !== "now_ms" && !k.endsWith(".id"));
  if (send && missing.length) throw new Error(`missing ${missing.map((k) => FLAG[k] || `{{${k}}}`).join(", ")}`);

  for (const [i, s] of plan.steps.entries()) {
    const req = fillIn(s.request, { ...known, now_ms: String(Date.now()) });
    log(`\n# ${i + 1}. ${s.step}`);
    if (!send) {
      if (vendor === "privy") {
        log(curl(req, { "content-type": "application/json", "privy-app-id": "$PRIVY_APP_ID", authorization: 'Basic $(printf %s "$PRIVY_APP_ID:$PRIVY_APP_SECRET" | base64)' }));
      } else log(`${req.method} ${req.url}   (signed at send time with ${NEEDS[vendor].join(", ")})\n${JSON.stringify(req.body, null, 2)}`);
      continue;
    }
    const open = holes(req);
    if (open.length) throw new Error(`step ${i + 1} still has ${open.map((k) => `{{${k}}}`).join(", ")}`);
    const body = JSON.stringify(req.body);
    const res = await fetchImpl(req.url, { method: req.method, headers: authHeaders(vendor, req, body, env), body });
    const text = await res.text();
    if (!res.ok) throw new Error(`step ${i + 1} (${s.step}) answered ${res.status}: ${text.slice(0, 400)}`);
    const got = created(vendor, text ? JSON.parse(text) : {});
    if (got.pending) throw new Error(`step ${i + 1} is waiting for approval in ${vendor} (${got.pending}, activity ${got.activityId}); approve it there, then run the remaining steps`);
    if (s.returns) {
      if (!got.id) throw new Error(`step ${i + 1} returned no id: ${text.slice(0, 200)}`);
      known[`${s.returns}.id`] = got.id;
      log(`   created ${s.returns} ${got.id}`);
    } else log("   done");
  }
  return Object.fromEntries(Object.entries(known).filter(([k]) => k.endsWith(".id")));
}

module.exports = { apply, fillIn, holes, authHeaders, created };
