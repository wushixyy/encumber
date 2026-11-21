// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {HoldTheScreen} from "../src/HoldTheScreen.sol";

/// @dev 收款时故意 revert 的合约，用来测试“转账失败记账”
contract Rejecter {
    function take(HoldTheScreen screen, uint256 slotId, uint256 price) external payable {
        screen.takeOver{value: msg.value}(slotId, "rejecter", 0, "no refunds", price);
    }

    receive() external payable {
        revert("nope");
    }
}

contract HoldTheScreenTest is Test {
    HoldTheScreen internal screen;
    address internal venue = makeAddr("venue");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public {
        screen = new HoldTheScreen(venue, 7000);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(carol, 10 ether);
    }

    function _take(address who, uint256 slotId, uint256 value, uint256 newPrice) internal {
        vm.prank(who);
        screen.takeOver{value: value}(slotId, "nick", 0, "hello", newPrice);
    }

    // 价格 1 ether 时，每秒税 = 0.01 ether

    function test_TakeVacantSlotForFree() public {
        _take(alice, 0, 1 ether, 1 ether);
        HoldTheScreen.SlotView memory v = screen.getSlot(0);
        assertEq(v.holder, alice);
        assertEq(v.price, 1 ether);
        assertEq(v.depositLeft, 1 ether); // 无主时不付定价，全部作为押金
        assertEq(v.secondsLeft, 100);
        assertEq(screen.totalTakeovers(), 1);
    }

    function test_TakeOverPaysPriceAndRefundsDeposit() public {
        _take(alice, 0, 1 ether, 1 ether);
        vm.warp(block.timestamp + 10); // 欠税 0.1 ether

        uint256 aliceBefore = alice.balance;
        _take(bob, 0, 1.5 ether, 2 ether); // 付 alice 1 ether 定价，0.5 ether 押金

        // alice 收到：定价 1 ether + 剩余押金 0.9 ether
        assertEq(alice.balance - aliceBefore, 1.9 ether);
        HoldTheScreen.SlotView memory v = screen.getSlot(0);
        assertEq(v.holder, bob);
        assertEq(v.price, 2 ether);
        assertEq(v.depositLeft, 0.5 ether);
        assertEq(screen.totalHeldSeconds(alice), 10);
    }

    function test_TaxSplitsBetweenVenueAndPrizePool() public {
        _take(alice, 0, 1 ether, 1 ether);
        vm.warp(block.timestamp + 10); // 欠税 0.1 ether
        screen.settle(0);

        assertEq(venue.balance, 0.07 ether); // 70%
        assertEq(screen.prizePool(), 0.03 ether); // 30%
        assertEq(screen.getSlot(0).depositLeft, 0.9 ether);
    }

    function test_ForeclosesWhenDepositRunsOut() public {
        _take(alice, 0, 0.5 ether, 1 ether); // 押金只够 50 秒
        vm.warp(block.timestamp + 80);

        // 只读视图已经显示为无主
        assertEq(screen.getSlot(0).holder, address(0));

        screen.settle(0);
        assertEq(screen.totalHeldSeconds(alice), 50);
        assertEq(venue.balance, 0.35 ether);
        assertEq(screen.prizePool(), 0.15 ether);

        // 无主后任何人免费占领
        uint256 bobBefore = bob.balance;
        _take(bob, 0, 0.1 ether, 0.01 ether);
        assertEq(screen.getSlot(0).holder, bob);
        assertEq(bobBefore - bob.balance, 0.1 ether); // 全部成了押金，没有付给任何人
    }

    function test_RevertWhenPaymentDoesNotCoverPrice() public {
        _take(alice, 0, 1 ether, 1 ether);
        vm.prank(bob);
        vm.expectRevert(HoldTheScreen.InsufficientPayment.selector);
        screen.takeOver{value: 1 ether}(0, "bob", 0, "hi", 1 ether); // 刚好等于定价，没有押金
    }

    function test_NewPriceCanBeLower() public {
        _take(alice, 0, 2 ether, 1 ether);
        _take(bob, 0, 1.1 ether, 0.01 ether); // 不要求加价
        assertEq(screen.getSlot(0).price, 0.01 ether);
    }

    function test_RevertWhenPriceBelowMinimum() public {
        vm.prank(alice);
        vm.expectRevert(HoldTheScreen.PriceTooLow.selector);
        screen.takeOver{value: 1 ether}(0, "a", 0, "hi", 0.0001 ether);
    }

    function test_SlotsAreIndependent() public {
        _take(alice, 0, 1 ether, 1 ether);
        _take(bob, 1, 1 ether, 0.5 ether);
        _take(carol, 2, 1 ether, 0.2 ether);

        HoldTheScreen.SlotView[] memory views = screen.getSlots();
        assertEq(views.length, 3);
        assertEq(views[0].holder, alice);
        assertEq(views[1].holder, bob);
        assertEq(views[2].holder, carol);
    }

    function test_MediaContentStored() public {
        vm.prank(alice);
        screen.takeOver{value: 1 ether}(1, unicode"小王", 2, "https://media.example/v.mp4", 1 ether);
        HoldTheScreen.SlotView memory v = screen.getSlot(1);
        assertEq(v.kind, 2);
        assertEq(v.nickname, unicode"小王");
        assertEq(v.content, "https://media.example/v.mp4");
    }

    function test_RevertOnInvalidInput() public {
        vm.startPrank(alice);
        vm.expectRevert(HoldTheScreen.InvalidSlot.selector);
        screen.takeOver{value: 1 ether}(3, "a", 0, "hi", 1 ether);
        vm.expectRevert(HoldTheScreen.InvalidKind.selector);
        screen.takeOver{value: 1 ether}(0, "a", 3, "hi", 1 ether);
        vm.expectRevert(HoldTheScreen.EmptyContent.selector);
        screen.takeOver{value: 1 ether}(0, "a", 0, "", 1 ether);
        vm.stopPrank();
    }

    function test_TopUpAndSetPrice() public {
        _take(alice, 0, 1 ether, 1 ether);
        vm.startPrank(alice);
        screen.topUp{value: 1 ether}(0);
        screen.setPrice(0, 0.5 ether);
        vm.stopPrank();
        HoldTheScreen.SlotView memory v = screen.getSlot(0);
        assertEq(v.depositLeft, 2 ether);
        assertEq(v.price, 0.5 ether);

        vm.prank(bob);
        vm.expectRevert(HoldTheScreen.NotHolder.selector);
        screen.setPrice(0, 1 ether);
    }

    function test_RejectingHolderCannotBlockSlot() public {
        Rejecter r = new Rejecter();
        r.take{value: 1 ether}(screen, 0, 1 ether);

        _take(bob, 0, 2 ether, 1 ether); // 给 Rejecter 转账失败，但抢屏照样成功
        assertEq(screen.getSlot(0).holder, bob);
        assertEq(screen.pendingWithdrawals(address(r)), 2 ether); // 定价 1 + 押金 1
    }

    function test_FundPlayers() public {
        address[] memory players = new address[](2);
        players[0] = makeAddr("p1");
        players[1] = makeAddr("p2");
        screen.fundPlayers{value: 0.2 ether}(players, 0.1 ether);
        assertEq(players[0].balance, 0.1 ether);
        assertEq(players[1].balance, 0.1 ether);

        vm.prank(alice);
        vm.expectRevert(HoldTheScreen.NotOwner.selector);
        screen.fundPlayers{value: 0.1 ether}(players, 0.05 ether);
    }

    function test_WithdrawPrize() public {
        _take(alice, 0, 1 ether, 1 ether);
        vm.warp(block.timestamp + 10);
        screen.settle(0); // 奖池 0.03 ether

        screen.withdrawPrize(carol, 0.03 ether);
        assertEq(carol.balance, 10.03 ether);
        assertEq(screen.prizePool(), 0);
    }
}
