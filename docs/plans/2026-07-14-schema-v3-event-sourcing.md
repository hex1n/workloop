# Schema v3 + 全事件溯源实施计划

日期：2026-07-14  
仓库基线：`7dd7d3473e587c8b13a8619a4f5359150fade6e6`  
模式：Plan  
深度：Deep  
输入来源：当前计划、`lib/application.mjs`、`lib/task-store.mjs`、`lib/task-engine.mjs`、`package.json`、`.github/workflows/test.yml`、installer/Windows 测试、上一轮 Fable 5 审查  
状态：实施候选计划；用户已决定 BUILD，但尚未授权写代码

## TL;DR

可以实施。当前最佳方案是：

1. `.taskloop/events-v3.jsonl` 成为 repo-local 唯一权威；
2. `.taskloop/task.json` 变为可删除、可重建的 schema-v3 当前任务快照；
3. `~/.taskloop/outcomes-v3.jsonl` 变为可重放、best-effort 的全局投影；
4. runtime contract 4 采用一次性 hard cutover：不迁移 v2、不提供 v2/v3 双模式、不支持降级到 runtime contract 3；
5. transcript 消费区间和 cursor 进入同一权威事件事务，不再维护独立 cursor sidecar；
6. 保持 dependency-free Node、现有 repo lock、Hook stdout 字节契约和 HOME 写入降级边界；
7. 预计总成本 26 人日，单工程师约 5–6 周；先交付 3–4 人日的不接管生产 CLI 的纵切，未通过崩溃门禁不得继续。

当前最便宜且能推翻方案的下一步，是实现一个只由测试直接调用、不暴露生产开关的纵切：

```text
task_opened
  → [output_tokens_tallied, write_authorized]
  → [criterion_observed, task_suspended]
  → 删除快照后完整重建
```

该纵切必须通过真实子进程崩溃、同一 transcript range 重放、尾部撕裂、内部损坏、并发提交和性能门禁。

### 最佳性检查（摘要）

- **适配条件**：单一权威、进程崩溃安全、Hook 兼容、零依赖、无 legacy 运行面、可审计失败。
- **赢家**：repo-local JSONL transaction store + pure reducer + disposable snapshot + event-derived transcript cursor。
- **最近替代**：继续以 v2 `task.json` 为权威，只修复已知时间、JSON 和 ledger 缺口。
- **击败条件**：如果完整历史重建、状态解释和多投影没有真实消费者，v2 强化会以低一个数量级的成本胜出。
- **边际停止点**：交付 hard cutover、单一权威、恢复和 outcome projection 后停止；不增加 v2 migration、通用查询、签名、远端存储或提前分段。

## 根问题

当前 task 权威是会被覆盖的 `task.json`，HOME ledger 又只记录部分事实且允许写入失败；因此无法从 genesis 解释当前裁决状态，也无法把“一个命令的多项状态变化”恢复成完整旧状态或完整新状态。目标不是“采用 JSONL”，而是让所有影响裁决的事实只有一个 repo-local 提交点，并能在 snapshot 丢失后确定性恢复。用户已明确接受 pre-v3 状态和旧 runtime 不兼容，以换取更小的状态机和更清晰的失败边界。

## 决策信封

```yaml
decision: BUILD
decision_source: 用户明确要求建设 schema-v3 + 全事件溯源，并明确放弃旧 runtime 和 v2 状态兼容
implementation_authorization: 尚未授予
target_outcome: 所有权威状态变化可从 v3 genesis 确定性重建，单命令不会留下半状态
baseline_and_frequency: 每个 mutation 当前覆盖写 task.json；HOME ledger 不完整且不可用于重建；事故频率尚未量化
expected_benefit: v3 任务从 genesis 起 100% 可重放；事务恢复结果只能是完整旧状态或完整新状态
delivery_and_maintenance_cost: 交付约 26 人日；不承担 pre-v3 兼容成本，但 v3 发布后每类破坏性事件变化仍约增加 1–2 人日的 schema、upcaster 和历史重放测试成本
status_quo_or_existing_mechanism: 继续强化 schema v2、修复时间和 JSON 输出问题
decision_flip_condition: 如果没有历史重建、状态解释或多投影的真实需求，则 v2 强化更优，应停止建设 v3 事件平台
review_scope: implementation-authorization
review_budget: 当前修订最多 1 次 Fable 5 full-depth complete-review 调用；生产切换前另行冻结发布评审预算
```

## 最终验收 Oracle

只有同时满足以下条件，才允许原子激活 runtime contract 4：

1. 删除任意 v3 `task.json` 后，重放结果与删除前语义完全一致；
2. 每个公开 mutation 都能在权威事件流中找到足以重建状态的事实；
3. 下述 C01–C12 所有注入崩溃点只产生完整旧状态或完整新状态，不出现半事务；
4. partial tail 可隔离并恢复，内部 corruption、hash-chain 错误和 sequence gap 必须 fail closed；
5. A01–A08 authority 判别矩阵全部通过：v3 event store 优先；legacy v2、孤儿 v3 snapshot 和 v2/v3 混合制品均 fail closed 且不产生 mutation；
6. HOME outcome 投影不可写或损坏时，本地任务状态仍完全正确；
7. PreToolUse 与 Stop stdout 保持字节级兼容；
8. 完整 `npm test` 全绿，且 `windows-2022/windows-2025 × Node 22/24` 四组 W01–W08 全绿；
9. 固定 10,001-record 数据集在记录环境上满足：三次 production full replay 均 `<200ms`、100 次增量尾读 P95 `<5ms`、50 次 append+fsync P95 `<20ms`；
10. 架构测试证明不存在绕过事件流的权威任务写入；
11. 同一 transcript generation 的同一区间在 crash、snapshot 丢失和命令重试后最多计费一次；文件截断或替换只开启新 generation 并建立零增量 baseline，不猜测缺失 token；
12. installer 原子激活 runtime contract 4；激活后不存在受支持的 runtime contract 3 回滚路径；
13. 同一 release commit 上的代码、测试、文档和 runtime-contract-4 fixture 获得一次 full-depth second-model `GO`，之后没有 material edit。

## 可执行证据矩阵

验证必须调用生产 `event-store`、validator、canonicalization、hash chain 和 reducer；只验证测试替身不算关闭门禁。测试 seam 只允许注入 filesystem operations 和命中通知，不允许在生产路径加入环境变量控制的 crash 分支。

### 测试资产与命令

| 资产 | 职责 | 固定入口 |
|---|---|---|
| `tests/fixtures/event-store-cases-v3.json` | Phase 0 冻结 case ID、前置状态、注入点和期望状态；不包含机器生成结果 | 由 architecture test 校验 ID 完整且无重复 |
| `tests/helpers/event-v3-fixture.mjs` | 固定 seed 生成 task/event/transcript 数据；10,001 records 不以大文件提交 | 被下述测试和 benchmark 共用 |
| `tests/helpers/event-store-crash-child.mjs` | 子进程调用生产模块，在 seam 通知后由父进程终止；不用 shell | 被 crash 和 Windows 套件调用 |
| `tests/event-store.test.mjs` | A/C/R/T 矩阵、并发、authority 和 snapshot 恢复 | `npm run test:event-store`，并纳入 `npm test` |
| `tests/event-store-benchmark.mjs` | 固定数据集的 production replay/tail/append+fsync 计时和 JSON receipt | `npm run bench:event-store -- --json` |
| `tests/windows.test.mjs` | W 矩阵；遵守现有 Windows 测试归属 | 固定 Windows workflow 的独立 bounded group |

`package.json` 新增 `test:event-store` 和 `bench:event-store`。benchmark 不进入普通 `npm test` 的共享 runner 绝对时间断言，避免硬件噪声；但 release candidate 必须显式运行并产生通过 receipt。receipt 只写 stdout，由本地保存或 CI 上传到 `tmp/taskloop-v3-evidence/` 对应 artifact，不提交机器相关结果。

### A：Authority 与 hard cutover

| ID | 输入/操作 | 期望 |
|---|---|---|
| A01 | 无 event store、无 `task.json` | 只有 `open` 可创建原生 v3 genesis；其他 task 命令报告无任务 |
| A02 | 无 event store、schema-2 `task.json` | 所有普通命令 `LEGACY_STATE_UNSUPPORTED`；只有用户授权的 raw-byte archive 可运行，随后 `open` 创建全新 v3 task |
| A03 | 无 event store、schema-3 `task.json` | `ORPHAN_V3_SNAPSHOT` fail closed；snapshot 不得提升为 authority，只有用户授权的 raw-byte archive 可解除阻塞 |
| A04 | 有效 event store、无/无效/落后 snapshot | 分别从 genesis 或 source cursor 恢复；task A snapshot + committed task B 使用 R06 规则 |
| A05 | 有效 event store、schema-2/未知 snapshot side artifact | 普通命令 `MIXED_OR_INVALID_AUTHORITY`；授权 archive 只移动 `task.json`，event store 字节不变，随后恢复 v3 snapshot |
| A06 | 损坏 event store、任意 snapshot | `CORRUPT_EVENT_AUTHORITY`；不读 snapshot 作为 fallback，不允许 archive 命令移动 event store |
| A07 | unsupported 旧进程在 v3 snapshot 缺失时留下 schema-2 `task.json` | v4 命中 A05，event store digest 不变；不得形成自动双权威 |
| A08 | installer 在 runtime staged、skills activated、shim activated、manifest committed 任一 failpoint 中止 | stable shim 最终只指向一个完整 release；恢复后只能是完整旧激活或完整 runtime-4 激活，不支持 runtime-3 rollback 读取 v3 |

### C：提交与进程崩溃

| ID | 注入点 | 必须观察到的结果 |
|---|---|---|
| C01 | genesis 临时文件创建前 | event store 不存在，repo 仍为空 |
| C02 | genesis 临时文件 short write 或中途终止 | authority 文件不存在；残留 temp 不是 authority，可保留诊断后清理 |
| C03 | genesis temp `fsync` 后、rename 前 | 与 C02 相同；不得从 temp 恢复任务 |
| C04 | genesis rename 后、目录同步前 | 进程崩溃恢复时只能看到完整新 genesis；不声称覆盖真实断电 |
| C05 | 已有 store append 第一字节前 | 完整旧状态 |
| C06 | append 返回 short write、零推进或异常 | 命令失败；只有 partial tail，恢复为旧状态 |
| C07 | append record 中途由父进程终止 | partial tail 原始字节先持久化到 quarantine，再截断到最后完整 record，恢复旧状态 |
| C08 | 完整 record 已写、event `fsync` 前终止 | 恢复结果允许完整旧状态或完整新状态，禁止半 record 成为已提交状态 |
| C09 | event `fsync` 后、snapshot 前终止 | event 是新权威；replay 恢复完整新状态 |
| C10 | snapshot temp write、snapshot rename 任一点失败 | 命令成功但明确警告；删除/破坏 snapshot 后仍恢复 C09 的新状态 |
| C11 | outcome append 或 HOME cursor 更新失败 | repo 新状态不回滚；`sync-outcomes --repo` 后投影收敛且无重复行 |
| C12 | partial-tail quarantine 已 fsync、event store 尚未 truncate 时终止 | 原始 store 仍可再次恢复；下一次运行复用或去重 quarantine 后完成截断，不丢原始尾部证据 |

partial tail 只指“最终片段没有 `0x0A`”。任何已换行 record 的 JSON、schema、digest、sequence 或 hash-chain 错误都是内部 corruption，禁止当作 tail 自动截断。

quarantine 固定写入 `.taskloop/quarantine/events-v3-tail-<valid_end_offset>-<sha256>-<uuid>.bin`，并写同名 receipt，至少记录 source path、valid end offset、原始文件长度、tail SHA-256、quarantine path 和恢复时间。顺序必须是 raw bytes temp 写完并 `fsync` 后 rename → receipt temp 写完并 `fsync` 后 rename → event store truncate 到 `valid_end_offset` 并 `fsync`；任一步失败都不得先 truncate。C12 证明该恢复过程自身可重入，重复恢复可按 offset + SHA-256 复用既有 quarantine。普通 cleanup 不得删除 quarantine。

### R：恢复与损坏

| ID | 输入 | 期望 |
|---|---|---|
| R01 | 最终无换行片段 | quarantine + 截断，回到最后完整 record |
| R02 | 中间或已换行最终 record 为非法 JSON/未知字段 | fail closed，原文件不改 |
| R03 | record/event digest 错误 | fail closed，原文件不改 |
| R04 | repo sequence 或 task sequence gap/regression | fail closed，原文件不改 |
| R05 | previous-record hash-chain 不匹配 | fail closed，原文件不改 |
| R06 | task A snapshot 落后，B 的 `task_opened` 已 fsync | 按 snapshot source cursor replay 到 B；不得误报 mixed authority |
| R07 | snapshot cursor 领先、source digest 不匹配或 identity 在自身 cursor 不匹配 | fail closed |
| R08 | event store 有效但 snapshot 缺失、无效 JSON 或 self-digest 错误 | 保留诊断信息后从 genesis 重建 |

### T：Transcript cursor 与预算

| ID | 场景 | 期望 |
|---|---|---|
| T01 | tally event 已 fsync、snapshot 前终止，然后重试同一 Hook payload | `output_tokens_delta` 只增加一次 |
| T02 | tally 后删除 snapshot，再重试同一区间 | cursor 从事件恢复，不产生第二个 tally |
| T03 | 人工构造重复、重叠、倒退 range | reducer 和 audit fail closed |
| T04 | UTF-8 多字节 JSONL、CRLF、末尾半行 | offset 按 `Buffer` 字节推进，只消费完整 `0x0A` 行 |
| T05 | 同路径文件截断、替换或 anchor 失配 | 新 generation 的 baseline delta 为 0，不重计旧 range |
| T06 | owner PreToolUse 读取新 range 后因 suspended/预算/Git/安全/envelope 被拒 | 只提交 tally transaction；不生成 `write_authorized`，Hook deny stdout 保持字节契约 |

### W：固定 Windows 发布矩阵

以下 W01–W08 必须在 `.github/workflows/test.yml` 的四个现有组合 `windows-2022/windows-2025 × Node 22/24` 上作为独立步骤运行，任一组合失败都阻止激活：

| ID | Windows 检查 |
|---|---|
| W01 | 含空格、Unicode 和 drive-letter case 变体路径上的 genesis temp/fsync/rename/replay |
| W02 | 真实 file `fsync` 后、snapshot 前终止，恢复完整新状态 |
| W03 | mid-record 终止、partial-tail quarantine 与重复恢复 C12 |
| W04 | snapshot 替换，以及 task A snapshot + task B committed event 的 R06 |
| W05 | 20 个 Node 子进程竞争同一 repo lock：`repo_sequence` 连续、无重复/丢失 mutation |
| W06 | stale task lock 与恢复进程再次崩溃，不得出现双持锁 |
| W07 | UTF-8/CRLF transcript byte range、truncate/replace generation |
| W08 | directory `fsync` capability 探测：只允许已枚举的 unsupported 错误降级，并记录 capability；其他错误 fail closed |

Windows workflow 为 event-store 组设置独立 5 分钟上限并输出失败 case ID；不得依赖 `continue-on-error`。真实断电、网络文件系统和对抗性篡改仍在排除范围，测试结论不得外推到这些场景。

W08 的 directory-fsync unsupported code allowlist 必须作为 exact fixture 按平台冻结，只能由四组 Windows capability probe 的实际 `err.code` 证据新增，禁止 catch-all。directory `fsync` 可按该 allowlist 降级并写入 receipt；event file 自身的 open/write/`fsync` 失败永远 fail closed。

### P：性能 receipt

`npm run bench:event-store -- --json` 必须：

1. 使用固定 seed 生成 10,001 个 transaction records，包含 production schema validation、SHA-256 canonical digest、hash-chain 和真实 reducer；
2. 先 warm-up 一次，再用三个全新进程各执行一次 full replay；三个值均 `<200ms`；
3. 在同一数据集执行 100 次单-record incremental tail read，P95 `<5ms`；
4. 在同一文件系统执行 50 次 append+file-fsync，P95 `<20ms`；
5. JSON 输出 Node、OS、arch、CPU、filesystem/capability、record 数、文件字节数、每次原始样本、P50/P95/max 和阈值判定；任一阈值失败时非零退出；
6. 禁止以旧 throwaway 数字替代本次结果，也禁止因失败直接放宽阈值。若生产实现无法达标，先 profile；仍无法达标则重新评估 framing/reducer，而不是激活。

### 分阶段关闭规则

- Phase 0：冻结本节 case manifest、deterministic generator、脚本接口和阈值；此时不声称 production 证据已经产生。
- Phase 2：C01–C09、C12、R01–R05 的生产 event-store 测试全绿。
- Phase 3：C10、R06–R08 全绿。
- Phase 4：T01–T06 与 P 矩阵全绿。
- Phase 5：A01–A08 全绿；archive receipt 和 installer failpoint 不得改写 event authority。
- Phase 6：C11 全绿。
- Phase 7：在 release candidate 上重跑完整 A/C/R/T、`npm test`、P receipt、W01–W08 和 installer failpoint；随后才进行同 commit second-model review 与原子激活。

## 目标架构

```text
CLI / Hook
    │
    ▼
repo task lock
    │
    ▼
authority discriminator
    │
    ▼
snapshot + event tail replay
    │
    ▼
decide(state, command) → events[]
    │
    ▼
events-v3.jsonl append + fsync       唯一权威
    │
    ├── evolve(events) → task.json   可删除快照
    └── outcome projector            HOME best-effort 投影
```

### 模块边界

- `lib/task-engine.mjs`：纯 `decide`、`evolve`、状态约束和派生投影；不做 I/O。
- `lib/event-store.mjs`：新增 leaf，负责 record 校验、append/fsync、replay、tail 恢复和 audit；只导入 `lib/prims.mjs`。
- `lib/task-store.mjs`：保留 repo lock，负责快照、legacy 原始字节显式归档和恢复入口；不把 v2 解析成运行态。
- `lib/application.mjs`：唯一装配层，组合 event-store 与 task-store 的证据，执行 authority 判别，并编排加载、decide、事务提交、快照和外部投影。
- `lib/outcome-ledger.mjs`：停止作为生产入口；新增 `lib/outcome-projector.mjs` 承担 v3 投影。
- `lib/supervision.mjs`：读取 sibling v3 快照；不可读时继续保持 advisory/fail-open。
- owner hook contact 等非权威活跃度信息进入独立 best-effort session activity，不污染权威事件流。

继续遵守现有架构规则：除 `application.mjs` 与 `prims.mjs` 外，leaf module 不导入 sibling leaf。

## 版本契约

不要再把运行时、快照、存储 framing 和事件 payload 绑定为同一个版本号。

| 契约 | 初始版本 | 规则 |
|---|---:|---|
| `runtime_contract` | 4 | Hook/CLI/存储整体契约；不读取 runtime contract 3 状态 |
| `task.json` snapshot schema | 3 | 可删除、可重新生成 |
| JSONL record schema | 1 | v3 发布后不得遗忘已写入版本；framing 破坏性变化必须使用新文件 |
| 每类 event payload | 1 | v3 发布后按 kind 独立 upcast；这是历史可重放要求，不是 runtime 3 兼容 |
| HOME outcome projection | 3 | 与权威事件存储解耦 |
| v2 task / ledger | 2 | unsupported；只识别到足以拒绝或按用户授权归档，不迁移、不读取业务语义 |

`info` 应至少输出：

```json
{
  "runtime_contract": 4,
  "task_snapshot_schema_version": 3,
  "event_record_schema_version": 1,
  "outcome_projection_schema_version": 3,
  "event_store": ".taskloop/events-v3.jsonl",
  "outcome_projection": "~/.taskloop/outcomes-v3.jsonl"
}
```

### Hard cutover authority 判别

runtime contract 4 的每个 repo-local 入口都先在 repo lock 内执行同一判别，不允许命令自行选择状态模型：

| `events-v3.jsonl` | `task.json` | 结果 |
|---|---|---|
| 不存在 | 不存在 | 空 repo；仅允许 `open` 创建原生 v3 genesis |
| 不存在 | schema 2 | `LEGACY_STATE_UNSUPPORTED`，fail closed；仅允许显式原始字节归档 |
| 不存在 | schema 3 | `ORPHAN_V3_SNAPSHOT`，fail closed；snapshot 不能提升为权威 |
| 存在且有效 | 不存在、无效 JSON或 snapshot digest 错误 | 保留诊断信息后从 event store genesis 重建 snapshot |
| 存在且有效 | schema 3，source cursor 落后，且 source record digest 与 task identity 在该 cursor 位置匹配 | 从 snapshot replay tail；即使 tail 已切换到新 task，也不得提前拿 snapshot task identity 与 tail task identity 比较 |
| 存在且有效 | schema 3，source cursor 等于 event tail，且 source record digest 与 task identity 匹配 | 直接使用 snapshot |
| 存在且有效 | schema 2、未知 schema、cursor 领先、source record digest 不匹配，或 task identity 与 snapshot 自己的 source cursor 不匹配 | `MIXED_OR_INVALID_AUTHORITY`，fail closed |
| 存在但内部损坏 | 任意 | `CORRUPT_EVENT_AUTHORITY`，fail closed，不回退 snapshot |

生产运行时不提供 `TASKLOOP_STATE_MODEL`、v3 opt-in 或 v2 reader。开发阶段的新模块只能由测试直接调用，直至一次性接管所有入口。现有 `archive-incompatible-state` 是 legacy 或混合 side artifact 状态下唯一允许的 repo-local 修复命令：它只归档 `task.json`，必须保存原始字节、SHA-256、原因、授权者和时间，永不移动 event store。无 event store 时，归档后只能开启全新的 v3 task；已有有效 event store 时，归档后从事件重建 v3 snapshot。两种情况都不能把 v2 snapshot 解释为 v3 genesis。

判别优先级固定为：先完整验证 event store，再识别 snapshot schema，再用 snapshot source cursor 定位它所声称的 source record，随后只在该 cursor 位置验证 record digest 和 task identity，最后才判断落后、相等或领先。合法恢复 fixture 必须包含：task A terminal snapshot 已落盘，`task_opened(B)` 已 fsync，但 B snapshot 尚未替换时崩溃；恢复必须从 A snapshot replay 到 B，不得报 mixed authority。

首次创建 event store 使用临时文件写入完整 `task_opened` record、`fsync`、原子 rename，再在支持的平台同步目录；因此 `events-v3.jsonl` 的出现本身表示已有完整 genesis。残留 genesis 临时文件永远不是 authority，可在保留诊断信息后清理。

## 事务 Record

每个命令提交一条 JSONL record；一个 record 可包含多个按序 domain event：

```json
{
  "record_schema_version": 1,
  "transaction_id": "uuid",
  "command_id": null,
  "repo_sequence": 42,
  "occurred_at_epoch_ms": 1784000000000,
  "occurred_at": "2026-07-14T00:00:00.000Z",
  "actor": {
    "kind": "hook",
    "session_id": "..."
  },
  "previous_record_digest": "sha256:...",
  "events": [
    {
      "event_id": "sha256:...",
      "task_id": "uuid",
      "task_event_sequence": 9,
      "kind": "criterion_observed",
      "payload_version": 1,
      "payload": {}
    }
  ],
  "record_digest": "sha256:..."
}
```

约束：

- 使用 SHA-256，不再使用 FNV 作为持久化完整性校验；
- digest 基于 dependency-free 的确定性 JSON canonicalization；
- `repo_sequence` 连续递增；
- 每个 task 的 `task_event_sequence` 连续递增；
- record 必须以换行结束；无换行最终片段视为未提交；
- payload 未知字段、未知 kind、未知 payload version 都拒绝；
- observation 只持久化裁决所需事实和有界输出尾部，不无限保存原始命令输出。

## 权威事件目录

### 生命周期

- `task_opened`
- `task_suspended`
- `task_resumed`
- `task_joined`
- `task_terminal`

### 工作、证据和预算

- `write_authorized`
  - PreToolUse 发生在真实工具执行前，只能表达“获准尝试写入”，不能声称写入已完成；
  - `artifact_revision` 继续表示保守的证据失效 revision。
- `criterion_observed`
- `criterion_side_effect_recorded`
- `output_tokens_tallied`
  - transcript 读取仍可 best effort；一旦读到一个完整换行边界，就用事件原子推进消费区间，因为 token 计数影响预算门；
  - payload 固定包含 `source_id`、`source_generation_id`、`episode_id`、`from_offset`、`to_offset`、`range_sha256`、`end_anchor_sha256`、`output_tokens_delta` 和 `mode`；
  - 所有 offset 都是原始文件 `Buffer` 的字节 offset，以 `0x0A` 完整换行作为提交边界；不得使用 JavaScript UTF-16 字符下标；
  - `source_id` 是规范化绝对路径的 SHA-256，不在事件中暴露原始本机路径；规范化至少覆盖 `path.resolve`、分隔符和 Windows drive-letter case，并由跨平台 fixture 固化；
  - `source_generation_id` 是在 baseline 时由装配层注入的 UUID；reducer 不自行取时钟或随机数；
  - `mode: "baseline"` 允许 `output_tokens_delta: 0`，用于新 episode、首次观察、截断或文件替换后的新 generation；
  - `mode: "increment"` 要求 `from_offset` 精确等于 reducer 中该 generation 的当前 offset，且 `to_offset > from_offset`；重复、重叠、倒退区间全部 fail closed；
  - `range_sha256` 绑定本次解析的原始字节，`end_anchor_sha256` 绑定结束 offset 前最多 4 KiB 字节；下一次读取先验证 anchor，失配时不猜测旧数据，而是开始新的 baseline generation；
  - reducer 从这些事件派生 authoritative transcript cursor；snapshot 只缓存它，删除 snapshot 后可完整恢复。

### 治理

- `task_amended`
- `review_recorded`
- `proof_gap_accepted`

明确不进入权威事件流：

- lock owner 文件；
- untracked nudge；
- owner hook contact；
- 由事件派生的 closure、risk floor、proof assurance、report；
- outcome projection cursor。

删除 `.taskloop/transcript-cursors.json` 的生产读写路径。磁盘上已有的该文件不读取、不迁移、不自动删除，只作为可忽略的 legacy 诊断残留。transcript cursor 不再是第二个文件中的权威字段，而是 `output_tokens_tallied` 事件重放得到的内部状态；同一 repo lock 下，下一条命令必须先重放到最新 cursor 再决定是否生成新 tally 事件。

## 命令事务映射

| 当前入口 | v3 事务事件 |
|---|---|
| `open` | `[task_opened]` |
| PreToolUse write | 可选 `output_tokens_tallied` + `write_authorized` |
| owner PreToolUse 最终因 suspended、预算、Git、安全或 envelope 被拒 | 如果读取到新完整 range，仅提交 `[output_tokens_tallied]`，随后返回 deny；绝不生成 `write_authorized` |
| PreToolUse read-only tally | `[output_tokens_tallied]` |
| Stop unsatisfied | `output_tokens_tallied? + criterion_observed` |
| Stop unsatisfied 且需自暂停 | `output_tokens_tallied? + criterion_observed + task_suspended` |
| Stop satisfied 且自动关闭 | `output_tokens_tallied? + criterion_observed + task_terminal` |
| `achieve` | `criterion_observed + task_terminal?` |
| criterion side effect | `output_tokens_tallied? + criterion_side_effect_recorded` |
| `suspend` | `[task_suspended]` |
| `resume` | `[task_resumed]` |
| `join` | `[task_joined]` |
| `review` | `[review_recorded]` |
| `accept-proof-gap` | `[proof_gap_accepted]` |
| `amend` | `[task_amended]` |
| `not-needed` / `abandon` | `[task_terminal]` |

`verify` 的普通 observation 仍不持久化；如果 criterion 产生 side effect，则必须提交 `criterion_side_effect_recorded`，且 JSON 输出如实报告 persistence 和前后 artifact revision。

deny 路径冻结当前“先 tally、后裁决”的语义：`decide` 可以返回 `{ events: [output_tokens_tallied], result: deny }`，装配层先提交 tally-only transaction，再输出原有 deny 协议。没有完整新 range 时不写空事务；tally commit 失败时 write-shaped hook 必须 fail closed，不能在预算状态未知时放行。foreign session 和 control-plane 预检仍在 transcript 读取前返回，不消费 owner range。

## 提交与恢复语义

### 正常提交

在现有 repo lock 内：

1. 执行 hard-cutover authority 判别；
2. 校验 v3 快照并从 snapshot cursor 重放事件尾部；快照缺失或可判定损坏时从 genesis 重放；
3. 如果命令携带 transcript，按 reducer 中的 authoritative cursor 读取到最后一个完整换行，验证 generation/anchor，并构造 range fact；读取不可用时不生成 fact；
4. `decide(state, command, facts)` 一次生成完整事件批，tally 和业务 mutation 属于同一批；
5. 构造单条 transaction record；
6. 已存在的 event store 用检查返回字节数的 `writeAllSync` 循环追加一条完整 record；repo lock 防止 record 交错，任意 short write/crash 只留下可识别的 partial tail；首次 genesis 使用临时文件写入完整 record、`fsync` 后原子 rename；
7. `fsyncSync` event file；支持时同步父目录；
8. 事务正式提交；
9. `evolve` 得到包含新 transcript cursor 的状态；
10. 原子替换 v3 `task.json` 快照；
11. best-effort 更新 HOME outcome projection 和非权威 session activity。

### 故障分类

| 故障点 | 结果 |
|---|---|
| append 前失败 | 无提交，保持旧状态 |
| 中途写断 | 最终 partial tail，隔离原始字节后截断，保持旧状态 |
| 完整写入、fsync 前崩溃 | 恢复后可能是旧状态或完整新状态；绝不允许半事务 |
| fsync 失败 | fail closed，不返回成功 |
| fsync 后快照失败 | 事件已提交；返回成功并警告，下一次读取重建快照 |
| HOME 投影失败 | 本地状态正确，cursor 保留待重试 |
| snapshot digest 错误 | 丢弃快照，从事件流重建 |
| snapshot cursor 领先事件流 | fail closed |
| 内部 JSON、digest、sequence、hash-chain 损坏 | fail closed，不跳过坏记录 |
| transcript 不可读或没有完整新行 | 不生成 tally 事件；命令按 best-effort token 语义继续 |
| transcript anchor 失配、截断或替换 | 生成新 generation 的零增量 baseline；不重复旧 range，也不猜测缺失 token |
| tally 已 fsync、快照前崩溃 | replay 恢复新 cursor 和 token delta；同一 range 不再生成事件 |
| 同一 range 被再次提交或与已消费区间重叠 | reducer/audit fail closed，不能再次增加 token |

如果宿主没有稳定 `command_id`，普通业务命令仍不能承诺 crash retry 的 exactly-once；能够承诺的是：成功返回前已 fsync，未成功返回的调用恢复为完整旧状态或完整新状态。transcript tally 额外以 `source_generation_id + episode_id + [from_offset,to_offset) + range_sha256` 建立内部幂等边界，因此同一已提交区间不会重复计入预算。

## 实施阶段

### Phase 0：固化契约与黄金样本 — 2 人日

改动：

- 在 `lib/prims.mjs` 定义独立版本、文件名和事件常量；
- 固化 record、12 类事件、v3 snapshot、v3 outcome projection；
- 新增 runtime-contract-4 fixtures；
- 固化 authority 判别矩阵，以及 legacy、孤儿 snapshot、混合制品、未知版本、未知字段和损坏错误文案；
- 固化 `output_tokens_tallied` range/generation/anchor 约束；
- 固化 owner PreToolUse 的 tally-only deny 顺序和失败语义；
- 时间统一为 epoch milliseconds + UTC ISO；
- 预注册性能与崩溃验收门槛；
- 冻结 `event-store-cases-v3.json`、deterministic fixture generator、测试脚本接口和 receipt schema；生产模块尚未存在时不伪造通过结果；历史 throwaway prototype 仅作非门禁参考。

门禁：schema、事件语义、hard-cutover 判别、transcript 幂等约束和 A/C/R/T/W/P case manifest 完成独立评审；所有 case 都有唯一 ID、前置状态、注入点和单一期望结果。

### Phase 1：重构纯状态引擎 — 3 人日

在 `lib/task-engine.mjs` 建立：

```js
decide(state, command) -> { events, result }
evolve(state, event) -> nextState
```

要求：

- `transition()` 只在分阶段开发期间作为当前行为的临时实现，并与 hard cutover 在同一发布落点删除，不作为 runtime 4 adapter；
- 12 类现有 mutation 用冻结黄金样本做逐项语义回归，不运行 runtime contract 3 reader；
- reducer 不做 I/O、不重新运行 criterion、不生成随机 ID；
- ID、时间、observation、文件列表作为外部事实注入；
- transcript range、generation 和 digest 也作为外部 fact 注入，reducer 只验证连续性并推进 cursor；
- replay 使用同一 reducer，但不逐事件重复深拷贝完整 projection；
- 派生状态不写入事件 payload。

门禁：同一命令序列下，新 reducer 与冻结黄金样本的 lifecycle、budget、attempt、review、closure 和 Hook 决策一致；tally range 重复或重叠会 fail closed。

### Phase 2：权威事件存储 — 4 人日

新增 `lib/event-store.mjs`：

- exact record validator；
- SHA-256 record digest 与 hash chain；
- append + fsync；
- 对每次 `writeSync` 返回值做推进检查，覆盖 short write、零推进和注入异常；
- full replay 与 cursor tail replay；
- torn-tail quarantine；
- event-store audit；
- 可注入 filesystem operations 的测试 seam，用于 fsync/write/rename 故障注入；
- 保持 leaf import 方向。

门禁：C01–C09、C12、R01–R05 使用生产 event-store 全绿；所有进程崩溃点只出现旧状态或完整新状态，内部损坏全部 fail closed。

### Phase 3：v3 快照与恢复 — 3 人日

调整 `lib/task-store.mjs`：

- `task.json` 写 schema-v3 projection wrapper；
- 保存 `snapshot_digest` 和 source cursor；
- 快照缺失/损坏时完整重建；
- 快照落后时增量 replay；
- 快照领先时 fail closed；
- 快照写失败不得把已提交事务伪装成失败事务；
- sibling-worktree advisory 理解 v3 快照。

门禁：C10、R06–R08 全绿；任意删除、截断或破坏 snapshot 后，恢复结果符合故障分类。

### Phase 4：接管全部 mutation — 5 人日

逐个替换 `lib/application.mjs` 中绕过事务层的直接任务写入：

- `open`；
- PreToolUse write authorization；
- transcript tally：删除 sidecar，把 baseline、generation、range 和 token delta 纳入同一 transaction；
- `verify` criterion side effect；
- Stop observation、自动 terminal 和自暂停；
- `suspend`、`resume`、`join`；
- `review`、`accept-proof-gap`、`amend`；
- `not-needed`、`abandon`。

新增 architecture test：除 event-store commit 和 snapshot projector 外，生产代码不得写权威 task 状态。

门禁：T01–T06 与 P 矩阵全绿；每个公开 mutation 都能从其事务事件单独重建，在 tally append/fsync/snapshot 各崩溃点重试同一 transcript 只计费一次，Hook stdout 仍字节兼容。

### Phase 5：Hard cutover 与 authority guard — 2 人日

新增或调整：

```text
taskloop archive-incompatible-state \
  --repo <repo> \
  --reason <reason> \
  --granted-by user
```

规则：

- 所有入口共享同一个 authority discriminator；
- schema 2 只识别为 unsupported legacy，不反序列化为业务状态；
- 显式归档保存原始字节、SHA-256 和授权 receipt，但不生成 v3 事件；
- 无 event store 的 legacy repo 归档后，`open` 创建全新的 `task_opened` genesis；已有有效 event store 的 mixed repo 归档 side artifact 后，从事件恢复当前 v3 task，不额外创建 genesis；
- 删除 `TASKLOOP_STATE_MODEL`、v3 opt-in、v2/v3 双写、v2 reader、`task_state_imported` 和迁移命令；
- installer 原子激活 runtime contract 4；生产 CLI 从一个版本点整体切换，不存在 repo 级灰度；
- 激活后的受支持恢复路径只有 roll forward 或切换到仍能读取当前 v3 record/payload 的 runtime contract 4 build；runtime contract 3 永不作为回滚目标；
- 旧进程或手工调用旧二进制属于不支持路径；其留下的 schema 2 side artifact 会触发 `MIXED_OR_INVALID_AUTHORITY`，v4 不会覆盖 event store。
- 旧 `.taskloop/transcript-cursors.json`、`.taskloop/history/` 和 HOME `outcomes-v2.jsonl` 永远不参与 authority 判别；runtime 4 忽略但不自动清理它们，`status`/`audit` 可把它们列为非阻断诊断项。

门禁：authority 真值表、legacy 显式归档、混合制品拒绝、shim 原子激活和“无 runtime 3 rollback”安装测试全部通过。

### Phase 6：Outcome 投影与审计 — 2 人日

- 新增 `~/.taskloop/outcomes-v3.jsonl`；
- 投影行绑定 `repo_identity + repo_sequence + event_id`；
- HOME 重试 cursor 存放在 `~/.taskloop/outcomes-v3-cursors/<repo_identity_sha256>.json`，采用 best-effort 原子替换，不属于 repo authority；
- cursor 缺失、损坏或落后时，从 repo event genesis 重扫，并用确定性 `event_id` 对现有 outcome projection 去重；projection append 已成功但 cursor 未更新的重试不得产生重复行；
- 新增 `sync-outcomes --repo` 幂等重建；
- `audit --repo` 审计本地权威事件；
- `audit-outcomes` 审计 HOME 投影；
- v2 `outcomes-v2.jsonl` 不读取、不迁移、也不自动删除；
- HOME 不可写、不同 HOME 或 sandbox 拒绝时，本地权威状态仍正确。

门禁：C11 全绿；删除 v3 HOME projection 后可从每个 repo 重建，投影失败从不阻塞 task commit。

### Phase 7：硬化、安装和原子激活 — 5 人日

- 在 release candidate 上重跑 A/C/R/T 全矩阵；
- 20+ 并发 mutation；
- stale task-lock 崩溃恢复；
- DST、时区和 monotonic epoch 验证；
- 四组固定 Windows CI 的 W01–W08；
- P 性能 receipt；
- `status`、`report --json`、`verify`、`audit`、`info` 自描述版本字段；
- 保持 Hook stdout 字节协议；
- 更新 `README.md`、`skills/loop-core/REFERENCE.md`、`HOSTS.md`、installer、架构图；
- 同一 release commit 的 runtime-contract-4 second-model 完整评审；
- 通过后才原子激活 hard cutover。

## 预计文件范围

| 路径 | 预期变化 |
|---|---|
| `lib/prims.mjs` | 独立版本、文件名、SHA-256/canonical helpers |
| `lib/task-engine.mjs` | `decide`、`evolve`、transcript cursor 状态、v3 validators；删除旧 transition 路径 |
| `lib/event-store.mjs` | 新增权威 JSONL 存储与恢复 |
| `lib/task-store.mjs` | lock、legacy 原始归档、v3 snapshot |
| `lib/application.mjs` | authority discriminator、事务装配、所有 mutation 接管、移除 transcript cursor sidecar、CLI |
| `lib/outcome-ledger.mjs` | 从生产装配移除或由 v3 projector 替换 |
| `lib/outcome-projector.mjs` | 新增 v3 outcome 投影 |
| `lib/supervision.mjs` | sibling v3 snapshot、控制面保护 |
| `lib/untracked.mjs` | 保持非权威，不进入事件流 |
| `tests/taskloop.test.mjs` | domain、CLI、hard cutover、transcript 幂等和 Hook 行为 |
| `tests/fixtures/event-store-cases-v3.json` | 冻结 A/C/R/T/W/P case manifest |
| `tests/event-store.test.mjs`、`tests/helpers/event-*.mjs` | 可重复 crash、corruption、concurrency、fixture generator 和 child harness |
| `tests/event-store-benchmark.mjs` | production replay/tail/append+fsync JSON benchmark receipt |
| `tests/taskloop-architecture.test.mjs` | import 方向、单一权威写入、版本 handshake |
| `tests/verify-full.mjs` | 把 portable event-store correctness suite 纳入任务级完整验证 |
| `tests/windows.test.mjs` | Windows event store/recovery |
| `tests/installer.test.mjs` | runtime 4 安装、原子激活、拒绝 runtime 3 rollback |
| `tests/fixtures/runtime-contract-4.mjs` | 新增冻结外部 Hook/CLI 契约 fixture |
| `tests/fixtures/runtime-contract-3.mjs` | 删除；runtime 4 不承担旧 reader 兼容 |
| `package.json` | 新增 event-store test/benchmark scripts，并把 correctness suite 纳入 `npm test` |
| `.github/workflows/test.yml` | 新增四组 Windows W01–W08 bounded gate 和 evidence artifact |
| `README.md`、`skills/loop-core/*` | 新权威边界与操作说明 |

## 范围与成本

| 范围 | 组件 | 人日 | 主要风险 | 价值 |
|---|---|---:|---|---|
| 核心 | 契约与黄金样本 | 2 | schema 过早冻结 | 阻止语义漂移 |
| 核心 | decide/evolve 引擎 | 3 | 行为黄金样本不完整 | 确定性重放 |
| 核心 | 事件存储与恢复 | 4 | crash/torn write | 单一权威 |
| 核心 | 快照投影 | 3 | cursor 不一致 | 保持 CLI 热路径 |
| 核心 | 全 mutation 与 transcript cursor 接管 | 5 | 漏写或区间重复 | 完整事件历史和预算正确性 |
| 核心 | hard cutover 与 authority guard | 2 | legacy/混合制品误判 | 消除双权威 |
| 支撑 | outcome 投影与 audit | 2 | HOME 打洞 | 可重建全局视图 |
| 支撑 | 崩溃、并发、Windows、性能、文档 | 5 | 跨平台差异 | 发布证据 |
| **总计** |  | **26** |  |  |

C/R/T/P 的测试实现计入对应 Phase 0–4 核心行，A 计入 Phase 5 hard-cutover 行，W 与 release-candidate 重跑计入最后 5 人日支撑行，不重复计价。如果 Windows 证据迫使引入新的持久化机制，或测试/恢复工作使总成本增加超过 2 人日，则 Decision Envelope 失效，必须重新比较 v2 强化与 v3 BUILD，不能静默扩项。

持续维护成本：

- 每类新 domain event：约 1–2 人日；
- pre-v3 task、ledger 和 runtime 不承担兼容维护；
- v3 发布后每次破坏性 payload 变化仍必须新增 upcaster 和冻结历史 fixture，否则最新 runtime 无法重放自己的权威历史；
- v3 record framing 不原地升级，使用新文件名和专用升级工具；
- Windows、installer、Hook contract 和历史 replay 成为每次 runtime contract 升级的固定测试成本。

## 安全发布顺序

以下顺序不可交换：

1. 先冻结 record/event 契约；
2. 再实现并验证 event-store commit；
3. 再实现 snapshot recovery；
4. 再把 transcript range/cursor 纳入事件事务并接管所有 mutation；
5. 再实现 authority discriminator、legacy archive 和 installer hard cutover；
6. 再实现 HOME projection 和文档；
7. 最后以一个原子激活点切到 runtime contract 4。

在第 7 步之前，新 v3 模块只允许测试直接调用，生产 CLI 仍保持当前实现；不提供 opt-in flag，避免形成需要维护和推理的双运行态。hard cutover 变更必须与删除生产 v2 reader/writer 同一发布落点。

禁止：

- 在 mutation 未全部接管前切换 v3 authority；
- 同一任务同时把 v2 snapshot 和 v3 event store 当作权威；
- 提供 `TASKLOOP_STATE_MODEL`、v2/v3 opt-in 或自动迁移；
- 让 runtime contract 3 作为 v3 发布后的回滚目标；
- event append 失败后继续写 snapshot；
- 在 event transaction 外推进 transcript cursor；
- 自动跳过内部损坏事件；
- 为了兼容而伪造 v2 历史；
- 在没有用户授权和完整 receipt 的情况下删除或覆盖 legacy 状态。

## 回滚

### Hard cutover 激活前

- v3 模块没有生产入口，回退代码不会接触用户状态；
- 测试 event store 只存在于临时 fixture；
- 当前 v2 task 和 ledger 不被新代码改写。

### Hard cutover 激活后

- 不允许切回 runtime contract 3，也不提供 v3 → v2 导出或自动降级；
- 首选恢复是 roll forward；只有目标 build 明确支持 event store 中已经出现的全部 record/payload version 时，才允许切换到另一个 runtime contract 4 build；
- 如果首个 runtime 4 release 本身故障且没有兼容 build，只能修复后 roll forward；
- 恢复到 v2 只被定义为整组恢复 cutover 前备份：runtime、repo-local `.taskloop` 和必要 HOME 数据必须来自同一备份点，并要求显式破坏性授权；它不是应用内 rollback 功能；
- outcome projection 可随时删除并重建，不参与 rollback 正确性；
- 本地 event store 是恢复所需资产，不能由普通 cleanup、legacy archive 或 installer 自动删除。

## 真实约束、约定与假设

### 真实约束

- dependency-free Node CLI；
- `application.mjs` 是唯一 cross-leaf assembly；
- 生命周期 mutation 留在纯 task engine；
- repo-local 权威写入失败必须 fail loudly；
- HOME outcome 与非权威 telemetry degrade open；
- Hook stdout byte-exact；
- scheduler 仍在仓库外；
- Windows 是正式支持边界；
- 用户明确接受 pre-v3 状态不兼容和无 runtime contract 3 降级；
- legacy 状态仍不能被静默猜测、迁移或无授权改写；
- runtime 4 必须持续读取它自己已经写入的 v3 历史，否则 event store 不能作为恢复权威。

### 可改变约定

- `task.json` 当前是权威；
- `last_issued_event_sequence` 是独立可变字段；
- 时间使用无时区本地字符串；
- outcome ledger 只记录部分事件；
- `audit` 只面向 HOME ledger。

### 承重假设

| 假设 | 如果错误 | 计划变化 |
|---|---|---|
| 本地可重建历史而非合规审计是目标 | 需要防恶意篡改 | 增加签名、远端/WORM，成本和边界重估 |
| 每个 repo 同时只存在一个当前 task | 未来允许多 active task | snapshot、lock 和命令选择器需重新设计 |
| 单 repo 常见事件量低于 100k | 大量仓库长期运行 | 增加 segment/seal 和 audit 索引 |
| 支持边界是本地文件系统上的进程崩溃语义 | 必须支持 NFS/SMB、真实断电或跨主机并发 | JSONL + repo lock 证据不再充分，需重选存储/锁机制并重新定价 |
| exactly-once 不是硬要求 | host 会自动重试未知结果 | 必须获得稳定 host `command_id` |
| hard cutover 时可以结束或显式归档现有 v2 task | 必须保留 active/suspended v2 工作 | 需要重新加入一次性迁移，成本与本计划重新评审 |
| runtime contract 3 调用在 cutover 后属于不支持行为 | 必须允许新旧 runtime 并行 | 需要稳定 authority dispatcher/marker 和兼容窗口，本计划不成立 |

## Value Gate 与替代方案

| 机制族 | 结论 | 原因 |
|---|---|---|
| 保持现状 | 不选 | 成本为零，但无法从 ledger 重建任务，也保留双写窗口 |
| 使用现有 ledger | 不选 | HOME 可能不可写、事件不完整、设计上不是 adjudication authority |
| 人工归档/流程检查 | 不选 | 能保留快照，不能提供命令原子性和确定性重放 |
| v2 最小强化 | 最近替代 | 对当前已知 bug 的 ROI 最好，但不满足完整历史目标 |
| repo-local v3 event authority | 选择 | 唯一满足重建、崩溃原子性和多投影，同时可保持 dependency-free |
| SQLite / 外部数据库 | 不选 | 引入运行时、跨平台、安装和备份复杂度，没有证明优于 JSONL |

## 明确排除

- 远端或 WORM 审计存储；
- 数字签名和对抗性防篡改；
- 自动压缩、删除或重写历史；
- SQLite；
- 通用事件查询语言；
- 通用多任务并行调度；
- v2 task/ledger 迁移、读取和审计；
- v2/v3 双模式、灰度开关和 runtime contract 3 降级；
- pre-v3 数据和旧二进制兼容；
- 没有稳定 host `command_id` 时的 exactly-once；
- 把 scheduler、reviewer 创建或模型路由纳入 taskloop runtime。

## 历史探索性证据与待复验证据

此前 throwaway prototype 已执行并删除，未进入生产代码，因此以下只能作为机制可行性的历史参考，不能作为实施或发布门禁证据：

- 覆盖当前 12 类 mutating transition；
- `criterion_observed + task_suspended` 作为单 record 多事件事务；
- append 前、mid-record、完整写未 fsync、fsync 后、snapshot 临时文件和 rename 后进程崩溃注入；
- partial tail 隔离后回到旧状态；
- fsync 后 snapshot 失败可恢复新状态；
- 损坏 snapshot 可重建；
- snapshot cursor 领先和内部 event corruption fail closed；
- 20 个并发进程无序列丢失；
- 10,001 events、约 6.8 MB event store；
- 优化后连续三次 full replay 约 157–160ms；
- incremental tail P95 约 1.20–1.34ms；
- append + fsync P95 约 4.05–4.61ms。

初始 reducer 因逐事件重复深拷贝，full replay 约 519–524ms，未通过 200ms 门槛；移除冗余 projection clone 后才通过。因此生产实现必须把“replay 不重复深拷贝完整状态”固定为性能和架构约束。

Phase 0 只冻结可重复的 case manifest、generator、命令和 receipt schema；生产 validator、SHA-256 hash chain、authoritative transcript cursor、实际 reducer 和 hard-cutover assembler 分别在 Phase 2–5 出现后关闭对应矩阵，Phase 7 再对 release candidate 全量复验。未复现时不得以历史数字放宽 Oracle。

即使复现，上述结果也只证明记录环境上的进程崩溃可行性，不等同于真实断电、所有 Windows 文件系统或合规级防篡改。Windows event-store 证据属于 Phase 7 的发布门禁；真实断电与对抗性防篡改仍明确排除。
