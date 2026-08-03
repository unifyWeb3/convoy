# @convoy/kh-client

The **only** module in this repository permitted to reach `app.keeperhub.com`. A CI grep-guard fails
the build if `app.keeperhub.com` appears anywhere else under `apps/`, `packages/`, `services/` or
`scripts/`.

Every KeeperHub API drift is absorbed here behind stable types, so the orchestrator, the Critic and
the manifest reconciler consume one contract that does not move.

## Vocabulary rule

REST direct execution, always:

| Use                                                         | Never                                      |
| ----------------------------------------------------------- | ------------------------------------------ |
| `contractAddress` / `functionName` / `functionArgs` / `abi` | `abiFunction`                              |
| `POST /api/execute/contract-call`                           | `call_workflow` for a write                |
| KeeperHub's nonce manager                                   | any `nonce:` field — Convoy never sets one |

`call_workflow` returns **unsigned calldata** to the caller. Using it for a write would hand Convoy
a transaction to sign, which would mean holding a key, managing a nonce, and reimplementing the
retries and multi-RPC failover that are the entire reason KeeperHub is in the architecture.

## The one thing to get right

**A simulate that finds a revert answers on HTTP 400.** It is a _successful_ simulate, not an API
error:

```jsonc
// HTTP 400 — recorded, test/vcr/simulate.wouldRevert.true.json
{ "success": false, "status": "simulated", "wouldRevert": true, "revertReason": "…" }
```

Note `success: false`. The verdict is `wouldRevert`, **not** `success`. Classifying this 400 as a
failure would turn every Critic veto into a hard error and take the veto mechanism off the table, so
`simulateContractCall` declares 400 an expected status and returns the revert as data.

The inverse mistake is guarded too: a 400 that carries **no** `wouldRevert` field is a genuine
validation error, and reporting it as "would not revert" would let the Critic approve an item the
API never evaluated. That case throws.

## Usage

```ts
import {
  KhClient,
  simulateContractCall,
  writeContractCall,
  pollUntilTerminal,
} from '@convoy/kh-client';

const client = new KhClient({
  apiKey: process.env.KEEPERHUB_API_KEY!,
  chainId: '84532', // Base Sepolia — DEC-001
  mode: process.env.CONVOY_KH_MODE === 'vcr' ? 'vcr' : 'live',
});

const sim = await simulateContractCall(client, {
  contractAddress: registry,
  functionName: 'commitAction',
  functionArgs: [runId, idx, payloadHash],
  abi: REGISTRY_ABI,
});
if (sim.wouldRevert) return veto(sim.revertReason);

const write = await writeContractCall(
  client,
  { contractAddress: registry, functionName: 'commitAction', functionArgs: [...], abi: REGISTRY_ABI },
  { runId, idx, attempt },
);
const final = await pollUntilTerminal(client, write); // no-op when already terminal
```

## Error classes

`classifyHttpError` sorts every failure into exactly one class, and the class decides what the
orchestrator does:

| Class          | Sources                                                       | Orchestrator action         |
| -------------- | ------------------------------------------------------------- | --------------------------- |
| `fatal`        | 401                                                           | stop everything             |
| `fatal-to-run` | 403 daily cap · 422 wallet not configured                     | fail the run                |
| `transient`    | 429 · 5xx · transport · `E-/N-/P-/C-` codes · 409 in-progress | retry with jittered backoff |
| `item-failed`  | config-revert (full message, no code) · 409 conflict          | fail the item, never retry  |

A coded run error is transient **wherever it appears** — the code wins over the status, so a coded
400 is not mistaken for a config-revert.

The retries here are **Convoy's own**, of its own HTTP requests. Onchain retries belong to KeeperHub
and are only ever observed.

## Idempotency

`Idempotency-Key: <runId>:<idx>:<attempt>`, per-org, 24h. **Simulates are exempt** — they sign
nothing, broadcast nothing and create no audit row, so spending a key on one would be pure waste.

The two 409s mean opposite things: `idempotency_in_progress` is transient (the same key is
mid-flight, wait), while `idempotency_conflict` means the same key was reused with a different body —
a Convoy bug, so the item fails rather than retrying into the same wall.

## VCR mode

`CONVOY_KH_MODE=vcr` replays recorded tapes from `test/vcr/` so UI work runs with no credentials and
no network. Tapes are verbatim recordings — they are `.prettierignore`d, because a reformatted tape
is a transcription rather than a recording.

A missing tape throws. It never silently passes.

## Recorded API drift

See `docs/KNOWN_GAPS.md`: G-01 (`chainId` vs `network`), G-02 (synchronous writes), G-03 (403/422),
G-20 (`revertReason` is a diagnostic blob, not `Error(...)`), G-21 (would-revert arrives on 400),
G-22 (unsupported chain returns 500 with an empty body), G-23 (a synchronous write carries no
transaction hash — it is only on `GET /status`).
