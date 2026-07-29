// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// MockRewardDistributor — DEMO ONLY.
//
// A clearly-labelled stand-in for a real Merkle-drop distributor. It is the
// honest source of genuine reverts: invalid batch items are pointed at a
// contract that legitimately rejects them (e.g. fund before setRoot). Convoy
// does not stage failures.
//
// Scaffold only. Implemented in CVY-001: setRoot(bytes32), fund(uint256),
// enableMarket(uint256), each reverting on unmet preconditions.
