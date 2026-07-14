# Schema v3 全事件溯源端到端测试计划

## Overview

- 范围：runtime contract 4 的 repo authority、快照恢复、全部 mutation、transcript 计费、HOME 投影、安装器、并发/崩溃和性能。
- 旅程：`J1–J10`；场景：`E2E-001–E2E-010`；Core Slice 为 `E2E-001–E2E-008`，Windows 与性能为发布扩展切片。
- 最高风险：双权威、已提交事件被快照失败回滚、transcript 重复计费、并发丢写、旧 runtime 回滚读取 v3。
- 执行数据：仅在本地临时仓库/HOME 和本计划同目录的 run 目录中创建；默认保留报告、命令和关键状态转储，测试 harness 自清理的临时 fixture 不作为诊断依赖。
- 已知门禁：四组真实 Windows runner 只能由 `.github/workflows/test.yml` 验证；本机执行只能验证跨平台逻辑及 W08 注入矩阵。

## 1. Source Inventory

| Source | Authority / receipt | Used for |
|---|---|---|
| `docs/plans/2026-07-14-schema-v3-event-sourcing.md` | 冻结 SHA-256 `7989bdbd061165efb23618a52c7819d61db29d9449a2549ea2b24508ca1dfcf0` | A/C/R/T/W/P Oracle、hard cutover 与回滚边界 |
| `lib/application.mjs` | `loadV3Authority`, `commitTaskCommand`, `transcriptRange`, CLI dispatch | 生产命令、Hook、事务编排、authority discriminator |
| `lib/event-store.mjs` | `buildRecord`, `commitRecord`, `readEventStore`, `auditEventStore` | JSONL framing、SHA-256 链、fsync、tail recovery、audit |
| `lib/task-engine.mjs` | `decide`, `evolve`, `evolveAll`, `assertV3TaskProjection` | 纯命令决策、事件归约、schema-v3 约束 |
| `lib/task-store.mjs` | snapshot、archive、task lock | disposable snapshot、raw archive、并发互斥 |
| `lib/outcome-projector.mjs` | `syncOutcomeRecords`, `auditOutcomeProjection` | HOME best-effort projection、去重、重建 |
| `install.mjs` | runtime 4 manifest/journal/shim activation | 原子安装、failpoint 收敛、拒绝 contract 3 rollback |
| `tests/fixtures/runtime-contract-4.mjs` | 冻结外部和 persisted contract | 精确版本、字段、错误与 benchmark receipt |
| `tests/fixtures/event-store-cases-v3.json` | A01–A08、C01–C12、R01–R08、T01–T06、W01–W08 | 验收 ID 完整性 |
| `tests/event-store.test.mjs` / `tests/task-snapshot-v3.test.mjs` | 生产模块 crash/corruption/replay harness | 存储与恢复证据 |
| `tests/runtime-v4.test.mjs` / `tests/taskloop.test.mjs` | 真实 CLI/Hook 子进程 | 公开 mutation、Hook、transcript、投影、并发 |
| `tests/installer.test.mjs` / `.github/workflows/test.yml` | installer failpoints 与固定 OS/Node 矩阵 | 激活与 Windows 发布门禁 |

### Document-Code Semantic Diff

| Contract | Document says | Current code behavior | Delta / risk | Resolution |
|---|---|---|---|---|
| 单一权威 | `events-v3.jsonl` 唯一权威 | `commitTaskCommand` 先 commit+fsync，再 evolve/snapshot | none | E2E-001/002/003 |
| v2 hard cutover | 不迁移、不双读、不支持 runtime 3 rollback | v2 reader/writer 与 `outcome-ledger.mjs` 已从生产删除；legacy 仅判别/原始归档 | none | E2E-004/007 |
| transcript | cursor 与 tally 在同一事务；UTF-8 byte range | `Buffer` offset、完整 LF、anchor generation、tally event | none | E2E-005 |
| outcome | HOME 失败不回滚 repo；可重建无重复 | repo commit 后 best-effort projector；`sync-outcomes` 去重 | none | E2E-006 |
| Windows W08 | 只允许枚举的 unsupported code 降级 | open=`EISDIR|EPERM`，fsync=`EINVAL|EPERM`；其他 fail closed | 真实 code 需 Windows CI 证明 | E2E-009 / GAP-001 |
| 发布评审 | 同一 release diff 获 second-model GO，之后无 material edit | 尚待 closing review | open gate | GATE-004 |

## 2. Business Flow Diagram + Journey Graph

```mermaid
flowchart TD
  U[CLI / Hook] -->|J1 acquire| L[repo task lock]
  L -->|J2 discriminate| A{v3 authority valid?}
  A -->|empty + open| D[decide]
  A -->|valid| R[replay / snapshot tail]
  A -->|legacy/orphan/mixed/corrupt| F[fail closed / explicit raw archive]
  R --> D
  D -->|J3 events[]| C[append record + fsync]
  C -->|J4 committed| E[evolve projection]
  E -->|J5 best effort| S[task.json snapshot]
  C -->|J6 best effort| O[outcomes-v3 projection]
  S -->|delete/damage| R
  O -->|delete/cursor damage| Y[sync-outcomes replay]
  C -->|J7 audit| Q[hash/sequence/schema report]
  I[installer journal] -->|J8 atomic activation| U
  T[transcript bytes] -->|J9 baseline/increment range| D
  P[20 processes / crash child / benchmark] -->|J10 stress| L
```

| Edge | Consumes | Produces / side effect | Source receipt |
|---|---|---|---|
| J1 | repo path, mutation | `.taskloop/.task.lock` ownership | `withTaskLock` |
| J2 | event store + optional snapshot | current projection or typed fail-closed error | `loadV3Authority` |
| J3 | state + command | exact domain event array | `decide` |
| J4 | sequenced events | one hash-chained JSONL record, file fsync receipt | `commitTaskCommand`, `commitRecord` |
| J5 | committed source cursor + projection | digest-checked disposable snapshot or warning | `buildTaskSnapshot`, `saveTaskSnapshot` |
| J6 | committed record | outcome rows/cursor or stderr warning | `syncOutcomeRecords` |
| J7 | authority bytes | structured valid/invalid audit | `auditEventStore` |
| J8 | staged runtime/skills | stable shim + manifest at one release | installer journal tests |
| J9 | transcript complete bytes + prior cursor | baseline/increment tally event | `transcriptRange` |
| J10 | contention/failpoint/fixed data | serialization, recovery, latency receipt | event-store/runtime/benchmark harnesses |

## 3. Agent Execution Contract

- **Target surfaces**: `node bin/taskloop.mjs`, Hook stdin JSON, `.taskloop/events-v3.jsonl`, `.taskloop/task.json`, temporary HOME `outcomes-v3.jsonl`, `install.mjs`, existing Node test/benchmark harnesses. `confirmed by source`.
- **Fixtures**: self-owned Git repo + HOME under a run directory; checked-in deterministic event generator; installer temporary HOME. `confirmed by source`.
- **Named variables**: `RUN_DIR`, `REPO`, `HOME_DIR`, `EVENT_STORE`, `SNAPSHOT`, `TASK_ID`, `REPO_SEQUENCE`, `EVENT_DIGEST`, `PLAN_SHA`. Values must be recorded in the execution report.
- **Probes/Oracles**: CLI exit/stdout/stderr; `audit --repo`; raw JSONL lines; snapshot projection; `sync-outcomes` counts; test TAP summary; benchmark JSON receipt.
- **Waits**: CLI 30s; suite 120s; installer 120s; benchmark 120s; 20-process contention 30s; no blind sleep.
- **Cleanup**: preserve the run directory and all report evidence. Existing tests may clean their isolated `os.tmpdir()` fixtures after assertions. Manual fixture is additive-retained with owner marker `schema-v3-e2e-20260714`; cleanup script/command is recorded but not run by default.
- **Blockers/Gaps**: actual `windows-2022/windows-2025 × Node 22/24` requires GitHub-hosted Windows runners; current local host cannot supply that runtime fact.

Required capabilities: Node ≥22, Git, writable workspace/temp/HOME, child-process termination, file fsync. Optional probes: GitHub Actions run URL/artifacts and Windows directory-fsync code.

## 4. Risk Map

| Risk family | Failure mode | Scenarios |
|---|---|---|
| Main/alternate path | open→mutate→terminal and new task history incomplete | E2E-001/002 |
| Consistency/recovery | snapshot loss or failure changes semantic state | E2E-003 |
| Invalid/mixed state | v2/orphan/mixed/corrupt authority is overwritten or trusted | E2E-004 |
| Idempotency | transcript retry/replacement double bills | E2E-005 |
| External projection | HOME failure rolls back repo or rebuild duplicates | E2E-006 |
| Deployment/rollback | installer interruption mixes releases or accepts contract 3 | E2E-007 |
| Concurrency/crash | lost mutation, half record, un-reapable stale lock | E2E-008 |
| Cross-platform | Windows path/rename/fsync behavior diverges | E2E-009 |
| Performance | replay/tail/fsync exceeds frozen threshold | E2E-010 |
| Observability | corrupt authority has no structured diagnosis | E2E-004/006 |

## 5. Scenario Inventory

| Scenario | Group | Priority | Slice | Risk/Purpose | Probe/Oracle | Edges | Channel | Side-effect Class | Data policy | Related issue |
|---|---|---:|---|---|---|---|---|---|---|---|
| E2E-001 | authority | P0 | Core Slice | 原生 v3 genesis 与版本握手 | info=4/3/1/3；首 record 为 `task_opened`；删 snapshot 可恢复 | J1–J5 | CLI/files | additive-retained | preserve | — |
| E2E-002 | lifecycle | P0 | Core Slice | 所有公开 mutation 可重放 | event kinds/sequence 连续；终态后新 task 仍可恢复 | J1–J5 | CLI/Hook | additive-retained | preserve | — |
| E2E-003 | recovery | P0 | Core Slice | crash/snapshot/torn-tail 原子性 | 仅完整旧/新状态；tail quarantine；内部损坏 fail closed | J2–J5,J7,J10 | harness/files | external-file | preserve | — |
| E2E-004 | cutover | P0 | Core Slice | legacy/orphan/mixed/corrupt 判别 | A01–A08；event bytes 不被 archive 改写 | J2,J7 | CLI/files | external-file | preserve | — |
| E2E-005 | transcript | P0 | Core Slice | exactly-once range tally | UTF-8/CRLF/半行、retry、replacement generation 均符合 T01–T06 | J9,J3,J4 | Hook/files | additive-retained | preserve | — |
| E2E-006 | outcome | P1 | Core Slice | HOME degrade-open 与重建 | repo commit 保留；delete/sync added 精确且无 duplicate | J6,J7 | CLI/HOME | external-file | preserve | — |
| E2E-007 | installer | P0 | Core Slice | 原子激活、禁止 contract 3 rollback | 所有 failpoint rerun 收敛；旧 source 非零拒绝 | J8 | CLI/files | external-file | harness cleanup | — |
| E2E-008 | concurrency | P0 | Core Slice | 20 mutation、stale lock、crash | repo sequence 1..21；20 writes；aged lock/reaper 恢复 | J1,J10 | child processes | additive-retained | preserve | — |
| E2E-009 | Windows | P0 | Extended Slice | W01–W08 四组合 | CI 四组合全绿且 W08 code 在 allowlist | J1–J10 | GitHub Actions | external-file | CI artifact | — |
| E2E-010 | performance | P1 | Extended Slice | P receipt | 3×replay <200ms；tail P95<5ms；fsync P95<20ms | J10 | benchmark | external-file | preserve receipt | — |

## 6. Detailed Scenario Cards

### E2E-001 — v3 genesis 与可删除快照

**Index**: `N1` · P0 · additive-retained · GATE-001  
**Purpose/Risk**: 证明只有 event store 是 authority。  
**Sources**: plan Oracle 1/2；`commitTaskCommand`; `runtime-v4.test.mjs`.  
**Edges**: J1–J5.  
**Setup**: 新 Git repo、独立 HOME、unsatisfied criterion。  
**Steps**: `info` → `open` → `audit` → 保存 status → 删除 snapshot → 再次 status。  
**Expected**: 契约 4/3/1/3；一条 genesis；恢复前后语义相同；event bytes 不变。  
**Automation**: E2E CLI.  
**Isolation/Cleanup**: run fixture retained；只允许 cleanup 脚本删除自有目录。

### E2E-002 — mutation 与多任务历史

**Index**: `N2` · P0 · additive-retained · GATE-001  
**Purpose/Risk**: 防止 mutation 绕过 event authority。  
**Sources**: plan Oracle 2/10；`decide/evolve`; CLI runtime suite.  
**Edges**: J1–J5.  
**Setup**: active task 和 owner session。  
**Steps**: Hook write → suspend → resume → review → amend → terminal → open new task。  
**Expected**: 每次 mutation 只增加一个 transaction record；同 task event sequence 连续；新 task sequence 从 1 开始；重放投影等于 snapshot。  
**Automation**: E2E CLI/Hook.

### E2E-003 — crash、tail 与 snapshot recovery

**Index**: `N3` · P0 · external-file · GATE-002  
**Purpose/Risk**: 防半事务和权威证据丢失。  
**Sources**: C01–C12、R01–R08；crash child harness。  
**Edges**: J2–J5,J7,J10.  
**Setup**: deterministic record files；仅在专用 fixture 注入 seam。  
**Steps**: 运行 event-store 与 snapshot production suites。  
**Expected**: partial tail 先 quarantine 后 truncate；内部 corruption 不改原文件；post-fsync snapshot failure 恢复新状态。  
**Automation**: chaos/recovery.

### E2E-004 — hard cutover authority matrix

**Index**: `N4` · P0 · external-file · GATE-001  
**Purpose/Risk**: 防自动迁移或双权威。  
**Sources**: A01–A08；`loadV3Authority`; archive tests。  
**Edges**: J2,J7.  
**Setup**: 专用 legacy/orphan/mixed/corrupt fixture。  
**Steps**: 对每类状态运行 status/mutation/archive/audit。  
**Expected**: typed fail closed；只有 user-authorized raw archive 可移动 snapshot；event digest 不变。  
**Automation**: E2E/contract.

### E2E-005 — transcript cursor transaction

**Index**: `N5` · P0 · additive-retained · GATE-001  
**Purpose/Risk**: 防 crash/retry/replace 重复计费。  
**Sources**: T01–T06；`transcriptRange`; Hook tests。  
**Edges**: J9,J3,J4.  
**Setup**: UTF-8、CRLF、末尾半行 transcript；小 token budget。  
**Steps**: baseline → complete partial row → retry → replacement → append。  
**Expected**: byte offset 精确；baseline delta=0；retry 无新 tally；replace 新 generation 且 delta=0。  
**Automation**: E2E Hook.

### E2E-006 — outcome projection degrade-open

**Index**: `N6` · P1 · external-file · GATE-001  
**Purpose/Risk**: 防 HOME 失败影响 repo correctness。  
**Sources**: C11；outcome projector；runtime v4 tests。  
**Edges**: J6,J7.  
**Setup**: 独立 HOME；可删除 projection/cursor。  
**Steps**: commit → sync twice → delete projection → sync → audit；注入 HOME 写失败由生产调用 catch 验证。  
**Expected**: repo sequence 不回滚；重复 sync `added=0`；删除后精确重建；audit 无 duplicate。  
**Automation**: E2E CLI.

### E2E-007 — installer atomic activation

**Index**: `N7` · P0 · external-file · GATE-003  
**Purpose/Risk**: 防 runtime/skills/shim 混装与旧 rollback。  
**Sources**: installer journal/failpoint tests。  
**Edges**: J8.  
**Setup**: `TASKLOOP_INSTALL_HOME` 临时 HOME。  
**Steps**: 正常安装；逐 failpoint 中断与 rerun；contract-3 source probe。  
**Expected**: stable shim 只指完整 release；manifest/journal 收敛；contract 3 source 非零退出。  
**Automation**: E2E installer.

### E2E-008 — concurrency 与 stale lock

**Index**: `N8` · P0 · additive-retained · GATE-002  
**Purpose/Risk**: 防丢写和 crash 后永久锁死。  
**Sources**: W05/W06；runtime/architecture tests。  
**Edges**: J1,J10.  
**Setup**: write budget 20；20 Node children；aged dead-owner lock/reaper。  
**Steps**: 并发 20 Hook writes；读取 authority；构造 stale locks 后执行 mutation lock。  
**Expected**: 21 records、repo sequence 连续、20 write events、spent=20；stale lock/reaper 消失且 callback 恰执行一次。  
**Automation**: concurrency/chaos.

### E2E-009 — Windows W01–W08

**Index**: `N9` · P0 · external-file · GATE-004  
**Purpose/Risk**: 证明 Windows 文件/进程语义。  
**Sources**: frozen W matrix；workflow fixed matrix。  
**Edges**: J1–J10.  
**Setup**: GitHub-hosted Windows 2022/2025 × Node 22/24。  
**Steps**: 运行 workflow 的 bounded W01–W08 step。  
**Expected**: 四组合全绿；真实 `directory_fsync` 为 `supported` 或 frozen `unsupported:<code>`；无 `continue-on-error`。  
**Automation**: CI E2E.  
**Isolation/Cleanup**: runner disposable；保留 CI logs/artifacts。

### E2E-010 — fixed performance receipt

**Index**: `N10` · P1 · external-file · GATE-002  
**Purpose/Risk**: 防全量 replay/append 退化。  
**Sources**: P thresholds；benchmark fixture。  
**Edges**: J10.  
**Setup**: 当前 Node/OS/CPU/filesystem 记录在 receipt。  
**Steps**: `npm run bench:event-store -- --json`。  
**Expected**: 10,001 records；三次 replay 均 <200ms；tail P95<5ms；fsync P95<20ms；exit 0。  
**Automation**: load/performance.

## 7. Execution DAG

| Node | Scenario | Depends on | Consumes | Produces | Parallel safety / isolation |
|---|---|---|---|---|---|
| N0 | preflight | — | repo/toolchain | environment contract | read-only |
| N1 | E2E-001 | N0 | manual fixture | TASK_ID, genesis digest | isolated repo |
| N2 | E2E-002 | N1 | active task | lifecycle event chain | same repo, serialized |
| N3 | E2E-003 | N0 | checked-in harness | crash/recovery TAP | isolated temp fixtures |
| N4 | E2E-004 | N0 | authority fixtures | error/archive receipts | isolated temp fixtures |
| N5 | E2E-005 | N1 | transcript + task | cursor generations | same repo, serialized |
| N6 | E2E-006 | N1 | records + HOME | projection audit | same HOME, serialized |
| N7 | E2E-007 | N0 | installer source | activation TAP | isolated install HOME |
| N8 | E2E-008 | N0 | runtime harness | concurrency/stale lock TAP | isolated/disruptive |
| N9 | E2E-009 | N0 | GitHub runners | four CI results | remote isolated |
| N10 | E2E-010 | N3 | production modules | benchmark receipt | run alone |
| N11 | full gates | N1–N8,N10 | release tree | npm/verify summaries | serialized final |

## 8. Executor Handoff Index

| Selection | Nodes | Command / adapter | Entry gate | Stop rule |
|---|---|---|---|---|
| Local core | N0–N8 | production CLI + checked-in Node suites | GATE-001–003 | any missing raw evidence blocks pass |
| Performance | N10 | `npm run bench:event-store -- --json` | local fsync available | any threshold false |
| Full local | N11 | `npm test`; `node tests/verify-full.mjs` | prior nodes pass | 0 failures |
| Windows release | N9 | GitHub Actions fixed matrix | authorized remote CI run | all four combinations pass |

### Agent-ready Gates

- **GATE-001**: Node/Git/writable repo+HOME and production CLI available.
- **GATE-002**: child processes, termination and fsync available.
- **GATE-003**: writable isolated `TASKLOOP_INSTALL_HOME`; no real user install path.
- **GATE-004**: GitHub-hosted Windows matrix run exists for the exact release diff; otherwise E2E-009 is blocked, not passed.
- **GATE-005**: second-model closing review is run only after all material edits and local reruns.

### Coverage Matrix

| Requirement | Coverage |
|---|---|
| Oracle 1–2 / single authority and all mutations | E2E-001/002 |
| C01–C12 / R01–R08 | E2E-003 |
| A01–A08 | E2E-004/007 |
| T01–T06 | E2E-005 |
| C11 / HOME projection | E2E-006 |
| concurrency/stale locks | E2E-008 |
| W01–W08 four combinations | E2E-009 |
| P thresholds | E2E-010 |
| Hook stdout / full regression | N11 |
| exact release second-model GO | GATE-005 |

### Gaps and Dispositions

| Gap | Disposition | Close condition |
|---|---|---|
| GAP-001 actual Windows four-combination evidence unavailable locally | CONDITIONAL | exact diff runs green on all workflow matrix cells |
| GAP-002 real power loss, NFS/SMB and multi-host concurrency | OUT-OF-SCOPE | requires a new storage/lock decision envelope |
| GAP-003 second-model release review pending | OPEN until final local evidence | closing review returns GO and no later material edit |

