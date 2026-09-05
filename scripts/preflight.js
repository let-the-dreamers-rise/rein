// Checks everything that has to be true before a deployment, and says which
// one failed rather than dying inside a provider call.
const { ethers, network } = require("hardhat");

// Each configured live network and the chain id it must answer with.
const EXPECTED = {
  whitechainSepolia: { chainId: 1874n, label: "Whitechain Sepolia", faucet: "the Whitechain testnet faucet" },
  baseSepolia: { chainId: 84532n, label: "Base Sepolia", faucet: "a Base Sepolia faucet (Coinbase, Alchemy)" },
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
    check(true, "signer", me.address);
    check(
      bal > ethers.parseEther("0.05"),
      "balance",
      `${ethers.formatEther(bal)} native${bal > ethers.parseEther("0.05") ? "" : ` -- fund from ${expected ? expected.faucet : "a faucet"}`}`
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
