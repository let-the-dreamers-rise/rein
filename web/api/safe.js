// Reads a Safe's public queue for the /safe page when Safe's gateway refuses a
// browser. GET only, and only the three read paths the page uses: nothing else
// passes through. No key, no state.
const GATEWAY = "https://safe-client.safe.global";
const ALLOWED = [
  /^\/v1\/chains\/\d{1,10}\/safes\/0x[0-9a-fA-F]{40}$/,
  /^\/v1\/chains\/\d{1,10}\/safes\/0x[0-9a-fA-F]{40}\/transactions\/queued$/,
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

async function handler(req, res, fetchImpl = globalThis.fetch) {
  res.setHeader("access-control-allow-origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const url = target(req.url);
  if (!url) return res.status(404).json({ error: "not a Safe read Rein uses" });
  try {
    const r = await fetchImpl(url, { headers: { accept: "application/json" } });
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
