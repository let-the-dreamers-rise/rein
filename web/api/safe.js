// Reads a Safe's public queue for the /safe page when Safe's gateway refuses a
// browser. GET only, and only the Safe read paths the page uses: nothing else
// passes through. No key, and no state unless the read count below is
// switched on.
const GATEWAY = "https://safe-client.safe.global";
const ALLOWED = [
  /^\/v1\/chains\/\d{1,10}\/safes\/0x[0-9a-fA-F]{40}$/,
  /^\/v1\/chains\/\d{1,10}\/safes\/0x[0-9a-fA-F]{40}\/transactions\/(queued|history)$/,
  /^\/v1\/chains\/\d{1,10}\/transactions\/[A-Za-z0-9_:-]{1,200}$/,
];
const QUERY = new Set(["cursor", "trusted"]);

function target(rawUrl) {
  const u = new URL(rawUrl, "http://x");
  // vercel.json rewrites /api/safe/<path> to /api/safe?path=<path>; a direct
  // /api/safe/<path> works too.
  const path = u.searchParams.has("path") ? `/${u.searchParams.get("path").replace(/^\/+/, "")}` : u.pathname.replace(/^\/api\/safe/, "");
  if (!ALLOWED.some((re) => re.test(path))) return null;
  const q = new URLSearchParams();
  for (const [k, v] of u.searchParams) if (QUERY.has(k) && v.length <= 500) q.set(k, v);
  const s = q.toString();
  return `${GATEWAY}${path}${s ? `?${s}` : ""}`;
}

/// What kind of read a gateway URL is, with no address in it: "8453 safe",
/// "8453 queued", "8453 history" or "8453 tx".
function kindOf(url) {
  const m = url.match(/\/v1\/chains\/(\d+)\/(?:safes\/0x[0-9a-fA-F]{40}(?:\/transactions\/(queued|history))?|(transactions)\/)/);
  return m ? `${m[1]} ${m[2] || (m[3] ? "tx" : "safe")}` : "other";
}

/// A daily count of relay reads by chain and kind, never an address. Off
/// unless a Redis REST store (Upstash or Vercel KV) is configured; /privacy
/// must say so in the same deploy that turns it on.
function count(url, env, fetchImpl) {
  const base = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) return Promise.resolve(false);
  const key = `relay:${new Date().toISOString().slice(0, 10)}:${kindOf(url).replace(" ", ":")}`;
  const call = fetchImpl(`${base.replace(/\/$/, "")}/incr/${encodeURIComponent(key)}`, { method: "POST", headers: { authorization: `Bearer ${token}` } }).then(() => true, () => false);
  // Never slows the read: give up after 300 ms.
  return Promise.race([call, new Promise((r) => setTimeout(() => r(false), 300))]);
}

async function handler(req, res, fetchImpl = globalThis.fetch, env = process.env) {
  res.setHeader("access-control-allow-origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const url = target(req.url);
  if (!url) return res.status(404).json({ error: "not a Safe read Rein uses" });
  const counted = count(url, env, fetchImpl);
  try {
    const r = await fetchImpl(url, { headers: { accept: "application/json" } });
    await counted;
    res.setHeader("cache-control", "public, s-maxage=15, max-age=0");
    res.status(r.status);
    res.setHeader("content-type", "application/json");
    return res.end(await r.text());
  } catch {
    return res.status(502).json({ error: "Safe's gateway didn't answer" });
  }
}

module.exports = handler;
module.exports.target = target;
module.exports.kindOf = kindOf;
