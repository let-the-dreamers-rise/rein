// rein guard: limits learned from a wallet's own history, held against each
// payment before the agent signs it. Everything here runs on the synthetic
// sample wallet (scan/sample.js) with guards saved under a temporary REIN_HOME.
const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const guard = require("../scan/guard");
const { toTrail } = require("../scan/blockscout");
const { sampleHistory, AGENT, PAYEES, USDC } = require("../scan/sample");
const { openClient } = require("../mcp/lib/config");
const rein = require("..");

const ERC20 = new ethers.Interface(["function transfer(address,uint256)"]);
const usdc = (n) => ethers.parseUnits(String(n), 6).toString();
const NOW = Math.floor(Date.UTC(2026, 8, 29, 12) / 1000);

describe("rein guard", function () {
  this.timeout(60000);
  let env;
  let learned;

  beforeEach(() => {
    env = { REIN_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "rein-guard-")) };
  });

  before(() => {
    learned = guard.learn(sampleHistory());
  });

  const saved = () => {
    const g = JSON.parse(JSON.stringify(learned.guard));
    return guard.saveGuard(g, guard.guardPath(g.wallet, env));
  };

  describe("learning", () => {
    it("learns payees and an hourly ceiling, and replays the last 30 days against limits from before them", () => {
      const { guard: g, replay } = learned;
      expect(g.wallet).to.equal(AGENT);
      expect(g.policy.payees).to.include(PAYEES.inference.address).and.not.include(PAYEES.stranger.address);
      expect(g.policy.tokens[USDC.address].maxPerWindow).to.be.greaterThan(0);
      expect(g.sentences.join("\n")).to.contain("USDC: at most");
      expect(replay.byTime).to.equal(true);
      expect(replay.total).to.be.greaterThan(0);
      expect(replay.allowed).to.be.within(replay.total - 5, replay.total);
      expect(replay.blocked.map((b) => b.reason)).to.include("PAYEE_NOT_ALLOWED");
    });

    it("reads a payment the wallet signed inside someone else's transaction (x402) as a payment", () => {
      const h = sampleHistory();
      const own = h.transactions.find((tx) => tx.from.hash.toLowerCase() === AGENT.toLowerCase());
      const t = h.tokenTransfers.find((x) => x.transaction_hash === own.hash && x.from.hash.toLowerCase() === AGENT.toLowerCase());
      const x402 = { ...t, transaction_hash: "0x" + "ab".repeat(32), timestamp: own.timestamp };
      const count = (hist, opts) => {
        const rows = toTrail(hist, opts).rows;
        return { paid: rows.filter((r) => !r.derived).length, side: rows.filter((r) => r.derived).length };
      };
      const before = { plain: count(h), paid: count(h, { payments: true }) };
      h.tokenTransfers.push(x402);
      // By default it is a side effect; as a guard reads it, a payment.
      expect(count(h).side).to.equal(before.plain.side + 1);
      expect(count(h, { payments: true }).paid).to.equal(before.paid.paid + 1);
    });
  });

  describe("check", () => {
    it("allows a usual payment, as an x402 requirement or as a transfer, and counts it against the hour", () => {
      saved();
      const a = rein.check({ payTo: PAYEES.inference.address, asset: USDC.address, amount: usdc(100) }, { env, now: NOW });
      expect(a).to.include({ allow: true, reason: "OK", token: "USDC", amount: 100 });
      const limit = learned.guard.policy.tokens[USDC.address].maxPerWindow;
      expect(a.leftThisHour).to.be.closeTo(limit - 100, 1e-6);
      const b = rein.check({ to: USDC.address, data: ERC20.encodeFunctionData("transfer", [PAYEES.data.address, usdc(50)]) }, { env, now: NOW + 60 });
      expect(b.allow).to.equal(true);
      expect(b.leftThisHour).to.be.closeTo(limit - 150, 1e-6);
      expect(guard.loadGuard(AGENT, env).guard.ledger.filter((r) => r.ts >= NOW)).to.have.length(2);
    });

    it("blocks a payee the wallet does not pay, with a reason in plain words", () => {
      saved();
      const v = rein.check({ payTo: PAYEES.stranger.address, asset: USDC.address, maxAmountRequired: usdc(5) }, { env, now: NOW });
      expect(v).to.include({ allow: false, reason: "PAYEE_NOT_ALLOWED" });
      expect(v.explanation).to.contain("never paid that address");
      const g = guard.loadGuard(AGENT, env).guard;
      expect(g.ledger.filter((r) => r.ts >= NOW)).to.have.length(0);
      expect(g.blocked).to.have.length(1);
    });

    it("blocks the payment that would cross the hourly ceiling, and allows it again an hour later", () => {
      saved();
      const limit = learned.guard.policy.tokens[USDC.address].maxPerWindow;
      const half = Math.floor(limit * 0.6);
      const pay = (now) => rein.check({ payTo: PAYEES.inference.address, asset: USDC.address, amount: usdc(half) }, { env, now });
      expect(pay(NOW).allow).to.equal(true);
      expect(pay(NOW + 60)).to.include({ allow: false, reason: "TOKEN_PER_WINDOW" });
      expect(pay(NOW + 3700).allow).to.equal(true);
    });

    it("posts a blocked payment to the webhook without waiting for it", async () => {
      const file = saved();
      const g = JSON.parse(fs.readFileSync(file, "utf8"));
      g.webhook = "https://hooks.example/rein";
      fs.writeFileSync(file, JSON.stringify(g));
      const posts = [];
      rein.check({ payTo: PAYEES.stranger.address, asset: USDC.address, amount: usdc(5000) }, { env, now: NOW, fetch: async (url, init) => posts.push([url, JSON.parse(init.body)]) });
      await new Promise((r) => setTimeout(r, 10));
      expect(posts).to.have.length(1);
      expect(posts[0][0]).to.equal("https://hooks.example/rein");
      expect(posts[0][1].text).to.contain("Rein blocked a payment").and.contain("5,000 USDC");
    });

    it("says what to do when nothing is guarded yet", () => {
      expect(() => rein.check({ payTo: PAYEES.inference.address, asset: USDC.address, amount: "1" }, { env })).to.throw(/npx rein-wallet guard/);
    });
  });

  describe("keeping the limits current", () => {
    it("tightens on its own and holds anything wider for the owner", () => {
      const old = JSON.parse(JSON.stringify(learned.guard));
      const fresh = JSON.parse(JSON.stringify(learned.guard));
      const tp = fresh.policy.tokens[USDC.address];
      tp.maxPerWindow = old.policy.tokens[USDC.address].maxPerWindow / 2;
      fresh.policy.payees = [...fresh.policy.payees.filter((p) => p !== PAYEES.contractor.address), PAYEES.stranger.address];
      fresh.policy.agent.maxCallsPerWindow = old.policy.agent.maxCallsPerWindow + 10;

      const { policy, applied, proposed } = guard.evolve(old, fresh);
      expect(policy.tokens[USDC.address].maxPerWindow).to.equal(tp.maxPerWindow);
      expect(policy.payees).to.not.include(PAYEES.contractor.address).and.not.include(PAYEES.stranger.address);
      expect(policy.agent.maxCallsPerWindow).to.equal(old.policy.agent.maxCallsPerWindow);
      expect(applied.join("\n")).to.contain("USDC an hour").and.contain("no longer uses");
      expect(proposed.map((x) => x.what).join("\n")).to.contain(`add payee ${PAYEES.stranger.address}`).and.contain("calls an hour");

      const g = { ...old, policy, pending: proposed };
      expect(guard.approve(g)).to.equal(2);
      expect(g.policy.payees).to.include(PAYEES.stranger.address);
      expect(g.policy.agent.maxCallsPerWindow).to.equal(old.policy.agent.maxCallsPerWindow + 10);
      expect(g.pending).to.deep.equal([]);
    });
  });

  describe("the ways in", () => {
    it("rein guard --sample learns, replays, saves and says the guard is on", async () => {
      const lines = [];
      expect(await guard.main(["--sample"], { log: (l) => lines.push(l), env })).to.equal(0);
      const out = lines.join("\n");
      expect(out).to.contain("Its last 30 days").and.contain("would have allowed").and.contain("Guard is on");
      expect(out).to.contain('require("rein-wallet").check(tx)');
      expect(fs.existsSync(guard.guardPath(AGENT, env))).to.equal(true);

      lines.length = 0;
      await guard.main(["--sample"], { log: (l) => lines.push(l), env });
      expect(lines.join("\n")).to.contain("Nothing needed tightening");
    });

    it("answers the MCP tools from the saved limits in guard mode", async () => {
      saved();
      const { client, info } = await openClient({ argv: ["node", "rein-mcp", "--guard", AGENT], env });
      expect(info.wallet).to.equal(AGENT);
      expect(info.limits.join("\n")).to.contain("USDC");
      const ok = client.check({ payee: PAYEES.inference.address, amount: "12.5", token: "usdc", because: "inference" });
      expect(ok).to.include({ allow: true, amount: 12.5 });
      expect(client.check({ payee: PAYEES.stranger.address, amount: "5000", token: "USDC", because: "x" })).to.include({ allow: false, reason: "PAYEE_NOT_ALLOWED" });
      expect(client.pay({}).message).to.contain("Rein checks, your wallet signs");
      expect(client.budget().tokens.USDC.leftThisHour).to.be.lessThan(learned.guard.policy.tokens[USDC.address].maxPerWindow);
    });
  });
});
