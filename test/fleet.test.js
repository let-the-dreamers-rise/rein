// rein fleet: shadow mode across many agent wallets, on the sample wallet, a
// copy of it whose last day includes a drain to an address it never paid, a
// twin, and a wallet too new to learn from that is held to the others' limits.
const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const fleet = require("../scan/fleet");
const guard = require("../scan/guard");
const { cohortFrom, guardFromCohort } = require("../scan/cohort");
const { sampleHistory, sampleFetch, historiesFetch, AGENT, PAYEES, USDC } = require("../scan/sample");
const rein = require("../bin/rein");

const THIEF = "0x7777777777777777777777777777777777777777";

describe("rein fleet (shadow mode)", function () {
  this.timeout(60000);

  it("learns each wallet from before --since and lists what a second key would have held after it", async () => {
    const lines = [];
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "rein-fleet-"));
    expect(await fleet.main(["--sample", "--out", out], { log: (l) => lines.push(l) })).to.equal(0);
    const { results } = JSON.parse(fs.readFileSync(path.join(out, "fleet.json"), "utf8"));
    const [honest, drained] = results;
    expect(honest.address).to.equal(AGENT);
    expect(honest.status).to.equal("ok");
    expect(honest.held.map((h) => h.reason)).to.have.members(["NEW_ADDRESS", "APPROVAL_TOO_LARGE"]);
    const stolen = drained.held.filter((h) => h.payee === THIEF);
    expect(stolen).to.have.length(3);
    expect(stolen.map((h) => h.reason).sort()).to.deep.equal(["NEW_ADDRESS", "PAYEE_NOT_ALLOWED", "PAYEE_NOT_ALLOWED"]);
    // Held payments never left, so the honest payments after them still fit the day.
    expect(drained.held.filter((h) => h.reason === "TOKEN_PER_DAY")).to.deep.equal([]);
    const text = lines.join("\n");
    expect(text).to.contain("would have waited for a person in the last 30 days").and.contain("the first payment this agent ever made to that address");
    expect(text).to.contain("Nothing was held");
    expect(fs.readFileSync(path.join(out, "fleet.md"), "utf8")).to.contain(`## ${drained.address}`);
  });

  it("posts to Slack only when something would have been held, unless told to always post", async () => {
    const posts = [];
    const fetch = async (url, init) => (posts.push(JSON.parse(init.body).text), { ok: true });
    await fleet.main(["--sample", "--webhook", "https://hooks.example/x"], { log: () => {}, fetch });
    expect(posts).to.have.length(1);
    expect(posts[0]).to.contain("*Rein shadow mode:* 10 payments or approvals from 4 of 4 agent wallets");
    await fleet.main(["--sample", "--since", "1m", "--webhook", "https://hooks.example/x"], { log: () => {}, fetch });
    expect(posts).to.have.length(1);
    await fleet.main(["--sample", "--since", "1m", "--always", "--webhook", "https://hooks.example/x"], { log: () => {}, fetch });
    expect(posts[1]).to.contain("nothing from 4 agent wallets would have been held in the last 1 minute");
  });

  it("reads a list of wallets from a file, and says which are too new to learn from", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rein-fleet-")), "wallets.csv");
    fs.writeFileSync(file, `address,label\n${AGENT},sample\nnot an address\n`);
    const out = path.join(path.dirname(file), "out");
    await fleet.main([file, "--since", "2026-07-30", "--out", out], { log: () => {}, fetch: sampleFetch() });
    const { results } = JSON.parse(fs.readFileSync(path.join(out, "fleet.json"), "utf8"));
    expect(results).to.have.length(1);
    expect(results[0].held.length).to.be.greaterThan(0);
    const young = fleet.shadow(sampleHistory(), { since: Date.parse("2026-07-01T12:00:00Z") / 1000 });
    expect(young.status).to.equal("too new");
  });

  it("holds a wallet too new to learn from to the limits its siblings share, and saves them as cohort.json", async () => {
    const lines = [];
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "rein-fleet-"));
    await fleet.main(["--sample", "--out", out], { log: (l) => lines.push(l) });
    const { results } = JSON.parse(fs.readFileSync(path.join(out, "fleet.json"), "utf8"));
    const fresh = results[3];
    expect(fresh.status).to.equal("cohort");
    expect(fresh.checked).to.equal(4);
    // Three payments to an address its siblings all pay go through; one to an address none of them pays waits.
    expect(fresh.held.map((h) => [h.reason, h.payee, h.amount])).to.deep.equal([["NEW_ADDRESS", "0x8888888888888888888888888888888888888888", 500]]);
    expect(results.every((r) => !("guard" in r))).to.equal(true);
    expect(lines.join("\n")).to.contain("1 new wallet was held to the limits the others share");
    const cohort = JSON.parse(fs.readFileSync(path.join(out, "cohort.json"), "utf8"));
    expect(cohort.kind).to.equal("rein-cohort");
    expect(cohort.learnedFrom).to.equal(3);
    expect(cohort.policy.transferPayees).to.include(PAYEES.inference.address);
    // Without siblings to learn from, it is only "too new".
    const alone = fleet.shadowFleet([{ history: fleet.sampleFleet()[3], since: 0 }]);
    expect(alone.cohort).to.equal(null);
  });

  it("keeps only what most wallets share, and the median of their limits", () => {
    const g = (payees, perHour) => ({
      policy: {
        agent: { maxCallsPerWindow: perHour / 10, maxNativePerCall: 0, maxNativePerWindow: 0, requireIntent: true },
        targets: [USDC.address],
        selectors: { [USDC.address]: ["transfer"] },
        transferPayees: payees,
        spenders: [],
        tokens: { [USDC.address]: { maxPerWindow: perHour, maxApproval: 0, maxPerDay: perHour * 2 } },
      },
      tokens: { [USDC.address]: { symbol: "USDC", decimals: 6 } },
    });
    const [a, b, c, d] = ["0x" + "a".repeat(40), "0x" + "b".repeat(40), "0x" + "c".repeat(40), "0x" + "d".repeat(40)];
    expect(() => cohortFrom([g([a], 100), g([a], 100)])).to.throw("at least 3");
    const cohort = cohortFrom([g([a, b], 100), g([a, c], 300), g([a, b, d], 200)]);
    expect(cohort.policy.transferPayees).to.deep.equal([a, b]);
    expect(cohort.policy.payees).to.deep.equal([a, b]);
    expect(cohort.policy.tokens[USDC.address]).to.include({ maxPerWindow: 200, maxPerDay: 400 });
    expect(cohort.policy.agent.maxCallsPerWindow).to.equal(20);
    const started = guardFromCohort(cohort, "0x" + "e".repeat(40));
    expect(started).to.include({ version: 2, fromCohort: true });
    expect(started.sentences.join(" ")).to.contain("USDC: at most 200 an hour and 400 a day");
    expect(() => guardFromCohort({ kind: "other" }, a)).to.throw("not a Rein cohort");
  });

  it("guards a wallet the explorer has never seen from cohort.json, and says plainly when the file is missing", async () => {
    const env = { REIN_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "rein-cohort-")) };
    const out = path.join(env.REIN_HOME, "fleet");
    await fleet.main(["--sample", "--out", out], { log: () => {} });
    const brandNew = "0x" + "b".repeat(40);
    const nobody = async () => ({ ok: false, status: 404, json: async () => ({}) });
    await guard.main([brandNew, "--cohort", path.join(out, "cohort.json")], { fetch: nobody, env, log: () => {} });
    expect(guard.loadGuard(brandNew, env).guard).to.include({ fromCohort: true });
    let err;
    await guard.main([brandNew, "--cohort", "nope.json"], { fetch: nobody, env, log: () => {} }).catch((e) => (err = e));
    expect(err.message).to.contain("no cohort file at nope.json");
  });

  it("starts a new wallet's guard from cohort.json, and lets its own limits take over once it has history", async () => {
    const env = { REIN_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "rein-cohort-")) };
    const out = path.join(env.REIN_HOME, "fleet");
    await fleet.main(["--sample", "--out", out], { log: () => {} });
    const wallets = fleet.sampleFleet();
    const fresh = wallets[3];
    const lines = [];
    await guard.main([fresh.address, "--cohort", path.join(out, "cohort.json")], { fetch: historiesFetch(wallets), env, log: (l) => lines.push(l) });
    expect(lines.join("\n")).to.contain("It has 4 calls of its own, too few to learn from (it needs 20)").and.contain("shared by 3 sibling wallets");
    const usdc = (payTo) => guard.check({ payTo, asset: USDC.address, amount: "5000000" }, { env, wallet: fresh.address });
    expect(usdc(PAYEES.inference.address)).to.include({ allow: true });
    expect(usdc("0x8888888888888888888888888888888888888888")).to.include({ allow: false, reason: "PAYEE_NOT_ALLOWED" });
    // A later run without --cohort keeps it on the shared limits.
    lines.length = 0;
    await guard.main([fresh.address], { fetch: historiesFetch(wallets), env, log: (l) => lines.push(l) });
    expect(lines.join("\n")).to.contain("held to the limits 3 sibling wallets share");
    expect(guard.loadGuard(fresh.address, env).guard.fromCohort).to.equal(true);

    // A wallet that started on the cohort and now has history of its own:
    // its own limits take over, tightening at once, widening only with approval.
    const cohort = JSON.parse(fs.readFileSync(path.join(out, "cohort.json"), "utf8"));
    const started = guardFromCohort(cohort, AGENT);
    started.policy.transferPayees = started.policy.transferPayees.slice(0, 1);
    guard.saveGuard(started, guard.guardPath(AGENT, env));
    lines.length = 0;
    await guard.main([AGENT], { fetch: sampleFetch(), env, log: (l) => lines.push(l) });
    expect(lines.join("\n")).to.contain("its own limits take over from the shared ones");
    const now = guard.loadGuard(AGENT, env).guard;
    expect(now.fromCohort).to.equal(undefined);
    expect(now.pending.map((x) => x.what).join(" ")).to.contain("add payee");
  });

  it("counts the outreach numbers: first-ever payments over $100, and hours over 3x the wallet's earlier peak", async () => {
    const T = 1000 * 3600;
    const row = (h, payee, amount) => ({ ts: (T + h) * 3600 + 60, kind: "transfer", token: USDC.address, payee, amount });
    const [a, b, c] = ["0x" + "a".repeat(40), "0x" + "b".repeat(40), "0x" + "c".repeat(40)];
    const tokens = { [USDC.address]: { symbol: "USDC", rate: null } };
    const rows = [row(0, a, 50), row(1, a, 40), row(10, a, 60), row(11, b, 101), row(12, b, 500), row(13, c, 40), row(13, a, 100)];
    const m = fleet.measure(rows, tokens, {}, (T + 10) * 3600);
    // Earlier peak 50 an hour: hour 12 (500) is a burst; hour 13 (140) is not. b's first payment is over $100; c's isn't.
    expect(m).to.deep.equal({ payments: 5, firstOver100: 1, burstHours: 1, wouldHold: 2 });
    const lines = [];
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "rein-fleet-"));
    await fleet.main(["--sample", "--out", out], { log: (l) => lines.push(l) });
    expect(lines.join("\n")).to.contain("4 wallets read.").and.contain("first-ever payments over $100");
    expect(JSON.parse(fs.readFileSync(path.join(out, "fleet.json"), "utf8")).numbers).to.include({ wallets: 4, firstOver100: 5 });
  });

  it("lists the newest deployed Olas services' wallets from the registry on Base", async () => {
    const { ethers } = require("ethers");
    const iface = new ethers.Interface([
      "function totalSupply() view returns (uint256)",
      "function getService(uint256 serviceId) view returns ((uint96 securityDeposit, address multisig, bytes32 configHash, uint32 threshold, uint32 maxNumAgentInstances, uint32 numAgentInstances, uint8 state, uint32[] agentIds))",
    ]);
    const safe = (i) => ethers.getAddress("0x" + String(i).padStart(40, "5"));
    const calls = [];
    const fetch = async (url, init) => {
      const { params } = JSON.parse(init.body);
      expect(url).to.equal("https://base.blockscout.com/api/eth-rpc");
      expect(params[0].to).to.equal("0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE");
      const tx = iface.parseTransaction({ data: params[0].data });
      calls.push(tx.name);
      const result =
        tx.name === "totalSupply"
          ? iface.encodeFunctionResult("totalSupply", [10])
          : iface.encodeFunctionResult("getService", [[0, Number(tx.args[0]) === 9 ? ethers.ZeroAddress : safe(tx.args[0]), ethers.ZeroHash, 1, 1, 1, Number(tx.args[0]) === 8 ? 5 : 4, [1]]]);
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
    };
    // 10 is deployed; 9 has no Safe yet; 8 is terminated.
    expect(await fleet.olasWallets(3, { fetch })).to.deep.equal([safe(10), safe(7), safe(6)]);
    expect(calls[0]).to.equal("totalSupply");
  });

  it("is a rein command", async () => {
    const lines = [];
    const log = console.log;
    console.log = (l) => lines.push(l);
    try {
      expect(await rein.main(["fleet", "--sample"])).to.equal(0);
    } finally {
      console.log = log;
    }
    expect(lines.join("\n")).to.contain("Rein shadow mode");
  });
});
