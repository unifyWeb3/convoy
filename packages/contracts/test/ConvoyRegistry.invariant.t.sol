// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// StdInvariant handler-based invariants. Implemented in CVY-001:
// invariant_noCommitBeforeOpen, invariant_noDoubleSeal,
// invariant_idxMonotonic, invariant_committedCountMatches.
// Configured at runs=1000 depth=32 in foundry.toml.
