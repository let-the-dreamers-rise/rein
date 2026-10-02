// rein safe: a second look at a Safe's queue before the last signature.
const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const safe = require("../scan/safe");
const cu = require("../scan/checkup");
const { poisonedSampleHistory, AGENT, PAYEES, USDC } = require("../scan/sample");

const ERC20 = new ethers.Interface(["function transfer(address,uint256)", "function approve(address,uint256)"]);
const SAFE = new ethers.Interface(["function addOwnerWithThreshold(address,uint256)", "function multiSend(bytes)"]);
const MULTISEND = "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D";
const usdc = (n) => ethers.parseUnits(String(n), 6);
const someone = (label) => ethers.getAddress(ethers.dataSlice(ethers.id(`safe test: ${label}`), 12));
const pay = (to, n) => ({ to: USDC.address, value: "0", data: ERC20.encodeFunctionData("transfer", [to, usdc(n)]), operation: 0 });
const pack = (calls) => ethers.concat(calls.map((c) => ethers.solidityPacked(["uint8", "address", "uint256", "uint256", "bytes"], [c.operation || 0, c.to, c.value || 0, ethers.dataLength(c.data), c.data])));

describe("rein safe", function () {
  this.timeout(60000);
  let env;
  let history;
  let fake;
  const OWNERS = [someone("owner a"), someone("owner b"), someone("owner c")];

  beforeEach(() => {
    env = { REIN_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "rein-safe-")) };
    history = poisonedSampleHistory();
    fake = cu.checkup(history).attack.lookalikes.find((x) => x.real === PAYEES.inference.address).fake;
  });

  const queue = () => [
    { nonce: 7, safeTxHash: "0x01", confirmations: [{}], confirmationsRequired: 2, ...pay(PAYEES.inference.address, 40) },
    { nonce: 8, safeTxHash: "0x02", confirmations: [{}], confirmationsRequired: 2, ...pay(fake, 5000) },
    { nonce: 9, safeTxHash: "0x03", confirmations: [], confirmationsRequired: 2, ...pay(someone("stranger"), 2000) },
    {
      nonce: 10,
      safeTxHash: "0x04",
      confirmations: [{}],
      confirmationsRequired: 2,
      to: MULTISEND,
      value: "0",
      operation: 1,
      data: SAFE.encodeFunctionData("multiSend", [pack([pay(PAYEES.data.address, 10), { to: USDC.address, data: ERC20.encodeFunctionData("approve", [someone("router"), ethers.MaxUint256]) }])]),
    },
    { nonce: 11, safeTxHash: "0x05", confirmations: [], confirmationsRequired: 2, to: someone("evil lib"), value: "0", data: "0x12345678", operation: 1 },
    { nonce: 12, safeTxHash: "0x06", confirmations: [], confirmationsRequired: 2, to: AGENT, value: "0", data: SAFE.encodeFunctionData("addOwnerWithThreshold", [someone("new owner"), 1]), operation: 0 },
    { nonce: 6, safeTxHash: "0x00", confirmations: [], confirmationsRequired: 2, ...pay(fake, 1) }, // already replaced: below the Safe's nonce
  ];
  const service = (q = queue()) => ({ info: async () => ({ nonce: 7, threshold: 2, owners: OWNERS }), queue: async () => q });
  const run = (o = {}) => safe.watchOnce(AGENT, { safeApi: service(), history, env, ...o });

  it("tells signers which queued payments need a second look, and why", async () => {
    const r = await run();
    const by = Object.fromEntries(r.queue.map((q) => [q.nonce, q]));
    expect(Object.keys(by).map(Number)).to.deep.equal([7, 8, 9, 10, 11, 12]);
    expect(by[7].found).to.deep.equal([]);
    expect(by[8].found[0]).to.include({ level: "danger" });
    expect(by[8].found[0].why).to.contain("address poisoning").and.contain(PAYEES.inference.address);
    expect(by[9].found[0].why).to.contain("never paid").and.contain("$2,000");
    // A MultiSend is read call by call: the usual payment is fine, the unlimited approval to a stranger isn't.
    expect(by[10].what).to.contain("pay 10 USDC").and.contain("spend all its USDC");
    expect(by[10].found.map((f) => f.level)).to.deep.equal(["warn"]);
    expect(by[11].found[0].why).to.contain("delegatecall");
    expect(by[12].found[0].why).to.contain("addOwnerWithThreshold");
    const out = safe.text(r);
    expect(out).to.contain("2 of 3 owners sign").and.contain("#8 (1 of 2 signed)").and.contain("DON'T SIGN YET").and.contain("#7 (1 of 2 signed)");
  });

  it("posts each flagged transaction once, and again only if what it found changes", async () => {
    expect((await run()).fresh.map((q) => q.nonce)).to.deep.equal([8, 9, 10, 11, 12]);
    expect((await run()).fresh).to.deep.equal([]);
    const q = queue();
    q.push({ nonce: 13, safeTxHash: "0x07", confirmations: [], confirmationsRequired: 2, ...pay(fake, 3) });
    const r = await safe.watchOnce(AGENT, { safeApi: service(q), history, env });
    expect(r.fresh.map((x) => x.nonce)).to.deep.equal([13]);
    expect(safe.alertText(r)).to.match(/^\*Rein, before you sign:\* 1 transaction in the queue of Safe 0x/);
  });

  it("flags a payment far above the most the Safe has paid that payee, and runs a made-up Safe offline", async () => {
    const r = await safe.watchOnce(AGENT, { safeApi: service([{ nonce: 7, safeTxHash: "0x0a", confirmations: [], confirmationsRequired: 2, ...pay(PAYEES.inference.address, 4000) }]), history, env });
    expect(r.queue[0].found.map((f) => f.why).join()).to.contain("more than 3× the most this Safe has ever paid Inference API");
    const lines = [];
    expect(await safe.main(["--sample"], { log: (l) => lines.push(l) })).to.equal(1);
    expect(lines.join("\n")).to.contain("made-up sample Safe").and.contain("#41 (1 of 2 signed): pay 15 USDC to Inference API. Looks normal (this isn't a guarantee).").and.contain("#42 (1 of 2 signed): pay 48,000 USDC");
  });

  it("runs on the web page from the same bundle, keeping nothing", async () => {
    const vm = require("vm");
    const code = fs.readFileSync(path.join(__dirname, "..", "web", "scan", "rein-scan.js"), "utf8");
    const sandbox = { window: { crypto: globalThis.crypto }, crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, console };
    vm.runInNewContext(`${code};window.Rein = Rein;`, sandbox);
    const s = sandbox.window.Rein.safe.sampleSafe();
    const r = await sandbox.window.Rein.safe.watchOnce(s.address, { safeApi: s.safeApi, history: s.history, remember: false });
    expect(r.queue.map((q) => q.found.map((f) => f.level).join())).to.deep.equal(["", "danger", "warn", "warn"]);
    const page = fs.readFileSync(path.join(__dirname, "..", "web", "safe", "index.html"), "utf8");
    expect(page).to.contain("Rein.safe.safeGateway").and.contain("remember: false").and.contain("window.history.replaceState");
  });

  it("counts ETH the Safe paid out through internal transactions", async () => {
    const { fetchEthPaid } = require("../scan/blockscout");
    const vendor = someone("eth vendor");
    const page = { items: [{ from: { hash: AGENT }, to: { hash: vendor }, value: "2000000000000000000", success: true, timestamp: "2026-08-01T00:00:00Z" }, { from: { hash: AGENT }, to: { hash: someone("failed") }, value: "1", success: false, timestamp: "2026-08-01T00:00:00Z" }], next_page_params: null };
    const eth = await fetchEthPaid(AGENT, { fetch: async () => ({ ok: true, status: 200, json: async () => page }), pause: 0 });
    expect(eth).to.deep.equal([{ payee: vendor, amount: 2, ts: Date.parse("2026-08-01T00:00:00Z") / 1000 }]);
    const tx = { nonce: 7, safeTxHash: "0x0b", confirmations: [], confirmationsRequired: 2, to: vendor, value: "1500000000000000000", data: "0x", operation: 0 };
    expect((await safe.watchOnce(AGENT, { safeApi: service([tx]), history, ethPaid: eth, env })).queue[0].found).to.deep.equal([]);
    expect((await safe.watchOnce(AGENT, { safeApi: service([{ ...tx, safeTxHash: "0x0c" }]), history, ethPaid: [], env })).queue[0].found[0].why).to.contain("never paid");
  });

  describe("attacked like a skeptical treasury would", () => {
    const one = (q) => safe.watchOnce(AGENT, { safeApi: service([{ nonce: 7, safeTxHash: `0x${Math.random().toString(16).slice(2, 10)}`, confirmations: [], confirmationsRequired: 2, ...q }]), history, env });

    it("adds up a payment split across a batch, so it can't slip under the dollar line", async () => {
      const to = someone("split payee");
      const r = await one({ to: MULTISEND, value: "0", operation: 1, data: SAFE.encodeFunctionData("multiSend", [pack([pay(to, 600), pay(to, 600), pay(to, 600)])]) });
      const why = r.queue[0].found.map((f) => f.why);
      expect(why).to.have.length(1);
      expect(why[0]).to.contain("never paid").and.contain("$1,800");
    });

    it("doesn't cry wolf on a grants Safe that pays new addresses every week", async () => {
      const iface = new ethers.Interface(["function transfer(address,uint256)"]);
      let i = 0;
      for (const t of history.transactions) if ((t.raw_input || "").startsWith("0xa9059cbb")) t.raw_input = iface.encodeFunctionData("transfer", [someone(`grantee ${i++}`), 5_000_000n]);
      const r = await one(pay(someone("next grantee"), 5000));
      expect(r.queue[0].found.map((f) => f.level)).to.deep.equal(["info"]);
      expect(r.fresh).to.deep.equal([]);
      expect(safe.text(r)).to.contain("Looks normal (this isn't a guarantee):").and.contain("pays new addresses often");
      // A lookalike is still a lookalike.
      expect((await one(pay(fake, 5))).queue[0].found[0].level).to.equal("danger");
    });

    it("won't let a batch approve a lookalike of a contract the Safe uses (the Request Finance theft)", async () => {
      // The Safe pays invoices through a batch-payment contract: approve it, then call it.
      const real = ethers.getAddress("0x8ae7aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3c51");
      const lookalike = ethers.getAddress("0x8ae7bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb3c51");
      const BATCH = new ethers.Interface(["function batchERC20PaymentsWithReference(address,address[],uint256[],bytes[],uint256[],address)"]);
      const approve = (spender) => ({ to: USDC.address, value: 0n, operation: 0, data: ERC20.encodeFunctionData("approve", [spender, usdc(50000)]) });
      const batchPay = (contract) => ({ to: contract, value: 0n, operation: 0, data: BATCH.encodeFunctionData("batchERC20PaymentsWithReference", [USDC.address, [PAYEES.inference.address], [usdc(50000)], ["0x01"], [0], PAYEES.inference.address]) });
      const multi = (calls) => ({ to: MULTISEND, value: "0", operation: 1, data: SAFE.encodeFunctionData("multiSend", [pack(calls)]) });
      const executed = [{ ...multi([approve(real), batchPay(real)]), isExecuted: true }];
      const run = (q) => safe.watchOnce(AGENT, { safeApi: { ...service([{ nonce: 7, safeTxHash: ethers.id(JSON.stringify(q.data)), confirmations: [], confirmationsRequired: 2, ...q }]), executed: async () => executed }, history, env });

      const attack = await run(multi([approve(lookalike), batchPay(lookalike)]));
      const found = attack.queue[0].found;
      expect(found.map((f) => f.level)).to.deep.equal(["danger", "danger"]);
      expect(found[0].why).to.contain(`it lets ${lookalike} spend the Safe's USDC`).and.contain(`like ${real}, a contract the Safe has used`);
      expect(found[1].why).to.contain(`it calls ${lookalike}`);
      expect(safe.text(attack)).to.contain("DON'T SIGN YET");
      // The real contract, as usual: nothing to say.
      expect((await run(multi([approve(real), batchPay(real)]))).queue[0].found).to.deep.equal([]);
      // Without the Safe's own transactions it can only say the spender is new.
      const blind = await safe.watchOnce(AGENT, { safeApi: service([{ nonce: 7, safeTxHash: "0x01", confirmations: [], confirmationsRequired: 2, ...multi([approve(lookalike)]) }]), history, env });
      expect(blind.queue[0].found.map((f) => f.level)).to.deep.equal(["warn"]);

      // Safe's gateway serves those executed transactions with no key.
      const base = "https://safe-client.safe.global/v1/chains/8453";
      const ex = executed[0];
      const pages = {
        [`${base}/safes/${AGENT}/transactions/history`]: { results: [{ type: "DATE_LABEL" }, { type: "TRANSACTION", transaction: { id: "x1", txInfo: { type: "Custom" } } }, { type: "TRANSACTION", transaction: { id: "t1", txInfo: { type: "Transfer" } } }], next: null },
        [`${base}/transactions/x1`]: { txData: { to: { value: ex.to }, value: "0", hexData: ex.data, operation: 1 }, detailedExecutionInfo: { nonce: 3 }, txStatus: "SUCCESS" },
      };
      const asked = [];
      const gw = safe.safeGateway("base", { fetch: async (url) => (asked.push(url), { ok: true, status: 200, json: async () => pages[url] }) });
      const got = await gw.executed(AGENT);
      expect(got.map((t) => [t.to, t.operation, t.isExecuted])).to.deep.equal([[MULTISEND, 1, true]]);
      expect(asked).to.not.include(`${base}/transactions/t1`);
      expect(require("../web/api/safe").target(`/api/safe?path=v1/chains/8453/safes/${AGENT}/transactions/history`)).to.equal(`${base}/safes/${AGENT}/transactions/history`);
    });

    it("says so when a Safe has no payment history at all", async () => {
      history.transactions = [];
      history.tokenTransfers = [];
      const r = await one(pay(someone("first ever"), 2000));
      expect(r.queue[0].found[0].why).to.contain("no payment history yet");
    });

    it("counts payments in the DAO's own unpriced token as payments, not as poisoning", async () => {
      const gov = ethers.getAddress(ethers.dataSlice(ethers.id("dao token"), 12));
      const member = someone("dao contributor");
      const t = JSON.parse(JSON.stringify(history.tokenTransfers.find((x) => x.to?.hash === PAYEES.inference.address)));
      Object.assign(t, { transaction_hash: ethers.id("gov payment"), to: { hash: member }, token: { address_hash: gov, address: gov, symbol: "DAO", name: "DAO Token", decimals: "18", type: "ERC-20", exchange_rate: null, reputation: "ok" }, total: { value: "1000000000000000000000", decimals: "18" } });
      history.tokenTransfers.push(t);
      const before = (await one(pay(PAYEES.inference.address, 1))).poisoning;
      const r = await one({ to: gov, value: "0", operation: 0, data: ERC20.encodeFunctionData("transfer", [member, 10n ** 21n]) });
      expect(r.queue[0].found).to.deep.equal([]);
      expect(r.poisoning).to.equal(before);
    });

    it("prices a token the Safe never held from what Safe's service says about the transfer", async () => {
      const eurc = someone("a euro token");
      const r = await one({ to: eurc, value: "0", operation: 0, data: ERC20.encodeFunctionData("transfer", [someone("eu vendor"), 2_500_000_000n]), tokens: [{ address: eurc, symbol: "EURC", decimals: 6 }] });
      expect(r.queue[0].what).to.contain("pay 2,500 EURC");
      expect(r.queue[0].found[0].why).to.contain("$2,500");
      // Unknown, unpriced: still flagged, and says why.
      const odd = await one({ to: someone("odd token"), value: "0", operation: 0, data: ERC20.encodeFunctionData("transfer", [someone("odd payee"), 1n]) });
      expect(odd.queue[0].what).to.contain("an unknown amount of");
      expect(odd.queue[0].found[0].why).to.contain("can't price");
    });
  });

  it("flags a payee that looks like one of the Safe's owners", async () => {
    const o = OWNERS[1];
    const twin = ethers.getAddress(`0x${o.slice(2, 6)}${"0".repeat(32)}${o.slice(-4)}`.toLowerCase());
    const r = await safe.watchOnce(AGENT, { safeApi: service([{ nonce: 7, safeTxHash: "0x09", confirmations: [], confirmationsRequired: 2, ...pay(twin, 50) }]), history, env });
    expect(r.queue[0].found[0].why).to.contain("one of the Safe's owners");
  });

  it("is `rein safe`, and says plainly what it needs", async () => {
    // With no key it reads Safe's public gateway, the one the Safe{Wallet} app uses.
    const id = `multisig_${AGENT}_0x02`;
    const tx = pay(fake, 5000);
    const gw = {
      [`https://safe-client.safe.global/v1/chains/8453/safes/${AGENT}`]: { nonce: 8, threshold: 2, owners: OWNERS.map((value) => ({ value })) },
      [`https://safe-client.safe.global/v1/chains/8453/safes/${AGENT}/transactions/queued`]: { results: [{ type: "LABEL", label: "Next" }, { type: "TRANSACTION", transaction: { id } }] },
      [`https://safe-client.safe.global/v1/chains/8453/transactions/${id}`]: { txStatus: "AWAITING_CONFIRMATIONS", txData: { to: { value: tx.to }, value: "0", hexData: tx.data, operation: 0 }, detailedExecutionInfo: { nonce: 8, safeTxHash: "0x02", confirmationsRequired: 2, confirmations: [{}] } },
    };
    const lines = [];
    const code = await safe.main([AGENT, "--webhook", "https://hooks.example/x"], {
      log: (l) => lines.push(l),
      env: { ...env },
      fetch: async (url, init) => {
        if (url.startsWith("https://hooks.")) return lines.push(`POSTED ${JSON.parse(init.body).text}`), { ok: true, status: 200 };
        if (gw[url]) return { ok: true, status: 200, json: async () => gw[url] };
        return Promise.reject(new Error(`unexpected ${url}`));
      },
    }).catch((e) => e);
    // The Safe's own history comes from the explorer, which this test doesn't reach.
    expect(String(code.message || code)).to.contain("unexpected https://base.blockscout.com");
    const r = await safe.watchOnce(AGENT, { safeApi: safe.safeGateway("base", { fetch: async (url) => ({ ok: true, status: 200, json: async () => gw[url] }) }), history, env });
    expect(r.queue.map((q) => [q.nonce, q.signed, q.needed, q.found[0]?.level])).to.deep.equal([[8, 1, 2, "danger"]]);
    expect(r.queue[0].found[0].why).to.contain("Inference API (");
    expect(() => safe.parse(["0x12"])).to.throw("isn't an address");
    expect(() => safe.parse([AGENT, "--webhook", "http://x"])).to.throw("https");
    // Safe's API is asked with the key, at the chain's own path.
    const asked = [];
    const api = safe.safeApi("base", { apiKey: "k", fetch: async (url, init) => (asked.push([url, init.headers.authorization]), { ok: true, status: 200, json: async () => ({ results: [] }) }) });
    await api.queue(AGENT, 3);
    expect(asked[0]).to.deep.equal([`https://api.safe.global/tx-service/base/api/v1/safes/${AGENT}/multisig-transactions/?executed=false&nonce__gte=3&ordering=nonce&limit=100`, "Bearer k"]);
    expect(require("../bin/rein").main).to.be.a("function");
    // Bug reports ask for it.
    const v = require("child_process").spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "rein.js"), "--version"], { encoding: "utf8" });
    expect(v.stdout.trim()).to.equal(require("../package.json").version);
  });
  it("reads a long queue page by page, and the site's pass-through only lets Safe reads through", async () => {
    const base = "https://safe-client.safe.global/v1/chains/8453";
    const asked = [];
    const item = (id) => ({ type: "TRANSACTION", transaction: { id } });
    const pages = {
      [`${base}/safes/${AGENT}/transactions/queued`]: { results: [{ type: "LABEL" }, item("a"), item("b")], next: `${base}/safes/${AGENT}/transactions/queued?cursor=2` },
      [`${base}/safes/${AGENT}/transactions/queued?cursor=2`]: { results: [item("b"), item("c")], next: null },
    };
    for (const [id, n] of [["a", 1], ["b", 2], ["c", 3]]) pages[`${base}/transactions/${id}`] = { txData: { to: { value: PAYEES.inference.address }, value: "0" }, detailedExecutionInfo: { nonce: n, confirmationsRequired: 2 } };
    const gw = safe.safeGateway("base", { fetch: async (url) => (asked.push(url), { ok: true, status: 200, json: async () => pages[url] }) });
    expect((await gw.queue(AGENT)).map((t) => t.nonce)).to.deep.equal([1, 2, 3]);
    const missing = safe.safeGateway("base", { fetch: async () => ({ ok: false, status: 404 }) });
    await missing.info(AGENT).then(() => expect.fail(), (e) => expect(e.message).to.equal("there is no Safe at that address on Base (on Ethereum? choose Ethereum, or add --chain ethereum)"));

    const proxy = require("../web/api/safe");
    expect(proxy.target(`/api/safe?path=v1/chains/8453/safes/${AGENT}/transactions/queued&cursor=x&evil=1`)).to.equal(`https://safe-client.safe.global/v1/chains/8453/safes/${AGENT}/transactions/queued?cursor=x`);
    expect(proxy.target(`/api/safe/v1/chains/1/transactions/multisig_${AGENT}_0xab`)).to.equal(`https://safe-client.safe.global/v1/chains/1/transactions/multisig_${AGENT}_0xab`);
    for (const bad of ["/api/safe?path=v1/chains/1/safes/0x12", "/api/safe?path=v2/owners/x", "/api/safe?path=v1/chains/1/safes/../../x", "/api/safe?path=//evil.example/v1"]) expect(proxy.target(bad), bad).to.equal(null);
    const res = () => {
      const r = { headers: {}, code: 200, body: "" };
      r.setHeader = (k, v) => { r.headers[k] = v; };
      r.status = (c) => ((r.code = c), r);
      r.end = (b = "") => ((r.body = b), r);
      r.json = (o) => r.end(JSON.stringify(o));
      return r;
    };
    const ok = await proxy({ method: "GET", url: `/api/safe?path=v1/chains/8453/safes/${AGENT}` }, res(), async (url) => ({ status: 200, text: async () => `{"seen":"${url}"}` }));
    expect([ok.code, ok.headers["access-control-allow-origin"], JSON.parse(ok.body).seen]).to.deep.equal([200, "*", `https://safe-client.safe.global/v1/chains/8453/safes/${AGENT}`]);
    // The read count: off with no store configured; with one, a daily count by chain and kind, never an address.
    const hits = [];
    const store = { KV_REST_API_URL: "https://kv.example", KV_REST_API_TOKEN: "t" };
    const seen = async (url, init) => (hits.push([url, init?.method || "GET"]), { status: 200, text: async () => "{}" });
    await proxy({ method: "GET", url: `/api/safe?path=v1/chains/8453/safes/${AGENT}/transactions/queued` }, res(), seen, {});
    expect(hits.map((h) => h[0])).to.deep.equal([`https://safe-client.safe.global/v1/chains/8453/safes/${AGENT}/transactions/queued`]);
    hits.length = 0;
    await proxy({ method: "GET", url: `/api/safe?path=v1/chains/8453/safes/${AGENT}/transactions/queued` }, res(), seen, store);
    const day = new Date().toISOString().slice(0, 10);
    expect(hits).to.deep.include([`https://kv.example/incr/${encodeURIComponent(`relay:${day}:8453:queued`)}`, "POST"]);
    expect(JSON.stringify(hits.filter((h) => h[0].startsWith("https://kv.")))).to.not.match(/0x[0-9a-f]{6}/i);
    expect([`/v1/chains/1/safes/${AGENT}`, `/v1/chains/1/safes/${AGENT}/transactions/history`, "/v1/chains/1/transactions/multisig_0xab"].map((u) => proxy.kindOf(u))).to.deep.equal(["1 safe", "1 history", "1 tx"]);
    // A store that hangs never holds up the read.
    const t0 = Date.now();
    const slow = await proxy({ method: "GET", url: `/api/safe?path=v1/chains/1/safes/${AGENT}` }, res(), async (url) => (url.startsWith("https://kv.") ? new Promise(() => {}) : { status: 200, text: async () => "{}" }), store);
    expect([slow.code, Date.now() - t0 < 2000]).to.deep.equal([200, true]);
    expect((await proxy({ method: "POST", url: "/api/safe" }, res())).code).to.equal(405);
    expect((await proxy({ method: "GET", url: "/api/safe?path=v1/about" }, res())).code).to.equal(404);
    expect((await proxy({ method: "GET", url: `/api/safe?path=v1/chains/1/safes/${AGENT}` }, res(), async () => { throw new Error("down"); })).code).to.equal(502);
    const page = fs.readFileSync(path.join(__dirname, "..", "web", "safe", "index.html"), "utf8");
    expect(page).to.contain("/api/safe").and.contain("gatewayFetch");
    // It also opens as a custom Safe App: Safe{Wallet} reads the manifest, the page asks which Safe it's in.
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "web", "safe", "manifest.json"), "utf8"));
    expect(manifest).to.include.keys("name", "description", "iconPath");
    expect(fs.existsSync(path.join(__dirname, "..", "web", "safe", manifest.iconPath))).to.equal(true);
    expect(page).to.contain('method: "getSafeInfo"').and.contain("in-safe");
    const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "web", "vercel.json"), "utf8"));
    expect(JSON.stringify(vercel.headers)).to.contain("manifest.json").and.contain("Access-Control-Allow-Origin");
  });
});
