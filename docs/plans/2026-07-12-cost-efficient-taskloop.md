# Taskloop 成本高效可信收口方案

版本：`chat-plan-r6-zh`

> 本文是已通过第二模型评审的 `chat-plan-r6` 的中文等义版本。代码标识、状态值、公式、阈值和执行顺序保持不变；由于文本经过翻译，文件哈希不再等同于英文受审版本。

## 1. 目标、边界与权责

目标：在不削弱判据完整性、写入边界安全、生命周期诚实性和风险分级评审的前提下，降低每个可信完成任务的推理成本。

近期确定交付的产品**仅为 Phase A**：sidecar 影子遥测、离线归因与报告、仅告警建议。它不改变任务 schema、生命周期、Stop 输出或 driver 行为。Armed enforcement 是可选后续项目，不是默认终点；只有 Workstream 0 针对明确的 host/version 证明 exact usage、稳定 session identity、同步 pre-next-call barrier、disposition acknowledgement 和安全 hook 兼容性后才可启动。任一证明失败，都停止 armed 工作；Phase A 仍是完整且有价值的交付。

Taskloop 继续保持 proof/stop-gate 内核定位，不创建 session、不选择模型、不调度 agent，也不承诺阻止不遵守协议的 driver：

1. **Kernel**：拥有已接受的 usage observation、任务成本投影、告警、预算触发挂起、证明状态和 Stop disposition。
2. **Versioned host adapter**：负责解析 host 数据、规范化候选 identity、声明 capability 和传递 acknowledgement。Kernel 始终是最终的幂等接收者与去重权威。
3. **Host driver**：负责创建/终止 session，并确认 disposition。

只有完成 capability handshake 的 `armed` binding 才能声称有硬执行能力。缺失、过期或不确认的 binding 进入 `degraded`；Taskloop 记录事实，但不声称已阻止后续调用。

Phase A 使用现有 `task_id` 归因成本；同一任务的 revision、reviewer session 和 resume 保持该归属。split/merge/import lineage 延后到出现真实跨任务归因需求后再做。本方案继承当前 `repo_identity = hash(absolute path)` 在 clone/worktree 之间不稳定的限制，并如实报告。

## 2. 权威协议

本节描述可选 armed 扩展；Phase A 不依赖这些能力。

成本是独立投影，不是第二套任务生命周期：

```text
cost_control.mode = disabled | shadow | armed | degraded
cost_control.pressure = normal | warning | exhausted
task lifecycle = active | suspended(reason) | terminal(outcome)
```

只有已接受的 exact observation 可以把 `pressure` 置为 `exhausted`。Armed 模式下，它触发现有 `suspended(out-of-budget)` 转移；随后 Stop 放行并携带 disposition。估算 observation 只能告警。

Handshake 声明 adapter/host/schema 版本以及 exact usage、request identity、parent session、session disposition 和 acknowledgement 能力。Stop 在发出 `disposition(id, task_revision, end | end_and_resume_fresh)` 前先持久化 `pending_ack(id, monotonic_deadline, boot_clock_context)`；driver 返回 `disposition_ack(id, session_id, accepted | unsupported | failed)`。

Armed driver 必须暴露稳定 host session ID，在下一次模型调用前同步提交上次调用的 exact usage，并处理所有 pending disposition。收到 accepted acknowledgement 前，执行保证只是 provisional。deadline 到期、driver 静默、disposition 后继续请求或 acknowledgement 失败，都会立即把 binding 降为 degraded。无法提供该 barrier 的 driver 只能处于 shadow/degraded。测试覆盖静默、迟到确认、重复确认和 disposition 后调用。

## 3. 成本遥测

定义版本化 `UsageObservation`：host/adapter 版本、非敏感 `account_instance_id`、现有 task/task revision、session/parent/role、request ID、counter epoch、uncached/cached/output/cache-write tokens、model/provider/pricing version、timestamp、cursor，以及 `precision=exact|estimated`。

不变量：

- Adapter 提供规范化候选 identity；Kernel 按 `(host, account_instance_id, session_id, counter_epoch, request_id)` 权威去重。namespace 使用本地随机标识，不使用账号名或凭证。
- 允许乱序交付，但按稳定 identity 而非到达顺序投影。
- 相同 identity 的 retry 只计一次；provider 发放新 request ID 时单独计数。
- Codex cumulative counter 按 epoch 转为 delta。只有 cursor 有序的 host reset 证据或新的 host session/counter epoch 才能切换 epoch。迟到的小快照视为旧数据；无法判定的下降会降低 precision，不创建虚假 exact epoch。
- Cursor 与任务状态原子持久化。rotation、truncation、crash recovery、重复、畸形数据、缺失 parent 和 counter reset 都有 fixture；无法确认时进入 degraded。
- Role 为 `implementation | reviewer | resume`。Kernel 根据 session lineage 和 review-request ID 推导 role/parent；adapter 不能自行标记成成本更低的角色。Armed 前必须通过 schema 与 capability fixture。

分别报告：

1. 物理量：uncached/cached/output token、调用数和 session 数；
2. 标准化参考成本：`(uncached_input * reference_input_rate + cached_read * reference_cache_read_rate + cache_write * reference_cache_write_rate + output * reference_output_rate) / 1,000,000`，按版本化价格快照换算为固定 USD-equivalent units。

订阅 quota 权重未知时保持 unknown。对比只在相同 host/model stratum 内进行，并用同一预注册价格快照重算两组。没有可信价格的模型把 normalized cost 标记为 `not-comparable`，仅报告物理量和调用数；该 stratum 在本版本中只能保持 shadow。若要使用物理量作为生产准入门，必须另行预注册修订。

Shadow 模式只写 `.taskloop/usage-v1.jsonl`，不改变 task schema 和 outcome ledger。Append 复用现有 task lock、唯一 event ID、行 checksum、cursor commit 前 fsync、partial-tail recovery 和 audit command。Compaction 原子写入新 generation，并在评估窗口保留源 generation。该文件是协作式遥测，不是防篡改安全证据。

建立覆盖 Claude/Codex 版本的脱敏 replay corpus。抽取 10 个 session 时，各 token 类别与 host 报告的物理总量误差不得超过 2%；声称具备 exact request identity 时，重建 request 数必须完全一致。`cost-report --explain <task>` 和机器可读 reconciliation report 列出每个投影的原始 observation ID。

本机已观察到、但 Workstream 0 通过前不视为支持契约的候选来源是：Claude JSONL 中按 request 记录的 `message.usage`，以及 Codex 中包含 cached/input/output total 的 cumulative `token_count` event。Phase A 可异步解析。缺少 exact input/cache 分类的 host 标记为 partial，不能使用 normalized-cost gate 或 armed token budget。

## 4. 预算不得削弱证明

Phase A 只输出 warning/recommendation。以下改变生命周期的行为全部属于可选 armed mode。

新增 exact total input tokens、模型调用数、implementation session、reviewer session、review attempt 和 wall clock 限制；保留现有 rounds、writes 和 output-token 限制。

- 80%：agent 可选择 handoff；无显式选择或用户不在场时默认 suspend。
- 100% exact usage 且处于 armed：以 out-of-budget 挂起并放行 Stop。
- 硬挂起始终要求已接受的 exact usage。Estimate（包括保守上界）只能告警或建议挂起，不能触发状态转移。
- 成本压力不能修改 goal、criterion、envelope、risk 或 assurance。只有用户明确授权的 amendment 才能改变证明义务。
- 默认 review quota 为一次初审加一次复核；耗尽后挂起等待用户，绝不静默豁免。
- Exact input 是 cached 与 uncached input 之和。Barrier 把异步超支限制在最多一个已声明的 in-flight request；必须记录超支。迟到 exact observation 可更新报告，但不能改写 terminal outcome。Override 不能绕过已耗尽的成本、证明或 review budget。
- 如果一个 in-flight long-context request 就可能突破预注册经济损失上限，则该 host/model 不能 armed。

## 5. 每个实现 Session 只承载一个任务

可靠 host session identity 是前置条件。本工作必须排在现有 session-scoped Stop-gate 方案之后，或吸收其实现；此前 Phase A 只能报告 session 证据，不能执行 per-session ownership 或 budget。

Reviewer session 和有界 resume session 分别计数。Taskloop 只发出、不执行 `session_disposition=end` 或 `end_and_resume_fresh`。

`taskloop handoff` 原子写入版本化、最大 32 KiB 的 resume packet，包含 goal/criterion 引用、envelope、proof/assurance 状态、剩余义务、repository identity、HEAD、dirty path 名称和 envelope 内 dirty file hash。Failure evidence 只能是结构化 command/check reference、exit/verdict 和有界脱敏诊断。禁止包含 transcript、原始日志、文件内容、凭证和个人数据。通过字段 allowlist、secret-pattern redactor、path normalizer 和对抗 fixture 执行边界。只有用户可授权非结构化 evidence；ledger event 只记录字段名，不记录值。无法安全脱敏时 handoff fail closed，只保存本地 evidence reference/hash。

Resume 校验 schema、repo identity、task revision、HEAD 和 dirty hash。不匹配时拒绝自动 resume，要求 reconciliation。Packet 作为私有任务状态保留到 terminal 后的可配置短期窗口；清理由显式 maintenance command 执行。

同一 implementation session 打开第二个任务时告警。Armed 模式只有超过 exact context/call 阈值后才拒绝；用户可显式 override，且理由必须记录。

跟踪 packet 大小与新 session rediscovery time。如果 median rediscovery cost 抵消 context savings，则不能 armed。

## 6. 不接受过期证据的 Review 成本治理

```text
criterion green -> review-ready freeze -> full initial review
-> remediation -> required recheck -> terminal
```

- Routine 默认不 review。
- Substantial 执行一次 fresh-context 全量初审。复核在另一个 fresh session 运行；可使用相同 model/reviewer identity，但必须独立于 implementation session，且不能延续 reviewer context。只有 canonical changed path/hash 完全落在原 review scope 与 finding-linked path 内时才允许 focused recheck。
- 变更超出该集合，或发生 criterion/envelope/risk amendment、dependency/permission change、cross-module signal 时，升级为 full recheck。
- Critical 始终执行规定的 second-model 初审，并在 remediation 后执行 fresh-session final full review。最终评审可以使用相同外部 second model；存在不同已配置 runtime 时不得使用 implementation model/runtime。Receipt 包含 provider、model、runtime、session ID 和 session 分离证据；这是协作式 provenance，不是密码学认证。
- Receipt 对 task/revision、criterion generation、repo/HEAD/dirty hash、scope、review verdict、finding ID、severity/content hash、finding state、check、evidence hash 和 independence level 的 canonical stable JSON 做 hash。
- Finding state 为 `open | fixed | rebutted-and-accepted | optional-risk-accepted`；blocker/should-fix 不能通过接受风险关闭。
- 任意 artifact 变更都会使 closure receipt 失效，直到规定 recheck 通过。
- Reviewer 接收冻结的 task brief、diff、check 和 prior finding，不接收 parent transcript。

## 7. 风险与成本策略

现有 risk-based assurance 继续作为 review requirement 的唯一来源；成本默认值是独立映射。Machine risk floor 始终权威。Risk 可以提高；降低必须由用户明确授权、记录理由和 ledger event，且不能低于 machine floor。Under-classification 信号包括多个 envelope root、public-contract change、destructive/network/install grant、permission change 和超出 scope 的 finding。全部任务声明 critical 时只报告 calibration anomaly，不自动降低。

Shadow 默认值：

```text
routine: 一个 implementation session；无 reviewer
substantial: 一个 implementation session；同一时间一个 reviewer；
             一次初审加一次复核
critical: 一个 implementation session；最多两个有界 reviewer session；
          second-model review 加 final full review
```

## 8. 兼容、迁移与回滚

Phase A 是纯 sidecar shadow telemetry。进入 armed 前测试 old CLI/new sidecar、new CLI/no sidecar、in-flight upgrade、stale/missing adapter、malformed/out-of-order observation、log rotation/counter reset、旧 host 忽略 additive Stop field、upgrade/downgrade 和 acknowledgement failure。

Phase A 所有数据保存在版本化 sidecar，不增加 Stop 字段。Taskloop 当前严格 clean-break task-schema 规则保持不变。未来 armed mode 若需要 task-resident field，必须提升 `TASK_SCHEMA_VERSION`，走现有 clean-break 路径：拒绝不匹配状态、要求显式 archive/migration，并在旧 client 运行前由新 client 完成 downgrade 准备。不声称支持 unknown-field tolerance。只有明确 host contract test 证明安全后，才能增加 Stop/disposition 字段。复用 `suspended(out-of-budget)` 也以这些 gate 通过为前提。

Kill switch 覆盖全局 governance、Claude adapter、Codex adapter、review quota 和 disposition。Downgrade 忽略可选 sidecar，同时保留 proof state。Rollback test 必须证明关闭 governance 后恢复原 Stop 行为且不丢失任务证据。host/version 的 compatibility 与 rollback matrix 未通过前不能 armed。

未来 armed schema 的 downgrade 顺序：使用新 CLI 停止 observation，处理或取消 pending acknowledgement，快照 sidecar，运行 `disable-cost-control --prepare-downgrade`，把 armed state 导出/归档为之前的 clean-break schema，验证后再运行旧 client。已 out-of-budget suspended 的任务保持挂起；downgrade 后由用户显式 resume。不能要求旧 client 关闭无法读取的 schema。

## 9. 验证与发布决策

### Phase A 完成门

Phase A 不等待 armed-mode 可行性或随机实验任务量。完成条件：两个 adapter 都能 replay 当前本地格式；所有 estimate 标记为 exact/partial/estimated；任务归因与 request count 通过 reconciliation corpus；warning-only report 能识别已知巨型 session outlier；sidecar/rollback test 通过；现有 task/Stop 行为零变化。

运营价值通过观察性指标衡量：host/version 覆盖率、归因误差、报告延迟、抽样 false/missed anomaly 和 telemetry overhead。此阶段不声称因果性降低成本。

### 可选 Armed-mode 实验

只有 Workstream 0 对明确 host/version 通过、session-scoped ownership 已存在，且预注册证明在有界时间内有足够 eligible volume 达到统计功效时，才进入以下阶段。否则长期保留 Phase A warning-only，armed 工作以当前不可行为由关闭。

Assignment 前预注册 inclusion/exclusion rule、observation window、metric formula、blinded audit rubric/adjudication 和 power calculation。按 host/model/repo/risk/change-size stratum 使用确定性 hash 前瞻分配到 concurrent control 或 pilot；禁止看到结果后分组。只排除 synthetic probe 和 assignment 前已由外部取消的任务。User-abandoned、suspended、timed-out 和 incomplete task 保留在 denominator 中作为 censored/non-completion。持续运行到达到预注册 power target。每个 host/model stratum 每组至少 15 个任务；稀疏 stratum 继续 shadow，不得事后合并。Critical 继续 shadow-only。

成本指标：

- Primary：所有 attempt 和 implementation/reviewer/resume session 的 normalized inference cost 总和，除以 trustworthy completion 数（`terminal(achieved)` 且满足 proof/review）；同时报告 censored-task cost 和 completion/outcome rate。
- Secondary：各类物理 token、调用数、implementation/reviewer session、resume、suspension、override 和 abandonment rate。

Assignment 前冻结 control/pilot policy/configuration version、host version、model default 和 price snapshot。Routine pilot 最少 30 个 control 与 30 个 pilot task。准入要求：cohort cost per trustworthy completion 至少下降 50%；completion rate 在 5 个百分点 margin 内 non-inferior，使用 one-sided 95% Newcombe interval；充分样本的 host/model stratum 成本回归 one-sided 95% upper bound 不超过 10%。Cost ratio 使用 stratified BCa bootstrap；任一 arm 零 completion 时不得通过。只有每组至少 100 个任务后，P95 call reduction 才能作为 gate，并使用 Harrell-Davis quantile 与 stratified bootstrap interval；此前只报告 P90。

质量规则：

- Routine：completion 后观察 7 天。Independent auditor 不知道 arm 和 rotation status，以相同预注册抽样率审计两组；初始 cohort 为 100%。Evaluation-only audit cost 单独报告，并对称排除在 operational cost 外。Reopen/rework 和 blocker-or-should-fix rate 必须在 5 个百分点 margin 内 non-inferior。任何 critical blocker 或由 truncation/session rotation 导致的 blocker 立即停止实验。
- Substantial：最少 30 个 control 和 30 个 shadow-pilot task。先执行 focused recheck，再执行 blinded sentinel full review。同时报告 total experimental cost 和只排除 sentinel full-review 调用的 counterfactual operational cost。Sentinel 独有发现 blocker/should-fix 时，把 counterfactual task 标记为未可信完成并拒绝 focused recheck；sentinel finding 触发的 remediation 标记为 experimental，不能改善 counterfactual denominator。只有成本至少改善 30%、completion 在 5 点内 non-inferior、operational reviewer session 不增加，且 stratum regression bound 不超过 10% 时才能启用。
- Critical：本方案不改变其行为。
- Armed driver 必须确认 disposition，之后最多允许一个已 in-flight 调用；失败会降级 binding，并使 enforcement claim 失效。

任务 observation window 关闭、pending acknowledgement 已处理或超时，并应用固定 reference-price snapshot 后，才能冻结分析数据集。之后迟到 exact observation 只能生成 amendment report。Evaluation owner 是明确的人类 maintainer；独立 reviewer 签署预注册分析与 rollout decision。报告联合 cost/quality frontier 和所有 censored outcome。

Rollout：Phase A current-schema trace → sidecar telemetry → replay validation → warning-only report。可选 Phase B：明确 host 的 routine armed pilot → substantial review pilot → critical 保持不变。

## 10. 工作计划

| 顺序 | Workstream | 工作量 | 依赖 |
|---|---|---:|---|
| 0 | 当前 schema/hook trace 与 host payload 可行性 spike | 2 天 | 无 |
| 1 | 协议/状态设计与兼容 fixture | 4 天 | 0 |
| 2 | Usage schema、sidecar、corpus 与 accounting | 4 天 | 1 |
| 3 | Claude adapter | 3 天 | 2 |
| 4 | Codex adapter | 3 天 | 2 |
| 5 | Budget projection、handshake 与 disposition/ack | 4 天 | 2–4 |
| 6 | Resume packet 与完整性检查 | 3 天 | 1、5 |
| 7 | Review receipt/freeze/recheck policy | 4 天 | 1、5 |
| 8 | Migration、kill switch、rollback test 与文档 | 3 天 | 3–7 |
| 9 | Routine concurrent intervention cohort | 2 个工程日；持续到统计功效满足 | 8 |
| 10 | Substantial paired focused/sentinel validation | 2 个工程日；持续到统计功效满足 | 8 |
| 11 | 统计分析与 censored-cost reconciliation | 2 天 | 9–10 |
| 12 | 独立签署与 rollout decision | 1 天 | 11 |
| **总计** | | **37 个工程日** | |

Accounting core 完成后，Claude 与 Codex adapter 可以并行。Armed mode 必须等待目标 host/version compatibility 与 rollback gate。

确定交付的 Phase A 为 16 个工程日：Workstream 0（2 天）、WS1 中 Phase-A protocol/sidecar compatibility（2 天）、WS2（4 天）、WS3（3 天）、WS4（3 天），以及 WS8 中 Phase-A rollback/reporting（2 天）。可选 Phase B 为剩余 21 天；可行性和任务量 gate 未通过时不排期。

Phase A 不依赖尚未合并的 session-scoped Stop-gate 和 review-dispatch 方案；Phase B 必须排在它们之后，或吸收其 session ownership 与 receipt/request substrate。

Workstream 0 必须产出版本化 Claude/Codex payload sample、当前 task/ledger/hook schema、transition map，以及六项 verdict：exact usage、stable session identity、pre-next-call barrier、acknowledgement return path、additive Stop field、clean-break downgrade 是否可用或安全。同时估算 eligible task volume。任一 capability verdict 失败或任务量不足，都停止该 host 的 armed-mode 工作；sidecar shadow telemetry 继续。另测量 hook CPU、磁盘和延迟开销。

## 11. 反转测试与停止点

以下情况下设计会成为最差方案：telemetry 不稳定、governance 变成隐藏 scheduler、session rotation 的 rediscovery 成本超过 context savings，或表面节省来自 abandonment/censoring 转移。缓解措施是版本化 degraded adapter、明确 ownership/acknowledgement、hash-bound resume packet、shadow validation，以及 cohort-total censored-cost accounting。

永远不要把模型选择、session 创建或 subagent 调度加入 kernel。无法提供可靠 exact usage 的 host 保持 warning-only，不能假装具备准确硬 token enforcement。

## 评审结论

英文原版 `chat-plan-r6` 已通过完整第二模型复审：

```text
revision: chat-plan-r6
verdict: GO
blockers: []
should_fix: []
```

评审确认：Phase A 可基于现有 Taskloop 基础实施；所有 Phase B enforcement 都被正确约束在 Workstream 0、session ownership、host capability 和任务量 gate 之后。
