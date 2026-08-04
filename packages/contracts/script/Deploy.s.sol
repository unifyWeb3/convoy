// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { ConvoyRegistry } from "../src/ConvoyRegistry.sol";
import { MockRewardDistributor } from "../src/MockRewardDistributor.sol";

/// @title Deploy — ConvoyRegistry + MockRewardDistributor
/// @notice Deploys both contracts on Base Sepolia (84532) or Base mainnet (8453).
/// @dev `DEPLOYER_PRIVATE_KEY` is read **only** here, by `forge script`. Convoy's runtime holds no
///      private key, and a CI grep-guard fails the build if `PRIVATE_KEY` appears anywhere outside
///      `packages/contracts/script`.
///
///      Written at CVY-002, **run** at CVY-003. Two guards make an accidental deploy hard: the
///      chain id must be one of the two supported networks (a stray run against anvil or any other
///      chain reverts), and `vm.envUint` reverts when the key is absent. Without `--broadcast`,
///      `forge script` only simulates — nothing is sent.
///
///      Commands, flag separators and troubleshooting live in
///      `docs/RUNBOOK_FIRST_TRANSACTION.md`, the single operational authority for this sequence.
///      They are not repeated here: `--rpc-url` and `--chain` take opposite separators, and every
///      copy of the command that was written from memory got one of them wrong.
contract Deploy is Script {
    uint256 internal constant BASE_MAINNET = 8453;
    uint256 internal constant BASE_SEPOLIA = 84_532;

    error UnsupportedChain(uint256 chainId);

    function run() external returns (ConvoyRegistry registry, MockRewardDistributor distributor) {
        uint256 chainId = block.chainid;
        if (chainId != BASE_MAINNET && chainId != BASE_SEPOLIA) revert UnsupportedChain(chainId);

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        registry = new ConvoyRegistry();
        distributor = new MockRewardDistributor();
        vm.stopBroadcast();

        console2.log("network:              %s", _networkName(chainId));
        console2.log("chainId:              %s", chainId);
        console2.log("deployer:             %s", vm.addr(deployerKey));
        console2.log("ConvoyRegistry:        %s", address(registry));
        console2.log("MockRewardDistributor: %s", address(distributor));
        console2.log("");
        console2.log("Record these in .env (CONVOY_REGISTRY_ADDR, MOCK_DISTRIBUTOR_ADDR),");
        console2.log("docs/DEPLOYMENT.md, and the README artifact table.");
    }

    function _networkName(uint256 chainId) internal pure returns (string memory) {
        if (chainId == BASE_MAINNET) return "Base mainnet";
        return "Base Sepolia";
    }
}
