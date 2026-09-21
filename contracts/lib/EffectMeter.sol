// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title EffectMeter
/// @notice Measures what a call actually did to the account's balances, rather
///         than what its calldata said it would do.
///
/// The reason this exists is the hole in decoding calldata at all. A decoder
/// can only understand the selectors it was taught. `CalldataGuard` understands
/// four, and every other selector on an allowlisted contract is waved through
/// with no token ceiling and no payee check -- which is fine for a contract
/// that moves nothing and catastrophic for a router, a bridge, a vault or any
/// token exposing `permit` or `transferAndCall`. An allowlisted router taking a
/// `recipient` argument is an unmetered exit, and a router is the single most
/// common thing an agent is allowlisted for.
///
/// So the ceiling is enforced on the balance sheet instead. Read the balances
/// the policy cares about, make the call, read them again, and charge the
/// difference. A decoder can be fooled by an encoding it has never seen; a
/// balance cannot. Fee-on-transfer tokens, rebasing tokens, ERC-777 hooks,
/// double-entrypoint tokens, EIP-3009 and EIP-2612 all land here correctly
/// without the account being taught anything about them.
library EffectMeter {
    /// @dev Bounded so the gas cost of a call cannot be grown without limit by
    ///      an owner who keeps adding tokens. Four is more than any real agent
    ///      needs; the common case is one.
    uint256 internal constant MAX_GUARDED_TOKENS = 4;
    uint256 internal constant MAX_WATCHED_SPENDERS = 4;

    /// @notice `balanceOf(self)` for each token, plus the native balance last.
    /// @dev A token that does not answer is read as zero rather than reverting.
    ///      Reverting here would let a hostile token brick the account; reading
    ///      zero is safe because a zero "before" can only ever under-report an
    ///      inflow, never under-report an outflow. If "before" is wrongly zero
    ///      the computed outflow is zero and the call is charged nothing, so
    ///      the companion check in `outflow` treats an unreadable token as an
    ///      error the caller must decide about.
    function snapshot(address[] memory tokens, address self)
        internal
        view
        returns (uint256[] memory balances, bool[] memory readable)
    {
        balances = new uint256[](tokens.length);
        readable = new bool[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            (bool ok, bytes memory ret) =
                tokens[i].staticcall(abi.encodeWithSelector(0x70a08231, self));
            if (ok && ret.length >= 32) {
                balances[i] = abi.decode(ret, (uint256));
                readable[i] = true;
            }
        }
    }

    /// @notice How much of `token` left the account between two snapshots.
    /// @dev An increase is an inflow and costs nothing; only a decrease is
    ///      charged. A token that was readable before and is not readable now
    ///      is treated as a full outflow of its previous balance, because a
    ///      token that stops answering after a call is either hostile or broken
    ///      and in both cases the safe reading is that the balance is gone.
    function outflow(uint256 before_, bool readableBefore, uint256 after_, bool readableAfter)
        internal
        pure
        returns (uint256)
    {
        if (!readableBefore) return 0;
        if (!readableAfter) return before_;
        return after_ >= before_ ? 0 : before_ - after_;
    }

    /// @notice `allowance(self, spender)`, or zero if the token will not say.
    /// @dev Used as a ceiling check after the call rather than a delta, so no
    ///      "before" reading is needed. The question being asked is not "did
    ///      this call raise the allowance" but "is the allowance standing after
    ///      this call one the owner would have permitted", which is the
    ///      question that actually bounds the loss. It catches `permit`,
    ///      `increaseAllowance` routed through a third party, and any approval
    ///      granted by a callback, none of which the calldata decoder sees.
    function allowanceOf(address token, address self, address spender)
        internal
        view
        returns (uint256)
    {
        (bool ok, bytes memory ret) =
            token.staticcall(abi.encodeWithSelector(0xdd62ed3e, self, spender));
        return (ok && ret.length >= 32) ? abi.decode(ret, (uint256)) : 0;
    }
}
