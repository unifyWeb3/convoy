// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";
import { MockRewardDistributor } from "../src/MockRewardDistributor.sol";

/// @notice Unit tests for MockRewardDistributor.
/// @dev These assert that unmet preconditions *genuinely* revert. That matters beyond coverage:
///      this contract is the only source of failure in the demo, so if these reverts were not real
///      the Critic's veto would be theatre. Convoy never stages a failure.
contract MockRewardDistributorTest is Test {
    MockRewardDistributor internal distributor;

    bytes32 internal constant ROOT = keccak256("merkle-root");
    bytes32 internal constant OTHER_ROOT = keccak256("other-merkle-root");

    function setUp() public {
        distributor = new MockRewardDistributor();
    }

    // --- initial state -----------------------------------------------------------------------

    function test_initialState_isUnset() public view {
        assertEq(distributor.root(), bytes32(0), "root starts zero");
        assertEq(distributor.funded(), 0, "funded starts zero");
        assertFalse(distributor.marketEnabled(1), "no market starts enabled");
    }

    // --- setRoot -----------------------------------------------------------------------------

    function test_setRoot_setsRoot() public {
        distributor.setRoot(ROOT);
        assertEq(distributor.root(), ROOT, "root must be stored");
    }

    function test_setRoot_revertsZeroRoot() public {
        vm.expectRevert(MockRewardDistributor.ZeroRoot.selector);
        distributor.setRoot(bytes32(0));
    }

    function test_setRoot_revertsRootAlreadySet() public {
        distributor.setRoot(ROOT);
        vm.expectRevert(MockRewardDistributor.RootAlreadySet.selector);
        distributor.setRoot(OTHER_ROOT);
    }

    // --- fund --------------------------------------------------------------------------------

    /// @dev The canonical unmet-precondition revert: `fund` before `setRoot`. This is the exact
    ///      call the Critic simulates and vetoes in the demo.
    function test_fund_revertsRootNotSet() public {
        vm.expectRevert(MockRewardDistributor.RootNotSet.selector);
        distributor.fund(1_000e6);
    }

    function test_fund_addsToFunded() public {
        distributor.setRoot(ROOT);
        distributor.fund(1_000e6);
        assertEq(distributor.funded(), 1_000e6, "funded must accumulate");

        distributor.fund(500e6);
        assertEq(distributor.funded(), 1_500e6, "funding is cumulative");
    }

    function test_fund_revertsZeroAmount() public {
        distributor.setRoot(ROOT);
        vm.expectRevert(MockRewardDistributor.ZeroAmount.selector);
        distributor.fund(0);
    }

    function testFuzz_fund_alwaysRevertsBeforeSetRoot(uint256 amount) public {
        vm.expectRevert(MockRewardDistributor.RootNotSet.selector);
        distributor.fund(amount);
    }

    // --- enableMarket ------------------------------------------------------------------------

    function test_enableMarket_revertsNotFunded() public {
        vm.expectRevert(MockRewardDistributor.NotFunded.selector);
        distributor.enableMarket(1);
    }

    function test_enableMarket_revertsNotFunded_evenAfterSetRoot() public {
        distributor.setRoot(ROOT);
        vm.expectRevert(MockRewardDistributor.NotFunded.selector);
        distributor.enableMarket(1);
    }

    function test_enableMarket_enablesMarket() public {
        distributor.setRoot(ROOT);
        distributor.fund(1_000e6);
        distributor.enableMarket(1);
        assertTrue(distributor.marketEnabled(1), "market 1 must be enabled");
        assertFalse(distributor.marketEnabled(2), "market 2 must be untouched");
    }

    function test_enableMarket_revertsMarketAlreadyEnabled() public {
        distributor.setRoot(ROOT);
        distributor.fund(1_000e6);
        distributor.enableMarket(1);

        vm.expectRevert(MockRewardDistributor.MarketAlreadyEnabled.selector);
        distributor.enableMarket(1);
    }

    // --- precondition chain ------------------------------------------------------------------

    /// @dev The whole point of the contract: the chain setRoot -> fund -> enableMarket is real,
    ///      and every out-of-order call reverts for a real reason.
    function test_preconditionChain_isGenuine() public {
        vm.expectRevert(MockRewardDistributor.RootNotSet.selector);
        distributor.fund(1_000e6);

        vm.expectRevert(MockRewardDistributor.NotFunded.selector);
        distributor.enableMarket(1);

        distributor.setRoot(ROOT);

        vm.expectRevert(MockRewardDistributor.NotFunded.selector);
        distributor.enableMarket(1);

        distributor.fund(1_000e6);
        distributor.enableMarket(1);

        assertEq(distributor.root(), ROOT);
        assertEq(distributor.funded(), 1_000e6);
        assertTrue(distributor.marketEnabled(1));
    }
}
