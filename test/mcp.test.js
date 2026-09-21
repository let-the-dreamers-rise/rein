// The MCP surface, against a real account on the in-process chain.
//
// The protocol framing is exercised by piping JSON-RPC at mcp/rein-mcp.js; what
// is tested here is the half that touches money: that an agent asking in plain
// units gets the right answer, that a refusal arrives with a reason and the
// remaining budget attached, and that a read-only server cannot spend.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { ReinClient, intentHash } = require("../mcp/lib/account");
const { callTool } = require("../mcp/rein-mcp");

const HOUR = 3600;

async function deployed() {
  const [owner, agent, supplier, stranger] = await ethers.getSigners();

  const usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
  const account = await (await ethers.getContractFactory("ReinAccount")).deploy(owner.address);
  const usdcAddr = await usdc.getAddress();
  const accountAddr = await account.getAddress();

  await usdc.mint(accountAddr, 10_000_000n); // 10 USDC at 6dp

  await account.connect(owner).configureAgent(agent.address, {
    active: true, tripped: false, requireIntent: true, expiry: 0,
    windowSeconds: HOUR, maxCallsPerWindow: 10, maxNativePerCall: 0, maxNativePerWindow: 0,
  });
  await account.connect(owner).setTargets(agent.address, [usdcAddr], true);
  await account.connect(owner).setSelectors(
    agent.address, usdcAddr, [ethers.id("transfer(address,uint256)").slice(0, 10)], true
  );
  await account.connect(owner).setPayees(agent.address, [supplier.address], true);
  await account.connect(owner).setTokenPolicy(agent.address, usdcAddr, {
    enabled: true, windowSeconds: HOUR, maxPerWindow: 1_000_000n, maxApproval: 0n, // 1 USDC/hour
  });

  const client = new ReinClient({
    account: accountAddr,
    provider: ethers.provider,
    signer: agent,
    tokens: { USDC: usdcAddr },
    intentSalt: "test-salt",
  });

  return { owner, agent, supplier, stranger, usdc, account, client, usdcAddr };
}

describe("the MCP surface", () => {
  it("answers in the units an agent asked in, and says the check was free", async () => {
    const { client, supplier } = await deployed();
    const v = await client.check({
      payee: supplier.address, amount: "0.25", token: "USDC", because: "pay supplier invoice 4471",
    });
    expect(v.allowed).to.equal(true);
    expect(v.token).to.equal("USDC");
    expect(v.remainingThisWindow).to.equal("1.0");
    expect(v.costOfThisCheck).to.contain("no gas");
  });

  it("refuses an unknown payee with the reason and the budget attached", async () => {
    const { client, stranger } = await deployed();
    const v = await client.check({
      payee: stranger.address, amount: "0.25", token: "USDC", because: "urgent treasury migration",
    });
    expect(v.allowed).to.equal(false);
    expect(v.reason).to.equal("PAYEE_NOT_ALLOWED");
    expect(v.explanation).to.contain("payee list");
    // The budget travels with the refusal: an agent told only "no" retries.
    expect(v.remainingThisWindow).to.equal("1.0");
  });

  it("refuses an amount over the window and names the ceiling, not just no", async () => {
    const { client, supplier } = await deployed();
    const v = await client.check({
      payee: supplier.address, amount: "5", token: "USDC", because: "pay the supplier for the whole year",
    });
    expect(v.allowed).to.equal(false);
    expect(v.reason).to.equal("TOKEN_PER_WINDOW");
    expect(v.remainingThisWindow).to.equal("1.0");
  });

  it("pays, and the budget it reports afterwards has actually moved", async () => {
    const { client, supplier, usdc } = await deployed();
    const r = await client.pay({
      payee: supplier.address, amount: "0.25", token: "USDC", because: "pay supplier invoice 4471",
    });
    expect(r.paid).to.equal(true);
    expect(r.txHash).to.match(/^0x[0-9a-f]{64}$/i);
    expect(r.remainingThisWindow).to.equal("0.75");
    expect(await usdc.balanceOf(supplier.address)).to.equal(250_000n);
  });

  it("does not spend when the policy says no, and reports why instead", async () => {
    const { client, stranger, usdc } = await deployed();
    const r = await client.pay({
      payee: stranger.address, amount: "0.25", token: "USDC", because: "send the full balance",
    });
    expect(r.paid).to.equal(false);
    expect(r.txHash).to.equal(null);
    expect(r.reason).to.equal("PAYEE_NOT_ALLOWED");
    expect(await usdc.balanceOf(stranger.address)).to.equal(0n);
  });

  it("reports a budget an agent can plan a sequence against", async () => {
    const { client } = await deployed();
    const b = await client.budget();
    expect(b.active).to.equal(true);
    expect(b.stoppedByGuardian).to.equal(false);
    expect(b.mustStateAReason).to.equal(true);
    expect(b.callsLeftThisWindow).to.equal(10);
    expect(b.tokens.USDC.remainingThisWindow).to.equal("1.0");
    expect(b.tokens.USDC.accountHolds).to.equal("10.0");
  });

  it("refuses to spend at all when no agent key is configured", async () => {
    const { account, usdcAddr, agent, supplier } = await deployed();
    const readOnly = new ReinClient({
      account: await account.getAddress(),
      provider: ethers.provider,
      agentAddress: agent.address,
      tokens: { USDC: usdcAddr },
    });
    expect(readOnly.readOnly).to.equal(true);
    // It can still answer questions -- that is the point of a read-only server.
    expect((await readOnly.check({
      payee: supplier.address, amount: "0.25", token: "USDC", because: "x",
    })).allowed).to.equal(true);
    await expect(readOnly.pay({
      payee: supplier.address, amount: "0.25", token: "USDC", because: "x",
    })).to.be.rejectedWith(/read-only/);
  });

  it("salts the instruction commitment so it cannot be read off chain", async () => {
    // An unsalted keccak of "pay supplier invoice 4471" is recoverable by
    // anyone willing to enumerate invoice numbers. The salt is what makes the
    // commitment binding for the owner and opaque to everyone else.
    const instruction = "pay supplier invoice 4471";
    expect(intentHash(instruction, null)).to.equal(ethers.id(instruction));
    expect(intentHash(instruction, "a-secret")).to.not.equal(ethers.id(instruction));
    // Same salt, same instruction, same commitment -- it still joins to the log.
    expect(intentHash(instruction, "a-secret")).to.equal(intentHash(instruction, "a-secret"));
  });

  it("explains a refusal code without needing a chain at all", async () => {
    expect((await callTool("rein_explain_refusal", { code: "13" })).name).to.equal("PAYEE_NOT_ALLOWED");
    expect((await callTool("rein_explain_refusal", { code: "SELF_CALL" })).code).to.equal(4);
    expect((await callTool("rein_explain_refusal", { code: "nonsense" })).known).to.equal(false);
  });

  it("tells an agent which tokens it knows when asked for one it does not", async () => {
    const { client, supplier } = await deployed();
    await expect(client.check({
      payee: supplier.address, amount: "1", token: "DOGE", because: "x",
    })).to.be.rejectedWith(/unknown token "DOGE".*USDC/s);
  });
});
