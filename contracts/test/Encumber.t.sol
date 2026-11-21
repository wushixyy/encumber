// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Encumber} from "../src/Encumber.sol";

contract EncumberTest is Test {
    Encumber internal e;
    address internal vendorA = makeAddr("vendorA");
    address internal vendorB = makeAddr("vendorB");
    address internal agentA = makeAddr("agentA");
    address internal agentB = makeAddr("agentB");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant A = 0;
    uint256 internal constant B = 1;

    // 场景：团队预算 100，项目甲 60、项目乙 40
    function setUp() public {
        e = new Encumber();
        e.deposit{value: 100 ether}();
        e.createProject(unicode"客服项目", vendorA);
        e.createProject(unicode"数据项目", vendorB);
        e.addAgent(agentA, A, unicode"客服 Agent");
        e.addAgent(agentB, B, unicode"数据 Agent");
        e.allocate(A, 60 ether);
        e.allocate(B, 40 ether);
    }

    function _view(uint256 id) internal view returns (Encumber.ProjectView memory) {
        return e.getProjects()[id];
    }

    function _assertSolvent() internal view {
        Encumber.ProjectView[] memory ps = e.getProjects();
        uint256 held = e.unallocated();
        for (uint256 i = 0; i < ps.length; i++) {
            held += ps[i].allocated - ps[i].spent; // 当前持有
        }
        assertEq(address(e).balance, held, "vault balance must equal unallocated + held");
    }

    function test_ReserveSettleReleasesRemainder() public {
        vm.prank(agentA);
        uint256 rid = e.reserve(20 ether);
        assertEq(_view(A).reserved, 20 ether);
        assertEq(_view(A).available, 40 ether);

        vm.prank(agentA);
        assertTrue(e.settle(rid, 12 ether));
        assertEq(vendorA.balance, 12 ether);
        assertEq(_view(A).reserved, 0);
        assertEq(_view(A).spent, 12 ether);
        assertEq(_view(A).available, 48 ether); // 剩余 8 已释放
        _assertSolvent();
    }

    /// 幕一：钱被预占后，财务调不走
    function test_ReallocateBlockedByReservation() public {
        vm.prank(agentA);
        e.pay(40 ether); // 甲已花 40，可用 20
        vm.prank(agentA);
        e.reserve(20 ether); // 预占最后 20

        vm.expectEmit(true, true, true, true);
        emit Encumber.Rejected(Encumber.Action.Reallocate, Encumber.Reason.FundsReserved, address(this), A, B, 20 ether);
        assertFalse(e.reallocate(A, B, 20 ether));
        assertEq(_view(B).available, 40 ether); // 乙没有收到
        _assertSolvent();
    }

    /// 幕二：结算后释放的部分可以调拨
    function test_ReleasedRemainderCanBeReallocated() public {
        vm.prank(agentA);
        e.pay(40 ether);
        vm.prank(agentA);
        uint256 rid = e.reserve(20 ether);
        vm.prank(agentA);
        e.settle(rid, 12 ether); // 释放 8

        assertFalse(e.reallocate(A, B, 9 ether)); // 多 1 都不行
        assertTrue(e.reallocate(A, B, 8 ether));
        assertEq(_view(A).available, 0);
        assertEq(_view(B).available, 48 ether);
        _assertSolvent();
    }

    /// 幕三 · 顺序一：付款先上链，调拨被拦
    function test_OrderPayFirstThenReallocate() public {
        vm.prank(agentB);
        e.pay(40 ether); // 乙花完
        vm.prank(agentA);
        e.pay(40 ether); // 甲已花 40、剩 20

        vm.prank(agentA);
        assertTrue(e.pay(20 ether)); // 甲的 Agent 先付最后 20
        assertFalse(e.reallocate(A, B, 20 ether)); // 财务的调拨被拦下

        assertEq(vendorA.balance, 60 ether);
        assertEq(_view(B).available, 0);
        _assertSolvent();
    }

    /// 幕三 · 顺序二：调拨先上链，付款被拦，乙可以花这 20
    function test_OrderReallocateFirstThenPay() public {
        vm.prank(agentB);
        e.pay(40 ether);
        vm.prank(agentA);
        e.pay(40 ether);

        assertTrue(e.reallocate(A, B, 20 ether)); // 财务先调走
        vm.prank(agentA);
        assertFalse(e.pay(20 ether)); // 甲的付款被拦下
        vm.prank(agentB);
        assertTrue(e.pay(20 ether)); // 乙花掉这 20

        assertEq(vendorA.balance, 40 ether);
        assertEq(vendorB.balance, 60 ether);
        _assertSolvent();
    }

    function test_SpentStaysInOriginalProject() public {
        vm.prank(agentA);
        e.pay(10 ether);
        e.reallocate(A, B, 50 ether); // 把甲剩下的全部调走
        assertEq(_view(A).spent, 10 ether); // 已花的留在甲的账上
        assertEq(_view(A).available, 0);
        assertEq(_view(B).available, 90 ether);
        _assertSolvent();
    }

    function test_SettleRules() public {
        vm.prank(agentA);
        uint256 rid = e.reserve(10 ether);

        vm.prank(agentB);
        assertFalse(e.settle(rid, 5 ether)); // 不是这笔预占的 Agent
        vm.prank(agentA);
        assertFalse(e.settle(rid, 11 ether)); // 超过预占上限
        vm.prank(agentA);
        assertTrue(e.settle(rid, 10 ether));
        vm.prank(agentA);
        assertFalse(e.settle(rid, 1 ether)); // 不能重复结算，不会多付钱
        assertEq(vendorA.balance, 10 ether);
        _assertSolvent();
    }

    function test_ReleaseCancelsReservation() public {
        vm.prank(agentA);
        uint256 rid = e.reserve(30 ether);
        vm.prank(agentA);
        assertTrue(e.release(rid));
        assertEq(_view(A).available, 60 ether);
        vm.prank(agentA);
        assertFalse(e.release(rid));
    }

    function test_StrangerAndOverspendRejected() public {
        vm.prank(stranger);
        assertFalse(e.pay(1 ether));
        vm.prank(agentA);
        assertFalse(e.pay(61 ether));
        vm.prank(agentA);
        assertEq(e.reserve(61 ether), type(uint256).max);
        _assertSolvent();
    }

    function test_OnlyOwnerManages() public {
        vm.prank(stranger);
        vm.expectRevert(Encumber.NotOwner.selector);
        e.reallocate(A, B, 1 ether);
    }

    function test_ActivitiesRecordRejectionsWithReason() public {
        vm.prank(agentA);
        e.reserve(60 ether);
        e.reallocate(A, B, 10 ether); // 被拦：钱被预占

        Encumber.Activity[] memory acts = e.getActivities();
        assertEq(uint8(acts[0].action), uint8(Encumber.Action.Reallocate));
        assertEq(uint8(acts[0].reason), uint8(Encumber.Reason.FundsReserved));
        assertEq(uint8(acts[1].action), uint8(Encumber.Action.Reserve));
        assertEq(uint8(acts[1].reason), uint8(Encumber.Reason.None));
    }
}
