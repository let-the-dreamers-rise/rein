// rein-wallet as a library.
//
//   const rein = require("rein-wallet");
//   const verdict = rein.check(tx);   // after `npx rein-wallet guard 0xAgentWallet`
//   if (!verdict.allow) throw new Error(`Rein blocked this payment: ${verdict.explanation}`);
//
// check() is synchronous and local: it reads the limits `rein guard` saved and
// never touches the network. tx is the transaction about to be signed
// ({ to, data, value }) or an x402 payment ({ payTo, asset, amount }).
const { check, learn, evolve, approve, loadGuard } = require("./scan/guard");
const { scan, scanHistory, exportPolicy } = require("./scan/index");

module.exports = { check, learn, evolve, approve, loadGuard, scan, scanHistory, exportPolicy };
