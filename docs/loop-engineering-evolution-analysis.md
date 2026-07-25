# Workloop 向 Loop Engineering Runtime 演进分析

> 状态：分析存档（已按仓库源码核对）  
> 日期：2026-07-24；核对与修订：2026-07-25  
> 范围：当前仓库源码、测试、CLI、Skill 与本地验证结果  
> 排除项：未读取或引用 `docs/` 目录中的既有文档内容

2026-07-25 的核对结果：本文的事实基础成立，§7.1、§7.2、§7.3 的三个底座问题
均已在源码中定位并复现。核对同时修正了两处低估和两处表述不准，相关段落已就地
更新，实测证据见[附录 A](#附录-a核对证据2026-07-25)。

## 结论

Workloop 的演进目标不应是“更可靠的任务记账器”，而应是真正的
**Loop Engineering Runtime**。

此前针对 authority journal、恢复能力和 certification CAS 的改进仍然有价值，
但它们只是可靠性底座，不是产品主线。产品主线应当是：

> 让一个目标能够跨进程、跨会话、跨 Agent 持续迭代；任何兼容宿主都能取得
> 确定的下一步，提交可验证的结果，并由持久化状态机决定继续、调整、暂停
> 还是结束。

## 1. Loop Engineering 的本质

Loop Engineering 不是让 Workloop 自动执行更多命令，而是系统化管理反馈闭环：

```text
目标
  ↓
生成下一步行动
  ↓
宿主 / Agent 执行
  ↓
采集执行结果与制品变化
  ↓
独立判断
  ↓
继续 / 调整 / 复核 / 求助 / 终止
  └────────────────────────↺
```

一个完整的 Loop Engineering 系统必须同时解决：

1. 目标如何被明确和冻结；
2. 每一轮应该执行什么；
3. 执行结果如何形成可靠观察；
4. 如何判断是否取得进展；
5. 失败后如何选择下一步；
6. 如何识别重复、停滞和预算耗尽；
7. 如何跨崩溃、会话和 Agent 恢复；
8. 何时停止，以及由谁授权继续。

现有 provider authority 应当成为这套系统的 durable substrate，而不是最终产品。

## 2. 当前能力边界

当前公开 Contract 的主路径是：

```text
open → stage → commit → certify
```

其中：

- `open` 建立任务、附件和 write claims；
- `stage`、`commit` 产生任务范围内的 Git receipt；
- `certify` 运行 tri-state criterion；
- criterion 满足时任务直接终结为 `achieved`；
- criterion 不满足或不确定时，CLI 返回错误，但不会形成新的持久化轮次。

最后一条已核对：`lib/provider-application.mjs` 的 `cmdCertify` 在 criterion 非
`satisfied` 时直接 `return error(...)`，退出码 2，authority journal 零写入。
失败结果不进入任何持久化状态。

当前 shipped Workloop Skill 也是由 Agent 人工完成以下过程：

1. frame authority；
2. open 或 join task；
3. 实现并运行检查；
4. 生成 receipt；
5. certify。

这是一套可靠的 provider workflow，但还不是循环运行时。

### 2.1 当前缺失的循环能力

当前可执行路径没有完整表达：

- Goal Contract；
- round、attempt、episode；
- 持久化的失败 observation；
- next-action decision；
- no-progress/stuck 检测；
- budget 消耗；
- strategy、reviewer 和 escalation；
- 崩溃后恢复同一轮；
- 循环嵌套；
- meta-loop。

一个例外：suspend/resume **不属于**缺失项。`lib/authority-state.mjs` 已经实现
完整的 `active ↔ suspended` lifecycle 转换，并要求 participant session 与显式
provenance。§5 提出的 `suspended: out_of_budget` 与 `suspended: needs_input`
只需要把当前的自由文本 `reason` 升级为受控枚举，不是新建概念。

### 2.2 源码中的演化“化石”

`lib/prims.mjs` 仍保留上一代运行时词汇：

- `DEFAULT_ROUNDS`；
- `STUCK_REPEATS`；
- `NO_PROGRESS_STOPS`；
- rounds、writes、wall-clock、output-token budgets；
- `criterion_observed`；
- `criterion_side_effect_recorded`；
- `review_recorded`；
- `task_amended`；
- `proof_gap_accepted`。

这些概念没有接入当前唯一运行入口，不能直接代表现有能力。

核对后的实际范围比上表更大：`lib/prims.mjs` 的 58 个导出中，**35 个在 `lib/`、
`bin/`、`install.mjs` 中零消费者**。除上表所列，还包括整套 `V3_EVENT_*` 词汇表、
`EVENT_PAYLOAD_FIELDS_BY_VERSION`、`BUDGET_DIMENSIONS`、`REVIEW_LEVELS`、
`VALID_SUSPEND_OUTCOMES`、`TERMINAL_OUTCOMES`、`OBSERVATION_VERDICTS`、
以及退役 event store 与 outcome projector 的全部文件名常量。

也不应直接复活已退役的 event/task runtime。正确方向是在当前
provider-neutral authority 底座上，重新建立职责清晰的循环控制层。

### 2.3 测试语料中的化石

化石不止在 `lib/prims.mjs`。`package.json` 的 `test` 门禁只覆盖 10 个测试文件，
`tests/` 下另有 13 个文件不在门禁内，其中多数已经失效：

| 文件 | 状态 |
| --- | --- |
| `tests/runtime-v5.test.mjs` | 全部失败；仍 import 已删除的 `lib/event-store.mjs`、`lib/outcome-projector.mjs` |
| `tests/roadmap-e2e.test.mjs` | 全部失败 |
| `tests/foreign-session-scope.test.mjs` | 31 项失败；针对已移除的 policy engine |
| `tests/host-authority.test.mjs` | 部分失败 |
| `tests/host-hooks.test.mjs` | 部分失败 |

这直接决定 §8 的第一条产品验收场景应该写在哪里、以及它能否被信任。在写第一行
Loop Kernel 代码之前，应先修复或删除失效语料并补齐门禁；这项成本低，但它是后续
所有循环断言的可信度前提。

## 3. 目标架构

### 3.1 Authority Kernel

Authority Kernel 继续负责：

- provider identity；
- attachment；
- write claims；
- Git/filesystem receipt；
- 并发冲突；
- task ownership；
- durable journal；
- crash recovery。

它回答的问题是：

> 谁可以在哪些制品上工作，哪些事实已经可靠发生？

Authority Kernel 不应决定下一轮采取什么工程行动。

### 3.2 Loop Kernel

新增 provider-neutral、可重放的确定性状态机：

```text
framed
  → ready
  → directive_issued
  → observation_recorded
  → judged
  → ready | suspended | terminal
```

它回答的问题是：

> 根据目标、当前制品、可靠证据、预算和历史，下一步应该是什么？

建议的核心领域对象：

```text
LoopSpec
LoopRun
Episode
Round
Directive
Observation
Judgment
Decision
Amendment
```

职责如下：

- `LoopSpec`：目标、约束、criterion、预算、策略和审查要求；
- `LoopRun`：一次具体循环实例；
- `Episode`：一个 Agent 或会话的参与周期；
- `Round`：一次完整的行动、观察和判断；
- `Directive`：系统发出的下一步行动契约；
- `Observation`：宿主提交的实际结果；
- `Judgment`：criterion 或 reviewer 对结果的判断；
- `Decision`：continue、reframe、review、request_input、suspend 或 terminal；
- `Amendment`：用户对目标、预算、约束和策略的显式变更。

### 3.3 Host Adapter

Workloop 不应直接执行工具，也不应取代宿主的权限系统。

它只输出结构化 directive，例如：

```json
{
  "directive_id": "uuid",
  "round": 3,
  "kind": "repair",
  "goal": "修复失败的并发认证",
  "allowed_claims": ["lib/**", "tests/**"],
  "feedback": {
    "failure_signature": "sha256:...",
    "summary": "task B caused task A certification stale"
  },
  "required_receipt": "git_commit_and_criterion"
}
```

Claude、Codex 或其他 Agent 执行 directive 后，再向 Workloop 提交 observation。

这样既能形成闭环，也能保持现有边界：

- 宿主决定是否允许执行；
- Agent 决定具体如何实现；
- Workloop 决定当前循环状态和合法的下一步。

### 3.4 Judge Adapter

现有 tri-state exit code 可以继续作为兼容协议，但下一版 criterion 应支持
结构化反馈：

```json
{
  "verdict": "unsatisfied",
  "summary": "disjoint task invalidated certification",
  "failures": [
    {
      "id": "certification-isolation",
      "expected": "task B does not stale task A",
      "actual": "global authority sequence changed"
    }
  ],
  "metrics": {
    "passed": 17,
    "failed": 1
  }
}
```

Judge 和 Strategy 必须分离：

- Judge 说明哪里未满足；
- Strategy 决定下一步怎么做。

criterion 不应逐渐演化成一个不可审计、能够隐式决定行动的 Agent。

### 3.5 Loop Journal

建议为每个 task 建立独立的 provider-neutral Loop Journal，记录：

- LoopSpec digest；
- episode open/close；
- round open/close；
- directive intent；
- observation；
- judgment；
- decision；
- budget consumption；
- amendment；
- suspension 和 terminal。

Loop Journal 与 provider task identity、attachment digest 绑定。

Provider journal 仍然拥有身份、claims 和制品 receipt；Loop Journal 拥有循环状态。
两者之间通过经过验证的 digest 引用连接，而不是互相复制事实。

## 4. 最小公开协议

第一阶段不应先实现自动 daemon。建议先建立可被任意宿主驱动的四个命令：

```text
loop-open
loop-next
loop-observe
loop-amend
```

### `loop-open`

- 验证并冻结 LoopSpec；
- 建立或绑定 provider task；
- 记录 artifact baseline；
- 创建第一轮。

### `loop-next`

- 根据当前持久化状态返回唯一 directive；
- 在状态未变化时重复调用必须返回同一 directive；
- 不执行 directive；
- 不自行获得宿主执行权。

### `loop-observe`

- 提交 directive 的执行结果；
- 绑定 provider receipt 和 artifact checkpoint；
- 关闭当前 directive；
- 触发或准备 judgment。

### `loop-amend`

- 由用户修改目标、预算、claims、criterion 或策略；
- 记录明确的 provenance；
- 使受影响的旧 directive 或 judgment stale。

现有的 `status`、`audit`、`ledger` 和 `certify` 继续作为底层及诊断接口。

关键原则不是让 CLI 自己持续运行一个隐藏的 `while` 循环，而是：

> 每次调用只推进一个可重放的状态转换，完整循环由宿主反复驱动。

## 5. 默认循环策略

第一版不需要 LLM strategy。应先实现机械、确定、可测试的默认策略：

```text
没有制品变化
  → implement

有变化但没有合法 receipt
  → reconcile / produce_receipt

有 receipt、尚未判断
  → judge

criterion satisfied
  → achieved

criterion unsatisfied 且 failure signature 新
  → repair

同一 progress signature 重复达到阈值
  → review 或 stuck

criterion indeterminate
  → collect_evidence

预算耗尽
  → suspended: out_of_budget

需要用户决定
  → suspended: needs_input
```

### 5.1 Progress Signature

`progress_signature` 不应只根据自然语言错误文本计算，而应绑定：

```text
artifact checkpoint
+ criterion definition digest
+ normalized failure identifiers
+ relevant receipt digest
```

只有 failure 相同且 artifact 没有实质变化时，才算重复失败。

### 5.2 Budget

建议第一阶段支持：

- rounds；
- wall-clock；
- writes。

output-token budget 只能在宿主能提供可靠计量时启用，不能从不完整 transcript
推断成权威事实。

预算耗尽应进入可恢复的 `suspended: out_of_budget`，而不是直接 abandoned。

## 6. 演进顺序

### Phase 1：第一个可恢复闭环

只实现：

```text
loop-open
→ loop-next
→ loop-observe
→ criterion
→ continue / achieved
```

同时引入：

- round；
- structured observation；
- failure signature；
- round budget；
- crash-safe directive replay。

这是最重要的垂直切片。

前置条件（核对后追加）：动手前先完成 §2.3 的测试语料清理与门禁补齐，并与 §7.1、
§7.2 一起确定 `task_certified` 的 CAS 粒度、Loop Journal 的记录粒度与 journal
容量模型。这三者共用同一份持久化契约，分开推进会导致本阶段返工。

### Phase 2：反馈动力学

加入：

- stuck/no-progress 检测；
- indeterminate evidence collection；
- goal/budget amendment；
- wall-clock/write/token budget；
- suspend/resume；
- failure taxonomy；
- progress metrics。

完成这一阶段后，Workloop 才开始成为工程闭环，而不是 provider task 包装器。

### Phase 3：多 Agent 与 Judgment Loop

将 review 建模成子循环：

```text
主循环
  → 发出 review directive
  → 建立独立 reviewer task
  → reviewer 生成绑定 revision/rubric 的 judgment receipt
  → 主循环消费 receipt 并继续
```

支持：

- self-reread；
- fresh-context review；
- second-model review；
- reviewer independence provenance；
- blocking findings 回流主循环。

Review receipt 是概率性工程证据，不应替代确定性的 acceptance criterion。

### Phase 4：Meta Loop

Meta Loop 不直接修改自身，而应：

1. 聚合多个 loop 的 failure signature；
2. 识别重复的 stuck、retry 和 escalation；
3. 产生一个可证伪的流程改进假设；
4. 打开一个新的普通 Workloop；
5. 使用相同的 criterion 机制验证改进是否有效。

最终形成：

```text
任务循环优化制品
元循环优化任务循环
```

## 7. 第一阶段只需要的 Authority 修复

不应在 Loop Engineering 垂直切片之前，投入大量时间重写全部 authority。

第一阶段只优先修复三个阻塞循环正确性的底座问题。核对后需要修正一处预期：其中
7.1 与 7.2 触及持久化 schema 与 journal 容量模型，属于 Phase 1 的**前置**变更，
不是可以边做垂直切片边顺手完成的局部修补。7.3 才是真正独立的小修补。

### 7.1 任务级 Certification CAS

当前 certification 不能再绑定整个 authority 的全局 sequence。

已核对的现状：`lib/git-authority-provider.mjs` 的 `certifyCurrentGitTask` 用
`records.length !== prepared.prepared_sequence` 做 CAS，而 criterion 在 prepare
与 certify 之间的锁外窗口执行。实测中，一个 claim 完全不相交（`docs` 对 `src`）、
由另一个 session 发起的 `join`，足以让目标任务的认证失败：

```text
workloop: authority, attachment, or task changed during criterion execution
```

**这一条的修复成本高于本节其余两条。** `prepared_sequence` 不只是 CLI 里的一次
比较，它已经写进 replay 契约：`lib/authority-state.mjs` 在重放 `task_certified`
时强制要求 `payload.prepared_sequence === record.sequence - 1`。改为任务级 CAS
需要同时变更持久化 payload schema、replay 验证器与既有 journal 的兼容读路径，
属于 schema 变更而非局部修补。

建议绑定：

```text
authority_id
+ task_id
+ task_revision
+ attachment_final_digest
+ claim_digest
+ artifact revision / clean receipt
+ criterion definition digest
```

不相交任务的活动不得破坏当前 round。

### 7.2 终结与恢复容量储备

循环会比单次任务产生更多事件。任何普通写入之后，都必须仍然保留足够容量执行：

- suspend；
- abandon；
- terminal；
- placement recovery；
- tail recovery。

已核对的现状：`MAX_AUTHORITY_BYTES` 是 4 MiB 硬上限，所有 append 共用同一处上限
检查，只有 tail recovery 在 `lib/authority-tail-recovery.mjs` 中为自己的恢复
receipt 预留了容量。`task_terminal` 与 `task_suspended` 没有任何保留额度——journal
写满后，任务将无法被终结或挂起。

需要说明根因：真正的约束不是"储备策略"，而是 4 MiB 硬上限加上没有分层与 epoch
rollover。只按储备额度修补只会推迟撞墙时间。§3.5 的独立 Loop Journal 会显著提高
append 频率，因此 7.1 的 CAS 粒度、7.2 的容量模型与 Loop Journal 的记录粒度必须
一起设计，否则 Phase 1 必然返工。

### 7.3 公共 Placement Recovery

崩溃后不能要求用户手工编辑 journal。

每个 durable placement intent 都必须有幂等的 public complete 或 abandon 出口。

已核对的现状：`placement_intents` 的 status 枚举只有 `pending` 与 `ready`，且
replay 强制 pending 唯一。任何卡住的 exclusive placement intent 都会让后续所有
exclusive `open` 以 `EXCLUSIVE_PLACEMENT_PENDING` 失败，而公开动词表中没有任何
放弃该 intent 的出口——唯一退路是用完全相同的 command 重跑。

全面性能优化可以根据真实 round 流量继续推进。但日志分层与 epoch rollover 不再
属于"可以延后"：按 7.2 的分析，它们是 Loop Journal 上线后第一个切片就会撞到的
约束，应与 7.1、7.2 一并纳入 Phase 1 的前置设计。

## 8. 第一条产品验收场景

第一条端到端测试应覆盖：

1. 用户使用 goal、criterion、claims 和 3-round budget 打开 loop；
2. `loop-next` 返回 implement directive；
3. Agent 修改代码并提交 observation；
4. criterion 返回结构化 `unsatisfied`；
5. 进程退出并切换到另一个 session；
6. `loop-next` 返回 round 2 repair directive，并携带 round 1 的 failure signature；
7. 第二次失败，但 artifact checkpoint 发生变化，因此允许继续；
8. 第三次满足 criterion；
9. Workloop 验证 receipt 并终结为 `achieved`；
10. 再次调用 `loop-next` 只能返回相同 terminal decision。

同时断言：

- 另一个不相交 task 的活动不影响该循环；
- 相同 failure 和相同 artifact 连续达到阈值会进入 `stuck`；
- budget 耗尽进入 `suspended`；
- crash 后未完成 directive 可重放；
- 一个 directive 不会被两个 session 同时消费；
- runtime 从未自行执行工具或越过宿主批准；
- terminal judgment 可以从 authority 与 Loop Journal 独立重放验证。

## 9. 不建议优先实施的方向

### 9.1 不先做自动 Agent Runner

如果 Loop Kernel 尚未稳定，自动 runner 只会把不确定行为包装在一个后台循环里，
并放大恢复、授权和重复执行问题。

### 9.2 不先做 LLM Strategy

在机械策略、结构化反馈和 progress signature 尚未成立前，LLM strategy 无法被可靠评估，
也难以区分“策略有效”与“模型碰巧成功”。

### 9.3 不直接复活旧 runtime

旧 rounds、budget 和 event vocabulary 可以作为设计输入，但不能直接接回 provider 模块。
新的 Loop Kernel 应通过明确的 provider port 使用当前 authority，而不是让 provider
重新依赖已退役 task runtime。

### 9.4 不把 Hook Evidence 当成循环判断

Hook evidence 可以说明某个工具被调用过，但不能单独证明：

- 制品已经正确改变；
- 改变属于当前 task；
- criterion 已经满足；
- 宿主批准了下一步；
- 当前循环取得了进展。

循环判断必须以 artifact checkpoint、task receipt 和 criterion judgment 为基础。

## 10. 最终推荐

主线应当是：

> 保留 provider authority 作为可靠内核，在其上建设一个可持久化、可驱动、
> 可组合、可恢复、可反思的反馈循环系统。

建议以一个完整的三轮修复场景作为架构切口，而不是先扩大底层抽象：

```text
Goal Contract
  → Durable Directive
  → Host Execution
  → Structured Observation
  → Independent Judgment
  → Deterministic Next Decision
```

当这条链能够跨进程和跨 Agent 稳定运行时，Workloop 才真正从
provider authority runtime 迈入 Loop Engineering Runtime。

## 附录 A：核对证据（2026-07-25）

本附录记录 2026-07-25 针对本文事实基础的源码核对与本地复现结果。核对只使用仓库
源码、测试与 CLI，未引用 `docs/` 下的其他文档。

### A.1 验证基线

干净环境下门禁全绿：

```text
env -u CLAUDE_CODE_SESSION_ID -u WORKLOOP_SESSION_ID npm test
# tests 82 / pass 82 / fail 0
```

### A.2 测试隔离缺陷

在 Claude Code 会话内直接运行 `npm test` 会出现 3 项失败，全部位于
`tests/git-linked-worktree-authority.test.mjs`。

根因：`lib/provider-application.mjs` 的 `sessionId()` 以 `WORKLOOP_SESSION_ID`
优先、`CLAUDE_CODE_SESSION_ID` 兜底。fixture 未隔离后者，导致 `status` 携带宿主
会话身份，被判定为 foreign session，`routable` 返回 `false`。

这是测试隔离缺陷，不是运行时回归——fixture 应显式清除这两个环境变量。循环运行时
将比现在更频繁地依赖 session identity，因此这项隔离应在 Phase 1 之前修好。

### A.3 不相交任务破坏认证（§7.1 复现）

复现步骤：

1. 同一仓库开两个 claim 不相交的任务：A 声明 `src`，B 声明 `docs`；
2. 任务 A 完成 `stage` 与 `commit`，取得干净 receipt；
3. 用一个耗时约 4 秒的 tri-state criterion 对 A 执行 `certify`；
4. 在 criterion 执行窗口内，由第三个 session 对任务 B 执行 `join`。

结果：

```text
[bg] session sess-c joined DISJOINT task B
workloop: authority, attachment, or task changed during criterion execution
```

任务 B 与任务 A 在 claim、session、制品上完全不相交，仍然使 A 的认证作废。

### A.4 核对得出的三条修正

- **§2.1**：suspend/resume 已在 substrate 中实现，不属于缺失项。
- **§2.2**：化石范围应按 35/58 个零消费导出计，并补充 §2.3 的失效测试语料。
- **§7.1、§7.2**：均触及持久化契约，属 Phase 1 前置变更，成本高于原文预期。
