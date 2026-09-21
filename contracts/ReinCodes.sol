// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ReinCodes
/// @notice The single enumeration of every reason Rein refuses a call.
/// @dev `simulate()` returns one of these and `execute()` reverts with
///      `PolicyViolation(code)` carrying the same value, so an off-chain agent
///      that asks first and one that just tries get an identical answer. Keeping
///      the two paths on one code table is what makes "ask before acting"
///      trustworthy -- a divergence would teach the agent the wrong lesson.
library ReinCodes {
    uint8 internal constant OK = 0;
    uint8 internal constant NOT_AN_AGENT = 1;
    uint8 internal constant AGENT_EXPIRED = 2;
    uint8 internal constant BREAKER_TRIPPED = 3;
    uint8 internal constant SELF_CALL = 4;
    uint8 internal constant TARGET_NOT_ALLOWED = 5;
    uint8 internal constant SELECTOR_NOT_ALLOWED = 6;
    uint8 internal constant NATIVE_PER_CALL = 7;
    uint8 internal constant NATIVE_PER_WINDOW = 8;
    uint8 internal constant CALL_RATE = 9;
    uint8 internal constant TOKEN_NOT_ALLOWED = 10;
    uint8 internal constant TOKEN_PER_WINDOW = 11;
    uint8 internal constant APPROVAL_TOO_LARGE = 12;
    uint8 internal constant PAYEE_NOT_ALLOWED = 13;
    uint8 internal constant INTENT_REQUIRED = 14;
    uint8 internal constant DELTA_APPROVAL_UNSUPPORTED = 15;

    // ---------------------------------------------------------------
    // v3: refusals that come from what a call DID, not what it said.
    //
    // Codes 1..15 are unchanged and mean what they always meant, so an agent
    // written against v1 reads a v3 refusal correctly. The ones below are
    // reachable only on an account that meters effects.
    // ---------------------------------------------------------------

    /// @notice The calldata is not one of the four the decoder understands and
    ///         this agent has no metered tokens, so nothing would bound what
    ///         the call moved. Refused rather than guessed.
    uint8 internal constant UNMETERED_CALL = 16;

    /// @notice The call completed and more value had left the account than the
    ///         window allows. Seen only after the fact; the call is undone.
    uint8 internal constant OUTFLOW_EXCEEDED = 17;

    /// @notice After the call, a standing allowance to a watched spender was
    ///         above the owner's ceiling -- however it got there.
    uint8 internal constant ALLOWANCE_STANDING = 18;

    /// @notice The target returned more data than the account will copy.
    uint8 internal constant RETURNDATA_TOO_LARGE = 19;

    /// @notice An ERC-3009 authorization was presented for signature that the
    ///         policy never approved.
    uint8 internal constant AUTHORIZATION_NOT_APPROVED = 20;

    /// @notice A guardian tripped this agent too recently to trip it again.
    uint8 internal constant GUARDIAN_COOLDOWN = 21;
}
