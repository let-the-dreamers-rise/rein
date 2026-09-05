// Checks everything that has to be true before a deployment, and says which
// one failed rather than dying inside a provider call.
const { ethers, network } = require("hardhat");

// Each configured live network and the chain id it must answer with.
const EXPECTED = {
  // minBalance is what a deploy plus the demo actually costs on that chain, not
  // a round number: Whitechain has a 5 gwei floor, Base Sepolia charges 0.006.
  whitechainSepolia: { chainId: 1874n, label: "Whitechain Sepolia", minBalance: "0.05", faucet: "the Whitechain testnet faucet" },
  baseSepolia: { chainId: 84532n, label: "Base Sepolia", minBalance: "0.005", faucet: "a Base Sepolia faucet (Coinbase, Alchemy), or bridge from Sepolia with npm run bridge:base" },
  sepolia: { chainId: 11155111n, label: "Ethereum Sepolia", minBalance: "0.05", faucet: "a Sepolia faucet (Google Cloud, Alchemy)" },
};

async function main() {
  let failures = 0;
  const check = (ok, label, detail) => {
    console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
    if (!ok) failures++;
  };

  console.log(`\nPreflight -- network "${network.name}"\n`);

  const expected = EXPECTED[network.name];
  const net = await ethers.provider.getNetwork();
  const chainOk = !expected || net.chainId === expected.chainId;
  check(
    chainOk,
    "chain id",
    `${net.chainId}${chainOk && expected ? ` (${expected.label})` : ""}`
  );

  const head = await ethers.provider.getBlockNumber();
  check(head > 0, "rpc reachable", `head block ${head.toLocaleString()}`);

  const fee = await ethers.provider.getFeeData();
  const gwei = fee.gasPrice ? Number(fee.gasPrice) / 1e9 : 0;
  check(gwei > 0, "gas price", `${gwei.toFixed(3)} gwei`);

  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    check(false, "signer", "no PRIVATE_KEY in the environment -- copy .env.example to .env");
  } else {
    const me = signers[0];
    const bal = await ethers.provider.getBalance(me.address);
    const min = ethers.parseEther(expected ? expected.minBalance : "0.05");
    check(true, "signer", me.address);
    check(
      bal >= min,
      "balance",
      `${ethers.formatEther(bal)} native${bal >= min ? "" : ` -- need ${ethers.formatEther(min)}, fund from ${expected ? expected.faucet : "a faucet"}`}`
    );
  }

  console.log(
    failures === 0
      ? "\nReady to deploy.\n"
      : `\n${failures} check(s) failed. Fix those before deploying.\n`
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
