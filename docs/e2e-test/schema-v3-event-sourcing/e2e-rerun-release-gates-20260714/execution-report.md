# Schema v3 release gates E2E 续跑报告

## Execution Summary

| Result | Count |
|---|---:|
| Passed | 2 |
| Failed | 0 |
| Blocked | 2 |
| Skipped | 0 |

本次只续跑上一轮被阻断的 `E2E-009` 及其发布依赖 `GATE-005`。本地候选指纹可生成；精确候选 Windows 四格和 second-model final verdict 均尚无可接受证据。

## Run Lineage & Emergent Scenarios

- Upstream plan: [2026-07-14-schema-v3-event-sourcing-e2e-test-plan.md](../2026-07-14-schema-v3-event-sourcing-e2e-test-plan.md)
- Upstream run: [e2e-run-schema-v3-event-sourcing-20260714](../e2e-run-schema-v3-event-sourcing-20260714/execution-report.md)
- Downstream: none
- Status: open

| Emergent scenario | Source trigger | Risk family | Plan section to update | Status |
|---|---|---|---|---|
| EM-003 pre-commit candidate fingerprint | exact-diff CI requires a stable comparison target before commit authorization | release identity | Oracle 8 / Oracle 13 | accepted |
| EM-004 W06 real crash recovery | completion audit found the former W06 used only synthetic stale directories | Windows lock recovery | W06 | closed: real owner crash, stale reaper, and two concurrent recovery contenders now pass |

## Environment State Ledger

- Target: local source CLI and GitHub Actions metadata, local/test run.
- Datasource: repository working tree plus GitHub `hex1n/taskloop` Actions run metadata.
- Deployment/freshness evidence: local `HEAD=7dd7d3473e587c8b13a8619a4f5359150fade6e6`; schema-v3 implementation remains a dirty working tree; candidate digest is recorded in `attachments/release-candidate-manifest.json`.
- Isolation namespace: `schema-v3-release-gates-20260714`.
- Created data: one candidate manifest and one read-only GitHub run preflight receipt.
- Cleanup policy: preserve traces; delete only this rerun directory if explicitly requested.
- Remaining traces: this report, script, and two JSON attachments.
- Tool permissions: local filesystem/process/read-only Git and authenticated read-only GitHub queries available; commit/push/workflow trigger authority not inferred.

## Run Metadata

| Field | Value |
|---|---|
| Run kind | local/test release-gate continuation |
| Selected scenarios | `E2E-009`, `GATE-005`, candidate fingerprint prerequisite |
| Baseline | `7dd7d3473e587c8b13a8619a4f5359150fade6e6` |
| Branch | `main` |
| Node | `/opt/homebrew/bin/node`, `v26.0.0` |
| GitHub CLI | authenticated as `hex1n`; read-only queries used |
| Retention | preserve traces |

## Environment & Capability Map

| Capability | Status | Evidence |
|---|---|---|
| enumerate exact local candidate files | available | candidate manifest script |
| query GitHub Actions metadata | available | `github-run-preflight.json` |
| create an exact release commit | blocked | no commit authorization; working tree is dirty |
| run exact candidate on Windows 2022/2025 × Node 22/24 | blocked | candidate has no Git head SHA |
| obtain Fable final verdict | blocked | prior deep attempt reached budget without final result; automatic retry prohibited |
| local W01–W08 selection and full regression | available | continuation attachments: W 8 pass/1 platform skip; npm 168 pass; verify-full 168/168 |

## DAG Schedule

| Node | Scenario | Depends on | Decision | Result |
|---|---|---|---|---|
| R0 | environment/read-only remote preflight | upstream report | execute first | passed |
| R1 | pre-commit candidate fingerprint | R0 | execute locally | passed |
| R1a | strengthened W06 + local release prerequisites | R1 | isolate W cases, then serialize full gates | passed |
| R2 | E2E-009 exact Windows matrix | authorized immutable Git revision | do not substitute baseline CI | blocked |
| R3 | GATE-005 second-model closing | R2 + frozen release commit + explicit retry | do not reuse inconclusive attempt | blocked |

## Scenario Results

| Scenario | Status | Expected | Actual | Diagnosis | Issue | Evidence / scene |
|---|---|---|---|---|---|---|
| RELEASE-FP | passed | deterministic pre-commit file/digest receipt excluding user-owned paths | manifest generated from current candidate | none | — | [RELEASE-FP](#release-fp--candidate-fingerprint) |
| LOCAL-GATES | passed | strengthened W06, local W selection, npm test, verify-full are green | W 8 pass/1 W01 skip; npm 168 pass; verify-full 168/168 | none | — | [LOCAL-GATES](#local-gates--w06-and-full-regression) |
| E2E-009 | blocked | four exact-candidate Windows cells pass W01–W08 | latest remote success is baseline SHA, not candidate | environment | — | [E2E-009](#e2e-009--exact-windows-matrix) |
| GATE-005 | blocked | final second-model GO on frozen release commit, then no material edit | no release commit; Fable attempt has no final result | tooling | — | [GATE-005](#gate-005--second-model-closing) |

## Evidence & Failure Scenes

### RELEASE-FP — candidate fingerprint

- Probe: `node docs/e2e-test/schema-v3-event-sourcing/e2e-rerun-release-gates-20260714/scripts/capture-release-candidate.mjs`.
- Expected: include all tracked changes and relevant untracked artifacts; exclude `output/`, `tmp/`, retained nested fixture, and the self-referential manifest.
- Actual: see [release-candidate-manifest.json](attachments/release-candidate-manifest.json) for entry-level byte counts and SHA-256 values.
- Created identifiers: `candidate_digest` in the manifest.
- Re-query: rerun the probe and compare `candidate_digest`; a changed value means the candidate changed.
- Cleanup safety: attachment is read-only evidence; no repository state was mutated beyond this self-owned run directory.

### E2E-009 — exact Windows matrix

- Probe: `gh run list --limit 10 --json databaseId,headSha,headBranch,status,conclusion,workflowName,createdAt,url`.
- Expected: a `test` run whose `headSha` identifies the exact release candidate and whose four Windows cells pass W01–W08.
- Actual: the newest successful run is SHA `7dd7d3473e587c8b13a8619a4f5359150fade6e6`, while the schema-v3 candidate is uncommitted and has no head SHA.
- Raw output: [github-run-preflight.json](attachments/github-run-preflight.json) and the queried [remote-workflow-baseline.yml](attachments/remote-workflow-baseline.yml). The remote baseline still has the pre-candidate Windows steps, so it cannot exercise the local W01–W08 selection.
- Created identifiers: none; query is read-only.
- Re-query: after an authorized push, query the run by the new release SHA and inspect every Windows matrix job.
- Cleanup safety: no workflow was triggered.

### LOCAL-GATES — W06 and full regression

- Probe: `node docs/e2e-test/schema-v3-event-sourcing/e2e-rerun-release-gates-20260714/scripts/run-local-release-prereqs.mjs`.
- Expected: real crashed lock owner and stale reaper recover without overlapping ownership; all local W cases and complete regression remain green.
- Actual raw summary:

```text
[W06] task lock recovers a crashed owner and crashed reaper without double ownership: pass
W selection: tests 9, pass 8, fail 0, W01 Windows-only skip 1
npm test: tests 175, pass 168, fail 0, Windows-only skip 7
verify-full: tests 168, pass 168, fail 0, skip 0
```

- Raw output: [windows-cases-local.json](attachments/windows-cases-local.json), [npm-test.json](attachments/npm-test.json), [verify-full.json](attachments/verify-full.json), [local-prereq-summary.json](attachments/local-prereq-summary.json).
- Created identifiers: isolated temporary process IDs only; test teardown removed their repositories.
- Re-query: rerun the probe command above.
- Cleanup safety: only self-owned continuation attachments remain.

### GATE-005 — second-model closing

- Probe: prior run's Fable receipt [fable-closing-attempt.json](../e2e-run-schema-v3-event-sourcing-20260714/attachments/fable-closing-attempt.json).
- Expected: `GO` on the same frozen release commit that passed the Windows matrix, followed by no material edit.
- Actual: no release commit exists; the working-tree Fable attempt exhausted its configured budget after 12 turns without a final result.
- Created identifiers: prior attempt usage receipt only.
- Re-query: after R2 passes, explicitly launch one final second-model review against the frozen release SHA.
- Cleanup safety: review was read-only.

## Failures / Defects / Plan Gaps

| ID | Type | Disposition | Detail | Close condition |
|---|---|---|---|---|
| GAP-001 | environment/release identity | CONDITIONAL | exact candidate has no Git SHA, so no four-cell Windows receipt can exist | authorized immutable revision followed by all four Windows jobs green |
| GAP-003 | review/tooling | CONDITIONAL | automatic Fable retry is prohibited and Oracle 13 requires the final release commit | after GAP-001 closes, explicitly run second-model closing and obtain GO with no later material edit |

No new product or plan defect was observed in this continuation.

## Completion Audit

| Oracle | Required proof | Current authoritative evidence | Verdict |
|---:|---|---|---|
| 1 | delete v3 snapshot and recover semantic equality | upstream manual E2E: semantic equality true and authority digest unchanged | proved locally |
| 2 | every public mutation reconstructable from events | upstream 8-record two-task replay plus mutation/reducer suites | proved locally |
| 3 | C01–C12 old-or-new crash semantics | upstream recovery suite 55/55 using production seams | proved locally |
| 4 | torn tail recovery; corruption/hash/sequence fail closed | production strict-read, quarantine, corruption and chain tests | proved locally |
| 5 | A01–A08 hard-cutover matrix | runtime authority guard, snapshot recovery, archive and installer failpoints | proved locally |
| 6 | HOME failure never rolls back repo | HOME projection/cursor failure and rebuild tests | proved locally |
| 7 | Hook stdout byte exact | full behavioral/hook suite in current `npm-test.json` | proved locally |
| 8 | complete npm test plus four Windows cells | npm 168 pass locally; no exact-candidate Windows four-cell receipt | **not proved** |
| 9 | fixed 10,001-record performance thresholds | upstream benchmark pass: replay 123.54ms, tail P95 0.128ms, fsync P95 4.428ms | proved on recorded host |
| 10 | no authoritative write bypass | architecture suite and assembly dependency test | proved locally |
| 11 | transcript range exactly-once and generation reset | T01–T06/runtime transcript tests, including UTF-8/CRLF/partial/replacement | proved locally |
| 12 | atomic runtime-4 installer; no runtime-3 rollback | installer 4/4 | proved locally |
| 13 | same release commit gets second-model GO, then no edit | no release commit; Fable attempt inconclusive | **not proved** |

The completion audit therefore contradicts a terminal-complete claim: Oracle 8 and 13 remain missing, while all locally decidable requirements are directly evidenced.

## Data Created & Cleanup

| Data | Owner marker | Retention | Cleanup |
|---|---|---|---|
| release candidate manifest | rerun directory path | preserve | remove this rerun directory only with explicit cleanup instruction |
| GitHub run preflight | rerun directory path | preserve | same |

No upstream fixture or user-owned `output/`/`tmp/` data was changed.

## Re-run Instructions

```sh
node docs/e2e-test/schema-v3-event-sourcing/e2e-rerun-release-gates-20260714/scripts/capture-release-candidate.mjs
node docs/e2e-test/schema-v3-event-sourcing/e2e-rerun-release-gates-20260714/scripts/run-local-release-prereqs.mjs
gh run list --limit 10 --json databaseId,headSha,headBranch,status,conclusion,workflowName,createdAt,url
```

## Next Actions for Agent

当前没有无需新授权即可执行的 OPEN action。两个缺口均为 `CONDITIONAL`：先取得 commit/push/CI 授权并冻结 release revision，Windows 四格通过后再明确启动一次 final Fable review。
