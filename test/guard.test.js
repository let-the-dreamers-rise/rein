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
const APPROVE = new ethers.Interface(["function approve(address,uint256)"]);
const { readRouterCall, strangers, ROUTER: ROUTER_ABI, ADDRESS_THIS } = require("../scan/moves");
const { ROUTER: ROUTER_ADDRESS, WETH: WETH_TOKEN } = require("../scan/sample");
const ROUTER = typeof ROUTER_ADDRESS === "string" ? ROUTER_ADDRESS : ROUTER_ADDRESS.address;
const WETH = WETH_TOKEN.address;
const DAY = 86400;
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

    it("posts a held payment to the webhook without waiting for it", async () => {
      const file = saved();
      const g = JSON.parse(fs.readFileSync(file, "utf8"));
      g.webhook = "https://hooks.example/rein";
      fs.writeFileSync(file, JSON.stringify(g));
      const posts = [];
      rein.check({ payTo: PAYEES.stranger.address, asset: USDC.address, amount: usdc(5000) }, { env, now: NOW, fetch: async (url, init) => posts.push([url, JSON.parse(init.body)]) });
      await new Promise((r) => setTimeout(r, 10));
      expect(posts).to.have.length(1);
      expect(posts[0][0]).to.equal("https://hooks.example/rein");
      expect(posts[0][1].text).to.contain("Rein is holding a payment").and.contain("5,000 USDC").and.contain("--allow");
    });

    it("blocks, and says what to do, when nothing is guarded yet or the file can't be read", () => {
      const pay = () => rein.check({ payTo: PAYEES.inference.address, asset: USDC.address, amount: "1" }, { env, now: NOW });
      expect(pay()).to.include({ allow: false, reason: "GUARD_ERROR" });
      expect(pay().explanation).to.match(/npx rein-wallet guard/);
      fs.writeFileSync(saved(), "{ half a fi");
      expect(pay()).to.include({ allow: false, reason: "GUARD_ERROR" });
      const old = JSON.parse(JSON.stringify(learned.guard));
      old.version = 1;
      fs.writeFileSync(guard.guardPath(AGENT, env), JSON.stringify(old));
      expect(pay().explanation).to.contain("older rein-wallet");
    });

    it("blocks a transfer to an address the agent only gives allowances to, like its swap router", () => {
      saved();
      expect(learned.guard.policy.spenders).to.include(ROUTER);
      expect(learned.guard.policy.transferPayees).to.not.include(ROUTER);
      const v = rein.check({ to: USDC.address, data: ERC20.encodeFunctionData("transfer", [ROUTER, usdc(750)]) }, { env, now: NOW });
      expect(v).to.include({ allow: false, reason: "NOT_A_PAYEE" });
      expect(rein.check({ to: USDC.address, data: APPROVE.encodeFunctionData("approve", [ROUTER, usdc(100)]) }, { env, now: NOW + 1 }).allow).to.equal(true);
    });

    it("blocks a swap that sends what it buys to anyone but the wallet, and counts the ones it allows", () => {
      saved();
      const swap = (to, n) => ({ to: ROUTER, data: ROUTER_ABI.encodeFunctionData("exactInputSingle", [[USDC.address, WETH, 500, to, usdc(n), 0, 0]]) });
      expect(rein.check(swap(PAYEES.stranger.address, 200), { env, now: NOW })).to.include({ allow: false, reason: "RECIPIENT_NOT_SELF", payee: PAYEES.stranger.address });
      const limit = learned.guard.policy.tokens[USDC.address].maxPerWindow;
      const ok = rein.check(swap(AGENT, 200), { env, now: NOW + 1 });
      expect(ok).to.include({ allow: true, amount: 200, token: "USDC" });
      expect(ok.leftThisHour).to.be.closeTo(limit - 200, 1e-6);
      expect(rein.check(swap(AGENT, Math.ceil(limit)), { env, now: NOW + 2 })).to.include({ allow: false, reason: "OUTFLOW_EXCEEDED" });
    });

    it("reads multicall swaps: output left in the router must be swept back to the wallet", () => {
      const keep = (n) => ROUTER_ABI.encodeFunctionData("exactInputSingle", [[USDC.address, WETH, 500, ADDRESS_THIS, usdc(n), 0, 0]]);
      const unwrap = (to) => ROUTER_ABI.encodeFunctionData("unwrapWETH9(uint256,address)", [0, to]);
      const call = (inner) => readRouterCall(ROUTER_ABI.encodeFunctionData("multicall(uint256,bytes[])", [9999999999, inner]));
      expect(strangers(call([keep(10), unwrap(AGENT)]), AGENT, ROUTER)).to.equal(null);
      expect(strangers(call([keep(10)]), AGENT, ROUTER)).to.deep.equal([ROUTER]);
      expect(strangers(call([keep(10), unwrap(PAYEES.stranger.address)]), AGENT, ROUTER)).to.include(PAYEES.stranger.address);
      expect(call([keep(10), unwrap(AGENT)]).spends).to.deep.equal([{ token: USDC.address, raw: BigInt(usdc(10)) }]);
    });

    it("holds signatures to the same payees and limits: x402 authorizations, Permit and Permit2", () => {
      saved();
      const typed = (primaryType, message, verifyingContract = USDC.address) => ({ domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract }, types: {}, primaryType, message });
      const auth = (to, n) => typed("TransferWithAuthorization", { from: AGENT, to, value: usdc(n), validAfter: 0, validBefore: 2e9, nonce: ethers.ZeroHash });
      expect(rein.check(auth(PAYEES.data.address, 5), { env, now: NOW })).to.include({ allow: true, amount: 5 });
      expect(rein.check(auth(PAYEES.stranger.address, 5), { env, now: NOW + 1 })).to.include({ allow: false, reason: "PAYEE_NOT_ALLOWED" });
      const MAX = (2n ** 256n - 1n).toString();
      expect(rein.check(typed("Permit", { owner: AGENT, spender: PAYEES.stranger.address, value: MAX, nonce: 0, deadline: 2e9 }), { env, now: NOW + 2 })).to.include({ allow: false, reason: "SPENDER_NOT_ALLOWED" });
      expect(rein.check(typed("Permit", { owner: AGENT, spender: ROUTER, value: MAX, nonce: 0, deadline: 2e9 }), { env, now: NOW + 3 })).to.include({ allow: false, reason: "APPROVAL_TOO_LARGE" });
      const permit2 = typed("PermitSingle", { details: { token: USDC.address, amount: usdc(100), expiration: 0, nonce: 0 }, spender: ROUTER, sigDeadline: 2e9 }, "0x000000000022D473030F116dDEE9F6B43aC78BA3");
      expect(rein.check(permit2, { env, now: NOW + 4 }).allow).to.equal(true);
      expect(rein.check(typed("Order", { maker: AGENT }), { env, now: NOW + 5 })).to.include({ allow: false, reason: "SIGNATURE_NOT_UNDERSTOOD" });
    });

    it("holds the day as well as the hour, so staying under the hourly ceiling can't add up to 24 of them", () => {
      saved();
      const { maxPerWindow, maxPerDay } = learned.guard.policy.tokens[USDC.address];
      expect(maxPerDay).to.be.lessThan(maxPerWindow * 24);
      const n = Math.floor(maxPerWindow * 0.9);
      let allowed = 0;
      for (let h = 0; h < 24; h++) if (rein.check({ payTo: PAYEES.data.address, asset: USDC.address, amount: usdc(n) }, { env, now: NOW + h * 3601 }).allow) allowed += n;
      expect(allowed).to.be.at.most(maxPerDay);
      const last = rein.check({ payTo: PAYEES.data.address, asset: USDC.address, amount: usdc(1) }, { env, now: NOW + 23 * 3601 + 60 });
      expect(last.reason === "TOKEN_PER_DAY" || last.leftToday >= 0).to.equal(true);
      expect(rein.check({ payTo: PAYEES.data.address, asset: USDC.address, amount: usdc(n) }, { env, now: NOW + 3 * DAY }).allow).to.equal(true);
    });

    it("keeps the hour right when several processes check at once", async () => {
      saved();
      const { spawn } = require("child_process");
      const script = `const r=require(${JSON.stringify(path.join(__dirname, ".."))});const v=r.check({payTo:${JSON.stringify(PAYEES.data.address)},asset:${JSON.stringify(USDC.address)},amount:${JSON.stringify(usdc(200))}},{now:${NOW}+Number(process.argv[1])});process.stdout.write(v.allow?"A":v.reason)`;
      const runs = await Promise.all(
        Array.from({ length: 8 }, (_, i) => new Promise((done) => {
          const p = spawn(process.execPath, ["-e", script, String(i)], { env: { ...process.env, ...env } });
          let out = "";
          p.stdout.on("data", (d) => (out += d));
          p.on("close", () => done(out));
        }))
      );
      expect(runs.filter((x) => x === "GUARD_ERROR")).to.deep.equal([]);
      const limit = learned.guard.policy.tokens[USDC.address].maxPerWindow;
      expect(runs.filter((x) => x === "A").length).to.equal(Math.floor(limit / 200));
    });
  });

  describe("holding a payment for a person", () => {
    const stranger = (n) => ({ payTo: PAYEES.stranger.address, asset: USDC.address, amount: usdc(n) });

    it("holds a payment outside the limits; an approval lets that one payment through once", async () => {
      saved();
      const v = rein.check(stranger(300), { env, now: NOW });
      expect(v).to.include({ allow: false, reason: "PAYEE_NOT_ALLOWED" });
      expect(v.held).to.match(/^[0-9a-f]{8}$/);
      expect(v.next).to.contain(`--allow ${v.held}`);
      expect(rein.check(stranger(300), { env, now: NOW + 5 }).held).to.equal(v.held); // a retry is the same hold
      expect(rein.check(stranger(301), { env, now: NOW + 6 }).held).to.not.equal(v.held); // a different payment isn't
      expect(await guard.main([AGENT, "--allow", v.held], { log: () => {}, env, input: "nope", now: NOW + 10 })).to.equal(1);
      expect(await guard.main([AGENT, "--allow", v.held], { log: () => {}, env, input: AGENT.slice(-4), now: NOW + 10 })).to.equal(0);
      expect(rein.check(stranger(300), { env, now: NOW + 20 })).to.include({ allow: true, reason: "APPROVED" });
      expect(rein.check(stranger(300), { env, now: NOW + 30 }).allow).to.equal(false); // once
    });

    it("refuses without a keyboard, and lists what is held", async () => {
      saved();
      const v = rein.check(stranger(300), { env, now: Math.floor(Date.now() / 1000) });
      const lines = [];
      expect(await guard.main([AGENT, "--deny", v.held], { log: (l) => lines.push(l), env })).to.equal(0);
      await guard.main([AGENT, "--holds"], { log: (l) => lines.push(l), env });
      expect(lines.join("\n")).to.contain("Refused").and.contain(`${v.held}  denied`);
    });

    it("lets a small first payment to a new address through when the owner sets a cap", () => {
      const file = saved();
      const g = JSON.parse(fs.readFileSync(file, "utf8"));
      g.newPayeeCap = 20;
      fs.writeFileSync(file, JSON.stringify(g));
      expect(rein.check(stranger(5), { env, now: NOW }).allow).to.equal(true);
      expect(rein.check(stranger(50), { env, now: NOW + 1 }).allow).to.equal(false);
    });

    it("posts each new hold to Slack once, with a signed link to approve or refuse it", async () => {
      saved();
      const { announce, handler, sign } = require("../scan/approvals");
      const now = Math.floor(Date.now() / 1000);
      const v = rein.check(stranger(300), { env, now });
      const posts = [];
      const fetch = async (u, init) => posts.push(JSON.parse(init.body).text);
      const secret = "a-secret-the-agent-cannot-read";
      expect(await announce({ env, secret, publicUrl: "https://rein.example", webhook: "https://hooks.example/x", fetch, now })).to.equal(1);
      expect(await announce({ env, secret, publicUrl: "https://rein.example", webhook: "https://hooks.example/x", fetch, now })).to.equal(0);
      const k = sign(secret, AGENT, v.held);
      expect(posts[0]).to.contain(`https://rein.example/h/${AGENT}/${v.held}?k=${k}`).and.contain("300 USDC");

      const http = require("http");
      const server = http.createServer(handler({ env, secret }));
      await new Promise((r) => server.listen(0, r));
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        expect((await globalThis.fetch(`${base}/h/${AGENT}/${v.held}?k=${"0".repeat(32)}`)).status).to.equal(403);
        const view = await globalThis.fetch(`${base}/h/${AGENT}/${v.held}?k=${k}`);
        expect(await view.text()).to.contain("Approve this payment");
        expect(guard.loadGuard(AGENT, env).guard.holds.find((h) => h.id === v.held).status).to.equal("waiting"); // looking decides nothing
        const done = await globalThis.fetch(`${base}/h/${AGENT}/${v.held}/approve?k=${k}`, { method: "POST" });
        expect(await done.text()).to.contain("Approved");
      } finally {
        server.close();
      }
      expect(rein.check(stranger(300), { env, now: now + 1 })).to.include({ allow: true, reason: "APPROVED" });
    });
  });

  describe("keeping the limits current", () => {
    it("tightens on its own and holds anything wider for the owner", () => {
      const old = JSON.parse(JSON.stringify(learned.guard));
      const fresh = JSON.parse(JSON.stringify(learned.guard));
      const tp = fresh.policy.tokens[USDC.address];
      tp.maxPerWindow = old.policy.tokens[USDC.address].maxPerWindow / 2;
      fresh.policy.transferPayees = [...fresh.policy.transferPayees.filter((p) => p !== PAYEES.contractor.address), PAYEES.stranger.address];
      fresh.policy.agent.maxCallsPerWindow = old.policy.agent.maxCallsPerWindow + 10;

      const { policy, applied, proposed } = guard.evolve(old, fresh);
      expect(policy.tokens[USDC.address].maxPerWindow).to.equal(tp.maxPerWindow);
      expect(policy.payees).to.not.include(PAYEES.contractor.address).and.not.include(PAYEES.stranger.address);
      expect(policy.agent.maxCallsPerWindow).to.equal(old.policy.agent.maxCallsPerWindow);
      expect(applied.join("\n")).to.contain("USDC an hour").and.contain("no longer uses");
      expect(proposed.map((x) => x.what).join("\n")).to.contain(`add payee ${PAYEES.stranger.address}`).and.contain("calls an hour");

      const g = { ...old, policy, pending: proposed };
      expect(guard.approve(g)).to.equal(2);
      expect(g.policy.transferPayees).to.include(PAYEES.stranger.address);
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

    it("widens only when a person types the wallet's last four characters at a terminal", async () => {
      const file = saved();
      const g = JSON.parse(fs.readFileSync(file, "utf8"));
      g.pending = [{ what: `add payee ${PAYEES.stranger.address}`, path: ["transferPayees"], add: PAYEES.stranger.address }];
      fs.writeFileSync(file, JSON.stringify(g));
      const lines = [];
      const log = (l) => lines.push(l);
      if (!process.stdin.isTTY) expect(await guard.main([AGENT, "--approve"], { log, env })).to.equal(1); // an agent's shell
      expect(await guard.main([AGENT, "--approve"], { log, env, input: "0000" })).to.equal(1);
      expect(guard.loadGuard(AGENT, env).guard.policy.transferPayees).to.not.include(PAYEES.stranger.address);
      expect(await guard.main([AGENT, "--approve"], { log, env, input: AGENT.slice(-4) })).to.equal(0);
      expect(guard.loadGuard(AGENT, env).guard.policy.transferPayees).to.include(PAYEES.stranger.address);
      expect(lines.join("\n")).to.contain("needs a person at a terminal").and.contain(`add payee ${PAYEES.stranger.address}`);
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
