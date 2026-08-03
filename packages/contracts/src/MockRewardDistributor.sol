// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title MockRewardDistributor — DEMO ONLY
/// @notice A clearly-labelled stand-in for a real Merkle-drop reward distributor.
/// @dev Frozen in docs/ARCHITECTURE.md §8. This contract exists for exactly one reason: it is the
///      honest source of *genuine* reverts. Convoy never stages a failure — it points an invalid
///      batch item at a contract that legitimately rejects it. The precondition chain is
///      `setRoot` -> `fund` -> `enableMarket`; calling out of order reverts with a custom error,
///      which is what KeeperHub's `simulate:true` decodes into `revertReason` for the Critic.
///      Not a production distributor: no Merkle proofs, no token transfers, no access control.
contract MockRewardDistributor {
    /// @notice The Merkle root of the reward set. Zero until `setRoot` is called.
    bytes32 public root;

    /// @notice Total amount funded against the current root.
    uint256 public funded;

    /// @notice Markets enabled for claiming. marketId => enabled.
    mapping(uint256 => bool) public marketEnabled;

    error RootNotSet();
    error RootAlreadySet();
    error ZeroRoot();
    error ZeroAmount();
    error NotFunded();
    error MarketAlreadyEnabled();

    /// @notice Sets the reward Merkle root. Must be the first call, and may only be made once.
    function setRoot(bytes32 newRoot) external {
        if (newRoot == bytes32(0)) revert ZeroRoot();
        if (root != bytes32(0)) revert RootAlreadySet();
        root = newRoot;
    }

    /// @notice Funds the distribution. Reverts if called before `setRoot` — the canonical
    ///         unmet-precondition revert the Critic simulates against.
    function fund(uint256 amount) external {
        if (root == bytes32(0)) revert RootNotSet();
        if (amount == 0) revert ZeroAmount();
        funded += amount;
    }

    /// @notice Opens a market for claiming. Reverts unless the distribution has been funded.
    function enableMarket(uint256 marketId) external {
        if (funded == 0) revert NotFunded();
        if (marketEnabled[marketId]) revert MarketAlreadyEnabled();
        marketEnabled[marketId] = true;
    }
}
