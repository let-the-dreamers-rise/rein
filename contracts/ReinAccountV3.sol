// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CalldataGuard} from "./lib/CalldataGuard.sol";
import {EffectMeter} from "./lib/EffectMeter.sol";
import {BoundedCall} from "./lib/BoundedCall.sol";
import {Erc3009Gate} from "./lib/Erc3009Gate.sol";
import {ReinCodes} from "./ReinCodes.sol";

/// @title ReinAccountV3
/// @notice A smart account a human owns and an autonomous agent operates under
///         a policy the chain enforces -- bounded by what its calls DO, not by
///         what their calldata claims.
///
/// v1 and v2 wrote policy over decoded calldata: four ERC-20 selectors carried
/// semantics and everything else on an allowlisted contract was bounded by the
/// target allowlist and the native budget alone. That is a real hole and it is
/// the shape of the most ordinary agent there is. An agent allowlisted for a
/// DEX router can call `swapExact(tokenIn, tokenOut, amountIn, recipient)`; the
/// decoder returns "not a token call", so the payee allowlist never runs, the
/// token ceiling never runs, and the rolling spend window is never charged. The
/// router moves the money and the policy watches it go. Nothing in v2 catches
/// it, and the same is true of a bridge, a vault deposit, `permit`,
/// `transferAndCall`, a fee-on-transfer token and any token with two addresses.
///
/// v3 keeps the calldata check, because it is cheap and it is what makes a
/// refusal legible BEFORE gas is spent, and then adds a second check the
/// decoder cannot be talked out of: read the balances the policy cares about,
/// make the call, read them again, and charge what actually left. If more left
/// than the window allows, the whole call is undone.
///
/// So the two halves say different things, on purpose:
///
///   simulate()  what the policy BELIEVES this call will do, free, before gas.
///   execute()   that, and then a refusal if reality disagreed.
///
/// An honest agent sees no difference. An agent that has found an encoding the
/// decoder does not understand gets its transaction reverted by arithmetic on
/// the balance sheet, which is not a thing that can be prompt-injected.
contract ReinAccountV3 {
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

    struct Call {
        address target;
        uint256 value;
        bytes data;
        bytes32 intentHash;
    }

    /// @dev The balance sheet as it stood before a call, carried as one value
    ///      so the execution path has stack left to do its job.
    struct Meter {
        bool armed;
        address[] tokens;
        uint256[] balances;
        bool[] readable;
        uint256 nativeBefore;
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

    mapping(address => bool) public guardian;

    /// @notice The tokens whose balances are read before and after every call
    ///         this agent makes. Arming this is what closes the router hole.
    mapping(address => address[]) internal _guardedTokens;

    /// @notice Spenders whose standing allowance is checked after every call.
    ///         Typically the routers and vaults the agent is allowed to call:
    ///         the ones that could hold an allowance worth draining later.
    mapping(address => address[]) internal _watchedSpenders;

    /// @notice Default true for every configured agent. An owner who genuinely
    ///         has an agent that touches no tokens can turn it off explicitly;
    ///         nobody turns it off by accident, which is the point.
    mapping(address => bool) public meteringRequired;

    /// @notice Gas forwarded to a target, per agent. Zero forwards everything.
    mapping(address => uint32) public callGasLimit;

    /// @notice digest => the agent whose policy approved it. ERC-3009/x402.
    mapping(bytes32 => address) public authorizedBy;

    /// @notice How far into the future an ERC-3009 authorization may stay
    ///         redeemable. An authorization is budget already spent, so one
    ///         that lingers for a month is a month of budget held hostage.
    uint32 public maxAuthorizationSeconds = 3600;

    /// @notice guardian => agent => when that guardian last tripped it.
    mapping(address => mapping(address => uint64)) public guardianLastTrip;

    /// @notice How long a guardian must wait before tripping the same agent
    ///         again. A guardian key that leaks can otherwise stop the business
    ///         forever: trip, owner resets, trip again, at the cost of one
    ///         transaction each time. The owner is never rate limited.
    uint32 public guardianTripCooldown = 900;

    uint256 private _entered;

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
    event GuardedTokensSet(address indexed agent, address[] tokens);
    event WatchedSpendersSet(address indexed agent, address[] spenders);
    event MeteringRequiredSet(address indexed agent, bool required);

    event IntentExecuted(
        address indexed agent,
        address indexed target,
        bytes32 indexed intentHash,
        bytes4 selector,
        uint256 value
    );
    event OwnerExecuted(address indexed target, bytes4 selector, uint256 value);

    /// @notice An outflow the calldata did not declare was charged to a window.
    ///         Worth its own event: every one of these is a call whose effect
    ///         the policy could not read from its arguments, which is exactly
    ///         the set of calls worth reviewing by hand afterwards.
    event UndeclaredOutflow(address indexed agent, address indexed token, uint256 amount);

    event AuthorizationApproved(
        address indexed agent,
        address indexed token,
        address indexed to,
        uint256 value,
        bytes32 digest
    );
    event AuthorizationRevoked(bytes32 indexed digest);

    // -----------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------

    error NotOwner();
    error NotGuardian();
    error BadConfig();
    error PolicyViolation(uint8 code);
    error CallFailed(bytes returndata);
    error Reentrancy();

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
    // Ownership
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

    function configureAgent(address agent, AgentPolicy calldata p) external onlyOwner {
        if (agent == address(0) || agent == address(this)) revert BadConfig();
        if (p.windowSeconds == 0 || p.maxCallsPerWindow == 0) revert BadConfig();
        if (p.maxNativePerCall > p.maxNativePerWindow) revert BadConfig();

        AgentPolicy storage stored = policy[agent];
        bool firstTime = stored.windowSeconds == 0;

        stored.active = p.active;
        stored.requireIntent = p.requireIntent;
        stored.expiry = p.expiry;
        stored.windowSeconds = p.windowSeconds;
        stored.maxCallsPerWindow = p.maxCallsPerWindow;
        stored.maxNativePerCall = p.maxNativePerCall;
        stored.maxNativePerWindow = p.maxNativePerWindow;

        // Metering defaults on, and only on the first configuration, so that a
        // routine limit change cannot silently re-arm something the owner
        // deliberately turned off -- nor silently disarm it.
        if (firstTime) {
            meteringRequired[agent] = true;
            emit MeteringRequiredSet(agent, true);
        }

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

    /// @notice Stop an agent immediately. Owner, or a guardian off cooldown.
    function tripBreaker(address agent, bytes32 reason) external {
        if (msg.sender != owner) {
            if (!guardian[msg.sender]) revert NotGuardian();
            uint64 last = guardianLastTrip[msg.sender][agent];
            if (last != 0 && block.timestamp < uint256(last) + guardianTripCooldown) {
                revert PolicyViolation(ReinCodes.GUARDIAN_COOLDOWN);
            }
            guardianLastTrip[msg.sender][agent] = uint64(block.timestamp);
        }
        policy[agent].tripped = true;
        emit BreakerTripped(agent, msg.sender, reason);
    }

    function resetBreaker(address agent) external onlyOwner {
        policy[agent].tripped = false;
        emit BreakerReset(agent);
    }

    function setGuardianTripCooldown(uint32 seconds_) external onlyOwner {
        guardianTripCooldown = seconds_;
    }

    function setTargets(address agent, address[] calldata targets, bool allowed) external onlyOwner {
        for (uint256 i; i < targets.length; ++i) {
            if (targets[i] == address(this)) revert BadConfig();
            targetAllowed[agent][targets[i]] = allowed;
            emit TargetSet(agent, targets[i], allowed);
        }
    }

    function setSelectors(address agent, address target, bytes4[] calldata selectors, bool allowed)
        external
        onlyOwner
    {
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

    /// @dev A token may not be given a spending ceiling unless its balance is
    ///      also being metered. Otherwise the ceiling is enforced on the four
    ///      selectors the decoder knows and on nothing else, which is precisely
    ///      the false sense of protection v3 exists to remove. The invariant is
    ///      checked here, at configuration time, so it cannot be violated at
    ///      call time by any ordering of events.
    function setTokenPolicy(address agent, address token, TokenPolicy calldata tp) external onlyOwner {
        if (tp.enabled) {
            if (tp.windowSeconds == 0) revert BadConfig();
            if (meteringRequired[agent] && !isGuarded(agent, token)) revert BadConfig();
        }
        tokenPolicy[agent][token] = tp;
        emit TokenPolicySet(agent, token, tp);
    }

    function setGuardedTokens(address agent, address[] calldata tokens) external onlyOwner {
        if (tokens.length > EffectMeter.MAX_GUARDED_TOKENS) revert BadConfig();
        _guardedTokens[agent] = tokens;
        emit GuardedTokensSet(agent, tokens);
    }

    function setWatchedSpenders(address agent, address[] calldata spenders) external onlyOwner {
        if (spenders.length > EffectMeter.MAX_WATCHED_SPENDERS) revert BadConfig();
        _watchedSpenders[agent] = spenders;
        emit WatchedSpendersSet(agent, spenders);
    }

    function setMeteringRequired(address agent, bool required) external onlyOwner {
        meteringRequired[agent] = required;
        emit MeteringRequiredSet(agent, required);
    }

    function setCallGasLimit(address agent, uint32 limit) external onlyOwner {
        callGasLimit[agent] = limit;
    }

    function setMaxAuthorizationSeconds(uint32 seconds_) external onlyOwner {
        if (seconds_ == 0) revert BadConfig();
        maxAuthorizationSeconds = seconds_;
    }

    function guardedTokens(address agent) external view returns (address[] memory) {
        return _guardedTokens[agent];
    }

    function watchedSpenders(address agent) external view returns (address[] memory) {
        return _watchedSpenders[agent];
    }

    function isGuarded(address agent, address token) public view returns (bool) {
        address[] storage t = _guardedTokens[agent];
        for (uint256 i; i < t.length; ++i) {
            if (t[i] == token) return true;
        }
        return false;
    }

    // -----------------------------------------------------------------
    // Evaluation -- what the policy believes, free, before gas
    // -----------------------------------------------------------------

    function simulate(address agent, address target, uint256 value, bytes calldata data, bytes32 intentHash)
        external
        view
        returns (uint8 code)
    {
        (code,,) = _evaluate(agent, target, value, data, intentHash);
    }

    function _evaluate(address agent, address target, uint256 value, bytes calldata data, bytes32 intentHash)
        internal
        view
        returns (uint8 code, CalldataGuard.Kind kind, uint256 amount)
    {
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
        if (target == address(this)) return ReinCodes.SELF_CALL;
        if (p.requireIntent && (intentHash == bytes32(0) || intentHash == EMPTY_INSTRUCTION)) {
            return ReinCodes.INTENT_REQUIRED;
        }
        if (!targetAllowed[agent][target]) return ReinCodes.TARGET_NOT_ALLOWED;
        if (!selectorAllowed[agent][target][CalldataGuard.selectorOf(data)]) {
            return ReinCodes.SELECTOR_NOT_ALLOWED;
        }
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

        if (kind == CalldataGuard.Kind.Other) {
            // The decoder has nothing to say about this call. That is fine if
            // the balance sheet is being watched, and a refusal if it is not:
            // an opaque call on an unmetered account is the router hole, and
            // there is no honest way to bound it after the fact.
            if (meteringRequired[agent] && _guardedTokens[agent].length == 0) {
                return (ReinCodes.UNMETERED_CALL, kind, 0);
            }
            return (ReinCodes.OK, kind, 0);
        }

        TokenPolicy memory tp = tokenPolicy[agent][target];
        if (!tp.enabled) return (ReinCodes.TOKEN_NOT_ALLOWED, kind, amount);
        if (!payeeAllowed[agent][counterparty]) return (ReinCodes.PAYEE_NOT_ALLOWED, kind, amount);

        if (kind == CalldataGuard.Kind.IncreaseAllowance) {
            return (ReinCodes.DELTA_APPROVAL_UNSUPPORTED, kind, amount);
        }
        if (kind == CalldataGuard.Kind.Approve) {
            if (amount > tp.maxApproval) return (ReinCodes.APPROVAL_TOO_LARGE, kind, amount);
            return (ReinCodes.OK, kind, amount);
        }

        if (amount > tp.maxPerWindow) return (ReinCodes.TOKEN_PER_WINDOW, kind, amount);
        (uint128 tSpent,) = _readWindow(tokenWindow[agent][target], tp.windowSeconds);
        if (uint256(tSpent) + amount > tp.maxPerWindow) return (ReinCodes.TOKEN_PER_WINDOW, kind, amount);

        return (ReinCodes.OK, kind, amount);
    }

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

    /// @dev Add to a token window only if the ceiling still has room for it.
    ///      Returns false rather than reverting so the caller chooses the code.
    function _chargeToken(address agent, address token, uint256 add) private returns (bool) {
        if (add == 0) return true;
        TokenPolicy memory tp = tokenPolicy[agent][token];
        if (!tp.enabled) return false;
        (uint128 spent,) = _readWindow(tokenWindow[agent][token], tp.windowSeconds);
        if (uint256(spent) + add > tp.maxPerWindow) return false;
        _commitWindow(tokenWindow[agent][token], tp.windowSeconds, add);
        return true;
    }

    // -----------------------------------------------------------------
    // Execution
    // -----------------------------------------------------------------

    function execute(address target, uint256 value, bytes calldata data, bytes32 intentHash)
        external
        nonReentrant
        returns (bytes memory)
    {
        return _agentCall(target, value, data, intentHash);
    }

    function executeBatch(Call[] calldata calls) external nonReentrant returns (bytes[] memory results) {
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

        Meter memory m = _snapshot();
        _chargeDeclared(target, value, kind, amount);

        bytes memory ret = _invoke(target, value, data);

        if (m.armed) _settle(m, target, kind, amount, value);

        emit IntentExecuted(msg.sender, target, intentHash, CalldataGuard.selectorOf(data), value);
        return ret;
    }

    function _snapshot() private view returns (Meter memory m) {
        m.tokens = _guardedTokens[msg.sender];
        m.armed = m.tokens.length > 0;
        if (!m.armed) return m;
        (m.balances, m.readable) = EffectMeter.snapshot(m.tokens, address(this));
        m.nativeBefore = address(this).balance;
    }

    /// @dev What the calldata declared, charged exactly as v2 charged it, so an
    ///      agent whose calls the decoder understands sees identical accounting
    ///      and the same refusal codes it saw before.
    function _chargeDeclared(address target, uint256 value, CalldataGuard.Kind kind, uint256 amount)
        private
    {
        _commitWindow(nativeWindow[msg.sender], policy[msg.sender].windowSeconds, value);
        if (kind == CalldataGuard.Kind.Transfer || kind == CalldataGuard.Kind.TransferFrom) {
            Window storage w = tokenWindow[msg.sender][target];
            _commitWindow(w, tokenPolicy[msg.sender][target].windowSeconds, amount);
        }
    }

    function _invoke(address target, uint256 value, bytes calldata data) private returns (bytes memory) {
        (bool ok, bytes memory ret, bool truncated) =
            BoundedCall.invoke(target, value, data, callGasLimit[msg.sender]);
        if (truncated) revert PolicyViolation(ReinCodes.RETURNDATA_TOO_LARGE);
        if (!ok) revert CallFailed(ret);
        return ret;
    }

    /// @dev The second half of the check, and the one that cannot be argued
    ///      with. Everything that left the account beyond what the calldata
    ///      declared is charged to the window; if it does not fit, the call is
    ///      undone. Then every watched spender's standing allowance is held to
    ///      the owner's ceiling, whatever route it took to get there.
    function _settle(
        Meter memory m,
        address target,
        CalldataGuard.Kind kind,
        uint256 declaredAmount,
        uint256 declaredValue
    ) private {
        _settleTokens(m, target, kind, declaredAmount);
        _settleNative(m.nativeBefore, declaredValue);
        _settleAllowances(m.tokens);
    }

    function _settleTokens(Meter memory m, address target, CalldataGuard.Kind kind, uint256 declaredAmount)
        private
    {
        (uint256[] memory after_, bool[] memory readableAfter) =
            EffectMeter.snapshot(m.tokens, address(this));

        bool declaredIsTokenMove =
            kind == CalldataGuard.Kind.Transfer || kind == CalldataGuard.Kind.TransferFrom;

        for (uint256 i; i < m.tokens.length; ++i) {
            uint256 out = EffectMeter.outflow(m.balances[i], m.readable[i], after_[i], readableAfter[i]);
            if (out == 0) continue;

            // Only the part the calldata did not account for is new.
            uint256 declared = (declaredIsTokenMove && m.tokens[i] == target) ? declaredAmount : 0;
            if (out <= declared) continue;

            uint256 undeclared = out - declared;
            if (!_chargeToken(msg.sender, m.tokens[i], undeclared)) {
                revert PolicyViolation(ReinCodes.OUTFLOW_EXCEEDED);
            }
            emit UndeclaredOutflow(msg.sender, m.tokens[i], undeclared);
        }
    }

    function _settleNative(uint256 nativeBefore, uint256 declaredValue) private {
        uint256 nativeAfter = address(this).balance;
        if (nativeBefore <= nativeAfter) return;

        uint256 nOut = nativeBefore - nativeAfter;
        if (nOut <= declaredValue) return;

        uint256 undeclared = nOut - declaredValue;
        AgentPolicy memory p = policy[msg.sender];
        (uint128 spent,) = _readWindow(nativeWindow[msg.sender], p.windowSeconds);
        if (uint256(spent) + undeclared > p.maxNativePerWindow) {
            revert PolicyViolation(ReinCodes.OUTFLOW_EXCEEDED);
        }
        _commitWindow(nativeWindow[msg.sender], p.windowSeconds, undeclared);
        emit UndeclaredOutflow(msg.sender, address(0), undeclared);
    }

    /// @dev A standing allowance is an outflow that has not happened yet, so it
    ///      is held to the same ceiling whatever route it took to get there --
    ///      `approve`, `permit`, `increaseAllowance` called by somebody else,
    ///      or a callback during the call that just ran.
    function _settleAllowances(address[] memory tokens) private view {
        address[] memory spenders = _watchedSpenders[msg.sender];
        for (uint256 s; s < spenders.length; ++s) {
            for (uint256 i; i < tokens.length; ++i) {
                uint256 standing = EffectMeter.allowanceOf(tokens[i], address(this), spenders[s]);
                if (standing > tokenPolicy[msg.sender][tokens[i]].maxApproval) {
                    revert PolicyViolation(ReinCodes.ALLOWANCE_STANDING);
                }
            }
        }
    }

    function ownerExecute(address target, uint256 value, bytes calldata data)
        external
        onlyOwner
        nonReentrant
        returns (bytes memory)
    {
        (bool ok, bytes memory ret,) = BoundedCall.invoke(target, value, data, 0);
        if (!ok) revert CallFailed(ret);
        emit OwnerExecuted(target, CalldataGuard.selectorOf(data), value);
        return ret;
    }

    // -----------------------------------------------------------------
    // ERC-3009 / x402: being a payer without being able to sign
    // -----------------------------------------------------------------

    /// @notice Check an ERC-3009 transfer against policy and stand behind it.
    /// @dev The budget is charged here, at approval, not at settlement, because
    ///      settlement happens later and in somebody else's transaction. An
    ///      authorization that is never redeemed still cost its window: that is
    ///      the conservative direction, and it is why they are short-lived.
    function authorizeTransfer(
        Erc3009Gate.Authorization calldata a,
        bool receiveVariant,
        bytes32 intentHash
    ) external returns (bytes32 digest) {
        uint8 code = _checkAuthorization(msg.sender, a, intentHash);
        if (code != ReinCodes.OK) revert PolicyViolation(code);

        digest = Erc3009Gate.digestOf(a, address(this), receiveVariant);
        if (digest == bytes32(0)) revert PolicyViolation(ReinCodes.TOKEN_NOT_ALLOWED);

        if (!_chargeToken(msg.sender, a.token, a.value)) {
            revert PolicyViolation(ReinCodes.TOKEN_PER_WINDOW);
        }
        _commitWindow(nativeWindow[msg.sender], policy[msg.sender].windowSeconds, 0);

        authorizedBy[digest] = msg.sender;
        emit AuthorizationApproved(msg.sender, a.token, a.to, a.value, digest);
        emit IntentExecuted(msg.sender, a.token, intentHash, CalldataGuard.TRANSFER, 0);
    }

    /// @notice The same question, free, before gas -- the ERC-3009 twin of
    ///         simulate().
    function simulateAuthorization(address agent, Erc3009Gate.Authorization calldata a, bytes32 intentHash)
        external
        view
        returns (uint8)
    {
        return _checkAuthorization(agent, a, intentHash);
    }

    function _checkAuthorization(address agent, Erc3009Gate.Authorization calldata a, bytes32 intentHash)
        private
        view
        returns (uint8)
    {
        AgentPolicy memory p = policy[agent];
        if (!p.active) return ReinCodes.NOT_AN_AGENT;
        if (p.expiry != 0 && block.timestamp > p.expiry) return ReinCodes.AGENT_EXPIRED;
        if (p.tripped) return ReinCodes.BREAKER_TRIPPED;
        if (a.token == address(this)) return ReinCodes.SELF_CALL;
        if (p.requireIntent && (intentHash == bytes32(0) || intentHash == EMPTY_INSTRUCTION)) {
            return ReinCodes.INTENT_REQUIRED;
        }
        if (!targetAllowed[agent][a.token]) return ReinCodes.TARGET_NOT_ALLOWED;
        if (!selectorAllowed[agent][a.token][CalldataGuard.TRANSFER]) {
            return ReinCodes.SELECTOR_NOT_ALLOWED;
        }
        if (!payeeAllowed[agent][a.to]) return ReinCodes.PAYEE_NOT_ALLOWED;

        if (a.validBefore <= block.timestamp) return ReinCodes.AGENT_EXPIRED;
        if (a.validBefore > block.timestamp + maxAuthorizationSeconds) return ReinCodes.AGENT_EXPIRED;

        TokenPolicy memory tp = tokenPolicy[agent][a.token];
        if (!tp.enabled) return ReinCodes.TOKEN_NOT_ALLOWED;
        if (a.value > tp.maxPerWindow) return ReinCodes.TOKEN_PER_WINDOW;
        (uint128 spent,) = _readWindow(tokenWindow[agent][a.token], tp.windowSeconds);
        if (uint256(spent) + a.value > tp.maxPerWindow) return ReinCodes.TOKEN_PER_WINDOW;

        (, uint32 calls) = _readWindow(nativeWindow[agent], p.windowSeconds);
        if (uint256(calls) + 1 > p.maxCallsPerWindow) return ReinCodes.CALL_RATE;

        return ReinCodes.OK;
    }

    /// @notice Withdraw the account's backing for a pending authorization.
    /// @dev The window is deliberately not refunded. Refunding would let an
    ///      agent approve and revoke in a loop to learn the exact remaining
    ///      budget for free, and a budget you can probe is a budget you can
    ///      plan around.
    function revokeAuthorization(bytes32 digest) external {
        address a = authorizedBy[digest];
        if (msg.sender != owner && msg.sender != a && !guardian[msg.sender]) revert NotGuardian();
        delete authorizedBy[digest];
        emit AuthorizationRevoked(digest);
    }

    /// @notice ERC-1271. The token asks this at settlement, which is the whole
    ///         value of the arrangement: a pending x402 payment is still
    ///         refusable, because the account is consulted when it lands rather
    ///         than when it was signed. Revoking the agent, tripping the
    ///         breaker or letting the key expire stops payments already in
    ///         flight -- something a signature from an EOA can never offer.
    /// @dev Replay is the token's job and the token does it: ERC-3009 nonces
    ///      are single-use, so a digest cannot settle twice.
    function isValidSignature(bytes32 hash, bytes calldata) external view returns (bytes4) {
        address a = authorizedBy[hash];
        if (a == address(0)) return Erc3009Gate.NOT_VALID;

        AgentPolicy memory p = policy[a];
        if (!p.active || p.tripped) return Erc3009Gate.NOT_VALID;
        if (p.expiry != 0 && block.timestamp > p.expiry) return Erc3009Gate.NOT_VALID;

        return Erc3009Gate.MAGIC;
    }

    // -----------------------------------------------------------------
    // Token receivers, so the account can hold what it is paid in
    // -----------------------------------------------------------------

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x150b7a02;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return 0xf23a6e61;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return 0xbc197c81;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 // ERC-165
            || id == 0x1626ba7e // ERC-1271
            || id == 0x150b7a02 // ERC-721 receiver
            || id == 0x4e2312e0; // ERC-1155 receiver
    }

    // -----------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------

    function remainingNative(address agent) external view returns (uint256 value, uint256 calls) {
        AgentPolicy memory p = policy[agent];
        (uint128 spent, uint32 used) = _readWindow(nativeWindow[agent], p.windowSeconds);
        value = p.maxNativePerWindow > spent ? p.maxNativePerWindow - spent : 0;
        calls = p.maxCallsPerWindow > used ? p.maxCallsPerWindow - used : 0;
    }

    function remainingToken(address agent, address token) external view returns (uint256) {
        TokenPolicy memory tp = tokenPolicy[agent][token];
        if (!tp.enabled) return 0;
        (uint128 spent,) = _readWindow(tokenWindow[agent][token], tp.windowSeconds);
        return tp.maxPerWindow > spent ? tp.maxPerWindow - spent : 0;
    }
}
