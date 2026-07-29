# Role — Principal Blockchain Engineer

Owns everything Convoy reads from the chain, the Solidity↔TypeScript byte parity of the payload
commitment, and gas accounting.

## Responsibilities

- Implement the `payloadHash` helper identically on both sides and prove it with a parity test over
  at least 10 fixtures dumped by a forge script.

  **Pinned encoding (byte-for-byte):**

  ```
  Solidity:  keccak256(abi.encode(address target, string fn, bytes args, uint256 idx))

  TypeScript (viem):
    keccak256(encodeAbiParameters(
      [{type:'address'},{type:'string'},{type:'bytes'},{type:'uint256'}],
      [target, functionName, encodedArgs, BigInt(idx)]
    ))

  where encodedArgs = the ABI-encoded argument tuple bytes (encodeAbiParameters over the
  function's input types), NOT the 4-byte-selector calldata.
  ```

  **Documented fallback** if dynamic-type packing drifts — hash the pieces on both sides:
  `keccak256(abi.encode(target, keccak256(bytes(fn)), keccak256(args), idx))`. Record the switch in
  `docs/DECISIONS.md`.

- Own all viem reads: the chain is pinned to Base **8453** through a dedicated RPC. Registry state
  and `ActionCommitted` / `RunOpened` / `RunSealed` events are read for the manifest's onchain leg.
- Own gas accounting. **Pinned formula:**
  `gas_used_usdc = (Number(gasUsedWei) / 1e18) * runEthUsd`, where `runEthUsd` is frozen into the
  `runs` row at open from `CONVOY_ETH_USD`. This is deliberately not a live oracle (KNOWN_GAPS
  G-04); the manifest discloses the rate used so the accounting is reproducible.

## Files owned

```
packages/kh-client/src/payloadHash.ts
packages/kh-client/test/payloadHash.parity.test.ts
apps/web/lib/registry.ts
apps/web/lib/budget.ts
```

## Invariants preserved

- **Never** run `eth_getLogs` against a public RPC. Reads go through `BASE_RPC_URL`, with
  `BASE_RPC_URL_FALLBACK` as the hot-swappable demo backup.
- The chain id is pinned and asserted: `eth_chainId` must equal `0x2105` (8453).
- Money is `numeric(20,6)` in the database. Wei is `bigint`/`string` — **never** a float.
- Convoy reads the chain; Convoy never writes to it directly. Every write is a KeeperHub call.
- `gasEstimate` (from simulate) and `gasUsedWei` (from status) are the only gas numbers that may
  appear anywhere. No estimates are invented.

## Definition of done

- `payloadHash.parity.test.ts` green: TypeScript output equals Solidity output on every fixture.
- Registry reads resolve against the deployed address on the pinned RPC.
- The budget meter drains from real `gasUsedWei` values traceable to transaction hashes.

## Milestones

CVY-002 (parity), CVY-007 (budget + gas accounting), CVY-012 (manifest onchain leg),
CVY-013 (registry-read dependency gate).
