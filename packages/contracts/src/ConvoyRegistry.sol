// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// ConvoyRegistry — commitment and sequencing ledger for a Convoy run.
//
// Scaffold only. Implemented in CVY-001 exactly as frozen in
// docs/ARCHITECTURE.md §8: enum State{None,Open,Sealed}; packed Run struct;
// runs / payloadHash / committed mappings; RunOpened / ActionCommitted /
// RunSealed events; six custom errors; openRun, commitAction, sealRun,
// isCommitted. No additions.
