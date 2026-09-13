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
  "function getIdentityRegistry() view returns (address)",
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
];

function registriesFor(chainId) {
  const entry = GOAT_ERC8004[Number(chainId)];
  if (!entry) throw new Error(`No ERC-8004 registries known for chain ${chainId}. Run on goatTestnet.`);
  return entry;
}

// The reputation registry checks that an agent exists by calling the identity
// registry it was deployed against, so the only identity registry that matters
// is the one it names. On mainnet that is the published 0x8004A169... On
// testnet3 it is 0x54b8...15ce, while agentkit's addresses.ts lists
// 0x5560...5522: registering there and then rating reverts with
// ERC721NonexistentToken(agentId), which is what this resolver avoids.
// Reported upstream; until it is fixed, ask the chain rather than the table.
async function resolveIdentityRegistry(ethers, entry) {
  try {
    const rep = await ethers.getContractAt(REPUTATION_ABI, entry.reputationRegistry);
    const onChain = await rep.getIdentityRegistry();
    if (onChain && onChain !== "0x0000000000000000000000000000000000000000") {
      if (onChain.toLowerCase() !== entry.identityRegistry.toLowerCase()) {
        console.log(`  note      the reputation registry uses identity registry ${onChain},`);
        console.log(`            not the ${entry.identityRegistry} in agentkit's address table`);
      }
      return onChain;
    }
  } catch {
    // older deployment without the getter; fall back to the table
  }
  return entry.identityRegistry;
}

module.exports = { GOAT_ERC8004, IDENTITY_ABI, REPUTATION_ABI, registriesFor, resolveIdentityRegistry };
