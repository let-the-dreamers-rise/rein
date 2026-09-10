// The AgentKit adapter: every write goes through the account, refusals arrive
// before gas is spent, and they carry the same code the contract would revert with.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { ReinWalletProvider, ReinRefusal } = require("../goat/rein-wallet-provider");

const HOUR = 3600;
const NATIVE_SELECTOR = "0x00000000";

async function setup() {
  const [owner, agent, seller, attacker] = await ethers.getSigners();
  const account = await ethers.deployContract("ReinAccount", [owner.address]);
  const token = await ethers.deployContract("MockERC20", ["Demo USD", "USDT", 6]);
  const accountAddr = await account.getAddress();
  const tokenAddr = await token.getAddress();

  await owner.sendTransaction({ to: accountAddr, value: ethers.parseEther("1") });
  await token.mint(accountAddr, 1_000_000n);

  await account.configureAgent(agent.address, {
    active: true, tripped: false, requireIntent: true, expiry: 0,
    windowSeconds: HOUR, maxCallsPerWindow: 10,
    maxNativePerCall: ethers.parseEther("0.1"), maxNativePerWindow: ethers.parseEther("0.2"),
  });
  await account.setTargets(agent.address, [seller.address, tokenAddr], true);
  await account.setSelectors(agent.address, seller.address, [NATIVE_SELECTOR], true);
  await account.setSelectors(agent.address, tokenAddr, [
    token.interface.getFunction("transfer").selector,
    token.interface.getFunction("approve").selector,
  ], true);
  await account.setPayees(agent.address, [seller.address], true);
  await account.setTokenPolicy(agent.address, tokenAddr, {
    enabled: true, windowSeconds: HOUR, maxPerWindow: 500n, maxApproval: 500n,
  });

  const wallet = new ReinWalletProvider({
    agentSigner: agent, provider: ethers.provider, accountAddress: accountAddr,
  }).setIntent("pay the seller for one call");

  return { owner, agent, seller, attacker, account, token, accountAddr, tokenAddr, wallet };
}

async function refusal(promise) {
  try {
    await promise;
  } catch (e) {
    expect(e).to.be.instanceOf(ReinRefusal);
    return e.reason;
  }
  expect.fail("expected a ReinRefusal");
}

describe("ReinWalletProvider", () => {
  it("reports the account, not the agent key, as its address", async () => {
    const { wallet, accountAddr, agent } = await setup();
    expect(await wallet.getAddress()).to.equal(accountAddr);
    expect(await wallet.getAgentAddress()).to.equal(agent.address);
    expect(await wallet.getNetwork()).to.equal("goat-testnet");
  });

  it("pays an allowlisted seller in native value", async () => {
    const { wallet, seller } = await setup();
    const before = await ethers.provider.getBalance(seller.address);
    const { txHash } = await wallet.transferNative(seller.address, ethers.parseEther("0.05"));
    expect(txHash).to.match(/^0x[0-9a-f]{64}$/);
    expect((await ethers.provider.getBalance(seller.address)) - before).to.equal(ethers.parseEther("0.05"));
  });

  it("refuses a payee that is not allowlisted, before sending anything", async () => {
    const { wallet, attacker } = await setup();
    expect(await refusal(wallet.transferNative(attacker.address, 1n))).to.equal("TARGET_NOT_ALLOWED");
    expect(await ethers.provider.getBalance(attacker.address)).to.equal(ethers.parseEther("10000"));
  });

  it("refuses more native value than one call may carry", async () => {
    const { wallet, seller } = await setup();
    expect(await refusal(wallet.transferNative(seller.address, ethers.parseEther("0.5")))).to.equal("NATIVE_PER_CALL");
  });

  it("refuses a call that carries no instruction", async () => {
    const { wallet, seller } = await setup();
    wallet.setIntent("");
    expect(await refusal(wallet.transferNative(seller.address, 1n))).to.equal("INTENT_REQUIRED");
  });

  it("routes ERC-20 transfers through the token policy", async () => {
    const { wallet, seller, attacker, token, tokenAddr } = await setup();
    await wallet.transferErc20(tokenAddr, seller.address, 250n);
    expect(await token.balanceOf(seller.address)).to.equal(250n);
    expect(await refusal(wallet.transferErc20(tokenAddr, attacker.address, 1n))).to.equal("PAYEE_NOT_ALLOWED");
    expect(await refusal(wallet.transferErc20(tokenAddr, seller.address, 251n))).to.equal("TOKEN_PER_WINDOW");
  });

  it("caps approvals and forbids unlimited allowance", async () => {
    const { wallet, seller, tokenAddr } = await setup();
    await wallet.approveErc20(tokenAddr, seller.address, 500n);
    expect(await refusal(wallet.approveErc20(tokenAddr, seller.address, ethers.MaxUint256))).to.equal("APPROVAL_TOO_LARGE");
  });

  it("writeContract encodes and executes through the account", async () => {
    const { wallet, seller, token, tokenAddr } = await setup();
    const abi = ["function transfer(address to, uint256 value) returns (bool)"];
    await wallet.writeContract(tokenAddr, abi, "transfer", [seller.address, 10n]);
    expect(await token.balanceOf(seller.address)).to.equal(10n);
  });

  it("refuses to widen its own policy", async () => {
    const { wallet, account, accountAddr, agent, attacker } = await setup();
    const abi = ["function setTargets(address agent, address[] targets, bool allowed)"];
    expect(await refusal(wallet.writeContract(accountAddr, abi, "setTargets", [agent.address, [attacker.address], true]))).to.equal("SELF_CALL");
    expect(await account.simulate(agent.address, attacker.address, 1n, "0x", ethers.id("x"))).to.equal(5n);
  });

  it("cannot sign typed data or deploy", async () => {
    const { wallet } = await setup();
    await expect(wallet.signTypedData({}, {}, {})).to.be.rejectedWith(/cannot sign typed data/);
    await expect(wallet.deployContract([], "0x")).to.be.rejectedWith(/does not deploy/);
  });
});
