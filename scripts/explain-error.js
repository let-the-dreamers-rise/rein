// The three failures a first run on a live chain actually hits, in words,
// with the command that diagnoses them. Everything else is printed as is.
function explainError(e) {
  const msg = String((e && e.message) || e);
  if (/insufficient funds|gas required exceeds|exceeds the balance/i.test(msg)) {
    return "the signer has no gas on this chain. Run the matching `npm run preflight:<chain>`; it names the faucet.";
  }
  if (/could not detect network|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timeout|failed to fetch|502|503/i.test(msg)) {
    return "the RPC did not answer. Check the network name and your connection; `npm run preflight:<chain>` tests the RPC first.";
  }
  if (/No signer|PRIVATE_KEY/i.test(msg)) {
    return "no signer: copy .env.example to .env and set PRIVATE_KEY to a throwaway key with testnet gas.";
  }
  return null;
}

function exitWith(e) {
  const why = explainError(e);
  if (why) console.error(`\n  ${why}\n`);
  else console.error(e);
  process.exitCode = 1;
}

module.exports = { explainError, exitWith };
