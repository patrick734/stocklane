// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";
import {LaneRouter} from "./LaneRouter.sol";

/// @title LaneRouterAdapter
/// @notice Lets DrawdownRetire buy $LANE through LaneRouter, so fees collected in any token can reach the $LANE
///         pool (for example AMD -> USDG -> ETH -> $LANE through the Pons pool).
/// @dev No owner and no state: it holds tokens only inside one call. `route` is `abi.encode(LaneRouter.Leg[])`,
///      split over `amountIn` minus the router fee, exactly as LaneRouter.swap expects. DrawdownRetire measures
///      what it receives itself, so it does not trust this adapter's return value.
contract LaneRouterAdapter is ISwapAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Release of the StockLane contracts this deployment was built from.
    string public constant VERSION = "1.0.0";

    LaneRouter public immutable router;

    error InvalidRoute();

    constructor(LaneRouter router_) {
        if (address(router_) == address(0)) revert InvalidRoute();
        router = router_;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient, bytes calldata route)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        if (route.length == 0) revert InvalidRoute();
        LaneRouter.Leg[] memory legs = abi.decode(route, (LaneRouter.Leg[]));
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(address(router), amountIn);
        amountOut = router.swap(tokenIn, tokenOut, amountIn, minOut, recipient, block.timestamp, legs);
        IERC20(tokenIn).forceApprove(address(router), 0);
    }
}
