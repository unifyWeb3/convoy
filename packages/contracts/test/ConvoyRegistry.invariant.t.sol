// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test, console2 } from "forge-std/Test.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";
import { CommonBase } from "forge-std/Base.sol";
import { StdCheats } from "forge-std/StdCheats.sol";
import { StdUtils } from "forge-std/StdUtils.sol";
import { ConvoyRegistry } from "../src/ConvoyRegistry.sol";

/// @notice Bounded handler that drives ConvoyRegistry and mirrors every accepted call into ghost
///         state. Calls are wrapped in try/catch so a rejected call is *recorded* rather than
///         dropped: `fail_on_revert = false` (frozen in foundry.toml) would otherwise let a handler
///         that reverts on almost every call still report 1000 green runs having exercised nothing.
/// @dev The registry is driven through a small fixed set of run ids, actors and indices so that
///      collisions — reopen, duplicate index, wrong operator, seal-after-seal — are actually
///      reachable within depth=32 instead of being lost in a 2^256 search space.
contract ConvoyRegistryHandler is CommonBase, StdCheats, StdUtils {
    ConvoyRegistry public immutable registry;

    uint256 public constant RUN_COUNT = 4;
    uint256 public constant MAX_IDX = 15;

    bytes32[RUN_COUNT] internal _runIds;
    address[3] internal _actors;

    // --- ghost state (mirror of everything the registry accepted) -----------------------------
    mapping(bytes32 => bool) public ghostOpened;
    mapping(bytes32 => bool) public ghostSealed;
    mapping(bytes32 => address) public ghostOperator;
    mapping(bytes32 => uint32) public ghostCommits;
    mapping(bytes32 => uint32) public ghostLastSeq;
    mapping(bytes32 => uint32) public ghostSealCount;
    mapping(bytes32 => mapping(uint256 => bool)) public ghostCommitted;
    mapping(bytes32 => mapping(uint256 => bytes32)) public ghostPayload;

    /// @notice Set if the registry ever reported a sequence number that was not exactly the
    ///         previous one plus one. Asserted false by `invariant_idxMonotonic`.
    bool public seqViolated;

    // --- coverage counters (proof the fuzz campaign actually exercised the lifecycle) ---------
    uint256 public okOpen;
    uint256 public okCommit;
    uint256 public okSeal;
    uint256 public rejectedOpen;
    uint256 public rejectedCommit;
    uint256 public rejectedSeal;
    uint256 public totalCalls;

    constructor(ConvoyRegistry registry_) {
        registry = registry_;
        for (uint256 i = 0; i < RUN_COUNT; i++) {
            _runIds[i] = keccak256(abi.encode("convoy-invariant-run", i));
        }
        _actors[0] = address(0xA11CE);
        _actors[1] = address(0xB0B);
        _actors[2] = address(0xCA55);
    }

    function runIdAt(uint256 i) external view returns (bytes32) {
        return _runIds[i];
    }

    function actorAt(uint256 i) external view returns (address) {
        return _actors[i];
    }

    function _runId(uint256 seed) internal view returns (bytes32) {
        return _runIds[seed % RUN_COUNT];
    }

    function _actor(uint256 seed) internal view returns (address) {
        return _actors[seed % _actors.length];
    }

    /// @dev Actor selection for `commitAction` / `sealRun`, biased towards the run's own operator.
    ///      `openRun` is permissionless, so a uniformly-random actor matches the opener only one
    ///      time in three and the campaign never gets past the first commit — measured, not
    ///      assumed: uniform selection landed `accepted open/commit/seal: 4 0 0` on a 32-call run.
    ///      One seed in four still picks a random actor, which keeps `NotOperator()` reachable.
    function _operatorBiasedActor(bytes32 runId, uint256 seed) internal view returns (address) {
        address op = ghostOperator[runId];
        if (op != address(0) && seed % 4 != 0) return op;
        return _actor(seed);
    }

    function _committedCount(bytes32 runId) internal view returns (uint32 c) {
        (,,,, c) = registry.runs(runId);
    }

    // --- driven calls ------------------------------------------------------------------------

    function openRun(uint256 runSeed, uint256 actorSeed) public {
        bytes32 runId = _runId(runSeed);
        address actor = _actor(actorSeed);
        totalCalls++;

        vm.prank(actor);
        try registry.openRun(runId) {
            ghostOpened[runId] = true;
            ghostOperator[runId] = actor;
            okOpen++;
        } catch {
            rejectedOpen++;
        }
    }

    function commitAction(uint256 runSeed, uint256 actorSeed, uint256 idx, bytes32 payload) public {
        bytes32 runId = _runId(runSeed);
        address actor = _operatorBiasedActor(runId, actorSeed);
        idx = bound(idx, 0, MAX_IDX);
        totalCalls++;

        vm.prank(actor);
        try registry.commitAction(runId, idx, payload) {
            ghostCommitted[runId][idx] = true;
            ghostPayload[runId][idx] = payload;
            ghostCommits[runId] += 1;

            uint32 seq = _committedCount(runId);
            if (seq != ghostLastSeq[runId] + 1) seqViolated = true;
            ghostLastSeq[runId] = seq;

            okCommit++;
        } catch {
            rejectedCommit++;
        }
    }

    function sealRun(uint256 runSeed, uint256 actorSeed) public {
        bytes32 runId = _runId(runSeed);
        address actor = _operatorBiasedActor(runId, actorSeed);
        totalCalls++;

        vm.prank(actor);
        try registry.sealRun(runId) {
            ghostSealed[runId] = true;
            ghostSealCount[runId] += 1;
            okSeal++;
        } catch {
            rejectedSeal++;
        }
    }
}

/// @notice Handler-based invariants for the ordering guarantees the registry exists to enforce:
///         open -> commit -> seal, no commit before open, no double seal, monotonic sequencing,
///         and a committed count that always matches the commitments actually accepted.
/// @dev Configured at runs=1000 depth=32 in foundry.toml.
contract ConvoyRegistryInvariantTest is StdInvariant, Test {
    ConvoyRegistry internal registry;
    ConvoyRegistryHandler internal handler;

    function setUp() public {
        registry = new ConvoyRegistry();
        handler = new ConvoyRegistryHandler(registry);

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = ConvoyRegistryHandler.openRun.selector;
        selectors[1] = ConvoyRegistryHandler.commitAction.selector;
        selectors[2] = ConvoyRegistryHandler.sealRun.selector;

        targetContract(address(handler));
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
    }

    function _run(bytes32 runId)
        internal
        view
        returns (
            ConvoyRegistry.State state,
            address operator,
            uint64 openedAt,
            uint64 sealedAt,
            uint32 committedCount
        )
    {
        return registry.runs(runId);
    }

    /// @notice Nothing may be committed against a run that was never opened, and a run the handler
    ///         never opened must still be in state None.
    function invariant_noCommitBeforeOpen() public view {
        for (uint256 r = 0; r < handler.RUN_COUNT(); r++) {
            bytes32 runId = handler.runIdAt(r);
            (ConvoyRegistry.State state,, uint64 openedAt,, uint32 committedCount) = _run(runId);

            if (!handler.ghostOpened(runId)) {
                assertEq(
                    uint8(state), uint8(ConvoyRegistry.State.None), "unopened run must be None"
                );
                assertEq(openedAt, 0, "unopened run must have no openedAt");
                assertEq(committedCount, 0, "unopened run must have no commitments");
                for (uint256 i = 0; i <= handler.MAX_IDX(); i++) {
                    assertFalse(registry.isCommitted(runId, i), "no idx may be committed pre-open");
                }
            } else {
                assertTrue(
                    state != ConvoyRegistry.State.None, "opened run may never return to None"
                );
                assertGt(openedAt, 0, "opened run must record openedAt");
            }
        }
    }

    /// @notice A run may be sealed at most once, and only from Open with at least one commitment.
    function invariant_noDoubleSeal() public view {
        for (uint256 r = 0; r < handler.RUN_COUNT(); r++) {
            bytes32 runId = handler.runIdAt(r);
            (ConvoyRegistry.State state,,, uint64 sealedAt, uint32 committedCount) = _run(runId);

            assertLe(handler.ghostSealCount(runId), 1, "a run may be sealed at most once");

            if (state == ConvoyRegistry.State.Sealed) {
                assertTrue(handler.ghostSealed(runId), "sealed onchain implies sealed in ghost");
                assertGt(sealedAt, 0, "sealed run must record sealedAt");
                assertGt(committedCount, 0, "a sealed run always has at least one commitment");
            } else {
                assertEq(sealedAt, 0, "unsealed run must have no sealedAt");
            }
        }
    }

    /// @notice Sequence monotonicity. The blueprint's name refers to the monotonic *sequence*
    ///         (`committedCount`, emitted as `seq`), not to `idx` ordering: the frozen contract
    ///         accepts any non-duplicate `idx`, and enforces sequencing through the counter. Every
    ///         accepted commit must advance the counter by exactly one, and it must never decrease.
    function invariant_idxMonotonic() public view {
        assertFalse(seqViolatedFlag(), "every accepted commit must advance seq by exactly 1");

        for (uint256 r = 0; r < handler.RUN_COUNT(); r++) {
            bytes32 runId = handler.runIdAt(r);
            (,,,, uint32 committedCount) = _run(runId);
            assertEq(
                handler.ghostLastSeq(runId), committedCount, "last observed seq == committedCount"
            );
        }
    }

    function seqViolatedFlag() internal view returns (bool) {
        return handler.seqViolated();
    }

    /// @notice The stored counter always equals the number of commitments the registry accepted,
    ///         and every accepted commitment is still readable with its exact payload hash. This is
    ///         the property the manifest reconciler and the dependency gates depend on.
    function invariant_committedCountMatches() public view {
        for (uint256 r = 0; r < handler.RUN_COUNT(); r++) {
            bytes32 runId = handler.runIdAt(r);
            (,,,, uint32 committedCount) = _run(runId);

            assertEq(committedCount, handler.ghostCommits(runId), "counter == accepted commits");

            uint32 seen;
            for (uint256 i = 0; i <= handler.MAX_IDX(); i++) {
                bool onchain = registry.isCommitted(runId, i);
                assertEq(onchain, handler.ghostCommitted(runId, i), "commit bit must mirror ghost");
                if (onchain) {
                    assertEq(
                        registry.payloadHash(runId, i),
                        handler.ghostPayload(runId, i),
                        "payload hash must be stored verbatim"
                    );
                    seen++;
                }
            }
            assertEq(seen, committedCount, "counter == number of set commit bits");
        }
    }

    /// @notice Operator binding survives the whole campaign: the operator is always the opener and
    ///         is never reassigned.
    function invariant_operatorIsOpener() public view {
        for (uint256 r = 0; r < handler.RUN_COUNT(); r++) {
            bytes32 runId = handler.runIdAt(r);
            (, address operator,,,) = _run(runId);
            assertEq(operator, handler.ghostOperator(runId), "operator == opener, never reassigned");
        }
    }

    /// @dev Coverage report for the campaign. With `fail_on_revert = false`, green invariants are
    ///      only meaningful if the lifecycle was actually reached — these counters say how often.
    function afterInvariant() public view {
        console2.log(
            "accepted   open/commit/seal:", handler.okOpen(), handler.okCommit(), handler.okSeal()
        );
        console2.log(
            "rejected   open/commit/seal:",
            handler.rejectedOpen(),
            handler.rejectedCommit(),
            handler.rejectedSeal()
        );
        // Deliberately asserts on calls driven, not on calls accepted: a run in which the fuzzer
        // happened to pick no `openRun` is astronomically unlikely but not impossible, and a CI
        // check that flakes teaches the team to ignore it. The hard reachability guarantee is
        // `test_handler_reachesEveryState` below; the logged counters make the depth visible.
        assertGt(handler.totalCalls(), 0, "campaign drove no calls at all");
    }

    /// @notice Deterministic proof that the handler can reach every state — open, commit, seal —
    ///         so the fuzz campaign's coverage counters above are measuring a reachable lifecycle
    ///         rather than a handler that silently rejects everything.
    function test_handler_reachesEveryState() public {
        handler.openRun(0, 0);
        assertEq(handler.okOpen(), 1, "open must be reachable");

        handler.commitAction(0, 0, 3, keccak256("payload"));
        assertEq(handler.okCommit(), 1, "commit must be reachable");

        handler.sealRun(0, 0);
        assertEq(handler.okSeal(), 1, "seal must be reachable");

        bytes32 runId = handler.runIdAt(0);
        (ConvoyRegistry.State state,,,, uint32 committedCount) = _run(runId);
        assertEq(uint8(state), uint8(ConvoyRegistry.State.Sealed));
        assertEq(committedCount, 1);

        // And that every rejection path is reachable too: reopen, wrong operator, double seal.
        handler.openRun(0, 0);
        assertEq(handler.rejectedOpen(), 1, "reopen must be rejected");

        // actorSeed 4 is the one-in-four case that bypasses the operator bias and picks a random
        // actor (_actors[1]), so this commit genuinely comes from a non-operator.
        handler.openRun(1, 0);
        handler.commitAction(1, 4, 0, keccak256("payload"));
        assertEq(handler.rejectedCommit(), 1, "wrong-operator commit must be rejected");

        handler.sealRun(0, 0);
        assertEq(handler.rejectedSeal(), 1, "double seal must be rejected");
    }
}
