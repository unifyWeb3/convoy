// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

/// @title DumpPayloadHashFixtures — generates the Sol↔TS payloadHash parity fixtures
/// @notice Writes `tests/fixtures/payloadHash.fixtures.json` from **real Solidity output**.
/// @dev The fixtures are dumped, never hand-written. A hand-written fixture would only prove that
///      TypeScript agrees with whatever the author believed Solidity does; a dumped one proves it
///      agrees with what Solidity actually did. `commitAction` correctness — the onchain proof that
///      item `idx` was committed with exactly this payload — rests on that agreement.
///
///      Pinned encoding (blueprint A4, do not vary):
///        keccak256(abi.encode(address target, string fn, bytes args, uint256 idx))
///      where `args` is the ABI-encoded argument *tuple* — NOT the 4-byte-selector calldata.
///
///      Run: forge script script/DumpPayloadHashFixtures.s.sol
///      Write access is scoped to ../../tests/fixtures by `fs_permissions` in foundry.toml.
contract DumpPayloadHashFixtures is Script {
    string internal constant OUT = "../../tests/fixtures/payloadHash.fixtures.json";
    string internal constant ENCODING =
        "keccak256(abi.encode(address target, string fn, bytes args, uint256 idx))";

    uint256 internal constant FIXTURE_COUNT = 13;

    // Deliberately varied, including the zero address and a max-nibble address, so a fixture set
    // cannot pass by coincidence of a shared prefix.
    address internal constant REGISTRY = 0x5FbDB2315678afecb367f032d93F642f64180aa3;
    address internal constant DISTRIBUTOR = 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512;
    address internal constant ZERO_ADDR = address(0);
    address internal constant MAX_ADDR = 0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF;
    address internal constant USDC_BASE = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    function run() external {
        string[] memory f = new string[](FIXTURE_COUNT);
        uint256 n;

        // 1 — empty args. viem's encodeAbiParameters([], []) returns "0x"; Solidity's abi.encode()
        //     returns zero-length bytes. These must hash identically or every no-arg call diverges.
        f[n++] = _fixture("emptyArgs", REGISTRY, "poke", _t0(), _v0(), abi.encode(), 0);

        // 2 — empty function name. `string` is dynamic; the empty case exercises its length header.
        f[n++] = _fixture(
            "emptyFunctionName",
            DISTRIBUTOR,
            "",
            _t1("uint256"),
            _v1(vm.toString(uint256(1))),
            abi.encode(uint256(1)),
            1
        );

        // 3 — single address, zero-valued target.
        f[n++] = _fixture(
            "singleAddress",
            ZERO_ADDR,
            "setOperator",
            _t1("address"),
            _v1(vm.toString(USDC_BASE)),
            abi.encode(USDC_BASE),
            2
        );

        // 4 — uint256 at its maximum, against the max-nibble address.
        f[n++] = _fixture(
            "singleUint256Max",
            MAX_ADDR,
            "fund",
            _t1("uint256"),
            _v1(vm.toString(type(uint256).max)),
            abi.encode(type(uint256).max),
            3
        );

        // 5 — bytes32, the shape ConvoyRegistry actually commits.
        bytes32 root = keccak256("convoy-merkle-root");
        f[n++] = _fixture(
            "singleBytes32",
            DISTRIBUTOR,
            "setRoot",
            _t1("bytes32"),
            _v1(vm.toString(root)),
            abi.encode(root),
            4
        );

        // 6 — the real commitAction shape: a multi-arg tuple mixing static types.
        bytes32 runId = keccak256("convoy-run-1");
        bytes32 payload = keccak256("payload-a");
        f[n++] = _fixture(
            "commitActionTriple",
            REGISTRY,
            "commitAction",
            _t3("bytes32", "uint256", "bytes32"),
            _v3(vm.toString(runId), vm.toString(uint256(7)), vm.toString(payload)),
            abi.encode(runId, uint256(7), payload),
            5
        );

        // 7 — address[]: a dynamic array of a static type, offset-encoded.
        address[] memory addrs = new address[](3);
        addrs[0] = REGISTRY;
        addrs[1] = ZERO_ADDR;
        addrs[2] = USDC_BASE;
        f[n++] = _fixture(
            "addressArray",
            DISTRIBUTOR,
            "enableMarkets",
            _t1("address[]"),
            _v1(_addrArrayJson(addrs)),
            abi.encode(addrs),
            6
        );

        // 8 — uint256[], including a zero element.
        uint256[] memory nums = new uint256[](4);
        nums[0] = 0;
        nums[1] = 1;
        nums[2] = 1_000_000e6;
        nums[3] = type(uint256).max;
        f[n++] = _fixture(
            "uint256Array",
            DISTRIBUTOR,
            "batchFund",
            _t1("uint256[]"),
            _v1(_uintArrayJson(nums)),
            abi.encode(nums),
            7
        );

        // 9 — a long function name: `string` length crossing a 32-byte word boundary is exactly
        //     where a naive encoder pads differently.
        string memory longFn =
            "commitActionWithAVeryLongDescriptiveNameThatCrossesSeveralThirtyTwoByteWordBoundariesOnPurposeForParity";
        f[n++] = _fixture(
            "longFunctionName",
            REGISTRY,
            longFn,
            _t1("uint256"),
            _v1(vm.toString(uint256(42))),
            abi.encode(uint256(42)),
            8
        );

        // 10 — a dynamic string argument carrying multi-byte UTF-8. `string` is length-prefixed in
        //      *bytes*, not characters, so a non-ASCII codepoint is where a JS-side encoder that
        //      counts UTF-16 units would diverge from Solidity.
        string memory label = unicode"Maya's Q3 distribution — cohort A";
        f[n++] = _fixture(
            "dynamicStringArg",
            REGISTRY,
            "setLabel",
            _t1("string"),
            _v1(label),
            abi.encode(label),
            9
        );

        // 11 — a dynamic bytes argument of non-word-multiple length (33 bytes forces padding).
        bytes memory blob = hex"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff01";
        f[n++] = _fixture(
            "dynamicBytesArg",
            REGISTRY,
            "submit",
            _t1("bytes"),
            _v1(vm.toString(blob)),
            abi.encode(blob),
            10
        );

        // 12 — bool plus a negative int256: two's-complement sign extension.
        f[n++] = _fixture(
            "boolAndNegativeInt",
            DISTRIBUTOR,
            "toggle",
            _t2("bool", "int256"),
            _v2("true", vm.toString(int256(-12_345))),
            abi.encode(true, int256(-12_345)),
            11
        );

        // 13 — idx at uint256 max: the index is part of the commitment, so its extremes matter.
        f[n++] = _fixture(
            "maxIdx",
            REGISTRY,
            "openRun",
            _t1("bytes32"),
            _v1(vm.toString(runId)),
            abi.encode(runId),
            type(uint256).max
        );

        require(n == FIXTURE_COUNT, "FIXTURE_COUNT out of sync");

        vm.writeFile(OUT, _document(f));
        console2.log("wrote %s fixtures to %s", n, OUT);
    }

    // --- hashing -------------------------------------------------------------------------------

    /// @dev The pinned encoding. Kept as its own function so there is exactly one place in Solidity
    ///      where the commitment is defined, and the TypeScript side mirrors this and nothing else.
    function _payloadHash(address target, string memory fn, bytes memory args, uint256 idx)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(target, fn, args, idx));
    }

    // --- serialisation -------------------------------------------------------------------------

    function _fixture(
        string memory name,
        address target,
        string memory fn,
        string[] memory argTypes,
        string[] memory argValues,
        bytes memory args,
        uint256 idx
    ) internal returns (string memory) {
        require(argTypes.length == argValues.length, "argTypes/argValues length mismatch");

        string memory obj = string.concat("fixture:", name);
        vm.serializeString(obj, "name", name);
        vm.serializeAddress(obj, "target", target);
        vm.serializeString(obj, "functionName", fn);
        vm.serializeString(obj, "argTypes", argTypes);
        vm.serializeString(obj, "argValues", argValues);
        vm.serializeBytes(obj, "args", args);
        vm.serializeString(obj, "idx", vm.toString(idx));
        return vm.serializeBytes32(obj, "payloadHash", _payloadHash(target, fn, args, idx));
    }

    function _document(string[] memory fixtures) internal pure returns (string memory) {
        string memory arr = "[";
        for (uint256 i = 0; i < fixtures.length; i++) {
            arr = string.concat(arr, fixtures[i]);
            if (i + 1 < fixtures.length) arr = string.concat(arr, ",");
        }
        arr = string.concat(arr, "]");

        return string.concat(
            '{"encoding":"',
            ENCODING,
            '","generatedBy":"packages/contracts/script/DumpPayloadHashFixtures.s.sol",',
            '"note":"Dumped from real Solidity output. Do not hand-edit; re-run the script.",',
            '"fixtures":',
            arr,
            "}"
        );
    }

    // --- small builders ------------------------------------------------------------------------

    function _t0() internal pure returns (string[] memory a) {
        a = new string[](0);
    }

    function _v0() internal pure returns (string[] memory a) {
        a = new string[](0);
    }

    function _t1(string memory a0) internal pure returns (string[] memory a) {
        a = new string[](1);
        a[0] = a0;
    }

    function _v1(string memory a0) internal pure returns (string[] memory a) {
        a = new string[](1);
        a[0] = a0;
    }

    function _t2(string memory a0, string memory a1) internal pure returns (string[] memory a) {
        a = new string[](2);
        a[0] = a0;
        a[1] = a1;
    }

    function _v2(string memory a0, string memory a1) internal pure returns (string[] memory a) {
        a = new string[](2);
        a[0] = a0;
        a[1] = a1;
    }

    function _t3(string memory a0, string memory a1, string memory a2)
        internal
        pure
        returns (string[] memory a)
    {
        a = new string[](3);
        a[0] = a0;
        a[1] = a1;
        a[2] = a2;
    }

    function _v3(string memory a0, string memory a1, string memory a2)
        internal
        pure
        returns (string[] memory a)
    {
        a = new string[](3);
        a[0] = a0;
        a[1] = a1;
        a[2] = a2;
    }

    function _addrArrayJson(address[] memory xs) internal pure returns (string memory s) {
        s = "[";
        for (uint256 i = 0; i < xs.length; i++) {
            s = string.concat(s, '"', vm.toString(xs[i]), '"');
            if (i + 1 < xs.length) s = string.concat(s, ",");
        }
        s = string.concat(s, "]");
    }

    function _uintArrayJson(uint256[] memory xs) internal pure returns (string memory s) {
        s = "[";
        for (uint256 i = 0; i < xs.length; i++) {
            s = string.concat(s, '"', vm.toString(xs[i]), '"');
            if (i + 1 < xs.length) s = string.concat(s, ",");
        }
        s = string.concat(s, "]");
    }
}
