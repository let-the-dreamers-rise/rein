// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReinAccount} from "../ReinAccount.sol";

/// @notice A target used to prove two things in the test suite: that a
///         permitted call cannot re-enter the account, and that a permitted
///         call cannot reach the account's own admin surface.
contract Sink {
    uint256 public pings;
    address public reenterInto;

    event Ping(uint256 count, uint256 value);

    function ping() external payable {
        pings += 1;
        emit Ping(pings, msg.value);
    }

    function setReenter(address account) external {
        reenterInto = account;
    }

    /// @dev Calls straight back into the account that called us.
    function reenter() external payable {
        ReinAccount(payable(reenterInto)).execute(address(this), 0, abi.encodeCall(Sink.ping, ()), bytes32(uint256(1)));
    }

    /// @dev Tries to make the account grant its caller a guardian seat.
    function escalate(address account, address who) external {
        ReinAccount(payable(account)).setGuardian(who, true);
    }

    receive() external payable {}
}
