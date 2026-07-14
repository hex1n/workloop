# Schema v3 exact-CI W05 修复续跑报告

## Execution Summary

| Result | Count |
|---|---:|
| Passed | 2 |
| Failed | 0 |
| Blocked | 2 |
| Skipped | 0 |

首个精确候选提交 `118cf8943c647703cb366407cc048b1ebd156792` 已触发 GitHub Actions run `29335557499`。五个矩阵格通过；Ubuntu Node 22/24 与 Windows 2025 + Node 22 暴露同一个 W05 Hook stdin 竞态。根因已在本地确定性复现并修复，远端精确修复提交验证尚未执行。

## Run Lineage & Emergent Scenarios

- Upstream plan: [2026-07-14-schema-v3-event-sourcing-e2e-test-plan.md](../2026-07-14-schema-v3-event-sourcing-e2e-test-plan.md)
- Upstream run: [e2e-rerun-release-gates-20260714](../e2e-rerun-release-gates-20260714/execution-report.md)
- Downstream: pending exact-fix CI rerun
- Status: open

| Emergent scenario | Source trigger | Risk family | Plan section to update | Status |
|---|---|---|---|---|
| EM-005 nonblocking Hook stdin | exact CI W05 lost events while every child exited 0 | Hook protocol / concurrency | W05 and Oracle 7/8 | accepted; local fix proved, remote closure pending |

## Execution Contract Override

| Supersedes | New rule | Source | Affected |
|---|---|---|---|
| prior run lacked commit/push/retry authority | user explicitly authorized release commit, push, exact CI, and post-Windows Fable closing | user `授权` | E2E-009, GATE-005 |

## Environment State Ledger

- Target: local source CLI plus GitHub Actions run `29335557499`, local/test only.
- Datasource: isolated temporary repositories created by `tests/runtime-v4.test.mjs`; GitHub `hex1n/taskloop` Actions metadata.
- Deployment/freshness evidence: failed remote SHA `118cf8943c647703cb366407cc048b1ebd156792`; local working tree adds the stdin retry fix and deterministic regression.
- Isolation namespace: `schema-v3-ci-w05-20260714`.
- Created data: temporary W05 repositories only; test teardown removed them.
- Cleanup policy: preserve this report and local issue; temporary fixtures self-clean.
- Remaining traces: GitHub run `29335557499`, this report, and `issues/ISSUE-001-hook-stdin-eagain.md`.
- Tool permissions: authenticated GitHub Actions read/push access and local process/filesystem access; no production target.

## Run Metadata

| Field | Value |
|---|---|
| Run kind | exact-CI failure continuation and local fix loop |
| Failed remote SHA | `118cf8943c647703cb366407cc048b1ebd156792` |
| GitHub run | [29335557499](https://github.com/hex1n/taskloop/actions/runs/29335557499) |
| Local runtimes | Node `v22.14.0` and `v26.0.0` |
| Selected scenarios | W05, E2E-009, GATE-005 |
| Retention | preserve evidence |

## Environment & Capability Map

| Capability | Status | Evidence |
|---|---|---|
| exact SHA CI metadata and failed logs | available | GitHub run `29335557499` |
| local Node 22 reproduction | available | `TASKLOOP_W05_CONCURRENCY=100` |
| delayed nonblocking stdin control | available | deterministic 50 ms regression test |
| exact fix Windows matrix | blocked | fix not yet committed/pushed |
| Fable closing | blocked | requires four exact-fix Windows cells first |

## DAG Schedule

| Node | Scenario | Depends on | Decision | Result |
|---|---|---|---|---|
| C0 | inspect exact CI failures | prior release gate | first | passed |
| C1 | amplify W05 locally | C0 | isolated Node 22 stress | passed |
| C2 | deterministic delayed-stdin regression | C1 | red before fix, green after fix | passed |
| C3 | complete local regression | C2 | Node 22 then Node 26 | passed |
| C4 | exact-fix matrix | C3 + new SHA | pending | blocked |
| C5 | Fable closing | C4 all green | pending | blocked |

## Scenario Results

| Scenario | Status | Expected | Actual | Diagnosis | Issue | Evidence / scene |
|---|---|---|---|---|---|---|
| W05-REPRO | passed | amplify the exact silent-loss symptom | Node 22 at 100 concurrency produced `29/101` records; all children exited 0 with empty output | product | [ISSUE-001](issues/ISSUE-001-hook-stdin-eagain.md) | [W05 reproduction](#w05-repro--silent-authority-loss) |
| W05-FIX | passed | delayed stdin and 100 concurrent hooks preserve every event | delayed test `2/2`; stress `101/101`; Node 22/26 full suites green | product | [ISSUE-001](issues/ISSUE-001-hook-stdin-eagain.md) | [W05 fix](#w05-fix--bounded-stdin-read-retry) |
| E2E-009 | blocked | all eight matrix jobs, including four Windows cells, pass the exact fix SHA | fix is not yet a Git revision | product | [ISSUE-001](issues/ISSUE-001-hook-stdin-eagain.md) | [Exact CI](#e2e-009--exact-fix-ci) |
| GATE-005 | blocked | Fable returns final GO on the exact green release commit | Windows prerequisite not yet met | tooling | — | [Fable gate](#gate-005--fable-closing) |

## Evidence & Failure Scenes

### W05-REPRO — silent authority loss

- Probe: `TASKLOOP_W05_CONCURRENCY=100 <node22> --test --test-reporter=spec --test-name-pattern='\[W05\]' tests/runtime-v4.test.mjs`.
- Expected: genesis plus 100 `write_authorized` records.
- Actual before fix: `29 !== 101`; all 100 children reported `{status:0,stdout:"",stderr:""}`.
- Targeted instrumentation then showed each missing payload read failed with `EAGAIN: resource temporarily unavailable, read`, after which `loadPayload` returned `{}` and dispatch silently exited.
- Raw failure slice:

```text
✖ [W05] twenty concurrent mutations serialize without sequence gaps or lost writes
29 !== 101
actual: 29
expected: 101
```

- Created identifiers: isolated temporary task/repository; removed by test teardown.
- Re-query: run the same stress command; a record count below 101 reproduces the defect.
- Cleanup safety: debug instrumentation was removed; no fixture remains.

### W05-FIX — bounded stdin read retry

- Probe 1: delayed writer test `--test-name-pattern='temporarily empty nonblocking stdin pipe'`.
- Red witness: before the fix, authority stayed at `1` instead of `2`.
- Green witness: after the fix, delayed test passes and authority reaches `2`; Node 22 stress reaches `101/101`.
- Full local outcomes: Node 22 `176 tests / 169 pass / 0 fail / 7 skip`; Node 26 same; `verify-full` `169/169`; local W selection `9 pass / 0 fail / 1 Windows-only skip`.
- Raw green slice:

```text
✔ [W05] twenty concurrent mutations serialize without sequence gaps or lost writes
✔ [W05] hook payload reading waits through a temporarily empty nonblocking stdin pipe
tests 2
pass 2
fail 0
```

- Re-query: `npm test` and `node tests/verify-full.mjs`.
- Cleanup safety: only source/test changes remain.

### E2E-009 — exact fix CI

- Probe: query the `test` workflow for the next pushed SHA and inspect all jobs.
- Expected: portable macOS/Ubuntu Node 22/24 and Windows 2022/2025 × Node 22/24 all succeed; each Windows job passes W01–W08.
- Actual: no fix SHA exists yet.
- Prior failure scene: run `29335557499` passed five jobs and failed Ubuntu Node 22/24 plus Windows 2025 + Node 22 on W05.
- Re-query: `gh run list --workflow test --branch agent/schema-v3-event-sourcing --json databaseId,headSha,status,conclusion`.
- Cleanup safety: remote run is immutable evidence.

### GATE-005 — Fable closing

- Probe: one Fable deep review after E2E-009 passes.
- Expected: final GO bound to the same release SHA, with no later material edit.
- Actual: prerequisite remains blocked.
- Re-query: launch only after all four Windows cells for the final SHA pass.
- Cleanup safety: review is read-only.

## Failures / Defects / Plan Gaps

| ID | Type | Disposition | Detail | Close condition |
|---|---|---|---|---|
| [ISSUE-001](issues/ISSUE-001-hook-stdin-eagain.md) | product/concurrency | OPEN | Hook stdin `EAGAIN` was swallowed as an empty payload, silently losing event authority writes | exact fix SHA passes all eight matrix jobs and affected E2E dependents |
| GAP-005 | review/tooling | CONDITIONAL | Fable must wait for exact-fix Windows success | all four Windows cells green, then final GO with no edit |

## Data Created & Cleanup

| Data | Owner marker | Retention | Cleanup |
|---|---|---|---|
| temporary W05 repositories | Node test temp prefix `taskloop-v4-` | cleaned | automatic `t.after` removal |
| GitHub Actions run | run `29335557499` | preserve | immutable remote evidence |
| report and issue | `e2e-rerun-ci-w05-20260714` | preserve | remove only by explicit instruction |

## Re-run Instructions

```sh
TASKLOOP_W05_CONCURRENCY=100 node --test --test-reporter=spec --test-name-pattern='\[W05\]' tests/runtime-v4.test.mjs
npm test
node tests/verify-full.mjs
git push github agent/schema-v3-event-sourcing
gh run list --workflow test --branch agent/schema-v3-event-sourcing --json databaseId,headSha,status,conclusion
```

## Next Actions for Agent

- [ISSUE-001](issues/ISSUE-001-hook-stdin-eagain.md): commit and push the bounded stdin reader plus regression test, then rerun W05 and all matrix dependents on the exact new SHA. Close only after all eight jobs pass.
