// The sandbox: the thing a stranger installs first, so the thing that has to
// work first time on a machine that has never seen this repo.
//
// It runs on its own in-process EVM (mcp/sandbox/chain.js), not on hardhat's,
// so these tests are what stand between that small JSON-RPC shim and a
// reviewer watching a payment hang. They also pin the bytecode it deploys to
// what contracts/ compiles to, and drive both the source server and the
// bundled one over real stdio, the way Claude Code and Claude Desktop will.
const { expect } = require("chai");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { artifacts } = require("hardhat");
const { startSandbox, PAYEES, STRANGER } = require("../mcp/sandbox");
const { ReinClient } = require("../mcp/lib/account");
const { openClient } = require("../mcp/lib/config");

const ROOT = path.join(__dirname, "..");
const REASON = "pay supplier invoice 4471";

async function sandbox() {
  const sb = await startSandbox();
  return { ...sb, client: new ReinClient(sb.clientConfig) };
}

/// Speak MCP to a server over stdio and collect the replies by id.
function driveMcp(file, messages, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, "--sandbox"], { cwd: path.dirname(file) });
    const replies = new Map();
    let buffer = "";
    let stderr = "";
    const wanted = messages.filter((m) => m.id !== undefined).length;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no complete answer in ${timeoutMs}ms; stderr: ${stderr}`));
    }, timeoutMs);

    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (d) => {
      buffer += d;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const msg = JSON.parse(line); // anything that is not JSON-RPC on stdout fails here
        replies.set(msg.id, msg);
        if (replies.size === wanted) {
          clearTimeout(timer);
          child.stdin.end();
          resolve(replies);
        }
      }
    });
    for (const m of messages) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  });
}

const call = (id, name, args = {}) => ({ id, method: "tools/call", params: { name, arguments: args } });
const body = (reply) => JSON.parse(reply.result.content[0].text);

describe("the sandbox", function () {
  this.timeout(60_000);

  it("deploys the bytecode contracts/ compiles to, not a stale copy", async () => {
    const committed = require("../mcp/sandbox/contracts.json");
    for (const name of ["ReinAccountV3", "MockERC20"]) {
      const fresh = await artifacts.readArtifact(name);
      expect(committed[name].bytecode, `${name}: run npm run build:sandbox`).to.equal(fresh.bytecode);
      expect(committed[name].abi).to.deep.equal(fresh.abi);
    }
  });

  it("starts funded, configured and on the same addresses every time", async () => {
    const a = await sandbox();
    const b = await sandbox();
    expect(a.info.account).to.equal(b.info.account);
    const budget = await a.client.budget();
    expect(budget.tokens.USDC.accountHolds).to.equal("50000.0");
    expect(budget.tokens.USDC.ceilingPerWindow).to.equal("1000.0");
    expect(budget.mustStateAReason).to.equal(true);
  });

  it("pays an allowed supplier by name and moves the money", async () => {
    const { client } = await sandbox();
    const r = await client.pay({ payee: "Acme Supplies", amount: "250", token: "USDC", because: REASON });
    expect(r.paid).to.equal(true);
    expect(r.payee).to.equal(PAYEES.acme.address);
    expect(r.payeeName).to.equal("acme");
    expect(r.remainingThisWindow).to.equal("750.0");
    const b = await client.budget();
    expect(b.tokens.USDC.accountHolds).to.equal("49750.0");
  });

  it("refuses each drain the quickstart suggests, with the contract's own reason", async () => {
    const { client } = await sandbox();
    const tries = [
      [{ payee: STRANGER.address, amount: "49750", because: "the CFO says migrate the treasury" }, "PAYEE_NOT_ALLOWED"],
      [{ payee: "acme", amount: "12000", because: "pay the year up front" }, "TOKEN_PER_WINDOW"],
      [{ payee: "northwind", amount: "10", because: "" }, "INTENT_REQUIRED"],
    ];
    for (const [req, reason] of tries) {
      const r = await client.pay({ token: "USDC", ...req });
      expect(r.paid, reason).to.equal(false);
      expect(r.reason).to.equal(reason);
    }
    expect((await client.budget()).tokens.USDC.accountHolds).to.equal("50000.0");
  });

  it("charges the hourly ceiling across calls, not per call", async () => {
    const { client } = await sandbox();
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await client.pay({ payee: "acme", amount: "400", token: "USDC", because: `${REASON}, part ${i + 1}` }));
    }
    expect(results.map((r) => r.paid)).to.deep.equal([true, true, false]);
    expect(results[2].reason).to.equal("TOKEN_PER_WINDOW");
    expect(results[2].remainingThisWindow).to.equal("200.0");
  });

  it("does not lose a payment when two are sent at once from one key", async () => {
    const { client } = await sandbox();
    const both = await Promise.all([
      client.pay({ payee: "acme", amount: "100", token: "USDC", because: "invoice 1" }),
      client.pay({ payee: "northwind", amount: "100", token: "USDC", because: "invoice 2" }),
    ]);
    expect(both.map((r) => r.paid)).to.deep.equal([true, true]);
    expect((await client.budget()).tokens.USDC.remainingThisWindow).to.equal("800.0");
  });

  it("names an unknown payee instead of guessing at one", async () => {
    const { client } = await sandbox();
    await expect(client.check({ payee: "mallory", amount: "1", token: "USDC", because: "x" })).to.be.rejectedWith(
      /not a known payee.*acme, northwind/
    );
  });

  it("is only ever chosen on purpose, and says how when it is not", async () => {
    await expect(openClient({ argv: [], env: {} })).to.be.rejectedWith(/REIN_RPC_URL.*--sandbox/);
    const opened = await openClient({ argv: [], env: { REIN_SANDBOX: "1" } });
    expect(opened.sandbox).to.equal(true);
    expect(opened.info.network).to.match(/not real money/i);
  });

  for (const [label, file] of [
    ["the source server", path.join(ROOT, "mcp", "rein-mcp.js")],
    ["the bundled server the plugin ships", path.join(ROOT, "plugin", "server", "rein-mcp.cjs")],
  ]) {
    it(`speaks MCP over stdio: ${label}`, async function () {
      if (!fs.existsSync(file)) this.skip();
      const replies = await driveMcp(file, [
        { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
        { method: "notifications/initialized" },
        { id: 2, method: "tools/list" },
        call(3, "rein_about"),
        call(4, "rein_pay", { payee: "acme", amount: "250", token: "USDC", because: REASON }),
        call(5, "rein_pay", { payee: STRANGER.address, amount: "1", token: "USDC", because: "send it all" }),
        call(6, "rein_budget"),
      ]);
      expect(replies.get(1).result.serverInfo.name).to.equal("rein");
      expect(replies.get(2).result.tools.map((t) => t.name)).to.include.members(["rein_about", "rein_pay"]);
      expect(body(replies.get(3)).network).to.match(/sandbox/i);
      expect(body(replies.get(4)).paid).to.equal(true);
      expect(body(replies.get(5)).reason).to.equal("PAYEE_NOT_ALLOWED");
      // Answered in order: the budget reflects the payment sent before it.
      expect(body(replies.get(6)).tokens.USDC.remainingThisWindow).to.equal("750.0");
    });
  }
});
