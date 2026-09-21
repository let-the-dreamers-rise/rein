// The router hole, demonstrated and then closed.
//
// The claim on the front of the README is that an agent which has been
// completely taken over "still cannot produce a transaction the account is
// unwilling to make". These tests show that on v1/v2 that is false whenever
// the agent is allowlisted for anything that moves tokens on its behalf -- a
// DEX router, a bridge, a vault -- because CalldataGuard only decodes four
// ERC-20 selectors and everything else is invisible to the policy.
//
// The first test is red against the product: it asserts the drain SUCCEEDS.
// The rest show v3 pricing the same call correctly, because v3 stops reading
// the calldata and starts reading the balance sheet.
const { expect } = require("chai");
const { ethers } = require("hardhat");

const HOUR = 3600;
const INTENT = ethers.id("pay supplier invoice 4471");

// Selector-level policy the owner would plausibly write for a swapping agent.
const SWAP_SIG = "swapExact(address,uint256,uint256,address)";

async function fixture(which) {
  const [owner, agent, attacker, supplier] = await ethers.getSigners();

  const usdt = await (await ethers.getContractFactory("MockERC20")).deploy("Tether", "USDT", 6);
  const router = await (await ethers.getContractFactory("DrainRouter")).deploy();
  const account = await (await ethers.getContractFactory(which)).deploy(owner.address);

  await usdt.mint(await account.getAddress(), 10_000n);

  return { owner, agent, attacker, supplier, usdt, router, account };
}

// The policy an owner writes for an agent that swaps: it may touch the token
// and the router, approve the router up to 500, and pay the supplier. The
// rolling ceiling is 600 an hour, which is the number the owner believes
// bounds their exposure.
async function configure(ctx, { guarded = false, maxPerWindow = 600n } = {}) {
  const { owner, agent, supplier, usdt, router, account } = ctx;
  const usdtAddr = await usdt.getAddress();
  const routerAddr = await router.getAddress();

  await account.connect(owner).configureAgent(agent.address, {
    active: true,
    tripped: false,
    requireIntent: true,
    expiry: 0,
    windowSeconds: HOUR,
    maxCallsPerWindow: 50,
    maxNativePerCall: 0,
    maxNativePerWindow: 0,
  });

  await account.connect(owner).setTargets(agent.address, [usdtAddr, routerAddr], true);
  await account.connect(owner).setSelectors(agent.address, usdtAddr, [
    ethers.id("approve(address,uint256)").slice(0, 10),
    ethers.id("transfer(address,uint256)").slice(0, 10),
  ], true);
  await account.connect(owner).setSelectors(agent.address, routerAddr, [
    ethers.id(SWAP_SIG).slice(0, 10),
  ], true);
  await account.connect(owner).setPayees(agent.address, [routerAddr, supplier.address], true);

  // v3 only: arm the balance-sheet meter before the token policy will be taken.
  if (guarded) {
    await account.connect(owner).setGuardedTokens(agent.address, [usdtAddr]);
    await account.connect(owner).setWatchedSpenders(agent.address, [routerAddr]);
  }

  await account.connect(owner).setTokenPolicy(agent.address, usdtAddr, {
    enabled: true,
    windowSeconds: HOUR,
    maxPerWindow,
    maxApproval: 500n,
  });
}

const approveData = (usdt, to, amount) =>
  usdt.interface.encodeFunctionData("approve", [to, amount]);

const swapData = (router, token, amount, recipient) =>
  router.interface.encodeFunctionData("swapExact", [token, amount, 0, recipient]);

describe("the router hole", () => {
  describe("ReinAccount (v1/v2, as shipped)", () => {
    it("lets a compromised agent drain the account through an allowlisted router", async () => {
      const ctx = await fixture("ReinAccount");
      await configure(ctx);
      const { agent, attacker, usdt, router, account } = ctx;
      const usdtAddr = await usdt.getAddress();
      const routerAddr = await router.getAddress();

      // Both of these are calls the owner's policy explicitly permits.
      await account.connect(agent).execute(usdtAddr, 0, approveData(usdt, routerAddr, 500n), INTENT);
      await account.connect(agent).execute(routerAddr, 0, swapData(router, usdtAddr, 500n, attacker.address), INTENT);

      // The money reached an address that is not on the payee list.
      expect(await usdt.balanceOf(attacker.address)).to.equal(500n);

      // And the rolling spend window -- the number the owner believes bounds
      // their hourly exposure -- was never touched. This is the finding: the
      // ceiling is not a ceiling for anything the decoder cannot read.
      expect(await account.remainingToken(agent.address, usdtAddr)).to.equal(600n);
    });

    it("repeats without limit, so the hourly ceiling bounds nothing", async () => {
      const ctx = await fixture("ReinAccount");
      await configure(ctx);
      const { agent, attacker, usdt, router, account } = ctx;
      const usdtAddr = await usdt.getAddress();
      const routerAddr = await router.getAddress();

      // Ten laps inside one window, against a 600/hour ceiling.
      for (let i = 0; i < 10; i++) {
        await account.connect(agent).execute(usdtAddr, 0, approveData(usdt, routerAddr, 500n), INTENT);
        await account.connect(agent).execute(routerAddr, 0, swapData(router, usdtAddr, 500n, attacker.address), INTENT);
      }

      expect(await usdt.balanceOf(attacker.address)).to.equal(5000n);
      expect(await account.remainingToken(agent.address, usdtAddr)).to.equal(600n);
    });
  });

  describe("ReinAccountV3 (metering the balance sheet)", () => {
    it("charges the undeclared outflow to the window and then refuses", async () => {
      const ctx = await fixture("ReinAccountV3");
      await configure(ctx, { guarded: true });
      const { agent, attacker, usdt, router, account } = ctx;
      const usdtAddr = await usdt.getAddress();
      const routerAddr = await router.getAddress();

      await account.connect(agent).execute(usdtAddr, 0, approveData(usdt, routerAddr, 500n), INTENT);
      await account.connect(agent).execute(routerAddr, 0, swapData(router, usdtAddr, 500n, attacker.address), INTENT);

      // The first lap still gets through -- 500 is inside the 600 ceiling, and
      // a policy that refused it would be refusing an in-budget payment. What
      // changed is that it was COUNTED.
      expect(await usdt.balanceOf(attacker.address)).to.equal(500n);
      expect(await account.remainingToken(agent.address, usdtAddr)).to.equal(100n);

      // The second lap is refused, because the window is now nearly spent.
      await account.connect(agent).execute(usdtAddr, 0, approveData(usdt, routerAddr, 500n), INTENT);
      await expect(
        account.connect(agent).execute(routerAddr, 0, swapData(router, usdtAddr, 500n, attacker.address), INTENT)
      ).to.be.revertedWithCustomError(account, "PolicyViolation").withArgs(17); // OUTFLOW_EXCEEDED

      // Loss is bounded by the ceiling the owner actually wrote, which is what
      // the ceiling was always supposed to mean.
      expect(await usdt.balanceOf(attacker.address)).to.equal(500n);
    });

    it("bounds a ten-lap attack to one window instead of the whole balance", async () => {
      const ctx = await fixture("ReinAccountV3");
      await configure(ctx, { guarded: true });
      const { agent, attacker, usdt, router, account } = ctx;
      const usdtAddr = await usdt.getAddress();
      const routerAddr = await router.getAddress();

      for (let i = 0; i < 10; i++) {
        try {
          await account.connect(agent).execute(usdtAddr, 0, approveData(usdt, routerAddr, 500n), INTENT);
          await account.connect(agent).execute(routerAddr, 0, swapData(router, usdtAddr, 500n, attacker.address), INTENT);
        } catch {
          // refused: the window is spent
        }
      }

      const stolen = await usdt.balanceOf(attacker.address);
      expect(stolen).to.be.lessThanOrEqual(600n);
      expect(stolen).to.equal(500n);
    });

    it("refuses an opaque call outright when nothing is being metered", async () => {
      // Fail-closed by default: an agent whose owner never armed the meter
      // cannot make a call the policy is unable to price. The owner has to say
      // "this agent touches no tokens" out loud before that is allowed.
      const ctx = await fixture("ReinAccountV3");
      const { owner, agent, attacker, usdt, router, account } = ctx;
      const usdtAddr = await usdt.getAddress();
      const routerAddr = await router.getAddress();

      await account.connect(owner).configureAgent(agent.address, {
        active: true, tripped: false, requireIntent: true, expiry: 0,
        windowSeconds: HOUR, maxCallsPerWindow: 50, maxNativePerCall: 0, maxNativePerWindow: 0,
      });
      await account.connect(owner).setTargets(agent.address, [routerAddr], true);
      await account.connect(owner).setSelectors(agent.address, routerAddr, [ethers.id(SWAP_SIG).slice(0, 10)], true);

      expect(
        await account.simulate(agent.address, routerAddr, 0, swapData(router, usdtAddr, 500n, attacker.address), INTENT)
      ).to.equal(16); // UNMETERED_CALL

      await expect(
        account.connect(agent).execute(routerAddr, 0, swapData(router, usdtAddr, 500n, attacker.address), INTENT)
      ).to.be.revertedWithCustomError(account, "PolicyViolation").withArgs(16);
    });

    it("refuses a token ceiling that is not backed by a meter", async () => {
      // The invariant is enforced where it cannot be got around: at
      // configuration time. A ceiling on a token nobody is watching is the
      // false comfort this whole version exists to remove.
      const ctx = await fixture("ReinAccountV3");
      const { owner, agent, usdt, account } = ctx;

      await account.connect(owner).configureAgent(agent.address, {
        active: true, tripped: false, requireIntent: true, expiry: 0,
        windowSeconds: HOUR, maxCallsPerWindow: 50, maxNativePerCall: 0, maxNativePerWindow: 0,
      });

      await expect(
        account.connect(owner).setTokenPolicy(agent.address, await usdt.getAddress(), {
          enabled: true, windowSeconds: HOUR, maxPerWindow: 600n, maxApproval: 500n,
        })
      ).to.be.revertedWithCustomError(account, "BadConfig");
    });

    it("still allows and prices an ordinary declared payment exactly as before", async () => {
      // The regression that matters: metering must not change what an honest
      // agent sees. A plain transfer to an allowed payee is charged once, at
      // its declared amount, not twice.
      const ctx = await fixture("ReinAccountV3");
      await configure(ctx, { guarded: true });
      const { agent, supplier, usdt, account } = ctx;
      const usdtAddr = await usdt.getAddress();

      const data = usdt.interface.encodeFunctionData("transfer", [supplier.address, 250n]);
      expect(await account.simulate(agent.address, usdtAddr, 0, data, INTENT)).to.equal(0);
      await account.connect(agent).execute(usdtAddr, 0, data, INTENT);

      expect(await usdt.balanceOf(supplier.address)).to.equal(250n);
      expect(await account.remainingToken(agent.address, usdtAddr)).to.equal(350n);
    });
  });
});
