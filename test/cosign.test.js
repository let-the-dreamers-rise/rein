// rein cosign: Rein as a second key that Turnkey enforces. A fake Turnkey
// answers here; the guard is the sample wallet's, saved under a temporary
// REIN_HOME.
const { expect } = require("chai");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const guard = require("../scan/guard");
const cosign = require("../scan/cosign");
const sign = require("../scan/sign");
const { sampleHistory, AGENT, PAYEES, USDC } = require("../scan/sample");

const ERC20 = new ethers.Interface(["function transfer(address,uint256)"]);
const usdc = (n) => ethers.parseUnits(String(n), 6);
const unsigned = (to, amount, chainId = 8453) =>
  ethers.Transaction.from({ type: 2, chainId, nonce: 0, gasLimit: 100000, maxFeePerGas: 1, maxPriorityFeePerGas: 1, to: USDC.address, data: ERC20.encodeFunctionData("transfer", [to, usdc(amount)]) }).unsignedSerialized.slice(2);
const signing = (id, to, amount, chainId) => ({
  id,
  fingerprint: `fp-${id}`,
  type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
  status: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
  canApprove: true,
  intent: { signTransactionIntentV2: { signWith: AGENT, unsignedTransaction: unsigned(to, amount, chainId), type: "TRANSACTION_TYPE_ETHEREUM" } },
});

// What Turnkey's viem signer sends for signTypedData: a raw payload whose
// encoding says EIP-712, and the typed data itself as the payload.
const typed = (id, to, amount) => ({
  id,
  fingerprint: `fp-${id}`,
  type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
  canApprove: true,
  intent: {
    signRawPayloadIntentV2: {
      signWith: AGENT,
      encoding: "PAYLOAD_ENCODING_EIP712",
      hashFunction: "HASH_FUNCTION_NO_OP",
      payload: JSON.stringify({
        domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC.address },
        types: { EIP712Domain: [], TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }] },
        primaryType: "TransferWithAuthorization",
        message: { from: AGENT, to, value: String(usdc(amount)) },
      }),
    },
  },
});

/// A Turnkey that keeps a list of waiting activities and records each vote.
function fakeTurnkey(key) {
  const t = { waiting: [], votes: [], posts: [], requests: [] };
  t.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const ok = (x) => ({ ok: true, status: 200, text: async () => JSON.stringify(x) });
    if (url.startsWith("https://hooks.")) return t.posts.push(body.text), ok({});
    const stamp = JSON.parse(Buffer.from(init.headers["X-Stamp"], "base64url").toString());
    expect(stamp.publicKey).to.equal(key.publicKey);
    t.requests.push({ url, body });
    if (url.endsWith("/query/list_activities")) {
      expect(body.filterByStatus).to.deep.equal(["ACTIVITY_STATUS_CONSENSUS_NEEDED"]);
      return ok({ activities: t.waiting });
    }
    const m = /\/submit\/(approve|reject)_activity$/.exec(url);
    if (m) {
      t.votes.push([m[1], body.parameters.fingerprint]);
      t.waiting = t.waiting.filter((a) => a.fingerprint !== body.parameters.fingerprint);
      return ok({ activity: { status: "ACTIVITY_STATUS_COMPLETED" } });
    }
    if (url.endsWith("/create_api_only_users")) return ok({ activity: { status: "ACTIVITY_STATUS_COMPLETED", result: { createApiOnlyUsersResult: { userIds: ["user-rein"] } } } });
    if (url.endsWith("/create_policy")) return ok({ activity: { status: "ACTIVITY_STATUS_COMPLETED", result: { createPolicyResult: { policyId: "policy-1" } } } });
    return { ok: false, status: 404, text: async () => "no" };
  };
  return t;
}

describe("rein cosign (Turnkey)", function () {
  this.timeout(60000);
  let env;
  let key;
  let tk;
  let client;
  let learned;

  before(() => {
    learned = guard.learn(sampleHistory()).guard;
  });

  beforeEach(() => {
    env = { REIN_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "rein-cosign-")) };
    guard.saveGuard(JSON.parse(JSON.stringify(learned)), guard.guardPath(AGENT, env));
    key = cosign.keygen();
    tk = fakeTurnkey(key);
    client = cosign.turnkeyClient({ organizationId: "org-1", publicKey: key.publicKey, privateKey: key.privateKey, fetch: tk.fetch });
  });

  const run = (o = {}) => cosign.tick({ client, organizationId: "org-1", env, webhook: "https://hooks.example/x", fetch: tk.fetch, ...o });

  it("reads what a waiting request would sign, and says why when it can't", () => {
    const r = cosign.readActivity(signing("a", PAYEES.inference.address, 5));
    expect(r.tx.from).to.equal(AGENT);
    expect(r.tx.to).to.equal(USDC.address);
    expect(r.chainId).to.equal(8453);
    const send = cosign.readActivity({ intent: { ethSendTransactionIntent: { from: AGENT, caip2: "eip155:8453", to: USDC.address, value: "0", data: "0x" } } });
    expect(send).to.deep.include({ chainId: 8453 });
    expect(cosign.readActivity({ intent: { ethSendTransactionIntentV2: { from: AGENT, caip2: "eip155:8453", calls: [{ to: AGENT }, { to: AGENT }] } } }).tx.calls).to.have.length(2);
    expect(cosign.readActivity({ intent: { signRawPayloadIntentV2: { signWith: AGENT, payload: "0x00" } } }).unreadable).to.contain("raw signature");
    const x402 = cosign.readActivity(typed("t", PAYEES.inference.address, 5));
    expect(x402).to.deep.include({ chainId: 8453 });
    expect(x402.tx).to.include({ from: AGENT, primaryType: "TransferWithAuthorization" });
    expect(cosign.readActivity({ intent: { signRawPayloadIntentV2: { signWith: AGENT, encoding: "PAYLOAD_ENCODING_EIP7702_AUTHORIZATION", payload: "0x00" } } }).unreadable).to.contain("EIP-7702");
    expect(cosign.readActivity({ intent: { signTransactionIntentV2: { signWith: "key-123", unsignedTransaction: "00" } } }).unreadable).to.contain("key id");
  });

  it("approves what fits the agent's limits, and holds the rest until a person decides", async () => {
    tk.waiting = [signing("usual", PAYEES.inference.address, 5), signing("stranger", "0x8888888888888888888888888888888888888888", 300), signing("refuse", "0x9999999999999999999999999999999999999999", 300)];
    let d = await run();
    expect(d.approved).to.deep.equal(["usual"]);
    expect(d.held).to.deep.equal(["stranger", "refuse"]);
    expect(tk.votes).to.deep.equal([["approve", "fp-usual"]]);

    // Nothing changes while nobody has decided, and the agent can't hurry it.
    d = await run();
    expect(d.approved.concat(d.rejected, d.held)).to.deep.equal([]);

    const holds = guard.loadGuard(AGENT, env).guard.holds;
    const id = (to) => holds.find((h) => h.what.includes(to)).id;
    await guard.main([AGENT, "--allow", id("0x8888")], { log: () => {}, env, input: AGENT.slice(-4) });
    await guard.main([AGENT, "--deny", id("0x9999")], { log: () => {}, env });
    d = await run();
    expect(d.approved).to.deep.equal(["stranger"]);
    expect(d.rejected).to.deep.equal(["refuse"]);
    expect(tk.votes.slice(1)).to.deep.equal([["approve", "fp-stranger"], ["reject", "fp-refuse"]]);
    // The approved payment counts against the hour like any other.
    expect(guard.loadGuard(AGENT, env).guard.ledger.length).to.be.greaterThan(0);
  });

  it("leaves what it can't judge for a person, and says so once", async () => {
    tk.waiting = [
      { id: "raw", fingerprint: "fp-raw", canApprove: true, intent: { signRawPayloadIntentV2: { signWith: AGENT, payload: "0x00" } } },
      { ...signing("other", PAYEES.inference.address, 5), intent: { ethSendTransactionIntent: { from: "0x1111111111111111111111111111111111111111", caip2: "eip155:8453", to: USDC.address, data: "0x" } } },
      signing("mainnet", PAYEES.inference.address, 5, 1),
      { ...signing("voted", PAYEES.inference.address, 5), canApprove: false },
    ];
    const d = await run({ learn: false });
    expect(d.left).to.deep.equal(["raw", "other", "mainnet"]);
    expect(tk.votes).to.deep.equal([]);
    expect(tk.posts).to.have.length(3);
    expect(tk.posts.join("\n")).to.contain("raw signature").and.contain("no guard for 0x1111").and.contain("chain 1");
    await run({ learn: false });
    expect(tk.posts).to.have.length(3);
  });

  it("judges x402 signatures as payments, the way Turnkey's viem signer sends them", async () => {
    tk.waiting = [typed("usual", PAYEES.inference.address, 5), typed("stranger", "0x8888888888888888888888888888888888888888", 300)];
    const d = await run();
    expect(d.approved).to.deep.equal(["usual"]);
    expect(d.held).to.deep.equal(["stranger"]);
  });

  it("judges a batch as one payment: one bad call holds the whole batch, and their sum counts against the hour", async () => {
    const limit = Object.values(learned.policy.tokens)[0].maxPerWindow;
    const call = (to, amount) => ({ to: USDC.address, value: "0", data: ERC20.encodeFunctionData("transfer", [to, usdc(amount)]) });
    const batch = (id, calls) => ({ id, fingerprint: `fp-${id}`, canApprove: true, intent: { ethSendTransactionIntentV2: { from: AGENT, caip2: "eip155:8453", calls } } });
    const half = Math.floor(limit * 0.6);
    tk.waiting = [
      batch("fine", [call(PAYEES.inference.address, 1), call(PAYEES.data.address, 1)]),
      batch("sneaky", [call(PAYEES.inference.address, 1), call("0x8888888888888888888888888888888888888888", 3)]),
      batch("split", [call(PAYEES.inference.address, half), call(PAYEES.data.address, half)]),
    ];
    const d = await run();
    expect(d.approved).to.deep.equal(["fine"]);
    expect(d.held).to.deep.equal(["sneaky", "split"]);
    const holds = guard.loadGuard(AGENT, env).guard.holds;
    expect(holds.map((h) => h.what)).to.include("a batch of 2 calls that includes 1 USDC to " + PAYEES.inference.address);
    // A person's yes lets that batch through once, as a whole.
    await guard.main([AGENT, "--allow", holds[0].id], { log: () => {}, env, input: AGENT.slice(-4) });
    expect((await run()).approved).to.deep.equal(["sneaky"]);
  });

  it("sets up a guard the first time it sees a wallet, so a platform configures nothing per wallet", async () => {
    const fresh = "0x" + "4".repeat(40);
    const pay = (id, to, amount) => ({ ...signing(id, to, amount), intent: { ethSendTransactionIntent: { from: fresh, caip2: "eip155:8453", to: USDC.address, value: "0", data: ERC20.encodeFunctionData("transfer", [to, usdc(amount)]) } } });
    const offline = async (url, init) => (url.includes("blockscout") ? Promise.reject(new Error("offline")) : tk.fetch(url, init));
    tk.waiting = [pay("small", PAYEES.inference.address, 10), pay("big", PAYEES.data.address, 400)];
    const d = await run({ fetch: offline });
    expect(d.approved).to.deep.equal(["small"]);
    expect(d.held).to.deep.equal(["big"]);
    expect(guard.loadGuard(fresh, env).guard.learning).to.equal(true);
  });

  it("serves an app with a sub-organization per user from Turnkey's webhook, reading each activity again from Turnkey", async () => {
    const sub = (id, org, to, amount) => ({ ...signing(id, to, amount), organizationId: org });
    const live = { a: sub("a", "sub-1", PAYEES.inference.address, 5), b: sub("b", "sub-2", "0x8888888888888888888888888888888888888888", 300) };
    const gets = [];
    const turnkey = async (url, init) => {
      if (url.endsWith("/query/get_activity")) {
        const body = JSON.parse(init.body);
        gets.push([body.organizationId, body.activityId]);
        return { ok: true, status: 200, text: async () => JSON.stringify({ activity: live[body.activityId] || null }) };
      }
      return tk.fetch(url, init);
    };
    const c = cosign.turnkeyClient({ organizationId: "parent", publicKey: key.publicKey, privateKey: key.privateKey, fetch: turnkey });
    const handler = cosign.turnkeyWebhookHandler({ client: c, organizationId: "parent", env, fetch: turnkey });
    const server = http.createServer(handler);
    await new Promise((r) => server.listen(0, r));
    const hook = (body) => fetch(`http://127.0.0.1:${server.address().port}/`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.status);
    try {
      // What the webhook says is only a doorbell: Rein judges what Turnkey returns.
      expect(await hook({ type: "ACTIVITY_UPDATES", data: { activity: { ...live.a, intent: { forged: true } } } })).to.equal(202);
      expect(await hook({ activity: { id: "b", organizationId: "sub-2", status: "ACTIVITY_STATUS_CONSENSUS_NEEDED" } })).to.equal(202);
      expect(await hook({ activity: { id: "z", status: "ACTIVITY_STATUS_COMPLETED" } })).to.equal(200);
      await handler.idle();
      expect(gets).to.deep.equal([["sub-1", "a"], ["sub-2", "b"]]);
      // The vote goes to the sub-organization the activity lives in.
      expect(tk.votes).to.deep.equal([["approve", "fp-a"]]);
      expect(tk.requests.find((r) => r.url.endsWith("/approve_activity")).body.organizationId).to.equal("sub-1");

      // A person's yes reaches Turnkey on the next re-check of held payments.
      const hold = guard.loadGuard(AGENT, env).guard.holds.find((h) => h.what.includes("0x8888"));
      await guard.main([AGENT, "--allow", hold.id], { log: () => {}, env, input: AGENT.slice(-4) });
      const d = await cosign.recheck({ client: c, organizationId: "parent", env, fetch: turnkey });
      expect(d.approved).to.deep.equal(["b"]);
      expect(tk.requests.filter((r) => r.url.endsWith("/approve_activity")).map((r) => r.body.organizationId)).to.deep.equal(["sub-1", "sub-2"]);
    } finally {
      server.close();
    }
  });

  it("points Turnkey's webhook at the co-signer, once, in the parent organization", async () => {
    const logs = [];
    const e = { ...env, TURNKEY_API_PUBLIC_KEY: key.publicKey, TURNKEY_API_PRIVATE_KEY: key.privateKey };
    const hookFetch = async (url, init) => (url.endsWith("/create_webhook_endpoint") ? (tk.requests.push({ url, body: JSON.parse(init.body) }), { ok: true, status: 200, text: async () => JSON.stringify({ activity: { status: "ACTIVITY_STATUS_COMPLETED", result: { createWebhookEndpointResult: { endpointId: "hook-1" } } } }) }) : tk.fetch(url, init));
    await cosign.main(["setup", "turnkey", "--organization", "parent", "--webhook-url", "https://rein.example/turnkey", "--send"], { log: (l) => logs.push(l), env: e, fetch: hookFetch });
    expect(tk.requests[0].body.parameters).to.deep.equal({ url: "https://rein.example/turnkey", name: "Rein co-signer", subscriptions: [{ eventType: "ACTIVITY_UPDATES" }] });
    expect(logs.join("\n")).to.contain("webhook hook-1").and.contain("--listen");
    await cosign.main(["setup", "turnkey", "--webhook-url", "http://plain"], { log: () => {}, env: e }).catch((err) => logs.push(err.message));
    expect(logs.pop()).to.contain("https");
  });

  it("sets Turnkey up: a co-signer user, then a policy needing both the agent and Rein", async () => {
    const logs = [];
    const e = { ...env, REIN_TURNKEY_PUBLIC_KEY: key.publicKey, TURNKEY_API_PUBLIC_KEY: key.publicKey, TURNKEY_API_PRIVATE_KEY: key.privateKey };
    expect(await cosign.main(["setup", "turnkey", "--organization", "org-1", "--agent-user", "user-agent"], { log: (l) => logs.push(l), env: e, fetch: tk.fetch })).to.equal(0);
    expect(tk.requests).to.have.length(0);
    expect(logs.join("\n")).to.contain("Nothing was sent");
    await cosign.main(["setup", "turnkey", "--organization", "org-1", "--agent-user", "user-agent", "--send"], { log: (l) => logs.push(l), env: e, fetch: tk.fetch });
    const [user, policy] = tk.requests;
    expect(user.body.parameters.apiOnlyUsers[0].apiKeys[0].publicKey).to.equal(key.publicKey);
    expect(policy.body.parameters.consensus).to.equal("approvers.any(user, user.id == 'user-agent') && approvers.any(user, user.id == 'user-rein')");
    expect(policy.body.parameters.condition).to.contain("ACTIVITY_TYPE_SIGN_TRANSACTION_V2");
    expect(logs.join("\n")).to.contain("co-signer user user-rein, policy policy-1").and.contain("root quorum");
  });

  it("makes a key pair Turnkey accepts, and is a rein command", async () => {
    const k = cosign.keygen();
    expect(() => sign.turnkeyKey(k.publicKey, k.privateKey)).to.not.throw();
    const lines = [];
    expect(await cosign.main(["keygen"], { log: (l) => lines.push(l) })).to.equal(0);
    expect(lines.join("\n")).to.match(/REIN_TURNKEY_PUBLIC_KEY=0[23][0-9a-f]{64}/);
    expect(require("../bin/rein").main).to.be.a("function");
  });
});

describe("rein cosign (Privy)", function () {
  this.timeout(60000);
  const APP = "app-1";
  const WALLET_ID = "w1";
  let env;
  let key;
  let server;
  let base;
  let learned;

  const rpc = (body, over = {}) => ({ method: "POST", url: `https://api.privy.io/v1/wallets/${WALLET_ID}/rpc`, body, headers: { "privy-app-id": APP }, ...over });
  const pay = (to, amount) => rpc({ method: "eth_sendTransaction", caip2: "eip155:8453", params: { transaction: { to: USDC.address, data: ERC20.encodeFunctionData("transfer", [to, usdc(amount)]), value: "0x0" } } });
  const ask = async (request, headers = { authorization: "Bearer t0ken" }) => {
    const res = await fetch(`${base}/sign`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(request) });
    return { status: res.status, body: await res.json() };
  };
  const verifies = (request, signature) => crypto.verify("sha256", sign.privyPayload(request), crypto.createPublicKey({ key: Buffer.from(key.privyPublicKey, "base64"), format: "der", type: "spki" }), Buffer.from(signature, "base64"));

  before(() => {
    learned = guard.learn(sampleHistory()).guard;
  });

  beforeEach(async () => {
    env = { REIN_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "rein-cosign-")) };
    guard.saveGuard(JSON.parse(JSON.stringify(learned)), guard.guardPath(AGENT, env));
    key = cosign.keygen();
    const privy = async (url, init) => {
      expect(url).to.equal(`https://api.privy.io/v1/wallets/${WALLET_ID}`);
      expect(init.headers["privy-app-id"]).to.equal(APP);
      return { ok: true, status: 200, json: async () => ({ id: WALLET_ID, address: AGENT.toLowerCase(), chain_type: "ethereum" }) };
    };
    server = http.createServer(cosign.privyHandler({ env, appId: APP, appSecret: "s3cret", key: key.privyPrivateKey, token: "t0ken", fetch: privy }));
    await new Promise((r) => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(() => server.close());

  it("signs Privy's canonical request: sorted keys, an empty body as an empty string", () => {
    const req = { method: "PATCH", url: "https://api.privy.io/v1/wallets/w1", body: { z: 1, a: { y: 2, b: 3 } }, headers: { "privy-app-id": APP, other: "dropped" } };
    expect(sign.privyPayload(req).toString()).to.equal('{"body":{"a":{"b":3,"y":2},"z":1},"headers":{"privy-app-id":"app-1"},"method":"PATCH","url":"https://api.privy.io/v1/wallets/w1","version":1}');
    expect(sign.privyPayload({ ...req, body: {} }).toString()).to.contain('"body":""');
    expect(verifies(req, sign.privySignature(req, key.privyPrivateKey))).to.equal(true);
  });

  it("co-signs a payment inside the limits, holds one outside them until a person approves, and signs nothing else", async () => {
    const usual = pay(PAYEES.inference.address, 5);
    let r = await ask(usual);
    expect(r.status).to.equal(200);
    expect(verifies(usual, r.body.signature)).to.equal(true);

    const stranger = pay("0x8888888888888888888888888888888888888888", 300);
    r = await ask(stranger);
    expect(r.status).to.equal(202);
    expect(r.body.signature).to.equal(undefined);
    await guard.main([AGENT, "--allow", r.body.held], { log: () => {}, env, input: AGENT.slice(-4) });
    r = await ask(stranger);
    expect(r.status).to.equal(200);
    expect(r.body.reason).to.equal("APPROVED");

    // Never a change to the wallet, its owner or its policies, and never another app's request.
    expect((await ask({ ...usual, method: "PATCH", url: `https://api.privy.io/v1/wallets/${WALLET_ID}`, body: { owner_id: "q-attacker" } })).status).to.equal(403);
    expect((await ask(rpc({ method: "personal_sign", params: { message: "hi" } }))).body.explanation).to.contain("personal_sign is not one");
    const t = usual.body.params.transaction;
    const tweak = (extra) => rpc({ ...usual.body, params: { transaction: { ...t, ...extra } } });
    expect((await ask(tweak({ authorization_list: [{ address: "0x8888888888888888888888888888888888888888" }] }))).body.explanation).to.contain("EIP-7702");
    expect((await ask(tweak({ chain_id: 1 }))).body.explanation).to.contain("two chains");
    expect((await ask(tweak({ input: "0xdeadbeef" }))).status).to.equal(403);
    expect((await ask({ ...usual, headers: { "privy-app-id": "app-2" } })).body.reason).to.equal("WRONG_APP");
    expect((await ask(usual, {})).status).to.equal(401);

    // The same, from the agent's side, in one call.
    const rein = require("..");
    expect(await rein.cosign(usual, { url: base, token: "t0ken" })).to.include({ allow: true }).and.have.property("signature");
    expect(await rein.cosign(usual, { url: "http://127.0.0.1:1", token: "t0ken" })).to.include({ allow: false, reason: "COSIGNER_UNREACHABLE" });
  });

  it("learns a Privy wallet it hasn't seen, the first time it is asked to co-sign for it", async () => {
    const fresh = "0x" + "4".repeat(40);
    const privy = async (url) => (url.startsWith("https://api.privy.io") ? { ok: true, status: 200, json: async () => ({ id: "w2", address: fresh }) } : Promise.reject(new Error("offline")));
    const s = http.createServer(cosign.privyHandler({ env, appId: APP, appSecret: "s3cret", key: key.privyPrivateKey, fetch: privy }));
    await new Promise((r) => s.listen(0, r));
    const at = (o) => fetch(`http://127.0.0.1:${s.address().port}/sign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const p = (to, amount) => ({ ...pay(to, amount), url: "https://api.privy.io/v1/wallets/w2/rpc" });
    try {
      expect((await at(p(PAYEES.inference.address, 10))).status).to.equal(200);
      expect((await at(p(PAYEES.data.address, 400))).status).to.equal(202);
      expect(guard.loadGuard(fresh, env).guard.learning).to.equal(true);
    } finally {
      s.close();
    }
  });

  it("won't set Privy up with keys that aren't P-256, or with the same key twice", async () => {
    const agent = cosign.keygen();
    const e = { ...env, REIN_PRIVY_PUBLIC_KEY: key.privyPublicKey };
    const run = (a, b) => cosign.main(["setup", "privy", "--wallet", WALLET_ID, "--policy", "p", "--agent-key", a, "--admin-key", b], { log: () => {}, env: e }).catch((x) => x.message);
    expect(await run("notakey", agent.privyPublicKey)).to.contain("--agent-key isn't a P-256 public key");
    expect(await run(agent.privyPublicKey, agent.privyPublicKey)).to.contain("three different keys");
    expect(await run(agent.privyPublicKey, key.privyPublicKey)).to.contain("three different keys");
  });

  it("sets Privy up: two key quorums, then the wallet, signed by its current owner", async () => {
    const owner = cosign.keygen();
    const agent = cosign.keygen();
    const admin = cosign.keygen();
    const sent = [];
    const fake = async (url, init) => {
      sent.push({ url, init, body: JSON.parse(init.body) });
      const id = url.endsWith("/key_quorums") ? `q${sent.length}` : WALLET_ID;
      return { ok: true, status: 200, text: async () => JSON.stringify({ id }) };
    };
    const e = { ...env, REIN_PRIVY_PUBLIC_KEY: key.privyPublicKey, PRIVY_APP_ID: APP, PRIVY_APP_SECRET: "s3cret", PRIVY_AUTHORIZATION_KEY: owner.privyPrivateKey };
    const logs = [];
    const args = ["setup", "privy", "--wallet", WALLET_ID, "--policy", "pol-1", "--agent-key", agent.privyPublicKey, "--admin-key", admin.privyPublicKey, "--send"];
    expect(await cosign.main(args, { log: (l) => logs.push(l), env: e, fetch: fake })).to.equal(0);
    expect(sent.map((x) => x.body.authorization_threshold)).to.deep.equal([1, 2, undefined]);
    expect(sent[1].body.public_keys).to.deep.equal([agent.privyPublicKey, key.privyPublicKey, admin.privyPublicKey]);
    const patch = sent[2];
    expect(patch.init.method).to.equal("PATCH");
    expect(patch.body).to.deep.equal({ owner_id: "q2", policy_ids: [], additional_signers: [{ signer_id: "q1", override_policy_ids: ["pol-1"] }] });
    const request = { method: "PATCH", url: patch.url, body: patch.body, headers: { "privy-app-id": APP } };
    const ownerPub = crypto.createPublicKey({ key: Buffer.from(owner.privyPublicKey, "base64"), format: "der", type: "spki" });
    expect(crypto.verify("sha256", sign.privyPayload(request), ownerPub, Buffer.from(patch.init.headers["privy-authorization-signature"], "base64"))).to.equal(true);
    expect(sent[0].init.headers["privy-authorization-signature"]).to.equal(undefined);
    expect(logs.join("\n")).to.contain("Rein is the second key on that wallet");
  });
});
