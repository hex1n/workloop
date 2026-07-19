# 《从循环到图》框架 vs taskloop 现状对照

**问题**: 在 IntuitMachine《从循环到图》的框架（单循环四失败 / 图的四拓扑回答 / 锚点·冻结节点·图外判断 / ungrounded vs grounded 轴）下，taskloop 处于什么位置——哪些已实现、哪些缺失、文章会批评什么？
**深度**: Standard
**核心结论**: taskloop 不是"正在从循环迁向图"的中位数案例——文章的三必需品（锚点、冻结节点、图外判断）已是显式实现并有决策文档记录推导，两处（测量衰变的含糊计价、闸门反噬定律）比文章更深；真实缺口在文章开篇案例那一层——关单后成果是否存活的慢反馈（"续约率"传感器）不存在，且审计通道单一。
**产物类型**: supporting
**验证状态**: 本 session 读取 `AGENTS.md` 全文、`skills/meta-loop|judgmentloop/SKILL.md` 全文、`lib/task-engine.mjs:100-184`、三份 2026-07-16 决策文档全文；grep 核实 `criterion.mjs` 判据执行、`agent_id` 锚落地、ledger 查询面、检测器自述。未逐行读完 `lib/application.mjs`（1522 行）与 `lib/supervision.mjs`（2293 行）。**同日追加**：存活连接 spike 在本仓库亲跑（见文末追记），开放问题 1 已关闭。
**开放问题**: 1 — 见文末（原开放问题 1 已由追记关闭）
**关联**: `2026-07-19-loops-to-graphs-article-digest.md`（文章要点译注）、`2026-07-11-taskloop-vs-loop-engineering.md`（业界分层对照）

## 逐项对照

### 文章的四种单循环失败 → taskloop 的应对

| 文章概念 | taskloop 实现 | 判定 | 证据 |
|---|---|---|---|
| 古德哈特（指标被刷） | 判据被定性为"真相的有损代理"；配对手段 = 风险驱动的强制评审 + 判据指纹（中途改写 = 新 generation，作废已有评审） | 部分覆盖 | `lib/task-engine.mjs:136-143`；`docs/decisions/2026-07-16-gate-input-epistemology.md` |
| 向上盲目（参照值无人质疑） | 参照值修订受治理：amend 走 grant、判据改写产生新代、grant 词汇只从真实 deny 证据生长 | 已实现 | `AGENTS.md:24`；`skills/meta-loop/SKILL.md:49-70`（authority_friction 挖掘） |
| 循环冲突（仲裁缺位） | 只有互斥没有仲裁：并发会话按对方仓库 envelope 相交判冲突；宿主风险底线永不下放 | 最小实现（设计上出让：driver/调度器在仓外） | `AGENTS.md:25-26`、`AGENTS.md:32` |
| 测量衰变（无人看守看守者） | 完整性是账本一等输出：covered/gapped/unknown 三态；序号跳空/重置朝诚实方向退化；传感器缺席报 unknown 不报 zero | **超出文章** | `skills/meta-loop/SKILL.md:16-34`；`docs/decisions/2026-07-16-adoption-observation-into-ledger.md` 决议 3/5 |

### 文章的三必需品 → taskloop 实现

| 必需品 | taskloop 实现 | 证据 |
|---|---|---|
| 锚点 | 判据由 runtime 自己 `spawnSync` 执行、读退出码；`verify --record` 持久化 `cli_verify` 溯源观测；评审独立性锚在宿主递来、agent 写不到的 `agent_id` | `lib/criterion.mjs:191-203`；`lib/application.mjs:747-771`；`lib/host-hooks.mjs:38` + `lib/application.mjs:1220`（已落地） |
| 冻结节点 | 机器风险底线不可豁免（waived 仅在底线 routine 时生效）；不可逆权力硬抬 critical；`self_reread` 结构性排除在评审梯外 | `lib/task-engine.mjs:150`、`:131`；`docs/decisions/2026-07-16-review-independence-anchor.md` 决议 1 |
| 图外判断 | 内核显式承认"够不到人"：`--granted-by user` 验证不了；judgmentloop 终结动词属于人；meta-loop 无机器阈值、永不无人值守 | `docs/decisions/2026-07-16-gate-input-epistemology.md` 决议 5；`skills/judgmentloop/SKILL.md:50-51`;`skills/meta-loop/SKILL.md:94-96` |

## 仓库比文章深的两处

1. **闸门反噬定律**：文章只说"某些节点必须冻结"；仓库发现冻结错误的节点会消灭信号本身——焊死诚实的自签（可观测）只会把行为洗成不可区分的橡皮图章（票 12 决议 2 的 P1→P2 论证；在 08/12/16 三票中反复成立为"记账优于闸门"）。
2. **含糊计价**：文章只说测量会衰变；仓库把"看不清"本身变成信号——写入不可归因升格为缺口信号、检测器盲区有声化、"声称 fresh_context 却无锚"成为账本可查询的类（票 16 决议 3/4）。谎不被拦，但留指纹。

## 文章会批评什么（按严重度）

1. **关单后无慢反馈——"续约率"传感器缺失**。账本查询面只有 `unanchored_review_claims` 与 `authority_friction`（`lib/application.mjs:1251-1255`）；`outcome-projector.mjs` 中 revert/reopen/regression 零命中。achieved 的成果次周被回滚、被后续任务重写、判据通过但用户弃用——都不会回流账本。票 13 的 adoption 观测覆盖"绕过监督的**工作流**是否补单"，不覆盖"关单的**成果**是否存活"。这正是文章开篇案例的形状：解决率漂亮，流失率在图外。
2. **审计通道单一**。meta-loop 被要求只读 `ledger --json`（`skills/meta-loop/SKILL.md:9-10`）。完整性三态防传感器缺口，防不了投影器自身的错——fold 有 bug 审计者原样继承。仓库历史即证据：票 12 记录过账本白名单销毁字段、文档错误"持续生产错误的票"等审计输入被污染的真实案例。缓解：锚行来自执行过的命令，人随时可读原始文件；但独立第二传感器不存在。
3. **冻结节点是协作式的**。命令安全检测自述 "it raises the cost of the obvious dangerous forms, it is not a sandbox"（`lib/supervision.mjs:1095` 附近）。仓库的处置是定价后接受（票 16 决议 3）而非修复——自家框架内自洽，但按文章"冻结规则在压力下保持冻结"的标准，该节点多孔；真正的硬边界显式让渡给宿主层。

## 边界与开放问题

- 本对照不裁决批评 1 是否该修（first-principles 规划问题）。仓库对分层并非无知：`2026-07-11` 研究已声明 driver 层与部分反馈层是"声明过的分层而非遗漏"。
- **开放问题 1（已关闭，见追记）**：`sync-outcomes` 经读源证实是同一事件流向全局投影的重放同步（`lib/application.mjs:1140-1148`），不是关单后现实的再入账；批评 1 成立。
- **开放问题 2**：批评 2 的"投影器污染审计"依据历史决策文档先例，未在当前代码上构造实际复现。

## 一句话收束

文章的轴是 ungrounded vs grounded；taskloop 在"关单时刻之前"是高度 grounded 的实现（锚到退出码、承认人不可观测），但它的图在关单时刻**闭合**——真正的续约数据永远在关单之后到货。

## 追记：存活连接 spike（2026-07-19，本仓库亲跑）

规划（first-principles，chat 收口）裁定：候选 1 BUILD 阶段 1（一个只读账本查询 + meta-loop 技能一步）、候选 2 并入（git 即独立第二通道）、候选 3 NO_BUILD（维持票 16 定价）。落地前的验证步骤为"在本仓库人工跑一次连接"，结果：

- **样本**：`.taskloop/events.jsonl` 中 9 任务、5 achieved；提取 achieved 任务的关单时刻与非合成写集，对 `git log --name-status --since=<关单>` 做文件级连接。
- **真实命中 n≥1（形态是换代不是回滚）**：roadmap 任务 `ed7df509`（07-16 关单）落地的 runtime contract 4 / 版本化工件命名，07-18 被 `50dd6ab` 换代——其判据锚被改名（`tests/runtime-v4.test.mjs → runtime-v5.test.mjs` R079、`tests/fixtures/runtime-contract-4.mjs → runtime-contract-5.mjs` R097），`65a9eb0` 同日把 evidence ledger 改 versionless，旧账本 rebuilt empty 不迁移（`AGENTS.md` 约定所载）。achieved 记录仍在账本，其证明过的契约已翻篇——账本对此不可见。
- **误报形状（喂 spec 三条）**：① 落地提交在关单之后（`1f858e2` = 关单 +3 分钟；`ee9d969` 一次落地三个任务），join 必须排除任务自己的落地提交且归因需要证据；② 文件级 M 在热仓库是纯噪声（ed7df509 的 31 文件三天内 27 个被改），真信号在 D/R、fixture/契约换代、revert 语义；③ 关单后零提交读作 unknown 不读作存活。
- **契约缺口坐实**：提取步骤只能直读原始事件流（meta-loop 的 ledger-only 契约不允许）——缺的恰是 `ledger --json` 暴露 per-task 终态写集这一个查询。
- **阶段 2 提示**：判据重跑在此案例会直接无法执行（判据文件已改名）——抓得到换代，分不清换代与回归，须留在有人值守阶段 2。

**结论**：BUILD 阶段 1 维持，spec 字段从 spike 直接读出：终态任务的 `task_id`、终态结局、关单时刻、非合成写集；解读（M vs D/R、换代 vs 回归）留给有人值守的 meta-loop 审查。
