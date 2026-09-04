const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer. Set PRIVATE_KEY in .env first.");

  console.log(`\nDeploying to "${network.name}" as ${deployer.address}\n`);

  const factory = await ethers.deployContract("ReinFactory");
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log(`  ReinFactory   ${factoryAddr}`);

  // One account for the deployer, at an address anyone could have computed in
  // advance -- which is the point: you can show a user where to send funds
  // before the account exists.
  const salt = ethers.id("rein/v1/default");
  const predicted = await factory.addressOf(deployer.address, salt);
  const tx = await factory.createAccount(deployer.address, salt);
  const receipt = await tx.wait();
  console.log(`  ReinAccount   ${predicted}  (predicted, then deployed)`);
  console.log(`  tx            ${receipt.hash}`);

  const record = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    factory: factoryAddr,
    account: predicted,
    salt,
    deployTx: receipt.hash,
    deployedAt: new Date().toISOString(),
  };

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\n  wrote ${path.relative(process.cwd(), file)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
