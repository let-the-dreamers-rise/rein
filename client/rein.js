// The pattern an agent should use with a ReinAccount: ask simulate() first,
// act only on OK, and turn a refusal into words the agent can reason about.
// simulate() is a free view call that returns the exact code execute() would
// revert with, so a refusal costs nothing and never teaches the agent a
// different lesson from the chain.
//
//   const rein = require("./client/rein");
//   const why = rein.intent("pay supplier invoice 4471");
//   const verdict = await rein.check(account, agent.address, usdt, 0n, data, why);
//   if (!verdict.ok) return abstain(verdict.why);            // no gas spent
//   const { tx } = await rein.act(account, agentSigner, usdt, 0n, data, why);
//
// `account` is an ethers Contract for ReinAccount (any ABI that includes
// simulate and execute); `agentSigner` is the agent's key, which pays gas.
const { id, ZeroHash } = require("ethers");
const { name, explain } = require("../scripts/codes");

// The intent hash the account records on every call: keccak of the
// instruction the agent is acting on. An empty instruction hashes to zero,
// which the account refuses when intents are required.
const intent = (instruction) => (instruction ? id(instruction) : ZeroHash);

async function check(account, agent, target, value, data, intentHash) {
  const code = Number(await account.simulate(agent, target, value, data, intentHash));
  return { ok: code === 0, code, name: name(code), why: explain(code) };
}

async function act(account, signer, target, value, data, intentHash) {
  const verdict = await check(account, signer.address, target, value, data, intentHash);
  if (!verdict.ok) return { ...verdict, tx: null };
  const receipt = await (await account.connect(signer).execute(target, value, data, intentHash)).wait();
  return { ...verdict, tx: receipt.hash };
}

module.exports = { intent, check, act };
