# Runbook — deploy and first transaction (CVY-003)

**This file is the single operational authority for deploying `ConvoyRegistry` and
`MockRewardDistributor` to Base Sepolia and landing the first real transaction through KeeperHub.**

`docs/DEPLOYMENT.md`, `.convoy/playbooks/release.md` and `.convoy/tasks/CVY-003.md` delegate here and
must not carry their own copies of these commands. Gap **G-19** exists because two documents
disagreed about a deploy target; if you find yourself editing a deploy command somewhere else,
that is the bug.

Chain: **Base Sepolia 84532** (decision DEC-001). Base mainnet 8453 is an optional CVY-019 flip and
is out of scope here.

---

# PART 1 — PRE-FLIGHT

## 1.1 The flag trap — read this first

`--rpc-url` and `--chain` take **opposite separators**. Measured 2026-08-04:

| Flag        | Correct                         | Rejected                                           |
| ----------- | ------------------------------- | -------------------------------------------------- |
| `--rpc-url` | `base_sepolia` (**underscore**) | `base-sepolia` → resolved as a _file path_, ENOENT |
| `--chain`   | `base-sepolia` (**hyphen**)     | `base_sepolia` → `invalid digit found in string`   |

`--rpc-url` names a key in `packages/contracts/foundry.toml` `[rpc_endpoints]`, which uses an
underscore. `--chain` names a value in Foundry's built-in chain enum, which uses a hyphen. `--chain
84532` also works and is unambiguous.

Every previously-written copy of this command in the repository had one of the two wrong. That is
why they now delegate here instead.

## 1.2 Prerequisites

### Funded addresses

Two **different** addresses need Base Sepolia ETH, and confusing them is the most likely pre-flight
failure:

| Address                                      | Role                                                 | Funds what                        |
| -------------------------------------------- | ---------------------------------------------------- | --------------------------------- |
| Derived from `DEPLOYER_PRIVATE_KEY`          | Foundry deploy only; never enters app/worker runtime | the two contract deployments      |
| `0x65f5afd3b4d5f7d58c408300569a11f0ec190da6` | KeeperHub **org Turnkey wallet**                     | every transaction Convoy executes |

Convoy never signs with the deployer key at runtime. The org wallet is the sender of record for
`openRun` and every subsequent write.

```bash
cd /home/unify/convoy
export $(grep -E '^(BASE_SEPOLIA_RPC_URL|DEPLOYER_PRIVATE_KEY)=' .env | xargs -d '\n')

# Deployer address (derived, never hardcode it):
cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY"

# Deployer balance, in wei:
cast balance "$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"

# Org Turnkey wallet balance, in wei:
cast balance 0x65f5afd3b4d5f7d58c408300569a11f0ec190da6 --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

**Minimum thresholds.** Deploying both contracts plus a handful of writes is cheap on Sepolia, but
do not start below:

| Address    | Minimum      | Why                                                            |
| ---------- | ------------ | -------------------------------------------------------------- |
| Deployer   | **0.02 ETH** | two contract deployments plus verification retries             |
| Org wallet | **0.02 ETH** | the first transaction plus the 12-item demo batch with retries |

Top up from a Base Sepolia faucet. Testnet ETH has no market value — see gap **G-18**, which is why
the budget meter reports real gas units and notional USD.

> KeeperHub reported `"sponsored": true` on the CVY-004 smoke transaction, so the org wallet may not
> be charged at all. **Do not rely on that.** Sponsorship is never load-bearing (gap G-08); fund the
> wallet as if it were not sponsored.

### Chain reachability — check **all three** RPC variables

Not just the deploy endpoint. `BASE_RPC_URL` and `BASE_RPC_URL_FALLBACK` are what the app, the
worker and the manifest's onchain leg read from, and they are easy to leave pointed at mainnet:

```bash
for v in BASE_RPC_URL BASE_RPC_URL_FALLBACK BASE_SEPOLIA_RPC_URL; do
  U=$(grep "^$v=" .env | cut -d= -f2-)
  echo "$v -> $(cast chain-id --rpc-url "$U")"
done
```

**All three must print `84532`.** Anything else and you are pointed at the wrong network. Stop.

This is not hypothetical: at CVY-003 both read endpoints were found on **8453**, caught by
`verify-env.ts`'s chain pin. A mainnet `BASE_RPC_URL` makes registry reads return nothing (the
contracts are on Sepolia), and a mainnet `BASE_RPC_URL_FALLBACK` means demo backup path b hot-swaps
onto the wrong chain mid-demo.

> `BASE_RPC_URL_FALLBACK` should ideally be a **different provider** on 84532 — its purpose is
> provider redundancy. Pointing it at the same URL as `BASE_RPC_URL` satisfies the chain check but
> leaves the redundancy nominal. Operator decision; recorded here so it is not mistaken for done.

## 1.3 Environment variables

```bash
pnpm tsx scripts/verify-env.ts --skip-web-build
```

The `RPC pinned 84532` row must be **PASS**. Rows marked "expected until CVY-005" are fine.

| Variable                | Confirm it is right by                                               |
| ----------------------- | -------------------------------------------------------------------- |
| `BASE_SEPOLIA_RPC_URL`  | `cast chain-id --rpc-url "$BASE_SEPOLIA_RPC_URL"` prints `84532`     |
| `BASE_RPC_URL`          | `verify-env.ts` row `RPC pinned 84532` is PASS                       |
| `DEPLOYER_PRIVATE_KEY`  | `cast wallet address --private-key …` returns the address you funded |
| `ETHERSCAN_API_KEY`     | an Etherscan **V2** key; V1 per-chain keys were retired 2025-08-15   |
| `KEEPERHUB_API_KEY`     | the org `kh_` key; §1.4 proves it end to end                         |
| `CONVOY_REGISTRY_ADDR`  | still the zero address **before** deploying; filled in at §2.4       |
| `MOCK_DISTRIBUTOR_ADDR` | still the zero address **before** deploying; filled in at §2.4       |

`DEPLOYER_PRIVATE_KEY` is read **only** by `forge script` under `packages/contracts/script`. A CI
grep-guard fails the build if `PRIVATE_KEY` appears anywhere else.

## 1.4 Confirm the KeeperHub path before deploying

Prove the wallet is provisioned for 84532 _before_ spending gas. A simulate signs nothing,
broadcasts nothing, and creates no audit row:

```bash
pnpm tsx scripts/first-tx.ts --preflight
```

Expect `wouldRevert: false` and a `gasEstimate`. A **422** here means the org Turnkey wallet is not
configured for this chain — fatal to the run, and no amount of deploying will fix it.

## 1.5 Dry run — no `--broadcast`, nothing is sent

```bash
cd packages/contracts
forge script script/Deploy.s.sol --rpc-url base_sepolia
```

This exercises the chain-allowlist guard (`block.chainid` must be 8453 or 84532) and proves the key
is readable. Addresses printed here are **predictions from the simulated nonce**, not deployments.
Do not record them.

## 1.6 Deploy

Order does not matter — `Deploy.s.sol` deploys `ConvoyRegistry` then `MockRewardDistributor` in one
broadcast, so both land or neither does.

```bash
cd packages/contracts
forge script script/Deploy.s.sol \
  --rpc-url base_sepolia \
  --broadcast \
  --verify \
  --chain base-sepolia
```

Note the separators — `--rpc-url base_sepolia`, `--chain base-sepolia`. See §1.1.

Verification uses the single Etherscan **V2** key and covers Basescan for both Base chains.

If `--verify` fails but the deploy succeeded, the contracts are deployed; verify separately rather
than redeploying:

```bash
forge verify-contract <ADDRESS> src/ConvoyRegistry.sol:ConvoyRegistry --chain base-sepolia --watch
```

## 1.7 First transaction

```bash
cd /home/unify/convoy
pnpm tsx scripts/first-tx.ts
```

Lands `openRun` through the org Turnkey wallet via `@convoy/kh-client` and prints the executionId,
transaction hash and Basescan link.

**The hash does not arrive on the write response.** A synchronous write returns
`202 {status:"completed"}` with no `transactionHash`; it is only on `GET /status` (gap **G-23**).
`pollUntilTerminal` handles this — but if you are debugging by hand, that is why the POST looks
incomplete.

## 1.8 Rollback

**Contracts are immutable. There is no rollback — only replacement.**

1. Deploy a fresh instance (§1.6).
2. Update `CONVOY_REGISTRY_ADDR` and `MOCK_DISTRIBUTOR_ADDR` in `.env`, in the Vercel dashboard, and
   in the README artifact table.
3. Update Part 2 of this runbook with the new addresses.

**Never migrate state, and never edit a recorded address in place.** A superseded deployment stays in
the record with a note; the manifest's onchain leg reconciles against whatever address the run
actually used, so rewriting history desynchronises it.

## 1.9 Troubleshooting

Seeded from what CVY-004 measured against the live API. Each row is an observation, not a guess.

| Symptom                                                              | Cause                                                                                                                      | Do this                                                                                                       |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `Internal transport error: No such file or directory … base-sepolia` | `--rpc-url base-sepolia` with a hyphen; Foundry read it as a file path                                                     | Use `--rpc-url base_sepolia` (§1.1)                                                                           |
| `invalid value 'base_sepolia' for '--chain'`                         | `--chain` takes a hyphen or the numeric id                                                                                 | Use `--chain base-sepolia` or `--chain 84532`                                                                 |
| `UnsupportedChain(31337)`                                            | No `--rpc-url`, so Foundry used its local default                                                                          | Add `--rpc-url base_sepolia`. The guard worked                                                                |
| `environment variable BASE_MAINNET_RPC_URL not found`                | You passed `--rpc-url base` — the **mainnet** endpoint, unset by design                                                    | Use `base_sepolia`. This guard is deliberate (DEC-001)                                                        |
| `HTTP 400`, body has `success:false` **and** `wouldRevert:true`      | **Not an error.** A would-revert verdict is delivered on 400 (gap **G-21**). The verdict is `wouldRevert`, never `success` | Read `wouldRevert`. The client already treats 400 as an expected simulate status                              |
| `HTTP 400` with **no** `wouldRevert` field                           | A genuine validation error wearing the same status code                                                                    | Fix the request. The client throws here rather than reporting "would not revert"                              |
| `HTTP 500` with an **empty body**                                    | Unsupported chain id (gap **G-22**) — not a server fault                                                                   | Check `chainId`. `KhClient` rejects unsupported chains at construction, so this means you bypassed the client |
| `HTTP 401`                                                           | `KEEPERHUB_API_KEY` rejected                                                                                               | Fatal. Retrying cannot help; replace the key                                                                  |
| `HTTP 403`                                                           | Daily spending cap (gap G-03)                                                                                              | Fatal to the run. Wait for the UTC-day reset                                                                  |
| `HTTP 422`                                                           | Org Turnkey wallet not configured for 84532                                                                                | Fatal to the run. Provision the wallet; do not retry                                                          |
| Write says `completed` but there is no hash                          | Expected (gap **G-23**) — the hash is only on `GET /status`                                                                | Poll the status endpoint. Never report LANDED without a hash                                                  |
| `revertReason` is an ethers diagnostic blob                          | Gap **G-20** — under investigation at this milestone                                                                       | See §2.6                                                                                                      |

---

# PART 2 — POST-FLIGHT

> **Filled from real deployment output on 2026-08-04.** Every value below was produced by an actual
> run and is independently verifiable on Basescan. Nothing here is pre-written.

## 2.1 Deployment

| Field            | Value                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Date (UTC)       | 2026-08-04                                                                                                                      |
| Chain            | Base Sepolia 84532                                                                                                              |
| Deployer address | [`0x5FE738227ab4219bc317812a938dEf57489d444a`](https://sepolia.basescan.org/address/0x5FE738227ab4219bc317812a938dEf57489d444a) |
| Block            | 45020238 (both contracts, one broadcast)                                                                                        |
| Total gas used   | 564,150 (registry 385,721 + distributor 178,429)                                                                                |

## 2.2 Contract addresses

| Contract                | Address                                      | Basescan                                                                                     | Verified |
| ----------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- | -------- |
| `ConvoyRegistry`        | `0xec51F84BD04dB4515Aa654a4a4f57Ce7596850dA` | [view](https://sepolia.basescan.org/address/0xec51F84BD04dB4515Aa654a4a4f57Ce7596850dA#code) | ✅ yes   |
| `MockRewardDistributor` | `0xD45c61797d7283caf8A31D91A5Bd6465A45AD561` | [view](https://sepolia.basescan.org/address/0xD45c61797d7283caf8A31D91A5Bd6465A45AD561#code) | ✅ yes   |

Deploy transactions:

- `ConvoyRegistry` — [`0x3fea883e…c803ff`](https://sepolia.basescan.org/tx/0x3fea883e9117064dc2e4ba16feb4281ba69e9339793f8e424a63d80172c803ff)
- `MockRewardDistributor` — [`0x9e73f327…d3d028`](https://sepolia.basescan.org/tx/0x9e73f327b9ba3f4177b28c2d910e8d512f2146e6e30effd305a4c3acefd3d028)

## 2.3 First transaction (`openRun`)

**The hackathon's hard submission requirement — a transaction the agent executed via KeeperHub.**

| Field               | Value                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KeeperHub execId    | `9qcx2ggv8xcblnl1y3jl5`                                                                                                                                                    |
| Transaction hash    | [`0x1ffb4aaf9525fd68b5d8eabe96d1e99058bbc40f9b0d7f7db102aa0d81b2bbcd`](https://sepolia.basescan.org/tx/0x1ffb4aaf9525fd68b5d8eabe96d1e99058bbc40f9b0d7f7db102aa0d81b2bbcd) |
| Basescan link       | https://sepolia.basescan.org/tx/0x1ffb4aaf9525fd68b5d8eabe96d1e99058bbc40f9b0d7f7db102aa0d81b2bbcd                                                                         |
| `gasUsedWei`        | 68,400                                                                                                                                                                     |
| `retryCount`        | 0                                                                                                                                                                          |
| Sender (org wallet) | `0x65F5AFd3b4d5F7d58C408300569a11f0EC190Da6`                                                                                                                               |
| `sponsored`         | `true`                                                                                                                                                                     |
| runId               | `0x3f1c170a3492e2b492cb6fd48a2546888aae10d41ce8f6d1ef016486a2198f5b`                                                                                                       |

**Independently verified on chain**, not merely reported by KeeperHub:

| Check               | Result                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Receipt status      | `0x1` (success), block 45020292                                                                                                             |
| Log count           | 1                                                                                                                                           |
| `topic0`            | `0x1b81a360f8bdf593af355a9cedac140fe493e4786630eccc041396aa8b4f4873` — matches `cast sig-event "RunOpened(bytes32,address,uint64)"` exactly |
| Indexed `runId`     | matches the runId sent                                                                                                                      |
| Indexed `operator`  | `0x65f5…90da6` — the org Turnkey wallet                                                                                                     |
| `runs(runId)` state | `state=1 (Open)`, `operator=0x65F5…0Da6`, `openedAt=1785808872`, `sealedAt=0`, `committedCount=0`                                           |

> **Note for CVY-012.** The receipt's `to` is `0x5af5194b4b0909eb978e3cf1e25333852277f07d`, **not** the
> registry, and `from` is `0x6331eb45…091e99`, **not** the org wallet — the transaction is routed
> through KeeperHub's sponsoring relay. The org wallet is the effective sender, provable from the
> `RunOpened` `operator` topic and from registry storage. **Reconciling the manifest's onchain leg by
> `to == CONVOY_REGISTRY_ADDR` would produce a false mismatch.** Match on the emitting contract of the
> log instead. Recorded as gap **G-24**.

## 2.4 Environment updates applied

- [x] `.env` — `CONVOY_REGISTRY_ADDR`
- [x] `.env` — `MOCK_DISTRIBUTOR_ADDR`
- [x] README artifact table
- [x] README honesty table (real Basescan link)

## 2.5 D-019 — the named revert case

**Closed.** CVY-004 proved the veto path against WETH9 because `MockRewardDistributor` did not exist;
that substitution does not carry forward. The case the architecture names has now run against the
deployed contract.

| Field               | Value                                                                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request payload     | `{chainId:"84532", network:"84532", contractAddress:"0xD45c61797d7283caf8A31D91A5Bd6465A45AD561", functionName:"fund", functionArgs:"[\"1000000\"]", abi:"[…fund(uint256)…]", simulate:true}` (bearer redacted) |
| HTTP status         | **400** — the would-revert channel, not an error (G-21)                                                                                                                                                         |
| `wouldRevert`       | **true**                                                                                                                                                                                                        |
| Decoded revert info | `data="0x1c8b6259"` = `RootNotSet()`, confirmed by `cast decode-error 0x1c8b6259`                                                                                                                               |
| Tape                | `packages/kh-client/test/vcr/d019.fundBeforeSetRoot.revert.json`                                                                                                                                                |

The revert is genuine: `fund()` checks `if (root == bytes32(0)) revert RootNotSet();` and the root
was never set. Nothing was staged.

## 2.6 G-20 — does `revertReason` decode a custom error?

**Verdict: branch c.** The selector is present; the name is not.

| Field            | Value                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Branch           | **c** — carries the selector but not the name                                                                                                                                                                                                                                                                      |
| Raw revertReason | `Simulation reverted: execution reverted (unknown custom error) (action="estimateGas", data="0x1c8b6259", reason=null, transaction={ "data": "0xca1d209d…0f4240", "from": "0x65F5…0Da6", "to": "0xD45c61797d7283caf8A31D91A5Bd6465A45AD561" }, invocation=null, revert=null, code=CALL_EXCEPTION, version=6.16.0)` |
| Verdict for G-20 | **MITIGATED** — the API says "unknown custom error", but `data=` carries the 4-byte selector, which is fully recoverable                                                                                                                                                                                           |

**This is a much better answer than CVY-004's measurement suggested.** The WETH9 blob said
`data=null` because WETH9's bare `require` emits _no revert data at all_ — that was the contract's
doing, not the API's. Against a custom-error contract the revert data **is** returned.

`SimulateResult.revertSelector` now extracts it, so CVY-011 maps selector → error name from the ABI
it already holds. The Critic's veto evidence can read `RootNotSet()`, not "missing revert data".

**Do not hardcode selectors.** The first attempt at this measurement used a hand-written constant
that was simply wrong, and it misreported the branch as `b`. Derive them — `toFunctionSelector()` in
TypeScript, `cast sig` at the terminal.
