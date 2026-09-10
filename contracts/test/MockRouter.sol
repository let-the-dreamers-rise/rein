// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice A stand-in for a DEX router, so the v2 demo has a permitted call
///         that moves no tokens through the account's own transfer path and
///         therefore exercises the target and selector allowlists on their own.
contract MockRouter {
    event Swap(address indexed caller, address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut);

    function swapExact(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        external
        returns (uint256)
    {
        emit Swap(msg.sender, tokenIn, tokenOut, amountIn, minOut);
        return amountIn;
    }

    /// @dev A second entry point the shadow agent never uses, so the compiled
    ///      policy should refuse it even though the router itself is allowed.
    function swapAny(address tokenIn, address tokenOut, uint256 amountIn) external returns (uint256) {
        emit Swap(msg.sender, tokenIn, tokenOut, amountIn, 0);
        return amountIn;
    }
}
