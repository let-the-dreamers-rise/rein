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
const { sampleHistory, sampleFetch, AGENT, PAYEES, USDC, ROUTER } = require("../scan/sample");
const { callTool } = require("../mcp/rein-mcp");
const { runBatch, readWallets } = require("../scan/cli");

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

    it("exports vendor policy JSON with no placeholders or rounding noise", () => {
      const e = exportPolicy(report);
      const text = JSON.stringify(e);
      // The one placeholder left is the approver id only the wallet's owner knows.
      expect(text.replaceAll("<AGENT_USER_ID>", "")).to.not.match(/<[^>]+>/);
      expect(text).to.not.contain("(none)");
      expect(text).to.not.match(/e\+\d/);
      expect(e.turnkey.some((p) => p.condition.includes(USDC.address))).to.equal(true);
      expect(e.privy.default_action).to.equal("DENY");
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

  describe("the ways in", () => {
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
