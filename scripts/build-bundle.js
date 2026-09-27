// Builds the MCP server into one file that runs on a bare `node`, and packs
// it for the two places people install MCP servers from:
//
//   plugin/server/rein-mcp.cjs   the server, ethers and the sandbox EVM in one
//                                file. No npm install, no node_modules.
//   plugin/                      a Claude Code plugin around it
//   dist/rein.mcpb               a Claude Desktop extension around it
//
// The readable source is mcp/; this is the same code, bundled. CI rebuilds
// both outputs and fails if they differ from what is committed, so the file a
// reviewer installs is always the file this repo's source produces.
//
//   node scripts/build-bundle.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const esbuild = require("esbuild");

const ROOT = path.join(__dirname, "..");
const PLUGIN = path.join(ROOT, "plugin");
const SERVER = path.join(PLUGIN, "server", "rein-mcp.cjs");
const MCPB = path.join(ROOT, "dist", "rein.mcpb");
const VERSION = require(path.join(ROOT, "package.json")).version;

async function bundle() {
  await esbuild.build({
    entryPoints: [path.join(ROOT, "mcp", "rein-mcp.js")],
    outfile: SERVER,
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    minify: true,
    // Keep every dependency's licence notice in the file that ships it.
    legalComments: "eof",
    banner: {
      // esbuild carries the entry file's shebang above this on its own.
      js:
        "// Rein MCP server, bundled from mcp/ in github.com/let-the-dreamers-rise/rein by scripts/build-bundle.js.\n" +
        "// Run with --sandbox to try it with nothing configured. Read the source there, not here.",
    },
    logLevel: "warning",
  });
  fs.chmodSync(SERVER, 0o755);
}

// -- .mcpb -----------------------------------------------------------------
//
// An .mcpb is a zip with manifest.json at its root. Written by hand, stored
// rather than deflated, with a fixed timestamp, so the same inputs give the
// same bytes on every machine and CI can diff it.

function manifest() {
  return {
    manifest_version: "0.3",
    name: "rein",
    display_name: "Rein",
    version: VERSION,
    description: "A wallet your agent can operate and cannot drain. Try it in a sandbox with a funded account and nothing to configure.",
    long_description:
      "Rein is a smart account for AI agents: the owner writes a spending policy, the chain enforces it, and a refusal is a free " +
      "view call that returns the reason before any gas is spent. This extension runs Rein's sandbox: a private EVM chain inside " +
      "the extension with an account holding 50,000 test USDC that may pay two suppliers up to 1,000 an hour. Ask Claude to pay " +
      "an invoice, then try to talk it into draining the account. No keys, no wallet, no real money.",
    author: { name: "Ashwin Goyal", url: "https://github.com/let-the-dreamers-rise" },
    homepage: "https://rein-nine.vercel.app",
    repository: { type: "git", url: "https://github.com/let-the-dreamers-rise/rein" },
    license: "MIT",
    keywords: ["wallet", "agents", "payments", "policy", "ethereum"],
    server: {
      type: "node",
      entry_point: "server/rein-mcp.cjs",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/rein-mcp.cjs", "--sandbox"],
      },
    },
    tools: [
      { name: "rein_about", description: "Which account, which network, who may be paid, and the limits." },
      { name: "rein_check_payment", description: "May I pay this? Free, no gas, returns the reason and the budget left." },
      { name: "rein_pay", description: "Pay, recording the instruction behind it. Refuses rather than failing." },
      { name: "rein_budget", description: "What is still spendable this window." },
      { name: "rein_policy", description: "The policy in force, in words." },
      { name: "rein_scan_wallet", description: "Any agent wallet's public history in, its compiled policy and drain exposure out." },
      { name: "rein_explain_refusal", description: "A refusal code in plain English." },
    ],
    compatibility: { runtimes: { node: ">=18.0.0" } },
  };
}

function zipStored(files) {
  const DOS_TIME = 0; // 00:00:00
  const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1; // 2026-01-01
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by: unix, 3.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

async function main() {
  if (typeof zlib.crc32 !== "function") {
    console.error("build-bundle: needs Node 20.15 or newer (zlib.crc32).");
    process.exit(1);
  }
  await bundle();
  const files = [
    ["manifest.json", Buffer.from(`${JSON.stringify(manifest(), null, 2)}\n`)],
    ["server/rein-mcp.cjs", fs.readFileSync(SERVER)],
    ["LICENSE", fs.readFileSync(path.join(ROOT, "LICENSE"))],
  ];
  fs.writeFileSync(MCPB, zipStored(files));
  for (const f of [SERVER, MCPB]) {
    console.log(`wrote ${path.relative(ROOT, f)} (${(fs.statSync(f).size / 1024 / 1024).toFixed(1)} MB)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
