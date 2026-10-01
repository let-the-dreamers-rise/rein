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
    expect(lines.join("\n")).to.contain("made-up sample Safe").and.contain("#41 (1 of 2 signed): pay 15 USDC to Inference API. Looks normal.").and.contain("#42 (1 of 2 signed): pay 48,000 USDC");
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
  });
});
