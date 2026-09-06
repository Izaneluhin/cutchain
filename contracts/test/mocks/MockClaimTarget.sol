// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Stand-in for the Pons locker. Records how it was called and pays `payout` ETH (or a
///      token) back to the caller so the test can see fees "arrive" in CutPool.
contract MockClaimTarget {
    address public lastCaller;
    bytes public lastData;
    uint256 public lastValue;
    uint256 public calls;

    address public feeRedirect;
    uint256 public payout;

    receive() external payable {}

    function setPayout(uint256 amount) external {
        payout = amount;
    }

    /// @dev Hypothetical creator-fee claim; signature deliberately arbitrary.
    function collectFees(address token) external payable returns (uint256 paid) {
        lastCaller = msg.sender;
        lastData = msg.data;
        lastValue = msg.value;
        calls++;
        paid = payout;
        if (paid != 0) {
            (bool ok,) = msg.sender.call{value: paid}("");
            require(ok, "payout failed");
        }
        token; // silence unused warning
    }

    /// @dev A privileged function that must NOT be reachable through CutPool.claim.
    function setFeeRedirect(address, address newFeeWallet) external {
        lastCaller = msg.sender;
        feeRedirect = newFeeWallet;
    }

    function alwaysReverts() external pure {
        revert("locker: nothing to claim");
    }
}
