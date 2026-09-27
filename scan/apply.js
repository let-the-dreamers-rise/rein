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
// Privy is the one sent from here: its API takes Basic auth from the app id
// and secret (PRIVY_APP_ID, PRIVY_APP_SECRET). Turnkey signs every request
// with the API key and Coinbase CDP with a JWT; their SDKs do that, so for
// them this prints the bodies to submit through the SDK or CLI.
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

/// Runs (or, without `send`, prints) a plan. Resolves with the ids created.
async function apply(plan, { vars = {}, send = false, env = process.env, fetch: fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const known = { now_ms: String(Date.now()), ...vars };
  const canSend = plan.vendor === "privy";
  if (send && !canSend) throw new Error(`${plan.vendor} requests must be signed by its SDK; run without --send to print them`);
  let headers = { "content-type": "application/json" };
  if (plan.vendor === "privy") {
    if (send && (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET)) throw new Error("set PRIVY_APP_ID and PRIVY_APP_SECRET (Privy dashboard, App settings)");
    const id = env.PRIVY_APP_ID || "$PRIVY_APP_ID";
    const auth = env.PRIVY_APP_SECRET ? Buffer.from(`${id}:${env.PRIVY_APP_SECRET}`).toString("base64") : "$(printf %s \"$PRIVY_APP_ID:$PRIVY_APP_SECRET\" | base64)";
    headers = { ...headers, "privy-app-id": id, authorization: `Basic ${auth}` };
  }

  // What the user must supply before anything is sent.
  const missing = (plan.fill || []).filter((k) => known[k] == null);
  if (send && missing.length) throw new Error(`missing ${missing.map((k) => `--${k.replace(/^privy_|^turnkey_|^cdp_/, "").replace(/_/g, "-")}`).join(", ")}`);

  for (const [i, s] of plan.steps.entries()) {
    const req = fillIn(s.request, known);
    const open = holes(req).filter((k) => !/\.id$/.test(k) || send);
    log(`\n# ${i + 1}. ${s.step}${s.request.auth && !canSend ? `\n#    auth: ${s.request.auth}` : ""}`);
    if (!send) {
      log(canSend ? curl(req, headers) : `${req.method} ${req.url}\n${JSON.stringify(req.body, null, 2)}`);
      continue;
    }
    if (open.length) throw new Error(`step ${i + 1} still has ${open.map((k) => `{{${k}}}`).join(", ")}`);
    const res = await fetchImpl(req.url, { method: req.method, headers, body: JSON.stringify(req.body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`step ${i + 1} (${s.step}) answered ${res.status}: ${text.slice(0, 400)}`);
    const body = text ? JSON.parse(text) : {};
    if (s.returns) {
      if (!body.id) throw new Error(`step ${i + 1} returned no id: ${text.slice(0, 200)}`);
      known[`${s.returns}.id`] = body.id;
      log(`   created ${s.returns} ${body.id}`);
    } else log("   done");
  }
  return Object.fromEntries(Object.entries(known).filter(([k]) => k.endsWith(".id")));
}

module.exports = { apply, fillIn, holes };
