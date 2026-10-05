// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ILaneOracle} from "./interfaces/ILaneOracle.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {GovernanceChecks} from "./governance/GovernanceChecks.sol";

/// @title LaneOracle
/// @notice Chainlink pricing for Equity Tokens in USDG units. Each Equity Token feed quotes USD and is
///         converted through the USDG / USD feed, so a USDG depeg is priced rather than ignored.
/// @dev Hardening on top of freshness and positivity:
///      - Bounds: every feed has a [minAnswer, maxAnswer] band. An answer outside it is unpriced, so a
///        misreporting or replaced aggregator cannot value a Lane at an absurd price.
///      - Circuit breaker: an answer that moved more than `maxJumpBps` from the feed's previous round is
///        unpriced until it is `jumpCooldown` old. Deposits and USDG exits wait out the cooldown; in-kind
///        exits never need a price and stay open. The breaker cannot be switched off, only tuned within
///        hard limits.
///      - Governance: the owner is a timelock from construction (checked), and every feed is configured
///        in the constructor, so the deployer never owns this contract.
contract LaneOracle is ILaneOracle, Ownable2Step {
    /// @notice Release of the StockLane contracts this deployment was built from.
    string public constant VERSION = "1.0.0";

    uint256 public constant SEQUENCER_GRACE = 1 hours;
    uint16 public constant MIN_JUMP_BPS = 100;
    uint16 public constant MAX_JUMP_BPS = 5_000;
    uint32 public constant MIN_JUMP_COOLDOWN = 5 minutes;
    uint32 public constant MAX_JUMP_COOLDOWN = 1 days;
    uint16 private constant BPS = 10_000;

    uint8 public immutable usdgDecimals;
    AggregatorV3Interface public immutable usdgFeed;
    uint32 public immutable usdgMaxAge;
    uint256 private immutable usdgFeedUnit;
    uint256 public immutable usdgMinAnswer;
    uint256 public immutable usdgMaxAnswer;

    /// @notice Zero disables the check; Chainlink has not yet published one for Robinhood Chain.
    AggregatorV3Interface public sequencerFeed;

    uint16 public maxJumpBps;
    uint32 public jumpCooldown;

    struct Feed {
        AggregatorV3Interface aggregator;
        uint32 maxAge;
        uint256 scale;
        uint256 minAnswer;
        uint256 maxAnswer;
    }

    struct FeedInit {
        address token;
        AggregatorV3Interface aggregator;
        uint32 maxAge;
        uint256 minAnswer;
        uint256 maxAnswer;
    }

    struct UsdgInit {
        AggregatorV3Interface feed;
        uint32 maxAge;
        uint8 decimals;
        uint256 minAnswer;
        uint256 maxAnswer;
    }

    /// @notice Why a token is or is not priced, for keepers and the app.
    enum Status {
        Ok,
        NoFeed,
        SequencerDown,
        CorporateAction,
        Stale,
        OutOfBounds,
        Jump,
        UsdgStale,
        UsdgOutOfBounds,
        UsdgJump
    }

    mapping(address token => Feed) public feeds;

    event FeedSet(address indexed token, address indexed aggregator, uint32 maxAge, uint256 minAnswer, uint256 maxAnswer);
    event SequencerFeedSet(address indexed feed);
    event BreakerSet(uint16 maxJumpBps, uint32 jumpCooldown);

    error InvalidFeed();
    error InvalidBreaker();
    error Unpriced(address token, Status status);

    constructor(
        address owner_,
        AggregatorV3Interface sequencerFeed_,
        UsdgInit memory usdg,
        uint16 maxJumpBps_,
        uint32 jumpCooldown_,
        FeedInit[] memory initialFeeds
    ) Ownable(owner_) {
        if (
            address(usdg.feed) == address(0) || usdg.maxAge == 0 || usdg.minAnswer == 0
                || usdg.minAnswer >= usdg.maxAnswer
        ) revert InvalidFeed();
        GovernanceChecks.requireTimelock(owner_, msg.sender);
        sequencerFeed = sequencerFeed_;
        usdgFeed = usdg.feed;
        usdgMaxAge = usdg.maxAge;
        usdgFeedUnit = 10 ** usdg.feed.decimals();
        usdgDecimals = usdg.decimals;
        usdgMinAnswer = usdg.minAnswer;
        usdgMaxAnswer = usdg.maxAnswer;
        _setBreaker(maxJumpBps_, jumpCooldown_);
        for (uint256 i; i < initialFeeds.length; ++i) {
            FeedInit memory f = initialFeeds[i];
            _setFeed(f.token, f.aggregator, f.maxAge, f.minAnswer, f.maxAnswer);
        }
    }

    // ---------------------------------------------------------------- governance (timelock)

    /// @param maxAge Longest accepted gap since the last update. Robinhood equity feeds have a 24h
    ///        heartbeat and stop during market closures, so this also decides when weekends go stale.
    /// @param minAnswer Lowest accepted answer, in the aggregator's own decimals (USD).
    /// @param maxAnswer Highest accepted answer, in the aggregator's own decimals (USD).
    function setFeed(address token, AggregatorV3Interface aggregator, uint32 maxAge, uint256 minAnswer, uint256 maxAnswer)
        external
        onlyOwner
    {
        _setFeed(token, aggregator, maxAge, minAnswer, maxAnswer);
    }

    function setSequencerFeed(AggregatorV3Interface feed) external onlyOwner {
        sequencerFeed = feed;
        emit SequencerFeedSet(address(feed));
    }

    function setBreaker(uint16 maxJumpBps_, uint32 jumpCooldown_) external onlyOwner {
        _setBreaker(maxJumpBps_, jumpCooldown_);
    }

    function _setFeed(address token, AggregatorV3Interface aggregator, uint32 maxAge, uint256 minAnswer, uint256 maxAnswer)
        private
    {
        if (token == address(0) || address(aggregator) == address(0) || maxAge == 0 || minAnswer == 0 || minAnswer >= maxAnswer) {
            revert InvalidFeed();
        }
        uint256 exponent = uint256(IERC20Metadata(token).decimals()) + aggregator.decimals();
        if (exponent < usdgDecimals) revert InvalidFeed();
        feeds[token] = Feed(aggregator, maxAge, 10 ** (exponent - usdgDecimals), minAnswer, maxAnswer);
        emit FeedSet(token, address(aggregator), maxAge, minAnswer, maxAnswer);
    }

    function _setBreaker(uint16 maxJumpBps_, uint32 jumpCooldown_) private {
        if (
            maxJumpBps_ < MIN_JUMP_BPS || maxJumpBps_ > MAX_JUMP_BPS || jumpCooldown_ < MIN_JUMP_COOLDOWN
                || jumpCooldown_ > MAX_JUMP_COOLDOWN
        ) revert InvalidBreaker();
        maxJumpBps = maxJumpBps_;
        jumpCooldown = jumpCooldown_;
        emit BreakerSet(maxJumpBps_, jumpCooldown_);
    }

    // ---------------------------------------------------------------- pricing

    function isFresh(address token) external view returns (bool fresh) {
        (Status s,) = _read(token);
        fresh = s == Status.Ok;
    }

    /// @notice Why `token` is or is not priced right now. Never reverts.
    function status(address token) external view returns (Status s) {
        (s,) = _read(token);
    }

    /// @notice The Equity Token price in USDG at the Equity Token feed's decimals. Reverts unless priced.
    function price(address token) external view returns (uint256 p) {
        Status s;
        (s, p) = _read(token);
        if (s != Status.Ok) revert Unpriced(token, s);
    }

    function usdgValue(address token, uint256 amount) external view returns (uint256) {
        (Status s, uint256 p) = _read(token);
        if (s != Status.Ok) revert Unpriced(token, s);
        return Math.mulDiv(amount, p, feeds[token].scale);
    }

    function fromUsdgValue(address token, uint256 usdgAmount) external view returns (uint256) {
        (Status s, uint256 p) = _read(token);
        if (s != Status.Ok) revert Unpriced(token, s);
        return Math.mulDiv(usdgAmount, feeds[token].scale, p);
    }

    /// @dev `p` is the Equity Token price in USDG, at the Equity Token feed's decimals.
    function _read(address token) private view returns (Status, uint256 p) {
        Feed memory f = feeds[token];
        if (address(f.aggregator) == address(0)) return (Status.NoFeed, 0);
        if (!_sequencerUp()) return (Status.SequencerDown, 0);
        if (_corporateActionPending(token)) return (Status.CorporateAction, 0);

        (Status s, uint256 usd) = _checked(f.aggregator, f.maxAge, f.minAnswer, f.maxAnswer);
        if (s != Status.Ok) return (s, 0);
        (Status us, uint256 usdgUsd) = _checked(usdgFeed, usdgMaxAge, usdgMinAnswer, usdgMaxAnswer);
        if (us != Status.Ok) return (Status(uint8(us) + 3), 0); // Stale/OutOfBounds/Jump -> Usdg*
        return (Status.Ok, Math.mulDiv(usd, usdgFeedUnit, usdgUsd));
    }

    /// @dev Returns Ok, Stale, OutOfBounds or Jump.
    function _checked(AggregatorV3Interface feed, uint32 maxAge, uint256 minAnswer, uint256 maxAnswer)
        private
        view
        returns (Status, uint256)
    {
        try feed.latestRoundData() returns (uint80 roundId, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > maxAge) {
                return (Status.Stale, 0);
            }
            uint256 a = uint256(answer);
            if (a < minAnswer || a > maxAnswer) return (Status.OutOfBounds, 0);
            if (block.timestamp - updatedAt < jumpCooldown && !_withinJump(feed, roundId, a)) {
                return (Status.Jump, 0);
            }
            return (Status.Ok, a);
        } catch {
            return (Status.Stale, 0);
        }
    }

    /// @dev Compares a young answer with the previous round. A previous round that cannot be read (first
    ///      round of a new aggregator phase, or an aggregator without history) counts as a jump, so the new
    ///      answer is only trusted once it has aged past the cooldown.
    function _withinJump(AggregatorV3Interface feed, uint80 roundId, uint256 answer) private view returns (bool) {
        if (roundId == 0) return false;
        try feed.getRoundData(roundId - 1) returns (uint80, int256 prev, uint256, uint256 prevUpdatedAt, uint80) {
            if (prev <= 0 || prevUpdatedAt == 0) return false;
            uint256 p = uint256(prev);
            uint256 diff = answer > p ? answer - p : p - answer;
            return diff * BPS <= p * maxJumpBps;
        } catch {
            return false;
        }
    }

    function _sequencerUp() private view returns (bool) {
        AggregatorV3Interface feed = sequencerFeed;
        if (address(feed) == address(0)) return true;
        try feed.latestRoundData() returns (uint80, int256 answer, uint256 startedAt, uint256, uint80) {
            return answer == 0 && startedAt != 0 && block.timestamp - startedAt > SEQUENCER_GRACE;
        } catch {
            return false;
        }
    }

    /// @dev Robinhood Stock Tokens expose `oraclePaused()` while a split or dividend multiplier is
    ///      being applied; prices are unreliable until it clears. Tokens without it are unaffected.
    function _corporateActionPending(address token) private view returns (bool) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("oraclePaused()"));
        return ok && data.length >= 32 && abi.decode(data, (bool));
    }
}
