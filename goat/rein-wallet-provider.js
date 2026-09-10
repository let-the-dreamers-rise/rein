// A WalletProvider for @goatnetwork/agentkit whose every write goes through a
// ReinAccount. AgentKit actions (x402 payment.transfer, erc8004.give_feedback,
// and the rest) run unchanged; the account decides whether each call is
// within policy before it is sent, and refuses on chain if it is not.
//
// The agent key signs. The account holds the funds. The policy lives in the
// contract, so a compromised agent process still cannot exceed it.
//
//   const wallet = new ReinWalletProvider({ agentSigner, provider, accountAddress });
//   wallet.setIntent("pay seller for one API call");
//   await wallet.transferNative(seller, amountWei);
//
// signTypedData is refused: a smart account cannot produce an EOA signature,
// so the EIP-712 x402 flow does not apply here. Use x402 payment.transfer.
const { Contract, Interface, ZeroHash, id: keccakId } = require("ethers");

const REIN_ABI = [
  "function simulate(address agent, address target, uint256 value, bytes data, bytes32 intentHash) view returns (uint8)",
  "function execute(address target, uint256 value, bytes data, bytes32 intentHash) returns (bytes)",
  "error PolicyViolation(uint8 code)",
];
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function approve(address spender, uint256 value) returns (bool)",
];
const CODES = [
  "OK", "NOT_AN_AGENT", "AGENT_EXPIRED", "BREAKER_TRIPPED", "SELF_CALL", "TARGET_NOT_ALLOWED",
  "SELECTOR_NOT_ALLOWED", "NATIVE_PER_CALL", "NATIVE_PER_WINDOW", "CALL_RATE", "TOKEN_NOT_ALLOWED",
  "TOKEN_PER_WINDOW", "APPROVAL_TOO_LARGE", "PAYEE_NOT_ALLOWED", "INTENT_REQUIRED", "DELTA_APPROVAL_UNSUPPORTED",
];

class ReinRefusal extends Error {
  constructor(code, target) {
    super(`Rein refused: ${CODES[code] ?? code} (target ${target})`);
    this.name = "ReinRefusal";
    this.code = code;
    this.reason = CODES[code] ?? String(code);
  }
}

class ReinWalletProvider {
  constructor({ agentSigner, provider, accountAddress, networkName = "goat-testnet" }) {
    if (!agentSigner || !provider || !accountAddress) {
      throw new Error("ReinWalletProvider needs agentSigner, provider and accountAddress");
    }
    this.signer = agentSigner;
    this.provider = provider;
    this.accountAddress = accountAddress;
    this.networkName = networkName;
    this.account = new Contract(accountAddress, REIN_ABI, agentSigner);
    this.intentHash = ZeroHash;
  }

  // Record the instruction the next call acts on. Policies with requireIntent
  // refuse calls that carry none.
  setIntent(text) {
    this.intentHash = text ? keccakId(text) : ZeroHash;
    return this;
  }

  async getAddress() { return this.accountAddress; }
  async getAgentAddress() { return this.signer.getAddress(); }
  async getNetwork() { return this.networkName; }
  async getChainId() { return Number((await this.provider.getNetwork()).chainId); }

  async getBalance(address) {
    return (await this.provider.getBalance(address ?? this.accountAddress)).toString();
  }

  async getErc20Balance(tokenAddress, owner) {
    const token = new Contract(tokenAddress, ERC20_ABI, this.provider);
    return (await token.balanceOf(owner ?? this.accountAddress)).toString();
  }

  async callContract(contractAddress, abi, functionName, args) {
    return new Contract(contractAddress, abi, this.provider)[functionName](...args);
  }

  // Every write funnels through here: ask first, then act.
  async _execute(target, value, data, options = {}) {
    const agent = await this.signer.getAddress();
    const code = Number(await this.account.simulate(agent, target, value, data, this.intentHash));
    if (code !== 0) throw new ReinRefusal(code, target);
    const tx = await this.account.execute(target, value, data, this.intentHash);
    if (options.signal?.aborted) throw new Error("Operation aborted");
    const receipt = await tx.wait();
    return { txHash: receipt?.hash ?? tx.hash };
  }

  async transferNative(to, amountWei, options) {
    return this._execute(to, BigInt(amountWei), "0x", options);
  }

  async transferErc20(tokenAddress, to, amount, options) {
    const data = new Interface(ERC20_ABI).encodeFunctionData("transfer", [to, BigInt(amount)]);
    return this._execute(tokenAddress, 0n, data, options);
  }

  async approveErc20(tokenAddress, spender, amount, options) {
    const data = new Interface(ERC20_ABI).encodeFunctionData("approve", [spender, BigInt(amount)]);
    return this._execute(tokenAddress, 0n, data, options);
  }

  async writeContract(contractAddress, abi, functionName, args, value, options) {
    const data = new Interface(abi).encodeFunctionData(functionName, args);
    return this._execute(contractAddress, value ? BigInt(value) : 0n, data, options);
  }

  async signTypedData() {
    throw new Error("ReinWalletProvider cannot sign typed data: the payer is a contract. Use x402 payment.transfer.");
  }

  async deployContract() {
    throw new Error("ReinWalletProvider does not deploy contracts: an agent key is scoped to allowlisted targets.");
  }
}

module.exports = { ReinWalletProvider, ReinRefusal, REIN_CODES: CODES };
