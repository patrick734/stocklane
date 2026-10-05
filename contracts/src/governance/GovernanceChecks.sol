// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title GovernanceChecks
/// @notice Constructor-time checks that make every StockLane contract refuse to deploy with an
///         admin the deployer could use to rug depositors.
/// @dev The deploying account (`msg.sender` of the constructor) must end up with no power at all:
///      - the admin must be an OpenZeppelin TimelockController with at least MIN_TIMELOCK_DELAY,
///      - the deployer must not be able to administer, propose to, execute on, or cancel that timelock,
///      - the guardian and keeper must be other accounts than the deployer and the admin.
///      Configuration is passed to constructors instead of being set afterwards, so no contract ever
///      has a window in which the deployer owns it.
library GovernanceChecks {
    uint256 internal constant MIN_TIMELOCK_DELAY = 48 hours;

    error AdminNotTimelock(address admin);
    error TimelockDelayTooShort(uint256 delay);
    error DeployerControlsTimelock(address deployer);
    error RoleCollision();

    /// @param admin The address that will hold DEFAULT_ADMIN_ROLE / ownership.
    /// @param deployer The account deploying the contract (pass `msg.sender` from the constructor).
    function requireTimelock(address admin, address deployer) internal view {
        if (admin.code.length == 0) revert AdminNotTimelock(admin);
        TimelockController tl = TimelockController(payable(admin));
        uint256 delay;
        try tl.getMinDelay() returns (uint256 d) {
            delay = d;
        } catch {
            revert AdminNotTimelock(admin);
        }
        if (delay < MIN_TIMELOCK_DELAY) revert TimelockDelayTooShort(delay);
        if (
            tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), deployer) || tl.hasRole(tl.PROPOSER_ROLE(), deployer)
                || tl.hasRole(tl.EXECUTOR_ROLE(), deployer) || tl.hasRole(tl.CANCELLER_ROLE(), deployer)
        ) revert DeployerControlsTimelock(deployer);
    }

    /// @notice Timelock admin plus distinct guardian and keeper, neither of which is the deployer.
    function requireRoles(address admin, address guardian, address keeper, address deployer) internal view {
        requireTimelock(admin, deployer);
        if (
            guardian == address(0) || keeper == address(0) || guardian == admin || keeper == admin
                || guardian == keeper || guardian == deployer || keeper == deployer
        ) revert RoleCollision();
    }
}
