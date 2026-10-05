// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {GovernanceChecks} from "./governance/GovernanceChecks.sol";

/// @title FeeRouter
/// @notice Receives every Lane's protocol share and forwards all of it to DrawdownRetire.
///         Anyone may call `route`. Changing the destination takes CHANGE_DELAY on top of the
///         owner's own timelock, so holders can watch it coming.
contract FeeRouter is Ownable2Step, ReentrancyGuard {
    /// @notice Release of the StockLane contracts this deployment was built from.
    string public constant VERSION = "1.0.0";

    using SafeERC20 for IERC20;

    uint256 public constant CHANGE_DELAY = 48 hours;

    address public drawdownRetire;
    address public pendingDrawdownRetire;
    uint64 public pendingSince;

    mapping(address token => uint256) public totalRouted;

    event Routed(address indexed token, address indexed to, uint256 amount);
    event DestinationProposed(address indexed next, uint256 executableAt);
    event DestinationChanged(address indexed previous, address indexed next);
    event DestinationProposalCancelled(address indexed next);

    error InvalidAddress();
    error NotReady();
    error NothingPending();

    constructor(address owner_, address drawdownRetire_) Ownable(owner_) {
        if (drawdownRetire_ == address(0)) revert InvalidAddress();
        GovernanceChecks.requireTimelock(owner_, msg.sender);
        drawdownRetire = drawdownRetire_;
    }

    function route(IERC20 token) external nonReentrant returns (uint256 amount) {
        amount = _route(token);
    }

    function routeMany(IERC20[] calldata tokens) external nonReentrant {
        for (uint256 i; i < tokens.length; ++i) {
            _route(tokens[i]);
        }
    }

    function _route(IERC20 token) private returns (uint256 amount) {
        amount = token.balanceOf(address(this));
        if (amount == 0) return 0;
        totalRouted[address(token)] += amount;
        token.safeTransfer(drawdownRetire, amount);
        emit Routed(address(token), drawdownRetire, amount);
    }

    function proposeDestination(address next) external onlyOwner {
        if (next == address(0) || next == drawdownRetire) revert InvalidAddress();
        pendingDrawdownRetire = next;
        pendingSince = uint64(block.timestamp);
        emit DestinationProposed(next, block.timestamp + CHANGE_DELAY);
    }

    function executeDestination() external onlyOwner {
        address next = pendingDrawdownRetire;
        if (next == address(0)) revert NothingPending();
        if (block.timestamp < uint256(pendingSince) + CHANGE_DELAY) revert NotReady();
        emit DestinationChanged(drawdownRetire, next);
        drawdownRetire = next;
        delete pendingDrawdownRetire;
        delete pendingSince;
    }

    function cancelDestination() external onlyOwner {
        address next = pendingDrawdownRetire;
        if (next == address(0)) revert NothingPending();
        delete pendingDrawdownRetire;
        delete pendingSince;
        emit DestinationProposalCancelled(next);
    }
}
