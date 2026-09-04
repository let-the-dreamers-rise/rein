// Checks everything that has to be true before a deployment, and says which
// one failed rather than dying inside a provider call.
const { ethers, network } = require("hardhat");

const EXPECTED_CHAIN_ID = 1874n;

async function main() {
  let failures = 0;
  const check = (ok, label, detail) => {
    console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
    if (!ok) failures++;
  };

  console.log(`\nPreflight -- network "${network.name}"\n`);

  const net = await ethers.provider.getNetwork();
  check(
    network.name !== "whitechainSepolia" || net.chainId === EXPECTED_CHAIN_ID,
    "chain id",
    `${net.chainId}${net.chainId === EXPECTED_CHAIN_ID ? " (Whitechain Sepolia)" : ""}`
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
      `${ethers.formatEther(bal)} WBT${bal > ethers.parseEther("0.05") ? "" : " -- fund from the Whitechain testnet faucet"}`
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
