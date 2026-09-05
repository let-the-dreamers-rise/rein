require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// Any EVM chain works; the bytecode targets the paris EVM so it deploys
// unchanged. Two testnets are configured. Whitechain Sepolia is named for the
// L1 it settles on (Ethereum Sepolia, 11155111); deploying to Ethereum Sepolia
// itself would put nothing there. Chain 1874 is the one that matters for it.
const WHITECHAIN_SEPOLIA = {
  chainId: 1874,
  rpc: "https://rpc.testnet.whitechain.io",
  explorer: "https://explorer.testnet.whitechain.io",
};
const BASE_SEPOLIA = {
  chainId: 84532,
  rpc: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
  explorer: "https://base-sepolia.blockscout.com",
};
// Ethereum Sepolia itself: the L1 the two above settle on. Used to bridge
// faucet ETH down to Base Sepolia and as a deployment target in its own right.
const SEPOLIA = {
  chainId: 11155111,
  rpc: process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com",
  explorer: "https://eth-sepolia.blockscout.com",
};

// Read from the environment and never committed. Nothing in this repo should
// ever contain a key.
const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Paris rather than Cancun: no PUSH0, no transient storage, so the same
      // bytecode deploys unchanged whatever hardfork a chain has reached.
      evmVersion: "paris",
    },
  },
  networks: {
    whitechainSepolia: {
      url: WHITECHAIN_SEPOLIA.rpc,
      chainId: WHITECHAIN_SEPOLIA.chainId,
      accounts,
      // The chain's base fee never drops below 5 gwei.
      gasPrice: 6_000_000_000,
    },
    baseSepolia: {
      url: BASE_SEPOLIA.rpc,
      chainId: BASE_SEPOLIA.chainId,
      accounts,
    },
    sepolia: {
      url: SEPOLIA.rpc,
      chainId: SEPOLIA.chainId,
      accounts,
    },
  },
  etherscan: {
    apiKey: { whitechainSepolia: "blockscout", baseSepolia: "blockscout", sepolia: "blockscout" },
    customChains: [
      {
        network: "whitechainSepolia",
        chainId: WHITECHAIN_SEPOLIA.chainId,
        urls: {
          apiURL: `${WHITECHAIN_SEPOLIA.explorer}/api`,
          browserURL: WHITECHAIN_SEPOLIA.explorer,
        },
      },
      {
        network: "baseSepolia",
        chainId: BASE_SEPOLIA.chainId,
        urls: {
          apiURL: `${BASE_SEPOLIA.explorer}/api`,
          browserURL: BASE_SEPOLIA.explorer,
        },
      },
      {
        network: "sepolia",
        chainId: SEPOLIA.chainId,
        urls: {
          apiURL: `${SEPOLIA.explorer}/api`,
          browserURL: SEPOLIA.explorer,
        },
      },
    ],
  },
  sourcify: { enabled: false },
};
