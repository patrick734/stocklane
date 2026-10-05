// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

// Test doubles only. Never deploy to a live network.

contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Mirrors the Robinhood Stock Token corporate-action flag.
contract MockStockToken is MockERC20 {
    bool public oraclePaused;

    constructor(string memory name_, string memory symbol_) MockERC20(name_, symbol_, 18) {}

    function setOraclePaused(bool paused) external {
        oraclePaused = paused;
    }
}

/// @dev Chainlink-style feed with round history. The constructor writes two identical rounds so the
///      first answer already has a previous round to be compared with by the circuit breaker.
contract MockAggregator {
    struct Round {
        int256 answer;
        uint256 startedAt;
        uint256 updatedAt;
    }

    uint8 public immutable decimals;
    uint80 public latestRound;
    mapping(uint80 => Round) public rounds;
    bool public historyDisabled;

    constructor(uint8 decimals_, int256 answer_) {
        decimals = decimals_;
        _push(answer_, block.timestamp, block.timestamp);
        _push(answer_, block.timestamp, block.timestamp);
    }

    function answer() external view returns (int256) {
        return rounds[latestRound].answer;
    }

    function updatedAt() external view returns (uint256) {
        return rounds[latestRound].updatedAt;
    }

    function set(int256 answer_, uint256 startedAt_, uint256 updatedAt_) external {
        _push(answer_, startedAt_, updatedAt_);
    }

    function setAnswer(int256 answer_) external {
        _push(answer_, block.timestamp, block.timestamp);
    }

    /// @dev Simulates a feed whose previous rounds cannot be read (for example a new aggregator phase).
    function disableHistory(bool disabled) external {
        historyDisabled = disabled;
    }

    function _push(int256 answer_, uint256 startedAt_, uint256 updatedAt_) private {
        latestRound += 1;
        rounds[latestRound] = Round(answer_, startedAt_, updatedAt_);
    }

    function getRoundData(uint80 id) external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!historyDisabled && id != 0 && id <= latestRound, "no data present");
        Round memory r = rounds[id];
        return (id, r.answer, r.startedAt, r.updatedAt, id);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = rounds[latestRound];
        return (latestRound, r.answer, r.startedAt, r.updatedAt, latestRound);
    }
}

contract MockSwapAdapter is ISwapAdapter {
    mapping(address => mapping(address => uint256)) public rate;

    function setRate(address tokenIn, address tokenOut, uint256 rateWad) external {
        rate[tokenIn][tokenOut] = rateWad;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient, bytes calldata)
        external
        returns (uint256 amountOut)
    {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        amountOut = Math.mulDiv(amountIn, rate[tokenIn][tokenOut], 1e18);
        require(amountOut >= minOut, "min out");
        IERC20(tokenOut).transfer(recipient, amountOut);
    }
}

/// @dev Burns 1% of every transfer.
contract MockFeeOnTransfer is ERC20 {
    constructor() ERC20("Taxed", "TAX") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 tax = value / 100;
            super._update(from, address(0), tax);
            value -= tax;
        }
        super._update(from, to, value);
    }
}
