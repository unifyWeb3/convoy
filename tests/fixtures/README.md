# Test fixtures

| Fixture                      | Purpose                                                                       | Milestone         |
| ---------------------------- | ----------------------------------------------------------------------------- | ----------------- |
| `payloadHash.fixtures.json`  | ≥10 cases dumped by a forge script, asserting Solidity↔TypeScript byte parity | CVY-002           |
| `planner.10run.json`         | 10-run labelled dependency fixture; recall ≥0.9                               | CVY-010           |
| `critic.5valid5invalid.json` | 5 valid + 5 invalid items; ≥4/5 vetoed, 5/5 valid passed, zero false vetoes   | CVY-011           |
| `batch-3item.json`           | Thin-slice batch for the state machine and GATE 1                             | CVY-005 / CVY-008 |
| `batch-12item.json`          | Full demo batch for GATE 2                                                    | CVY-005           |
| `ablation.batch.json`        | Batch used by the ablation harness                                            | CVY-016           |
| `vcr/`                       | Recorded KeeperHub tapes replayed when `CONVOY_KH_MODE=vcr`                   | CVY-004           |

Fixtures are real inputs, never fabricated outputs. A fixture never contains a transaction hash that
was not produced by a real execution.
