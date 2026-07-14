# Taskloop、Loop Engineering 最佳实践与第一性原理演进决策

> 日期：2026-07-15
> 模式：方案
> 深度：深度
> 状态：建议稿；需要 owner 明确接受 charter 变更后才能进入实现

## TL;DR

当前最佳路径不是把 taskloop 继续限制为被动 stop gate，也不是把它做成绑定某个模型、工具系统和 prompt 的单体 agent framework，而是演进为一个**持久化、宿主无关的 Loop Supervisor**。

它应主动拥有语义层的工程循环：生成有界 `WorkOrder`、接收结构化 `TurnReceipt`、运行 verifier/evaluator、决定下一轮、恢复、handoff、并发租约、暂停和终止。模型推理、工具执行、sandbox、权限审批和宿主 UI 继续由可插拔 executor/host adapter 承担。

**价值门禁决定：BUILD，但只授权一个可证伪的 tracer-bullet supervisor slice；完整迁移要等对照评测证明收益。**

**验收 oracle：** 一个至少经历两轮的工程任务能够通过结构化协议完成 `WorkOrder → TurnReceipt → Verify → Transition`；在轮次之间杀死进程后可以恢复，既不重复已提交工作，也不依赖 shell 命令解析；现有 CLI/hook 契约仍通过测试。

**下一步验证：** 先实现一个 5–8 工程日的薄切片，只覆盖单任务、单 worker、一个当前宿主 adapter 和一个 fake executor。若它不能在保持现有事件语义的前提下消除控制面 shell 解析，或不能可靠恢复下一轮，则停止 supervisor 扩张，退回结构化 stop-gate API。

## 决策信封

```yaml
decision: BUILD
target_outcome: >-
  让长周期工程任务的每一轮都由持久状态驱动，以结构化工作单和回执推进，
  可恢复、可验证、可预算，并能跨宿主复用，而不是依赖 shell 字符串和单次会话记忆。
baseline_and_frequency: >-
  当前完成门、预算、事件恢复很强，但控制面仍通过 CLI/hook 命令进入；
  实际 shell 误判率、人工恢复频率和任务结果提升尚未建立基线。
expected_benefit: >-
  pilot 中 100% 的 lifecycle 控制操作不再解析 shell 字符串；
  首次获得跨轮进程恢复和显式 next-work transition。
  对真实任务正确率、成本和时延的提升未知，必须由 agent-in-loop 对照评测确认。
delivery_and_maintenance_cost: >-
  tracer bullet 约 5–8 工程日；可生产的单 worker supervisor 约 14–22 工程日；
  每个新宿主 adapter 预估另需 2–5 工程日，并产生持续兼容成本。
status_quo_or_existing_mechanism: >-
  保留当前 stop gate，并依赖宿主原生 max-turns、HITL、session 和 tracing。
decision_flip_condition: >-
  如果 pilot 无法降低控制面误判/人工操作，或 host-native loop 在相同任务上以更低成本达到同等终态正确率，
  则不建设完整 supervisor，只保留结构化 gate。
review_scope: implementation-authorization
review_budget: 在 tracer bullet 之后由 owner 重新授权
```

## 最佳性检查

| 检查 | 结论 |
|---|---|
| 决定“最佳”的标准 | 终态正确性、跨轮恢复、宿主中立、低控制面歧义、可渐进迁移、不过度复制宿主能力 |
| 胜者 | 持久化 Loop Supervisor + 可插拔 executor adapters |
| 最接近替代方案 | 保持 stop gate，只增加结构化 API/MCP adapter |
| 什么会击败胜者 | 实测表明主动调度没有提高正确率或恢复率，却显著增加 token、延迟、双重状态和维护成本 |
| 边际收益停止点 | 不自建模型客户端、通用工具平台、sandbox、向量记忆、通用 DAG 引擎或 UI，除非独立评测证明现有宿主能力无法满足目标 |

这是当前约束下的最佳方案。它比 gate 更主动，但仍用明确责任边界避免滑向“另一个 agent framework”。

## 1. 研究边界与输入

本决策使用：

- 当前实现源码：`lib/application.mjs`、`lib/task-engine.mjs`、`lib/event-store.mjs`、`lib/task-store.mjs`、`lib/criterion.mjs`、`lib/supervision.mjs`、`lib/host-hooks.mjs`。
- 当前实现测试；本轮执行 `npm test`，结果为 202 tests、195 passed、0 failed、7 个 Windows-only skipped。
- 外部一手资料与论文，列于文末。

仓库内 README、既有 research、plan 和设计文档**没有作为能力判断或方案证据**。`AGENTS.md` 只用于遵守仓库操作规则，以及识别“当前 runtime 是 stop gate、scheduler 在仓库外”是现有 charter；本文显式讨论改变该 charter 的反事实方向。

## 2. 根问题

表面问题是“taskloop 太依赖 shell”。第一性原理下，shell 只是症状。

真正的问题是：**工程 agent 的控制循环被分散在短生命周期宿主、命令字符串、隐式会话状态和事后完成声明中，没有一个组件对‘下一轮为何发生、基于什么状态发生、何时停止、崩溃后如何继续’承担端到端语义责任。**

解决后的状态应当是：

1. 每轮开始于一个持久、版本化、有预算的工作单，而不是自然语言会话惯性。
2. 每轮结束于结构化回执和环境终态 observation，而不是 agent 的“已完成”。
3. 下一轮、重试、换策略、handoff、暂停或关闭由显式 transition 决定。
4. 进程、宿主或上下文被替换后，系统仍能从已提交事实恢复。
5. 模型和工具宿主可以替换，核心任务语义不随之重写。

## 3. 约束、惯例与假设

### 真实约束

- 终态必须由环境证据验证，不能相信模型自报完成。
- 持久化写入必须单写者、可恢复、可审计；损坏时 fail closed。
- 不可逆或高风险操作必须由真实 sandbox/authz/HITL 边界约束；正则不是安全边界。
- 迁移不能破坏当前 CLI/hook 的公开兼容性。
- 每轮必须有预算、取消和人工接管路径，不能产生无界自触发循环。

### 可改变的惯例

- runtime 只能是 stop gate、scheduler 必须在仓库外。
- 控制协议必须通过 CLI 和 shell 传输。
- 一个 episode 等同于一个宿主会话。
- verifier 必须由 command string 描述。
- `application.mjs` 只公开进程入口，而不公开结构化 application service。

### 承重假设

| # | 假设 | 类型 | 如果错误 | 最便宜验证 |
|---|---|---|---|---|
| A1 | 主动 supervisor 能提高真实长任务的恢复率或正确率 | 未验证 | 维持结构化 gate 即可 | host-only vs host+supervisor 对照任务 |
| A2 | 至少两个宿主值得共享同一 loop 语义 | 未验证 | 可以采用单宿主深集成 | 用两个 adapter 完成同一 fixture |
| A3 | shell 控制面造成了可观测摩擦，而不只是审美问题 | 部分验证 | 去 shell 的 ROI 降低 | 记录 rewrite/deny/人工重试和解析失败率 |
| A4 | 当前事件模型足以承载 work order 与 receipt | 未验证 | 需要新 stream 或 breaking schema | 用现有 `decide/evolve` 做纯内存 spike |
| A5 | 宿主可以提供稳定的身份、usage、tool/result 回执 | 未验证 | adapter 只能降级，跨宿主一致性受限 | capability handshake fixture |

A1 是最可能推翻完整 supervisor 建设的事实，因此必须先评测，而不是先扩状态机。

## 4. 当前实现相对最佳实践的位置

| 维度 | 当前实现证据 | 判断 |
|---|---|---|
| 终态验证 | fresh observation、criterion drift、proof gap、review freshness；`lib/task-engine.mjs:100-197,685-715` | 强，应该保留为内核 |
| 停止与预算 | rounds、writes、wall clock、output tokens、重复失败和无 artifact 进展；`lib/task-engine.mjs:206-221,471-491` | 强，可直接成为 supervisor policy |
| 持久与并发 | hash-chain 事件、torn-tail recovery、原子快照、跨进程锁；`lib/event-store.mjs:369-445,567-614`，`lib/task-store.mjs:20-23,134-177` | 强，是扩展 supervisor 的主要资产 |
| 结构化领域核 | `decide/evolve` 已接收结构化 command 并返回 events/result；`lib/task-engine.mjs:518+` | 强，说明去 shell 不必重写领域规则 |
| 公开控制接口 | `application.mjs` 只导出 `main` 和 recovery；taskloop 命令通过 Bash/PowerShell 字符串识别和 session rewrite；`lib/application.mjs:98-119,1010` | 弱，是首要解耦点 |
| criterion transport | command criterion 在需要时 `shell: true`，否则用空白拆 argv；`lib/criterion.mjs:115-145` | 可兼容，不适合作为新协议 |
| 安全 | grants 与保守拒绝有价值，但源码明确说明不是 sandbox；`lib/supervision.mjs:129-163` | 只能是 policy signal |
| 主动编排 | 没有 durable work order、next-round scheduler、adapter capability 或 resumable execution receipt | 若解除 gate 限制，这是核心缺口 |
| 上下文工程 | 有 episode/cursor/token tally，但没有高信号 resume packet、compaction/handoff contract | supervisor 应拥有 schema，不应拥有 prompt 实现 |
| observability/eval | 审计 ledger 很强，但没有统一 generation/tool/handoff trace，也没有 agent-in-loop outcome benchmark | 在继续扩张前必须补齐 |

## 5. 候选机制淘汰赛

### 方案 A：保持 stop gate，只做结构化接口

机制：把 CLI 前面的控制面改为 JSON/MCP/API，仍由宿主决定何时发起下一轮。

- 优点：最小变更、最少重复、与现有领域模型一致。
- 失败模式：跨 session 的“下一步是什么、谁来继续、崩溃后是否补跑”仍然无人负责。
- 适用条件：真实任务通常在单会话内结束，或宿主已经提供可靠 durable scheduler。

### 方案 B：建设绑定模型和工具的单体 agent runner

机制：taskloop 自己调用模型、组 prompt、执行工具、维护 sandbox、管理 memory 和 UI。

- 优点：端到端控制最直接，单宿主优化空间最大。
- 失败模式：复制 Codex/Claude/Agents SDK 等宿主能力；模型与工具变化都会进入核心维护面；安全责任显著扩大。
- 适用条件：只服务一个稳定模型栈，而且宿主完全无法提供所需控制原语。

### 方案 C：持久化 Loop Supervisor + executor adapters

机制：taskloop 拥有语义调度和持久 transition；adapter 执行一轮并返回结构化回执。

- 优点：补齐跨轮责任，又保留宿主能力；复用现有 event/state/criterion 资产；可逐步迁移。
- 失败模式：如果边界不严格，会与宿主形成双重 scheduler、双重预算和双重 approval。
- 适用条件：长任务、多宿主、恢复和终态证明是核心价值。

### 方案 D：只用 prompt、skill 和人工 runbook

机制：通过工作约定要求 agent 自己记录进度、验证和 handoff。

- 优点：成本最低，适合探索。
- 失败模式：不能在进程崩溃、上下文丢失或模型误判时提供强保证。
- 适用条件：任务低风险、低频，失败可廉价重做。

### 胜者

方案 C 胜出。A 是最接近替代方案，也是 C 在 pilot 失败后的安全退路。B 的端到端控制看似完整，但它改变了 taskloop 的能力类别和安全责任，且违反“只增加被评测证明有收益的复杂度”原则。D 可以作为操作补充，不能替代强状态和终态验证。

## 6. 目标责任边界

| Taskloop Supervisor 拥有 | Executor/Host 拥有 | 通过协议共享 |
|---|---|---|
| task graph 与 artifact revision | 模型调用与 provider API | capability manifest |
| work order、lease、round transition | prompt 组装与具体 compaction | session/worker identity |
| budget policy 与 no-progress policy | 工具执行、sandbox、authz/HITL | usage 与 tool receipts |
| verifier/evaluator policy 与 terminal truth | 原始 generation/tool trace | trace/span correlation IDs |
| durable event、checkpoint、resume decision | 宿主 UI 与交互方式 | structured observation |
| handoff/resume packet 的 schema | 如何把 packet 注入上下文 | artifact/input hashes |

关键边界：taskloop 决定**要做什么和下一状态是什么**；宿主决定**用哪个模型和工具如何执行这一轮**。

## 7. 目标循环

```text
Task State / Graph
       │
       ▼
Supervisor --issue--> WorkOrder + Lease + Budget + ResumePacket
       │                              │
       │                              ▼
       │                       Executor Adapter
       │                    model + tools + sandbox
       │                              │
       │<--submit-- TurnReceipt + Usage + Artifact Delta
       │
       ▼
Verifier / Evaluator
       │
       ▼
Transition Decision
  ├─ next_work
  ├─ retry_with_changed_strategy
  ├─ handoff
  ├─ suspend / human_required
  └─ terminal
```

所有箭头都是结构化、版本化协议；shell 只允许存在于 legacy CLI adapter 或显式 `shell` criterion 中，不能再承载控制语义。

## 8. 最小协议

建议先冻结语义，不先押注 MCP、JSON-RPC 或某个 SDK：

```text
CapabilityManifest
  host, protocol_version, supports_resume, supports_usage,
  supports_approvals, supports_tool_receipts

WorkOrder
  task_id, work_order_id, artifact_revision, goal_slice,
  acceptance, envelope, budget, lease, resume_packet, trace_context

TurnReceipt
  work_order_id, status, artifact_delta, observations,
  usage, tool_receipts, handoff_note, trace_context

TransitionDecision
  next_state, reason, next_work_order?, required_human_action?,
  persisted_event_cursor
```

传输适配优先级：

1. 进程内 application service，作为唯一语义入口。
2. JSON stdio adapter，最容易做确定性 fixture 和崩溃测试。
3. MCP 或宿主原生 adapter，只做协议映射。
4. CLI 保留为人工和兼容入口，但内部调用同一 service。

criterion 同步增加显式 argv 形态，例如 `{ kind: "exec", executable, args }`；旧 `{ kind: "command" }` 作为 legacy escape hatch，而不是默认。

## 9. 上下文、handoff 与多 agent

Supervisor 不应保存或重放整段 conversation。它应生成小而高信号的 `ResumePacket`：

- 当前目标切片与不能破坏的约束；
- 已验证事实、未解决失败和最后一次 transition 原因；
- artifact revision、关键文件/输入 hash；
- 剩余预算和允许的动作 envelope；
- 下一步可验证动作；
- 原始 trace 的引用，而不是全部 trace 内容。

多 agent 不应是第一阶段。只有在单 worker supervisor 证明收益后，才加入 parent/child task、worker lease 和 join。强依赖的编码修改默认串行；可独立验证的调查或评测才并行。

## 10. Observability 与 agent-in-loop eval

事件 ledger 回答“状态如何变化”，trace 回答“这一轮为什么这样执行”，eval 回答“这套系统是否真的更好”。三者不能互相替代。

最小评测矩阵：

| 指标 | 必须回答的问题 |
|---|---|
| terminal correctness | 是否真的满足环境 criterion，有多少 false close |
| gate friction | 有多少 false hold、rewrite/deny、人工 join/resume |
| recovery | 崩溃后是否重复工具副作用、丢失进展或错误续跑 |
| efficiency | 成功任务的 tokens、turns、tool calls、wall clock |
| intervention | 每个任务需要多少次人工接管和原因 |
| portability | 同一 fixture 在两个 adapter 上是否保持相同任务语义 |

对照组至少包含：host-native、host + structured gate、host + supervisor。没有这个三组对照，就无法知道主动编排是否比结构化 gate 多出的复杂度更值。

## 11. 范围与成本

以下是决策定价，不是实现顺序；均为当前代码规模下的粗估，必须在 tracer bullet 后重估。

| 范围 | 组件 | 工作量 | 风险 | 价值 |
|---|---|---:|---|---|
| 核心 | versioned WorkOrder/Receipt/Transition schema 与 capability handshake | 2–3 日 | schema 过早固化 | 消除隐式协议 |
| 核心 | 纯 supervisor transition engine，复用现有 task engine 事件语义 | 3–5 日 | 双重状态机 | 主动拥有下一轮 |
| 核心 | application service + JSON stdio adapter | 2–3 日 | assembly 边界变复杂 | 去除控制面 shell |
| 核心 | 单 worker lease、crash resume、幂等 receipt | 3–4 日 | 重复副作用 | 跨轮可靠性 |
| 支撑 | 显式 argv criterion + legacy command 兼容 | 1–2 日 | 平台差异 | 降低 shell 歧义 |
| 支撑 | agent-in-loop 三组对照 eval 与 trace correlation | 3–5 日 | fixture 代表性不足 | 证明或否定收益 |
| **总计（核心 + 支撑）** | 生产级单 worker supervisor | **14–22 日** | | |
| 可选 | MCP adapter | 2–4 日 | 协议绑定 | 扩宿主 |
| 可选 | parent/child task 与多 worker join | 5–8 日 | 并发语义爆炸 | 独立任务并行 |
| 可选 | evaluator model adapter | 2–4 日 | judge 偏差 | 非确定性任务反馈 |

如果 14–22 日的定价明显超过真实事故/摩擦成本，完整建设应退回 DEFER；但 5–8 日 tracer bullet 仍值得作为决策实验。

## 12. 演进门禁

### Gate 0：charter 决策

owner 必须明确接受：taskloop 从“被动完成门”变为“主动、持久的语义 supervisor”。在此之前不修改当前方向性文档或公开定位。

### Gate 1：结构化 tracer bullet

只做单任务、单 worker、单 adapter。必须证明：

- 新控制路径完全不解析 shell；
- event authority 与 snapshot recovery 语义不退化；
- receipt 重放不会重复 transition；
- CLI/hook 全量测试继续通过；
- 至少一个两轮任务可在进程重启后完成。

### Gate 2：结果评测

运行三组对照。只有 supervisor 相比 structured gate 在 terminal correctness、recovery 或人工介入上有实质提升，且成本可接受，才进入生产化。

### Gate 3：第二宿主

第二 adapter 是宿主中立性的证伪测试，不是市场扩张。如果必须为第二宿主修改核心语义，说明协议边界失败。

### Gate 4：多 worker（可选）

只有单 worker已稳定、任务确实可独立分解且并发收益覆盖额外 token 成本时才进入。

## 13. 反向失败测试

在以下条件下，Loop Supervisor 会成为最差方案：

1. 真实任务绝大多数单轮完成，恢复价值接近零。
2. 只有一个宿主，且宿主已经提供稳定的 durable execution、HITL、trace 和 scheduler。
3. taskloop 与宿主同时决定 retry/stop，导致双重预算和重复工具副作用。
4. adapter 无法提供可信 identity、usage 或 artifact receipt，supervisor 只能相信自然语言。
5. 团队没有能力维护跨宿主兼容矩阵。

缓解方式不是继续加规则，而是：单写者 lease、capability negotiation、幂等 receipt、明确 ownership table，以及在 Gate 2 失败时收缩回 structured gate。

## 14. 不做什么

- 不在第一阶段自建模型 provider client。
- 不自建通用 shell/tool sandbox；只集成宿主真实安全边界。
- 不把 regex supervision 描述成安全强制。
- 不保存完整 conversation 作为恢复协议。
- 不先做多 agent、DAG UI、向量 memory 或 marketplace。
- 不因为已有复杂 event model 就假设继续扩状态机一定有价值。
- 不在没有对照 eval 的情况下宣布 supervisor 优于 gate。

## 15. 外部证据

- Anthropic 建议从简单、可组合的 loop 开始，只有评测证明收益时增加复杂度；环境反馈、明确停止条件和人工检查点是 agent 可靠性的基础：[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)。
- 工具应有清晰边界、无歧义参数和高信号输出；ACI 设计会直接改变 agent 表现：[Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)、[SWE-agent paper](https://arxiv.org/abs/2405.15793)。
- 长任务需要 compaction、结构化 note/handoff、fresh context 或 subagent 等不同上下文策略，不能依赖无限增长的 conversation：[Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)。
- 编码 agent 的 eval 应优先验证环境 outcome，同时保留 trajectory、成本和人工抽查；不能用脆弱的固定路径评分：[Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)。
- OpenAI Agents SDK 把 loop、max turns、HITL serializable state 和 tracing 作为宿主能力，说明 taskloop 若扩张必须避免复制这些执行层原语：[Running agents](https://openai.github.io/openai-agents-python/running_agents/)、[Human in the loop](https://openai.github.io/openai-agents-python/human_in_the_loop/)、[Tracing](https://openai.github.io/openai-agents-python/tracing/)。
- Anthropic 的长任务 harness 研究支持显式 handoff、独立 evaluator 和增量可验证工作，同时也显示完整 harness 可能非常昂贵，应该持续做消融并移除无收益组件：[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)、[Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)。

## 最终建议

解除 stop-gate 限制后，taskloop 的最佳演进类别是：

> **一个以环境终态为真相、以事件为权威、以 WorkOrder/Receipt 为协议、以 adapter 执行单轮工作的 durable Loop Supervisor。**

它应该比 stop gate 多拥有“下一轮和恢复”，但比 agent framework 少拥有“模型、工具和 sandbox”。这条中间边界既利用了 taskloop 已有的强资产，也对最容易失控的重复建设设下了停止线。
