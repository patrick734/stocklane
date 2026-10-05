// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title LaneToken (local demo and tests only)
/// @notice Stand-in for the Pons-launched $LANE: fixed supply, burnable. Never deployed on mainnet.
contract LaneToken is ERC20, ERC20Burnable {
    constructor(address recipient, uint256 supply) ERC20("StockLane", "LANE") {
        _mint(recipient, supply);
    }
}
