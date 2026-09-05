// Moves testnet ETH from Ethereum Sepolia to Base Sepolia through Base's own
// OptimismPortal. Sending plain ETH to the portal is a deposit: the same
// address receives it on L2 a minute or two later. Address from
// docs.base.org/base-chain/network-information/base-contracts (Base Sepolia).
//
//   AMOUNT=0.03 npm run bridge:base
const { ethers, network } = require("hardhat");

const BASE_SEPOLIA_PORTAL = "0x49f53e41452C74589E85cA1677426Ba426459e85";
const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";

async function main() {
  if (network.name !== "sepolia") throw new Error(`Run this on --network sepolia, not ${network.name}`);
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No signer. Set PRIVATE_KEY in .env first.");

  const amount = ethers.parseEther(process.env.AMOUNT || "0.03");
  const bal = await ethers.provider.getBalance(signer.address);
  console.log(`\n  from     ${signer.address}`);
  console.log(`  balance  ${ethers.formatEther(bal)} ETH on Sepolia`);
  console.log(`  bridging ${ethers.formatEther(amount)} ETH to Base Sepolia via portal ${BASE_SEPOLIA_PORTAL}\n`);
  if (bal <= amount) throw new Error("Not enough Sepolia ETH to bridge that amount and pay gas.");

  const l2 = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC);
  const before = await l2.getBalance(signer.address);

  const tx = await signer.sendTransaction({ to: BASE_SEPOLIA_PORTAL, value: amount });
  console.log(`  L1 tx    ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  mined    block ${receipt.blockNumber}, status ${receipt.status}\n`);

  console.log("  waiting for the deposit to land on Base Sepolia (usually 1-3 minutes)...");
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const now = await l2.getBalance(signer.address);
    if (now > before) {
      console.log(`  arrived  ${ethers.formatEther(now)} ETH on Base Sepolia\n`);
      return;
    }
    await new Promise((r) => setTimeout(r, 20000));
  }
  console.log("  not visible after 15 minutes; check the portal deposit on the explorer before retrying.\n");
  process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
