// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";

/// @title MerkleDistributor
/// @notice Weekly clipper payouts. Each week is a `round`: the owner publishes a Merkle
///         root over (roundId, index, account, amount) leaves, and anyone can submit a
///         proof to send `amount` of the round's token to `account`.
///
/// Leaf encoding (must match `tooling/build_round.py` exactly):
///
///     inner = keccak256(abi.encode(roundId, index, account, amount))
///           = keccak256(uint256(roundId) ‖ uint256(index) ‖ uint256(uint160(account)) ‖ uint256(amount))
///             (four 32-byte big-endian words, address left-padded with zeros)
///     leaf  = keccak256(bytes.concat(inner))            // double hash, OpenZeppelin style
///
/// Internal nodes are `keccak256(min(a, b) ‖ max(a, b))` (sorted pairs). When a level has an
/// odd number of nodes the last node is carried up unchanged (Uniswap merkle-distributor
/// style), so its proof simply has no sibling at that level.
///
/// Funds: a round can only be set if the contract already holds enough of its token on
/// top of what earlier open rounds still owe (`reserved[token]`). `token == address(0)`
/// denotes native ETH. Claims are open through `claimDeadline` (inclusive); afterwards the
/// owner may `sweep` the unclaimed remainder to any address. Tokens that were sent to the
/// contract but never assigned to a round can be pulled back with `withdrawUnreserved`;
/// funds already reserved for a live round can never be touched by the owner.
///
/// Trust model: the owner controls *which* roots get published and where leftovers go.
/// The owner cannot alter a published round, claim on someone's behalf to a different
/// address, or withdraw funds reserved for an open round.
contract MerkleDistributor {
    using SafeTransferLib for address;

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    struct Round {
        address token; // address(0) = ETH
        uint64 claimDeadline; // last timestamp at which claims are accepted (inclusive)
        bool swept;
        bytes32 merkleRoot;
        uint256 total;
        uint256 unclaimed;
    }

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    address public owner;
    address public pendingOwner;

    mapping(uint256 roundId => Round) private _rounds;
    /// @dev roundId => word index => 256-bit claimed bitmap.
    mapping(uint256 roundId => mapping(uint256 wordIndex => uint256 bits)) private _claimedBitMap;
    /// @notice Amount of `token` still owed to open rounds (sum of `unclaimed`). address(0) = ETH.
    mapping(address token => uint256) public reserved;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Received(address indexed from, uint256 amount);
    event RoundSet(
        uint256 indexed roundId, address indexed token, bytes32 merkleRoot, uint256 total, uint64 claimDeadline
    );
    event Claimed(uint256 indexed roundId, uint256 index, address indexed account, uint256 amount);
    event Swept(uint256 indexed roundId, address indexed token, address indexed to, uint256 amount);
    event UnreservedWithdrawn(address indexed token, address indexed to, uint256 amount);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();
    error RoundAlreadySet(uint256 roundId);
    error RoundNotFound(uint256 roundId);
    error EmptyRoot();
    error ZeroTotal();
    error DeadlineInPast();
    error InsufficientBalance(address token, uint256 available, uint256 required);
    error RoundClosed(uint256 roundId, uint64 claimDeadline);
    error RoundStillOpen(uint256 roundId, uint64 claimDeadline);
    error AlreadyClaimed(uint256 roundId, uint256 index);
    error AlreadySwept(uint256 roundId);
    error InvalidProof();
    error AmountExceedsUnclaimed(uint256 roundId, uint256 amount, uint256 unclaimed);

    // ------------------------------------------------------------------
    // Constructor / ownership
    // ------------------------------------------------------------------

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Two-step ownership transfer: the new owner must call `acceptOwnership`.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previous = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, msg.sender);
    }

    // ------------------------------------------------------------------
    // Receive (for ETH rounds)
    // ------------------------------------------------------------------

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    // ------------------------------------------------------------------
    // Owner actions
    // ------------------------------------------------------------------

    /// @notice Publishes a round. Can only be called once per `roundId`.
    /// @param roundId       Arbitrary round identifier (e.g. ISO week number 202637).
    /// @param token         ERC-20 to pay out, or address(0) for ETH.
    /// @param merkleRoot    Root over the leaves described in the contract docs.
    /// @param total         Sum of all leaf amounts. Must already be held by this contract
    ///                      on top of what other open rounds still owe.
    /// @param claimDeadline Last timestamp (inclusive) at which claims are accepted.
    function setRound(uint256 roundId, address token, bytes32 merkleRoot, uint256 total, uint64 claimDeadline)
        external
        onlyOwner
    {
        Round storage r = _rounds[roundId];
        if (r.merkleRoot != bytes32(0)) revert RoundAlreadySet(roundId);
        if (merkleRoot == bytes32(0)) revert EmptyRoot();
        if (total == 0) revert ZeroTotal();
        if (claimDeadline <= block.timestamp) revert DeadlineInPast();

        uint256 free = available(token);
        if (free < total) revert InsufficientBalance(token, free, total);

        r.token = token;
        r.claimDeadline = claimDeadline;
        r.merkleRoot = merkleRoot;
        r.total = total;
        r.unclaimed = total;
        reserved[token] += total;

        emit RoundSet(roundId, token, merkleRoot, total, claimDeadline);
    }

    /// @notice After `claimDeadline`, moves the unclaimed remainder of a round to `to`.
    function sweep(uint256 roundId, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        Round storage r = _rounds[roundId];
        if (r.merkleRoot == bytes32(0)) revert RoundNotFound(roundId);
        if (block.timestamp <= r.claimDeadline) revert RoundStillOpen(roundId, r.claimDeadline);
        if (r.swept) revert AlreadySwept(roundId);

        uint256 amount = r.unclaimed;
        r.swept = true;
        r.unclaimed = 0;
        reserved[r.token] -= amount;

        if (amount != 0) _pay(r.token, to, amount);
        emit Swept(roundId, r.token, to, amount);
    }

    /// @notice Withdraws funds that are not reserved for any open round (e.g. over-funding).
    function withdrawUnreserved(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 free = available(token);
        if (amount > free) revert InsufficientBalance(token, free, amount);
        _pay(token, to, amount);
        emit UnreservedWithdrawn(token, to, amount);
    }

    // ------------------------------------------------------------------
    // Permissionless claim
    // ------------------------------------------------------------------

    /// @notice Claims `amount` for `account` in `roundId`. Anyone may submit; funds always go to `account`.
    function claim(uint256 roundId, uint256 index, address account, uint256 amount, bytes32[] calldata proof) external {
        if (account == address(0)) revert ZeroAddress();
        Round storage r = _rounds[roundId];
        if (r.merkleRoot == bytes32(0)) revert RoundNotFound(roundId);
        if (block.timestamp > r.claimDeadline) revert RoundClosed(roundId, r.claimDeadline);
        if (isClaimed(roundId, index)) revert AlreadyClaimed(roundId, index);
        if (!_verify(proof, r.merkleRoot, leaf(roundId, index, account, amount))) revert InvalidProof();
        if (amount > r.unclaimed) revert AmountExceedsUnclaimed(roundId, amount, r.unclaimed);

        _setClaimed(roundId, index);
        r.unclaimed -= amount;
        reserved[r.token] -= amount;

        if (amount != 0) _pay(r.token, account, amount);
        emit Claimed(roundId, index, account, amount);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function round(uint256 roundId) external view returns (Round memory) {
        return _rounds[roundId];
    }

    function isClaimed(uint256 roundId, uint256 index) public view returns (bool) {
        uint256 word = _claimedBitMap[roundId][index >> 8];
        return (word >> (index & 0xff)) & 1 == 1;
    }

    /// @notice Balance of `token` held by this contract that is not reserved for open rounds.
    function available(address token) public view returns (uint256) {
        uint256 bal = token == address(0) ? address(this).balance : IERC20(token).balanceOf(address(this));
        uint256 res = reserved[token];
        return bal > res ? bal - res : 0;
    }

    /// @notice Leaf hash used by this contract. Mirror this exactly off-chain.
    function leaf(uint256 roundId, uint256 index, address account, uint256 amount) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(roundId, index, account, amount))));
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _setClaimed(uint256 roundId, uint256 index) private {
        _claimedBitMap[roundId][index >> 8] |= (uint256(1) << (index & 0xff));
    }

    function _pay(address token, address to, uint256 amount) private {
        if (token == address(0)) to.safeTransferETH(amount);
        else token.safeTransfer(to, amount);
    }

    /// @dev Sorted-pair Merkle proof verification (compatible with OpenZeppelin MerkleProof).
    function _verify(bytes32[] calldata proof, bytes32 root, bytes32 node) private pure returns (bool) {
        for (uint256 i; i < proof.length; ++i) {
            bytes32 p = proof[i];
            node = node < p ? keccak256(abi.encodePacked(node, p)) : keccak256(abi.encodePacked(p, node));
        }
        return node == root;
    }
}
