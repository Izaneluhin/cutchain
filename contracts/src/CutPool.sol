// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IWETH} from "./interfaces/IWETH.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";

/// @title CutPool
/// @notice Immutable fee splitter for CUT creator revenue.
///
/// Anything that lands in this contract (ETH, WETH, CUT, any ERC-20) can be split by
/// *anyone* across a fixed list of recipients according to basis-point weights fixed at
/// deployment. There is no owner, no upgrade path, no generic `execute`, and the only
/// outbound call the contract can make on someone's behalf is a single, selector-locked
/// call to `claimTarget` (the Pons locker) so that anyone can trigger the creator-fee
/// claim when CutPool itself is registered as the creator / fee wallet of the token.
///
/// Rounding: every recipient except the last receives `floor(amount * bps / 10_000)`;
/// the last recipient receives whatever is left, so rounding dust (at most
/// `recipients.length - 1` wei per distribution) is never stranded in the contract.
///
/// Trust model:
///   * Recipients and weights are immutable. Nobody can redirect funds after deployment.
///   * `distribute`, `distributeToken`, `unwrapWETH` and `claim` are permissionless.
///   * Recipients must be able to receive plain ETH transfers (EOAs or contracts with a
///     `receive()`); if one recipient rejects ETH the whole ETH distribution reverts.
///   * `claimTarget` must be the Pons locker (or whichever contract pays creator fees),
///     never a token contract, and `claimSelector` must be that contract's claim function.
///     Locking the selector prevents anyone from using CutPool's identity as the token's
///     creator to call unrelated functions on the locker (e.g. a fee-redirect setter).
contract CutPool {
    using SafeTransferLib for address;

    // ------------------------------------------------------------------
    // Constants / immutables
    // ------------------------------------------------------------------

    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Contract that pays out the Pons creator fee (the locker). Zero = claim disabled.
    address public immutable claimTarget;

    /// @notice The only function selector `claim` is allowed to forward to `claimTarget`.
    bytes4 public immutable claimSelector;

    // ------------------------------------------------------------------
    // Storage (written once in the constructor, never again)
    // ------------------------------------------------------------------

    address[] private _recipients;
    uint16[] private _bps;
    uint256 private _reentrancyLock = 1;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @notice Emitted on every plain ETH deposit (kept minimal so WETH9's 2300-gas `transfer` succeeds).
    event Received(address indexed from, uint256 amount);
    /// @notice Emitted once per distribution. `token == address(0)` means ETH.
    event Distributed(address indexed token, uint256 amount);
    /// @notice Emitted for each recipient share inside a distribution.
    event Paid(address indexed token, address indexed recipient, uint256 amount);
    /// @notice Emitted when a claim call to `claimTarget` succeeds.
    event Claimed(address indexed caller, bytes data, bytes result);
    /// @notice Emitted when WETH held by the contract is unwrapped to ETH.
    event Unwrapped(address indexed weth, uint256 amount);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error LengthMismatch();
    error NoRecipients();
    error ZeroAddress();
    error ZeroBps(uint256 index);
    error BpsSumNot10000(uint256 sum);
    error ClaimTargetNotSet();
    error ClaimSelectorRequired();
    error ClaimSelectorMismatch();
    error ClaimFailed(bytes result);
    error NothingToDistribute();
    error NothingToUnwrap();
    error UnwrapMismatch();
    error Reentrancy();

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /// @param recipients_  Payout addresses (e.g. dev, clipper pool / MerkleDistributor, team).
    /// @param bps_         Basis-point weights, same length as `recipients_`, summing to 10_000.
    /// @param claimTarget_ Pons locker / claim contract. May be zero to disable `claim`.
    /// @param claimSelector_ 4-byte selector of the locker's claim function. Must be non-zero
    ///                       when `claimTarget_` is set and zero when it is not.
    constructor(address[] memory recipients_, uint16[] memory bps_, address claimTarget_, bytes4 claimSelector_) {
        uint256 n = recipients_.length;
        if (n == 0) revert NoRecipients();
        if (n != bps_.length) revert LengthMismatch();

        uint256 sum;
        for (uint256 i; i < n; ++i) {
            if (recipients_[i] == address(0)) revert ZeroAddress();
            if (bps_[i] == 0) revert ZeroBps(i);
            sum += bps_[i];
            _recipients.push(recipients_[i]);
            _bps.push(bps_[i]);
        }
        if (sum != BPS_DENOMINATOR) revert BpsSumNot10000(sum);

        if (claimTarget_ != address(0) && claimSelector_ == bytes4(0)) revert ClaimSelectorRequired();
        if (claimTarget_ == address(0) && claimSelector_ != bytes4(0)) revert ClaimSelectorMismatch();
        claimTarget = claimTarget_;
        claimSelector = claimSelector_;
    }

    // ------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------

    modifier nonReentrant() {
        if (_reentrancyLock != 1) revert Reentrancy();
        _reentrancyLock = 2;
        _;
        _reentrancyLock = 1;
    }

    // ------------------------------------------------------------------
    // Receive
    // ------------------------------------------------------------------

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    // ------------------------------------------------------------------
    // Permissionless actions
    // ------------------------------------------------------------------

    /// @notice Splits the entire ETH balance across recipients.
    function distribute() external nonReentrant {
        uint256 amount = address(this).balance;
        if (amount == 0) revert NothingToDistribute();

        uint256 n = _recipients.length;
        uint256 sent;
        for (uint256 i; i < n; ++i) {
            uint256 share = _share(amount, i, n, sent);
            sent += share;
            if (share != 0) _recipients[i].safeTransferETH(share);
            emit Paid(address(0), _recipients[i], share);
        }
        emit Distributed(address(0), amount);
    }

    /// @notice Splits the entire balance of `token` across recipients.
    function distributeToken(address token) external nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        uint256 amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) revert NothingToDistribute();

        uint256 n = _recipients.length;
        uint256 sent;
        for (uint256 i; i < n; ++i) {
            uint256 share = _share(amount, i, n, sent);
            sent += share;
            if (share != 0) token.safeTransfer(_recipients[i], share);
            emit Paid(token, _recipients[i], share);
        }
        emit Distributed(token, amount);
    }

    /// @notice Forwards `data` to `claimTarget` with zero value so anyone can trigger the
    ///         Pons creator-fee claim into this contract. `data` must start with `claimSelector`.
    /// @return result Raw return data of the claim call.
    function claim(bytes calldata data) external nonReentrant returns (bytes memory result) {
        if (claimTarget == address(0)) revert ClaimTargetNotSet();
        if (data.length < 4 || bytes4(data[:4]) != claimSelector) revert ClaimSelectorMismatch();

        bool ok;
        (ok, result) = claimTarget.call(data);
        if (!ok) revert ClaimFailed(result);
        emit Claimed(msg.sender, data, result);
    }

    /// @notice Unwraps the contract's full WETH balance into ETH so it can be split with `distribute`.
    /// @dev Verifies the ETH balance grew by exactly the unwrapped amount, so a non-WETH `weth`
    ///      argument cannot be used to make the contract do anything except a no-op revert.
    function unwrapWETH(address weth) external nonReentrant {
        uint256 bal = IWETH(weth).balanceOf(address(this));
        if (bal == 0) revert NothingToUnwrap();
        uint256 before = address(this).balance;
        IWETH(weth).withdraw(bal);
        if (address(this).balance != before + bal) revert UnwrapMismatch();
        emit Unwrapped(weth, bal);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function recipientCount() external view returns (uint256) {
        return _recipients.length;
    }

    function recipient(uint256 index) external view returns (address) {
        return _recipients[index];
    }

    function bps(uint256 index) external view returns (uint16) {
        return _bps[index];
    }

    /// @notice Returns the full split configuration.
    function split() external view returns (address[] memory recipients, uint16[] memory weights) {
        return (_recipients, _bps);
    }

    /// @notice Returns the exact per-recipient amounts `distribute*` would pay for `amount`.
    function previewSplit(uint256 amount) external view returns (uint256[] memory shares) {
        uint256 n = _recipients.length;
        shares = new uint256[](n);
        uint256 sent;
        for (uint256 i; i < n; ++i) {
            shares[i] = _share(amount, i, n, sent);
            sent += shares[i];
        }
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /// @dev Share for recipient `i`; the last recipient absorbs rounding dust.
    function _share(uint256 amount, uint256 i, uint256 n, uint256 sent) private view returns (uint256) {
        if (i == n - 1) return amount - sent;
        return amount * _bps[i] / BPS_DENOMINATOR;
    }
}
