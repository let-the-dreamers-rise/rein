// ERC-8004 registry addresses on GOAT Network, as published in
// GOATNetwork/agentkit plugins/erc8004/addresses.ts. Mainnet contracts are
// CREATE2-deployed at deterministic 0x8004... addresses.
const GOAT_ERC8004 = {
  48816: {
    name: "goat-testnet",
    explorer: "https://explorer.testnet3.goat.network",
    identityRegistry: "0x556089008Fc0a60cD09390Eca93477ca254A5522",
    reputationRegistry: "0xd9140951d8aE6E5F625a02F5908535e16e3af964",
  },
  2345: {
    name: "goat-mainnet",
    explorer: "https://explorer.goat.network",
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
  },
};

// Only the functions this project calls. Full ABIs live in
// erc-8004/erc-8004-contracts on GitHub.
const IDENTITY_ABI = [
  "function register(string agentURI) returns (uint256 agentId)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function isAuthorizedOrOwner(address spender, uint256 agentId) view returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

const REPUTATION_ABI = [
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function getClients(uint256 agentId) view returns (address[])",
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
];

function registriesFor(chainId) {
  const entry = GOAT_ERC8004[Number(chainId)];
  if (!entry) throw new Error(`No ERC-8004 registries known for chain ${chainId}. Run on goatTestnet.`);
  return entry;
}

module.exports = { GOAT_ERC8004, IDENTITY_ABI, REPUTATION_ABI, registriesFor };
