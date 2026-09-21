// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title BoundedCall
/// @notice An external call whose returndata cannot be used as a weapon.
///
/// `(bool ok, bytes memory ret) = target.call(data)` copies the whole of
/// returndata into memory before the caller can look at it. A hostile target --
/// and an allowlisted target can become hostile, that is the entire premise of
/// this account -- returns several megabytes, memory expansion costs quadratic
/// gas, and the transaction dies out of gas. The account is then unusable for
/// that target by anyone, including the owner, at a cost to the attacker of
/// almost nothing. It is a cheap denial of service against a contract whose
/// selling point is that it keeps working when the agent has been taken over.
///
/// This copies a bounded prefix instead. Callers that need the full return
/// value of a huge response are out of scope, and that is the right trade for
/// an account whose calls are payments.
library BoundedCall {
    /// @dev 8 KiB. Larger than any ERC-20 or router return value and small
    ///      enough that memory expansion stays in the tens of thousands of gas.
    uint256 internal constant MAX_RETURNDATA = 8192;

    /// @param gasLimit Gas forwarded to the target. Zero forwards everything
    ///        that is left, which is the normal case; a non-zero value lets an
    ///        owner bound a target that is known to be gas-hungry, so that one
    ///        target in a batch cannot consume the whole transaction.
    function invoke(address target, uint256 value, bytes memory data, uint256 gasLimit)
        internal
        returns (bool ok, bytes memory ret, bool truncated)
    {
        uint256 g = gasLimit == 0 ? gasleft() : gasLimit;
        assembly {
            ok := call(g, target, value, add(data, 0x20), mload(data), 0, 0)

            let size := returndatasize()
            truncated := gt(size, MAX_RETURNDATA)
            if truncated { size := MAX_RETURNDATA }

            ret := mload(0x40)
            mstore(ret, size)
            returndatacopy(add(ret, 0x20), 0, size)
            mstore(0x40, add(ret, and(add(add(size, 0x20), 0x1f), not(0x1f))))
        }
    }
}
