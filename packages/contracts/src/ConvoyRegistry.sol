// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ConvoyRegistry
/// @notice Commitment and sequencing ledger for a Convoy run.
/// @dev Frozen in docs/ARCHITECTURE.md §8. The registry is NOT an event log: its storage
///      (`runs[runId].state`, `runs[runId].committedCount`, `payloadHash[runId][idx]`) is a live
///      precondition read at runtime by Convoy's dependency gates and by the manifest reconciler.
///      Access control is operator-bound — `msg.sender` must equal the opener (the KeeperHub org
///      wallet). Reverts use custom errors only: a revert is a product feature, because it is what
///      KeeperHub's `simulate:true` decodes into `revertReason` for the Critic.
contract ConvoyRegistry {
    enum State {
        None,
        Open,
        Sealed
    }

    struct Run {
        State state;
        address operator; // opener = KeeperHub org wallet
        uint64 openedAt;
        uint64 sealedAt;
        uint32 committedCount; // monotonic; enforces sequencing
    }

    mapping(bytes32 => Run) public runs;
    mapping(bytes32 => mapping(uint256 => bytes32)) public payloadHash; // runId=>idx=>hash
    mapping(bytes32 => mapping(uint256 => bool)) public committed; // runId=>idx=>done

    event RunOpened(bytes32 indexed runId, address indexed operator, uint64 at);
    event ActionCommitted(
        bytes32 indexed runId, uint256 indexed idx, bytes32 payloadHash, uint32 seq, uint64 at
    );
    event RunSealed(bytes32 indexed runId, uint32 committedCount, uint64 at);

    error NotOpen();
    error AlreadyOpen();
    error AlreadySealed();
    error NotOperator();
    error DupIndex();
    error NothingCommitted();

    function openRun(bytes32 runId) external {
        Run storage r = runs[runId];
        if (r.state != State.None) revert AlreadyOpen();
        r.state = State.Open;
        r.operator = msg.sender;
        r.openedAt = uint64(block.timestamp);
        emit RunOpened(runId, msg.sender, r.openedAt);
    }

    function commitAction(bytes32 runId, uint256 idx, bytes32 hash) external {
        Run storage r = runs[runId];
        if (r.state != State.Open) revert NotOpen();
        if (msg.sender != r.operator) revert NotOperator();
        if (committed[runId][idx]) revert DupIndex();
        committed[runId][idx] = true;
        payloadHash[runId][idx] = hash;
        unchecked {
            r.committedCount += 1;
        }
        emit ActionCommitted(runId, idx, hash, r.committedCount, uint64(block.timestamp));
    }

    function sealRun(bytes32 runId) external {
        Run storage r = runs[runId];
        if (r.state != State.Open) revert NotOpen();
        if (msg.sender != r.operator) revert NotOperator();
        if (r.committedCount == 0) revert NothingCommitted();
        r.state = State.Sealed;
        r.sealedAt = uint64(block.timestamp);
        emit RunSealed(runId, r.committedCount, r.sealedAt);
    }

    function isCommitted(bytes32 runId, uint256 idx) external view returns (bool) {
        return committed[runId][idx];
    }
}
