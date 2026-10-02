// rein approvals: approve or refuse held payments from Slack.
//
//   REIN_APPROVAL_SECRET=… npx rein-wallet approvals --public-url https://rein.example.com \
//     --webhook "$SLACK_WEBHOOK_URL"
//
// `check` holds a payment outside the agent's limits until a person decides.
// This small server watches the guards on this machine, posts each new hold to
// Slack with an Approve link and a Refuse link, and applies what the person
// picks. An approval lets that one payment through once, within the hour.
//
// Each link carries a signature made with REIN_APPROVAL_SECRET, so only
// someone who got the Slack message can use it. Opening a link only shows the
// payment; the decision is a button on that page, because Slack opens links
// itself to draw previews. Keep the secret where the agent can't read it: an
// agent that can read it, or can write the guard file, can approve itself.
// The co-signer, where the wallet vendor enforces the second key, removes
// that last gap.
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { loadGuard, saveGuard, decide, withLock, home } = require("./guard");

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sign = (secret, wallet, id) => crypto.createHmac("sha256", secret).update(`${wallet.toLowerCase()}:${id}`).digest("hex").slice(0, 32);
const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y); // byte lengths: "é" is one character, two bytes
};

function guardFiles(env) {
  const dir = path.join(home(env), "guards");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f)) : [];
}

const link = (base, secret, wallet, id) => `${base.replace(/\/$/, "")}/h/${wallet}/${id}?k=${sign(secret, wallet, id)}`;

function slackText(guard, h, url) {
  const short = `${guard.wallet.slice(0, 6)}…${guard.wallet.slice(-4)}`;
  return `Rein is holding a payment from ${short}: ${h.what}.\nWhy: ${h.explanation}.\n<${url}|Approve or refuse it>. Nothing moves unless someone approves.`;
}

/// One pass: marks every guard as served by this approvals page, and posts
/// each hold not yet announced. Returns the number posted.
async function announce({ env, secret, publicUrl, webhook, fetch: fetchImpl = globalThis.fetch, now = Math.floor(Date.now() / 1000) }) {
  let posted = 0;
  for (const file of guardFiles(env)) {
    let fresh = [];
    let guard;
    withLock(file, () => {
      guard = loadGuard(file, env).guard;
      guard.approvals = publicUrl;
      fresh = (guard.holds || []).filter((h) => h.status === "waiting" && h.until > now && !h.announced);
      for (const h of fresh) h.announced = new Date(now * 1000).toISOString();
      saveGuard(guard, file);
    });
    for (const h of fresh) {
      const text = slackText(guard, h, link(publicUrl, secret, guard.wallet, h.id));
      if (webhook) await fetchImpl(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, content: text }) }).catch(() => {});
      posted++;
    }
  }
  return posted;
}

function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#1c1917;background:#fafaf9}h1{font-size:22px}
.b{display:inline-block;font:inherit;padding:10px 18px;border-radius:8px;border:1px solid #1c1917;margin-right:8px;cursor:pointer}.y{background:#1c1917;color:#fff}.n{background:#fff}
code{font-size:14px;word-break:break-all}</style>${body}`;
}

/// The HTTP handler: GET shows a hold, POST .../approve or .../deny decides it.
function handler({ env, secret }) {
  return (req, res) => {
    const url = new URL(req.url, "http://x");
    const m = /^\/h\/(0x[0-9a-fA-F]{40})\/([0-9a-f]{8})(?:\/(approve|deny))?$/.exec(url.pathname);
    const send = (code, html) => {
      res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" });
      res.end(html);
    };
    if (!m) return send(404, page("Not found", "<h1>Not found</h1>"));
    const [, wallet, id, action] = m;
    const k = url.searchParams.get("k") || "";
    if (!same(k, sign(secret, wallet, id))) return send(403, page("Link not valid", "<h1>This link isn't valid</h1><p>Use the link from the Slack message.</p>"));
    let guard;
    let file;
    try {
      ({ guard, file } = loadGuard(wallet, env));
    } catch (err) {
      return send(404, page("Not found", `<h1>Not found</h1><p>${esc(err.message)}</p>`));
    }
    const h = (guard.holds || []).find((x) => x.id === id);
    if (!h) return send(404, page("Not found", "<h1>That hold has expired</h1>"));
    if (req.method === "POST" && action) {
      try {
        withLock(file, () => {
          const g = loadGuard(file, env).guard;
          decide(g, id, action === "approve" ? "approved" : "denied");
          saveGuard(g, file);
        });
      } catch (err) {
        return send(409, page("Already decided", `<h1>Nothing changed</h1><p>${esc(err.message)}</p>`));
      }
      return send(200, page("Done", action === "approve" ? "<h1>Approved</h1><p>The agent's next try of this same payment, within the hour, goes through once.</p>" : "<h1>Refused</h1><p>It stays blocked.</p>"));
    }
    const q = `?k=${esc(k)}`;
    const body =
      h.status === "waiting"
        ? `<form method="post" action="/h/${wallet}/${id}/approve${q}" style="display:inline"><button class="b y">Approve this payment</button></form><form method="post" action="/h/${wallet}/${id}/deny${q}" style="display:inline"><button class="b n">Refuse</button></form>`
        : `<p>Already <b>${esc(h.status)}</b>.</p>`;
    return send(200, page("Held payment", `<h1>Rein is holding a payment</h1><p>From <code>${esc(guard.wallet)}</code>: <b>${esc(h.what)}</b>.</p><p>Why: ${esc(h.explanation)}.</p><p>Held at ${esc(h.at.slice(0, 16).replace("T", " "))} UTC.</p>${body}`));
  };
}

function parse(argv) {
  const o = { port: Number(process.env.PORT) || 8787, publicUrl: null, webhook: process.env.REIN_WEBHOOK || null, every: 2 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") o.port = Number(argv[++i]);
    else if (a === "--public-url") o.publicUrl = argv[++i];
    else if (a === "--webhook") o.webhook = argv[++i];
    else if (a === "--every") o.every = Number(argv[++i]);
    else if (a === "-h" || a === "--help") o.help = true;
    else throw new Error(`unknown flag ${a}`);
  }
  return o;
}

const USAGE = `usage: REIN_APPROVAL_SECRET=<long random string> rein approvals --public-url https://<where this is reachable> --webhook <Slack URL> [--port 8787]`;

async function main(argv, { env = process.env, log = console.error } = {}) {
  const o = parse(argv);
  const secret = env.REIN_APPROVAL_SECRET;
  if (o.publicUrl && !/^https:\/\//.test(o.publicUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(o.publicUrl)) {
    console.error("--public-url must be https (approval links carry a secret), or http://localhost while you try it");
    return 2;
  }
  if (o.webhook && !/^https?:\/\//.test(o.webhook)) {
    console.error("--webhook must be a URL (a Slack or Discord incoming webhook)");
    return 2;
  }
  if (o.help || !o.publicUrl || !secret || secret.length < 16) {
    console.error(USAGE);
    if (!o.help && (!secret || secret.length < 16)) console.error("REIN_APPROVAL_SECRET must be set, 16 characters or more, and kept where the agent can't read it.");
    return o.help ? 0 : 2;
  }
  const server = http.createServer(handler({ env, secret }));
  await new Promise((r, j) => {
    server.once("error", (err) => j(err.code === "EADDRINUSE" ? new Error(`port ${o.port} is already in use; stop whatever holds it or pass --port`) : err));
    server.listen(o.port, r);
  });
  log(`Approvals on ${o.publicUrl} (listening on ${o.port}). Watching ${guardFiles(env).length} guard(s) in ${path.join(home(env), "guards")}.`);
  const tick = () => announce({ env, secret, publicUrl: o.publicUrl, webhook: o.webhook }).catch((err) => log(`could not announce: ${err.message}`));
  await tick();
  setInterval(tick, o.every * 1000);
  return null; // runs until stopped
}

module.exports = { main, handler, announce, sign, link, parse, USAGE };
