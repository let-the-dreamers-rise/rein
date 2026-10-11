// Finding R-02: in real (non-sandbox) mode, rein_about returns REIN_RPC_URL
// verbatim. Hosted RPC providers put the API key in the URL path or query, so
// the key lands in the model's context, the client transcript, and anything an
// injected instruction can get the agent to repeat.
//
// Also checks (pass/fail, not findings by themselves):
//   - whether an RPC error message echoes the URL too
//   - whether a malformed REIN_AGENT_PRIVATE_KEY is echoed in an error
//
// Runs entirely on localhost: a throwaway JSON-RPC stub on 127.0.0.1 that
// answers every call with an error.
//   node 02-rpc-url-disclosure.js
const http = require("http");
const { start } = require("./harness");

const FAKE_KEY = "alch_TEST_0123456789abcdefSECRET";
const ACCOUNT = "0x5555555555555555555555555555555555555555";
const AGENT = "0x6666666666666666666666666666666666666666";

(async () => {
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("upstream unavailable");
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${stub.address().port}/v2/${FAKE_KEY}`;

  // 1. rein_about, read-only mode (no signing key at all)
  let s = start({ args: [], env: { REIN_RPC_URL: url, REIN_ACCOUNT: ACCOUNT, REIN_AGENT_ADDRESS: AGENT } });
  await s.init();
  const about = await s.call("rein_about", {});
  console.log("rein_about ->", about.text);
  console.log("RPC key disclosed by rein_about:", about.text.includes(FAKE_KEY));

  // 2. an RPC failure on a tool that touches the chain
  const budget = await s.call("rein_budget", {}, { timeoutMs: 20000 });
  const btxt = budget.timeout ? "(no answer in 20s)" : budget.text;
  console.log("\nrein_budget with the RPC failing ->", btxt.slice(0, 600));
  console.log("RPC key disclosed by the error text:", btxt.includes(FAKE_KEY));
  s.stop();

  // 3. A valid key with a stray character, as .env files and copy-paste
  //    produce them: a trailing newline, a Windows CR, surrounding quotes.
  //    The key below is a throwaway (sha256 of a fixed string); never fund it.
  const realKey = "0x" + require("crypto").createHash("sha256").update("rein-review-throwaway-key").digest("hex");
  for (const [label, value] of [["trailing newline", realKey + "\n"], ["trailing CR (CRLF .env)", realKey + "\r"], ["double-quoted", `"${realKey}"`], ["trailing space", realKey + " "]]) {
    s = start({ args: [], env: { REIN_RPC_URL: url, REIN_ACCOUNT: ACCOUNT, REIN_AGENT_PRIVATE_KEY: value } });
    await s.init();
    const r = await s.call("rein_about", {});
    console.log(`\nrein_about, private key with ${label} ->`, r.text.slice(0, 260));
    console.log("full 32-byte private key echoed into the tool result:", r.text.includes(realKey.slice(2)));
    s.stop();
  }
  stub.close();
})();
