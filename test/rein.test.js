const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// Mirror of contracts/ReinCodes.sol. If these ever drift, the suite is lying.
const CODE = {
  OK: 0,
  NOT_AN_AGENT: 1,
  AGENT_EXPIRED: 2,
  BREAKER_TRIPPED: 3,
  SELF_CALL: 4,
  TARGET_NOT_ALLOWED: 5,
  SELECTOR_NOT_ALLOWED: 6,
  NATIVE_PER_CALL: 7,
  NATIVE_PER_WINDOW: 8,
  CALL_RATE: 9,
  TOKEN_NOT_ALLOWED: 10,
  TOKEN_PER_WINDOW: 11,
  APPROVAL_TOO_LARGE: 12,
  PAYEE_NOT_ALLOWED: 13,
  INTENT_REQUIRED: 14,
  DELTA_APPROVAL_UNSUPPORTED: 15,
};

const HOUR = 3600;
const USDT = (n) => ethers.parseUnits(String(n), 6);
const INTENT = ethers.id("pay the invoice for order 4471");
const NO_INTENT = ethers.ZeroHash;
const MAX_UINT = ethers.MaxUint256;

async function deployed() {
  const [owner, agent, guardian, payee, stranger] = await ethers.getSigners();

  const account = await ethers.deployContract("ReinAccount", [owner.address]);
  const token = await ethers.deployContract("MockERC20", ["Tether USD", "USDT", 6]);
  const sink = await ethers.deployContract("Sink");

  const accountAddr = await account.getAddress();
  const tokenAddr = await token.getAddress();
  const sinkAddr = await sink.getAddress();

  await token.mint(accountAddr, USDT(1_000_000));
  await owner.sendTransaction({ to: accountAddr, value: ethers.parseEther("50") });

  await account.configureAgent(agent.address, {
    active: true,
    tripped: false,
    requireIntent: true,
    expiry: 0,
    windowSeconds: HOUR,
    maxCallsPerWindow: 10,
    maxNativePerCall: ethers.parseEther("1"),
    maxNativePerWindow: ethers.parseEther("2"),
  });

  await account.setTargets(agent.address, [tokenAddr, sinkAddr], true);
  await account.setSelectors(
    agent.address,
    tokenAddr,
    [
      token.interface.getFunction("transfer").selector,
      token.interface.getFunction("approve").selector,
      token.interface.getFunction("transferFrom").selector,
      token.interface.getFunction("increaseAllowance").selector,
    ],
    true
  );
  await account.setSelectors(
    agent.address,
    sinkAddr,
    [sink.interface.getFunction("ping").selector, sink.interface.getFunction("reenter").selector],
    true
  );
  await account.setPayees(agent.address, [payee.address], true);
  await account.setTokenPolicy(agent.address, tokenAddr, {
    enabled: true,
    windowSeconds: HOUR,
    maxPerWindow: USDT(100),
    maxApproval: USDT(50),
  });
  await account.setGuardian(guardian.address, true);

  const xfer = (to, amt) => token.interface.encodeFunctionData("transfer", [to, amt]);
  const approve = (sp, amt) => token.interface.encodeFunctionData("approve", [sp, amt]);
  const ping = () => sink.interface.encodeFunctionData("ping", []);

  return {
    owner, agent, guardian, payee, stranger,
    account, token, sink,
    accountAddr, tokenAddr, sinkAddr,
    xfer, approve, ping,
  };
}

// The central claim of the design: what simulate() says is what execute() does.
// Every scenario below goes through here, so a divergence fails the suite
// rather than quietly teaching an agent the wrong lesson.
async function expectCode(f, code, { target, value = 0n, data = "0x", intent = INTENT }) {
  const { account, agent } = f;
  expect(await account.simulate(agent.address, target, value, data, intent)).to.equal(code);

  const send = account.connect(agent).execute(target, value, data, intent);
  if (code === CODE.OK) {
    await expect(send).to.not.be.reverted;
  } else {
    await expect(send).to.be.revertedWithCustomError(account, "PolicyViolation").withArgs(code);
  }
}

describe("ReinAccount", function () {
  describe("the happy path exists", function () {
    it("lets an authorized agent pay an allowlisted payee", async function () {
      const f = await loadFixture(deployed);
      await expectCode(f, CODE.OK, { target: f.tokenAddr, data: f.xfer(f.payee.address, USDT(25)) });
      expect(await f.token.balanceOf(f.payee.address)).to.equal(USDT(25));
    });

    it("lets it send native value to an allowlisted target", async function () {
      const f = await loadFixture(deployed);
      await expectCode(f, CODE.OK, {
        target: f.sinkAddr,
        value: ethers.parseEther("0.5"),
        data: f.ping(),
      });
      expect(await ethers.provider.getBalance(f.sinkAddr)).to.equal(ethers.parseEther("0.5"));
    });

    it("records the intent hash against the transaction", async function () {
      const f = await loadFixture(deployed);
      const data = f.xfer(f.payee.address, USDT(1));
      await expect(f.account.connect(f.agent).execute(f.tokenAddr, 0, data, INTENT))
        .to.emit(f.account, "IntentExecuted")
        .withArgs(f.agent.address, f.tokenAddr, INTENT, data.slice(0, 10), 0);
    });
  });

  describe("scope", function () {
    it("refuses a target that was never allowlisted", async function () {
      const f = await loadFixture(deployed);
      await expectCode(f, CODE.TARGET_NOT_ALLOWED, {
        target: f.stranger.address,
        data: f.xfer(f.payee.address, USDT(1)),
      });
    });

    it("refuses a selector that was never allowlisted on an allowed target", async function () {
      const f = await loadFixture(deployed);
      const data = f.token.interface.encodeFunctionData("mint", [f.agent.address, USDT(1)]);
      await expectCode(f, CODE.SELECTOR_NOT_ALLOWED, { target: f.tokenAddr, data });
    });

    it("refuses a bare value transfer unless 0x00000000 was allowlisted", async function () {
      const f = await loadFixture(deployed);
      await expectCode(f, CODE.SELECTOR_NOT_ALLOWED, {
        target: f.sinkAddr,
        value: ethers.parseEther("0.1"),
        data: "0x",
      });

      await f.account.setSelectors(f.agent.address, f.sinkAddr, ["0x00000000"], true);
      await expectCode(f, CODE.OK, {
        target: f.sinkAddr,
        value: ethers.parseEther("0.1"),
        data: "0x",
      });
    });

    it("refuses an unknown payee even on an allowed token and selector", async function () {
      const f = await loadFixture(deployed);
      await expectCode(f, CODE.PAYEE_NOT_ALLOWED, {
        target: f.tokenAddr,
        data: f.xfer(f.stranger.address, USDT(1)),
      });
    });

    it("refuses a token move when no token policy sets a ceiling", async function () {
      const f = await loadFixture(deployed);
      // Target and selector are allowed; only the token policy is withdrawn.
      await f.account.setTokenPolicy(f.agent.address, f.tokenAddr, {
        enabled: false,
        windowSeconds: 0,
        maxPerWindow: 0,
        maxApproval: 0,
      });
      await expectCode(f, CODE.TOKEN_NOT_ALLOWED, {
        target: f.tokenAddr,
        data: f.xfer(f.payee.address, USDT(1)),
      });
    });
  });

  describe("budgets", function () {
    it("caps a single native call", async function () {
      const f = await loadFixture(deployed);
      await expectCode(f, CODE.NATIVE_PER_CALL, {
        target: f.sinkAddr,
        value: ethers.parseEther("1.5"),
        data: f.ping(),
      });
    });

    it("caps native spend across calls, not just within one", async function () {
      const f = await loadFixture(deployed);
      const one = { target: f.sinkAddr, value: ethers.parseEther("1"), data: f.ping() };
      await expectCode(f, CODE.OK, one);
      await expectCode(f, CODE.OK, one);
      await expectCode(f, CODE.NATIVE_PER_WINDOW, one);
    });

    it("caps token spend across calls", async function () {
      const f = await loadFixture(deployed);
      await expectCode(f, CODE.OK, { target: f.tokenAddr, data: f.xfer(f.payee.address, USDT(60)) });
      await expectCode(f, CODE.OK, { target: f.tokenAddr, data: f.xfer(f.payee.address, USDT(40)) });
      await expectCode(f, CODE.TOKEN_PER_WINDOW, {
        target: f.tokenAddr,
        data: f.xfer(f.payee.address, USDT(1)),
      });
      expect(await f.token.balanceOf(f.payee.address)).to.equal(USDT(100));
    });

    it("caps the number of calls", async function () {
      const f = await loadFixture(deployed);
      const call = { target: f.tokenAddr, data: f.xfer(f.payee.address, USDT(1)) };
      for (let i = 0; i < 10; i++) await expectCode(f, CODE.OK, call);
      await expectCode(f, CODE.CALL_RATE, call);
    });

    it("lets budgets refill when the window rolls over", async function () {
      const f = await loadFixture(deployed);
      await expectCode(f, CODE.OK, { target: f.tokenAddr, data: f.xfer(f.payee.address, USDT(100)) });
      await expectCode(f, CODE.TOKEN_PER_WINDOW, {
        target: f.tokenAddr,
        data: f.xfer(f.payee.address, USDT(1)),
      });

      await time.increase(HOUR + 1);

      expect(await f.account.remainingToken(f.agent.address, f.tokenAddr)).to.equal(USDT(100));
      await expectCode(f, CODE.OK, { target: f.tokenAddr, data: f.xfer(f.payee.address, USDT(100)) });
    });

    it("charges a batch the same as the calls made separately", async function () {
      const f = await loadFixture(deployed);
      const call = (amt) => ({
        target: f.tokenAddr,
        value: 0,
        data: f.xfer(f.payee.address, USDT(amt)),
        intentHash: INTENT,
      });

      await expect(
        f.account.connect(f.agent).executeBatch([call(60), call(50)])
      ).to.be.revertedWithCustomError(f.account, "PolicyViolation").withArgs(CODE.TOKEN_PER_WINDOW);

      await expect(f.account.connect(f.agent).executeBatch([call(60), call(40)])).to.not.be.reverted;
      expect(await f.token.balanceOf(f.payee.address)).to.equal(USDT(100));
    });
  });

  describe("allowances", function () {
    it("refuses an infinite approve", async function () {
      const f = await loadFixture(deployed);
      await expectCode(f, CODE.APPROVAL_TOO_LARGE, {
        target: f.tokenAddr,
        data: f.approve(f.payee.address, MAX_UINT),
      });
    });

    it("allows an approval up to the ceiling and refuses one over it", async function () {
      const f = await loadFixture(deployed);
      await expectCode(f, CODE.OK, {
        target: f.tokenAddr,
        data: f.approve(f.payee.address, USDT(50)),
      });
      await expectCode(f, CODE.APPROVAL_TOO_LARGE, {
        target: f.tokenAddr,
        data: f.approve(f.payee.address, USDT(51)),
      });
    });

    // Regression. The first version of this contract compared
    // increaseAllowance's argument to maxApproval, but that argument is a delta:
    // N permitted calls left N * maxApproval standing, and the README claimed an
    // infinite approve was unreachable. It was reachable by repetition.
    it("refuses increaseAllowance outright -- a ceiling cannot bound a delta", async function () {
      const f = await loadFixture(deployed);
      const inc = (sp, amt) => f.token.interface.encodeFunctionData("increaseAllowance", [sp, amt]);

      await expectCode(f, CODE.DELTA_APPROVAL_UNSUPPORTED, {
        target: f.tokenAddr,
        data: inc(f.payee.address, USDT(1)),
      });

      // The drip that used to work: every call is individually under the
      // ceiling, and together they blow through it.
      for (let i = 0; i < 5; i++) {
        await expectCode(f, CODE.DELTA_APPROVAL_UNSUPPORTED, {
          target: f.tokenAddr,
          data: inc(f.payee.address, USDT(50)),
        });
      }
      expect(await f.token.allowance(f.accountAddr, f.payee.address)).to.equal(0n);
    });

    it("still allows approve(), whose argument is an absolute total", async function () {
      const f = await loadFixture(deployed);
      await expectCode(f, CODE.OK, {
        target: f.tokenAddr,
        data: f.approve(f.payee.address, USDT(50)),
      });
      expect(await f.token.allowance(f.accountAddr, f.payee.address)).to.equal(USDT(50));
    });

    it("refuses an approval to a spender that is not an allowed payee", async function () {
      const f = await loadFixture(deployed);
      await expectCode(f, CODE.PAYEE_NOT_ALLOWED, {
        target: f.tokenAddr,
        data: f.approve(f.stranger.address, USDT(1)),
      });
    });
  });

  describe("no path widens the policy that permits it", function () {
    it("refuses a call from the agent to the account itself", async function () {
      const f = await loadFixture(deployed);
      await f.account.setTargets(f.agent.address, [f.stranger.address], true);
      const data = f.account.interface.encodeFunctionData("setGuardian", [f.agent.address, true]);
      await expectCode(f, CODE.SELF_CALL, { target: f.accountAddr, data });
    });

    it("refuses an escalation routed through an allowlisted contract", async function () {
      const f = await loadFixture(deployed);
      await f.account.setSelectors(
        f.agent.address,
        f.sinkAddr,
        [f.sink.interface.getFunction("escalate").selector],
        true
      );
      const data = f.sink.interface.encodeFunctionData("escalate", [f.accountAddr, f.agent.address]);
      await expect(
        f.account.connect(f.agent).execute(f.sinkAddr, 0, data, INTENT)
      ).to.be.revertedWithCustomError(f.account, "CallFailed");
      expect(await f.account.guardian(f.agent.address)).to.equal(false);
    });

    it("refuses re-entry from a permitted target", async function () {
      const f = await loadFixture(deployed);
      await f.sink.setReenter(f.accountAddr);
      const data = f.sink.interface.encodeFunctionData("reenter", []);
      await expect(
        f.account.connect(f.agent).execute(f.sinkAddr, 0, data, INTENT)
      ).to.be.revertedWithCustomError(f.account, "CallFailed");
      expect(await f.sink.pings()).to.equal(0);
    });

    it("refuses agent access to every owner-only entry point", async function () {
      const f = await loadFixture(deployed);
      const a = f.account.connect(f.agent);
      const p = {
        active: true, tripped: false, requireIntent: false, expiry: 0,
        windowSeconds: HOUR, maxCallsPerWindow: 1000,
        maxNativePerCall: ethers.parseEther("50"), maxNativePerWindow: ethers.parseEther("50"),
      };
      await expect(a.configureAgent(f.agent.address, p)).to.be.revertedWithCustomError(f.account, "NotOwner");
      await expect(a.setTargets(f.agent.address, [f.stranger.address], true)).to.be.revertedWithCustomError(f.account, "NotOwner");
      await expect(a.setPayees(f.agent.address, [f.stranger.address], true)).to.be.revertedWithCustomError(f.account, "NotOwner");
      await expect(a.setGuardian(f.agent.address, true)).to.be.revertedWithCustomError(f.account, "NotOwner");
      await expect(a.ownerExecute(f.tokenAddr, 0, f.xfer(f.stranger.address, USDT(1)))).to.be.revertedWithCustomError(f.account, "NotOwner");
      await expect(a.resetBreaker(f.agent.address)).to.be.revertedWithCustomError(f.account, "NotOwner");
    });
  });

  describe("stopping", function () {
    it("lets a guardian trip the breaker but not clear it", async function () {
      const f = await loadFixture(deployed);
      await expect(f.account.connect(f.guardian).tripBreaker(f.agent.address, ethers.id("anomaly")))
        .to.emit(f.account, "BreakerTripped");

      await expectCode(f, CODE.BREAKER_TRIPPED, {
        target: f.tokenAddr,
        data: f.xfer(f.payee.address, USDT(1)),
      });

      await expect(
        f.account.connect(f.guardian).resetBreaker(f.agent.address)
      ).to.be.revertedWithCustomError(f.account, "NotOwner");

      await f.account.resetBreaker(f.agent.address);
      await expectCode(f, CODE.OK, { target: f.tokenAddr, data: f.xfer(f.payee.address, USDT(1)) });
    });

    it("refuses a guardian seat to a stranger", async function () {
      const f = await loadFixture(deployed);
      await expect(
        f.account.connect(f.stranger).tripBreaker(f.agent.address, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(f.account, "NotGuardian");
    });

    it("does not let a routine limit change clear a tripped breaker", async function () {
      const f = await loadFixture(deployed);
      await f.account.connect(f.guardian).tripBreaker(f.agent.address, ethers.id("anomaly"));
      await f.account.configureAgent(f.agent.address, {
        active: true, tripped: false, requireIntent: true, expiry: 0,
        windowSeconds: HOUR, maxCallsPerWindow: 10,
        maxNativePerCall: ethers.parseEther("1"), maxNativePerWindow: ethers.parseEther("2"),
      });
      await expectCode(f, CODE.BREAKER_TRIPPED, {
        target: f.tokenAddr,
        data: f.xfer(f.payee.address, USDT(1)),
      });
    });

    it("stops a revoked agent", async function () {
      const f = await loadFixture(deployed);
      await f.account.revokeAgent(f.agent.address);
      await expectCode(f, CODE.NOT_AN_AGENT, {
        target: f.tokenAddr,
        data: f.xfer(f.payee.address, USDT(1)),
      });
    });

    it("stops an expired agent", async function () {
      const f = await loadFixture(deployed);
      const now = await time.latest();
      await f.account.configureAgent(f.agent.address, {
        active: true, tripped: false, requireIntent: true, expiry: now + 60,
        windowSeconds: HOUR, maxCallsPerWindow: 10,
        maxNativePerCall: ethers.parseEther("1"), maxNativePerWindow: ethers.parseEther("2"),
      });
      await expectCode(f, CODE.OK, { target: f.tokenAddr, data: f.xfer(f.payee.address, USDT(1)) });
      await time.increase(120);
      await expectCode(f, CODE.AGENT_EXPIRED, {
        target: f.tokenAddr,
        data: f.xfer(f.payee.address, USDT(1)),
      });
    });

    it("requires an intent hash when the policy asks for one", async function () {
      const f = await loadFixture(deployed);
      await expectCode(f, CODE.INTENT_REQUIRED, {
        target: f.tokenAddr,
        data: f.xfer(f.payee.address, USDT(1)),
        intent: NO_INTENT,
      });
    });

    it("refuses the hash of an empty instruction, not just the zero hash", async function () {
      const f = await loadFixture(deployed);
      // keccak256("") looks like a commitment but records nothing.
      await expectCode(f, CODE.INTENT_REQUIRED, {
        target: f.tokenAddr,
        data: f.xfer(f.payee.address, USDT(1)),
        intent: ethers.id(""),
      });
    });
  });

  describe("the owner is not bound by the agent's policy", function () {
    it("lets the owner move funds the agent could not", async function () {
      const f = await loadFixture(deployed);
      await f.account.ownerExecute(f.tokenAddr, 0, f.xfer(f.stranger.address, USDT(500_000)));
      expect(await f.token.balanceOf(f.stranger.address)).to.equal(USDT(500_000));
    });

    it("hands ownership over in two steps", async function () {
      const f = await loadFixture(deployed);
      await f.account.transferOwnership(f.stranger.address);
      expect(await f.account.owner()).to.equal(f.owner.address);
      await f.account.connect(f.stranger).acceptOwnership();
      expect(await f.account.owner()).to.equal(f.stranger.address);
    });
  });

  describe("configuration refuses nonsense", function () {
    it("rejects a zero window, a zero call cap, and a per-call cap above the window cap", async function () {
      const f = await loadFixture(deployed);
      const base = {
        active: true, tripped: false, requireIntent: true, expiry: 0,
        windowSeconds: HOUR, maxCallsPerWindow: 10,
        maxNativePerCall: ethers.parseEther("1"), maxNativePerWindow: ethers.parseEther("2"),
      };
      await expect(
        f.account.configureAgent(f.agent.address, { ...base, windowSeconds: 0 })
      ).to.be.revertedWithCustomError(f.account, "BadConfig");
      await expect(
        f.account.configureAgent(f.agent.address, { ...base, maxCallsPerWindow: 0 })
      ).to.be.revertedWithCustomError(f.account, "BadConfig");
      await expect(
        f.account.configureAgent(f.agent.address, {
          ...base,
          maxNativePerCall: ethers.parseEther("3"),
        })
      ).to.be.revertedWithCustomError(f.account, "BadConfig");
    });

    it("refuses to make the account its own agent or its own target", async function () {
      const f = await loadFixture(deployed);
      const base = {
        active: true, tripped: false, requireIntent: true, expiry: 0,
        windowSeconds: HOUR, maxCallsPerWindow: 10,
        maxNativePerCall: ethers.parseEther("1"), maxNativePerWindow: ethers.parseEther("2"),
      };
      await expect(
        f.account.configureAgent(f.accountAddr, base)
      ).to.be.revertedWithCustomError(f.account, "BadConfig");
      await expect(
        f.account.setTargets(f.agent.address, [f.accountAddr], true)
      ).to.be.revertedWithCustomError(f.account, "BadConfig");
    });
  });
});

describe("ReinFactory", function () {
  it("deploys to the address it predicted", async function () {
    const [owner] = await ethers.getSigners();
    const factory = await ethers.deployContract("ReinFactory");
    const salt = ethers.id("agent-1");
    const predicted = await factory.addressOf(owner.address, salt);
    await factory.createAccount(owner.address, salt);
    expect(await ethers.provider.getCode(predicted)).to.not.equal("0x");
    const account = await ethers.getContractAt("ReinAccount", predicted);
    expect(await account.owner()).to.equal(owner.address);
  });

  it("gives two owners different addresses for the same salt", async function () {
    const [a, b] = await ethers.getSigners();
    const factory = await ethers.deployContract("ReinFactory");
    const salt = ethers.id("agent-1");
    expect(await factory.addressOf(a.address, salt)).to.not.equal(
      await factory.addressOf(b.address, salt)
    );
  });
});
