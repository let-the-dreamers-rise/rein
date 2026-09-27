// Writes the two contracts the sandbox deploys -- ReinAccountV3 and the mock
// token -- as ABI plus creation bytecode into mcp/sandbox/contracts.json.
//
// That file is committed so the MCP server can start its own chain with no
// compiler, no download and no hardhat: the bytecode a reviewer runs is the
// bytecode `npx hardhat compile` produces from contracts/, and CI regenerates
// it and fails if the two ever differ.
//
//   npx hardhat compile && node scripts/build-sandbox.js
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WANTED = {
  ReinAccountV3: "contracts/ReinAccountV3.sol/ReinAccountV3.json",
  MockERC20: "contracts/test/MockERC20.sol/MockERC20.json",
};

const out = {};
for (const [name, rel] of Object.entries(WANTED)) {
  const file = path.join(ROOT, "artifacts", rel);
  if (!fs.existsSync(file)) {
    console.error(`build-sandbox: ${rel} is missing. Run \`npx hardhat compile\` first.`);
    process.exit(1);
  }
  const { abi, bytecode } = JSON.parse(fs.readFileSync(file, "utf8"));
  out[name] = { abi, bytecode };
}

const dest = path.join(ROOT, "mcp", "sandbox", "contracts.json");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, `${JSON.stringify(out)}\n`);
console.log(`wrote ${path.relative(ROOT, dest)} (${Object.keys(out).join(", ")})`);
