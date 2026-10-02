// rein-wallet as a library.
//
//   const { protect } = require("rein-wallet");
//   const wallet = protect(walletClient);   // a viem wallet client: every payment is checked first
//
//   const rein = require("rein-wallet");
//   const verdict = rein.check(tx);   // after `npx rein-wallet guard 0xAgentWallet`
//   if (!verdict.allow) throw new Error(`Rein blocked this payment: ${verdict.explanation}`);
//
// check() is synchronous and local: it reads the limits `rein guard` saved and
// never touches the network. tx is the transaction about to be signed
// ({ to, data, value }) or an x402 payment ({ payTo, asset, amount }).
//
// With Rein as the second key on a Privy wallet (`rein cosign setup privy`),
// ask the co-signer for its signature on anything outside the agent's limits:
//
//   const v = await rein.cosign(request, { url: process.env.REIN_COSIGNER_URL });
//   if (v.signature) headers["privy-authorization-signature"] = `${mine},${v.signature}`;
//   else if (v.held) // a person is deciding: retry this same request later
//
// `request` is exactly what the agent will send to Privy: { method, url, body,
// headers: { "privy-app-id" } }.
const { check, learn, evolve, approve, loadGuard } = require("./scan/guard");
const { scan, scanHistory, exportPolicy } = require("./scan/index");
const { protect, ReinHeld } = require("./scan/protect");

/// Asks `rein cosign privy` to co-sign a Privy request. Resolves with the
/// verdict: { allow, signature } when it signs, { held, next } while a person
/// decides, or { allow: false, reason, explanation }. Never throws on a
/// refusal; a co-signer it can't reach comes back as { allow: false,
/// reason: "COSIGNER_UNREACHABLE" }.
async function cosign(request, { url, token = process.env.REIN_COSIGN_TOKEN, fetch: fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl(`${String(url).replace(/\/$/, "")}/sign`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(request),
    });
    return await res.json();
  } catch (err) {
    return { allow: false, reason: "COSIGNER_UNREACHABLE", explanation: `Rein's co-signer couldn't be reached, so nothing was signed: ${err.message}` };
  }
}

module.exports = { protect, ReinHeld, check, cosign, learn, evolve, approve, loadGuard, scan, scanHistory, exportPolicy };
