// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SafeTransferLib
/// @notice Tiny, dependency-free transfer helpers for ETH and ERC-20 tokens.
/// @dev ERC-20 transfers tolerate tokens that return nothing (USDT-style) but revert
///      when a token returns `false` or when the target has no code. Adapted in spirit
///      from OpenZeppelin's SafeERC20 / Solmate's SafeTransferLib, reduced to the two
///      operations this repo needs so there is no external dependency to audit.
library SafeTransferLib {
    error ETHTransferFailed(address to, uint256 amount);
    error TokenTransferFailed(address token, address to, uint256 amount);

    /// @dev Sends `amount` wei to `to` with all available gas. Reverts on failure.
    function safeTransferETH(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert ETHTransferFailed(to, amount);
    }

    /// @dev Calls `token.transfer(to, amount)`, accepting either no return data or `true`.
    function safeTransfer(address token, address to, uint256 amount) internal {
        if (token.code.length == 0) revert TokenTransferFailed(token, to, amount);
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer(address,uint256)
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) {
            revert TokenTransferFailed(token, to, amount);
        }
    }
}
