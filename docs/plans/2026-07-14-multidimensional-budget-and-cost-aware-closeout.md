# taskloop 多维预算一致性与成本感知收尾执行计划

日期：2026-07-14  
仓库基线：`f40dfb96025c3ee9b0de17268d3ed398dcf5cfa4`  
模式：Plan  
深度：Deep  
状态：可执行计划，尚未实施  
输入来源：`docs/research/2026-07-14-first-principles-taskloop-improvements.md`、当前 `lib/` 实现、相关测试、README/skills 契约、预算语义提交历史，以及本会话重跑的完整测试套件。

## TL;DR

当前最佳路径是两个可独立回滚的实现切片：

1. 以 `lib/task-engine.mjs` 中一个纯预算投影作为唯一判定源，统一 PreToolUse、closure adjudication（Stop 与显式 `achieve`）和 resume 对 rounds、writes、wall-clock、output-token 四类预算的语义；
2. 在不改变 task/ledger schema 的前提下，让 Markdown report 和 workloop 收尾显式报告全部预算消耗，token 数明确标记为 best-effort estimate。

预计总投入 **7–11 工程小时**。不增加 scheduler、sidecar、价格模型、reviewer session accounting 或新 schema。`runtime_contract=3`、`task_schema=2`、`ledger_schema=2` 保持不变。

**下一步验证**：先给“`--writes 0` + unsatisfied Stop/`achieve` 应立即 `suspended(out_of_budget)`”增加 CLI 回归测试并确认它在当前实现上失败；不得先改生产代码。

## 决策信封

### P0：多维预算生命周期一致性

```yaml
decision: BUILD
decision_source: 2026-07-14 first-principles analysis + user request to make it executable
target_outcome: 任一已配置预算耗尽时，fresh unsatisfied closure adjudication（Stop 或显式 achieve）都诚实暂停为 out_of_budget；fresh satisfied closure adjudication 仍可正常关闭；resume 只能在全部耗尽预算被提高后成功
baseline_and_frequency: 当前 writes/wall-clock/output-token 只拒绝写入，不会在 unsatisfied Stop/achieve 上转为 out_of_budget；随后可能在第 3 或第 7 次无进展关闭尝试被误报 stuck；真实发生频率未知，但影响所有使用可选预算的任务
expected_benefit: 每次命中避免约 2–6 次无效关闭尝试，并修正生命周期原因、judgment 和恢复条件
delivery_and_maintenance_cost: P0 预计 5–8 小时；无 schema 迁移，长期维护为一个共享纯投影和对应行为矩阵
status_quo_or_existing_mechanism: 依靠 PreToolUse 拒绝写入并让用户人工识别预算耗尽
decision_flip_condition: maintainer 明确决定只有 rounds 是生命周期预算，而 writes/wall-clock/output-token 只是永久保持 active 的写入节流器
review_scope: implementation-authorization
review_budget: 一次 second-model 完整复核，最多两轮修复后复核
```

### P1：成本感知的收尾报告

```yaml
decision: BUILD
decision_source: 2026-07-14 first-principles analysis + user request to make it executable
target_outcome: 人类可读 report 无需解析 JSON 或重建现场即可看到四类预算的实际消耗、上限和 token 估算属性
baseline_and_frequency: JSON 已有 budget/spent；Markdown 每次生成都遗漏 output_tokens_estimate、wall-clock 上限以及零值写预算上限
expected_benefit: 让 task state 和 JSON report 已经采集的 output-token estimate 进入每次人类可读收尾和边际停止判断；不依赖随时间变化的本地 ledger 快照
delivery_and_maintenance_cost: P1 预计 2–3 小时；只增加稳定格式化和 skill/report 断言
status_quo_or_existing_mechanism: 人工读取 report --json
decision_flip_condition: Markdown report 被确认不是受支持的人类接口，或 token estimate 在目标宿主上长期完全不可用
review_scope: implementation-authorization
review_budget: 与 P0 合并执行同一次 second-model 复核
```

## 最佳性检查

- **适配标准**：状态机正确性、Stop hook 兼容、职责边界、可确定性验证、实现与维护成本。
- **胜出机制**：在纯 task engine 中建立一个共享预算耗尽投影，再由现有 application 路径消费；它以最少机制消除 PreToolUse、closure adjudication 和 resume 的语义分裂。
- **最接近替代方案**：保留重复判断，只补 closure path 的三个 `if` 并修改 README。它短期更快，但会继续让 PreToolUse、Stop/achieve、resume 三份条件和 wall-clock 算法漂移。
- **击败条件**：如果可选预算被产品所有者重新定义成非生命周期节流器，则应只修文档，不改 closure/resume。
- **边际停止点**：四预算投影、Stop/achieve/resume 一致性和人类报告完成后停止；review cost、sidecar、价格和 scheduler 不进入本计划。

## 验收 Oracle

实现只有同时满足下列可观察结果才算完成：

1. rounds、writes、wall-clock、output-token 任一预算耗尽后，fresh `unsatisfied` Stop 和显式 `achieve` 都在同一次裁决中得到 `suspended(out_of_budget)`；
2. 多个预算同时耗尽时，judgment 以稳定顺序列出全部耗尽维度，并指出需要 amend 的对应 CLI 选项；
3. 任一预算已经耗尽但 fresh criterion 为 `satisfied` 时，Stop 和显式 `achieve` 在符合其他关闭条件时仍正常 `terminal(achieved)`；
4. out-of-budget task 在任一当前耗尽维度未提高时拒绝 resume；所有维度均不再耗尽后 resume 成功；
5. `indeterminate` criterion、`needs_input`、既有 `stuck` 阈值、read/verify 免费路径和 foreign-session 行为保持不变；
6. PreToolUse 对既有单维预算的 deny JSON 和文字保持字节兼容；
7. Markdown report 显示 rounds、writes、wall clock、output token 的 spent/limit；未配置上限明确显示 `unbounded`，零上限显示 `/0`，token 标明 `best effort estimate`；
8. JSON report 字段、task state、ledger event、hook payload 形状及版本号保持不变；
9. `npm test`、`node bin/taskloop.mjs help` 和 `node bin/taskloop.mjs info` 全部通过。

## 范围与成本

| 范围 | 组件 | 预计投入 | 风险 | 价值 |
|---|---|---:|---|---|
| Core | `task-engine` 纯预算耗尽投影与 resume guard | 2–3h | wall-clock 边界和多维提示 | 消除判定源分裂 |
| Core | closure adjudication 与 PreToolUse 接入共享投影 | 1–2h | hook/CLI 输出兼容 | 修正错误生命周期并保持 gate 行为 |
| Core | Markdown 完整预算格式 | 0.5–1h | 人类输出格式变化 | 让已有遥测可见 |
| Supporting | unit/CLI/report 回归矩阵 | 2–3h | 测试时钟与 transcript fixture | 固化所有边界和反例 |
| Supporting | README、loop-core、workloop 同步 | 0.5–1h | 文码漂移 | 统一公共语义和 agent 收尾要求 |
| Supporting | 全套验证与 second-model 复核 | 1h + review latency | 发现跨宿主盲点 | 关闭 public-contract 风险 |
| **Total** | **Core + Supporting** | **7–11h** | **Critical/public-contract** | **两个 BUILD 决策完整落地** |

可选且明确排除在总量之外：reviewer usage probe、`audit --summary`、usage sidecar、价格换算、driver acknowledgement、模型路由和 scheduler。

总成本仍落在原 Value Gate 的 0.5–1.5 工程日范围内，不需要重新打开 BUILD 决策。

## 目标文件

| 文件 | 计划变更 |
|---|---|
| `lib/task-engine.mjs` | 新增并导出纯预算耗尽投影；resume 使用同一投影验证全部维度 |
| `lib/application.mjs` | import 投影；PreToolUse、Stop/achieve suspension 和 next action 共用结果；扩展 Markdown Budget |
| `tests/taskloop.test.mjs` | 增加投影真值表、四维 Stop/achieve、multi-budget、satisfied-close、真实优先级冲突、resume 和 report 测试 |
| `README.md` | 把较旧的“仅 rounds 挂起”更新为四预算统一的 fresh-unsatisfied closure 语义 |
| `skills/loop-core/REFERENCE.md` | 明确 out-of-budget resume 必须提高所有仍耗尽的 task-level budget |
| `skills/workloop/SKILL.md` | Report 要求列出四类实际消耗、上限和 telemetry gap/estimate |

本计划不要求修改：

- `lib/prims.mjs` 的 schema/runtime 常量；
- `lib/outcome-ledger.mjs` 或 frozen runtime-contract fixture；
- `skills/loop-core/HOSTS.md` 的 stop-gate/driver 边界；
- installer 行为；
- 既有研究与成本平台计划。

如果实施过程中发现必须修改上述排除项，先停止并重新过 Value Gate，不得顺手扩张范围。

## 行为契约

### 单一预算投影

在 `lib/task-engine.mjs` 增加纯函数，建议命名为 `projectBudgetExhaustion(task, atEpochMs)`。`atEpochMs` 必须是调用者捕获的有限整数 epoch milliseconds；函数不得自行读时钟、文件、环境变量或宿主状态。Stop、显式 `achieve`、PreToolUse、resume 和测试都传入同一类型，禁止传入秒级 `localTimestamp()` 字符串。

application 路径在每个预算决策点只捕获一次 `atEpochMs = Date.now()`：PreToolUse 在预算投影前捕获，Stop/显式 `achieve` 在 fresh observation 返回后捕获，resume 在调用 transition 前捕获。需要持久化事件时间时，由同一个值生成 `localTimestamp(atEpochMs)`；resume transition 通过非持久化的 event 输入接收该值。这既计入 criterion 执行耗时，又不因先后调用两个时钟产生边界漂移，也不增加 task schema 字段。`created_at` 仍按现有方式解析。

建议返回一个按固定次序排列的耗尽项数组：

```js
[
  { dimension: "rounds", spent: 8, limit: 8 },
  { dimension: "writes", spent: 3, limit: 3 },
  { dimension: "wall_clock", spent: 60000, limit: 60000 },
  { dimension: "output_tokens", spent: 1000, limit: 1000 },
]
```

固定顺序为 `rounds → writes → wall_clock → output_tokens`。字段名和返回容器可以在实现时微调，但必须满足：纯、稳定顺序、全部维度可见、调用方无需重新实现阈值算法。

判定规则：

| 维度 | 耗尽条件 | 未配置语义 |
|---|---|---|
| rounds | `spent.rounds >= budget.rounds` | 不允许 null；默认 8 |
| writes | `spent.writes >= budget.writes` | `null` 为 unbounded |
| wall_clock | `max(spent.wall_clock_ms, atEpochMs - Date.parse(created_at)) >= budget.wall_clock_minutes * 60000` | `null` 为 unbounded |
| output_tokens | `spent.output_tokens_estimate >= budget.output_tokens` | `null` 为 unbounded |

边界统一采用 `>=`；显式零预算立即耗尽。wall-clock 使用毫秒级 `atEpochMs` 和已记录 spent 的较大值，既保持当前 PreToolUse 边界，也避免 resume 在 amend 后到实际恢复之间漏掉新增耗时。invalid/non-finite `atEpochMs` 是内部调用错误，纯函数必须明确拒绝，不能静默退回秒级时间。

### Closure adjudication 顺序

Stop 与显式 `achieve` 共享 `closeAttempt()`，因此两者保持同一个“先观察，再裁决”顺序：

```text
fresh observation
  ├─ indeterminate → 现有 indeterminate 路径
  ├─ satisfied → 现有 closure/review/proof gate；eligible 时允许关闭
  └─ unsatisfied
       ├─ any budget exhausted → suspended(out_of_budget)
       ├─ same signature ×3 → suspended(stuck)
       ├─ same revision/generation ×7 → suspended(stuck)
       └─ remain active
```

显式 `achieve` 的 unsatisfied 结果与 Stop 一样参与预算和 stuck 裁决；这是对现有 rounds 行为向其他预算维度的对称扩展，不是 Stop-only 特例。不得把预算检查提前到 fresh observation 之前，否则“预算耗尽但工作已经完成”的任务会失去最后一次诚实关闭机会。

### Suspension judgment

- 单独 rounds 耗尽时，保留当前 failure/next-action 文本，避免改变已经固定的 hook 输出；
- 新增维度使用现有 CLI 选项名：`--writes`、`--wall-clock-minutes`、`--token-budget`；
- 多维耗尽时按投影顺序组合，不只报告第一项；
- next action 应说明“一次 amend 提高列出的全部维度，然后 resume”；
- 不把价格、模型、session 或 host-specific invocation 写入 judgment。

### Resume

`transition(..., { type: "resume" })` 在增加 revision、关闭 episode 或追加新 episode之前，使用 event 携带的 `atEpochMs` 调用同一预算投影。如果生命周期原因是 `out_of_budget` 且投影非空，抛出稳定错误并列出仍耗尽的维度。

这里检查的是 amend 后的当前 budget，而不是“是否出现过某个 amend event”。因此：

- 提高错误维度不能解锁；
- 只提高多个耗尽维度中的一部分不能解锁；
- 把另一个维度降低到 spent 以下会继续保持锁定；
- wall-clock 新上限必须大于从 task `created_at` 起的当前总耗时。

### PreToolUse

PreToolUse 继续只在 write-shaped 调用上执行预算 deny。读取、验证和 taskloop 控制命令保持现状。

接入投影后，选择第一个耗尽项并使用当前完全相同的 dimension-specific deny 文本。这样复用判定逻辑而不改变既有单维 hook 输出。多维时仍只需在 PreToolUse 报告第一项；完整集合由 Stop judgment 和 report 承担。

### Markdown report

预算行采用一个小型本地 formatter，禁止用 truthiness 判断可选上限，因为 `0` 是合法且已耗尽的上限。建议稳定输出：

```text
- rounds 1/8; writes 1/1; wall clock 12s/5m; output tokens estimate 320/1000 (best effort)
```

未配置上限：

```text
- rounds 1/8; writes 0/unbounded; wall clock 12s/unbounded; output tokens estimate 320/unbounded (best effort)
```

JSON report 已包含结构化 `budget` 与 `spent`，保持字节结构不变。

## 执行顺序

### 0. 固定基线和范围

1. 确认只修改“目标文件”表中的文件；保留用户已有的 `output/`、`tmp/` 和其他工作树改动。
2. 运行并记录：

   ```sh
   git status --short
   npm test
   node bin/taskloop.mjs info
   ```

3. 预期基线为 runtime/task/ledger `3/2/2`，完整测试 0 失败。

若基线失败，先区分已有失败与本计划问题；不得在本计划中顺手修无关失败。

### 1. 先挣得 P0 的红测试

在 `tests/taskloop.test.mjs` 增加以下最小失败用例：

1. open `--writes 0`，执行 unsatisfied Stop，断言 lifecycle 为 `suspended(out_of_budget)` 且 judgment 指向 `--writes`；
2. 另开同样的 `--writes 0` fixture，执行显式 `achieve` 并断言同样的 out-of-budget 结果；
3. 用整数 epoch-ms 对 `projectBudgetExhaustion()` 做 fixed-time 真值表，覆盖 null、0、等于上限、低于上限、多维稳定顺序和非法时间输入；
4. 确认定向测试在当前实现上至少因前两项失败：

   ```sh
   node --test --test-name-pattern="budget" tests/taskloop.test.mjs
   ```

只有得到预期红色后进入生产实现。不要提交纯红状态。

### 2. 实现共享投影与 resume guard

1. 在 `lib/task-engine.mjs` 实现并导出纯预算投影；
2. 在同模块的 resume transition 中替换 rounds-only guard，并要求 application 传入同次捕获的 `atEpochMs`；
3. 更新所有直接构造 resume transition event 的单元测试，显式提供整数 `atEpochMs`，避免测试绕过新的内部契约；
4. 在测试中增加 multi-budget 部分提高仍拒绝、全部提高后恢复成功；
5. 使用固定时间构造 wall-clock 测试，不使用 sleep。

完成条件：投影与 resume 定向测试通过；task-engine 仍为纯 leaf，只 import `lib/prims.mjs` 和 Node 内建模块。

### 3. 接入 closure adjudication 与 PreToolUse

1. `lib/application.mjs` import 共享投影；
2. `failureSuspension()` 只对 fresh unsatisfied observation 使用投影；Stop 与显式 `achieve` 都走该路径，并让预算优先于两个 stuck 判定；
3. 生成单维/多维 failure 和 next action；
4. PreToolUse 改用同一投影，但保留现有 deny 字节；
5. 增加 CLI 矩阵：
   - `--writes 0`；
   - `--wall-clock-minutes 0`；
   - `--token-budget 0`；
   - `--rounds 1`；
   - 四项同时耗尽；
   - writes 刚好耗尽但 checker 已绿时，Stop 与显式 `achieve` 都仍 achieved；
   - optional budget 耗尽且显式 `achieve` 得到 unsatisfied 时进入 out_of_budget；
   - indeterminate 不被预算路径吞掉。

6. 增加真正的判定优先级冲突，而不是只断言第一次失败：
   - round budget 为 3，第三次同签名 unsatisfied 时让 `rounds exhausted` 与 `same signature ×3` 同时成立，断言 `out_of_budget`；
   - 以 `rounds=7`、`spent.rounds=6`、`unsatisfied_streak=6`，在同一 generation/artifact revision 下准备六个不同 signature 的既有 attempts；第七次 unsatisfied 同时命中 round budget 与 no-progress 阈值，断言 `out_of_budget`；
   - 至少一个冲突夹具使用 optional budget（例如预置两个与下一次 checker 输出同签名的 attempts 后以 `writes 0/0` 裁决），证明新维度也走相同优先级。

完成条件：所有新 P0 测试绿，既有 stuck 与 byte-exact hook 测试不变且通过。

### 4. 实现 P1 的报告闭环

先扩展现有 report 测试，再修改输出：

1. bounded 值显示 spent/limit；
2. null 上限显示 `unbounded`；
3. 0 上限显示 `/0`；
4. output token 标签包含 `estimate` 与 `best effort`；
5. JSON report 深相等/字段集合不变；
6. `skills/workloop/SKILL.md` 的 Report 段要求列出四类实际消耗和 telemetry gap，不承诺 exact token accounting。

完成条件：Markdown 新断言与现有 terminal/suspended report 测试全部通过。

### 5. 同步公共契约

1. `README.md` 更新为：可选预算先拒绝进一步写入，但 fresh unsatisfied Stop 或显式 `achieve` 会按任一耗尽维度暂停为 `out_of_budget`；读取和验证保持免费；fresh satisfied closure 仍可关闭。
2. `skills/loop-core/REFERENCE.md` 明确 resume 前必须提高所有仍耗尽预算，而不只是 rounds。
3. `skills/workloop/SKILL.md` 只保留 task-facing 报告要求，共享预算状态语义仍放 loop-core。
4. 不修改 HOSTS 的 driver 边界，不加入任何宿主专用语法。

完成条件：skills architecture/closure 测试通过，README、loop-core、代码行为没有互相矛盾的预算描述。

### 6. 完整验证与复核

按顺序运行：

```sh
node --test --test-name-pattern="budget|report|stuck|indeterminate" tests/taskloop.test.mjs
npm test
node bin/taskloop.mjs help
node bin/taskloop.mjs info
git diff --check
git status --short
```

然后执行一次 second-model 完整复核，固定检查：

- satisfied-close 是否被预算提前拦截；
- 多维 resume 是否存在只提高一项即可绕过；
- wall-clock 是否在 Stop、显式 `achieve`、PreToolUse、resume 使用同一个 epoch-ms 边界；
- optional null 与合法 0 是否混淆；
- hook 现有 JSON/文字是否意外变化；
- task/runtime/ledger schema 是否被无意改变；
- README、loop-core、workloop 是否各自承担正确层级的语义。

复核 blocker 必须修复并重新跑定向测试和 `npm test`；advisory finding 记录在最终报告中。

## 测试矩阵

| 场景 | 入口 | 预期 |
|---|---|---|
| rounds `1/1` + unsatisfied | Stop | `out_of_budget` 基础路径 |
| writes `0/0` + unsatisfied | Stop 与 `achieve` | `out_of_budget`，judgment 指向 `--writes` |
| wall `0/0m` + unsatisfied | Stop 与 `achieve` | `out_of_budget`，无需 sleep |
| output tokens `0/0` + unsatisfied | Stop 与 `achieve` | `out_of_budget`，judgment 指向 `--token-budget` |
| 四维同时耗尽 | Stop | judgment 按固定顺序列出四维 |
| writes `1/1` + satisfied | Stop 与 `achieve` | `terminal(achieved)` |
| 预算耗尽 + indeterminate | Stop/achieve | 保持 criterion-indeterminate 语义 |
| rounds `3/3` + 第三次同签名 | Stop | budget 与 stuck 同时成立，选择 `out_of_budget` |
| 同 revision 第七次 varied-signature + budget exhausted | Stop | budget 与 no-progress 同时成立，选择 `out_of_budget` |
| 预置两次同签名 + writes `0/0` | Stop | optional budget 与 stuck 同时成立，选择 `out_of_budget` |
| 多维耗尽，仅提高 rounds | resume | 拒绝并列出其余维度 |
| 多维耗尽，全部提高 | resume | active，新 episode 正常创建 |
| optional budget 为 null | projection/PreToolUse | 不视为耗尽 |
| optional budget 为 0 | projection/report | 立即耗尽且报告 `/0` |
| 单维 PreToolUse deny | Hook | 与当前 stdout 字节一致 |
| report bounded/unbounded | CLI | 四类 spent/limit 完整，JSON 不变 |
| 三次同失败且无预算耗尽 | Stop | 仍为 `stuck` |
| 七次同 revision 且无预算耗尽 | Stop | 仍为 `stuck` |

## 提交边界

保持两个可独立审查和回滚的提交；红绿过程不单独提交失败状态。

1. `fix: unify multidimensional budget exhaustion`
   - task-engine 投影与 resume；
   - Stop/achieve/PreToolUse 接入；
   - P0 测试；
   - README 与 loop-core 契约同步。
2. `feat: expose complete budget usage in closeout reports`
   - Markdown formatter；
   - report 测试；
   - workloop Report 要求。

如果当前分支包含无关用户改动，只 stage 上述目标文件的相关 hunks，不使用 destructive checkout/reset。

## 兼容、发布与回滚

### 版本与迁移

- task state 不增加字段，`TASK_SCHEMA_VERSION` 维持 2；
- ledger event kind/payload 不增加字段，ledger schema 维持 2；
- hook 输入输出 JSON 形状不变，runtime contract 维持 3；
- `out_of_budget` 和 judgment 字段已经存在，不需要数据迁移；
- installed runtime/skills 仍由现有 `install.mjs` 同版本原子分发，本计划不执行真实 home 安装。

这是一次有意的行为纠偏：7 月 12 日 README 仍写“只有 rounds 挂起”，但 7 月 13 日更新的仓库契约已经规定“budget exhaustion → out_of_budget”。实现提交必须同时修 README，避免把纠偏隐藏成未记录的接口变化。

### 存量任务

- active 且 optional budget 已耗尽的存量 task，会在下一次 fresh unsatisfied Stop 或显式 `achieve` 上暂停；这是目标行为；
- 已 terminal task 不变；
- 已 suspended(stuck/needs_input) task 不自动重分类；
- 已 suspended(out_of_budget) task 在 resume 时接受更严格的“全部维度不再耗尽”检查；
- 旧 runtime 仍能读取新 runtime 写出的 task 与 ledger，因为没有新字段或 enum。

### 回滚

- P1 可单独 revert，只恢复旧 Markdown/skill 报告，不影响 P0 状态机；
- P0 可单独 revert，无 state/ledger migration；已写出的 `out_of_budget` 仍是旧 runtime 支持的合法状态；
- 若发布后发现宿主依赖旧 optional-budget active 行为，先回滚 P0 runtime，再由 maintainer 决定是否把该行为正式定义为节流器语义；不要在热修中引入兼容开关。

## 失败条件与停止规则

出现以下任一情况，停止实现并重新决策：

1. maintainer 明确确认 README 的 rounds-only 行为才是产品意图；
2. 实现要求新增 task/ledger 字段、runtime contract 或 host-specific payload；
3. 无法同时满足“预算耗尽但 fresh satisfied 可关闭”和“unsatisfied 立即 out_of_budget”；
4. 为精确 token accounting 必须引入 reviewer/session sidecar；
5. 目标文件之外出现不可绕开的生产改动。

满足验收 Oracle、完整测试和 second-model 复核后即停止。不得借本计划继续建设成本治理平台、调度器或新的 loop skill。

## 基线验证记录

2026-07-14 在基线提交上运行 `npm test`：

- tests：96；
- passed：89；
- skipped：7 个 Windows-only；
- failed：0；
- duration：约 32 秒。

## 来源

- 第一性原理存档：[`../research/2026-07-14-first-principles-taskloop-improvements.md`](../research/2026-07-14-first-principles-taskloop-improvements.md)
- 既有成本治理方案：[`2026-07-12-cost-efficient-taskloop.md`](2026-07-12-cost-efficient-taskloop.md)
- Anthropic loop engineering：[Getting started with loops](https://claude.com/blog/getting-started-with-loops)
