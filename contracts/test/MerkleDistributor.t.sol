// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MerkleDistributor} from "../src/MerkleDistributor.sol";
import {SafeTransferLib} from "../src/libraries/SafeTransferLib.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {RejectsETH} from "./mocks/Recipients.sol";
import {MerkleTreeLib} from "./utils/MerkleTreeLib.sol";

contract MerkleDistributorTest is Test {
    address internal owner = makeAddr("owner");
    address internal anyone = makeAddr("anyone");
    address internal treasury = makeAddr("treasury");

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    MerkleDistributor internal dist;
    MockERC20 internal cut;

    uint256 internal constant ROUND = 202637;
    uint64 internal deadline;

    // 3-leaf round built in Solidity (same algorithm as tooling/build_round.py)
    bytes32[] internal leaves;
    uint256[] internal amounts;
    address[] internal accounts;
    bytes32 internal root;
    uint256 internal total;

    function setUp() public {
        dist = new MerkleDistributor(owner);
        cut = new MockERC20("CUT", "CUT", true);
        deadline = uint64(block.timestamp + 7 days);

        accounts.push(alice);
        accounts.push(bob);
        accounts.push(carol);
        amounts.push(600e18);
        amounts.push(300e18);
        amounts.push(100e18 + 1);
        for (uint256 i; i < 3; i++) {
            leaves.push(dist.leaf(ROUND, i, accounts[i], amounts[i]));
            total += amounts[i];
        }
        root = MerkleTreeLib.root(leaves);
    }

    function _fundAndSetTokenRound() internal {
        cut.mint(address(dist), total);
        vm.prank(owner);
        dist.setRound(ROUND, address(cut), root, total, deadline);
    }

    function _proof(uint256 i) internal view returns (bytes32[] memory) {
        return MerkleTreeLib.proof(leaves, i);
    }

    // ------------------------------------------------------------------
    // Leaf encoding
    // ------------------------------------------------------------------

    function test_Leaf_IsDoubleHashOfAbiEncode() public view {
        bytes32 expected = keccak256(bytes.concat(keccak256(abi.encode(uint256(7), uint256(2), carol, uint256(51)))));
        assertEq(dist.leaf(7, 2, carol, 51), expected);
        // and abi.encode really is four 32-byte words
        assertEq(abi.encode(uint256(7), uint256(2), carol, uint256(51)).length, 128);
    }

    // ------------------------------------------------------------------
    // setRound
    // ------------------------------------------------------------------

    function test_SetRound_HappyPath() public {
        cut.mint(address(dist), total);
        vm.expectEmit(true, true, false, true, address(dist));
        emit MerkleDistributor.RoundSet(ROUND, address(cut), root, total, deadline);
        vm.prank(owner);
        dist.setRound(ROUND, address(cut), root, total, deadline);

        MerkleDistributor.Round memory r = dist.round(ROUND);
        assertEq(r.token, address(cut));
        assertEq(r.merkleRoot, root);
        assertEq(r.total, total);
        assertEq(r.unclaimed, total);
        assertEq(r.claimDeadline, deadline);
        assertFalse(r.swept);
        assertEq(dist.reserved(address(cut)), total);
        assertEq(dist.available(address(cut)), 0);
    }

    function test_SetRound_OnlyOwner() public {
        cut.mint(address(dist), total);
        vm.prank(anyone);
        vm.expectRevert(MerkleDistributor.NotOwner.selector);
        dist.setRound(ROUND, address(cut), root, total, deadline);
    }

    function test_SetRound_RevertsWithoutFunds() public {
        cut.mint(address(dist), total - 1);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(MerkleDistributor.InsufficientBalance.selector, address(cut), total - 1, total)
        );
        dist.setRound(ROUND, address(cut), root, total, deadline);
    }

    function test_SetRound_AccountsForFundsReservedByOpenRounds() public {
        cut.mint(address(dist), 100);
        vm.startPrank(owner);
        dist.setRound(1, address(cut), bytes32(uint256(1)), 60, deadline);
        assertEq(dist.available(address(cut)), 40);
        vm.expectRevert(abi.encodeWithSelector(MerkleDistributor.InsufficientBalance.selector, address(cut), 40, 50));
        dist.setRound(2, address(cut), bytes32(uint256(2)), 50, deadline);
        dist.setRound(2, address(cut), bytes32(uint256(2)), 40, deadline);
        assertEq(dist.reserved(address(cut)), 100);
        vm.stopPrank();
    }

    function test_SetRound_RevertsOnBadParams() public {
        cut.mint(address(dist), total);
        vm.startPrank(owner);
        vm.expectRevert(MerkleDistributor.EmptyRoot.selector);
        dist.setRound(ROUND, address(cut), bytes32(0), total, deadline);
        vm.expectRevert(MerkleDistributor.ZeroTotal.selector);
        dist.setRound(ROUND, address(cut), root, 0, deadline);
        vm.expectRevert(MerkleDistributor.DeadlineInPast.selector);
        dist.setRound(ROUND, address(cut), root, total, uint64(block.timestamp));

        dist.setRound(ROUND, address(cut), root, total, deadline);
        cut.mint(address(dist), total);
        vm.expectRevert(abi.encodeWithSelector(MerkleDistributor.RoundAlreadySet.selector, ROUND));
        dist.setRound(ROUND, address(cut), root, total, deadline);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // claim
    // ------------------------------------------------------------------

    function test_Claim_HappyPath() public {
        _fundAndSetTokenRound();

        vm.expectEmit(true, true, false, true, address(dist));
        emit MerkleDistributor.Claimed(ROUND, 0, alice, amounts[0]);
        vm.prank(alice);
        dist.claim(ROUND, 0, alice, amounts[0], _proof(0));

        assertEq(cut.balanceOf(alice), amounts[0]);
        assertTrue(dist.isClaimed(ROUND, 0));
        assertFalse(dist.isClaimed(ROUND, 1));
        assertEq(dist.round(ROUND).unclaimed, total - amounts[0]);
        assertEq(dist.reserved(address(cut)), total - amounts[0]);
    }

    function test_Claim_AnyoneCanSubmitButFundsGoToAccount() public {
        _fundAndSetTokenRound();
        vm.prank(anyone);
        dist.claim(ROUND, 1, bob, amounts[1], _proof(1));
        assertEq(cut.balanceOf(bob), amounts[1]);
        assertEq(cut.balanceOf(anyone), 0);
    }

    function test_Claim_AllLeavesDrainRoundExactly() public {
        _fundAndSetTokenRound();
        for (uint256 i; i < 3; i++) {
            dist.claim(ROUND, i, accounts[i], amounts[i], _proof(i));
        }
        assertEq(dist.round(ROUND).unclaimed, 0);
        assertEq(dist.reserved(address(cut)), 0);
        assertEq(cut.balanceOf(address(dist)), 0);
        // the odd (carried) leaf has a shorter proof
        assertEq(_proof(2).length, 1);
        assertEq(_proof(0).length, 2);
    }

    function test_Claim_DoubleClaimReverts() public {
        _fundAndSetTokenRound();
        dist.claim(ROUND, 0, alice, amounts[0], _proof(0));
        vm.expectRevert(abi.encodeWithSelector(MerkleDistributor.AlreadyClaimed.selector, ROUND, 0));
        dist.claim(ROUND, 0, alice, amounts[0], _proof(0));
        assertEq(cut.balanceOf(alice), amounts[0]);
    }

    function test_Claim_WrongProofReverts() public {
        _fundAndSetTokenRound();

        // tampered proof element
        bytes32[] memory bad = _proof(0);
        bad[0] = bytes32(uint256(bad[0]) ^ 1);
        vm.expectRevert(MerkleDistributor.InvalidProof.selector);
        dist.claim(ROUND, 0, alice, amounts[0], bad);

        // right proof, inflated amount
        vm.expectRevert(MerkleDistributor.InvalidProof.selector);
        dist.claim(ROUND, 0, alice, amounts[0] + 1, _proof(0));

        // right proof, different account
        vm.expectRevert(MerkleDistributor.InvalidProof.selector);
        dist.claim(ROUND, 0, anyone, amounts[0], _proof(0));

        // right proof, wrong index
        vm.expectRevert(MerkleDistributor.InvalidProof.selector);
        dist.claim(ROUND, 1, alice, amounts[0], _proof(0));

        // proof of another leaf
        vm.expectRevert(MerkleDistributor.InvalidProof.selector);
        dist.claim(ROUND, 0, alice, amounts[0], _proof(1));

        // empty proof
        vm.expectRevert(MerkleDistributor.InvalidProof.selector);
        dist.claim(ROUND, 0, alice, amounts[0], new bytes32[](0));

        assertEq(cut.balanceOf(alice), 0);
    }

    function test_Claim_SameLeavesDifferentRoundIdReverts() public {
        // A proof from round X must not be replayable in round Y, because roundId is in the leaf.
        _fundAndSetTokenRound();
        cut.mint(address(dist), total);
        vm.prank(owner);
        dist.setRound(ROUND + 1, address(cut), root, total, deadline);
        vm.expectRevert(MerkleDistributor.InvalidProof.selector);
        dist.claim(ROUND + 1, 0, alice, amounts[0], _proof(0));
    }

    function test_Claim_RevertsAfterDeadlineAndForUnknownRound() public {
        _fundAndSetTokenRound();
        vm.expectRevert(abi.encodeWithSelector(MerkleDistributor.RoundNotFound.selector, 999));
        dist.claim(999, 0, alice, amounts[0], _proof(0));

        vm.warp(deadline); // inclusive: still claimable
        dist.claim(ROUND, 1, bob, amounts[1], _proof(1));

        vm.warp(uint256(deadline) + 1);
        vm.expectRevert(abi.encodeWithSelector(MerkleDistributor.RoundClosed.selector, ROUND, deadline));
        dist.claim(ROUND, 0, alice, amounts[0], _proof(0));
    }

    function test_Claim_RevertsIfTreeOwesMoreThanTotal() public {
        // Owner publishes a root whose leaves sum to more than `total` (bad off-chain data).
        // Late claimers must fail loudly instead of draining other rounds' reserves.
        cut.mint(address(dist), total);
        vm.prank(owner);
        dist.setRound(ROUND, address(cut), root, amounts[0] + 1, deadline); // understated total
        dist.claim(ROUND, 0, alice, amounts[0], _proof(0));
        vm.expectRevert(abi.encodeWithSelector(MerkleDistributor.AmountExceedsUnclaimed.selector, ROUND, amounts[1], 1));
        dist.claim(ROUND, 1, bob, amounts[1], _proof(1));
    }

    function test_Claim_BitmapHandlesLargeIndices() public {
        uint256[] memory idx = new uint256[](4);
        idx[0] = 0;
        idx[1] = 255;
        idx[2] = 256;
        idx[3] = 70_000;
        bytes32[] memory lv = new bytes32[](4);
        for (uint256 i; i < 4; i++) {
            lv[i] = dist.leaf(5, idx[i], alice, 1);
        }
        cut.mint(address(dist), 4);
        vm.prank(owner);
        dist.setRound(5, address(cut), MerkleTreeLib.root(lv), 4, deadline);
        for (uint256 i; i < 4; i++) {
            dist.claim(5, idx[i], alice, 1, MerkleTreeLib.proof(lv, i));
            assertTrue(dist.isClaimed(5, idx[i]));
        }
        assertFalse(dist.isClaimed(5, 1));
        assertFalse(dist.isClaimed(5, 257));
        assertEq(cut.balanceOf(alice), 4);
    }

    // ------------------------------------------------------------------
    // sweep
    // ------------------------------------------------------------------

    function test_Sweep_AfterDeadlineMovesRemainder() public {
        _fundAndSetTokenRound();
        dist.claim(ROUND, 0, alice, amounts[0], _proof(0));
        uint256 remainder = total - amounts[0];

        vm.warp(uint256(deadline) + 1);
        vm.expectEmit(true, true, true, true, address(dist));
        emit MerkleDistributor.Swept(ROUND, address(cut), treasury, remainder);
        vm.prank(owner);
        dist.sweep(ROUND, treasury);

        assertEq(cut.balanceOf(treasury), remainder);
        assertEq(dist.round(ROUND).unclaimed, 0);
        assertTrue(dist.round(ROUND).swept);
        assertEq(dist.reserved(address(cut)), 0);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MerkleDistributor.AlreadySwept.selector, ROUND));
        dist.sweep(ROUND, treasury);

        // swept funds can be re-used for the next round without leaving the contract
        cut.mint(address(dist), 0); // no new funds...
        assertEq(dist.available(address(cut)), 0);
    }

    function test_Sweep_CanTargetContractItselfIsNotNeeded_SweptToNextRound() public {
        // Sweeping to the distributor itself makes the remainder available for the next round.
        _fundAndSetTokenRound();
        vm.warp(uint256(deadline) + 1);
        vm.prank(owner);
        dist.sweep(ROUND, address(dist));
        assertEq(dist.available(address(cut)), total);
    }

    function test_Sweep_RevertsBeforeDeadlineOrNonOwnerOrUnknown() public {
        _fundAndSetTokenRound();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MerkleDistributor.RoundStillOpen.selector, ROUND, deadline));
        dist.sweep(ROUND, treasury);

        vm.warp(uint256(deadline) + 1);
        vm.prank(anyone);
        vm.expectRevert(MerkleDistributor.NotOwner.selector);
        dist.sweep(ROUND, treasury);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MerkleDistributor.RoundNotFound.selector, 42));
        dist.sweep(42, treasury);

        vm.prank(owner);
        vm.expectRevert(MerkleDistributor.ZeroAddress.selector);
        dist.sweep(ROUND, address(0));
    }

    // ------------------------------------------------------------------
    // ETH rounds
    // ------------------------------------------------------------------

    function test_ETHRound_ClaimAndSweep() public {
        vm.deal(address(dist), total);
        assertEq(dist.available(address(0)), total);
        vm.prank(owner);
        dist.setRound(ROUND, address(0), root, total, deadline);
        assertEq(dist.reserved(address(0)), total);

        vm.prank(anyone);
        dist.claim(ROUND, 2, carol, amounts[2], _proof(2));
        assertEq(carol.balance, amounts[2]);

        vm.warp(uint256(deadline) + 1);
        vm.prank(owner);
        dist.sweep(ROUND, treasury);
        assertEq(treasury.balance, total - amounts[2]);
        assertEq(address(dist).balance, 0);
    }

    function test_ETHRound_ClaimToRejectingAccountReverts() public {
        address rejecter = address(new RejectsETH());
        bytes32[] memory lv = new bytes32[](1);
        lv[0] = dist.leaf(9, 0, rejecter, 1);
        vm.deal(address(dist), 1);
        vm.prank(owner);
        dist.setRound(9, address(0), MerkleTreeLib.root(lv), 1, deadline);
        vm.expectRevert(abi.encodeWithSelector(SafeTransferLib.ETHTransferFailed.selector, rejecter, 1));
        dist.claim(9, 0, rejecter, 1, new bytes32[](0));
        assertFalse(dist.isClaimed(9, 0), "failed claim must not be marked claimed");
    }

    function test_Receive_EmitsEvent() public {
        vm.deal(anyone, 5);
        vm.expectEmit(true, false, false, true, address(dist));
        emit MerkleDistributor.Received(anyone, 5);
        vm.prank(anyone);
        (bool ok,) = address(dist).call{value: 5}("");
        assertTrue(ok);
    }

    // ------------------------------------------------------------------
    // withdrawUnreserved
    // ------------------------------------------------------------------

    function test_WithdrawUnreserved_OnlyFreeFunds() public {
        cut.mint(address(dist), total + 10);
        vm.startPrank(owner);
        dist.setRound(ROUND, address(cut), root, total, deadline);
        vm.expectRevert(abi.encodeWithSelector(MerkleDistributor.InsufficientBalance.selector, address(cut), 10, 11));
        dist.withdrawUnreserved(address(cut), treasury, 11);
        dist.withdrawUnreserved(address(cut), treasury, 10);
        vm.stopPrank();
        assertEq(cut.balanceOf(treasury), 10);
        assertEq(cut.balanceOf(address(dist)), total);

        // reserved funds are still fully claimable
        for (uint256 i; i < 3; i++) {
            dist.claim(ROUND, i, accounts[i], amounts[i], _proof(i));
        }
        assertEq(cut.balanceOf(address(dist)), 0);
    }

    function test_WithdrawUnreserved_OnlyOwner() public {
        cut.mint(address(dist), 1);
        vm.prank(anyone);
        vm.expectRevert(MerkleDistributor.NotOwner.selector);
        dist.withdrawUnreserved(address(cut), anyone, 1);
    }

    // ------------------------------------------------------------------
    // Ownership
    // ------------------------------------------------------------------

    function test_Ownership_TwoStep() public {
        vm.prank(anyone);
        vm.expectRevert(MerkleDistributor.NotOwner.selector);
        dist.transferOwnership(anyone);

        vm.prank(owner);
        dist.transferOwnership(anyone);
        assertEq(dist.owner(), owner);
        assertEq(dist.pendingOwner(), anyone);

        vm.prank(treasury);
        vm.expectRevert(MerkleDistributor.NotPendingOwner.selector);
        dist.acceptOwnership();

        vm.prank(anyone);
        dist.acceptOwnership();
        assertEq(dist.owner(), anyone);
        assertEq(dist.pendingOwner(), address(0));
    }

    function test_Constructor_RejectsZeroOwner() public {
        vm.expectRevert(MerkleDistributor.ZeroAddress.selector);
        new MerkleDistributor(address(0));
    }
}

// Cross-checks the Python tooling against the contract using fixtures generated by
// `tooling/build_round.py`:
//   test/fixtures/round_example.json:
//     python3 tooling/build_round.py --csv tooling/views.example.csv --total 5e21 --round 202637 \
//       --token 0x000000000000000000000000000000000000bbbb --out test/fixtures/round_example.json
//   test/fixtures/round_three.json:
//     python3 tooling/build_round.py --csv three.csv --total 100 --round 7 --out test/fixtures/round_three.json
//     (three.csv rows: 0x..01 / handle a / 10 views, 0x..02 / b / 20, 0x..03 / c / 30)
contract MerkleDistributorFixtureTest is Test {
    address internal owner = makeAddr("owner");
    MerkleDistributor internal dist;

    function setUp() public {
        dist = new MerkleDistributor(owner);
    }

    struct FixtureClaim {
        uint256 index;
        address account;
        uint256 amount;
        bytes32[] proof;
    }

    function _load(string memory file)
        internal
        view
        returns (uint256 roundId, bytes32 root, uint256 total, FixtureClaim[] memory claims)
    {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/", file));
        roundId = vm.parseJsonUint(json, ".round");
        root = vm.parseJsonBytes32(json, ".merkleRoot");
        total = vm.parseUint(vm.parseJsonString(json, ".total"));
        uint256 n = vm.parseJsonUint(json, ".recipients");
        claims = new FixtureClaim[](n);
        for (uint256 i; i < n; i++) {
            string memory p = string.concat(".claims[", vm.toString(i), "]");
            claims[i].index = vm.parseJsonUint(json, string.concat(p, ".index"));
            claims[i].account = vm.parseJsonAddress(json, string.concat(p, ".account"));
            claims[i].amount = vm.parseUint(vm.parseJsonString(json, string.concat(p, ".amount")));
            claims[i].proof = vm.parseJsonBytes32Array(json, string.concat(p, ".proof"));
        }
    }

    /// @dev Rebuilds the tree in Solidity from the fixture's (index, account, amount) rows and
    ///      asserts the root equals what the Python tool wrote.
    function _assertRootMatches(uint256 roundId, bytes32 root, uint256 total, FixtureClaim[] memory claims)
        internal
        view
    {
        bytes32[] memory leaves = new bytes32[](claims.length);
        uint256 sum;
        for (uint256 i; i < claims.length; i++) {
            assertEq(claims[i].index, i, "tool assigns sequential indices");
            leaves[i] = dist.leaf(roundId, claims[i].index, claims[i].account, claims[i].amount);
            sum += claims[i].amount;
        }
        assertEq(MerkleTreeLib.root(leaves), root, "python root != solidity root");
        assertEq(sum, total, "amounts must sum to total exactly");
        for (uint256 i; i < claims.length; i++) {
            bytes32[] memory solProof = MerkleTreeLib.proof(leaves, i);
            assertEq(solProof.length, claims[i].proof.length, "proof length");
            for (uint256 j; j < solProof.length; j++) {
                assertEq(solProof[j], claims[i].proof[j], "proof element");
            }
        }
    }

    // Hardcoded copy of test/fixtures/round_three.json (3 leaves, exercises the odd-node carry):
    //   python3 tooling/build_round.py --csv three.csv --total 100 --round 7
    //   three.csv: 0x..01,@a,10 / 0x..02,@b,20 / 0x..03,@c,30
    function test_Fixture_ThreeLeaf_Hardcoded() public view {
        bytes32 expectedRoot = 0x1f787501ca295cf99d4f73501fe0e4f10c1a46ed5a7d789f75f5bb9a30c5b7a2;
        bytes32[] memory leaves = new bytes32[](3);
        leaves[0] = dist.leaf(7, 0, address(1), 16);
        leaves[1] = dist.leaf(7, 1, address(2), 33);
        leaves[2] = dist.leaf(7, 2, address(3), 51);
        assertEq(MerkleTreeLib.root(leaves), expectedRoot);

        bytes32[] memory p2 = MerkleTreeLib.proof(leaves, 2);
        assertEq(p2.length, 1);
        assertEq(p2[0], 0xef0ec27efbad63a1806986b87e6a368851e326b55734e962d7716969673b7e33);

        bytes32[] memory p0 = MerkleTreeLib.proof(leaves, 0);
        assertEq(p0.length, 2);
        assertEq(p0[0], 0xc49fa74c771a49e2f7f69f524fe49c0ca3d027ec247df1b01de073d22a366435);
        assertEq(p0[1], 0x2e49a4743f708ad4ace6589bf12dac3b558914ae44f3959a7a54b124e1d6efaa);
    }

    function test_Fixture_ThreeLeaf_JsonRootMatchesAndClaimsSucceedOnETHRound() public {
        (uint256 roundId, bytes32 root, uint256 total, FixtureClaim[] memory claims) = _load("round_three.json");
        assertEq(claims.length, 3);
        _assertRootMatches(roundId, root, total, claims);

        vm.deal(address(dist), total);
        vm.prank(owner);
        dist.setRound(roundId, address(0), root, total, uint64(block.timestamp + 1 days));
        for (uint256 i; i < claims.length; i++) {
            uint256 before = claims[i].account.balance;
            dist.claim(roundId, claims[i].index, claims[i].account, claims[i].amount, claims[i].proof);
            assertEq(claims[i].account.balance - before, claims[i].amount);
        }
        assertEq(dist.round(roundId).unclaimed, 0);
        assertEq(address(dist).balance, 0);
    }

    function test_Fixture_Example_JsonRootMatchesAndClaimsSucceedOnTokenRound() public {
        (uint256 roundId, bytes32 root, uint256 total, FixtureClaim[] memory claims) = _load("round_example.json");
        assertEq(roundId, 202637);
        assertEq(claims.length, 4, "views.example.csv has 5 rows, one with 0 views is excluded");
        assertEq(total, 5_000e18);
        _assertRootMatches(roundId, root, total, claims);

        MockERC20 token = new MockERC20("CUT", "CUT", true);
        token.mint(address(dist), total);
        vm.prank(owner);
        dist.setRound(roundId, address(token), root, total, uint64(block.timestamp + 1 days));
        for (uint256 i; i < claims.length; i++) {
            dist.claim(roundId, claims[i].index, claims[i].account, claims[i].amount, claims[i].proof);
            assertEq(token.balanceOf(claims[i].account), claims[i].amount);
        }
        assertEq(token.balanceOf(address(dist)), 0, "round fully drained, remainder went to last row");
    }
}
