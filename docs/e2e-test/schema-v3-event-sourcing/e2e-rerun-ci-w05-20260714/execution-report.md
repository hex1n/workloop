# Schema v3 exact-CI W05 修复续跑报告

## Execution Summary

| Result | Count |
|---|---:|
| Passed | 4 |
| Failed | 0 |
| Blocked | 1 |
| Skipped | 0 |

首个精确候选提交 `118cf8943c647703cb366407cc048b1ebd156792` 暴露 Hook stdin `EAGAIN`；后续诊断 run 暴露 Windows reaper `EPERM/EACCES`。两项根因均已修复，证据提交 `c16a790579ed1f6876b8644edc3ed28e47704696` 的 GitHub Actions run `29337719411` 已通过全部 8 个矩阵任务。随后 Fable deep closing 返回 `needs-attention`：核心完整性设计无法被证伪，但指出 Hook 重复全量回放、HOME outcome torn tail/全扫和死代码；对应修复已在本地通过回归，仍需新 SHA 的精确 CI 和 Fable GO。

## Run Lineage & Emergent Scenarios

- Upstream plan: [2026-07-14-schema-v3-event-sourcing-e2e-test-plan.md](../2026-07-14-schema-v3-event-sourcing-e2e-test-plan.md)
- Upstream run: [e2e-rerun-release-gates-20260714](../e2e-rerun-release-gates-20260714/execution-report.md)
- Downstream: Fable remediation SHA exact CI, then Fable closing
- Status: open

| Emergent scenario | Source trigger | Risk family | Plan section to update | Status |
|---|---|---|---|---|
| EM-005 nonblocking Hook stdin | exact CI W05 lost events while every child exited 0 | Hook protocol / concurrency | W05 and Oracle 7/8 | closed by run `29337249679` |
| EM-006 Windows reaper `EPERM` | fix CI exposed transient `EPERM` while contenders create/remove `.task.lock.reaper` | Windows lock recovery | W05/W06 and Oracle 8 | closed by run `29337249679` |
| EM-007 closing-review efficiency | Fable found repeated authority replay and unbounded HOME projection scans | Hook latency / derived projection recovery | GATE-005 | remediated locally; exact CI pending |

## Execution Contract Override

| Supersedes | New rule | Source | Affected |
|---|---|---|---|
| prior run lacked commit/push/retry authority | user explicitly authorized release commit, push, exact CI, and post-Windows Fable closing | user `授权` | E2E-009, GATE-005 |

## Environment State Ledger

- Target: local source CLI plus GitHub Actions runs `29335557499` through `29337719411`, local/test only.
- Datasource: isolated temporary repositories created by `tests/runtime-v4.test.mjs`; GitHub `hex1n/taskloop` Actions metadata.
- Deployment/freshness evidence: remote SHA `c16a790579ed1f6876b8644edc3ed28e47704696`, run `29337719411`, conclusion `success`, eight successful matrix jobs; later local remediation is not yet committed.
- Isolation namespace: `schema-v3-ci-w05-20260714`.
- Created data: temporary W05 repositories only; test teardown removed them.
- Cleanup policy: preserve this report and local issue; temporary fixtures self-clean.
- Remaining traces: five GitHub runs, two Fable sessions, this report, and two closed local issue documents.
- Tool permissions: authenticated GitHub Actions read/push access and local process/filesystem access; no production target.

## Run Metadata

| Field | Value |
|---|---|
| Run kind | exact-CI failure continuation and local fix loop |
| Failed remote SHA | `118cf8943c647703cb366407cc048b1ebd156792` |
| GitHub run | [29335557499](https://github.com/hex1n/taskloop/actions/runs/29335557499) |
| Successful fix SHA | `d89e8871924ddeb9ddbb8f8b030ebedc8d186fd6` |
| Successful fix run | [29337249679](https://github.com/hex1n/taskloop/actions/runs/29337249679), 8/8 jobs |
| Successful evidence SHA/run | `c16a790579ed1f6876b8644edc3ed28e47704696`; [29337719411](https://github.com/hex1n/taskloop/actions/runs/29337719411), 8/8 jobs |
| Fable review | session `e3f4afcf-20db-42eb-aca5-a0246a17974d`; `needs-attention`; 1 medium + 2 low; core correctness not falsified |
| Local runtimes | Node `v22.14.0` and `v26.0.0` |
| Selected scenarios | W05, E2E-009, GATE-005 |
| Retention | preserve evidence |

## Environment & Capability Map

| Capability | Status | Evidence |
|---|---|---|
| exact SHA CI metadata and failed logs | available | GitHub run `29335557499` |
| local Node 22 reproduction | available | `TASKLOOP_W05_CONCURRENCY=100` |
| delayed nonblocking stdin control | available | deterministic 50 ms regression test |
| exact fix Windows matrix | available/passed | run `29337249679`: Windows 2022/2025 × Node 22/24 all successful |
| Fable closing | blocked | `needs-attention`; remediation successor needs exact CI and GO |

## DAG Schedule

| Node | Scenario | Depends on | Decision | Result |
|---|---|---|---|---|
| C0 | inspect exact CI failures | prior release gate | first | passed |
| C1 | amplify W05 locally | C0 | isolated Node 22 stress | passed |
| C2 | deterministic delayed-stdin regression | C1 | red before fix, green after fix | passed |
| C3 | complete local regression | C2 | Node 22 then Node 26 | passed |
| C3b | Windows reaper contention classification | second/third exact CI | preserve task-lock fail-closed semantics | passed |
| C4 | exact-fix matrix | C3 + new SHA | run all eight jobs | passed |
| C5 | Fable closing | C4 all green | remediate review findings, rerun exact CI | blocked |

## Scenario Results

| Scenario | Status | Expected | Actual | Diagnosis | Issue | Evidence / scene |
|---|---|---|---|---|---|---|
| W05-REPRO | passed | amplify the exact silent-loss symptom | Node 22 at 100 concurrency produced `29/101` records; all children exited 0 with empty output | product | [ISSUE-001](issues/ISSUE-001-hook-stdin-eagain.md) | [W05 reproduction](#w05-repro--silent-authority-loss) |
| W05-FIX | passed | delayed stdin and 100 concurrent hooks preserve every event | delayed test `2/2`; stress `101/101`; Node 22/26 full suites green | product | [ISSUE-001](issues/ISSUE-001-hook-stdin-eagain.md) | [W05 fix](#w05-fix--bounded-stdin-read-retry) |
| W05-WINDOWS-REAPER | passed | reaper-directory contention retries without losing the real task lock | all four Windows cells passed W01–W08 and downstream suites | product | [ISSUE-002](issues/ISSUE-002-windows-reaper-eperm.md) | [Windows reaper](#w05-windows-reaper--transient-eperm) |
| E2E-009 | passed | all eight matrix jobs, including four Windows cells, pass the exact fix SHA | run `29337249679` is 8/8 successful on `d89e887…6fd6` | product | [ISSUE-001](issues/ISSUE-001-hook-stdin-eagain.md), [ISSUE-002](issues/ISSUE-002-windows-reaper-eperm.md) | [Exact CI](#e2e-009--exact-fix-ci) |
| GATE-005 | blocked | Fable returns final GO on the exact green release commit | deep review returned `needs-attention`; local remediation is green but uncommitted | performance/review | — | [Fable gate](#gate-005--fable-closing) |

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

- Probe: query the `test` workflow for SHA `d89e8871924ddeb9ddbb8f8b030ebedc8d186fd6` and inspect all jobs.
- Expected: portable macOS/Ubuntu Node 22/24 and Windows 2022/2025 × Node 22/24 all succeed; each Windows job passes W01–W08.
- Actual: run `29337249679` completed `success`; four portable and four Windows jobs all succeeded. Every Windows cell passed W01–W08, Architecture, Installer, and Behavioral/hook protocol.
- Raw job receipt:

```text
portable (macos-latest, 22) success
portable (macos-latest, 24) success
portable (ubuntu-latest, 22) success
portable (ubuntu-latest, 24) success
windows (windows-2022, 22) success
windows (windows-2022, 24) success
windows (windows-2025, 22) success
windows (windows-2025, 24) success
```

- Prior failure scene: run `29335557499` passed five jobs and failed Ubuntu Node 22/24 plus Windows 2025 + Node 22 on W05.
- Re-query: `gh run list --workflow test --branch agent/schema-v3-event-sourcing --json databaseId,headSha,status,conclusion`.
- Cleanup safety: remote run is immutable evidence.

### W05-WINDOWS-REAPER — transient EPERM

- Probe: diagnostic assertion in exact run `29336791375` preserved each failed child process's stderr.
- Expected: failure to acquire the optional reaper directory is treated as contention; the real task lock remains authoritative.
- Actual raw slice:

```text
EPERM: operation not permitted, mkdir '...\\repo\\.taskloop\\.task.lock.reaper'
permissionDecisionReason: taskloop: supervisor unavailable; refusing a write whose artifact revision cannot be recorded
```

- Diagnosis: Windows may return `EPERM/EACCES` while another process creates or removes the short-lived reaper directory. The code previously propagated anything except `EEXIST`.
- Fix: on Windows only, classify `EPERM/EACCES` from reaper `mkdir` as contention and return to the bounded outer task-lock retry; persistent failure still reaches `TASKLOCK_TIMEOUT`.
- Created identifiers: GitHub jobs `87097933087` and `87097933131`; no retained local data.
- Re-query: exact Windows 2022/2025 × Node 22/24 W01–W08 step.
- Post-fix result: run `29337249679` passed all four cells and every downstream job step.
- Cleanup safety: remote logs are immutable; diagnostic assertion remains useful failure evidence.

### GATE-005 — Fable closing

- Probe: one Fable deep review after E2E-009 passes.
- Expected: final GO bound to the same release SHA, with no later material edit.
- Actual: SHA `c16a7905…4696` passed run `29337719411`; Fable session `e3f4afcf-20db-42eb-aca5-a0246a17974d` returned `needs-attention`, not GO. It found one medium efficiency risk (about six full event replays per PreToolUse) and two low robustness/cleanup findings.
- Local remediation: PreToolUse now performs one full verified replay under the task lock and reuses its authority for the single commit; 10,001-record full replay is about 110–112 ms locally. The HOME outcome projection uses its existing cursor for the normal incremental append, repairs complete/no-newline and incomplete tails, and falls back to full scan on cursor/tail inconsistency. Dead suspension/review helpers were removed. A guard makes the Windows W01–W08 selection non-vacuous in every listed file.
- Local evidence: Node 22 and Node 26 `npm test` each pass `173`, fail `0`, skip `7`; `verify-full` passes `173/173`; W selection passes `9` with only W01 skipped locally; event-store benchmark passes all thresholds.
- Re-query: commit the remediation, require all eight matrix jobs on that exact SHA, then obtain a new Fable GO with no later material edit.
- Cleanup safety: review is read-only.

## Failures / Defects / Plan Gaps

| ID | Type | Disposition | Detail | Close condition |
|---|---|---|---|---|
| [ISSUE-001](issues/ISSUE-001-hook-stdin-eagain.md) | product/concurrency | CLOSED | bounded stdin reader and deterministic regression pass locally and in run `29337249679` | closed by exact 8/8 fix run |
| [ISSUE-002](issues/ISSUE-002-windows-reaper-eperm.md) | product/Windows concurrency | CLOSED | Windows reaper contention retries while the real task lock stays authoritative | closed by four exact Windows successes in run `29337249679` |
| GAP-005 | performance/review | BLOCKED | Fable returned `needs-attention`; remediation is local-only | exact remediation SHA passes 8/8, then Fable GO with no edit |

## Data Created & Cleanup

| Data | Owner marker | Retention | Cleanup |
|---|---|---|---|
| temporary W05 repositories | Node test temp prefix `taskloop-v4-` | cleaned | automatic `t.after` removal |
| GitHub Actions runs | runs `29335557499`, `29336558086`, `29336791375`, `29337249679`, `29337719411` | preserve | immutable remote evidence |
| Fable review receipt | session `e3f4afcf-20db-42eb-aca5-a0246a17974d` | preserve in review job history | read-only evidence |
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

No original W05 product issue remains. The release orchestrator must commit the Fable remediation, obtain exact 8/8 CI for that successor SHA, and only then request a new Fable closing review.
