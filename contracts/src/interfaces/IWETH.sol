// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The two WETH9 functions CutPool relies on.
interface IWETH {
    function balanceOf(address account) external view returns (uint256);
    function withdraw(uint256 amount) external;
}
