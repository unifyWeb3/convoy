// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";
import { ConvoyRegistry } from "../src/ConvoyRegistry.sol";

/// @notice Unit tests for ConvoyRegistry — every happy path and every revert path.
/// @dev The reverts are the point: each one is a real invalid-input source that KeeperHub's
///      `simulate:true` decodes into `revertReason`. Nothing here is staged or mocked.
contract ConvoyRegistryTest is Test {
    ConvoyRegistry internal registry;

    address internal operator = address(0xA11CE);
    address internal stranger = address(0xB0B);

    bytes32 internal constant RUN_ID = keccak256("convoy-run-1");
    bytes32 internal constant HASH_A = keccak256("payload-a");
    bytes32 internal constant HASH_B = keccak256("payload-b");

    event RunOpened(bytes32 indexed runId, address indexed operator, uint64 at);
    event ActionCommitted(
        bytes32 indexed runId, uint256 indexed idx, bytes32 payloadHash, uint32 seq, uint64 at
    );
    event RunSealed(bytes32 indexed runId, uint32 committedCount, uint64 at);

    function setUp() public {
        registry = new ConvoyRegistry();
        vm.warp(1_754_179_200); // fixed timestamp so openedAt/sealedAt assertions are exact
    }

    // --- helpers -----------------------------------------------------------------------------

    function _open(bytes32 runId) internal {
        vm.prank(operator);
        registry.openRun(runId);
    }

    function _commit(bytes32 runId, uint256 idx, bytes32 h) internal {
        vm.prank(operator);
        registry.commitAction(runId, idx, h);
    }

    function _state(bytes32 runId) internal view returns (ConvoyRegistry.State s) {
        (s,,,,) = registry.runs(runId);
    }

    function _run(bytes32 runId)
        internal
        view
        returns (
            ConvoyRegistry.State state,
            address op,
            uint64 openedAt,
            uint64 sealedAt,
            uint32 committedCount
        )
    {
        return registry.runs(runId);
    }

    // --- openRun -----------------------------------------------------------------------------

    function test_openRun_setsOpen() public {
        _open(RUN_ID);

        (
            ConvoyRegistry.State state,
            address op,
            uint64 openedAt,
            uint64 sealedAt,
            uint32 committedCount
        ) = _run(RUN_ID);

        assertEq(uint8(state), uint8(ConvoyRegistry.State.Open), "state must be Open");
        assertEq(op, operator, "operator must be the opener");
        assertEq(openedAt, uint64(block.timestamp), "openedAt must be the block timestamp");
        assertEq(sealedAt, 0, "sealedAt must still be zero");
        assertEq(committedCount, 0, "committedCount must start at zero");
    }

    function test_openRun_emitsRunOpened() public {
        vm.expectEmit(true, true, false, true, address(registry));
        emit RunOpened(RUN_ID, operator, uint64(block.timestamp));
        _open(RUN_ID);
    }

    function test_openRun_revertsAlreadyOpen() public {
        _open(RUN_ID);
        vm.prank(operator);
        vm.expectRevert(ConvoyRegistry.AlreadyOpen.selector);
        registry.openRun(RUN_ID);
    }

    /// @dev A stranger reopening an already-open run is rejected on state, not on identity:
    ///      `openRun` is permissionless by design (anyone may open a *fresh* runId and thereby
    ///      become its operator), so the only guard is `state != None`.
    function test_openRun_revertsAlreadyOpen_forStranger() public {
        _open(RUN_ID);
        vm.prank(stranger);
        vm.expectRevert(ConvoyRegistry.AlreadyOpen.selector);
        registry.openRun(RUN_ID);
    }

    /// @dev Documents frozen behaviour recorded as gap G-10: reopening a *sealed* run reverts
    ///      `AlreadyOpen()`, not `AlreadySealed()`, because the guard tests `state != State.None`.
    ///      `AlreadySealed()` is declared in the frozen source but is unreachable. Not reconciled.
    function test_openRun_revertsAlreadyOpen_whenSealed() public {
        _open(RUN_ID);
        _commit(RUN_ID, 0, HASH_A);
        vm.prank(operator);
        registry.sealRun(RUN_ID);

        vm.prank(operator);
        vm.expectRevert(ConvoyRegistry.AlreadyOpen.selector);
        registry.openRun(RUN_ID);
    }

    function test_openRun_isPermissionlessForFreshRunId() public {
        vm.prank(stranger);
        registry.openRun(RUN_ID);
        (, address op,,,) = _run(RUN_ID);
        assertEq(op, stranger, "the opener becomes the operator");
    }

    // --- commitAction ------------------------------------------------------------------------

    function test_commitAction_storesPayloadAndIncrementsCount() public {
        _open(RUN_ID);
        _commit(RUN_ID, 7, HASH_A);

        assertTrue(registry.isCommitted(RUN_ID, 7), "idx 7 must be committed");
        assertTrue(registry.committed(RUN_ID, 7), "committed mapping must be set");
        assertEq(registry.payloadHash(RUN_ID, 7), HASH_A, "payloadHash must be stored verbatim");

        (,,,, uint32 committedCount) = _run(RUN_ID);
        assertEq(committedCount, 1, "committedCount must be 1");
    }

    function test_commitAction_emitsActionCommittedWithSeq() public {
        _open(RUN_ID);

        vm.expectEmit(true, true, false, true, address(registry));
        emit ActionCommitted(RUN_ID, 3, HASH_A, 1, uint64(block.timestamp));
        _commit(RUN_ID, 3, HASH_A);

        vm.expectEmit(true, true, false, true, address(registry));
        emit ActionCommitted(RUN_ID, 9, HASH_B, 2, uint64(block.timestamp));
        _commit(RUN_ID, 9, HASH_B);
    }

    /// @dev `seq` (committedCount) is monotonic; `idx` need not be sequential or ordered. The
    ///      contract enforces sequencing through the counter, and uniqueness through `committed`.
    function test_commitAction_seqIsMonotonicAcrossUnorderedIdx() public {
        _open(RUN_ID);
        _commit(RUN_ID, 42, HASH_A);
        _commit(RUN_ID, 5, HASH_B);
        _commit(RUN_ID, 100, HASH_A);

        (,,,, uint32 committedCount) = _run(RUN_ID);
        assertEq(committedCount, 3, "counter advances once per commit regardless of idx order");
    }

    function test_commitAction_revertsNotOpen() public {
        vm.prank(operator);
        vm.expectRevert(ConvoyRegistry.NotOpen.selector);
        registry.commitAction(RUN_ID, 0, HASH_A);
    }

    function test_commitAction_revertsNotOpen_afterSeal() public {
        _open(RUN_ID);
        _commit(RUN_ID, 0, HASH_A);
        vm.prank(operator);
        registry.sealRun(RUN_ID);

        vm.prank(operator);
        vm.expectRevert(ConvoyRegistry.NotOpen.selector);
        registry.commitAction(RUN_ID, 1, HASH_B);
    }

    function test_commitAction_revertsNotOperator() public {
        _open(RUN_ID);
        vm.prank(stranger);
        vm.expectRevert(ConvoyRegistry.NotOperator.selector);
        registry.commitAction(RUN_ID, 0, HASH_A);
    }

    function test_commitAction_revertsDupIndex() public {
        _open(RUN_ID);
        _commit(RUN_ID, 0, HASH_A);

        vm.prank(operator);
        vm.expectRevert(ConvoyRegistry.DupIndex.selector);
        registry.commitAction(RUN_ID, 0, HASH_B);
    }

    /// @dev `DupIndex()` is what makes onchain double-execution impossible even if Convoy or
    ///      KeeperHub retried a landed write.
    function test_commitAction_dupIndexLeavesStateUnchanged() public {
        _open(RUN_ID);
        _commit(RUN_ID, 0, HASH_A);

        vm.prank(operator);
        vm.expectRevert(ConvoyRegistry.DupIndex.selector);
        registry.commitAction(RUN_ID, 0, HASH_B);

        assertEq(registry.payloadHash(RUN_ID, 0), HASH_A, "original payload must survive");
        (,,,, uint32 committedCount) = _run(RUN_ID);
        assertEq(committedCount, 1, "counter must not advance on a rejected commit");
    }

    function test_commitAction_isolatesRuns() public {
        bytes32 other = keccak256("convoy-run-2");
        _open(RUN_ID);
        _open(other);

        _commit(RUN_ID, 0, HASH_A);

        assertTrue(registry.isCommitted(RUN_ID, 0), "run 1 idx 0 committed");
        assertFalse(registry.isCommitted(other, 0), "run 2 idx 0 must be untouched");

        (,,,, uint32 otherCount) = _run(other);
        assertEq(otherCount, 0, "run 2 counter must be untouched");
    }

    function testFuzz_commitAction_storesAnyPayloadAtAnyIdx(uint256 idx, bytes32 h) public {
        _open(RUN_ID);
        _commit(RUN_ID, idx, h);

        assertTrue(registry.isCommitted(RUN_ID, idx));
        assertEq(registry.payloadHash(RUN_ID, idx), h);
    }

    // --- sealRun -----------------------------------------------------------------------------

    function test_sealRun_setsSealed() public {
        _open(RUN_ID);
        _commit(RUN_ID, 0, HASH_A);
        _commit(RUN_ID, 1, HASH_B);

        vm.prank(operator);
        registry.sealRun(RUN_ID);

        (ConvoyRegistry.State state,,, uint64 sealedAt, uint32 committedCount) = _run(RUN_ID);
        assertEq(uint8(state), uint8(ConvoyRegistry.State.Sealed), "state must be Sealed");
        assertEq(sealedAt, uint64(block.timestamp), "sealedAt must be the block timestamp");
        assertEq(committedCount, 2, "committedCount must survive sealing");
    }

    function test_sealRun_emitsRunSealed() public {
        _open(RUN_ID);
        _commit(RUN_ID, 0, HASH_A);

        vm.expectEmit(true, false, false, true, address(registry));
        emit RunSealed(RUN_ID, 1, uint64(block.timestamp));
        vm.prank(operator);
        registry.sealRun(RUN_ID);
    }

    function test_sealRun_revertsNotOpen() public {
        vm.prank(operator);
        vm.expectRevert(ConvoyRegistry.NotOpen.selector);
        registry.sealRun(RUN_ID);
    }

    /// @dev Double-seal is rejected on state: the second seal sees `Sealed`, not `Open`.
    function test_sealRun_revertsNotOpen_whenAlreadySealed() public {
        _open(RUN_ID);
        _commit(RUN_ID, 0, HASH_A);
        vm.prank(operator);
        registry.sealRun(RUN_ID);

        vm.prank(operator);
        vm.expectRevert(ConvoyRegistry.NotOpen.selector);
        registry.sealRun(RUN_ID);
    }

    function test_sealRun_revertsNotOperator() public {
        _open(RUN_ID);
        _commit(RUN_ID, 0, HASH_A);

        vm.prank(stranger);
        vm.expectRevert(ConvoyRegistry.NotOperator.selector);
        registry.sealRun(RUN_ID);
    }

    function test_sealRun_revertsNothingCommitted() public {
        _open(RUN_ID);

        vm.prank(operator);
        vm.expectRevert(ConvoyRegistry.NothingCommitted.selector);
        registry.sealRun(RUN_ID);
    }

    // --- isCommitted -------------------------------------------------------------------------

    function test_isCommitted_falseForUnopenedRun() public view {
        assertFalse(registry.isCommitted(RUN_ID, 0), "nothing is committed before openRun");
    }

    function test_isCommitted_falseForUncommittedIdx() public {
        _open(RUN_ID);
        _commit(RUN_ID, 0, HASH_A);
        assertFalse(registry.isCommitted(RUN_ID, 1), "idx 1 was never committed");
    }

    function test_isCommitted_survivesSeal() public {
        _open(RUN_ID);
        _commit(RUN_ID, 0, HASH_A);
        vm.prank(operator);
        registry.sealRun(RUN_ID);

        assertTrue(registry.isCommitted(RUN_ID, 0), "commitments are permanent after sealing");
    }

    // --- lifecycle ---------------------------------------------------------------------------

    function test_fullLifecycle_openCommitSeal() public {
        assertEq(uint8(_state(RUN_ID)), uint8(ConvoyRegistry.State.None));

        _open(RUN_ID);
        assertEq(uint8(_state(RUN_ID)), uint8(ConvoyRegistry.State.Open));

        for (uint256 i = 0; i < 12; i++) {
            _commit(RUN_ID, i, keccak256(abi.encode("payload", i)));
        }

        vm.prank(operator);
        registry.sealRun(RUN_ID);
        assertEq(uint8(_state(RUN_ID)), uint8(ConvoyRegistry.State.Sealed));

        (,,,, uint32 committedCount) = _run(RUN_ID);
        assertEq(committedCount, 12, "a 12-item run seals with 12 commitments");

        for (uint256 i = 0; i < 12; i++) {
            assertTrue(registry.isCommitted(RUN_ID, i));
            assertEq(registry.payloadHash(RUN_ID, i), keccak256(abi.encode("payload", i)));
        }
    }
}
