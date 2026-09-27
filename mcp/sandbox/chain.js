// A whole EVM chain inside the MCP server's own process, for trying Rein with
// nothing: no RPC, no key, no faucet, no compiler.
//
// It is @ethereumjs/vm -- the reference EVM in plain JavaScript -- behind the
// handful of JSON-RPC methods ethers actually sends, so the code above it
// (mcp/lib/account.js, the same code that talks to Base Sepolia) cannot tell
// it is not a real node. Every transaction is mined into its own block the
// moment it arrives, and block time is wall-clock time, so the account's
// rolling windows roll on their own.
//
// It is deliberately small and deliberately not a general node: no logs
// filter, no pending pool, no reorgs. State lives in memory and is gone when
// the process exits.
const { ethers } = require("ethers");
const { createVM, runTx } = require("@ethereumjs/vm");
const { Mainnet, Hardfork, createCustomCommon } = require("@ethereumjs/common");
const { createTxFromRLP } = require("@ethereumjs/tx");
const { createBlock } = require("@ethereumjs/block");
const { createAddressFromString, createAccount, bytesToHex, hexToBytes } = require("@ethereumjs/util");

const CHAIN_ID = 31337;
const BASE_FEE = 1_000_000_000n; // 1 gwei, constant
const BLOCK_GAS_LIMIT = 30_000_000n;
const ZERO_HASH = ethers.ZeroHash;
const EMPTY_BLOOM = `0x${"00".repeat(256)}`;

const hex = (n) => ethers.toQuantity(n);

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

class SandboxChain {
  static async create() {
    const chain = new SandboxChain();
    chain.common = createCustomCommon({ chainId: CHAIN_ID, name: "rein-sandbox" }, Mainnet, {
      hardfork: Hardfork.Shanghai,
    });
    chain.vm = await createVM({ common: chain.common });
    chain.blocks = [chain._block(0, [], 0n)];
    chain.txs = new Map(); // hash -> { tx, receipt }
    return chain;
  }

  // -- state ---------------------------------------------------------------

  async fund(address, wei) {
    const addr = createAddressFromString(address);
    const current = await this.vm.stateManager.getAccount(addr);
    const account = current || createAccount({ nonce: 0n, balance: 0n });
    account.balance += wei;
    await this.vm.stateManager.putAccount(addr, account);
  }

  get head() {
    return this.blocks[this.blocks.length - 1];
  }

  _now() {
    // Monotonic wall-clock seconds: a block may never be older than its parent.
    const now = BigInt(Math.floor(Date.now() / 1000));
    const parent = this.blocks ? this.head.timestamp : 0n;
    return now > parent ? now : parent + 1n;
  }

  _block(number, txHashes, gasUsed) {
    const timestamp = number === 0 ? BigInt(Math.floor(Date.now() / 1000)) : this._now();
    const parentHash = number === 0 ? ZERO_HASH : this.head.hash;
    return {
      number: BigInt(number),
      timestamp,
      parentHash,
      hash: ethers.keccak256(ethers.toUtf8Bytes(`rein-sandbox:${number}:${parentHash}:${timestamp}`)),
      txHashes,
      gasUsed,
    };
  }

  /// The header the EVM sees when it executes something at the tip.
  _header(number, timestamp) {
    return createBlock(
      {
        header: {
          number,
          timestamp,
          gasLimit: BLOCK_GAS_LIMIT,
          baseFeePerGas: BASE_FEE,
          coinbase: "0x0000000000000000000000000000000000000000",
        },
      },
      { common: this.common, skipConsensusFormatValidation: true }
    );
  }

  // -- execution -----------------------------------------------------------

  /// Run a call against the tip without keeping what it did.
  async _dryRun({ from, to, data, value, gas }) {
    const sm = this.vm.stateManager;
    await sm.checkpoint();
    try {
      const block = this._header(this.head.number + 1n, this._now());
      const res = await this.vm.evm.runCall({
        caller: createAddressFromString(from || ethers.ZeroAddress),
        to: to ? createAddressFromString(to) : undefined,
        data: hexToBytes(data || "0x"),
        value: value ? BigInt(value) : 0n,
        gasLimit: gas ? BigInt(gas) : BLOCK_GAS_LIMIT,
        block,
        skipBalance: true,
      });
      return res.execResult;
    } finally {
      await sm.revert();
    }
  }

  _throwIfReverted(exec) {
    if (!exec.exceptionError) return;
    const data = bytesToHex(exec.returnValue || new Uint8Array());
    // The shape a node returns, so ethers decodes PolicyViolation(code) from it.
    throw new RpcError(3, `execution reverted`, data === "0x" ? undefined : data);
  }

  async _mine(raw) {
    const tx = createTxFromRLP(hexToBytes(raw), { common: this.common });
    const number = this.head.number + 1n;
    const timestamp = this._now();
    const block = this._header(number, timestamp);
    const result = await runTx(this.vm, { tx, block, skipBlockGasLimitValidation: true });

    const hash = bytesToHex(tx.hash());
    const mined = this._block(Number(number), [hash], result.totalGasSpent);
    mined.timestamp = timestamp;
    this.blocks.push(mined);

    const logs = (result.receipt.logs || []).map(([address, topics, data], i) => ({
      address: bytesToHex(address),
      topics: topics.map((t) => bytesToHex(t)),
      data: bytesToHex(data),
      logIndex: hex(i),
      blockNumber: hex(number),
      blockHash: mined.hash,
      transactionHash: hash,
      transactionIndex: "0x0",
      removed: false,
    }));

    const from = tx.getSenderAddress().toString();
    const receipt = {
      transactionHash: hash,
      transactionIndex: "0x0",
      blockHash: mined.hash,
      blockNumber: hex(number),
      from,
      to: tx.to ? tx.to.toString() : null,
      contractAddress: result.createdAddress ? result.createdAddress.toString() : null,
      cumulativeGasUsed: hex(result.totalGasSpent),
      gasUsed: hex(result.totalGasSpent),
      effectiveGasPrice: hex(result.amountSpent / (result.totalGasSpent || 1n)),
      logs,
      logsBloom: bytesToHex(result.bloom.bitvector),
      status: result.execResult.exceptionError ? "0x0" : "0x1",
      type: hex(tx.type),
    };
    const json = tx.toJSON();
    const response = {
      ...json,
      hash,
      from,
      blockHash: mined.hash,
      blockNumber: hex(number),
      transactionIndex: "0x0",
      type: hex(tx.type),
      chainId: hex(CHAIN_ID),
      gasPrice: json.gasPrice || json.maxFeePerGas,
    };
    this.txs.set(hash, { receipt, response });
    return hash;
  }

  _blockJson(b) {
    return {
      number: hex(b.number),
      hash: b.hash,
      parentHash: b.parentHash,
      timestamp: hex(b.timestamp),
      nonce: "0x0000000000000000",
      difficulty: "0x0",
      gasLimit: hex(BLOCK_GAS_LIMIT),
      gasUsed: hex(b.gasUsed),
      miner: ethers.ZeroAddress,
      extraData: "0x",
      baseFeePerGas: hex(BASE_FEE),
      logsBloom: EMPTY_BLOOM,
      transactions: b.txHashes,
    };
  }

  _blockAt(tag) {
    if (tag === undefined || tag === "latest" || tag === "pending" || tag === "safe" || tag === "finalized") {
      return this.head;
    }
    if (tag === "earliest") return this.blocks[0];
    return this.blocks[Number(BigInt(tag))] || null;
  }

  // -- JSON-RPC ------------------------------------------------------------

  async request(method, params = []) {
    switch (method) {
      case "eth_chainId":
        return hex(CHAIN_ID);
      case "net_version":
        return String(CHAIN_ID);
      case "eth_blockNumber":
        return hex(this.head.number);
      case "eth_gasPrice":
        return hex(BASE_FEE);
      case "eth_maxPriorityFeePerGas":
        return "0x0";
      case "eth_accounts":
        return [];
      case "eth_getBalance": {
        const a = await this.vm.stateManager.getAccount(createAddressFromString(params[0]));
        return hex(a ? a.balance : 0n);
      }
      case "eth_getTransactionCount": {
        const a = await this.vm.stateManager.getAccount(createAddressFromString(params[0]));
        return hex(a ? a.nonce : 0n);
      }
      case "eth_getCode":
        return bytesToHex(await this.vm.stateManager.getCode(createAddressFromString(params[0])));
      case "eth_getBlockByNumber": {
        const b = this._blockAt(params[0]);
        return b ? this._blockJson(b) : null;
      }
      case "eth_getBlockByHash": {
        const b = this.blocks.find((x) => x.hash === params[0]);
        return b ? this._blockJson(b) : null;
      }
      case "eth_call": {
        const exec = await this._dryRun(params[0]);
        this._throwIfReverted(exec);
        return bytesToHex(exec.returnValue);
      }
      case "eth_estimateGas": {
        const exec = await this._dryRun(params[0]);
        this._throwIfReverted(exec);
        // Intrinsic cost plus what the call used, with room for the refunds
        // and cold reads a dry run does not price the same way.
        return hex(((exec.executionGasUsed + 60_000n) * 13n) / 10n);
      }
      case "eth_sendRawTransaction":
        return this._mine(params[0]);
      case "eth_getTransactionReceipt":
        return this.txs.get(params[0])?.receipt || null;
      case "eth_getTransactionByHash":
        return this.txs.get(params[0])?.response || null;
      case "eth_getLogs":
        return [];
      default:
        throw new RpcError(-32601, `the Rein sandbox chain does not implement ${method}`);
    }
  }
}

/// ethers' own JSON-RPC provider with the transport swapped for the in-process
/// chain, so formatting, retries and error decoding are ethers' and not ours.
class SandboxProvider extends ethers.JsonRpcApiProvider {
  constructor(chain) {
    super(new ethers.Network("rein-sandbox", CHAIN_ID), {
      staticNetwork: true,
      batchMaxCount: 1,
      pollingInterval: 50,
      cacheTimeout: -1,
    });
    this.chain = chain;
  }

  async _send(payload) {
    const out = [];
    for (const { id, method, params } of [].concat(payload)) {
      try {
        out.push({ id, result: await this.chain.request(method, params) });
      } catch (err) {
        out.push({ id, error: { code: err.code ?? -32603, message: err.message, data: err.data } });
      }
    }
    return out;
  }
}

module.exports = { SandboxChain, SandboxProvider, CHAIN_ID };
