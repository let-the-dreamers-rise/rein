// Mirror of contracts/ReinCodes.sol, for printing refusals in plain words.
const NAMES = [
  "OK",
  "NOT_AN_AGENT",
  "AGENT_EXPIRED",
  "BREAKER_TRIPPED",
  "SELF_CALL",
  "TARGET_NOT_ALLOWED",
  "SELECTOR_NOT_ALLOWED",
  "NATIVE_PER_CALL",
  "NATIVE_PER_WINDOW",
  "CALL_RATE",
  "TOKEN_NOT_ALLOWED",
  "TOKEN_PER_WINDOW",
  "APPROVAL_TOO_LARGE",
  "PAYEE_NOT_ALLOWED",
  "INTENT_REQUIRED",
  "DELTA_APPROVAL_UNSUPPORTED",
  // v3 only: refusals that come from what a call did, not what it said.
  "UNMETERED_CALL",
  "OUTFLOW_EXCEEDED",
  "ALLOWANCE_STANDING",
  "RETURNDATA_TOO_LARGE",
  "AUTHORIZATION_NOT_APPROVED",
  "GUARDIAN_COOLDOWN",
];

const EXPLAIN = {
  NOT_AN_AGENT: "this key is not authorized on the account",
  AGENT_EXPIRED: "the key's authorization has lapsed",
  BREAKER_TRIPPED: "a guardian has stopped this agent",
  SELF_CALL: "an agent may not call the account that authorizes it",
  TARGET_NOT_ALLOWED: "that contract is not on the agent's allowlist",
  SELECTOR_NOT_ALLOWED: "that function is not on the agent's allowlist",
  NATIVE_PER_CALL: "more native value than one call may carry",
  NATIVE_PER_WINDOW: "more native value than remains in this window",
  CALL_RATE: "the agent has used its calls for this window",
  TOKEN_NOT_ALLOWED: "no spending ceiling is set for this token",
  TOKEN_PER_WINDOW: "more of this token than remains in this window",
  APPROVAL_TOO_LARGE: "an allowance above the ceiling the owner set",
  PAYEE_NOT_ALLOWED: "that recipient is not on the agent's payee list",
  INTENT_REQUIRED: "the call carries no record of the instruction behind it",
  DELTA_APPROVAL_UNSUPPORTED:
    "increaseAllowance raises an allowance by a delta, which no ceiling can bound -- use approve() with an exact total",
  UNMETERED_CALL: "a call the policy cannot read, with no metered token to bound what it moves",
  OUTFLOW_EXCEEDED: "more value left the account than remains in this window, so the call was undone",
  ALLOWANCE_STANDING: "the call left an allowance to a watched spender above the owner's ceiling",
  RETURNDATA_TOO_LARGE: "the target returned more data than the account will copy",
  AUTHORIZATION_NOT_APPROVED: "a signed transfer authorization the policy never approved",
  GUARDIAN_COOLDOWN: "a guardian stopped this agent too recently to stop it again",
};

const name = (code) => NAMES[Number(code)] ?? `UNKNOWN(${code})`;
const explain = (code) => EXPLAIN[name(code)] ?? "";

module.exports = { NAMES, name, explain };
