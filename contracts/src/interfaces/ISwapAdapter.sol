// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Wraps the Uniswap v4 router. Callers must enforce their own minimum output and
/// verify the received balance; the adapter is not trusted to report amounts honestly.
interface ISwapAdapter {
    /// @notice Pulls `amountIn` of `tokenIn` from the caller and sends at least `minOut` of
    /// `tokenOut` to `recipient`. An empty `route` uses the adapter's default pool for the pair.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient,
        bytes calldata route
    ) external returns (uint256 amountOut);
}
