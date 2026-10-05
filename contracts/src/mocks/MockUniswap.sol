// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IUniswapV3SwapCallback} from "../interfaces/IUniswapV3.sol";

// Test doubles only. Never deploy to a live network.
// Pools trade at a fixed rate (WAD: out = in * rate / 1e18) and can be told to fill only part of an input,
// as a real pool does when it reaches its price limit.

contract MockV3Factory {
    mapping(address => mapping(address => mapping(uint24 => address))) public getPool;

    function createPool(address a, address b, uint24 fee, uint256 rateAtoB, uint256 rateBtoA) external returns (MockV3Pool pool) {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        (uint256 r01, uint256 r10) = a < b ? (rateAtoB, rateBtoA) : (rateBtoA, rateAtoB);
        pool = new MockV3Pool(t0, t1, r01, r10);
        getPool[a][b][fee] = address(pool);
        getPool[b][a][fee] = address(pool);
    }
}

contract MockV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint256 public rate01;
    uint256 public rate10;
    /// @dev When nonzero, only this share (bps) of the input is used.
    uint256 public fillBps;

    constructor(address t0, address t1, uint256 r01, uint256 r10) {
        token0 = t0;
        token1 = t1;
        rate01 = r01;
        rate10 = r10;
    }

    function setFillBps(uint256 bps) external {
        fillBps = bps;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(amountSpecified > 0, "exact in only");
        uint256 amountIn = uint256(amountSpecified);
        if (fillBps != 0) amountIn = (amountIn * fillBps) / 10_000;
        uint256 out = Math.mulDiv(amountIn, zeroForOne ? rate01 : rate10, 1e18);
        (address tin, address tout) = zeroForOne ? (token0, token1) : (token1, token0);
        IERC20(tout).transfer(recipient, out);
        (amount0, amount1) = zeroForOne ? (int256(amountIn), -int256(out)) : (-int256(out), int256(amountIn));
        uint256 before = IERC20(tin).balanceOf(address(this));
        IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        require(IERC20(tin).balanceOf(address(this)) >= before + amountIn, "IIA");
    }

    /// @dev Calls the callback without a swap, to test that routers reject unsolicited callbacks.
    function poke(address target, int256 a0, int256 a1, bytes calldata data) external {
        IUniswapV3SwapCallback(target).uniswapV3SwapCallback(a0, a1, data);
    }
}

/// @dev Minimal PoolManager: unlock, swap, sync, settle, take, with per-currency delta accounting that must net to
///      zero by the end of every unlock.
contract MockPoolManager {
    mapping(bytes32 => uint256) public rate01;
    mapping(bytes32 => uint256) public rate10;
    mapping(bytes32 => uint256) public fillBps;
    mapping(address => int256) public delta;
    address[] private _touched;
    bool public unlocked;
    address private _synced;
    uint256 private _syncedBalance;

    function poolId(PoolKey memory key) public pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    function setPool(PoolKey memory key, uint256 r01, uint256 r10) external {
        bytes32 id = poolId(key);
        rate01[id] = r01;
        rate10[id] = r10;
    }

    function setFillBps(PoolKey memory key, uint256 bps) external {
        fillBps[poolId(key)] = bps;
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        require(!unlocked, "AlreadyUnlocked");
        unlocked = true;
        result = IUnlockCallback(msg.sender).unlockCallback(data);
        for (uint256 i; i < _touched.length; ++i) {
            require(delta[_touched[i]] == 0, "CurrencyNotSettled");
        }
        delete _touched;
        unlocked = false;
    }

    function swap(PoolKey memory key, SwapParams memory params, bytes calldata) external returns (BalanceDelta) {
        require(unlocked, "ManagerLocked");
        bytes32 id = poolId(key);
        uint256 r = params.zeroForOne ? rate01[id] : rate10[id];
        require(r != 0, "PoolNotInitialized");
        require(params.amountSpecified < 0, "exact in only");
        uint256 amountIn = uint256(-params.amountSpecified);
        if (fillBps[id] != 0) amountIn = (amountIn * fillBps[id]) / 10_000;
        uint256 out = Math.mulDiv(amountIn, r, 1e18);
        (address cin, address cout) = params.zeroForOne
            ? (Currency.unwrap(key.currency0), Currency.unwrap(key.currency1))
            : (Currency.unwrap(key.currency1), Currency.unwrap(key.currency0));
        _account(cin, -int256(amountIn));
        _account(cout, int256(out));
        return params.zeroForOne
            ? toBalanceDelta(-int128(int256(amountIn)), int128(int256(out)))
            : toBalanceDelta(int128(int256(out)), -int128(int256(amountIn)));
    }

    function sync(Currency currency) external {
        _synced = Currency.unwrap(currency);
        _syncedBalance = IERC20(_synced).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        paid = IERC20(_synced).balanceOf(address(this)) - _syncedBalance;
        _account(_synced, int256(paid));
        _synced = address(0);
    }

    function take(Currency currency, address to, uint256 amount) external {
        _account(Currency.unwrap(currency), -int256(amount));
        IERC20(Currency.unwrap(currency)).transfer(to, amount);
    }

    function _account(address currency, int256 d) private {
        delta[currency] += d;
        _touched.push(currency);
    }
}
