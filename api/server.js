#!/usr/bin/env node
// Rein over HTTP, for agents that are not MCP clients.
//
// Same four operations as the MCP server, same domain code underneath, and no
// framework: node:http, a bearer token, and a rate limit. A payments control
// plane that needs a hundred transitive dependencies to answer "may I pay this
// person" is not a payments control plane anyone should put money behind.
//
//   REIN_API_TOKENS   "name:secret,name2:secret2" -- required; without it the
//                     server refuses to start rather than listening openly
//   REIN_API_PORT     default 8402
//   plus the same REIN_RPC_URL / REIN_ACCOUNT / REIN_AGENT_PRIVATE_KEY /
//   REIN_TOKENS / REIN_PAYEES / REIN_INTENT_SALT the MCP server reads
//
// Or, to try it with nothing configured:
//
//   node api/server.js --sandbox
//
// which runs against the sandbox account on a chain inside this process and,
// if no token is given, makes one up and prints it -- there is no real money
// behind the sandbox, so a generated key guards nothing worth guarding.
const http = require("node:http");
const crypto = require("node:crypto");
const { openClient, wantsSandbox } = require("../mcp/lib/config");

const PORT = Number(process.env.REIN_API_PORT || 8402);
const MAX_BODY = 64 * 1024;

// -- auth ------------------------------------------------------------------

/// Tokens are held as digests, never as the secret itself, so a heap dump or a
/// stray log line does not hand over the ability to spend. Comparison is
/// constant-time because a token check that returns faster on a wrong first
/// byte is a token check an attacker can walk character by character.
function loadTokens() {
  const table = new Map();
  for (const pair of (process.env.REIN_API_TOKENS || "").split(",")) {
    const idx = (pair || "").indexOf(":");
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const secret = pair.slice(idx + 1).trim();
    if (!name || !secret) continue;
    if (secret.length < 24) {
      throw new Error(`the token for "${name}" is under 24 characters; generate one with: openssl rand -hex 32`);
    }
    table.set(crypto.createHash("sha256").update(secret).digest("hex"), name);
  }
  return table;
}

function identify(tokens, header) {
  const presented = /^Bearer\s+(.+)$/i.exec(header || "")?.[1]?.trim();
  if (!presented) return null;
  const digest = crypto.createHash("sha256").update(presented).digest("hex");
  for (const [known, name] of tokens) {
    const a = Buffer.from(digest, "hex");
    const b = Buffer.from(known, "hex");
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return name;
  }
  return null;
}

// -- rate limiting ---------------------------------------------------------

/// Per caller, not per IP: the caller is the thing holding a key, and an agent
/// behind a NAT should not be throttled by its neighbour. Paying is limited
/// much harder than asking, because asking is free on chain and should stay
/// free here too -- an agent that checks before it acts is doing the right
/// thing and should not be punished for it.
const BUCKETS = new Map();
const LIMITS = { check: 120, pay: 20, read: 120 }; // per minute

function withinLimit(caller, kind) {
  const now = Date.now();
  const key = `${caller}:${kind}`;
  const b = BUCKETS.get(key) || { start: now, count: 0 };
  if (now - b.start >= 60_000) {
    b.start = now;
    b.count = 0;
  }
  b.count += 1;
  BUCKETS.set(key, b);
  return b.count <= LIMITS[kind];
}

// -- routes ----------------------------------------------------------------

let opening = null;
function rein() {
  if (!opening) {
    opening = openClient()
      .then((opened) => opened.client)
      .catch((err) => {
        opening = null;
        throw err;
      });
  }
  return opening;
}

const ROUTES = {
  "POST /v1/check": { kind: "check", run: async (body) => (await rein()).check(body) },
  "POST /v1/pay": { kind: "pay", run: async (body) => (await rein()).pay(body) },
  "GET /v1/budget": { kind: "read", run: async () => (await rein()).budget() },
  "GET /v1/policy": { kind: "read", run: async () => (await rein()).policy() },
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function createServer(tokens) {
  return http.createServer(async (req, res) => {
    const route = ROUTES[`${req.method} ${(req.url || "").split("?")[0]}`];
    if (!route) return json(res, 404, { error: "no such endpoint" });

    const caller = identify(tokens, req.headers.authorization);
    if (!caller) return json(res, 401, { error: "a valid bearer token is required" });

    if (!withinLimit(caller, route.kind)) {
      return json(res, 429, { error: `rate limit for ${route.kind} reached; try again in under a minute` });
    }

    try {
      const body = req.method === "POST" ? await readBody(req) : {};
      return json(res, 200, await route.run(body));
    } catch (err) {
      // A policy refusal is a 200 with allowed:false -- it is a normal answer.
      // A 4xx here means the request itself was malformed or unanswerable.
      return json(res, 400, { error: err.message });
    }
  });
}

function main() {
  const sandbox = wantsSandbox();
  if (sandbox && !process.env.REIN_API_TOKENS) {
    const secret = crypto.randomBytes(32).toString("hex");
    process.env.REIN_API_TOKENS = `sandbox:${secret}`;
    console.error(
      `rein-api: sandbox mode, no REIN_API_TOKENS given, so this run's key is:\n\n  ${secret}\n\n` +
      `  curl -s -H "Authorization: Bearer ${secret}" http://127.0.0.1:${PORT}/v1/budget\n`
    );
  }

  let tokens;
  try {
    tokens = loadTokens();
  } catch (err) {
    console.error(`rein-api: ${err.message}`);
    process.exit(1);
  }
  if (tokens.size === 0) {
    console.error(
      "rein-api: REIN_API_TOKENS is empty. This server can move money, so it will not listen without one.\n" +
      '  REIN_API_TOKENS="my-agent:$(openssl rand -hex 32)" node api/server.js'
    );
    process.exit(1);
  }
  if (sandbox) rein().catch((err) => console.error(`rein-api: the sandbox did not start: ${err.message}`));
  createServer(tokens).listen(PORT, "127.0.0.1", () => {
    // Loopback by default. Putting a key that can spend on a public interface
    // should be a decision somebody makes on purpose, behind a proxy they chose.
    console.error(`rein-api listening on http://127.0.0.1:${PORT} for ${tokens.size} caller(s)`);
  });
}

if (require.main === module) main();

module.exports = { createServer, loadTokens, identify, withinLimit };
