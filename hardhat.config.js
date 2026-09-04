require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// Whitechain Sepolia is Whitechain's testnet. It is named for the L1 it settles
// on (Ethereum Sepolia, 11155111) -- deploying to Ethereum Sepolia itself would
// put nothing on Whitechain. Chain 1874 is the one that matters here.
const WHITECHAIN_SEPOLIA = {
  chainId: 1874,
  rpc: "https://rpc.testnet.whitechain.io",
  explorer: "https://explorer.testnet.whitechain.io",
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
  },
  etherscan: {
    apiKey: { whitechainSepolia: "blockscout" },
    customChains: [
      {
        network: "whitechainSepolia",
        chainId: WHITECHAIN_SEPOLIA.chainId,
        urls: {
          apiURL: `${WHITECHAIN_SEPOLIA.explorer}/api`,
          browserURL: WHITECHAIN_SEPOLIA.explorer,
        },
      },
    ],
  },
  sourcify: { enabled: false },
};
