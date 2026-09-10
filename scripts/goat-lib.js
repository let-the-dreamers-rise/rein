// Shared helpers for the GOAT scripts: actors, the ask-then-act attempt loop,
// and the read-visibility wait. Kept apart from demo-injection.js so that
// script stays a single readable story.
const { ethers } = require("hardhat");
const { name, explain } = require("./codes");

const hash = (s) => ethers.id(s);

const rule = (t = "") =>
  console.log(`\n${t ? `-- ${t} ` : ""}${"-".repeat(Math.max(0, 74 - (t ? t.length + 4 : 0)))}\n`);

// One funded key on a live chain; the other roles are derived from fixed
// labels. Demo keys: computable by anyone reading this file, given gas dust only.
async function actors(gasEach) {
  const signers = await ethers.getSigners();
  if (signers.length === 0) throw new Error("No signer. Set PRIVATE_KEY in .env first.");
  const owner = signers[0];
  const derive = (label) => new ethers.Wallet(hash(`rein/goat/${label}`), ethers.provider);
  const roles = { agent: derive("agent"), seller: derive("seller"), attacker: derive("attacker") };

  for (const who of ["agent", "seller"]) {
    const w = roles[who];
    if ((await ethers.provider.getBalance(w.address)) < gasEach) {
      console.log(`  funding the ${who} key with ${ethers.formatEther(gasEach)} BTC of gas...`);
      await (await owner.sendTransaction({ to: w.address, value: gasEach })).wait();
    }
  }
  return { owner, ...roles };
}

// Ask the account whether the action is covered; only then act. A refusal
// arrives before any gas is spent, and forcing it reverts with the same code.
async function attempt(account, agent, { target, value = 0n, data = "0x", intent }) {
  const intentHash = intent ? hash(intent) : ethers.ZeroHash;
  const code = Number(await account.simulate(agent.address, target, value, data, intentHash));
  console.log(`  agent  "${intent || "(no instruction recorded)"}"`);

  if (code !== 0) {
    console.log(`  chain  REFUSED  ${name(code)} -- ${explain(code)}`);
    try {
      await account.connect(agent).execute.staticCall(target, value, data, intentHash);
      console.log("  chain  INCONSISTENT: simulate refused but execute would allow");
      process.exitCode = 1;
    } catch (e) {
      const parsed = account.interface.parseError(e.data ?? e?.info?.error?.data ?? "0x");
      const forced = parsed && parsed.name === "PolicyViolation" ? name(parsed.args[0]) : "reverted";
      console.log(`  chain  forcing it anyway reverts: ${forced}`);
    }
    console.log("");
    return null;
  }

  const tx = await account.connect(agent).execute(target, value, data, intentHash);
  const receipt = await tx.wait();
  console.log(`  chain  ALLOWED   tx ${receipt.hash}\n`);
  return receipt;
}

// Public RPCs are load-balanced; a read can land on a node behind the write.
async function waitUntil(check, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try {
      if (await check()) return true;
    } catch {
      // node behind the write
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

module.exports = { hash, rule, actors, attempt, waitUntil };
