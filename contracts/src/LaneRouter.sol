// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ILaneOracle} from "./interfaces/ILaneOracle.sol";
import {IUniswapV3Factory, IUniswapV3Pool, IUniswapV3SwapCallback} from "./interfaces/IUniswapV3.sol";
import {GovernanceChecks} from "./governance/GovernanceChecks.sol";

/// @title LaneRouter
/// @notice Exact-input swaps for tokenized stocks on Robinhood Chain, split across up to four legs. Each leg is a
///         path of up to three hops through Uniswap v3 pools (canonical factory only) and Uniswap v4 pools (hookless,
///         or with a timelock-allowlisted hook). Routes are found off chain; the router executes them, charges a small
///         fee in the input token for the $LANE buy-and-burn, and checks the result against Chainlink.
/// @dev Safety properties:
///      - Holds no funds between transactions: every hop must fill its full input, and the output is measured as the
///        router's balance change and sent to the recipient in the same call.
///      - v3 callbacks are accepted only from the pool the router is calling right now, which must be the factory's.
///      - v4 callbacks are accepted only from the PoolManager while the router itself is unlocking it.
///      - Oracle guard: when both tokens are priced by Chainlink, the output may not be worth less than the input by
///        more than `maxOracleDeviationBps`. When a price is unavailable the swap still runs, protected by `minOut`.
///      - The fee is capped in code at 0.3% and can only change through the 48h timelock admin.
contract LaneRouter is AccessControl, Pausable, ReentrancyGuard, IUnlockCallback, IUniswapV3SwapCallback {
    using SafeERC20 for IERC20;
    using BalanceDeltaLibrary for BalanceDelta;

    /// @notice Release of the StockLane contracts this deployment was built from.
    string public constant VERSION = "1.0.0";

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    uint16 public constant MAX_FEE_BPS = 30;
    uint16 public constant MAX_ORACLE_DEVIATION_BPS = 1_000;
    uint256 public constant MAX_LEGS = 4;
    uint256 public constant MAX_HOPS = 3;
    uint16 private constant BPS = 10_000;

    uint8 public constant V3 = 0;
    uint8 public constant V4 = 1;

    IPoolManager public immutable poolManager;
    IUniswapV3Factory public immutable v3Factory;
    ILaneOracle public immutable oracle;
    /// @notice The token every Chainlink price is quoted in (USDG). It needs no feed of its own.
    address public immutable quoteToken;
    /// @notice Receives the swap fee (the FeeRouter, which forwards it to the $LANE buy-and-burn).
    address public immutable feeRecipient;

    uint16 public feeBps;
    uint16 public maxOracleDeviationBps;
    mapping(address hook => bool) public hookAllowed;

    /// @dev Set only while the router is inside its own pool call; checked by the callbacks.
    address private _activeV3Pool;
    bool private _unlocking;
    bool private _quoting;

    struct Hop {
        uint8 kind; // V3 or V4
        address tokenOut; // address(0) = native ETH, only between two v4 hops
        uint24 fee;
        int24 tickSpacing; // v4 only
        address hooks; // v4 only
    }

    struct Leg {
        uint256 amountIn;
        Hop[] hops;
    }

    event Swapped(
        address indexed sender,
        address indexed recipient,
        address indexed tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee
    );
    event FeeSet(uint16 bps);
    event OracleDeviationSet(uint16 bps);
    event HookAllowed(address indexed hook, bool allowed);
    event Swept(address indexed token, address indexed to, uint256 amount);

    error InvalidConfig();
    error InvalidRoute();
    error Expired();
    error PartialFill();
    error InsufficientOutput(uint256 amountOut, uint256 minOut);
    error OracleDeviation(uint256 valueOut, uint256 valueIn);
    error Unauthorized();
    error QuoteResult(uint256 amountOut);

    struct Config {
        IPoolManager poolManager;
        IUniswapV3Factory v3Factory;
        ILaneOracle oracle;
        address quoteToken;
        address feeRecipient;
        address admin;
        address guardian;
        uint16 feeBps;
        uint16 maxOracleDeviationBps;
        address[] hooks;
    }

    constructor(Config memory c) {
        if (
            address(c.poolManager) == address(0) || address(c.v3Factory) == address(0) || address(c.oracle) == address(0)
                || c.quoteToken == address(0) || c.feeRecipient == address(0) || c.guardian == address(0)
                || c.guardian == c.admin || c.guardian == msg.sender
        ) revert InvalidConfig();
        GovernanceChecks.requireTimelock(c.admin, msg.sender);
        poolManager = c.poolManager;
        v3Factory = c.v3Factory;
        oracle = c.oracle;
        quoteToken = c.quoteToken;
        feeRecipient = c.feeRecipient;
        _setFee(c.feeBps);
        _setOracleDeviation(c.maxOracleDeviationBps);
        for (uint256 i; i < c.hooks.length; ++i) {
            _setHookAllowed(c.hooks[i], true);
        }
        _grantRole(DEFAULT_ADMIN_ROLE, c.admin);
        _grantRole(GUARDIAN_ROLE, c.guardian);
    }

    // ---------------------------------------------------------------- swaps

    /// @notice Swaps exactly `amountIn` of `tokenIn` for at least `minOut` of `tokenOut`, sent to `recipient`.
    /// @param legs Split of `amountIn - fee(amountIn)` across up to four paths; amounts must add up exactly.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient,
        uint256 deadline,
        Leg[] calldata legs
    ) external nonReentrant whenNotPaused returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert Expired();
        if (recipient == address(0)) revert InvalidRoute();
        uint256 fee = _checkRoute(tokenIn, tokenOut, amountIn, legs);

        IERC20 inToken = IERC20(tokenIn);
        uint256 inBefore = inToken.balanceOf(address(this));
        inToken.safeTransferFrom(msg.sender, address(this), amountIn);
        if (inToken.balanceOf(address(this)) - inBefore != amountIn) revert InvalidRoute(); // fee-on-transfer tokens
        if (fee != 0) inToken.safeTransfer(feeRecipient, fee);

        IERC20 outToken = IERC20(tokenOut);
        uint256 outBefore = outToken.balanceOf(address(this));
        for (uint256 i; i < legs.length; ++i) {
            _runLeg(tokenIn, legs[i]);
        }
        amountOut = outToken.balanceOf(address(this)) - outBefore;
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);
        _checkOracle(tokenIn, amountIn - fee, tokenOut, amountOut);

        outToken.safeTransfer(recipient, amountOut);
        emit Swapped(msg.sender, recipient, tokenIn, tokenOut, amountIn, amountOut, fee);
    }

    /// @notice What `swap` would return for this route right now, without moving any tokens. Not a view (it
    ///         simulates the pool swaps and reverts them), so call it with eth_call. Ignores the oracle guard; see
    ///         `oracleCheck` for that.
    /// @dev Legs are quoted independently, so two legs through the same pool are each quoted against its current state.
    function quote(address tokenIn, address tokenOut, uint256 amountIn, Leg[] calldata legs)
        external
        nonReentrant
        returns (uint256 amountOut, uint256 fee)
    {
        fee = _checkRoute(tokenIn, tokenOut, amountIn, legs);
        _quoting = true;
        for (uint256 i; i < legs.length; ++i) {
            amountOut += _quoteLeg(tokenIn, legs[i]);
        }
        _quoting = false;
    }

    /// @notice Whether a swap of `amountIn` (after fee) for `amountOut` passes the oracle guard, and both values.
    ///         `priced` is false when either token has no fresh Chainlink price (the guard is then skipped).
    function oracleCheck(address tokenIn, uint256 amountInAfterFee, address tokenOut, uint256 amountOut)
        public
        view
        returns (bool ok, bool priced, uint256 valueIn, uint256 valueOut)
    {
        (bool pin, uint256 vin) = _value(tokenIn, amountInAfterFee);
        (bool pout, uint256 vout) = _value(tokenOut, amountOut);
        priced = pin && pout;
        if (!priced) return (true, false, vin, vout);
        ok = vout * BPS >= vin * (BPS - maxOracleDeviationBps);
        return (ok, true, vin, vout);
    }

    function feeFor(uint256 amountIn) public view returns (uint256) {
        return (amountIn * feeBps) / BPS;
    }

    // ---------------------------------------------------------------- route execution

    function _checkRoute(address tokenIn, address tokenOut, uint256 amountIn, Leg[] calldata legs)
        private
        view
        returns (uint256 fee)
    {
        if (
            tokenIn == address(0) || tokenOut == address(0) || tokenIn == tokenOut || amountIn == 0 || legs.length == 0
                || legs.length > MAX_LEGS
        ) revert InvalidRoute();
        fee = feeFor(amountIn);
        uint256 total;
        for (uint256 i; i < legs.length; ++i) {
            Hop[] calldata hops = legs[i].hops;
            if (hops.length == 0 || hops.length > MAX_HOPS || legs[i].amountIn == 0) revert InvalidRoute();
            if (hops[hops.length - 1].tokenOut != tokenOut) revert InvalidRoute();
            address prev = tokenIn;
            for (uint256 h; h < hops.length; ++h) {
                Hop calldata hop = hops[h];
                if (hop.tokenOut == prev) revert InvalidRoute();
                if (hop.kind == V3) {
                    // Native ETH can only pass between two v4 hops, never in or out of a v3 pool.
                    if (prev == address(0) || hop.tokenOut == address(0)) revert InvalidRoute();
                } else if (hop.kind == V4) {
                    if (hop.hooks != address(0) && !hookAllowed[hop.hooks]) revert InvalidRoute();
                    if (hop.tokenOut == address(0) && (h + 1 == hops.length || hops[h + 1].kind != V4)) revert InvalidRoute();
                } else {
                    revert InvalidRoute();
                }
                prev = hop.tokenOut;
            }
            total += legs[i].amountIn;
        }
        if (total != amountIn - fee) revert InvalidRoute();
    }

    /// @dev Runs one leg: v3 hops one by one, each run of consecutive v4 hops inside a single PoolManager unlock.
    function _runLeg(address tokenIn, Leg calldata leg) private {
        uint256 amount = leg.amountIn;
        address token = tokenIn;
        uint256 h;
        while (h < leg.hops.length) {
            if (leg.hops[h].kind == V3) {
                amount = _v3Hop(token, leg.hops[h], amount);
                token = leg.hops[h].tokenOut;
                ++h;
            } else {
                uint256 end = h;
                while (end < leg.hops.length && leg.hops[end].kind == V4) ++end;
                amount = _v4Segment(token, leg.hops[h:end], amount);
                token = leg.hops[end - 1].tokenOut;
                h = end;
            }
        }
    }

    function _quoteLeg(address tokenIn, Leg calldata leg) private returns (uint256 amount) {
        amount = leg.amountIn;
        address token = tokenIn;
        uint256 h;
        while (h < leg.hops.length) {
            uint256 end = h + 1;
            if (leg.hops[h].kind == V4) {
                while (end < leg.hops.length && leg.hops[end].kind == V4) ++end;
            }
            try this.quoteSegment(token, leg.hops[h:end], amount) {
                revert InvalidRoute(); // quoteSegment always reverts
            } catch (bytes memory reason) {
                amount = _decodeQuote(reason);
            }
            token = leg.hops[end - 1].tokenOut;
            h = end;
        }
    }

    /// @notice Internal: simulates one v3 hop or one run of v4 hops and reverts with QuoteResult. Only the router
    ///         may call it, from `quote`.
    function quoteSegment(address tokenIn, Hop[] calldata hops, uint256 amountIn) external {
        if (msg.sender != address(this) || !_quoting) revert Unauthorized();
        uint256 out = hops[0].kind == V3 ? _v3Hop(tokenIn, hops[0], amountIn) : _v4Segment(tokenIn, hops, amountIn);
        revert QuoteResult(out);
    }

    function _decodeQuote(bytes memory reason) private pure returns (uint256 out) {
        if (reason.length != 36 || bytes4(reason) != QuoteResult.selector) {
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }
        assembly {
            out := mload(add(reason, 36))
        }
    }

    // ---------------------------------------------------------------- Uniswap v3

    function _v3Hop(address tokenIn, Hop calldata hop, uint256 amountIn) private returns (uint256 amountOut) {
        address pool = v3Factory.getPool(tokenIn, hop.tokenOut, hop.fee);
        if (pool == address(0) || amountIn > uint256(type(int256).max)) revert InvalidRoute();
        bool zeroForOne = tokenIn < hop.tokenOut;
        _activeV3Pool = pool;
        (int256 a0, int256 a1) = IUniswapV3Pool(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
            abi.encode(tokenIn, hop.tokenOut, hop.fee)
        );
        _activeV3Pool = address(0);
        (int256 paid, int256 received) = zeroForOne ? (a0, a1) : (a1, a0);
        if (paid <= 0 || uint256(paid) != amountIn || received >= 0) revert PartialFill();
        amountOut = uint256(-received);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (msg.sender != _activeV3Pool || msg.sender == address(0)) revert Unauthorized();
        (address tokenIn, address tokenOut, uint24 fee) = abi.decode(data, (address, address, uint24));
        if (v3Factory.getPool(tokenIn, tokenOut, fee) != msg.sender) revert Unauthorized();
        if (_quoting) {
            int256 out = tokenIn < tokenOut ? amount1Delta : amount0Delta;
            revert QuoteResult(uint256(-out));
        }
        int256 owed = tokenIn < tokenOut ? amount0Delta : amount1Delta;
        if (owed > 0) IERC20(tokenIn).safeTransfer(msg.sender, uint256(owed));
    }

    // ---------------------------------------------------------------- Uniswap v4

    function _v4Segment(address tokenIn, Hop[] calldata hops, uint256 amountIn) private returns (uint256) {
        if (amountIn > uint256(type(int256).max)) revert InvalidRoute();
        _unlocking = true;
        bytes memory result = poolManager.unlock(abi.encode(tokenIn, hops, amountIn));
        _unlocking = false;
        return abi.decode(result, (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !_unlocking) revert Unauthorized();
        (address tokenIn, Hop[] memory hops, uint256 amountIn) = abi.decode(data, (address, Hop[], uint256));

        uint256 amount = amountIn;
        address token = tokenIn;
        for (uint256 i; i < hops.length; ++i) {
            Hop memory hop = hops[i];
            if (hop.hooks != address(0) && !hookAllowed[hop.hooks]) revert InvalidRoute();
            (address c0, address c1) = token < hop.tokenOut ? (token, hop.tokenOut) : (hop.tokenOut, token);
            PoolKey memory key = PoolKey({
                currency0: Currency.wrap(c0),
                currency1: Currency.wrap(c1),
                fee: hop.fee,
                tickSpacing: hop.tickSpacing,
                hooks: IHooks(hop.hooks)
            });
            bool zeroForOne = token == c0;
            BalanceDelta delta = poolManager.swap(
                key,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: -int256(amount),
                    sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                }),
                bytes("")
            );
            int128 paid = zeroForOne ? delta.amount0() : delta.amount1();
            int128 received = zeroForOne ? delta.amount1() : delta.amount0();
            if (paid >= 0 || uint256(uint128(-paid)) != amount || received <= 0) revert PartialFill();
            amount = uint256(uint128(received));
            token = hop.tokenOut;
        }
        if (_quoting) revert QuoteResult(amount);

        poolManager.sync(Currency.wrap(tokenIn));
        IERC20(tokenIn).safeTransfer(address(poolManager), amountIn);
        poolManager.settle();
        poolManager.take(Currency.wrap(token), address(this), amount);
        return abi.encode(amount);
    }

    // ---------------------------------------------------------------- oracle

    /// @dev USDG value of `amount` of `token`, and whether it is priced. USDG is worth its own amount.
    function _value(address token, uint256 amount) private view returns (bool, uint256) {
        if (token == quoteToken) return (true, amount);
        if (!oracle.isFresh(token)) return (false, 0);
        return (true, oracle.usdgValue(token, amount));
    }

    function _checkOracle(address tokenIn, uint256 amountInAfterFee, address tokenOut, uint256 amountOut) private view {
        (bool ok,, uint256 vin, uint256 vout) = oracleCheck(tokenIn, amountInAfterFee, tokenOut, amountOut);
        if (!ok) revert OracleDeviation(vout, vin);
    }

    // ---------------------------------------------------------------- governance

    function setFeeBps(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setFee(bps);
    }

    function setMaxOracleDeviationBps(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setOracleDeviation(bps);
    }

    function setHookAllowed(address hook, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setHookAllowed(hook, allowed);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Recovers tokens sent to the router by mistake. The router holds nothing between swaps, so this can
    ///         never touch a user's swap. Admin (timelock) only.
    function sweep(IERC20 token, address to) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert InvalidConfig();
        uint256 amount = token.balanceOf(address(this));
        token.safeTransfer(to, amount);
        emit Swept(address(token), to, amount);
    }

    function _setFee(uint16 bps) private {
        if (bps > MAX_FEE_BPS) revert InvalidConfig();
        feeBps = bps;
        emit FeeSet(bps);
    }

    function _setOracleDeviation(uint16 bps) private {
        if (bps == 0 || bps > MAX_ORACLE_DEVIATION_BPS) revert InvalidConfig();
        maxOracleDeviationBps = bps;
        emit OracleDeviationSet(bps);
    }

    function _setHookAllowed(address hook, bool allowed) private {
        if (hook == address(0)) revert InvalidConfig();
        hookAllowed[hook] = allowed;
        emit HookAllowed(hook, allowed);
    }
}
