// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CutPool} from "../src/CutPool.sol";
import {SafeTransferLib} from "../src/libraries/SafeTransferLib.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockWETH, FakeWETH} from "./mocks/MockWETH.sol";
import {MockClaimTarget} from "./mocks/MockClaimTarget.sol";
import {RejectsETH, Reenterer} from "./mocks/Recipients.sol";

contract CutPoolTest is Test {
    address internal dev = makeAddr("dev");
    address internal clipperPool = makeAddr("clipperPool");
    address internal team = makeAddr("team");
    address internal anyone = makeAddr("anyone");

    MockClaimTarget internal locker;
    CutPool internal pool;
    MockERC20 internal cut;
    MockWETH internal weth;

    bytes4 internal constant CLAIM_SELECTOR = MockClaimTarget.collectFees.selector;

    function setUp() public {
        locker = new MockClaimTarget();
        pool = new CutPool(_recipients(), _bps(5000, 3000, 2000), address(locker), CLAIM_SELECTOR);
        cut = new MockERC20("CUT", "CUT", true);
        weth = new MockWETH();
    }

    function _recipients() internal view returns (address[] memory r) {
        r = new address[](3);
        r[0] = dev;
        r[1] = clipperPool;
        r[2] = team;
    }

    function _bps(uint16 a, uint16 b, uint16 c) internal pure returns (uint16[] memory w) {
        w = new uint16[](3);
        w[0] = a;
        w[1] = b;
        w[2] = c;
    }

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    function test_Constructor_StoresConfig() public view {
        (address[] memory r, uint16[] memory w) = pool.split();
        assertEq(r.length, 3);
        assertEq(r[0], dev);
        assertEq(r[1], clipperPool);
        assertEq(r[2], team);
        assertEq(w[0], 5000);
        assertEq(w[1], 3000);
        assertEq(w[2], 2000);
        assertEq(pool.recipientCount(), 3);
        assertEq(pool.recipient(1), clipperPool);
        assertEq(pool.bps(2), 2000);
        assertEq(pool.claimTarget(), address(locker));
        assertEq(pool.claimSelector(), CLAIM_SELECTOR);
    }

    function test_Constructor_RevertsWhenBpsDoNotSumTo10000() public {
        vm.expectRevert(abi.encodeWithSelector(CutPool.BpsSumNot10000.selector, 9999));
        new CutPool(_recipients(), _bps(5000, 3000, 1999), address(0), bytes4(0));
    }

    function test_Constructor_RevertsOnLengthMismatch() public {
        uint16[] memory w = new uint16[](2);
        w[0] = 5000;
        w[1] = 5000;
        vm.expectRevert(CutPool.LengthMismatch.selector);
        new CutPool(_recipients(), w, address(0), bytes4(0));
    }

    function test_Constructor_RevertsOnZeroRecipientOrZeroBps() public {
        address[] memory r = _recipients();
        r[1] = address(0);
        vm.expectRevert(CutPool.ZeroAddress.selector);
        new CutPool(r, _bps(5000, 3000, 2000), address(0), bytes4(0));

        vm.expectRevert(abi.encodeWithSelector(CutPool.ZeroBps.selector, 1));
        new CutPool(_recipients(), _bps(8000, 0, 2000), address(0), bytes4(0));

        vm.expectRevert(CutPool.NoRecipients.selector);
        new CutPool(new address[](0), new uint16[](0), address(0), bytes4(0));
    }

    function test_Constructor_RequiresSelectorWithTargetAndViceVersa() public {
        vm.expectRevert(CutPool.ClaimSelectorRequired.selector);
        new CutPool(_recipients(), _bps(5000, 3000, 2000), address(locker), bytes4(0));

        vm.expectRevert(CutPool.ClaimSelectorMismatch.selector);
        new CutPool(_recipients(), _bps(5000, 3000, 2000), address(0), CLAIM_SELECTOR);
    }

    // ------------------------------------------------------------------
    // Split math
    // ------------------------------------------------------------------

    function test_PreviewSplit_ExactAndDustToLast() public {
        // 10_001 wei with 50/30/20: floor shares 5000 + 3000 = 8000, last gets 2001 (includes 1 wei dust)
        uint256[] memory s = pool.previewSplit(10_001);
        assertEq(s[0], 5000);
        assertEq(s[1], 3000);
        assertEq(s[2], 2001);
        assertEq(s[0] + s[1] + s[2], 10_001);

        // Thirds: 3333/3333/3334 on 100 wei -> 33, 33, 34
        CutPool thirds = new CutPool(_recipients(), _bps(3333, 3333, 3334), address(0), bytes4(0));
        s = thirds.previewSplit(100);
        assertEq(s[0], 33);
        assertEq(s[1], 33);
        assertEq(s[2], 34);

        // 1 wei: everything rounds to zero except the last recipient
        s = thirds.previewSplit(1);
        assertEq(s[0], 0);
        assertEq(s[1], 0);
        assertEq(s[2], 1);
    }

    function testFuzz_PreviewSplit_SumsToAmountAndNeverExceedsWeight(uint256 amount, uint16 a, uint16 b) public {
        amount = bound(amount, 0, type(uint256).max / 10_000);
        a = uint16(bound(a, 1, 9_998));
        b = uint16(bound(b, 1, 9_999 - a));
        uint16 c = 10_000 - a - b;
        CutPool p = new CutPool(_recipients(), _bps(a, b, c), address(0), bytes4(0));
        uint256[] memory s = p.previewSplit(amount);
        assertEq(s[0] + s[1] + s[2], amount, "sum");
        assertEq(s[0], amount * a / 10_000, "share0 exact floor");
        assertEq(s[1], amount * b / 10_000, "share1 exact floor");
        // last recipient gets its floor share plus at most (n-1) wei of dust
        assertGe(s[2], amount * c / 10_000);
        assertLe(s[2], amount * c / 10_000 + 2);
    }

    // ------------------------------------------------------------------
    // ETH distribution
    // ------------------------------------------------------------------

    function test_Distribute_ETH() public {
        vm.deal(anyone, 10_001 wei);
        vm.prank(anyone);
        (bool ok,) = address(pool).call{value: 10_001 wei}("");
        assertTrue(ok);
        assertEq(address(pool).balance, 10_001);

        vm.expectEmit(true, true, false, true, address(pool));
        emit CutPool.Paid(address(0), dev, 5000);
        vm.expectEmit(true, true, false, true, address(pool));
        emit CutPool.Paid(address(0), clipperPool, 3000);
        vm.expectEmit(true, true, false, true, address(pool));
        emit CutPool.Paid(address(0), team, 2001);
        vm.expectEmit(true, false, false, true, address(pool));
        emit CutPool.Distributed(address(0), 10_001);

        vm.prank(anyone); // permissionless
        pool.distribute();

        assertEq(dev.balance, 5000);
        assertEq(clipperPool.balance, 3000);
        assertEq(team.balance, 2001);
        assertEq(address(pool).balance, 0, "no dust left behind");
    }

    function test_Distribute_RevertsWhenEmpty() public {
        vm.expectRevert(CutPool.NothingToDistribute.selector);
        pool.distribute();
    }

    function test_Distribute_RevertsIfRecipientRejectsETH() public {
        address[] memory r = _recipients();
        r[2] = address(new RejectsETH());
        CutPool p = new CutPool(r, _bps(5000, 3000, 2000), address(0), bytes4(0));
        vm.deal(address(p), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(SafeTransferLib.ETHTransferFailed.selector, r[2], 0.2 ether));
        p.distribute();
    }

    function test_Distribute_ReentrancyIsBlocked() public {
        Reenterer re = new Reenterer();
        address[] memory r = _recipients();
        r[0] = address(re);
        CutPool p = new CutPool(r, _bps(5000, 3000, 2000), address(0), bytes4(0));
        vm.deal(address(p), 1 ether);
        p.distribute();
        assertTrue(re.reentryReverted(), "nested distribute must revert");
        assertEq(bytes32(bytes4(re.reentryError())), bytes32(CutPool.Reentrancy.selector));
        assertEq(address(re).balance, 0.5 ether);
        assertEq(clipperPool.balance, 0.3 ether);
        assertEq(team.balance, 0.2 ether);
    }

    // ------------------------------------------------------------------
    // ERC-20 distribution
    // ------------------------------------------------------------------

    function test_DistributeToken_ERC20() public {
        uint256 amount = 1_000_000e18 + 7;
        cut.mint(address(pool), amount);

        vm.expectEmit(true, false, false, true, address(pool));
        emit CutPool.Distributed(address(cut), amount);
        vm.prank(anyone);
        pool.distributeToken(address(cut));

        assertEq(cut.balanceOf(dev), amount * 5000 / 10_000);
        assertEq(cut.balanceOf(clipperPool), amount * 3000 / 10_000);
        assertEq(cut.balanceOf(team), amount - cut.balanceOf(dev) - cut.balanceOf(clipperPool));
        assertEq(cut.balanceOf(dev) + cut.balanceOf(clipperPool) + cut.balanceOf(team), amount);
        assertEq(cut.balanceOf(address(pool)), 0);
    }

    function test_DistributeToken_NoReturnValueToken() public {
        MockERC20 usdtLike = new MockERC20("T", "T", false);
        usdtLike.mint(address(pool), 100);
        pool.distributeToken(address(usdtLike));
        assertEq(usdtLike.balanceOf(dev), 50);
        assertEq(usdtLike.balanceOf(clipperPool), 30);
        assertEq(usdtLike.balanceOf(team), 20);
    }

    function test_DistributeToken_RevertsOnFalseReturn() public {
        cut.mint(address(pool), 100);
        cut.setFailTransfers(true);
        vm.expectRevert(abi.encodeWithSelector(SafeTransferLib.TokenTransferFailed.selector, address(cut), dev, 50));
        pool.distributeToken(address(cut));
    }

    function test_DistributeToken_RevertsOnZeroAddressOrEmpty() public {
        vm.expectRevert(CutPool.ZeroAddress.selector);
        pool.distributeToken(address(0));
        vm.expectRevert(CutPool.NothingToDistribute.selector);
        pool.distributeToken(address(cut));
    }

    // ------------------------------------------------------------------
    // claim()
    // ------------------------------------------------------------------

    function test_Claim_ForwardsDataToTargetWithZeroValue() public {
        vm.deal(address(locker), 1 ether);
        locker.setPayout(0.7 ether);

        bytes memory data = abi.encodeCall(MockClaimTarget.collectFees, (address(cut)));
        vm.expectEmit(true, false, false, true, address(pool));
        emit CutPool.Claimed(anyone, data, abi.encode(uint256(0.7 ether)));

        vm.prank(anyone);
        bytes memory result = pool.claim(data);

        assertEq(locker.lastCaller(), address(pool), "locker must see CutPool as msg.sender");
        assertEq(locker.lastData(), data, "calldata forwarded verbatim");
        assertEq(locker.lastValue(), 0, "zero value");
        assertEq(locker.calls(), 1);
        assertEq(abi.decode(result, (uint256)), 0.7 ether);
        assertEq(address(pool).balance, 0.7 ether, "fees arrived in CutPool");

        // and the fees are now splittable by anyone
        pool.distribute();
        assertEq(dev.balance, 0.35 ether);
        assertEq(clipperPool.balance, 0.21 ether);
        assertEq(team.balance, 0.14 ether);
    }

    function test_Claim_RevertsOnZeroTarget() public {
        CutPool noTarget = new CutPool(_recipients(), _bps(5000, 3000, 2000), address(0), bytes4(0));
        vm.expectRevert(CutPool.ClaimTargetNotSet.selector);
        noTarget.claim(abi.encodeCall(MockClaimTarget.collectFees, (address(cut))));
    }

    function test_Claim_RevertsOnWrongSelector() public {
        // Somebody tries to use CutPool's creator identity to redirect fees to themselves.
        bytes memory evil = abi.encodeCall(MockClaimTarget.setFeeRedirect, (address(cut), anyone));
        vm.prank(anyone);
        vm.expectRevert(CutPool.ClaimSelectorMismatch.selector);
        pool.claim(evil);
        assertEq(locker.feeRedirect(), address(0));

        vm.expectRevert(CutPool.ClaimSelectorMismatch.selector);
        pool.claim(hex"aabb"); // shorter than a selector
    }

    function test_Claim_BubblesTargetRevert() public {
        CutPool p =
            new CutPool(_recipients(), _bps(5000, 3000, 2000), address(locker), MockClaimTarget.alwaysReverts.selector);
        bytes memory data = abi.encodeCall(MockClaimTarget.alwaysReverts, ());
        bytes memory expected = abi.encodeWithSignature("Error(string)", "locker: nothing to claim");
        vm.expectRevert(abi.encodeWithSelector(CutPool.ClaimFailed.selector, expected));
        p.claim(data);
    }

    // ------------------------------------------------------------------
    // unwrapWETH()
    // ------------------------------------------------------------------

    function test_UnwrapWETH_ThenDistribute() public {
        vm.deal(anyone, 1 ether);
        vm.prank(anyone);
        weth.deposit{value: 1 ether}();
        vm.prank(anyone);
        weth.transfer(address(pool), 1 ether);
        assertEq(weth.balanceOf(address(pool)), 1 ether);

        vm.expectEmit(true, false, false, true, address(pool));
        emit CutPool.Unwrapped(address(weth), 1 ether);
        vm.prank(anyone);
        pool.unwrapWETH(address(weth)); // MockWETH pays with a 2300-gas `transfer`, like WETH9

        assertEq(weth.balanceOf(address(pool)), 0);
        assertEq(address(pool).balance, 1 ether);

        pool.distribute();
        assertEq(dev.balance, 0.5 ether);
        assertEq(clipperPool.balance, 0.3 ether);
        assertEq(team.balance, 0.2 ether);
    }

    function test_UnwrapWETH_RevertsWhenNothingToUnwrap() public {
        vm.expectRevert(CutPool.NothingToUnwrap.selector);
        pool.unwrapWETH(address(weth));
    }

    function test_UnwrapWETH_RevertsIfContractDoesNotBehaveLikeWETH() public {
        FakeWETH fake = new FakeWETH();
        fake.mint(address(pool), 5);
        vm.expectRevert(CutPool.UnwrapMismatch.selector);
        pool.unwrapWETH(address(fake));
    }

    // ------------------------------------------------------------------
    // receive()
    // ------------------------------------------------------------------

    function test_Receive_EmitsEvent() public {
        vm.deal(anyone, 1);
        vm.expectEmit(true, false, false, true, address(pool));
        emit CutPool.Received(anyone, 1);
        vm.prank(anyone);
        (bool ok,) = address(pool).call{value: 1}("");
        assertTrue(ok);
    }

    function test_Receive_FitsIn2300GasStipend() public {
        vm.deal(address(this), 1);
        (bool ok,) = address(pool).call{value: 1, gas: 2300}("");
        assertTrue(ok, "receive() must work with the 2300 gas stipend used by WETH9.withdraw");
    }
}
