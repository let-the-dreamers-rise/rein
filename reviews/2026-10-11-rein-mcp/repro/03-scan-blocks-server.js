// Finding R-03: one rein_scan_wallet call against a slow or unresponsive
// explorer stalls every other tool on the server, with no timeout.
//
// The server answers one message at a time (rein-mcp.js main(): a promise
// queue), and scan/blockscout.js calls fetch() with no timeout or abort
// signal. So a hanging explorer response -- or a scan that is simply walking
// 40 pages with 200 ms pauses -- holds up ping, rein_budget and rein_check_payment.
//
// The explorer is simulated locally (fake-blockscout.js, mode "hang").
//   node 03-scan-blocks-server.js
const path = require("path");
const { start } = require("./harness");

(async () => {
  const s = start({ args: ["--sandbox"], preload: path.join(__dirname, "fake-blockscout.js"), env: { FAKE_BLOCKSCOUT: "hang" } });
  await s.init();
  // Warm-up so the sandbox chain is ready before the measurement.
  const warm = await s.call("rein_budget", {});
  console.log("before the scan, rein_budget answers:", !warm.timeout);

  const scan = s.call("rein_scan_wallet", { address: "0x1111111111111111111111111111111111111111" }, { timeoutMs: 30000 });
  const t0 = Date.now();
  const ping = await s.rpc("ping", {}, { timeoutMs: 15000 });
  console.log(`ping while a scan is in flight: ${ping.timeout ? "NO ANSWER" : "answered"} after ${Date.now() - t0} ms`);
  const t1 = Date.now();
  const check = await s.call("rein_check_payment", { payee: "acme", amount: "1", token: "USDC", because: "test" }, { timeoutMs: 15000 });
  console.log(`rein_check_payment while a scan is in flight: ${check.timeout ? "NO ANSWER" : "answered"} after ${Date.now() - t1} ms`);
  const sc = await scan;
  console.log(`the scan itself: ${sc.timeout ? "still no answer after 30 s" : "answered"}`);
  s.stop();
})();
