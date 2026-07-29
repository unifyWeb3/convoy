// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Deploy script for ConvoyRegistry + MockRewardDistributor on Base (8453) and
// Base Sepolia (84532). Implemented in CVY-002.
//
// DEPLOYER_PRIVATE_KEY is read ONLY here, by forge script. Convoy's runtime
// holds no private key; a CI grep-guard enforces that PRIVATE_KEY appears
// nowhere outside packages/contracts/script.
