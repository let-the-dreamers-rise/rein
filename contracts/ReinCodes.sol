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
}
