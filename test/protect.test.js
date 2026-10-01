// protect(walletClient): Rein in one line for an agent that signs with viem.
const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const { protect, ReinHeld } = require("..");
const guard = require("../scan/guard");
const { sampleFetch, AGENT, PAYEES, USDC } = require("../scan/sample");

const ERC20 = new ethers.Interface(["function transfer(address to, uint256 value)"]);
const ERC20_ABI = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ type: "bool" }] }];
const usdc = (n) => BigInt(Math.round(n * 1e6));
const someone = (label) => ethers.getAddress(ethers.dataSlice(ethers.id(`protect test: ${label}`), 12));

// What viem's wallet client looks like from the outside: an account, a chain,
// and async methods that sign and send.
function fakeClient(address) {
  const sent = [];
  const client = {
    account: { address },
    chain: { id: 8453 },
    sendTransaction: async (tx) => (sent.push(["send", tx]), "0xhash"),
    writeContract: async (call) => (sent.push(["write", call]), "0xhash"),
    signTypedData: async (td) => (sent.push(["sign", td]), "0xsig"),
    getAddresses: async () => [address],
  };
  return { client, sent };
}

const offline = async () => {
  throw new Error("offline");
};

describe("protect(walletClient)", function () {
  this.timeout(60000);
  let env;
  beforeEach(() => {
    env = { REIN_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "rein-protect-")) };
  });

  it("starts a brand-new agent in learning mode: small payments go through and teach it, the rest wait", async () => {
    const me = someone("new agent");
    const { client, sent } = fakeClient(me);
    const wallet = protect(client, { env, fetch: offline });
    const a = someone("a supplier");

    await wallet.sendTransaction({ to: USDC.address, data: ERC20.encodeFunctionData("transfer", [a, usdc(10)]) });
    await wallet.writeContract({ address: USDC.address, abi: ERC20_ABI, functionName: "transfer", args: [a, usdc(12)] });
    expect(sent.map((x) => x[0])).to.deep.equal(["send", "write"]);

    // Too big for an address it has never paid.
    const big = await wallet.sendTransaction({ to: USDC.address, data: ERC20.encodeFunctionData("transfer", [someone("b"), usdc(400)]) }).catch((e) => e);
    expect(big).to.be.instanceOf(ReinHeld);
    expect(big.reason).to.equal("PAYEE_NOT_ALLOWED");
    expect(big.message).to.contain(`npx rein-wallet guard ${me} --allow ${big.held}`);

    // An address dressed up as the supplier's.
    const fake = ethers.getAddress(`0x${a.slice(2, 6)}${"9".repeat(32)}${a.slice(-4)}`.toLowerCase());
    const poisoned = await wallet.sendTransaction({ to: USDC.address, data: ERC20.encodeFunctionData("transfer", [fake, usdc(5)]) }).catch((e) => e);
    expect(poisoned.reason).to.equal("LOOKALIKE_PAYEE");

    // A token it doesn't know is held too, and nothing held was sent.
    const odd = await wallet.sendTransaction({ to: someone("a token"), data: ERC20.encodeFunctionData("transfer", [a, 1n]) }).catch((e) => e);
    expect(odd).to.be.instanceOf(ReinHeld);
    expect(sent).to.have.length(2);

    // Everything else passes straight through.
    expect(await wallet.getAddresses()).to.deep.equal([me]);
  });

  it("checks x402 signatures too", async () => {
    const me = someone("x402 agent");
    const { client, sent } = fakeClient(me);
    const wallet = protect(client, { env, fetch: offline });
    const td = (to, value) => ({
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC.address },
      types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }] },
      primaryType: "TransferWithAuthorization",
      message: { from: me, to, value: String(value) },
    });
    await wallet.signTypedData(td(someone("an api"), usdc(0.5)));
    expect(sent).to.have.length(1);
    // Now a payee it knows, but far over the starter's hour.
    expect(await wallet.signTypedData(td(someone("an api"), usdc(5000))).catch((e) => e.reason)).to.equal("TOKEN_PER_WINDOW");
    expect(await wallet.signTypedData(td(someone("another api"), usdc(30))).catch((e) => e.reason)).to.equal("PAYEE_NOT_ALLOWED");
  });

  it("learns a wallet with history from that history, and a person's --allow lets one held payment through", async () => {
    const { client, sent } = fakeClient(AGENT);
    const wallet = protect(client, { env, fetch: sampleFetch() });
    await wallet.sendTransaction({ to: USDC.address, data: ERC20.encodeFunctionData("transfer", [PAYEES.inference.address, usdc(12)]) });
    expect(sent).to.have.length(1);
    expect(guard.loadGuard(AGENT, env).guard.learning).to.equal(undefined);

    const tx = { to: USDC.address, data: ERC20.encodeFunctionData("transfer", [PAYEES.stranger.address, usdc(500)]) };
    const held = await wallet.sendTransaction(tx).catch((e) => e);
    expect(held).to.be.instanceOf(ReinHeld);
    // What `rein guard 0x… --allow <id>` does once a person confirms at a terminal.
    const { guard: g, file } = guard.loadGuard(AGENT, env);
    guard.decide(g, held.held, "approved");
    guard.saveGuard(g, file);
    await wallet.sendTransaction(tx);
    expect(sent).to.have.length(2);
  });
});
