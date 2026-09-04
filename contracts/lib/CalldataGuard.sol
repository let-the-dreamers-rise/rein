// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title CalldataGuard
/// @notice Decodes the handful of ERC-20 calls that actually move value, so a
///         policy can be written over *what* a call does instead of only over
///         which selector it carries.
/// @dev Address words are masked to their low 160 bits rather than rejected.
///      That is deliberate: the token contract's own ABI decoder masks too, so
///      masking makes this library see exactly the address the token will see.
///      Rejecting dirty words would be stricter but would also let a caller
///      choose between two different readings of the same calldata, and any
///      divergence between our reading and the token's is a policy bypass.
library CalldataGuard {
    enum Kind {
        Other,
        Transfer,
        Approve,
        TransferFrom,
        IncreaseAllowance
    }

    bytes4 internal constant TRANSFER = 0xa9059cbb;
    bytes4 internal constant APPROVE = 0x095ea7b3;
    bytes4 internal constant TRANSFER_FROM = 0x23b872dd;
    bytes4 internal constant INCREASE_ALLOWANCE = 0x39509351;

    /// @notice Selector of `data`, or 0x00000000 for a plain value transfer.
    function selectorOf(bytes calldata data) internal pure returns (bytes4) {
        if (data.length < 4) return bytes4(0);
        return bytes4(data[0:4]);
    }

    /// @notice Classify a call into (kind, counterparty, amount).
    /// @dev Length checks are inclusive of the selector: a well-formed
    ///      `transfer(address,uint256)` is 4 + 32 + 32 = 68 bytes. Anything
    ///      shorter cannot be decoded and falls through to `Kind.Other`, where
    ///      the target/selector allowlist is the only thing standing in the way.
    function classify(bytes calldata data)
        internal
        pure
        returns (Kind kind, address counterparty, uint256 amount)
    {
        if (data.length < 4) return (Kind.Other, address(0), 0);
        bytes4 sel = bytes4(data[0:4]);

        if (sel == TRANSFER && data.length >= 68) {
            return (Kind.Transfer, _addressAt(data, 4), _uintAt(data, 36));
        }
        if (sel == APPROVE && data.length >= 68) {
            return (Kind.Approve, _addressAt(data, 4), _uintAt(data, 36));
        }
        if (sel == INCREASE_ALLOWANCE && data.length >= 68) {
            return (Kind.IncreaseAllowance, _addressAt(data, 4), _uintAt(data, 36));
        }
        if (sel == TRANSFER_FROM && data.length >= 100) {
            // (from, to, amount) -- the payee is `to`, at word index 1.
            return (Kind.TransferFrom, _addressAt(data, 36), _uintAt(data, 68));
        }
        return (Kind.Other, address(0), 0);
    }

    function _wordAt(bytes calldata data, uint256 offset) private pure returns (bytes32 w) {
        assembly {
            w := calldataload(add(data.offset, offset))
        }
    }

    function _addressAt(bytes calldata data, uint256 offset) private pure returns (address) {
        return address(uint160(uint256(_wordAt(data, offset))));
    }

    function _uintAt(bytes calldata data, uint256 offset) private pure returns (uint256) {
        return uint256(_wordAt(data, offset));
    }
}
