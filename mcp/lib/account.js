// Talking to a ReinAccount in the units a person uses, so that the layer above
// this one can be about money and reasons rather than about ABI encoding.
//
// An agent should never have to build calldata to ask whether it is allowed to
// pay someone. Every tool in this server takes a payee, an amount and a reason,
// and the encoding happens here.
const { ethers } = require("ethers");
const { name: codeName, explain: codeExplain } = require("../../scripts/codes");

const ACCOUNT_ABI = [
  "function simulate(address agent, address target, uint256 value, bytes data, bytes32 intentHash) view returns (uint8)",
  "function execute(address target, uint256 value, bytes data, bytes32 intentHash) returns (bytes)",
  "function remainingNative(address agent) view returns (uint256 value, uint256 calls)",
  "function remainingToken(address agent, address token) view returns (uint256)",
  "function policy(address agent) view returns (bool active, bool tripped, bool requireIntent, uint64 expiry, uint32 windowSeconds, uint32 maxCallsPerWindow, uint128 maxNativePerCall, uint128 maxNativePerWindow)",
  "function tokenPolicy(address agent, address token) view returns (bool enabled, uint32 windowSeconds, uint128 maxPerWindow, uint128 maxApproval)",
  "function owner() view returns (address)",
];

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

/// The instruction behind a call is committed to on chain as a hash. Hashing it
/// bare is a mistake we are not repeating here: instructions are short and
/// formulaic ("pay supplier invoice 4471 -- 250 USDT"), so an unsalted keccak is
/// recoverable by anyone willing to enumerate invoice numbers, which turns a
/// commitment into a published payment ledger. A per-account salt makes the
/// commitment binding for the owner (who knows the salt) and meaningless to
/// everyone else.
function intentHash(instruction, salt) {
  if (!instruction) return ethers.ZeroHash;
  return salt
    ? ethers.keccak256(ethers.concat([ethers.toUtf8Bytes(salt), ethers.toUtf8Bytes(instruction)]))
    : ethers.id(instruction);
}

class ReinClient {
  constructor(config) {
    this.config = config;
    // A provider and signer may be handed in directly, which is what the test
    // suite does: it means the money path is exercised against a real deployed
    // account rather than mocked, without standing up an RPC endpoint first.
    this.provider = config.provider || new ethers.JsonRpcProvider(config.rpcUrl);
    this.signer = config.signer || (config.agentKey ? new ethers.Wallet(config.agentKey, this.provider) : null);
    this.agent = config.agentAddress || (this.signer ? this.signer.address : null);
    this.account = new ethers.Contract(config.account, ACCOUNT_ABI, this.provider);
    this.tokens = config.tokens || {};
    this._meta = new Map();
  }

  get readOnly() {
    return this.signer === null;
  }

  /// Accept either a symbol the operator configured or a raw address, so an
  /// agent that only knows "USDC" and one that knows the address both work.
  async token(symbolOrAddress) {
    const key = String(symbolOrAddress || "").trim();
    const address = ethers.isAddress(key) ? ethers.getAddress(key) : this.tokens[key.toUpperCase()];
    if (!address) {
      const known = Object.keys(this.tokens).join(", ") || "none configured";
      throw new Error(`unknown token "${key}". Known symbols: ${known}. An address also works.`);
    }
    if (this._meta.has(address)) return this._meta.get(address);

    const erc20 = new ethers.Contract(address, ERC20_ABI, this.provider);
    const [decimals, symbol] = await Promise.all([
      erc20.decimals().catch(() => 18),
      erc20.symbol().catch(() => key.toUpperCase()),
    ]);
    const meta = { address, symbol, decimals: Number(decimals), erc20 };
    this._meta.set(address, meta);
    return meta;
  }

  /// A refusal, in the words the contract would use, plus what is left. The
  /// remaining budget is included on every refusal on purpose: an agent told
  /// only "no" retries, and an agent told "no, and you have 350 left this hour"
  /// can decide to pay less or to wait.
  async check({ payee, amount, token, because }) {
    const t = await this.token(token);
    const raw = ethers.parseUnits(String(amount), t.decimals);
    const data = t.erc20.interface.encodeFunctionData("transfer", [payee, raw]);
    const code = Number(
      await this.account.simulate(this.agent, t.address, 0, data, intentHash(because, this.config.intentSalt))
    );

    const remaining = await this.account.remainingToken(this.agent, t.address);
    return {
      allowed: code === 0,
      code,
      reason: codeName(code),
      explanation: code === 0 ? "the policy permits this payment" : codeExplain(code),
      payee,
      amount: String(amount),
      token: t.symbol,
      remainingThisWindow: ethers.formatUnits(remaining, t.decimals),
      costOfThisCheck: "none -- simulate() is a free view call, no gas was spent",
    };
  }

  async pay({ payee, amount, token, because }) {
    if (this.readOnly) {
      throw new Error(
        "this server is running read-only: no agent key is configured, so it can check payments but not make them. Set REIN_AGENT_PRIVATE_KEY to enable rein_pay."
      );
    }
    const verdict = await this.check({ payee, amount, token, because });
    if (!verdict.allowed) return { ...verdict, paid: false, txHash: null };

    const t = await this.token(token);
    const raw = ethers.parseUnits(String(amount), t.decimals);
    const data = t.erc20.interface.encodeFunctionData("transfer", [payee, raw]);
    const tx = await this.account
      .connect(this.signer)
      .execute(t.address, 0, data, intentHash(because, this.config.intentSalt));
    const receipt = await tx.wait();

    const remaining = await this.account.remainingToken(this.agent, t.address);
    return {
      ...verdict,
      paid: true,
      txHash: receipt.hash,
      remainingThisWindow: ethers.formatUnits(remaining, t.decimals),
    };
  }

  async budget() {
    const p = await this.account.policy(this.agent);
    const [nativeValue, calls] = await this.account.remainingNative(this.agent);

    const perToken = {};
    for (const symbol of Object.keys(this.tokens)) {
      const t = await this.token(symbol);
      const [tp, remaining, held] = await Promise.all([
        this.account.tokenPolicy(this.agent, t.address),
        this.account.remainingToken(this.agent, t.address),
        t.erc20.balanceOf(this.config.account).catch(() => 0n),
      ]);
      if (!tp.enabled) continue;
      perToken[t.symbol] = {
        remainingThisWindow: ethers.formatUnits(remaining, t.decimals),
        ceilingPerWindow: ethers.formatUnits(tp.maxPerWindow, t.decimals),
        windowSeconds: Number(tp.windowSeconds),
        accountHolds: ethers.formatUnits(held, t.decimals),
      };
    }

    return {
      agent: this.agent,
      account: this.config.account,
      active: p.active,
      stoppedByGuardian: p.tripped,
      expiresAt: Number(p.expiry) === 0 ? "never" : new Date(Number(p.expiry) * 1000).toISOString(),
      callsLeftThisWindow: Number(calls),
      windowSeconds: Number(p.windowSeconds),
      nativeRemaining: ethers.formatEther(nativeValue),
      tokens: perToken,
      mustStateAReason: p.requireIntent,
    };
  }

  /// What is readable from chain, and an honest note about what is not.
  /// Allowlists live in mappings, which cannot be enumerated, so this does not
  /// pretend to list them. The compiled policy file is where the sentences are.
  async policy() {
    const b = await this.budget();
    return {
      ...b,
      note:
        "Target, selector and payee allowlists are stored as mappings and cannot be listed from chain. " +
        "Use rein_check_payment to find out whether a specific payee is allowed -- it is free and costs no gas. " +
        "The human-readable compiled policy, if this account has one, is v2/out/policy.md in the Rein repo.",
    };
  }
}

module.exports = { ReinClient, intentHash, ACCOUNT_ABI, ERC20_ABI };
