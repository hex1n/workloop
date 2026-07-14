# 基于 Loop Engineering 的 taskloop 第一性原理改进判断

日期：2026-07-14  
仓库基线：`f40dfb96025c3ee9b0de17268d3ed398dcf5cfa4`  
分析模式：Deep / repository-grounded recommendation  
状态：决策记录，不构成实施授权  

## 问题

结合 Precisox 转发的视频课程内容、Anthropic 对 loop engineering 的公开说明，以及 taskloop 当前代码和测试，从第一性原理判断：哪些改进确实比现状更好，哪些只是看起来先进但不应进入 taskloop 内核？

本次分析由一个独立子代理使用更新后的 `first-principles-planner` 执行 Value Gate，主代理随后逐项核对代码、测试、历史账本与仓库边界。项目文档只用于核对既定边界，结论主要来自实现和测试。

## 结论

当前只有两项通过 Value Gate：

1. **P0 / BUILD：统一多维预算耗尽的状态机语义。**
2. **P1 / BUILD：让已有成本数据进入人类可读的收尾报告。**

其余候选项应当 `RESEARCH_FIRST`、`DEFER` 或 `NO_BUILD`。尤其不应把视频中的调度、自动权限模式、语音输入、draft PR 编排或模型路由复制进 taskloop。它们属于 host、driver 或外部 workflow skill；taskloop 的职责是 stop gate，而不是再次执行下一回合的 scheduler。

## 第一性原理框架

### 根问题

taskloop 的根任务不是“提供尽可能多的 agent 功能”，而是：

> 以最小且可验证的机制，确保自主工作只能在获得新鲜证明后诚实完成，或在无法继续时以正确原因停止，同时不越过授权边界。

因此候选改进按以下顺序比较：

1. 是否修复契约或状态机正确性；
2. 是否减少无效自主循环；
3. 是否属于 taskloop 的 stop-gate 边界；
4. 是否能以现有数据和小改动验证；
5. 收益是否大于实现与长期维护成本。

Value Gate 同时比较四种路径：维持现状、只改流程/文档、最小实现改动、建设新平台。只有最小实现改动在证据上明显胜出时才判定 `BUILD`。

## 视频内容与当前实现的映射

原视频帖的章节覆盖 agentic loop、auto mode、voice、draft PR 自动 review 与非代码循环。Anthropic 的配套文章进一步强调：循环必须有明确停止条件和上限；确定性工作应使用脚本；高风险结果应由 fresh agent 独立检查；定时和主动循环由外部触发器驱动。

taskloop 已经覆盖其中最重要且属于内核的部分：

- executable criterion 与 fresh observation；
- rounds、writes、wall-clock、output-token 四类预算；
- `out_of_budget`、`stuck`、`needs_input` 等诚实停止状态；
- fresh-context / second-model review 要求；
- envelope、proof assurance 和 outcome ledger；
- host-neutral 的 workloop 与 judgmentloop。

所以正确策略不是扩张功能，而是检查这些已有机制是否在所有路径上保持同一语义。

## P0 / BUILD：统一多维预算耗尽语义

### 当前缺陷

PreToolUse 写入门会在以下任一预算耗尽时拒绝继续写入：

- rounds；
- writes；
- wall-clock；
- output-token estimate。

实现位置：`lib/application.mjs` 的写入预算门，约第 668 行。

但是 Stop 后的 `failureSuspension()` 只把 rounds 耗尽识别为 `out_of_budget`。writes、wall-clock 或 output-token 耗尽后，如果 criterion 仍未满足，任务会继续保持 active。由于写入已经被禁止，后续 Stop 通常只能重复同一失败，最终被错误归类为 `stuck`。

实现位置：`lib/application.mjs` 的 `failureSuspension()`，约第 401 行。

恢复路径也只验证 rounds 是否提高：`lib/task-engine.mjs` 约第 371 行。于是一个因 writes 或 token 耗尽而暂停的任务，即使没有提高真正耗尽的预算，也可能被恢复后立即再次拒绝写入。

这不是功能缺失，而是同一个“预算”概念在写入门、Stop 裁决和 resume 三条路径上语义分裂。

### 最小机制

建立一个纯判定源，例如 `exhaustedBudgets(task, at)`，返回全部耗尽维度，并由 PreToolUse、Stop 和 resume 共用。

Stop 顺序应当是：

1. 先运行新鲜 criterion observation；
2. criterion `satisfied` 且满足关闭条件时，即使预算刚好耗尽，也允许正常关闭；
3. criterion `unsatisfied` 且任一预算耗尽时，立即暂停为 `out_of_budget`；
4. `out_of_budget` 判定优先于同签名三次或无进展七次的 `stuck`；
5. criterion `indeterminate` 继续走现有证据/环境错误路径，不误归类为预算问题；
6. suspension judgment 列出全部耗尽维度和可直接执行的 amend/resume 动作；
7. resume 要求所有仍然耗尽的维度都已被有效提高。

不应在第一次 PreToolUse 写入拒绝时直接 suspend。任务可能已经满足 criterion，只需读和验证便能诚实关闭；过早暂停会破坏这一合法路径。

### 最小测试矩阵

- rounds 耗尽 + unsatisfied Stop → `suspended(out_of_budget)`；
- writes 耗尽 + unsatisfied Stop → `suspended(out_of_budget)`；
- wall-clock 耗尽 + unsatisfied Stop → `suspended(out_of_budget)`；
- output-token 耗尽 + unsatisfied Stop → `suspended(out_of_budget)`；
- 多个预算同时耗尽 → judgment 列出全部维度；
- 任一预算耗尽 + satisfied Stop → 正常 `terminal(achieved)`；
- out-of-budget resume 在真正耗尽的预算未提高时被拒绝；
- out-of-budget 优先于三次同签名与七次无进展；
- 现有 `stuck` 行为和 hook 协议字节输出保持兼容。

当前相关测试从 `tests/taskloop.test.mjs` 约第 591 行开始，覆盖了写入拒绝和 token tally，但没有覆盖 writes、wall-clock、output-token 从 Stop 进入 `out_of_budget` 的状态转移。

### 收益、成本与反转条件

- **正确性收益：高。** 修复生命周期原因、恢复条件和用户下一步建议。
- **运行收益：中。** 避免预算耗尽后额外发生约 2–6 次没有改变工件可能性的 Stop。
- **边界适配：高。** 完全属于 stop gate。
- **预计成本：0.5–1 个工程日。**
- **置信度：高。** 缺陷可由当前代码直接推出并可写成确定性测试。

只有在 maintainer 明确重新定义“`out_of_budget` 只代表 round budget，其他三项只是写入节流器”时，此建议才应反转。当前命名、公开契约和四预算模型都不支持这种解释。

## P1 / BUILD：成本感知的收尾报告

### 当前缺口

task state 和 JSON report 已经包含完整的 `budget` 与 `spent`，其中包括 `output_tokens_estimate`。但是 Markdown report 的 Budget 段只显示 rounds、writes 和 wall clock，遗漏 token estimate；`skills/workloop/SKILL.md` 的报告要求也没有要求报告实际预算消耗或遥测缺口。

实现位置：

- `lib/application.mjs` Markdown Budget，约第 377 行；
- `skills/workloop/SKILL.md` Report，约第 90 行。

本地 outcome ledger 样本中，9 个终态任务已经累计记录约 346,903 个 output-token estimate。数据已经存在，但当前人类可读收尾无法用它判断一轮工作的成本与边际收益。

### 最小机制

1. Markdown report 增加 `output token estimate: spent/limit`；
2. 没有上限时明确显示 unbounded，而不是省略；
3. 标记该数值为 best-effort estimate；
4. workloop 收尾要求报告实际 rounds、writes、wall-clock、output-token estimate，以及不可用或降级的 telemetry；
5. 不增加新 sidecar，不改变 task schema，不引入价格换算或模型路由。

### 收益、成本与反转条件

- **收益：中高。** 让已有数据参与“是否值得继续”的边际停止判断。
- **风险：低。** 主要是展示和 skill 文本变化。
- **预计成本：1–3 小时。**
- **置信度：中高。**

如果后续证明 Markdown report 几乎无人使用，或绝大多数宿主无法提供任何可信 token estimate，可以只保留 JSON 数据而不修改人类报告。

## RESEARCH_FIRST

### Reviewer 和子代理成本是否被漏记

当前 ledger 有 review provenance，但没有证据证明 reviewer/subagent 的 token 一定进入父任务的 transcript tally。直接扩展 schema、建立 review-cost accounting 或完整成本 sidecar，会在未知问题上预付大量复杂度。

最小研究：分别在 Claude 和 Codex 做一次受控的“实现 session + fresh reviewer”任务，对比 taskloop tally、宿主 usage 和可定位的 reviewer usage。只有确认存在稳定且重要的漏记后，才设计 review cost 字段或 sidecar。

触发 `BUILD` 的条件应至少包括：

- 漏记可以稳定复现；
- 漏记量足以改变任务成本判断；
- 宿主能够提供稳定 session/role 归因；
- 最小数据模型不会把 taskloop 变成 host-specific accounting platform。

### `audit --summary` 与完整成本平台

当前账本规模仍可由一次性脚本分析。完整 sidecar、价格模型、driver acknowledgement 和实验平台的设计成本远高于已证明收益。

因此，`docs/plans/2026-07-12-cost-efficient-taskloop.md` 仍可作为历史设计输入，但其中 Phase A 的确定交付在本次 Value Gate 下归类为 **RESEARCH_FIRST / DEFER**，直到上述受控实验和真实使用规模证明需要。本文不删除或改写原计划，也不把它视为已批准实施项。

## DEFER / NO_BUILD

### DEFER

- 给 workloop 强制增加 Decision Envelope 入场检查：workloop 已定义为运行 approved work；价值判断属于上游 planner/plan-review。没有真实事故证明还需在 portable kernel 重复执行。
- 内容哈希级的写入 churn 检测：现有 rounds cap、同失败签名和无进展检测已经覆盖主要风险，暂无线上的反例。
- 多任务 `audit --summary`：等账本规模或人工分析频率形成真实压力后再做。

### NO_BUILD

- scheduler、定时循环、主动唤醒；
- auto mode 或宿主权限系统；
- voice 输入；
- 自动 draft PR 与 GitHub review 编排；
- 模型选择、模型路由和 per-skill 模型定价；
- 在 taskloop 内创建或调度 reviewer session；
- 把更多非代码 loop 塞入核心仓库。

这些能力可以通过 host、driver 或独立 skill 与 taskloop 组合，但不应成为 loop kernel 的职责。

## 最佳性检查

P0 的最近替代方案是“只在 HOSTS/README 中提醒 driver 同时检查四种预算”。它不能修复 task state 的错误原因，也不能修复 resume 校验，因此被 P0 的小型代码改动严格支配。

P1 的最近替代方案是维持 JSON-only。它没有新增工程成本，但让已经付费收集的 token estimate 对日常收尾不可见。由于展示改动极小，P1 的收益/成本比更高。

完整成本治理平台的最近替代方案是先做一次受控 usage probe。probe 能回答最关键的“是否真的漏记”问题，成本远低于平台，因此平台当前不通过 Value Gate。

## 边际停止点

完成 P0 与 P1 后应停止扩张。除非受控实验或真实 outcome ledger 数据出现新的、可重复的失败机制，否则不继续建设调度、成本 sidecar、review receipt 或模型治理平台。

## 验证记录

分析时运行 `npm test`：

- tests：96；
- passed：89；
- skipped：7 个 Windows-only；
- failed：0。

本次分析未修改生产代码。

## 相关记录与来源

- 仓库既有调研：`docs/research/2026-07-11-taskloop-vs-loop-engineering.md`
- 既有成本方案：`docs/plans/2026-07-12-cost-efficient-taskloop.md`
- taskloop 边界：`skills/loop-core/HOSTS.md`
- 原视频帖：[Precisox / X](https://x.com/precisox/status/2075824818440519692/video/1?s=46)
- 官方配套文章：[Getting started with loops — Anthropic](https://claude.com/blog/getting-started-with-loops)

