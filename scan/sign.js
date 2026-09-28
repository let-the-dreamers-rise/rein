// Request signing for the wallet engines whose APIs will not take a plain
// secret, written against their own SDKs so `rein apply` needs neither:
//
//   Turnkey       X-Stamp: base64url({publicKey, scheme, signature}), where
//                 signature is a DER ECDSA P-256/SHA-256 signature over the
//                 exact request body, hex (tkhq/sdk packages/api-key-stamper).
//   Coinbase CDP  Authorization: Bearer <JWT> signed with the API key (ES256
//                 for a PEM EC key, EdDSA for a base64 Ed25519 key), naming
//                 the one request it may be used for; and, for account
//                 writes, X-Wallet-Auth: an ES256 JWT from the Wallet Secret
//                 carrying a hash of the body (coinbase/cdp-sdk src/auth).
//
// Node's crypto only; nothing leaves this machine but the signed request.
const crypto = require("crypto");

const b64url = (buf) => Buffer.from(buf).toString("base64url");

// -- Turnkey ------------------------------------------------------------------

/// The P-256 key a Turnkey API key pair names: the private scalar (hex) and
/// the compressed public key (hex). Refuses a pair that does not match, so a
/// pasted wrong half fails here rather than as a 401.
function turnkeyKey(publicKeyHex, privateKeyHex) {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateKeyHex.replace(/^0x/, ""), "hex"));
  const compressed = ecdh.getPublicKey("hex", "compressed");
  if (compressed.toLowerCase() !== publicKeyHex.replace(/^0x/, "").toLowerCase()) {
    throw new Error("the Turnkey API public key does not belong to that private key");
  }
  const raw = ecdh.getPublicKey(null, "uncompressed"); // 0x04 || x || y
  return crypto.createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: b64url(ecdh.getPrivateKey()), x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33)) },
    format: "jwk",
  });
}

function turnkeyStamp(body, { publicKey, privateKey }) {
  const signature = crypto.sign("sha256", Buffer.from(body), turnkeyKey(publicKey, privateKey)).toString("hex");
  return b64url(JSON.stringify({ publicKey, scheme: "SIGNATURE_SCHEME_TK_API_P256", signature }));
}

// -- Coinbase CDP -----------------------------------------------------------------

function jwt(header, claims, key, alg) {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = alg === "EdDSA" ? crypto.sign(null, Buffer.from(input), key) : crypto.sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64url(sig)}`;
}

/// A CDP API key secret is either a PEM EC key or 64 base64 bytes of Ed25519
/// seed and public key; the SDK accepts both, and so does this.
function cdpApiKey(secret) {
  const s = secret.replace(/\\n/g, "\n").trim();
  if (s.includes("-----BEGIN")) return { alg: "ES256", key: crypto.createPrivateKey(s) };
  const raw = Buffer.from(s, "base64");
  if (raw.length !== 64) throw new Error("CDP_API_KEY_SECRET is neither a PEM EC key nor a base64 Ed25519 key");
  return { alg: "EdDSA", key: crypto.createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: b64url(raw.subarray(0, 32)), x: b64url(raw.subarray(32)) }, format: "jwk" }) };
}

function cdpJwt({ keyId, keySecret, method, url, now = Math.floor(Date.now() / 1000), expiresIn = 120 }) {
  const u = new URL(url);
  const { alg, key } = cdpApiKey(keySecret);
  const header = { alg, kid: keyId, typ: "JWT", nonce: crypto.randomBytes(16).toString("hex") };
  const claims = { sub: keyId, iss: "cdp", uris: [`${method} ${u.host}${u.pathname}`], iat: now, nbf: now, exp: now + expiresIn };
  return jwt(header, claims, key, alg);
}

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;

/// The SDK asks for wallet auth on writes under /evm/accounts (and a few
/// other wallet paths); a policy attach is one.
const cdpNeedsWalletAuth = (method, url) => /\/(evm|solana)\/accounts/.test(new URL(url).pathname) && ["POST", "PUT", "DELETE"].includes(method);

function cdpWalletJwt({ walletSecret, method, url, body, now = Math.floor(Date.now() / 1000) }) {
  const u = new URL(url);
  const key = crypto.createPrivateKey({ key: Buffer.from(walletSecret, "base64"), format: "der", type: "pkcs8" });
  const claims = { uris: [`${method} ${u.host}${u.pathname}`] };
  if (body && typeof body === "object" && Object.values(body).some((v) => v !== undefined)) {
    claims.reqHash = crypto.createHash("sha256").update(JSON.stringify(sortKeys(body))).digest("hex");
  }
  Object.assign(claims, { iat: now, nbf: now, jti: crypto.randomBytes(16).toString("hex") });
  return jwt({ alg: "ES256", typ: "JWT" }, claims, key, "ES256");
}

module.exports = { turnkeyStamp, turnkeyKey, cdpJwt, cdpWalletJwt, cdpNeedsWalletAuth, sortKeys };
