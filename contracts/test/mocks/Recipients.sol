// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IDistribute {
    function distribute() external;
}

/// @dev Recipient that refuses ETH.
contract RejectsETH {
    // no receive / fallback
}

/// @dev Recipient that tries to re-enter `distribute()` when paid.
contract Reenterer {
    bool public reentryReverted;
    bytes public reentryError;

    receive() external payable {
        try IDistribute(msg.sender).distribute() {
            reentryReverted = false;
        } catch (bytes memory err) {
            reentryReverted = true;
            reentryError = err;
        }
    }
}
