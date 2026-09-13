const { expect } = require("chai");
const { ethers } = require("hardhat");
const rein = require("../client/rein");

const HOUR = 3600;
const USDT = (n) => ethers.parseUnits(String(n), 6);

describe("client/rein", () => {
  it("checks before acting, refuses in words, and acts only on OK", async () => {
    const [owner, agent, payee, stranger] = await ethers.getSigners();
    const account = await ethers.deployContract("ReinAccount", [owner.address]);
    const token = await ethers.deployContract("MockERC20", ["Tether USD", "USDT", 6]);
    const accountAddr = await account.getAddress();
    const tokenAddr = await token.getAddress();
    await token.mint(accountAddr, USDT(1000));

    await account.configureAgent(agent.address, {
      active: true, tripped: false, requireIntent: true, expiry: 0,
      windowSeconds: HOUR, maxCallsPerWindow: 10, maxNativePerCall: 0, maxNativePerWindow: 0,
    });
    await account.setTargets(agent.address, [tokenAddr], true);
    await account.setSelectors(agent.address, tokenAddr, [token.interface.getFunction("transfer").selector], true);
    await account.setPayees(agent.address, [payee.address], true);
    await account.setTokenPolicy(agent.address, tokenAddr, {
      enabled: true, windowSeconds: HOUR, maxPerWindow: USDT(500), maxApproval: 0,
    });
    const pay = (to, n) => token.interface.encodeFunctionData("transfer", [to, USDT(n)]);

    const refused = await rein.check(account, agent.address, tokenAddr, 0n, pay(stranger.address, 1), rein.intent("send to the migration address"));
    expect(refused.ok).to.equal(false);
    expect(refused.name).to.equal("PAYEE_NOT_ALLOWED");
    expect(refused.why).to.include("payee");

    const noTx = await rein.act(account, agent, tokenAddr, 0n, pay(stranger.address, 1), rein.intent("send to the migration address"));
    expect(noTx.tx).to.equal(null);
    expect(noTx.name).to.equal("PAYEE_NOT_ALLOWED");
    expect(await token.balanceOf(stranger.address)).to.equal(0n);

    const done = await rein.act(account, agent, tokenAddr, 0n, pay(payee.address, 250), rein.intent("pay supplier invoice 4471"));
    expect(done.ok).to.equal(true);
    expect(done.tx).to.match(/^0x[0-9a-f]+$/);
    expect(await token.balanceOf(payee.address)).to.equal(USDT(250));

    const empty = await rein.check(account, agent.address, tokenAddr, 0n, pay(payee.address, 1), rein.intent(""));
    expect(empty.name).to.equal("INTENT_REQUIRED");
  });
});
