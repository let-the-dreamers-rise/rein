// The one-minute checkup: rein checkup / rein 0x…, the web page, and
// rein_check_wallet over MCP all run scan/checkup.js.
const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { ethers } = require("ethers");
const cu = require("../scan/checkup");
const guard = require("../scan/guard");
const fleet = require("../scan/fleet");
const { sampleHistory, poisonedSampleHistory, sampleFetch, historiesFetch, AGENT, PAYEES } = require("../scan/sample");
const { callTool } = require("../mcp/rein-mcp");

describe("rein checkup", function () {
  this.timeout(60000);
  let c;
  beforeEach(() => {
    c = cu.checkup(poisonedSampleHistory());
  });

  it("leads with the payment Rein would most want to have held, then the attack, then the habits", () => {
    expect(c.headline).to.match(/^Rein would have held this payment: on 20 Aug 2026 this wallet sent 12,500 USDC \(\$13k\) to 0x7946…2773, an address it had never paid before\./);
    expect(c.headline).to.contain("Someone is trying to trick this wallet: 24 fake transfers");
    expect(c.attack.fakeTransfers).to.equal(24);
    // The poisoners copy the one-off payee too, not only the usual ones.
    expect(c.attack.lookalikes.map((x) => x.real)).to.include(c.biggest.payee).and.include(PAYEES.inference.address);
    expect(c.habits.join(" ")).to.contain("Pays 4 addresses").and.contain("Makes at most 5 transactions an hour");
    expect(c.recent.held.map((h) => h.what)).to.include("pay 12,500 USDC to 0x7946…2773");
    expect(JSON.stringify(cu.summary(c))).to.not.contain("ledger");
  });

  it("doesn't let one large payment to a stranger set the limits for everything else", () => {
    const usdc = Object.values(c.guard.policy.tokens)[0];
    expect(usdc.maxPerWindow).to.be.below(1000);
    expect(usdc.maxPerDay).to.be.below(2000);
  });

  it("says nothing alarming about a wallet that isn't under attack", () => {
    const calm = cu.checkup(sampleHistory());
    expect(calm.attack).to.equal(null);
    expect(calm.headline).to.match(/^Rein learned its habits and would have held 2 of its last 100 transactions/);
  });

  it("answers a payment in plain words, from the wallet's own habits", () => {
    expect(cu.ask(c, "pay inference api 12.5").verdict).to.include({ allow: true, reason: "OK" });
    expect(cu.ask(c, "send 2k usdc to data vendor").verdict.reason).to.equal("TOKEN_PER_WINDOW");
    const fake = c.attack.lookalikes.find((x) => x.real === c.biggest.payee).fake;
    const v = cu.ask(c, `Send 40 USDC to ${fake}`);
    expect(v.verdict.reason).to.equal("LOOKALIKE_PAYEE");
    expect(v.answer).to.match(/^Held for a person: this address starts and ends like one the agent has paid/);
    expect(cu.ask(c, "hello").understood).to.equal(false);
    expect(cu.ask(c, "send to data vendor").answer).to.contain("say how much");
  });

  it("lets a person approve a held payment once, or refuse it for good", () => {
    const q = `send 500 USDC to ${PAYEES.stranger.address}`;
    const held = cu.ask(c, q);
    expect(held.held).to.be.a("string");
    cu.approve(c, held.held);
    expect(cu.ask(c, q).verdict.reason).to.equal("APPROVED");
    expect(cu.ask(c, q).held).to.be.a("string"); // once only
    cu.refuse(c, cu.ask(c, q).held);
    expect(cu.ask(c, q).answer).to.match(/^Refused: a person already said no/);
  });

  it("offers one-click questions that show each kind of answer", () => {
    const answers = cu.examples(c).map((e) => cu.ask(c, e.text).verdict.reason);
    expect(answers).to.deep.equal(["OK", "TOKEN_PER_WINDOW", "LOOKALIKE_PAYEE", "PAYEE_NOT_ALLOWED"]);
  });

  it("runs in the browser bundle exactly as on the command line", () => {
    const code = fs.readFileSync(path.join(__dirname, "..", "web", "scan", "rein-scan.js"), "utf8");
    const sandbox = { window: { crypto: globalThis.crypto }, crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, console };
    vm.runInNewContext(`${code};window.Rein = Rein;`, sandbox);
    const R = sandbox.window.Rein;
    const b = R.checkup.checkup(R.poisonedSampleHistory());
    expect(b.headline).to.equal(c.headline);
    const held = R.checkup.ask(b, `send 500 USDC to ${PAYEES.stranger.address}`);
    expect(held.held).to.match(/^[0-9a-f]{8}$/);
  });

  it("is `rein checkup` and `rein 0x…` in a terminal, with answers to a few payments", async () => {
    const lines = [];
    expect(await cu.main([AGENT], { log: (l) => lines.push(l), fetch: sampleFetch(), input: null })).to.equal(0);
    const out = lines.join("\n");
    expect(out).to.contain("Rein learned its habits").and.contain("Asked about a few payments, Rein says:").and.contain("Switch it on:");
    expect(out).to.contain(`npx rein-wallet guard ${AGENT}`);
    lines.length = 0;
    await cu.main(["--sample", "--json", "--ask", "send 40 usdc to data vendor"], { log: (l) => lines.push(l), input: null });
    const j = JSON.parse(lines.join("\n"));
    expect(j.answers[0]).to.include({ allow: true, reason: "OK" });
    expect(j).to.not.have.property("guard");
    expect(() => cu.parse(["--nope"])).to.throw("unknown flag");
  });

  it("answers rein_check_wallet over MCP", async () => {
    const text = await callTool("rein_check_wallet", { address: "sample", payments: ["send 40 USDC to Data vendor"] });
    expect(text).to.contain("Rein would have held this payment").and.contain("> send 40 USDC to Data vendor\nGoes through.");
  });
});

describe("what the laptop test of 1 Oct found", function () {
  this.timeout(60000);

  it("guard says it isn't ready, rather than on, when its limits would have stopped most of what the agent did", async () => {
    const h = sampleHistory();
    const last = Math.max(...h.transactions.map((t) => Date.parse(t.timestamp)));
    const iface = new ethers.Interface(["function transfer(address,uint256)"]);
    let i = 0;
    for (const t of h.transactions) {
      if (Date.parse(t.timestamp) > last - 30 * 86400 * 1000 && (t.raw_input || "").startsWith("0xa9059cbb")) {
        t.raw_input = iface.encodeFunctionData("transfer", [ethers.getAddress(ethers.dataSlice(ethers.id(`new payee ${i++}`), 12)), 5_000_000n]);
      }
    }
    const env = { REIN_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "rein-ready-")) };
    const lines = [];
    await guard.main([AGENT], { log: (l) => lines.push(l), env, fetch: historiesFetch([h]) });
    const out = lines.join("\n");
    expect(out).to.contain("Not ready to switch on").and.not.contain("Guard is on");
  });

  it("fleet --olas falls back to a public RPC when the explorer turns it away", async () => {
    const iface = new ethers.Interface([
      "function totalSupply() view returns (uint256)",
      "function getService(uint256 serviceId) view returns ((uint96 securityDeposit, address multisig, bytes32 configHash, uint32 threshold, uint32 maxNumAgentInstances, uint32 numAgentInstances, uint8 state, uint32[] agentIds))",
    ]);
    const safe = ethers.getAddress("0x" + "5".repeat(40));
    const urls = [];
    const fetch = async (url, init) => {
      urls.push(url);
      if (url.includes("blockscout")) return { ok: false, status: 429, json: async () => ({ message: "Too Many Requests" }) };
      const tx = iface.parseTransaction({ data: JSON.parse(init.body).params[0].data });
      const result = tx.name === "totalSupply" ? iface.encodeFunctionResult("totalSupply", [1]) : iface.encodeFunctionResult("getService", [[0, safe, ethers.ZeroHash, 1, 1, 1, 4, [1]]]);
      return { ok: true, status: 200, json: async () => ({ result }) };
    };
    expect(await fleet.olasWallets(1, { fetch })).to.deep.equal([safe]);
    expect(urls).to.deep.equal(["https://base.blockscout.com/api/eth-rpc", "https://mainnet.base.org", "https://mainnet.base.org"]);
    const dead = async () => ({ ok: false, status: 429, json: async () => ({}) });
    let err;
    await fleet.olasWallets(1, { fetch: dead }).catch((e) => (err = e));
    expect(err.message).to.contain("--rpc");
  });
});
