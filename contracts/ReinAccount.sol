// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CalldataGuard} from "./lib/CalldataGuard.sol";
import {ReinCodes} from "./ReinCodes.sol";

/// @title ReinAccount
/// @notice A smart account a human owns and an autonomous agent operates under
///         a policy the chain enforces.
///
/// The premise is that an agent's own code is not a security boundary. It can be
/// rewritten, and it can be talked into things by whatever it reads. So the
/// limits live here, in storage the agent cannot reach: the agent holds a key
/// that can only produce calls this contract is willing to make.
///
/// Three properties do the work:
///
///  1. Policy is written over what a call *does*, not only over its selector.
///     An allowlisted `transfer` still has to clear a rolling spend window and a
///     payee allowlist, so "can call transfer" is never "can drain the account".
///
///  2. The agent can never call this account. Every path that widens a policy is
///     owner-only, and `target == address(this)` is refused outright, so there is
///     no sequence of permitted calls that escalates into more permission.
///
///  3. Refusals are legible. `simulate()` returns the same code `execute()`
///     reverts with, for free, before any gas is spent -- so a well-built agent
///     asks whether an action is covered and abstains when it is not, instead of
///     discovering the boundary by hitting it.
contract ReinAccount {
    using CalldataGuard for bytes;

    // -----------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------

    struct AgentPolicy {
        bool active;
        bool tripped;
        bool requireIntent;
        uint64 expiry; // 0 = never expires
        uint32 windowSeconds;
        uint32 maxCallsPerWindow;
        uint128 maxNativePerCall;
        uint128 maxNativePerWindow;
    }

    struct TokenPolicy {
        bool enabled;
        uint32 windowSeconds;
        uint128 maxPerWindow;
        uint128 maxApproval;
    }

    struct Window {
        uint64 start;
        uint128 spent;
        uint32 calls;
    }

    // -----------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------

    address public owner;
    address public pendingOwner;

    mapping(address => AgentPolicy) public policy;
    mapping(address => Window) public nativeWindow;
    mapping(address => mapping(address => TokenPolicy)) public tokenPolicy;
    mapping(address => mapping(address => Window)) public tokenWindow;

    mapping(address => mapping(address => bool)) public targetAllowed;
    mapping(address => mapping(address => mapping(bytes4 => bool))) public selectorAllowed;
    mapping(address => mapping(address => bool)) public payeeAllowed;

    /// @notice Keys that may trip an agent's breaker and nothing else. A
    ///         monitoring bot can hold one safely: it can stop the account but
    ///         can never move a coin out of it.
    mapping(address => bool) public guardian;

    uint256 private _entered;

    /// @dev keccak256("") -- what hashing no instruction at all produces. It is
    ///      a valid-looking hash, so refusing only bytes32(0) would let an agent
    ///      satisfy `requireIntent` while recording nothing. Found by the demo
    ///      script, which passed an empty instruction and was waved through.
    bytes32 private constant EMPTY_INSTRUCTION =
        0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470;

    // -----------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------

    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);
    event AgentConfigured(address indexed agent, AgentPolicy policy);
    event AgentRevoked(address indexed agent);
    event GuardianSet(address indexed guardian, bool allowed);
    event BreakerTripped(address indexed agent, address indexed by, bytes32 reason);
    event BreakerReset(address indexed agent);
    event TargetSet(address indexed agent, address indexed target, bool allowed);
    event SelectorSet(address indexed agent, address indexed target, bytes4 indexed selector, bool allowed);
    event PayeeSet(address indexed agent, address indexed payee, bool allowed);
    event TokenPolicySet(address indexed agent, address indexed token, TokenPolicy policy);

    /// @notice One row of the prompt-to-transaction audit trail.
    /// @param intentHash keccak256 of the instruction the agent was acting on.
    ///        The contract cannot verify that the hash is honest -- it is a
    ///        commitment, not a proof. What it gives you is that an agent which
    ///        later disputes what it was told has already signed a hash of it.
    event IntentExecuted(
        address indexed agent,
        address indexed target,
        bytes32 indexed intentHash,
        bytes4 selector,
        uint256 value
    );

    event OwnerExecuted(address indexed target, bytes4 selector, uint256 value);

    // -----------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------

    error NotOwner();
    error NotGuardian();
    error BadConfig();
    error PolicyViolation(uint8 code);
    error CallFailed(bytes returndata);
    error Reentrancy();
    error LengthMismatch();

    // -----------------------------------------------------------------
    // Modifiers
    // -----------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address owner_) {
        if (owner_ == address(0)) revert BadConfig();
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    receive() external payable {}

    // -----------------------------------------------------------------
    // Ownership (two-step, so a typo cannot orphan the account)
    // -----------------------------------------------------------------

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // -----------------------------------------------------------------
    // Policy administration -- owner only, always
    // -----------------------------------------------------------------

    /// @notice Authorize an agent key, or rewrite its limits.
    /// @dev `windowSeconds` and `maxCallsPerWindow` must both be non-zero. A
    ///      zero window would make "spend per window" meaningless and a zero
    ///      call cap would authorize a key that can do nothing -- both are far
    ///      more likely to be a mistake than an intention, so they are refused
    ///      rather than silently interpreted.
    function configureAgent(address agent, AgentPolicy calldata p) external onlyOwner {
        if (agent == address(0) || agent == address(this)) revert BadConfig();
        if (p.windowSeconds == 0 || p.maxCallsPerWindow == 0) revert BadConfig();
        if (p.maxNativePerCall > p.maxNativePerWindow) revert BadConfig();

        AgentPolicy storage stored = policy[agent];
        stored.active = p.active;
        stored.requireIntent = p.requireIntent;
        stored.expiry = p.expiry;
        stored.windowSeconds = p.windowSeconds;
        stored.maxCallsPerWindow = p.maxCallsPerWindow;
        stored.maxNativePerCall = p.maxNativePerCall;
        stored.maxNativePerWindow = p.maxNativePerWindow;
        // `tripped` is deliberately not writable here: clearing a breaker is
        // resetBreaker(), so a routine limit change can never quietly un-trip an
        // account that a guardian stopped for cause.

        emit AgentConfigured(agent, stored);
    }

    function revokeAgent(address agent) external onlyOwner {
        policy[agent].active = false;
        emit AgentRevoked(agent);
    }

    function setGuardian(address who, bool allowed) external onlyOwner {
        guardian[who] = allowed;
        emit GuardianSet(who, allowed);
    }

    /// @notice Stop an agent immediately. Callable by the owner or any guardian.
    function tripBreaker(address agent, bytes32 reason) external {
        if (msg.sender != owner && !guardian[msg.sender]) revert NotGuardian();
        policy[agent].tripped = true;
        emit BreakerTripped(agent, msg.sender, reason);
    }

    /// @notice Clear a breaker. Owner only -- a guardian can stop, never start.
    function resetBreaker(address agent) external onlyOwner {
        policy[agent].tripped = false;
        emit BreakerReset(agent);
    }

    function setTargets(address agent, address[] calldata targets, bool allowed) external onlyOwner {
        for (uint256 i; i < targets.length; ++i) {
            if (targets[i] == address(this)) revert BadConfig();
            targetAllowed[agent][targets[i]] = allowed;
            emit TargetSet(agent, targets[i], allowed);
        }
    }

    function setSelectors(
        address agent,
        address target,
        bytes4[] calldata selectors,
        bool allowed
    ) external onlyOwner {
        for (uint256 i; i < selectors.length; ++i) {
            selectorAllowed[agent][target][selectors[i]] = allowed;
            emit SelectorSet(agent, target, selectors[i], allowed);
        }
    }

    function setPayees(address agent, address[] calldata payees, bool allowed) external onlyOwner {
        for (uint256 i; i < payees.length; ++i) {
            payeeAllowed[agent][payees[i]] = allowed;
            emit PayeeSet(agent, payees[i], allowed);
        }
    }

    function setTokenPolicy(address agent, address token, TokenPolicy calldata tp) external onlyOwner {
        if (tp.enabled && tp.windowSeconds == 0) revert BadConfig();
        tokenPolicy[agent][token] = tp;
        emit TokenPolicySet(agent, token, tp);
    }

    // -----------------------------------------------------------------
    // Evaluation
    // -----------------------------------------------------------------

    /// @notice Ask whether a call would be permitted, without making it.
    /// @return code `ReinCodes.OK` (0) if the call would go through, otherwise
    ///         the exact reason it would not.
    /// @dev Free to call. This is the honest half of the design: an agent that
    ///      checks first can decline a task it cannot legally complete and say
    ///      so, rather than emitting a failed transaction and guessing why.
    function simulate(
        address agent,
        address target,
        uint256 value,
        bytes calldata data,
        bytes32 intentHash
    ) external view returns (uint8 code) {
        (code,,) = _evaluate(agent, target, value, data, intentHash);
    }

    /// @dev Split into two halves purely to keep each one inside the EVM's stack
    ///      window. Scope and native budget first; token semantics second, and
    ///      only if the call turns out to move tokens.
    function _evaluate(
        address agent,
        address target,
        uint256 value,
        bytes calldata data,
        bytes32 intentHash
    ) internal view returns (uint8 code, CalldataGuard.Kind kind, uint256 amount) {
        code = _checkScopeAndNative(agent, target, value, data, intentHash);
        if (code != ReinCodes.OK) return (code, CalldataGuard.Kind.Other, 0);
        return _checkTokenMove(agent, target, data);
    }

    function _checkScopeAndNative(
        address agent,
        address target,
        uint256 value,
        bytes calldata data,
        bytes32 intentHash
    ) private view returns (uint8) {
        AgentPolicy memory p = policy[agent];

        if (!p.active) return ReinCodes.NOT_AN_AGENT;
        if (p.expiry != 0 && block.timestamp > p.expiry) return ReinCodes.AGENT_EXPIRED;
        if (p.tripped) return ReinCodes.BREAKER_TRIPPED;

        // No permitted call may re-enter the account, so no permitted call can
        // widen the policy that permitted it.
        if (target == address(this)) return ReinCodes.SELF_CALL;
        if (p.requireIntent && (intentHash == bytes32(0) || intentHash == EMPTY_INSTRUCTION)) {
            return ReinCodes.INTENT_REQUIRED;
        }

        if (!targetAllowed[agent][target]) return ReinCodes.TARGET_NOT_ALLOWED;
        if (!selectorAllowed[agent][target][CalldataGuard.selectorOf(data)]) {
            return ReinCodes.SELECTOR_NOT_ALLOWED;
        }

        // The per-call check runs first so that `value` is known to fit in
        // uint128 before it is added to the window total.
        if (value > p.maxNativePerCall) return ReinCodes.NATIVE_PER_CALL;

        (uint128 nSpent, uint32 nCalls) = _readWindow(nativeWindow[agent], p.windowSeconds);
        if (uint256(nCalls) + 1 > p.maxCallsPerWindow) return ReinCodes.CALL_RATE;
        if (uint256(nSpent) + value > p.maxNativePerWindow) return ReinCodes.NATIVE_PER_WINDOW;

        return ReinCodes.OK;
    }

    function _checkTokenMove(address agent, address target, bytes calldata data)
        private
        view
        returns (uint8, CalldataGuard.Kind, uint256)
    {
        (CalldataGuard.Kind kind, address counterparty, uint256 amount) = CalldataGuard.classify(data);
        if (kind == CalldataGuard.Kind.Other) return (ReinCodes.OK, kind, 0);

        // The call moves tokens. Allowlisting the selector was necessary but is
        // not sufficient -- without a token policy there is no ceiling on the
        // amount, so the safe reading of "no policy" is "no".
        TokenPolicy memory tp = tokenPolicy[agent][target];
        if (!tp.enabled) return (ReinCodes.TOKEN_NOT_ALLOWED, kind, amount);
        if (!payeeAllowed[agent][counterparty]) return (ReinCodes.PAYEE_NOT_ALLOWED, kind, amount);

        if (kind == CalldataGuard.Kind.IncreaseAllowance) {
            // Refused outright, and the reason is worth stating because the first
            // version of this contract got it wrong: increaseAllowance's argument
            // is a DELTA, not a total. Capping the delta caps nothing -- twenty
            // permitted calls of `maxApproval` each leave an allowance of twenty
            // times maxApproval standing. Bounding it properly would mean
            // mirroring the token's allowance in storage, and that mirror silently
            // goes stale the moment the spender spends or the owner approves from
            // elsewhere. A ceiling computed from a stale mirror is worse than no
            // ceiling, because it reads as protection. So the policy is: set the
            // allowance to an exact figure with approve(), where the argument IS
            // the total and the ceiling means what it says.
            return (ReinCodes.DELTA_APPROVAL_UNSUPPORTED, kind, amount);
        }

        if (kind == CalldataGuard.Kind.Approve) {
            // An allowance is a promise to be drained later, so it is capped on
            // its own axis rather than charged to the spend window. approve()
            // sets an absolute value, so a ceiling below type(uint256).max does
            // make an infinite approve unreachable -- for this selector.
            if (amount > tp.maxApproval) return (ReinCodes.APPROVAL_TOO_LARGE, kind, amount);
            return (ReinCodes.OK, kind, amount);
        }

        // Checked against the ceiling before being added to the running total,
        // so an amount near type(uint256).max cannot overflow the sum.
        if (amount > tp.maxPerWindow) return (ReinCodes.TOKEN_PER_WINDOW, kind, amount);
        (uint128 tSpent,) = _readWindow(tokenWindow[agent][target], tp.windowSeconds);
        if (uint256(tSpent) + amount > tp.maxPerWindow) {
            return (ReinCodes.TOKEN_PER_WINDOW, kind, amount);
        }

        return (ReinCodes.OK, kind, amount);
    }

    /// @dev A window that has aged out reads as empty. Nothing is written until
    ///      a call actually commits, so simulating never advances the clock.
    function _readWindow(Window memory w, uint32 windowSeconds)
        private
        view
        returns (uint128 spent, uint32 calls)
    {
        if (block.timestamp >= uint256(w.start) + windowSeconds) return (0, 0);
        return (w.spent, w.calls);
    }

    function _commitWindow(Window storage w, uint32 windowSeconds, uint256 add) private {
        if (block.timestamp >= uint256(w.start) + windowSeconds) {
            w.start = uint64(block.timestamp);
            w.spent = uint128(add);
            w.calls = 1;
        } else {
            w.spent = uint128(uint256(w.spent) + add);
            w.calls = w.calls + 1;
        }
    }

    // -----------------------------------------------------------------
    // Execution
    // -----------------------------------------------------------------

    struct Call {
        address target;
        uint256 value;
        bytes data;
        bytes32 intentHash;
    }

    /// @notice Make one call as the account, if policy permits it.
    /// @param intentHash keccak256 of the instruction the agent is acting on.
    function execute(address target, uint256 value, bytes calldata data, bytes32 intentHash)
        external
        nonReentrant
        returns (bytes memory)
    {
        return _agentCall(target, value, data, intentHash);
    }

    /// @notice Make several calls as the account. Each one is evaluated against
    ///         the state the previous one left behind, so a batch cannot spend
    ///         more than the same calls made separately.
    function executeBatch(Call[] calldata calls)
        external
        nonReentrant
        returns (bytes[] memory results)
    {
        results = new bytes[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            results[i] = _agentCall(calls[i].target, calls[i].value, calls[i].data, calls[i].intentHash);
        }
    }

    function _agentCall(address target, uint256 value, bytes calldata data, bytes32 intentHash)
        private
        returns (bytes memory)
    {
        (uint8 code, CalldataGuard.Kind kind, uint256 amount) =
            _evaluate(msg.sender, target, value, data, intentHash);
        if (code != ReinCodes.OK) revert PolicyViolation(code);

        // Budgets are spent before the call, not after, so a target that calls
        // back in cannot be charged twice for one allowance.
        _commitWindow(nativeWindow[msg.sender], policy[msg.sender].windowSeconds, value);
        if (kind == CalldataGuard.Kind.Transfer || kind == CalldataGuard.Kind.TransferFrom) {
            _commitWindow(
                tokenWindow[msg.sender][target],
                tokenPolicy[msg.sender][target].windowSeconds,
                amount
            );
        }

        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(ret);

        emit IntentExecuted(msg.sender, target, intentHash, CalldataGuard.selectorOf(data), value);
        return ret;
    }

    /// @notice The owner's unrestricted path. Policy binds agents, not the human
    ///         who wrote it -- otherwise a misconfigured limit could lock the
    ///         owner out of their own funds.
    function ownerExecute(address target, uint256 value, bytes calldata data)
        external
        onlyOwner
        nonReentrant
        returns (bytes memory)
    {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
        emit OwnerExecuted(target, CalldataGuard.selectorOf(data), value);
        return ret;
    }

    // -----------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------

    /// @notice What an agent has left in the current native window.
    function remainingNative(address agent) external view returns (uint256 value, uint256 calls) {
        AgentPolicy memory p = policy[agent];
        (uint128 spent, uint32 used) = _readWindow(nativeWindow[agent], p.windowSeconds);
        value = p.maxNativePerWindow > spent ? p.maxNativePerWindow - spent : 0;
        calls = p.maxCallsPerWindow > used ? p.maxCallsPerWindow - used : 0;
    }

    /// @notice What an agent has left of a token in the current token window.
    function remainingToken(address agent, address token) external view returns (uint256) {
        TokenPolicy memory tp = tokenPolicy[agent][token];
        if (!tp.enabled) return 0;
        (uint128 spent,) = _readWindow(tokenWindow[agent][token], tp.windowSeconds);
        return tp.maxPerWindow > spent ? tp.maxPerWindow - spent : 0;
    }
}
