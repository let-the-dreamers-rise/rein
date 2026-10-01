// The wallet scanner: history in, compiled policy and drain exposure out.
//
// The compiler here is a port of v2/compile.py, so the first tests hold it to
// the original: against the committed policy (which CI regenerates from the
// Python compiler byte for byte) and, where Python and nyaya are available,
// against compile.py run fresh in robust mode. The rest run on the synthetic
// sample wallet (scan/sample.js), served through a fake Blockscout so the
// paging and decoding are exercised as well.
const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");
const { compileTrail } = require("../scan/compile");
const { evaluate } = require("../scan/evaluate");
const { toTrail, fetchHistory } = require("../scan/blockscout");
const { scanHistory, exportPolicy, markdown } = require("../scan");
const { sampleHistory, sampleFetch, AGENT, PAYEES, USDC, ROUTER, START } = require("../scan/sample");
const { callTool } = require("../mcp/rein-mcp");
const { runBatch, readWallets } = require("../scan/cli");
const { watch, policyFrom, parseSince } = require("../scan/watch");
const rein = require("../bin/rein");

const ROOT = path.join(__dirname, "..");
const V2_TRAIL = fs
  .readFileSync(path.join(ROOT, "v2", "out", "trail.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const plain = (x) => JSON.parse(JSON.stringify(x));

function pythonCompile(robust) {
  const nyaya = process.env.NYAYA_PATH || path.join(ROOT, "..", "nyaya");
  if (!fs.existsSync(path.join(nyaya, "nyaya"))) return null;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "rein-compile-"));
  const args = [path.join(ROOT, "v2", "compile.py"), path.join(ROOT, "v2", "out", "trail.jsonl"), "--out", out];
  if (robust) args.push("--robust");
  const run = spawnSync(process.env.PYTHON || "python3", args, { env: { ...process.env, NYAYA_PATH: nyaya } });
  if (run.status !== 0) return null;
  return JSON.parse(fs.readFileSync(path.join(out, "policy.json"), "utf8"));
}

describe("the wallet scanner", function () {
  this.timeout(60_000);

  describe("the compiler port", () => {
    it("draws the same bounds as the committed policy from v2/compile.py", () => {
      const committed = require("../v2/out/policy.json");
      const js = compileTrail(V2_TRAIL, { robust: false });
      expect(plain(js.bounds)).to.deep.equal(committed.bounds);
      expect(plain(js.onchain)).to.deep.equal(committed.onchain);
      expect(js.split).to.deep.equal(committed.split);
    });

    it("matches compile.py --robust run fresh, where python and nyaya are available", function () {
      const py = pythonCompile(true);
      if (!py) this.skip();
      const js = compileTrail(V2_TRAIL, { robust: true });
      expect(plain(js.bounds)).to.deep.equal(py.bounds);
      expect(plain(js.onchain)).to.deep.equal(py.onchain);
    });

    it("allows the 22 held-out v2 calls the on-chain replay allowed", () => {
      const result = require("../v2/out/result.json");
      for (const robust of [false, true]) {
        const c = compileTrail(V2_TRAIL, { robust });
        const e = evaluate(c.onchain, c.heldout);
        expect([e.allowed, e.total]).to.deep.equal([result.coverage.allowed, result.coverage.total]);
      }
    });
  });

  describe("the replay", () => {
    const policy = {
      agent: { windowSeconds: 3600, maxCallsPerWindow: 3, maxNativePerCall: 0, maxNativePerWindow: 0, expiry: 0 },
      targets: ["USDC"],
      selectors: { USDC: ["transfer"] },
      payees: ["A"],
      tokens: { USDC: { windowSeconds: 3600, maxPerWindow: 100, maxApproval: 0 } },
    };
    const pay = (ts, amount, payee = "A") => ({ ts, target: "USDC", selector: "transfer", kind: "transfer", token: "USDC", payee, amount, value: 0 });

    it("uses the contract's tumbling window, and a refusal charges nothing", () => {
      const e = evaluate(policy, [pay(0, 60), pay(10, 60), pay(20, 40), pay(3600, 100)]);
      expect(e.results.map((x) => x.reason)).to.deep.equal(["OK", "TOKEN_PER_WINDOW", "OK", "OK"]);
    });

    it("refuses a payee the policy never admitted, and counts calls per window", () => {
      const e = evaluate(policy, [pay(0, 1, "B"), pay(1, 1), pay(2, 1), pay(3, 1), pay(4, 1)]);
      expect(e.results.map((x) => x.reason)).to.deep.equal(["PAYEE_NOT_ALLOWED", "OK", "OK", "OK", "CALL_RATE"]);
    });

    it("charges an outflow no call declared, as v3's meter does", () => {
      const derived = { ...pay(5, 80), derived: true, payee: "POOL" };
      const e = evaluate(policy, [pay(0, 30), derived]);
      expect(e.results.map((x) => x.reason)).to.deep.equal(["OK", "OUTFLOW_EXCEEDED"]);
    });
  });

  describe("reading a wallet", () => {
    it("decodes calls, keeps a swap's outflow, skips what reverted, and counts nothing twice", () => {
      const history = sampleHistory();
      const { rows } = toTrail(history);
      const sentOk = history.transactions.filter((t) => t.status === "ok").length;
      expect(rows.filter((r) => !r.derived)).to.have.length(sentOk);
      // Every swap's USDC outflow is there once, as derived; direct payments are not repeated.
      const swaps = history.transactions.filter((t) => t.to.hash === ROUTER).length;
      expect(rows.filter((r) => r.derived)).to.have.length(swaps);
      expect(rows.some((r) => r.kind === "approve" && r.payee === ROUTER && r.token === USDC.address)).to.equal(true);
      expect(rows.some((r) => r.token === "native" && r.payee === PAYEES.bounty.address)).to.equal(true);
      expect(rows.some((r) => r.amount === 5000)).to.equal(false); // the reverted one
    });

    it("walks every page the explorer serves and reads the same history", async () => {
      const fetched = await fetchHistory(AGENT, { fetch: sampleFetch({ pageSize: 25 }), pause: 0 });
      expect(fetched.truncated).to.equal(false);
      expect(toTrail(fetched).rows).to.deep.equal(toTrail(sampleHistory()).rows);
    });

    it("says when it stopped before the end of the history", async () => {
      const fetched = await fetchHistory(AGENT, { fetch: sampleFetch({ pageSize: 25 }), pause: 0, maxPages: 2 });
      expect(fetched.truncated).to.equal(true);
      expect(scanHistory(fetched).caveats.join(" ")).to.match(/cut off/);
    });

    it("refuses an unknown chain by name", async () => {
      await expect(fetchHistory(AGENT, { chain: "solana" })).to.be.rejectedWith(/unknown chain "solana"/);
    });
  });

  describe("the report", () => {
    const report = scanHistory(sampleHistory());

    it("says it is the synthetic sample, first", () => {
      expect(report.synthetic).to.equal(true);
      expect(report.caveats[0]).to.match(/^SYNTHETIC/);
      expect(markdown(report)).to.contain("(synthetic sample)");
    });

    it("prices what can leave today against what the policy allows", () => {
      expect(report.exposureToday.usd).to.equal(29000);
      expect(report.exposureUnderPolicy.usdPerHour).to.be.above(0).and.below(1000);
      const usdc = report.exposureUnderPolicy.tokens.find((t) => t.symbol === "USDC");
      expect(usdc.perHour).to.equal(report.policy.onchain.tokens[USDC.address].maxPerWindow);
      // WETH was never sent anywhere, so the policy lets none of it go.
      expect(report.exposureUnderPolicy.tokens.find((t) => t.symbol === "WETH").perDay).to.equal(0);
    });

    it("bounds ETH in fractions of an ETH, not whole ones", () => {
      const eth = report.policy.onchain.agent.maxNativePerWindow;
      expect(eth).to.be.above(0.01).and.below(0.1);
    });

    it("refuses the first-time payee on the held-out days, and nothing else", () => {
      expect(report.coverage.total - report.coverage.allowed).to.equal(1);
      expect(report.coverage.reasons).to.deep.equal({ PAYEE_NOT_ALLOWED: 1 });
      expect(report.coverage.refusedExamples[0].what).to.contain("180 USDC");
    });

    it("admits only payees with a habit behind them", () => {
      expect(report.policy.onchain.payees).to.include.members([PAYEES.inference.address, PAYEES.data.address]);
      expect(report.policy.onchain.payees).to.not.include(PAYEES.stranger.address);
    });

    it("exports each vendor's API requests with real addresses, no rounding noise, and only the owner's ids left to fill", () => {
      const e = exportPolicy(report);
      const bodies = JSON.stringify(Object.values(e).flatMap((plan) => plan.steps.map((st) => st.request.body)));
      expect(bodies).to.not.match(/<[^>]+>/);
      expect(bodies).to.not.contain("(none)");
      expect(bodies).to.not.match(/e\+\d/);
      const holes = new Set([...bodies.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1]));
      expect([...holes].sort()).to.deep.equal(["aggregation_usdc.id", "now_ms", "policy.id", "turnkey_agent_user_id", "turnkey_organization_id"]);
      expect(e.turnkey.steps.at(-1).request.body.parameters.condition).to.contain(USDC.address.toLowerCase());
      // The bounty is paid in plain ETH, so it gets a rule on recipient and value.
      expect(e.turnkey.covers).to.include("ETH to known recipients");
      expect(e.privy.steps.at(-2).request.body.rules.map((x) => x.name)).to.include("ETH to known recipients");
    });

    it("puts the policy on Privy in order, feeding each returned id to the next request", async () => {
      const { apply } = require("../scan/apply");
      const plan = exportPolicy(report).privy;
      const sent = [];
      const fetch = async (url, init) => {
        sent.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
        const id = url.endsWith("/aggregations") ? "agg_1" : url.endsWith("/policies") ? "pol_1" : "wal_1";
        return { ok: true, status: 200, text: async () => JSON.stringify({ id }) };
      };
      const env = { PRIVY_APP_ID: "app", PRIVY_APP_SECRET: "secret" };
      await expect(apply(plan, { send: true, env, fetch, log: () => {} })).to.be.rejectedWith(/missing --wallet$/);
      const ids = await apply(plan, { send: true, vars: { privy_wallet_id: "wal_1" }, env, fetch, log: () => {} });
      expect(ids).to.deep.equal({ "aggregation_usdc.id": "agg_1", "policy.id": "pol_1" });
      expect(sent.map((x) => `${x.method} ${x.url}`)).to.deep.equal([
        "POST https://api.privy.io/v1/aggregations",
        "POST https://api.privy.io/v1/policies",
        "PATCH https://api.privy.io/v1/wallets/wal_1",
      ]);
      expect(sent[0].headers).to.include({ "privy-app-id": "app", authorization: `Basic ${Buffer.from("app:secret").toString("base64")}` });
      expect(JSON.stringify(sent[1].body)).to.contain('"aggregation.agg_1"');
      expect(sent[2].body).to.deep.equal({ policy_ids: ["pol_1"] });
    });

    // A fake vendor API that records each request and answers with an id.
    function vendorApi(answer) {
      const sent = [];
      const fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        sent.push({ url, method: init.method, headers: init.headers, raw: init.body, body });
        return { ok: true, status: 200, text: async () => JSON.stringify(answer(url, body)) };
      };
      return { sent, fetch };
    }

    it("stamps every Turnkey request with the API key, over the exact body sent", async () => {
      const { apply } = require("../scan/apply");
      const crypto = require("crypto");
      const ecdh = crypto.createECDH("prime256v1");
      ecdh.generateKeys();
      const env = { TURNKEY_API_PUBLIC_KEY: ecdh.getPublicKey("hex", "compressed"), TURNKEY_API_PRIVATE_KEY: ecdh.getPrivateKey("hex") };
      const api = vendorApi((url) => ({ activity: { id: "act", status: "ACTIVITY_STATUS_COMPLETED", result: url.endsWith("/create_policy") ? { createPolicyResult: { policyId: "tk_pol" } } : { createSmartContractInterfaceResult: { smartContractInterfaceId: "sci" } } } }));
      const plan = exportPolicy(report).turnkey;
      await expect(apply(plan, { send: true, env, fetch: api.fetch, log: () => {} })).to.be.rejectedWith(/missing --organization, --agent-user/);
      const ids = await apply(plan, { send: true, vars: { turnkey_organization_id: "org", turnkey_agent_user_id: "usr" }, env, fetch: api.fetch, log: () => {} });
      expect(ids).to.deep.equal({ "policy.id": "tk_pol" });
      expect(api.sent.map((x) => x.url.split("/").pop())).to.deep.equal(["create_smart_contract_interface", "create_policy"]);
      const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("3039301306072a8648ce3d020106082a8648ce3d030107032200", "hex"), ecdh.getPublicKey(null, "compressed")]), format: "der", type: "spki" });
      for (const x of api.sent) {
        const stamp = JSON.parse(Buffer.from(x.headers["X-Stamp"], "base64url"));
        expect(stamp.scheme).to.equal("SIGNATURE_SCHEME_TK_API_P256");
        expect(crypto.verify("sha256", Buffer.from(x.raw), pub, Buffer.from(stamp.signature, "hex"))).to.equal(true);
        expect(Number(x.body.timestampMs)).to.be.closeTo(Date.now(), 60_000);
        expect(x.body.organizationId).to.equal("org");
      }
      expect(api.sent[1].body.parameters.consensus).to.contain("user.id == 'usr'");
    });

    it("stops, and says so, when Turnkey holds a policy for more approvers", async () => {
      const { apply } = require("../scan/apply");
      const crypto = require("crypto");
      const ecdh = crypto.createECDH("prime256v1");
      ecdh.generateKeys();
      const env = { TURNKEY_API_PUBLIC_KEY: ecdh.getPublicKey("hex", "compressed"), TURNKEY_API_PRIVATE_KEY: ecdh.getPrivateKey("hex") };
      const api = vendorApi(() => ({ activity: { id: "act_9", status: "ACTIVITY_STATUS_CONSENSUS_NEEDED" } }));
      await expect(apply(exportPolicy(report).turnkey, { send: true, vars: { turnkey_organization_id: "o", turnkey_agent_user_id: "u" }, env, fetch: api.fetch, log: () => {} }))
        .to.be.rejectedWith(/waiting for approval in turnkey .*act_9/);
    });

    it("signs CDP requests with the API key, and the attach with the Wallet Secret over the body", async () => {
      const { apply } = require("../scan/apply");
      const crypto = require("crypto");
      const apiKey = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
      const wallet = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
      const env = {
        CDP_API_KEY_ID: "key-1",
        CDP_API_KEY_SECRET: apiKey.privateKey.export({ type: "pkcs8", format: "pem" }),
        CDP_WALLET_SECRET: wallet.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      };
      const api = vendorApi(() => ({ id: "cdp_pol" }));
      const ids = await apply(exportPolicy(report).coinbase, { send: true, env, fetch: api.fetch, log: () => {} });
      expect(ids).to.deep.equal({ "policy.id": "cdp_pol" });
      const [create, attach] = api.sent;
      expect(`${attach.method} ${attach.url}`).to.equal(`PUT https://api.cdp.coinbase.com/platform/v2/evm/accounts/${AGENT}`);
      expect(attach.body).to.deep.equal({ accountPolicy: "cdp_pol" });
      const claims = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url"));
      const verify = (jwt, key) => {
        const [h, c, sig] = jwt.split(".");
        return crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));
      };
      const bearer = create.headers.authorization.replace(/^Bearer /, "");
      expect(verify(bearer, apiKey.publicKey)).to.equal(true);
      expect(claims(bearer)).to.include({ sub: "key-1", iss: "cdp" });
      expect(claims(bearer).uris).to.deep.equal(["POST api.cdp.coinbase.com/platform/v2/policy-engine/policies"]);
      expect(create.headers).to.not.have.property("X-Wallet-Auth");
      const walletAuth = attach.headers["X-Wallet-Auth"];
      expect(verify(walletAuth, wallet.publicKey)).to.equal(true);
      expect(claims(walletAuth).reqHash).to.equal(crypto.createHash("sha256").update(JSON.stringify({ accountPolicy: "cdp_pol" })).digest("hex"));
      await expect(apply(exportPolicy(report).coinbase, { send: true, env: { ...env, CDP_WALLET_SECRET: "" }, fetch: api.fetch, log: () => {} })).to.be.rejectedWith(/CDP_WALLET_SECRET/);
    });

    it("says what the chain shows, not what will happen, and names what it cannot see", () => {
      expect(report.verdict).to.contain("has no on-chain limit on where it can go");
      expect(report.exposureToday.to).to.equal("no on-chain limit");
      expect(report.caveats).to.include("A signing policy held off chain (Privy, Turnkey, CDP) is invisible to this scan.");
      expect(markdown(report)).to.contain("## Today: no on-chain limit").and.contain("invisible to this scan");
    });

    it("declines to compile from a wallet with no history", () => {
      const empty = { ...sampleHistory(), transactions: [], tokenTransfers: [], synthetic: false };
      const r = scanHistory(empty);
      expect(r.policy).to.equal(undefined);
      expect(r.verdict).to.match(/not enough history/);
      expect(exportPolicy(r)).to.equal(null);
    });
  });

  describe("a batch of wallets", () => {
    // The sample's history, moved to another address and passed off as real.
    const real = (address) => {
      const moved = JSON.stringify(sampleHistory()).replace(new RegExp(AGENT.slice(2), "gi"), address.slice(2));
      return scanHistory({ ...JSON.parse(moved), synthetic: false });
    };
    const [A, B, C] = ["a1", "b2", "c3"].map((x) => ethers.getAddress("0x" + x.repeat(20)));
    let dir;
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "rein-batch-"));
      fs.writeFileSync(
        path.join(dir, "wallets.csv"),
        `address,label,team,contact\n${A},ops agent,Team A,a@example.com\n\n${B},trader,Team B,\n${A},dup,,\nnot-an-address,x,,\n`
      );
    });

    it("reads each address once, skipping the header and junk", () => {
      expect(readWallets(path.join(dir, "wallets.csv"))).to.deep.equal([A, B]);
    });

    it("writes a folder per wallet, then public totals and a private CSV", async () => {
      const out = path.join(dir, "reports");
      const logs = [];
      const res = await runBatch({ batch: path.join(dir, "wallets.csv"), out, pause: 0 }, { scanOne: async (a) => real(a), log: (l) => logs.push(l) });
      expect(res).to.include({ wallets: 2, scanned: 2 });
      for (const a of [A, B]) {
        for (const f of ["report.md", "report.json", "trail.jsonl", "export/turnkey.json"]) expect(fs.existsSync(path.join(out, a.toLowerCase(), f)), f).to.equal(true);
      }
      const pub = fs.readFileSync(path.join(out, "summary.md"), "utf8");
      expect(pub).to.contain("Wallets scanned: **2** real").and.contain("$58,000").and.not.contain(A.slice(2, 10).toLowerCase()).and.not.contain(A.slice(2, 10));
      expect(res.totals.coverage).to.include({ allowed: 78, total: 80 });
      const priv = fs.readFileSync(path.join(out, "summary-private.csv"), "utf8");
      expect(priv).to.contain(`${A},ops agent,Team A,a@example.com`);
      expect(JSON.parse(fs.readFileSync(path.join(out, "errors.json"), "utf8"))).to.deep.equal([]);
      // One Turnkey policy for the fleet, each agent's limits keyed by its own address.
      const fleet = JSON.parse(fs.readFileSync(path.join(out, "turnkey-fleet.json"), "utf8"));
      const create = fleet.steps.filter((st) => st.request.url.endsWith("/create_policy"));
      expect(create).to.have.length(1);
      const p = create[0].request.body.parameters;
      expect(p.consensus).to.contain("user.tags.contains(");
      for (const a of [A, B]) expect(p.condition).to.contain(`wallet_account.address == '${a.toLowerCase()}'`);
    });

    it("retries a failed wallet once, records one that fails twice, and carries on", async () => {
      fs.appendFileSync(path.join(dir, "wallets.csv"), `${C},broken,,\n`);
      const tries = {};
      const scanOne = async (a) => {
        tries[a] = (tries[a] || 0) + 1;
        if (a === A && tries[a] === 1) throw new Error("429 too many requests");
        if (a === C) throw new Error("explorer down");
        return real(a);
      };
      const out = path.join(dir, "reports");
      const res = await runBatch({ batch: path.join(dir, "wallets.csv"), out, pause: 0 }, { scanOne, log: () => {} });
      expect(tries).to.deep.equal({ [A]: 2, [B]: 1, [C]: 2 });
      expect(res.scanned).to.equal(2);
      expect(res.errors).to.deep.equal([{ address: C, error: "explorer down" }]);
    });

    it("leaves the synthetic sample out of the totals", async () => {
      const out = path.join(dir, "reports");
      const res = await runBatch({ batch: path.join(dir, "wallets.csv"), out, pause: 0 }, { scanOne: async () => scanHistory(sampleHistory()), log: () => {} });
      expect(res.totals).to.include({ real: 0, synthetic: 2 });
    });
  });

  describe("watching a wallet", () => {
    const DAY = 86400;
    const policy = scanHistory(sampleHistory()).policy.onchain;

    // The explorer shows the wallet up to day 50; each poll moves time on.
    function growing(days) {
      let now = START + days[0] * DAY;
      const steps = days.slice(1);
      return { fetch: sampleFetch({ asOf: () => now }), sleep: async () => { now = START + steps.shift() * DAY; } };
    }

    it("alerts on the one payment outside the policy, once, and posts it to the webhook", async () => {
      const { fetch: explorer, sleep } = growing([50, 52, 53]);
      const posted = [];
      const fetch = async (url, init) => {
        if (String(url).startsWith("https://hooks.example")) {
          posted.push(JSON.parse(init.body));
          return { ok: true, status: 200 };
        }
        return explorer(url, init);
      };
      const { alerts } = await watch(AGENT, { policy, fetch, sleep, polls: 2, pause: 0, webhook: "https://hooks.example/x", log: () => {} });
      expect(alerts.map((a) => a.reason)).to.deep.equal(["PAYEE_NOT_ALLOWED"]);
      expect(alerts[0].text).to.contain("pay 180 USDC").and.contain("base.blockscout.com/tx/0x");
      expect(posted).to.have.length(1);
      expect(posted[0].text).to.equal(alerts[0].text).and.equal(posted[0].content);
    });

    it("stays quiet while the wallet does what its policy was compiled from", async () => {
      // The raw-maximum policy admits every call it was compiled from, so
      // replaying days the compiler saw must raise nothing.
      const naive = scanHistory(sampleHistory(), { robust: false }).policy.onchain;
      const { fetch, sleep } = growing([10, 20, 30, 40]);
      const { alerts } = await watch(AGENT, { policy: naive, fetch, sleep, polls: 3, pause: 0, log: () => {} });
      expect(alerts).to.deep.equal([]);
    });

    it("compiles the policy itself when given none", async () => {
      const { fetch, sleep } = growing([50, 52]);
      const lines = [];
      const { alerts, policy: compiled } = await watch(AGENT, { fetch, sleep, polls: 1, pause: 0, log: (l) => lines.push(l) });
      expect(lines[0]).to.match(/^compiled a policy from \d+ calls/);
      expect(compiled.payees).to.not.include(PAYEES.stranger.address);
      expect(alerts.map((a) => a.reason)).to.include("PAYEE_NOT_ALLOWED");
    });

    it("checks once from a schedule: compiles from before --since and reports only what came after", async () => {
      const fetch = sampleFetch({ asOf: () => START + 53 * DAY });
      const lines = [];
      const { alerts, policy: compiled } = await watch(AGENT, { since: START + 51 * DAY, fetch, pause: 0, log: (l) => lines.push(l) });
      expect(compiled.payees).to.not.include(PAYEES.stranger.address);
      expect(alerts.map((a) => a.reason)).to.deep.equal(["PAYEE_NOT_ALLOWED"]);
      expect(alerts[0].text).to.contain("pay 180 USDC");
      expect(lines.at(-1)).to.match(/^checked \d+ row\(s\) since 2026-08-21T00:00:00.000Z: 1 outside the policy\.$/);

      const quiet = await watch(AGENT, { since: START + 52 * DAY, policy, fetch, pause: 0, log: () => {} });
      expect(quiet.alerts).to.deep.equal([]);
    });

    it("reads --since as a duration, unix seconds or a date", () => {
      const now = 1_800_000_000;
      expect(parseSince("20m", now)).to.equal(now - 1200);
      expect(parseSince("2d", now)).to.equal(now - 172800);
      expect(parseSince("1790000000", now)).to.equal(1790000000);
      expect(parseSince("2026-09-01T00:00:00Z", now)).to.equal(Date.UTC(2026, 8, 1) / 1000);
      expect(() => parseSince("soon", now)).to.throw(/--since takes/);
    });

    it("reads the policy out of a saved report", () => {
      const saved = JSON.parse(JSON.stringify(scanHistory(sampleHistory())));
      expect(policyFrom(saved)).to.deep.equal(policy);
      expect(() => policyFrom({ verdict: "x" })).to.throw(/no compiled policy/);
    });
  });

  describe("the ways in", () => {
    it("answers `rein` with what it can do, and `rein 0x…` with a scan", async () => {
      const run = spawnSync(process.execPath, [path.join(ROOT, "bin", "rein.js"), "help"], { encoding: "utf8" });
      expect(run.status).to.equal(0);
      expect(run.stderr).to.contain("rein scan").and.contain("rein watch").and.contain("rein mcp --sandbox");
      const sample = spawnSync(process.execPath, [path.join(ROOT, "bin", "rein.js"), "scan", "--sample", "--json"], { encoding: "utf8" });
      expect(JSON.parse(sample.stdout).coverage.total).to.equal(40);
      expect(rein.parseWatch(["0xabc", "--every", "30", "--webhook", "https://h"])).to.include({ address: "0xabc", every: 30, webhook: "https://h" });
      expect(rein.parseWatch(["0xabc", "--since", "20m", "--fail-on-alert"])).to.include({ since: "20m", failOnAlert: true });
    });

    it("`rein try` runs the gauntlet in a terminal: one payment through, every drain refused by the contract", async () => {
      const { runTry } = require("../bin/try");
      const lines = [];
      const { rows, left, stranger } = await runTry({ log: (l) => lines.push(l) });
      expect(rows.map((r) => (r.last.paid ? "paid" : r.last.reason))).to.deep.equal([
        "paid",
        "PAYEE_NOT_ALLOWED",
        "PAYEE_NOT_ALLOWED",
        "TOKEN_PER_WINDOW",
        "INTENT_REQUIRED",
        "TOKEN_PER_WINDOW",
      ]);
      expect(left).to.equal(250);
      expect(stranger).to.equal(0);
      expect(lines.join("\n")).to.contain("What this does not stop");
    });

    it("publishes every file the commands load, and nothing it does not need", async () => {
      const pkg = require("../package.json");
      const esbuild = require("esbuild");
      const entries = [...new Set([...Object.values(pkg.bin), pkg.main])].map((b) => path.join(ROOT, b));
      const { metafile } = await esbuild.build({ entryPoints: entries, bundle: true, platform: "node", write: false, outdir: os.tmpdir(), metafile: true, logLevel: "silent" });
      const local = Object.keys(metafile.inputs).filter((f) => !f.includes("node_modules"));
      const shipped = (f) => f === "package.json" /* npm always ships it */ || pkg.files.some((p) => (p.endsWith("/") ? f.startsWith(p) : p.includes("*") ? f.startsWith(p.split("*")[0]) && !f.slice(p.split("*")[0].length).includes("/") : f === p));
      expect(local.filter((f) => !shipped(f))).to.deep.equal([]);
      expect(pkg.private).to.equal(undefined);
      expect(pkg.bin[pkg.name]).to.equal("bin/rein.js"); // so `npx rein-wallet` knows what to run
      expect(require("../server.json").packages[0].identifier).to.equal(pkg.name);
      expect(require("../server.json").name).to.equal(pkg.mcpName);
    });

    it("runs from the command line on the sample, with nothing on the network", () => {
      const run = spawnSync(process.execPath, [path.join(ROOT, "scan", "cli.js"), "--sample", "--json"], { encoding: "utf8" });
      expect(run.status, run.stderr).to.equal(0);
      expect(JSON.parse(run.stdout).coverage.total).to.equal(40);
    });

    it("answers rein_scan_wallet over MCP without a Rein account", async () => {
      const text = await callTool("rein_scan_wallet", { address: "sample" });
      expect(text).to.contain("synthetic sample").and.contain("Would it have got in the way?");
    });
  });
});
