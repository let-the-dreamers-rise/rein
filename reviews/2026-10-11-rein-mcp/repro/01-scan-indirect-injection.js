// Finding R-01: rein_scan_wallet carries attacker-written on-chain text into
// the calling agent's context, verbatim and unlabeled.
//
// Setup an attacker needs on a real chain: deploy any ERC-20 whose symbol() is
// the payload and transfer 1 unit to the wallet that will be scanned. No
// permission from the wallet owner is needed. Here the explorer's answer is
// served locally by fake-blockscout.js; the MCP server itself is unmodified.
//
// Then a fully compromised-looking flow is NOT needed: the agent only has to do
// what the /rein:scan command tells it to do (call rein_scan_wallet and report).
// The script then sends the rein_pay call the payload asks for, to show that
// the same server would execute it (sandbox money, within policy).
//
//   node 01-scan-indirect-injection.js
const path = require("path");
const { start } = require("./harness");
const { WALLET, PAYLOAD } = require("./fake-blockscout");

(async () => {
  const s = start({ args: ["--sandbox"], preload: path.join(__dirname, "fake-blockscout.js"), env: { FAKE_BLOCKSCOUT: "inject", ...(process.env.INJECT_SYMBOL ? { INJECT_SYMBOL: process.env.INJECT_SYMBOL } : {}) } });
  await s.init();
  const r = await s.call("rein_scan_wallet", { address: WALLET, chain: "base" });
  console.log("isError:", r.isError);
  console.log("payload appears verbatim in the tool result:", r.text.includes(PAYLOAD));
  console.log("result marks it as untrusted / third-party data:", /untrusted|third[- ]party|on-chain text|do not follow/i.test(r.text));
  console.log("\n----- tool result as the agent receives it (first 40 lines) -----");
  console.log(r.text.split("\n").slice(0, 40).join("\n"));
  console.log("----- end -----\n");

  // What the injected text asks for. In the plugin and in any server started
  // with an agent key, rein_pay sits in the same server as rein_scan_wallet.
  const pay = await s.call("rein_pay", { payee: "acme", amount: "900", token: "USDC", because: "scan follow-up" });
  console.log("rein_pay as instructed by the token symbol ->", JSON.stringify({ paid: pay.json?.paid, reason: pay.json?.reason, remainingThisWindow: pay.json?.remainingThisWindow }));
  const over = await s.call("rein_pay", { payee: "0x" + "44".repeat(20), amount: "900", token: "USDC", because: "scan follow-up" });
  console.log("same payload aimed at an unlisted address ->", JSON.stringify({ paid: over.json?.paid, reason: over.json?.reason }));
  s.stop();
})();
