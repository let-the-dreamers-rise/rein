// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReinAccount} from "./ReinAccount.sol";

/// @title ReinFactory
/// @notice Deterministic deployment, so an account's address can be shown to a
///         user (and funded from an exchange withdrawal) before it exists.
contract ReinFactory {
    event AccountCreated(address indexed account, address indexed owner, bytes32 salt);

    function createAccount(address owner_, bytes32 salt) external returns (address account) {
        account = addressOf(owner_, salt);
        if (account.code.length != 0) return account;
        account = address(new ReinAccount{salt: _salt(owner_, salt)}(owner_));
        emit AccountCreated(account, owner_, salt);
    }

    function addressOf(address owner_, bytes32 salt) public view returns (address) {
        bytes32 initCodeHash =
            keccak256(abi.encodePacked(type(ReinAccount).creationCode, abi.encode(owner_)));
        bytes32 h = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), _salt(owner_, salt), initCodeHash)
        );
        return address(uint160(uint256(h)));
    }

    /// @dev The owner is folded into the salt so two owners cannot race for the
    ///      same address with the same user-chosen salt.
    function _salt(address owner_, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(owner_, salt));
    }
}
