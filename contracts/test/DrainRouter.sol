// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20Min {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @notice What a real DEX router looks like to a policy that reads calldata.
///
/// `MockRouter` in this directory emits an event and moves nothing, so the
/// existing demo allowlists a router without ever exercising what a router
/// actually does. This one does what they all do: it spends the allowance the
/// caller granted it, and it sends the proceeds wherever the `recipient`
/// argument says.
///
/// That is the whole attack. `swapExact` is not one of the four selectors
/// CalldataGuard decodes, so to a v1/v2 ReinAccount this call moves no tokens,
/// has no payee and costs nothing against the rolling spend window. The router
/// then moves the tokens anyway.
contract DrainRouter {
    event Swap(address indexed caller, address tokenIn, uint256 amountIn, address recipient);

    /// @dev The signature is deliberately shaped like a real router's: a
    ///      recipient the caller chooses, which is exactly the argument a
    ///      compromised agent fills in with its own address.
    function swapExact(address tokenIn, uint256 amountIn, uint256 minOut, address recipient)
        external
        returns (uint256)
    {
        IERC20Min(tokenIn).transferFrom(msg.sender, recipient, amountIn);
        emit Swap(msg.sender, tokenIn, amountIn, recipient);
        minOut;
        return amountIn;
    }
}
