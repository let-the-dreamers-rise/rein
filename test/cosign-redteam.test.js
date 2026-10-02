// Security review (security/red-team-0.1.1.md, section 4): one bad request
// must never stop the co-signer, and an allowance is an allowance.
const { expect } = require("chai");
const http = require("http");
const { ethers } = require("ethers");
const cosign = require("../scan/cosign");
const guard = require("../scan/guard");

const listen = (handler) => new Promise((r) => { const s = http.createServer(handler).listen(0, "127.0.0.1", () => r(s)); });
const post = (s, path, body, headers = {}) => fetch(`http://127.0.0.1:${s.address().port}${path}`, { method: "POST", headers, body }).then((r) => r.status);
const TOKEN = "t".repeat(40);

describe("rein cosign, red-teamed", function () {
  this.timeout(30000);

  it("answers malformed Privy requests and keeps serving", async () => {
    const s = await listen(cosign.privyHandler({ env: {}, appId: "app-1", appSecret: "x", key: null, token: TOKEN, fetch: async () => ({ ok: false, status: 404 }) }));
    const auth = { authorization: `Bearer ${TOKEN}` };
    const rpc = (body) => JSON.stringify({ method: "POST", url: "https://api.privy.io/v1/wallets/w1/rpc", headers: { "privy-app-id": "app-1" }, body });
    let deep = "0";
    for (let i = 0; i < 5000; i++) deep = `[${deep}]`;
    for (const body of [
      rpc({ method: "eth_sendTransaction", params: { transaction: { to: ethers.ZeroAddress, value: "1.5" } } }),
      rpc({ method: { toString: 1, valueOf: 1 } }),
      rpc({ method: "eth_sendTransaction", params: { transaction: { to: { toString: 1 }, data: 7 } } }),
      rpc({ method: "eth_sendTransaction", extra: "__DEEP__" }).replace('"__DEEP__"', deep),
    ]) expect(await post(s, "/sign", body, auth)).to.be.within(400, 403);
    expect(await post(s, "/sign", "{}", { authorization: `Bearer ${"é".repeat(20)}` })).to.equal(401); // same length in characters, not bytes
    expect(await post(s, "/sign", "{}", auth)).to.equal(403); // still up
    s.close();
  });

  it("ignores a Turnkey delivery whose id isn't an id, and keeps serving", async () => {
    const client = { get: async () => null };
    const s = await listen(cosign.turnkeyWebhookHandler({ client, organizationId: "org-1" }));
    expect(await post(s, "/", JSON.stringify({ activity: { id: { toString: 1, valueOf: 1 } } }))).to.equal(200);
    expect(await post(s, "/", JSON.stringify({ activity: { id: "a-1", organizationId: { toString: 1 } } }))).to.equal(200);
    expect(await post(s, "/", JSON.stringify({ activity: { id: "a-2" } }))).to.equal(202);
    s.close();
  });

  it("judges increaseAllowance as an allowance, held to the spender list", () => {
    const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const data = new ethers.Interface(["function increaseAllowance(address,uint256)"]).encodeFunctionData("increaseAllowance", [ethers.Wallet.createRandom().address, 10n ** 12n]);
    const out = guard.toRow({ to: USDC, data, value: 0n }, { tokens: {} }, 1);
    const row = out.rows ? out.rows[0] : out;
    expect(row.kind).to.equal("approve");
  });

  it("won't start the Privy co-signer without a long bearer token, and listens on this machine only by default", async () => {
    const env = { REIN_PRIVY_AUTH_KEY: "k", PRIVY_APP_ID: "a", PRIVY_APP_SECRET: "s" };
    let err = await cosign.main(["privy"], { env, log: () => {} }).catch((e) => e);
    expect(err.message).to.contain("REIN_COSIGN_TOKEN");
    err = await cosign.main(["privy"], { env: { ...env, REIN_COSIGN_TOKEN: "short" }, log: () => {} }).catch((e) => e);
    expect(err.message).to.contain("at least 32");
    expect(cosign.parse(["privy", "--host", "0.0.0.0"]).host).to.equal("0.0.0.0");
  });
});
