# Schema v3 全事件溯源 E2E Execution Report

## Execution Summary

| Result | Count |
|---|---:|
| Passed | 9 |
| Failed | 0 |
| Blocked | 1 |
| Skipped | 0 |

本机 Core Slice、installer、concurrency、crash/recovery、outcome rebuild、transcript 和性能全部通过。`npm test` 为 175 tests / 168 pass / 0 fail / 7 Windows-only skip；`verify-full` 为 168/168。W01–W08 已成为专名、可筛选的 CI cases；唯一 blocker 是 E2E-009 的四组真实 Windows runner 证据，本地 Darwin 不能替代。

## Run Lineage & Emergent Scenarios

- Upstream plan: [2026-07-14-schema-v3-event-sourcing-e2e-test-plan.md](../2026-07-14-schema-v3-event-sourcing-e2e-test-plan.md)
- Implementation plan: `docs/plans/2026-07-14-schema-v3-event-sourcing.md`, SHA-256 `7989bdbd061165efb23618a52c7819d61db29d9449a2549ea2b24508ca1dfcf0`
- Upstream run: none
- This run: local release-candidate E2E, preserved traces

| Trigger | Emergent ID | Risk family | Backflow target | Status |
|---|---|---|---|---|
| 首次 snapshot comparison 用 `JSON.stringify` 比较对象，键序不同导致 false negative | EM-001 | plan/tooling oracle | E2E-001 semantic equality probe | CLOSED：改用 `isDeepStrictEqual`，保留首轮 attachment，重建 fixture 后通过 |
| Fable deep closing 在 12 turns 后达到预算且未产出 final result | EM-002 | release review evidence | GATE-005 / Oracle 13 | OPEN：不是 GO/NO-GO；按 reviewer 规则未自动重试 |

## Environment State Ledger

| Field | Value |
|---|---|
| target | local production CLI and checked-in production modules |
| datasource | retained fixture repo `.taskloop/events-v3.jsonl`; retained isolated fixture HOME |
| deployment/freshness evidence | baseline Git HEAD `7dd7d3473e587c8b13a8619a4f5359150fade6e6` + dirty working-tree implementation; `taskloop info` reports 4/3/1/3 |
| isolation namespace | `schema-v3-e2e-20260714` |
| created data | two task IDs, 8 authority records/events, 8 outcome rows, one fixture Git repo |
| cleanup policy | preserve traces; cleanup script exists but final fixture remains |
| remaining traces | `fixture/`, tracked authority/snapshot/outcome copies and digests in `attachments/`, scripts, this report |
| tool permissions | local filesystem/process/Git available; GitHub-hosted Windows runners unavailable in this run |

## Run Metadata

| Field | Value |
|---|---|
| Date/time zone | 2026-07-14, Asia/Shanghai session |
| Host | Darwin arm64, Apple M4 |
| Node | `v26.0.0` |
| Git | `2.50.1 (Apple Git-155)` |
| Repository baseline | `7dd7d3473e587c8b13a8619a4f5359150fade6e6` |
| Runtime handshake | `runtime=4`, `snapshot=3`, `record=1`, `outcome=3` |
| Data policy | preserve self-owned traces |
| Plan mode | full local + conditional Windows release node |

Environment preflight raw output:

```text
v26.0.0
git version 2.50.1 (Apple Git-155)
7dd7d3473e587c8b13a8619a4f5359150fade6e6
7989bdbd061165efb23618a52c7819d61db29d9449a2549ea2b24508ca1dfcf0  docs/plans/2026-07-14-schema-v3-event-sourcing.md
{"name":"taskloop","runtime_contract":4,"task_snapshot_schema_version":3,"event_record_schema_version":1,"outcome_projection_schema_version":3,"event_store":".taskloop/events-v3.jsonl","outcome_projection":"~/.taskloop/outcomes-v3.jsonl","distribution_owner":"taskloop"}
```

## Environment & Capability Map

| Capability | Status | Evidence |
|---|---|---|
| production CLI | available | manual E2E attachment |
| writable repo/HOME | available | fixture and outcome projection created |
| file fsync + directory fsync | available | benchmark receipt `directory_fsync=supported` |
| child process termination | available | recovery suite 55/55 |
| 20-process contention | available | runtime targeted suite 6/6 |
| isolated installer HOME | available | installer 4/4 |
| Windows 2022/2025 × Node 22/24 | blocked | no Windows runner in local environment |

## DAG Schedule

| Node | Scenario(s) | Execution decision | Result |
|---|---|---|---|
| N0 | preflight | first, read-only | passed |
| N1/N2/N6 | E2E-001/002/006 | serialized on one retained manual fixture | passed |
| N3/N4 | E2E-003/004 | isolated existing recovery harness | passed |
| N5/N8 | E2E-005/008 | isolated runtime/hook harness | passed |
| N7 | E2E-007 | isolated temporary install HOME | passed |
| N10 | E2E-010 | run alone after correctness | passed |
| N11 | full gates | serialized after all local nodes | passed |
| N9 | E2E-009 | not runnable on Darwin | blocked |

## Scenario Results

| Scenario | Status | Expected | Actual | Diagnosis | Issue | Evidence / scene |
|---|---|---|---|---|---|---|
| E2E-001 | passed | v3 genesis; snapshot deletion preserves semantics and authority bytes | deep semantic equality true; event digest unchanged | none | — | [E2E-001](#e2e-001--e2e-002--genesis-mutation-and-multi-task-replay) |
| E2E-002 | passed | every public mutation recorded; second task starts sequence 1 | 8 contiguous repo records; event kinds complete; opened sequences `[1,1]` | none | — | [E2E-001/002](#e2e-001--e2e-002--genesis-mutation-and-multi-task-replay) |
| E2E-003 | passed | crash/tail/snapshot outcomes are complete old/new only | recovery/snapshot suite 55/55 | none | — | [E2E-003](#e2e-003--crash-corruption-and-snapshot-recovery) |
| E2E-004 | passed | legacy/orphan/mixed/corrupt fail closed | targeted runtime authority guard plus recovery suite pass | none | — | [E2E-004](#e2e-004--hard-cutover-authority) |
| E2E-005 | passed | transcript tally is byte-exact and retry-safe | baseline/retry/UTF-8/CRLF/replacement tests pass | none | — | [E2E-005](#e2e-005--transcript-idempotency) |
| E2E-006 | passed | projection rebuilds and deduplicates without repo rollback | second sync added 0; deletion rebuild added 8; audit row_count 8 | none | — | [E2E-006](#e2e-006--outcome-projection) |
| E2E-007 | passed | installer failpoints converge; contract 3 rollback refused | installer suite 4/4 | none | — | [E2E-007](#e2e-007--installer-atomic-activation) |
| E2E-008 | passed | 20 mutations serialize; stale lock/reaper recovers | runtime targeted 6/6; stale-lock 1/1 | none | — | [E2E-008](#e2e-008--concurrency-and-stale-lock) |
| E2E-009 | blocked | W01–W08 green on four Windows matrix cells | workflow configured; no exact-diff remote run | environment | — | [E2E-009](#e2e-009--windows-release-matrix) |
| E2E-010 | passed | all frozen performance thresholds pass | replay max 123.54ms; tail P95 0.128ms; fsync P95 4.428ms | none | — | [E2E-010](#e2e-010--performance) |

## Evidence & Failure Scenes

### E2E-001 / E2E-002 — genesis, mutation and multi-task replay

- Probe: `node .../scripts/run-manual-e2e.mjs`
- Expected: snapshot semantic equality, unchanged event digest, contiguous repo sequence, task-opened sequence reset.
- Actual raw output:

```json
{"snapshot_recovery_semantically_equal":true,"event_digest_unchanged_by_snapshot_recovery":true,"repo_sequences":[1,2,3,4,5,6,7,8],"task_opened_sequences":[1,1]}
```

- Created identifiers: `d2d19ab9-e285-4f7b-aaae-f01e85570a26`, `f403a10c-f2f6-4eae-94ab-32b76ed44d70`.
- Persisted event kinds: `task_opened, write_authorized, task_suspended, task_resumed, review_recorded, task_amended, task_terminal, task_opened`.
- Full raw command/output: [manual-e2e-result.json](attachments/manual-e2e-result.json).
- Retained raw authority/projections and digest receipt: [events-v3.jsonl](attachments/events-v3.jsonl), [task-snapshot-v3.json](attachments/task-snapshot-v3.json), [outcomes-v3.jsonl](attachments/outcomes-v3.jsonl), [retained-artifact-manifest.json](attachments/retained-artifact-manifest.json).
- Preserved first false-negative scene: [manual-e2e-result-first-run.json](attachments/manual-e2e-result-first-run.json).
- Re-query: `node bin/taskloop.mjs audit --repo docs/e2e-test/schema-v3-event-sourcing/e2e-run-schema-v3-event-sourcing-20260714/fixture/repo`.

### E2E-003 — crash, corruption and snapshot recovery

- Probe: `node --test tests/event-store.test.mjs tests/task-snapshot-v3.test.mjs`
- Expected: C/R matrix and snapshot recovery all pass.
- Actual raw output:

```text
ℹ tests 55
ℹ suites 0
ℹ pass 55
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

- Created identifiers: deterministic harness task/event/transaction IDs; fixtures self-clean after assertions.
- Full raw output: [recovery.json](attachments/recovery.json).
- Re-query: same command above.

### E2E-004 — hard cutover authority

- Probe: `node --test --test-name-pattern="authority guard|transcript|outcomes-v3|HOME projection|twenty concurrent" tests/runtime-v4.test.mjs` plus recovery suite.
- Expected: legacy/orphan/mixed/corrupt inputs fail closed without event overwrite.
- Actual raw slice:

```text
✔ authority guard rejects legacy, orphan, mixed, and corrupt state without overwriting events
ℹ tests 6
ℹ pass 6
ℹ fail 0
```

- Created identifiers: isolated runtime fixtures; no shared data.
- Full raw output: [runtime.json](attachments/runtime.json).
- Re-query: targeted command above.

### E2E-005 — transcript idempotency

- Probe: same targeted runtime command.
- Expected: baseline/increment/retry and UTF-8/CRLF/replacement generation pass.
- Actual raw output:

```text
✔ transcript baseline and increment are in authority and a denied retry cannot double tally
✔ [W07] transcript ranges use UTF-8 byte offsets, CRLF, partial records, and replacement generations
ℹ fail 0
```

- Created identifiers: per-fixture generation/event IDs; fixtures self-clean.
- Full raw output: [runtime.json](attachments/runtime.json).
- Re-query: targeted runtime command.

### E2E-006 — outcome projection

- Probe: manual `sync-outcomes` twice, delete self-owned projection, sync, `audit-outcomes`.
- Expected: idempotent second sync, exact rebuild, no duplicate rows.
- Actual raw output:

```json
{"second_sync":{"valid":true,"added":0,"total":8},"rebuild_sync":{"valid":true,"added":8,"total":8},"outcome_audit":{"valid":true,"row_count":8}}
```

- Created identifiers: repo cursor hash `0e7915c010fb29ab2fc27a6d3fb79f0c5f6ec5a53956c90ec184f9b438873a6a`.
- Full raw output: [manual-e2e-result.json](attachments/manual-e2e-result.json).
- Re-query: `HOME=<run>/fixture/home node bin/taskloop.mjs audit-outcomes`.

### E2E-007 — installer atomic activation

- Probe: `node --test tests/installer.test.mjs`.
- Expected: normal install, all activation interruptions, assurance matrix and contract-3 rejection pass.
- Actual raw output:

```text
✔ installer puts runtime and skills from one release under a temporary home
✔ runtime-contract-4 installer refuses a contract-3 source rollback
✔ installed runtime exercises the assurance matrix
✔ every installer activation interruption leaves a journal and rerun converges
ℹ tests 4
ℹ pass 4
ℹ fail 0
```

- Created identifiers: installer test temporary release IDs; harness cleans isolated HOME.
- Full raw output: [installer.json](attachments/installer.json).
- Re-query: same command.

### E2E-008 — concurrency and stale lock

- Probes: targeted runtime command; `node --test --test-name-pattern="aged lock" tests/taskloop-architecture.test.mjs`.
- Expected: 20 writes without gaps/loss; aged owner and reaper recovered once.
- Actual raw output:

```text
✔ [W05] twenty concurrent mutations serialize without sequence gaps or lost writes
ℹ tests 6
ℹ pass 6
ℹ fail 0

✔ [W06] task lock recovers an aged lock and reaper left by crashed processes without double ownership
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

- Created identifiers: isolated child-process fixtures; self-clean.
- Full raw output: [runtime.json](attachments/runtime.json), [stale-lock.json](attachments/stale-lock.json).
- Re-query: the two probe commands above.

### E2E-009 — Windows release matrix

- Probe: inspect `.github/workflows/test.yml`; local `npm test` enumerates Windows-only tests as skip.
- Expected: four exact GitHub-hosted Windows cells pass W01–W08.
- Actual raw output:

```text
ℹ tests 175
ℹ pass 168
ℹ fail 0
ℹ skipped 7
```

- Created identifiers: none.
- Scene: workflow has `windows-2022/windows-2025 × Node 22/24`, a 5-minute exact `[W01]`–`[W08]` selection, case IDs in test failure output, and no `continue-on-error`; local W02–W08 pass while W01 is correctly Windows-only skipped, but no remote run receipt exists for this dirty working tree.
- Full local output: [npm-test.json](attachments/npm-test.json).
- Exact local case selection: [windows-cases-local.json](attachments/windows-cases-local.json) (8 pass, W01 Windows-only skip).
- Re-query: trigger the exact revision's GitHub Actions `test` workflow and inspect all four matrix jobs.

### E2E-010 — performance

- Probe: `npm run bench:event-store -- --json`.
- Expected: 10,001 records; replay <200ms; tail P95 <5ms; append+fsync P95 <20ms.
- Actual raw output:

```json
{"status":"pass","record_count":10001,"file_bytes":7180046,"summary":{"full_replay_ms":{"p50_ms":119.668625,"p95_ms":123.54291699999999,"max_ms":123.54291699999999,"passed":true},"incremental_tail_ms":{"p50_ms":0.08687500000002046,"p95_ms":0.12837500000000546,"max_ms":0.36579200000005585,"passed":true},"append_fsync_ms":{"p50_ms":3.8746250000000373,"p95_ms":4.4278340000000185,"max_ms":5.050916000000029,"passed":true}},"passed":true}
```

- Created identifiers: deterministic 10,001-record benchmark dataset in temporary files; harness cleans it.
- Full raw receipt: [benchmark.json](attachments/benchmark.json).
- Re-query: same benchmark command.

### Final local gates

```text
npm test
ℹ tests 175
ℹ pass 168
ℹ fail 0
ℹ skipped 7

node tests/verify-full.mjs
ℹ tests 168
ℹ pass 168
ℹ fail 0
ℹ skipped 0
```

Full output: [npm-test.json](attachments/npm-test.json), [verify-full.json](attachments/verify-full.json).

## Failures / Defects / Plan Gaps

| ID | Type | Disposition | Detail | Close condition |
|---|---|---|---|---|
| PLAN-001 | plan/tooling defect | CLOSED | semantic object equality initially depended on JSON property order | `isDeepStrictEqual` rerun true; first scene retained |
| GAP-001 | environment gap | CONDITIONAL | no exact-diff GitHub-hosted Windows matrix receipt | all four W01–W08 matrix cells green |
| GAP-002 | scope gap | OUT-OF-SCOPE | real power loss, NFS/SMB, multi-host concurrency | new decision envelope and storage/lock design |
| GAP-003 | release gate | OPEN | Fable closing 已执行但达到预算，未产出 final result；当前也不存在可认证的 release commit | Windows receipt 后，在冻结 release commit 上取得 second-model GO，随后无 material edit |

Review found and this run closed three actionable product defects: unlocked torn-tail truncation, inaccurate side-effect `verify` persistence output, and authority bypass in `audit/sync-outcomes`. No OPEN actionable product root cause remains, so no local issue document was created.

Review receipts: Standards code verdict PASS；Spec implementation verdict CONDITIONAL GO；Fable attempt [fable-closing-attempt.json](attachments/fable-closing-attempt.json) is inconclusive, not a verdict.

## Data Created & Cleanup

| Data | Owner marker | Retention | Cleanup |
|---|---|---|---|
| manual fixture repo/HOME | `schema-v3-e2e-20260714` marker file | retained | `node .../scripts/cleanup-fixture.mjs` |
| two task histories / 8 records | task IDs listed above | retained inside fixture and `attachments/events-v3.jsonl` | same cleanup script removes fixture only |
| outcome projection / cursor | isolated fixture HOME | retained; projection copied to attachments | same cleanup script removes fixture only |
| harness fixtures | test-specific temp prefixes | cleaned by Node test teardown | rerun suites to recreate |
| attachments/report | run directory | retained indefinitely with working tree | delete run directory only with explicit cleanup decision |

Cleanup was intentionally not run after the final passing manual E2E.

## Re-run Instructions

```sh
node docs/e2e-test/schema-v3-event-sourcing/e2e-run-schema-v3-event-sourcing-20260714/scripts/run-suite-evidence.mjs
npm run bench:event-store -- --json
npm test
node tests/verify-full.mjs
```

The manual fixture is retained and is not idempotently reset. For a clean manual rerun, first run the owner-checking cleanup script, then `seed-fixture.mjs`, then `run-manual-e2e.mjs`.

## Next Actions for Agent

1. Obtain the four-cell Windows receipt for the exact release diff.
2. Freeze an authorized release commit, then explicitly rerun Fable/second-model closing; resolve findings and make no later material edit.
