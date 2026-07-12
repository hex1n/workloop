# taskloop 判据术语与状态模型改进方案

**类型**：破坏性重构方案（已实现）
**日期**：2026-07-11
**范围**：判据观测、任务生命周期、收口约束、启动策略、CLI、ledger、hook
**演进策略**：clean break；不保留上一版接口、字段、状态编码或历史数据读取能力
**依据**：`lib/criterion.mjs`、`lib/task-engine.mjs`、`lib/application.mjs`、`README.md`、`skills/loop-core/REFERENCE.md`、`skills/workloop/SKILL.md` 现状实读

**验证**：`npm test`；初始切换见 `docs/e2e-test/criterion-vocabulary-state-model/e2e-run-criterion-vocabulary-state-model-20260712-014613/execution-report.md`；Claude 复审修复见 `docs/e2e-test/criterion-vocabulary-state-model/e2e-run-review-fixes-20260712-093920/execution-report.md`

## TL;DR

taskloop 应停止把 `red` / `green` 当作正式领域状态。颜色天然携带 TDD 语境，也把“判据观测”“任务是否终结”“现在能否收口”混在了一起。

本方案直接建立单一语义模型，并一次性切换所有公共表面：

- 判据术语统一为 `unsatisfied` / `satisfied` / `indeterminate`；
- 生命周期统一为 `active | suspended(reason) | terminal(outcome)`；
- 收口资格由事实派生为 `not_ready | held | eligible`，不持久化缓存；
- 启动行为拆成互相正交的 open、witness、close 三项策略；
- `task.json`、CLI、ledger、hook、README 和 skills 在同一版本切换；
- 删除 `red` / `green` 领域词、`earn_red` / `red_witnessed` / `keep_green` 字段及对应 CLI 参数；
- 升级前的活动任务不迁移，升级后按新模型重新打开；历史 ledger 不进入新 runtime 的读取路径。

## 根问题

`red → green` 对 TDD 很自然，但 taskloop 的判据可以是测试、lint、构建、API/SQL 检查、外部证据 adapter 或回归守卫。颜色没有说明被观测的对象，并产生三类误读：

1. `green` 被误解成任务完成，而它只表示一次机器判据通过；
2. `red` 被误解成任务失败，而它通常只是工作尚未满足 done-when；
3. `red-at-birth` 被误解成 TDD 流程约束，而真正的不变量是判据在收口前证明过区分“未满足/已满足”的能力。

新用户心智模型应是：

> 任务默认在判据未满足时打开；工作使判据转为已满足；判据已满足且不存在收口阻断时，任务才可以终结为 achieved。

## 已验证的现状约束

- `lib/criterion.mjs` 已在执行边界区分 `pass` / `fail` / `indeterminate`，三态执行机制无需重造，但公共领域投影需要统一命名。
- `lib/application.mjs` 的 CLI 文案、启动参数和 Stop hook 输出大量暴露 red/green。
- `lib/task-engine.mjs` 与 outcome ledger 持久化 `earn_red`、`red_witnessed`、`keep_green` 等字段。
- 默认 open 会立即运行判据：普通任务必须得到未满足才创建；无法裁决会拒绝；已满足只有显式策略才能创建。
- 当前 runtime 对 state-dir/unresolved 弱判据只要求 fresh-context/second-model review provenance，或显式 provisional；它还不是 verdict 闸门。正式模型有意升级为下文定义的协作式 review acceptance gate，这是 clean break 的行为变化。
- 当前默认任务在 amend 判据后不会为新传感器重置或重建未满足见证；这违反“当前传感器必须证明过区分能力”的不变量，必须随模型切换修正。

## 正式语义模型

### 1. 判据观测

```text
unsatisfied    判据未满足
satisfied      判据已满足
indeterminate  判据无法裁决
```

规则：

- 人类文案始终写完整的“判据未满足/已满足”，不单独写“失败/成功”；
- `satisfied` 不等于目标已达成，也不等于任务已完成；
- adapter 的 exit code 保持 `0/1/2`，边界映射为 `satisfied/unsatisfied/indeterminate`；
- 新鲜度、输入漂移是对观测有效性的判断，不新增 `fresh` 或 `stale` 持久化 verdict。

规范指纹词汇：

- `criterion_definition_hash`：判据定义的稳定内容哈希，覆盖命令或文件、协议、timeout、声明输入、subjects 与其他 trust exemption；相同定义得到相同哈希；
- `criterion_generation_id`：判据世代的不可复用标识，在 open 时生成，任何影响判据定义、输入声明或信任豁免的 amend 都生成新值，即使 definition hash 最终未变；
- `criterion_input_fingerprint`：判据输入内容快照，用于判断 sensor drift；
- witness 与 review 绑定 `criterion_generation_id`；definition hash 用于比较定义是否相同，不能用于复用上一世代的证明；输入内容变化由 drift 独立裁决。

这个拆分消除两种冲突：逻辑定义保持可比较，amend 又必然建立新的证明边界。任何 generation 变化都使 witness 和 review 立即过期。

## 判据执行结果映射

执行层先产生结构化结果，再映射为领域 observation：

| protocol / 执行结果 | observation | execution_error |
|---|---|---|
| `binary`, 正常退出 0 | `satisfied` | `null` |
| `binary`, 正常退出非 0 | `unsatisfied` | `null` |
| `tri-state`, 正常退出 0 | `satisfied` | `null` |
| `tri-state`, 正常退出 1 | `unsatisfied` | `null` |
| `tri-state`, 正常退出 2 | `indeterminate` | `adapter_indeterminate` |
| `tri-state`, 其他正常退出码 | `indeterminate` | `invalid_adapter_exit` |
| spawn/ENOENT/权限拒绝 | `indeterminate` | `spawn_failed` / `command_not_found` / `permission_denied` |
| timeout | `indeterminate` | `timeout` |
| signal 终止 | `indeterminate` | `signal:<name>` |

`indeterminate` 在 open 时拒绝创建任务；在 active task 中产生 `not_ready(criterion_indeterminate)`，不取得 witness、不烧失败轮次，也不能被 `--provisional` 解除。stdout/stderr tail、exit code、signal、duration 和 timeout 必须进入 observation evidence，但不得把基础设施错误伪装成判据未满足。

判据和 adapter 必须只读、幂等。每次 runtime 执行 criterion 都在前后采集仓库快照（tracked 与 untracked、排除 `.taskloop/`；内容相同的临时改写不算变化）。若快照变化：本次 observation 强制为 `indeterminate`、`execution_error=criterion_side_effect` 并拒绝收口；已有 task 时递增 artifact/substantive revision、使 review 过期，open 阶段则拒绝创建并列出变化路径。该规则同时适用于 Stop、`achieve` 和诊断性 `verify`；runtime 自己启动的子进程不能绕过 artifact revision。

### 2. 任务生命周期

逻辑模型与持久化模型统一使用 sum type，避免 nullable 字段组合出非法状态：

```text
active
suspended(reason)
terminal(outcome)
```

```text
reason  = needs_input | stuck | out_of_budget
outcome = achieved | not_needed | abandoned
```

`task.json` 直接编码该模型。不存在同时携带 suspension 与 terminal outcome 的对象，也不存在用 `state=open` 加可空字段推断真实生命周期的路径。

### 3. 收口资格

```text
not_ready(reason)
held(reasons[])
eligible
```

收口资格是 `active` 任务的派生视图：

- 判据 `unsatisfied` → `not_ready(criterion_unsatisfied)`；
- 判据 `indeterminate` → `not_ready(criterion_indeterminate)`；
- 当前 generation 尚无 observation → `not_ready(criterion_unobserved)`；
- 判据 `satisfied` 且存在策略或信任约束 → `held(reasons[])`；
- 判据 `satisfied` 且无 hold → `eligible`；
- `suspended` / `terminal` → `closure: null`，分别由 resume 或终态语义支配。

`eligible` 是咨询性投影，不是关闭授权。它只支配 `achieved` 路径：`close_policy=automatic` 表示下一次 Stop 的现场重跑若仍满足即可自动写入 `terminal(achieved)`；`close_policy=explicit` 表示只有显式 `achieve` 在现场重跑后才能写入 `terminal(achieved)`。真正关闭为 achieved 时必须现场重跑，不能复用 status 投影。

`not_needed` 与 `abandoned` 不属于判据成功路径：前者要求只读 evidence 证明无需变更，后者要求明确 reason。两者都不要求 criterion satisfied，也不受 closure hold 或 `close_policy` 支配。

hold 必须由持久化事实派生：

| hold | 事实来源 |
|---|---|
| `sensor_drift` | 当前输入内容与 `criterion_input_fingerprint` 不一致 |
| `unsatisfied_not_witnessed` | 当前 `criterion_generation_id` 要求见证未满足，但 witness 不存在 |
| `weak_sensor_unreviewed` | 弱传感器策略要求 review，但当前 generation 与 artifact revision 没有 findings=0 的独立 review，也未显式 provisional |

不持久化 `closure_holds` 或 `next_action`。两者只由当前事实计算，避免缓存与事实源分叉。

### Review 新鲜度

现有 runtime 只记录 review provenance；本方案明确把弱传感器路径升级为**协作式 review acceptance gate**。runtime 不声称能密码学验证 reviewer 身份，但在协作信任边界内，只有当前产物上的独立、无阻塞项 review 才能解除 hold。每条 review 必须记录：

```text
criterion_generation_id
reviewed_task_revision
reviewed_artifact_revision
level = fresh_context | second_model | self_reread
reviewer
blocking_findings_count
advisory_findings_count
reviewed_at
```

只有 `fresh_context | second_model`、绑定当前 generation、`reviewed_task_revision == last_substantive_task_revision`、`reviewed_artifact_revision == artifact_revision` 且 `blocking_findings_count == 0` 的 review 才解除 `weak_sensor_unreviewed`；advisory findings 可存在但必须在 closeout 回显。`self_reread` 永远只作 telemetry。review 后任何机器目击的写形调用都会递增 `artifact_revision` 与 `last_substantive_task_revision`，即使工具随后失败也保守地使 review 过期；goal、alignment、criterion、policy、envelope 或 grant 的 amend 同样更新 substantive revision，其中 criterion/policy 还会建立新 generation。带 blocking findings 的 review 不由作者自行标记“已处理”，必须修改后重新取得 blocking=0 的独立 review。

CLI 由 reviewer/宿主明确提交 `--blocking-findings N --advisory-findings N`；runtime 只验证非负整数、review level 与 revision freshness，不判断 finding 内容。`--provisional` 是带 ledger 痕迹的显式降级，只能绕过这一 acceptance gate。

### 4. 打开、见证与关闭策略

启动行为直接表达为三个正交字段：

```text
open_requirement    = unsatisfied | determinate
witness_requirement = required | none
close_policy        = automatic | explicit
```

提供三个具名策略：

| policy | open_requirement | witness_requirement | close_policy | 用途 |
|---|---|---|---|---|
| `default` | `unsatisfied` | `required` | `automatic` | 普通实现或修复任务 |
| `deferred_witness` | `determinate` | `required` | `automatic` | 先写失败检查，再完成实现 |
| `steady_satisfied` | `determinate` | `none` | `explicit` | 以持续满足为正常状态的观察或守卫任务 |

witness 是绑定当前 `criterion_generation_id` 的事实：

```text
unsatisfied_witnessed(criterion_generation_id, observed_at, source_event)
```

- `default` 在 open 的未满足观测上取得 witness；
- `deferred_witness` 可在任务打开后取得 witness；
- amend 建立新 `criterion_generation_id` 后，原 witness 立即失效；
- `steady_satisfied` 豁免 witness，但 Stop 不得自动收口。

`determinate` 精确等于 `{unsatisfied, satisfied}`；`indeterminate` 在所有 policy 下都拒绝 open。它不是可持久化的启动状态。

策略组合必须通过构造器校验：

- `determinate + none + automatic` 会让已满足任务出生即可自动收口，拒绝；
- v1 只接受与具名 policy 精确对应的 tuple；
- 任一未命名或无法解释其收口行为的组合都不得写入 task。

v1 只接受下列三个 tuple，其他五种组合全部由构造器拒绝；未来如需开放，必须提升 schema 并新增具名 policy：

| open | witness | close | v1 判定 |
|---|---|---|---|
| `unsatisfied` | `required` | `automatic` | 允许：`default` |
| `unsatisfied` | `required` | `explicit` | 拒绝：无具名 policy |
| `unsatisfied` | `none` | `automatic` | 拒绝：无具名 policy |
| `unsatisfied` | `none` | `explicit` | 拒绝：无具名 policy |
| `determinate` | `required` | `automatic` | 允许：`deferred_witness` |
| `determinate` | `required` | `explicit` | 拒绝：无具名 policy |
| `determinate` | `none` | `automatic` | 拒绝：出生即自动收口 |
| `determinate` | `none` | `explicit` | 允许：`steady_satisfied` |

CLI 使用 kebab-case：`deferred-witness`、`steady-satisfied`；task schema 和 ledger 使用 snake_case：`deferred_witness`、`steady_satisfied`。open 将 CLI 名映射为 tuple 后只持久化 tuple，同时持久化 `policy_rationale`：`default` 为 `null`，另外两种必须是非空 reason。

## 规范 task schema

新 schema 直接成为唯一持久化表示。下例给出所有公共基字段；数组为空也必须存在，不能靠缺字段表达默认值：

```json
{
  "schema_version": 1,
  "task_id": "uuid",
  "task_revision": 1,
  "last_substantive_task_revision": 1,
  "artifact_revision": 0,
  "last_issued_event_sequence": 1,
  "created_at": "2026-07-11T00:00:00Z",
  "updated_at": "2026-07-11T00:00:00Z",
  "lifecycle": { "state": "active" },
  "goal": "observable outcome",
  "criterion": {
    "source": { "kind": "command", "value": "npm test" },
    "protocol": "binary",
    "timeout_seconds": 300,
    "declared_inputs": [],
    "subjects": [],
    "criterion_definition_hash": "sha256:...",
    "criterion_generation_id": "uuid",
    "criterion_input_fingerprint": null,
    "input_coverage": "unknown",
    "provenance": "unresolved",
    "last_observation": {
      "observation_id": "uuid",
      "verdict": "unsatisfied",
      "criterion_generation_id": "uuid",
      "observed_artifact_revision": 0,
      "observed_at": "2026-07-11T00:00:00Z",
      "execution": {
        "exit_code": 1,
        "signal": null,
        "duration_ms": 120,
        "execution_error": null,
        "output_tail": "..."
      }
    }
  },
  "policy": {
    "open_requirement": "unsatisfied",
    "witness_requirement": "required",
    "close_policy": "automatic"
  },
  "policy_rationale": null,
  "witness": {
    "criterion_generation_id": "uuid",
    "observed_at": "2026-07-11T00:00:00Z",
    "source_event": "open"
  },
  "alignment": {
    "because": "what the criterion exercises",
    "not_covered": ["deployment environment"]
  },
  "envelope": {
    "files": ["src/**"],
    "git": [],
    "destructive": false,
    "network": false
  },
  "grants": [],
  "budget": {
    "rounds": 8,
    "writes": null,
    "wall_clock_minutes": null,
    "output_tokens": null
  },
  "spent": {
    "rounds": 0,
    "writes": 0,
    "wall_clock_ms": 0,
    "output_tokens_estimate": 0
  },
  "evidence": {
    "touched_files": [],
    "criterion_input_drift": []
  },
  "reviews": [],
  "attempts": [],
  "episodes": []
}
```

`lifecycle` 是以下封闭 discriminated union；分支外字段禁止出现：

```text
Active = {
  state: "active"
}

Suspended = {
  state: "suspended",
  reason: "needs_input" | "stuck" | "out_of_budget",
  suspended_at: timestamp,
  judgment: {
    remaining: string,
    failure: string,
    next_action: string
  }
}

TerminalAchieved = {
  state: "terminal",
  outcome: "achieved",
  terminal_at: timestamp,
  closing_observation_id: uuid,
  provisional: boolean
}

TerminalNotNeeded = {
  state: "terminal",
  outcome: "not_needed",
  terminal_at: timestamp,
  evidence: string,
  verified_at_task_revision: integer
}

TerminalAbandoned = {
  state: "terminal",
  outcome: "abandoned",
  terminal_at: timestamp,
  reason: string
}
```

完整 lifecycle 样例：

```json
{"state":"suspended","reason":"needs_input","suspended_at":"2026-07-11T01:00:00Z","judgment":{"remaining":"credential","failure":"cannot authenticate","next_action":"user supplies access"}}
{"state":"terminal","outcome":"achieved","terminal_at":"2026-07-11T02:00:00Z","closing_observation_id":"uuid","provisional":false}
{"state":"terminal","outcome":"not_needed","terminal_at":"2026-07-11T02:00:00Z","evidence":"read-only check showed target already satisfied","verified_at_task_revision":4}
{"state":"terminal","outcome":"abandoned","terminal_at":"2026-07-11T02:00:00Z","reason":"superseded by a different goal"}
```

支持记录同样使用封闭 schema：

```text
Grant = {
  grant_id: uuid,
  kind: "git" | "destructive" | "network" | "install" | "whole_repo" | "criterion_subject",
  scope: string[],
  reason: string,
  granted_by: "user" | "self",
  granted_at_task_revision: integer
}

Review = {
  review_id: uuid,
  criterion_generation_id: uuid,
  reviewed_task_revision: integer,
  reviewed_artifact_revision: integer,
  level: "fresh_context" | "second_model" | "self_reread",
  reviewer: string,
  blocking_findings_count: non_negative_integer,
  advisory_findings_count: non_negative_integer,
  reviewed_at: timestamp
}

Attempt = {
  attempt_id: uuid,
  criterion_generation_id: uuid,
  artifact_revision: integer,
  signature: string,
  failure_summary: string,
  observed_at: timestamp
}

Episode = {
  episode_id: uuid,
  host_session_id: string,
  started_at: timestamp,
  ended_at: timestamp | null,
  start_task_revision: integer,
  end_task_revision: integer | null,
  output_tokens_estimate: non_negative_integer
}
```

字段与跨字段约束：

- `schema_version: 1` 以外的 task 文件直接报错，并提示结束现有任务后重新 `open`；
- runtime 不推断缺失字段，不把其他形状补齐为默认值；
- `task_revision` 从 1 开始，每次成功持久化状态变化递增；`artifact_revision` 从 0 开始，每次 PreToolUse 允许写形调用时保守递增；
- `last_substantive_task_revision` 只在 goal、alignment、criterion、policy、envelope、grant 或 artifact 变化时更新为新 task revision；observation、review 记录和 ledger telemetry 不更新它；
- `last_issued_event_sequence` 在任何需要追加 ledger event 的 task commit 中先递增并持久化；append 使用该值，失败后也不回退；
- `task_id`、`created_at` 创建后不可变；`updated_at` 必须对应当前 `task_revision`；
- `criterion.last_observation` 必须是 `null | Observation`；open 成功后非空，criterion/policy/trust amend 建立新 generation 时原子设置为 null；
- 非空 observation 的 id 全 task 唯一，且 `criterion_generation_id` 必须等于当前 generation，否则 observation 无效；
- `witness` 仅在当前 policy 要求且已经目击 unsatisfied 时为对象；其余为 `null`，不得省略；
- `criterion_input_fingerprint` 在 coverage 未知时为 `null`；`input_coverage` 必须明确为 `full | partial | unknown`；
- `provenance` 必须为 `repo | state_dir | unresolved`；`state_dir | unresolved` 或非 full coverage 触发弱传感器策略，projector 不持久化额外 strength 缓存；
- review 项必须包含 `criterion_generation_id`、`reviewed_task_revision`、`reviewed_artifact_revision`、level、reviewer、blocking/advisory findings counts、reviewed_at；
- grant 项必须包含 kind、scope、reason、granted_by、granted_at_task_revision；attempt 与 episode 必须携带各自 id 和起止 revision；
- `terminal(achieved).closing_observation_id` 必须引用 `criterion.last_observation.observation_id`；该 observation 必须 satisfied、绑定当前 generation 与当前 artifact revision；另外两种 terminal 分支禁止携带 closing observation id；
- `not_needed` 只允许在 `spent.writes == 0` 时产生；已经发生写形调用的任务只能 achieved 或 abandoned；
- task 只持久化展开后的 policy tuple，不同时保存 preset 名；CLI preset 只负责在 open 时构造并校验 tuple；
- outcome ledger 只写正式事件形状，audit 只读取正式 ledger 文件；
- 安装器切换 runtime 时不得自动改写目标仓库的 task 状态或用户级 ledger。

## 状态转移与守卫

所有 lifecycle 改变只由 `task-engine` 的封闭 transition 完成：

| 当前状态 | 事件/命令 | 守卫 | 下一状态/效果 |
|---|---|---|---|
| 无 task | `open` | criterion determinate；policy tuple 合法；default 必须 unsatisfied | `active`，新 task id/generation；按 Witness 表处理 |
| `terminal` | `open` | task state 已是 terminal | 新 `active` task；不读取 ledger，不复用 id/budget/proof |
| `active` | PreToolUse read | 无 | 放行，不改 revision |
| `active` | PreToolUse write | envelope、grant、budget、命令安全均通过 | 放行；递增 task/artifact/substantive revision；旧 review 过期 |
| `active` | `verify` | 无 | 运行判据并回显；正常时不改 task；若 criterion 有副作用，仅更新 artifact/substantive revision 并使 review 过期，不写 witness/observation/budget |
| `active` | Stop | 当前 episode owner；未 suspended | 现场观测；unsatisfied 记录 attempt/witness 并计 round，satisfied 按 closure/close policy 裁决，indeterminate 不计 round |
| `active` | `amend` | reason 非空；扩权满足 grant 规则 | 保持 active；递增 task/substantive revision；criterion/policy/trust 改动建立新 generation、清空 witness/review 并把 last_observation 设为 null |
| `active` | `suspend` | reason 与 judgment 三行完整 | `suspended(reason)` |
| `active` | `achieve` | fresh satisfied；当前 generation/artifact；closure eligible；explicit/automatic 路径匹配 | `terminal(achieved)` |
| `active` | `not-needed` | evidence 非空；`spent.writes == 0` | `terminal(not_needed)` |
| `active` | `abandon` | reason 非空 | `terminal(abandoned)` |
| `suspended` | read/`status`/`verify` | 无 | 保持 suspended；verify 正常时只回显，若 criterion 有副作用则按 active verify 更新 revisions 并使 review 过期 |
| `suspended` | Stop | 无 | release：stdout 空、exit 0；不改 revision、round、episode 或 observation |
| `suspended` | PreToolUse write/`achieve`/`not-needed` | 无 | 拒绝；必须先 resume（abandon 除外） |
| `suspended` | `amend` | reason 非空；扩权满足 grant 规则 | 保持 suspended；按 active amend 更新 revisions/generation/observation |
| `suspended` | `resume` | reason 非空；若 out_of_budget，预算先经 amend 扩充 | `active`，新 episode |
| `suspended` | `abandon` | reason 非空 | `terminal(abandoned)` |
| `terminal` | 任一 mutating verb（除新 `open`） | 无 | 拒绝；terminal 不可复活或改写 |

`achieve`、`not-needed`、`abandon` 是三条互斥终结路径。`suspended` 不是第四种终态；除了显式 abandon，必须 resume 回 active 后才能选择终结路径。

## Witness 产生规则

只有会写入任务事实且受锁保护的 metered event 可以产生 witness：

| event | observation | 产生 witness？ | 其他效果 |
|---|---|---|---|
| `open` | `unsatisfied`，policy requires witness | 是，`source_event=open` | 创建 task；不计 round |
| `open` | `satisfied` | 否 | 仅 determinate policy 可创建；closure 可能 held |
| `open` | `indeterminate` | 否 | 拒绝创建 |
| Stop | `unsatisfied`，active owner，policy requires witness | 是，`source_event=stop` | 计 round、记录 attempt |
| Stop | `unsatisfied`，policy has no witness requirement | 否 | 计 round、记录 attempt |
| `achieve` | `unsatisfied`，policy requires witness | 是，`source_event=achieve` | 拒绝终结、计 round、记录 attempt |
| `achieve` | `unsatisfied`，policy has no witness requirement | 否 | 拒绝终结、计 round、记录 attempt |
| Stop/`achieve` | `satisfied` | 否 | 使用已有 witness 裁决 closure |
| Stop/`achieve` | `indeterminate` | 否 | not_ready，不计 round |
| `verify` | 任意 | 否 | 不写 witness/observation/budget；criterion side effect 例外地更新 artifact/substantive revision |
| `amend`/`resume`/PreToolUse | 不运行判据 | 否 | 不得凭缓存结果生成 witness |

witness 的 generation 必须与当前 criterion generation 相同；同一 generation 首次目击 unsatisfied 后重复目击只更新时间与 provenance，不产生多张票。criterion/policy/trust amend 先建立新 generation，再清空 witness 与 generation-bound review，禁止把 amend 前的 observation 带入新世代。

## 规范 outcome ledger 事件

新 runtime 写入独立文件 `~/.taskloop/outcomes-v1.jsonl`，不复用其他事件文件。每行必须满足：

```json
{
  "event_schema_version": 1,
  "event_id": "uuid",
  "task_id": "uuid",
  "task_schema_version": 1,
  "task_revision": 1,
  "task_event_sequence": 1,
  "kind": "task_opened",
  "occurred_at": "2026-07-11T00:00:00Z",
  "repo_identity": "sha256:...",
  "payload": {}
}
```

`kind` 的封闭集合为：

```text
task_opened | task_amended | task_reviewed |
task_suspended | task_resumed | task_terminal
```

## Ledger payload schema

每个 kind 的 `payload` 都是封闭对象，未知字段拒绝写入：

| kind | required payload |
|---|---|
| `task_opened` | goal、policy tuple、policy_rationale、criterion definition/generation、initial observation、alignment、envelope、budget |
| `task_amended` | changed_fields、reason、before/after substantive revision；若 generation 改变则含 before/after generation 与 definition hash；若扩权则含 grants |
| `task_reviewed` | level、reviewer、criterion_generation_id、reviewed_task_revision、reviewed_artifact_revision、blocking/advisory findings counts、reviewed_at |
| `task_suspended` | reason、judgment、spent、artifact_revision |
| `task_resumed` | reason、new_episode_id、spent |
| `task_terminal` + achieved | outcome、closing_observation_id、provisional、spent、review_level、artifact_revision |
| `task_terminal` + not_needed | outcome、evidence、verified_at_task_revision、spent |
| `task_terminal` + abandoned | outcome、reason、spent |

顺序与损坏语义：

- `task_event_sequence` 在每个 task 内从 1 单调递增，由 task state 的 `last_issued_event_sequence` 分配；task state 先提交，ledger 后追加，因此 append 失败可导致 sequence gap，但不能回滚 task；
- `event_id` 确定性地由 `(task_id, task_revision, kind)` 生成；同一已提交 revision 的重试得到相同 id。ledger 是 best-effort telemetry，本方案不增加可靠 outbox；崩溃后允许该事件永久缺失，由后续 sequence gap 或未闭合 open 体现，而不是阻塞 task；
- event id 相同且字节相同的重复行按幂等重放去重并告警；event id 相同但内容不同、sequence 倒退或 payload 不合 schema 视为 corruption；
- sequence gap 视为 telemetry incomplete：audit 继续读取其他行、退出 1，并报告缺失范围；corruption 时 audit 隔离坏行、继续汇总可信行、退出 2；完整数据退出 0；
- runtime 的 task 裁决永不读取 ledger；append 失败继续保持 degrade-open，但必须在 stderr 报出丢失的 task id、revision 与 sequence；
- audit 只打开 `outcomes-v1.jsonl`，不会扫描或归一其他 ledger 文件。

约束：

- `task_terminal.payload.outcome` 只能是 `achieved | not_needed | abandoned`；
- `task_suspended.payload.reason` 只能是 `needs_input | stuck | out_of_budget`；
- 每行的 `task_revision` 必须等于产生该事件的已提交 task revision；同一 revision 最多有一个 lifecycle event，但可有具名的 review/amend event；
- policy、criterion observation、witness、review、grant 和成本字段都使用正式词汇；
- audit 遇到不满足 `event_schema_version: 1` 的行即报告 ledger corruption，不做字段猜测；
- `info` 暴露 `task_schema_version: 1`、`ledger_event_schema_version: 1` 和 ledger 路径。

## CLI 与 hook

CLI 直接采用新词汇：

```text
taskloop open --criterion-policy default \
  --alignment-because "what the criterion exercises" \
  --not-covered "deployment environment"
taskloop open --criterion-policy deferred-witness --reason "..." ...
taskloop open --criterion-policy steady-satisfied --reason "..." ...

taskloop achieve [--provisional]
taskloop not-needed --evidence "..."
taskloop abandon --reason "..."
taskloop review --level fresh-context|second-model|self-reread \
  --reviewer "..." --blocking-findings N --advisory-findings N
```

`--alignment-because` 必填，`--not-covered` 可重复；CLI 直接构造结构化 alignment，不解析格式化句子。三个终结动词分别且仅能写入 `achieved`、`not_needed`、`abandoned`。

- `achieve` 必须取得 fresh satisfied，且 closure 无 hold；`--provisional` 只能解除 `weak_sensor_unreviewed`，不能解除 drift 或 witness hold；
- `not-needed` 必须携带只读 evidence，不运行 achieved 收口门；
- `abandon` 必须携带 reason，不运行 achieved 收口门。

CLI 枚举统一使用 kebab-case，持久化统一使用 snake_case：`fresh-context → fresh_context`、`second-model → second_model`、`self-reread → self_reread`。未知拼写直接拒绝，不做宽松归一。

删除：

```text
--earn-red
--keep-green
--alignment
done
earn_red
red_witnessed
keep_green
state: done
```

公共输出统一切换：

```text
taskloop: criterion unsatisfied
taskloop: criterion satisfied; closure held: unsatisfied_not_witnessed
taskloop: criterion indeterminate
```

hook 协议与 CLI 同版本发布，`info.runtime_contract` 一次性提升为 `2`。输入继续采用宿主定义的 PreToolUse/Stop payload；runtime 输出固定为：

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"taskloop: ..."}}
{"decision":"block","reason":"taskloop: criterion unsatisfied ..."}
```

- PreToolUse allow 与 Stop release：stdout 为空、exit 0；
- PreToolUse deny：第一种 JSON、单行 LF、exit 0；
- Stop block：第二种 JSON、单行 LF、exit 0；
- runtime/configuration failure：stderr 给出有界错误，stdout 不伪造 allow/block verdict，采用已定义的 fail-open/fail-closed 边界；
- Claude 与 Codex 的输入 payload fixture、上述输出字节和 `info.runtime_contract=2` 都由 golden test 固定。

协议消费者必须使用新 runtime 生成的配置；同一 runtime 不提供两套文案或协商分支。

## 不相容状态的恢复

新 runtime 解析 task 前只读取顶层 `schema_version`。不是 v1 时，所有普通 mutating verb fail closed，但提供一个不理解内容的维护命令：

```text
taskloop archive-incompatible-state --repo <repo> \
  --reason "upgrade to schema v1" --granted-by user
```

该命令不解析、不迁移、不重写原 task，只执行：

1. 确认 `.taskloop/task.json` 是仓库内普通文件而非 symlink；
2. 计算原文件摘要并创建 `.taskloop/archive/incompatible-<timestamp>-<digest>-<uuid>.json`；
3. 使用同目录原子 rename 移走当前文件；UUID 保证同秒同内容归档不撞名，跨设备时拒绝；
4. 写一个不含原内容的 receipt，记录 source path、archive path、digest、reason、granted_by 和时间；
5. 此后用户显式运行新 `open`，新 task 不继承原 id、预算、proof 或 ledger lineage。

命令要求当前用户明确授权；`open --force` 不得隐式触发。升级说明优先要求在切换前用原 runtime 结束活动任务，归档命令只处理已经升级后无法解析的遗留状态。归档是可逆的文件保全操作，不是读取上一版语义。

## 安装切换边界

runtime shim 与 Claude/Codex skill 根分处不同目录，文件系统无法把它们作为一个原子事务切换。本方案不伪造该担保，而是把升级定义为明确的维护窗口：切换期间不得有活动 Claude/Codex 会话，完成后新开会话。

安装器按以下顺序执行：

1. 对 Claude/Codex skill root 做 realpath 去重；两者指向同一目录时只生成一个 activation target，但 manifest 保留两种 runtime provenance；
2. 把带同一 `release_id`、内容摘要和 `runtime_contract: 2` 的 runtime、workloop、loop-core 写入每个唯一目标根的 staging 目录；
3. 验证 staging 内容闭包、摘要、skill 相对链接和 runtime/skill contract 一致；
4. 获取 owner-token 安装锁；在锁内重新读取 active manifest 和盘上摘要。未受管、本地修改、symlink 或外部 takeover 的 skill 立即中止且保持原样；
5. 把每棵仍受管的旧 skill 树 rename 到同根 rollback 目录，保留到整个事务提交；记录包含 before/after digest、realpath target 和步骤状态的 activation journal；
6. 逐个把 staging skill rename 到稳定目录，每步 fsync/更新 journal；
7. skills 全部就位后，最后切换稳定 runtime shim；
8. 写入 active release manifest；再次核对全部稳定目标摘要后，才删除 rollback、staging 与 journal。

任一步失败都返回非零并保留旧树与 journal；重跑安装器根据 journal、active manifest 和盘上摘要决定继续新 release 或恢复 rollback，不能凭路径存在就宣称所有权。若任何目标已被用户修改或接管，恢复/继续都停止并给出人工处置清单，不覆盖该目标。最终必须收敛到完整的上一 release 或完整的新 release，不能把混合版本报告为成功。

故障测试覆盖：Claude/Codex roots alias、未受管同名目录、本地修改、外部 takeover、symlink 拒绝，以及每个 staging/backup/swap/shim/manifest/cleanup 中断点的继续与回滚。维护窗口负责避免宿主在短暂中间态读取文件，不把跨目录原子性当作实现能力。

## 实施计划

各切片可在开发分支中逐步完成，但只允许一次性切换发布，不能把中间形态交付给用户。

### 切片 1：冻结语义契约

- 固定 observation、lifecycle、closure、policy、witness 的类型与不变量；
- 固定新模型的 `schema_version: 1` 和 ledger 事件形状；
- 建立穷举真值表，先让新模型在测试中完整表达。

必须覆盖：

1. 默认未满足打开；
2. 未满足后满足且可收口；
3. deferred_witness 的未见证 hold；
4. 见证未满足后重新满足；
5. steady_satisfied 不自动收口；
6. active + indeterminate → not_ready；
7. satisfied + sensor drift；
8. satisfied + weak sensor unreviewed；
9. suspended + 最近观测 satisfied → closure null；
10. achieved 必须绑定收口时的新鲜 satisfied；
11. default 与 deferred_witness 在 amend 后都使原 witness 失效；
12. 非 v1 task 文件明确拒绝；
13. steady_satisfied + fresh satisfied 输出 eligible，但 Stop 不自动收口；
14. `not_needed` 只由 evidence 终结，不要求 satisfied；
15. `abandoned` 只由 reason 终结，不要求 satisfied；
16. engine 的 achieved 裁决与 closure projector 完全一致；
17. 相同 definition 的 criterion amend 仍生成新 generation，并使 witness/review 过期；
18. review 后写入、goal/alignment/envelope/grant amend 都使 review 过期；
19. active/suspended/terminal 的每个 mutating verb 符合转移表；
20. 只有 open/Stop/achieve 的 unsatisfied observation 能产生 witness，verify 永不产生；
21. 八种 policy tuple 只有三个具名组合可构造；
22. binary/tri-state 的全部 exit、spawn failure、timeout、signal 映射符合执行结果表；
23. 每种 ledger kind 的 payload、sequence gap、重复、corruption 和退出码符合 schema；
24. 不相容 task 只能经显式授权归档，归档前后摘要一致且 open 不继承 lineage；
25. amend 后 last_observation=null，projector 返回 criterion_unobserved，直到当前 generation 被 Stop/achieve 观测；
26. suspended Stop 永远 release，且不改 revision/round/episode；
27. achieved 的 closing_observation_id 精确引用当前 satisfied observation；
28. criterion side effect 在 open/verify/Stop/achieve 四条路径均成为 indeterminate，并使已有 review 过期；
29. review 的 blocking/advisory 分类、acceptance gate、provisional 降级和 CLI/storage 枚举映射一致；
30. event sequence 由 task state 分配，event id 确定性生成，append 丢失不阻塞后续 task。

### 切片 2：替换状态引擎与存储

- `task-engine` 只接受和返回规范 lifecycle；
- `task-store` 只读写新模型的 schema v1；
- criterion evaluation 直接生成正式 observation；
- open/amend 管理稳定的 `criterion_definition_hash` 与不可复用的 `criterion_generation_id`，generation 变化使 witness/review 失效；
- task engine 实现完整转移表、substantive/artifact revision 和 review freshness；
- closure projector 与 engine 共享同一组纯判断函数，禁止复制规则。

### 切片 3：切换 CLI、ledger 与 hook

- CLI 只接受 `--criterion-policy`；
- open 只接受结构化的 `--alignment-because` 与可重复 `--not-covered`；
- 机器成功终结动词改为 `achieve`，与 `terminal(achieved)` 一一对应；
- status/info/audit 只输出新词汇与新字段；
- outcome ledger 只写 `outcomes-v1.jsonl` 和 `event_schema_version: 1` 事件；
- 增加显式 `archive-incompatible-state` 维护命令；
- PreToolUse/Stop hook 同步切换文本和 JSON payload，并把 `runtime_contract` 提升为 2；
- 所有公共输出测试按新协议重写。

### 切片 4：切换文档与 skills

- README、loop-core reference、workloop skill、CLI help 全部改用“判据未满足/已满足/无法裁决”；
- alignment 指引改为结构化的 `because` 与 `not_covered`，展示时可渲染为 `criterion satisfied ⇒ goal because ...; not covered: ...`；
- 删除颜色词和已移除参数的操作指引；
- 安装器只分发与新 runtime 匹配的 skill 内容。

### 切片 5：一次性切换验证

- 从空临时 home 安装 runtime 与 skills；
- 在临时仓库覆盖 default、deferred-witness、steady-satisfied 三条 CLI 主链路；
- 验证 suspend/resume、amend、achieve、not-needed、abandon、audit 与双宿主 hook；
- 验证 task schema、ledger event schema、runtime contract 三个版本在 `info` 与实际输出中一致；
- 在安装切换前关闭 Claude/Codex 活动会话；模拟每个 stage/swap 中断点并证明重跑 installer 可收敛；
- 扫描发布内容，确保已删除的字段和参数不再出现；
- 运行完整测试后一次性切换发布。

## 文件接触面

| 区域 | 预期变化 |
|---|---|
| `lib/criterion.mjs` | 生成正式 observation、definition hash、generation id 与 fingerprint |
| `lib/task-engine.mjs` | 采用规范 lifecycle、policy、witness 与 closure 判断 |
| `lib/task-store.mjs` | 只读写新模型的 schema v1，拒绝其他形状 |
| `lib/application.mjs` | 新 CLI、status/info/audit、ledger 与 hook 协议 |
| `README.md` | 全面切换正式术语和新命令 |
| `skills/loop-core/REFERENCE.md` | 作为共享领域词汇唯一来源 |
| `skills/workloop/SKILL.md` | 使用新术语和新 policy，不重复定义模型 |
| `install.mjs` | 分阶段部署同版本 runtime 与 skills，并提供可收敛的中断恢复 |
| tests | 真值表、状态转移、CLI、hook、ledger、installer 和 E2E 全面更新 |

## 优先级与工作量

| 优先级 | 改动 | 估算 | 风险 | 价值 |
|---|---|---:|---|---|
| P0 | 语义契约、完整 schema 与真值表 | 1–1.5 天 | 中 | 固定唯一模型 |
| P0 | 新模型 schema v1、engine、store | 2–3 天 | 高 | 消除非法状态、witness 与 review 缺口 |
| P0 | CLI、ledger、hook 切换 | 1.5–2 天 | 高 | 公共表面统一 |
| P0 | installer 事务恢复与不相容状态归档 | 1–1.5 天 | 高 | 确保 clean break 可安全升级 |
| P0 | 文档与 skills | 0.5–1 天 | 中 | 防止运行时与指导文本分叉 |
| P0 | 临时环境 E2E 与发布扫描 | 1 天 | 中 | 证明一次性切换完整 |
| **合计** | | **7–10 天** | | |

## 拒绝的替代方案

### 只改颜色

把红/绿换成橙/蓝没有改变领域含义，仍然没有说明这是判据观测。

### 使用失败/成功

`failure/success` 仍会被理解成整个任务的结果，无法表达“判据已满足但仍被 hold”。

### 只增加投影视图

在底层继续保存颜色字段、可空状态组合和例外分支，会让正式模型只是展示层。engine 与 projector 最终仍会分叉，无法修复领域模型本身。

### 分阶段发布半成品

先发布新 JSON、再保留两套 CLI 或 hook，会让每一层都承担多种表示。开发可以分切片，对外只能作为一个 release 完成切换。

### 立即引入事件溯源

当前目标是统一术语、状态与收口不变量。事件溯源会引入额外存储和重放模型，不是完成本次重构的必要条件。

## 失败条件与防护

### 失败条件 1：颜色词继续进入领域接口

防护：对生产代码、skills、README 和公共输出做扫描；颜色只可用于 UI 样式变量，不得成为 API 值、字段名或状态名。

### 失败条件 2：用户把 satisfied 当作 achieved

防护：所有用户文案写完整的“criterion satisfied / 判据已满足”，并持续回显 alignment 与 `not_covered`。

### 失败条件 3：状态组合非法

防护：使用单一构造入口和穷举真值表；terminal 必须携带 outcome，suspended 必须携带 reason，active 不得携带终态 outcome；closure 只对 active 非空。

### 失败条件 4：engine 与 projector 分叉

防护：二者共享纯判断函数，并以 oracle 测试证明：engine 允许自动收口当且仅当 projector 为 `eligible` 且 `close_policy=automatic`。

### 失败条件 5：runtime 与 skills 不在同一语义版本

防护：安装器使用同一 release id、内容摘要、activation journal 和 runtime-last 顺序部署 runtime 与受管 skills；维护窗口阻止宿主读取中间态，故障注入证明重跑可收敛。E2E 对实际安装结果运行，不只测试源码树。

### 失败条件 6：升级后误读现有状态

防护：非 v1 task 文件 fail loudly，不猜测、不补默认值、不自动改写。错误信息给出升级前关单或显式 `archive-incompatible-state` 两条恢复路径；归档命令只按字节保全文件，不解释其语义。

### 失败条件 7：旧 review 解除新产物的 hold

防护：review 同时绑定 generation、last substantive task revision 和 artifact revision；任何实质改动都会使它过期，findings 必须通过修改后重新取得 findings=0 的独立 review 闭合。

## 最佳性检查

- **适配标准**：语义通用、三态完整、状态不可非法组合、收口事实单源、公共表面单一、可机器验证。
- **当前赢家**：一次性 clean break。
- **最接近替代方案**：仅增加语义投影视图。
- **反转条件**：只有明确要求保留已发布接口或历史状态读取能力时，才重新设计迁移层；该条件不属于本文范围。
- **停止点**：完成术语、schema、engine、CLI、ledger、hook、skills 的单 release 切换后停止，不顺带引入 scheduler、sandbox 或事件溯源。

## 最小纵向切片

最小可交付单位不是单独的 projector，而是一条完整 default 主链路：

1. 新模型的 schema v1 创建 `active` task；
2. open 取得 `unsatisfied` observation 与 witness；
3. 写入受 envelope 与预算约束；
4. Stop 取得 fresh `satisfied`；
5. closure projector 返回 `eligible`；
6. engine 写入 `terminal(achieved)`；
7. ledger、status、hook 和 skill 指引全程只出现新术语。

该纵向切片通过后，再补 deferred_witness、steady_satisfied、suspend/resume 和其他终态。最终发布仍等待全部切片、完整测试和安装后 E2E 一起通过。
