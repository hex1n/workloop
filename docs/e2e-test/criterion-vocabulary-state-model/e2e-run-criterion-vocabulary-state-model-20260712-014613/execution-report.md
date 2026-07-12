# criterion vocabulary/state model E2E 执行报告

## 执行摘要

- 结果：6 passed / 0 failed / 0 blocked / 0 skipped。
- 环境：local；临时 HOME 与三个临时 Git 仓库。
- 数据策略：保留 traces，便于审计；未触碰生产或外部服务。
- 上游计划：`docs/plans/2026-07-11-criterion-vocabulary-and-state-model.md`。
- Upstream run：无，这是首次执行。

## Run Lineage & Emergent Scenarios

| Plan | Upstream run | Downstream | Status |
|---|---|---|---|
| `docs/plans/2026-07-11-criterion-vocabulary-and-state-model.md` | none | none | passed |

未发现计划外 P0/P1 场景。

## Environment State Ledger

| Field | Value |
|---|---|
| Target | local temporary install |
| Datasource/schema | filesystem task schema v1；ledger event schema v1；无数据库 |
| Deployment/freshness evidence | installed release `f00290e75c54`；installed `info.runtime_contract=2` |
| Isolation namespace | `/private/tmp/taskloop-e2e-criterion-v1` |
| Created data | temporary HOME；default/deferred/steady Git fixtures；task state；outcomes-v1 ledger |
| Cleanup policy | preserve traces |
| Remaining traces | `/private/tmp/taskloop-e2e-criterion-v1` |
| TTL / cleanup command | 当前机器会话期；审计后可删除该单一临时根 |
| Tool permissions | local shell、Node、Git、repository CLI；无网络、DB、MQ、UI |
| Must not clean | 报告审计完成前不得清理临时根 |

## Run Metadata

| Field | Value |
|---|---|
| Started | 2026-07-11T17:46:13Z |
| Environment | local |
| Source commit | `83a5b74551b93f561f53565cdd42e2958f167d13` + 当前工作树实现 |
| Node | `v26.0.0` |
| Installed runtime | `/private/tmp/taskloop-e2e-criterion-v1/home-final/bin/taskloop.mjs` |
| Installed release | `f00290e75c54` |
| Selected scenarios | E2E-ENV, E2E-DEFAULT, E2E-DEFERRED, E2E-STEADY, E2E-HOOK, E2E-LEDGER |

## Environment & Capability Map

| Facet | Capability / gate | Evidence |
|---|---|---|
| Build/run toolchain | Node `v26.0.0`, Git, dependency-free source | preflight commands below |
| Trigger channel gates | installed CLI executable through Node; hook JSON through stdin | all three installed-runtime chains executed |
| Filesystem | temporary HOME and temporary Git repositories writable | install and task state writes succeeded |
| Runtime fingerprint | active release manifest and installed `info` | E2E-ENV raw proof |
| Logs/metrics/traces | stdout/stderr, task JSON, outcomes-v1 JSONL | retained in temporary namespace |
| Auth/network/external dependencies | not applicable | no external calls |

Environment Contract 已在首次业务触发前解析：有效“datasource”是临时文件系统根，schema 是 task v1/ledger v1，工具链是 Node v26，实际触达进程由 active release `f00290e75c54` 的稳定 shim 指向。

## DAG Schedule

```text
E2E-ENV
  ├─ E2E-DEFAULT ─┐
  ├─ E2E-DEFERRED ├─ E2E-LEDGER
  └─ E2E-STEADY ──┘
E2E-HOOK (isolated repository test adapter)
```

安装和指纹 preflight 先执行。三条 policy 链在隔离仓库串行执行，以便原始输出清晰；ledger 最后验证全部事件。Hook golden 使用仓库现有测试适配器隔离执行。

## Scenario Results

| ID | Status | Expected | Actual | Diagnosis | Issue | Evidence / scene |
|---|---|---|---|---|---|---|
| E2E-ENV | passed | runtime/skills 同 release，contract 2，journal 提交后移除 | release `f00290e75c54`，contract 2，manifest 完整，journal 不存在 | none | — | [E2E-ENV](#e2e-env) |
| E2E-DEFAULT | passed | unsatisfied open → Stop block → satisfied Stop → terminal achieved | 完全一致 | none | — | [E2E-DEFAULT](#e2e-default) |
| E2E-DEFERRED | passed | satisfied open held；unsatisfied witness；再 satisfied 后 achieved | 完全一致 | none | — | [E2E-DEFERRED](#e2e-deferred) |
| E2E-STEADY | passed | satisfied Stop 不自动关闭；显式 achieve 关闭 | 完全一致 | none | — | [E2E-STEADY](#e2e-steady) |
| E2E-HOOK | passed | PreToolUse deny、Stop block、release 字节协议固定 | repository adapter passed | none | — | [E2E-HOOK](#e2e-hook) |
| E2E-LEDGER | passed | 只读 outcomes-v1；无 gap/corruption | audit exit 0 | none | — | [E2E-LEDGER](#e2e-ledger) |

## Evidence & Failure Scenes

### E2E-ENV

Probe：

```sh
TASKLOOP_INSTALL_HOME=/private/tmp/taskloop-e2e-criterion-v1/home \
TASKLOOP_INSTALL_REPO=<repo> HOME=/private/tmp/taskloop-e2e-criterion-v1/home \
node install.mjs
HOME=/private/tmp/taskloop-e2e-criterion-v1/home \
node /private/tmp/taskloop-e2e-criterion-v1/home-final/bin/taskloop.mjs info
```

Expected：安装后的 runtime、skills 和 manifest 属于同一 release，runtime contract 为 2，提交后 journal 被移除。

Raw output：

```text
runtime: f00290e75c54
summary: 17 new, 3 update, 0 remove, 1 warning, 1 ok, 0 error
{"name":"taskloop","runtime_contract":2,"task_schema_version":1,"ledger_event_schema_version":1,"ledger_path":"/private/tmp/taskloop-e2e-criterion-v1/home-final/.taskloop/outcomes-v1.jsonl","distribution_owner":"taskloop"}
{"release_manifest_version":1,"release_id":"f00290e75c54","runtime_contract":2,"runtime_digest":"f00290e75c54","managed_skills_manifest_digest":"7553890cf62fe36ac30e977878902e9bbb5fd48d0b3722765631bb0b393e3536"}
journal_absent=true
```

Created entity identifiers：release `f00290e75c54`；temporary HOME `home-final`。Re-query：

```sh
HOME=/private/tmp/taskloop-e2e-criterion-v1/home node /private/tmp/taskloop-e2e-criterion-v1/home-final/bin/taskloop.mjs info
```

### E2E-DEFAULT

Probe：installed `open`，stdin Stop，创建 fixture `done`，再次 stdin Stop，随后 `status`。

Expected：首次 Stop block；第二次 Stop stdout 空并写入 terminal achieved。

Raw output：

```text
taskloop: opened /private/tmp/taskloop-e2e-criterion-v1/default/.taskloop/task.json; criterion unsatisfied; policy default
{"decision":"block","reason":"taskloop: criterion unsatisfied; closure not_ready(criterion_unsatisfied)"}
{"task_schema_version":1,"task_id":"f5dc063e-304f-449f-ad62-7c365d51ec17","lifecycle":{"state":"terminal","outcome":"achieved","closing_observation_id":"7333fd77-4d70-408b-b876-ef373c5bf800","provisional":false}}
```

Created entity identifiers：task `f5dc063e-304f-449f-ad62-7c365d51ec17`；observation `7333fd77-4d70-408b-b876-ef373c5bf800`。Re-query：

```sh
HOME=/private/tmp/taskloop-e2e-criterion-v1/home node /private/tmp/taskloop-e2e-criterion-v1/home-final/bin/taskloop.mjs status --repo /private/tmp/taskloop-e2e-criterion-v1/default
```

### E2E-DEFERRED

Probe：installed deferred-witness open；`achieve` satisfied；删除 dedicated fixture `done` 后 `achieve`；重新创建后 `achieve`。

Expected：先 hold，随后取得 unsatisfied witness，最后 achieved。

Raw output：

```text
taskloop: opened /private/tmp/taskloop-e2e-criterion-v1/deferred/.taskloop/task.json; criterion satisfied; policy deferred-witness
taskloop: criterion satisfied; closure held(unsatisfied_not_witnessed)
taskloop: criterion unsatisfied; closure not_ready(criterion_unsatisfied)
taskloop: terminal(achieved); criterion satisfied; not covered: none
{"task_id":"f2d8aae7-ff31-419d-9195-2d800f39a55e","lifecycle":{"state":"terminal","outcome":"achieved"},"policy":{"open_requirement":"determinate","witness_requirement":"required","close_policy":"automatic"}}
```

Created entity identifiers：task `f2d8aae7-ff31-419d-9195-2d800f39a55e`。Re-query：

```sh
HOME=/private/tmp/taskloop-e2e-criterion-v1/home node /private/tmp/taskloop-e2e-criterion-v1/home-final/bin/taskloop.mjs status --repo /private/tmp/taskloop-e2e-criterion-v1/deferred
```

### E2E-STEADY

Probe：installed steady-satisfied open；stdin Stop；显式 `achieve`。

Expected：Stop block 且仍 active；achieve terminal。

Raw output：

```text
taskloop: opened /private/tmp/taskloop-e2e-criterion-v1/steady/.taskloop/task.json; criterion satisfied; policy steady-satisfied
{"decision":"block","reason":"taskloop: criterion satisfied; closure eligible; explicit achieve required"}
taskloop: terminal(achieved); criterion satisfied; not covered: none
```

Created entity identifiers：steady repository task state。Re-query：

```sh
HOME=/private/tmp/taskloop-e2e-criterion-v1/home node /private/tmp/taskloop-e2e-criterion-v1/home-final/bin/taskloop.mjs status --repo /private/tmp/taskloop-e2e-criterion-v1/steady
```

### E2E-HOOK

Probe：

```sh
node --test --test-name-pattern='hook contract is byte-exact' tests/taskloop.test.mjs
```

Expected：PreToolUse deny、Stop block、allow/release 与 contract 2 golden 完全一致。

Raw output：

```text
✔ hook contract is byte-exact for deny, block, and release
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

Created entity identifiers：测试适配器隔离临时仓库（测试退出时自动清理）。Re-query：同一 probe command。

### E2E-LEDGER

Probe：

```sh
HOME=/private/tmp/taskloop-e2e-criterion-v1/home node /private/tmp/taskloop-e2e-criterion-v1/home-final/bin/taskloop.mjs audit
```

Expected：只读取 `outcomes-v1.jsonl`，事件 schema/task schema 均为 1，序列连续，无 corruption。

Raw output：

```text
{"file":"/private/tmp/taskloop-e2e-criterion-v1/home-final/.taskloop/outcomes-v1.jsonl","exit":0}
first_event={"event_schema_version":1,"task_schema_version":1,"task_event_sequence":1,"kind":"task_opened"}
default_terminal={"task_revision":2,"task_event_sequence":2,"kind":"task_terminal","payload":{"outcome":"achieved"}}
```

Created entity identifiers：ledger tasks 与上述三个 task 对应。Re-query：同一 audit command。

## Failures / Defects / Plan Gaps

无 `OPEN`、`CONDITIONAL` 或 `BLOCKED-BY-TOOLING` 项。安装器输出的 Codex writable-root warning 属于临时 HOME 未请求 `--configure-codex` 的预期提示，不影响本地 CLI E2E，disposition=`CLOSED`。

## Data Created & Cleanup

| Entity | Owner marker | Retention | TTL | Cleanup |
|---|---|---|---|---|
| temporary HOME/runtime/skills/ledger | `taskloop-e2e-criterion-v1` | preserve traces | 当前机器会话期 | 删除单一临时根 |
| default/deferred/steady fixtures | scenario directory name | preserve traces | 当前机器会话期 | 删除单一临时根 |

没有生产数据、共享测试数据或外部副作用。由于数据仅是临时文件系统 fixture，未另建 seed/cleanup 脚本；创建命令和 re-query 已完整记录。

## Re-run Instructions

```sh
npm test
TASKLOOP_INSTALL_HOME=<fresh-temp-home> TASKLOOP_INSTALL_REPO=<repo> HOME=<fresh-temp-home> node install.mjs
HOME=<fresh-temp-home> node <fresh-temp-home>/bin/taskloop.mjs info
node --test --test-name-pattern='CLI default chain|CLI deferred-witness chain|CLI steady-satisfied|CLI suspend|incompatible state archival|hook contract is byte-exact' tests/taskloop.test.mjs
```

## Next Actions for Agent

无 OPEN actionable root cause。
