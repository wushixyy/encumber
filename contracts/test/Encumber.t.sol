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
    bytes32 internal constant ORDER = bytes32("order-001");
    uint256 internal constant TTL = 600;

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

    function _commit(uint256 amount) internal returns (uint256 rid) {
        vm.prank(agentA);
        rid = e.reserve(amount, ORDER, TTL);
    }

    function test_CommitmentBindsVendorOrderAndDeadline() public {
        uint256 rid = _commit(20 ether);
        Encumber.Reservation memory r = e.getReservation(rid);
        assertEq(r.vendor, vendorA);
        assertEq(r.agent, agentA);
        assertEq(r.orderId, ORDER);
        assertEq(r.deadline, block.timestamp + TTL);
        assertEq(_view(A).reserved, 20 ether);
        assertEq(_view(A).available, 40 ether);
    }

    /// 主线：Agent 掉线，供应商自己按实际用量结算，剩余自动释放
    function test_VendorSettlesWithoutAgent() public {
        uint256 rid = _commit(20 ether);
        vm.prank(vendorA);
        assertTrue(e.settle(rid, 12 ether));
        assertEq(vendorA.balance, 12 ether);
        assertEq(_view(A).reserved, 0);
        assertEq(_view(A).spent, 12 ether);
        assertEq(_view(A).available, 48 ether); // 剩余 8 已释放
        _assertSolvent();
    }

    function test_OnlyDesignatedVendorCanSettle() public {
        uint256 rid = _commit(20 ether);
        vm.prank(agentA);
        assertFalse(e.settle(rid, 5 ether)); // Agent 自己不能结算给别人
        vm.prank(vendorB);
        assertFalse(e.settle(rid, 5 ether)); // 别的供应商也不行
        vm.prank(stranger);
        assertFalse(e.settle(rid, 5 ether));
        assertEq(_view(A).reserved, 20 ether);
    }

    /// 财务和 Agent 在到期前都取消不了承诺，也调不走被锁的钱
    function test_FinanceCannotCancelOrMoveActiveCommitment() public {
        vm.prank(agentA);
        e.pay(40 ether); // 甲只剩 20
        uint256 rid = _commit(20 ether);

        vm.expectEmit(true, true, true, true);
        emit Encumber.Rejected(Encumber.Action.Release, Encumber.Reason.CommitmentActive, address(this), A, A, 20 ether);
        assertFalse(e.release(rid)); // 财务取消：拒绝
        vm.prank(agentA);
        assertFalse(e.release(rid)); // Agent 取消：也拒绝

        vm.expectEmit(true, true, true, true);
        emit Encumber.Rejected(Encumber.Action.Reallocate, Encumber.Reason.FundsReserved, address(this), A, B, 20 ether);
        assertFalse(e.reallocate(A, B, 20 ether)); // 调走：拒绝
        _assertSolvent();
    }

    function test_SettleCappedAndOnlyOnce() public {
        uint256 rid = _commit(10 ether);
        vm.prank(vendorA);
        assertFalse(e.settle(rid, 11 ether)); // 超过上限
        vm.prank(vendorA);
        assertTrue(e.settle(rid, 10 ether));
        vm.prank(vendorA);
        assertFalse(e.settle(rid, 1 ether)); // 不能重复结算，不会多付钱
        assertEq(vendorA.balance, 10 ether);
        _assertSolvent();
    }

    function test_ExpiredCommitmentCannotBeSettledButCanBeReleased() public {
        uint256 rid = _commit(20 ether);
        vm.warp(block.timestamp + TTL + 1);
        vm.prank(vendorA);
        assertFalse(e.settle(rid, 5 ether)); // 过期不能再结算
        vm.prank(stranger);
        assertTrue(e.release(rid)); // 过期后任何人都能释放
        assertEq(_view(A).available, 60 ether);
        _assertSolvent();
    }

    function test_VendorCanWaiveEarly() public {
        uint256 rid = _commit(20 ether);
        vm.prank(vendorA);
        assertTrue(e.release(rid)); // 供应商主动放弃
        assertEq(_view(A).available, 60 ether);
    }

    /// 结算后释放的部分可以调拨，已花的留在原项目
    function test_ReleasedRemainderCanBeReallocated() public {
        vm.prank(agentA);
        e.pay(40 ether);
        uint256 rid = _commit(20 ether);
        vm.prank(vendorA);
        e.settle(rid, 12 ether); // 释放 8

        assertFalse(e.reallocate(A, B, 9 ether)); // 多 1 都不行
        assertTrue(e.reallocate(A, B, 8 ether));
        assertEq(_view(A).available, 0);
        assertEq(_view(A).spent, 52 ether);
        assertEq(_view(B).available, 48 ether);
        _assertSolvent();
    }

    /// 顺序一：付款先上链，调拨被拦
    function test_OrderPayFirstThenReallocate() public {
        vm.prank(agentB);
        e.pay(40 ether);
        vm.prank(agentA);
        e.pay(40 ether);

        vm.prank(agentA);
        assertTrue(e.pay(20 ether));
        assertFalse(e.reallocate(A, B, 20 ether));

        assertEq(vendorA.balance, 60 ether);
        assertEq(_view(B).available, 0);
        _assertSolvent();
    }

    /// 顺序二：调拨先上链，付款被拦，乙可以花这 20
    function test_OrderReallocateFirstThenPay() public {
        vm.prank(agentB);
        e.pay(40 ether);
        vm.prank(agentA);
        e.pay(40 ether);

        assertTrue(e.reallocate(A, B, 20 ether));
        vm.prank(agentA);
        assertFalse(e.pay(20 ether));
        vm.prank(agentB);
        assertTrue(e.pay(20 ether));

        assertEq(vendorA.balance, 40 ether);
        assertEq(vendorB.balance, 60 ether);
        _assertSolvent();
    }

    function test_StrangerAndOverspendRejected() public {
        vm.prank(stranger);
        assertFalse(e.pay(1 ether));
        vm.prank(agentA);
        assertFalse(e.pay(61 ether));
        vm.prank(agentA);
        assertEq(e.reserve(61 ether, ORDER, TTL), type(uint256).max);
        _assertSolvent();
    }

    function test_OnlyOwnerManages() public {
        vm.prank(stranger);
        vm.expectRevert(Encumber.NotOwner.selector);
        e.reallocate(A, B, 1 ether);
    }

    function test_ActivitiesRecordRejectionsWithReason() public {
        _commit(60 ether);
        e.reallocate(A, B, 10 ether); // 被拦：钱被预占

        Encumber.Activity[] memory acts = e.getActivities();
        assertEq(uint8(acts[0].action), uint8(Encumber.Action.Reallocate));
        assertEq(uint8(acts[0].reason), uint8(Encumber.Reason.FundsReserved));
        assertEq(uint8(acts[1].action), uint8(Encumber.Action.Reserve));
        assertEq(uint8(acts[1].reason), uint8(Encumber.Reason.None));
    }
}
