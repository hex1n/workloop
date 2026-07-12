# taskloop 不变量修复方案：裁停自持 + publish 授权 + 机器账目 + 判断层预注册

**类型**：改进方案（第一性原理推导，未实现）
**日期**：2026-07-13
**触发**：对照 OpenAI Prompting 指南与 Anthropic Claude Code Best Practices 逐环检验 taskloop 控制链；外部第二模型（GPT-5.6）分析交叉校准
**依据**：`AGENTS.md`、`skills/workloop/SKILL.md`、`skills/loop-core/REFERENCE.md`、`skills/loop-core/HOSTS.md`、`lib/application.mjs`、`lib/task-engine.mjs`、`lib/supervision.mjs`、`lib/untracked.mjs`、`install.mjs` 现状实读
**推导轮次**：文章启发裁剪 → 第二模型建议评审 → 公理法重推 → 规划器收敛（裁剪法与公理法产出同组工作项，公理法修正 P1 设计）
**修订**：
- 2026-07-13：P2 由"枚举已知工具"改为"通用效应动词形状匹配"，枚举降级为测试矩阵；术语对齐 schema v2 状态模型，移除 red/green 域词（见 [2026-07-11-criterion-vocabulary-and-state-model.md](2026-07-11-criterion-vocabulary-and-state-model.md)）
- 2026-07-13（二）：并入 work-loop 全局卡片退役方案——卡片已删除，其三件无机械兜底纪律按**加载时机**分派：环内纪律并入 P4（扩容），always-on dispatch 职能新增 P5（hook 消息路由），judgment 环内核侧新增 P6（人工裁决适配器命名）；配方本体落 `<repo:asdf-skills>`；SessionStart 注入仅作升级路径备案
- 2026-07-13（三）：两项用户拍板转向——judgment 环配方**入本仓**（P6 升级为 judgmentloop bundled skill，AGENTS.md"仅 workloop"章程行随附修订，撤销对应排除项，取代（二）中的外部仓放置）；P5 dispatch 消息路由明确**双宿主**（消息宿主中立，经同一运行时通道达 Claude 与 Codex）
- 2026-07-13（四）：fresh-context 子代理评审（3 blocking / 3 advisory，逐条复核后全部采纳）——P6 撤销"install.mjs 登记"误读（skill 发现为动态枚举）；P1 重构为扩展既有 `failureSuspension`（same-signature stuck 与 out_of_budget 路径已存在）；假设 #1 依 `HOSTS.md` 真机 spike 改判已验证，探针 A 收窄并改用 `--rounds 20`；P4 补 not-covered；词法类描述补全为五类；行号订正
- 2026-07-13（六）：**P2–P6 全部落地并收口 `terminal(achieved)`，六项完成**。P2 经五轮 second-model 评审收敛（命令位锚定、换行边界、gh 路径前缀、行续接入口折叠，final 0/0）；P3 两轮 fresh-context（review 字段名 `*_findings_count` blocking 修复、terminal 渲染补测）；P4 两轮（"无判据先 open 再挂起"与 CLI 结构矛盾改为 ask-first、amend criterion/policy flag 拆分）；P5 一轮 0/0（双宿主同一消息通道，宿主中立断言入测）；P6 两轮（"未裁决"语义改判 unsatisfied——done-when 是人已验收、未验收即不成立；rubric 承载于 adapter 单文件以获指纹保证；行为测试走通 criterion-file+tri-state+steady-satisfied 全链）。全套 89/89。P1/P2/P3 判据为全套件（accept-proof-gap --granted-by self 在案）；P4/P5/P6 用 criterion-file 检查器（全输入覆盖，无 gap）。
- 2026-07-13（五）：**P1 已实现并收口 `terminal(achieved)`**（探针 A/B 前置完成，结果见"探针结果"节）。落地与契约的偏差：① second-model 评审两轮——首轮 2 blocking：satisfied/indeterminate 插入不打断"连续"为真缺陷，修复引入引擎侧 `unsatisfied_streak` 字段（增于 observe/achieve、satisfied/indeterminate 归零、旧任务容忍缺省），envelope 经 `amend --files` 扩至 `lib/task-engine.mjs`；achieve 计入判定为动词中立的既定语义（与 out_of_budget/same-signature 一致），复审接受，终轮 0/0。② 挂起沿用既有"先 block 一次带挂起消息、下一 Stop 释放"约定，非原文的"直接释放"。③ 命令判据输入覆盖为 gap，已 `accept-proof-gap --granted-by self`（proof provisional）。全套 82/82；测试判据出生红经 achieve 挣得 witness
**验证**：各任务判据见下文契约；文档层验证 = 本文所引行号与机制描述均来自当日源码实读

## TL;DR

taskloop 的存在理由是"工作者的自述不是证据"。沿控制链（契约 → 写闸 → 停闸 → 终局 → 账目）逐环检验，发现三处已验证的不变量破口和一处判断层空白：

1. **裁停权在特定条件下被宿主静默夺走**：宿主 8 连块强制放行是真机已录事实（`skills/loop-core/HOSTS.md`，Claude Code 2.1.207 / Codex CLI 0.144.1 双宿主 spike）。默认预算 8 下 out_of_budget 自挂起恰在第 8 次 metered Stop 先行兜住；缺口在 amend 预算 >8 的任务单回合内输给宿主连块计数，以及判据尾非确定（时间戳等）时绕过既有 same-signature stuck（×3）路径——此时任务停在 `active`，无生命周期事件，判断快照丢失。
2. **publish 形状的不可逆外效零授权放行**：`npm publish`、`gh pr create`、`gh release create` 等不落入任何词法类（`lib/supervision.mjs` 的 `commandSafetyFailure` 现有五类：remote-exec、network、install、密钥转储、destructive——publish 形状不匹配其中任何一类）。
3. **closeout 账目由工作者自述**：`skills/workloop/SKILL.md` §5 的报告要求是对 agent 的文本指令，机器不生成、不校验——claim-based accounting 是 claim-based success 的上一层同病。
4. **判断层规则未预注册**：判据索要技法、上下文轮换出口、advisory 不扩界、中途转向的动词映射，运行时管不了语义，skill 文本也没写。
5. **dispatch 消息缺纪律路由**（work-loop 卡片退役后暴露）：untracked 通道自第一个文件即发 notice、第二个文件起 deny（`lib/untracked.mjs:92-106`），always-on 的 dispatch 强制已在，但消息把 agent 路由到裸 CLI 模板——诱导现场硬凑判据过闸门。

修复即六个工作项：**P1 Stop 无进展自挂起 → P2 对外效应动词类与 publish grant → P3 `report` verb → P4 skill 环内纪律全集 → P5 dispatch 消息路由（双宿主） → P6 judgmentloop skill 入仓**。约 660 行、5–6 个开环任务。明确不做：TaskSpec/YAML 解析、六级效果分类、deliverables 状态字段、export-template。观察名单：context_manifest。

## 下一步验证（先于一切编码）

**探针 A——P1 的失败见证**（provenance = recovered，而非 given；已依 HOSTS.md 收窄——"8 连块强制放行"与"与默认 rounds 同值"是真机 spike 已录事实，不再复证）：

1. 在临时仓库 open 一个判据必然 unsatisfied 的任务，**预算须调高越过自挂起兜底**（如 `--rounds 20`；默认 8 会在第 8 次 Stop 先触发 out_of_budget 挂起，永远跑不到宿主强制放行），判据尾须含非确定成分（避开 same-signature ×3 路径）。
2. 让宿主跑到 8 连块强制放行，检查 `.taskloop/task.json`：预期 lifecycle 仍为 `active`、无挂起事件——这是 P1 的失败见证。
3. 回答 HOSTS.md 未覆盖的唯一开放子问题：宿主"连续"计数是否被轮间写入重置（决定 P1 阈值 7 的口径：按连续 Stop 计还是按回合内累计）。

约 15 分钟。若写入会重置宿主计数，P1 紧迫性下调，但无进展自挂起作为独立的 stuck 检测仍然成立。

### 探针结果（2026-07-13 实测，双宿主）

- **A1**（rounds 20、非确定判据尾、纯空转）：9 次计量 Stop（9 个互异 signature，成功绕开 same-signature 路径）后宿主强制放行，任务遗留 `active`、无生命周期事件——**P1 失败见证已取得**（recovered）。阈值 7 < 实测 9，次序安全。
- **A2**（每次 block 之间插入一次 envelope 内写入）：宿主未再强制放行，循环跑满 20 轮由 out_of_budget 自挂起（判断快照自动生成，19 行写入佐证）。**假设 1b 已答：轮间活动重置宿主连块计数**——宿主只惩罚纯空转，与 P1"revision 未推进才计数"的口径精确对齐：干活的 agent 归预算管，空转的归 P1 管。
- **附带发现**：从宿主会话内经 CLI 开任务会被本会话 PreToolUse 注入宿主 session 身份，探针会话即为 foreign、其 Stop 释放不计量——探针（及任何接手会话）须先 `join`。这是 session-ownership 的正确行为，非缺陷。
- **B**（Claude 与 Codex 各一轮，多文件自然语言指令、无卡片）：两宿主 agent 均在第二文件 deny 后自行开任务、用真实可执行判据（ESM 导入断言）、完成 fresh-context 评审、`terminal(achieved)` 收口（task.json 复核属实，非自述）。**基线强于预期**：P5 定位确认为增量改进（撞墙前的引导与反硬凑提示），非救火；SessionStart 升级路径暂无触发依据。

**探针 B——无卡片 dispatch 基线**（P5 的前置测量）：新会话给一个多文件实现指令，观察三点——第一文件 notice 是否被 agent 消费、第二文件 deny 后开出的任务像不像样、判据是否硬凑。用 loop-engineering 校准口径（开场带硬判据占比）记无卡片基线，P5 落地后同口径复测；该口径同时是 SessionStart 升级路径的判停器。约 20 分钟。

## 行动计划

| 优先级 | 变更 | 工作量 | 风险 | 价值 |
|---|---|---:|---|---|
| P1 | failureSuspension 无进展扩展 | ~150 行 | 中（hook 协议有意变更） | 高：裁停权是存在理由 |
| P2 | 对外效应动词类 + publish grant | ~120 行 | 低中（permissions 语义） | 高：不可逆外效零授权 |
| P3 | `report [--json\|--markdown]` | ~200 行 | 低（只读） | 中高：消灭自述账目 |
| P4 | skill 环内纪律全集（六条） | ~50 行 | 低 | 中高：判断层预注册 |
| P5 | dispatch 消息路由（双宿主） | ~40 行 | 低（消息文本） | 中高：反硬凑判据 |
| P6 | judgmentloop skill 入仓 | ~100 行 | 低中（章程修订随附） | 中高：judgment 环一等化 |
| **合计** | | **~660 行** | | 5–6 个开环任务 |

排序即公理承重顺序（裁停权 > 不可逆效应 > 账目诚实 > 规则可读）。无真依赖，P2/P3 可并行，P5 可随行；P6 的 AGENTS.md 章程行修订与 skill 落地同任务完成（用户已拍板）。

## 任务契约

### P1 — 扩展 failureSuspension：无进展自挂起（评审后重构）

既有机制（评审指出，复核成立）：`failureSuspension`（`lib/application.mjs:352-358`）已挂在 `hookStop → closeAttempt` 上，有两条自挂起路径——`out_of_budget`（轮次耗尽）与 `stuck`（same failure signature 连续 `STUCK_REPEATS`=3 次，`lib/prims.mjs:21`）。默认预算 8 下，out_of_budget 恰在第 8 次 metered Stop 释放并挂起，先于宿主强制放行。

因此 P1 不新建平行机制，而是**在同一函数里加第三个析取项**，只堵剩余缺口：连续 metered Stop 之间 artifact revision 未推进且观察未变化，但 signature 因非确定尾（时间戳等）而互不相同，导致 same-signature 路径失焦；以及 amend 预算 >8 后单回合内输给宿主连块计数。阈值默认 7（低于 HOSTS.md 已录的宿主常数 8），触发时同走既有挂起出口，`judgment.failure` 增加第三种文案（现有两种写死于 `lib/application.mjs:386`）。

反演检验：担心误挂起（合法的长研究轮无写入）。连续多次尝试结束回合、期间 revision 未推进且观察不变，本身就是 spinning 的定义；误挂起代价是一次 `resume --reason`，误放行代价是静默死亡——不对称支持挂起。

- **判据**（`deferred-witness`，先写失败测试）：`node --test` 新用例——模拟连续 7 个 revision 未推进、signature 互异的 unsatisfied Stop，断言第 7 次 exit 0 且转 `suspended(stuck)`（前 6 次仍 block）；signature 相同路径仍在第 3 次触发；revision 推进时计数重置；预算 >8 的任务同样在第 7 次自挂起。
- **envelope**：`lib/application.mjs`（failureSuspension 扩展 + 文案，~40 行）、`lib/prims.mjs`（常数，~2 行）、`tests/**`（~100 行）、`AGENTS.md`（接口变更记录 1 行）。
- **risk/review**：`public-contract` → critical → second-model。
- **not-covered**：实测宿主在 9 次计量 Stop 后放行、轮间写入重置其计数（探针 A1/A2），阈值 7 的次序已证；其他宿主/版本的常数漂移仍在判据之外。

### P2 — 对外效应动词类与 publish 授权

原理：不可逆世界效应必须有 grant；词法守卫只能兑现它认得的形状。初版枚举已知工具（npm/gh/cargo/…），但枚举永远追不上生态——机制应当匹配**形状**而非工具名：命令的子命令自我宣告了对外效应（publish/deploy/release/push/upload），守卫裁决的是这个宣告，不是实际效果。这与拒绝六级效果分类是同一条原理（对守卫自身应用 A1：只声明能兑现的），只是把"能兑现"的边界画准：动词形状可兑现，GET/POST 语义不可兑现。

- **改动**：`commandSafetyFailure` 新增通用效应动词类：`<工具> <效应动词>` 形状（动词集：`publish|deploy|release|push|upload`），无 `publish` grant 即拒绝。三处收边：`git push` 继续走既有 git op 授权（git grant 本就按操作逐个授权），不落入本类；shell 内建与纯文本工具（echo/printf/cat/grep 等）排除；多词已知形态（`gh (pr|release|issue) create`）作小补充清单。grant 词汇表（`lib/task-engine.mjs` 封闭枚举）加 `publish`，归 critical 档（对外不可逆）；`open`/`amend` 加 `--publish-allowed`。
- **反演检验**：通用匹配的代价是词形碰撞误报（如 `python deploy.py`——虽然"跑一个叫 deploy 的脚本"要求授权本就说得通）。误报被 deny 的代价是一次说明或授权，漏报的代价是不可逆外效静默放行——不对称支持宽拒绝。若实践中误报高频，收紧动词集是单向安全的调整。
- **判据**（`deferred-witness`）：生态矩阵作为测试用例而非实现——`npm|yarn|pnpm publish`、`cargo publish`、`twine upload`、`docker push`、`helm push`、`mvn deploy`、`gem push`、`gh pr create` 无 grant 时被 PreToolUse deny、有 grant 放行；`git push` 仍走 git op 授权不受扰；`echo deploy`、`grep publish` 等排除样例不被拒。
- **envelope**：`lib/supervision.mjs`、`lib/task-engine.mjs`、`lib/application.mjs`、`tests/**`。
- **risk/review**：`permissions` → critical → second-model。
- **not-covered**：脚本/Makefile 包裹与改名脚本仍不可见——与现有类同等强度（"raises the cost, not a sandbox"）；词形碰撞误报按反演检验的不对称原则接受。

### P3 — `taskloop report` closeout artifact

原理："没有 claim-based 成功"贯彻到账目层：closeout 从 task.json 机器生成，工作者只能补充、不能代笔。

- **改动**：新 verb `report [--json|--markdown]`，纯读 `task.json` 输出：lifecycle/outcome、goal、判据与最后观察（含 generation）、touched vs 声明 envelope 的偏差、reviews（级别、blocking/advisory）、not-covered、已接受 proof gap、风险与豁免、预算消耗。对 suspended 任务同样可用（即交接文档）。遥测不设闸，按 ledger 先例 degrade open。
- **判据**（`deferred-witness`）：fixture 任务断言 `--json` 全字段、`--markdown` 对应小节；suspended fixture 断言含判断快照。
- **envelope**：`lib/application.mjs`、`tests/**`。
- **risk/review**：新 CLI 面 → substantial → fresh-context。
- **not-covered**：报告如实转写 task.json，不验证其内容真实性。

### P4 — skill 文本固化环内纪律全集（卡片退役后扩容为六条）

运行时管不了语义的地方，规则预注册为 skill 文本（预注册公理在判断层的对应物）。关键前提：这些纪律都发生在**环内**，彼时 skill 已加载，pull-based 天然够用——卡片的 always-on 优势只在 dispatch 层，那归 P5。全部保持 portable：不出现宿主工具名、不引外部 skill。

1. §1 判据索要：criterion 缺失时先向用户逐项问出 done-when / envelope / not-covered，访谈产物即 open 参数，不猜判据。
2. §1 溯源映射点名：given → `default`、recovered → `deferred-witness`、absent → `steady-satisfied`（三个 policy 已在，差显式映射一句）。
3. §3 上下文轮换：同一原因连续 unsatisfied 约 3 轮 → `suspend stuck` 带死路清单，新会话 `resume` 续跑，不在污染的上下文里磨。
4. 评审段落：只有 blocking findings 喂回循环；不为 advisory findings 扩 envelope。
5. steer 决策表：补充说明 → 普通 revision；改 goal → `amend --goal`；改判据/policy → `amend --criterion`（新 generation，旧证据失效）；扩 envelope → `amend --files`（风险重算）；完全换目标 → `abandon` 后新开。queue 不进内核（驱动器侧）。
6. 挂起指南：`needs_input` 挂起须附人可直接照做的精确指令（代行动词的机器侧义务）。

- **判据**（`default`，出生观察为 unsatisfied）：grep 断言六个新小节/关键句存在 + `npm test`（skill-closure 套件）通过。
- **envelope**：`skills/workloop/SKILL.md`（steer 表若归共享语义则含 `skills/loop-core/REFERENCE.md`）。
- **risk/review**：substantial → fresh-context（satisfied 只证明"存在且不破坏"，文本质量由评审补位）。
- **not-covered**：steer 分类的边界判断（"补充说明" vs "改 goal"的模糊 case）依赖现场判断，文本无法穷举；由评审与实际使用沉淀。

### P5 — dispatch 消息路由（承接卡片的 always-on 职能，双宿主等效）

原理：卡片退役后，唯一 always-on 通道是 hook 消息，且 dispatch 强制本就在运行时——untracked 通道自第一个文件即发 notice（`lib/untracked.mjs:101-106`）、第二个文件起 deny（`lib/untracked.mjs:92-100`）。缺口只在消息内容：裸 CLI 模板诱导 agent 现场发明一个能过闸门的检查。同一运行时消息通道服务两宿主（taskloop hook 已装于 Claude settings 与 Codex hooks，均已验证），因此消息改进天然双达——前提是措辞保持宿主中立。

- **改动**：notice/deny 消息在 open 模板前加两句纪律——判据先索要、不为过闸门发明检查、无判据则 `suspend needs-input`；并按名称指称 workloop skill 而非仅裸 CLI。**宿主中立约束**：不使用任何宿主专有的 skill 调用语法（两宿主 skills 根可 alias 同目录，installer 保障），宿主差异如需记录归 `skills/loop-core/HOSTS.md`。消息文本属 hook 接口，按 AGENTS.md 记录变更。
- **判据**（`deferred-witness`）：测试断言 notice 与 deny 消息含路由句与反硬凑句、不含宿主专有调用语法；Claude 与 Codex 两种 payload 形状各断言一次；hook JSON 协议形状不变。
- **envelope**：`lib/untracked.mjs`、`tests/**`、`AGENTS.md`（接口变更记录 1 行）、`skills/loop-core/HOSTS.md`（如需）。
- **risk/review**：消息文本变更 → substantial → fresh-context。
- **not-covered**：agent 是否消费消息属行为层，判据只证文本存在；实效由探针 B 口径复测（Claude 与 Codex 各测一轮）。

### P6 — judgmentloop skill 入仓（judgment 环一等化）

用户拍板修订章程：judgment 环配方作为第二个 bundled skill 入本仓，AGENTS.md"仅 workloop 内核"的章程行随本项一并修订。机制原语全在内核——criterion-file 指纹化 = rubric 预注册（generation 绑定防篡改）、三值适配器 = 人工裁决证据入账带 provenance、review 记录 = 独立评审、explicit 收口 = 人验收终态。skill 只做组合与纪律，不加运行时行为。

- **改动**：新增 `skills/judgmentloop/SKILL.md`（经 loop-core 契约组合，与 workloop 平行）：预注册 rubric 为 criterion-file 后再动笔；人作三值传感器的适配器用法（`skills/loop-core/ADAPTERS.md` 补通用"人工裁决适配器"模式两三行）；`steady-satisfied`/explicit 政策收口，终态动词是人的验收；评审至少 fresh-context；写不出 rubric 的探索性工作不开环。随附：`AGENTS.md` 章程行修订。installer **无需登记**（评审订正）：skill 发现是对 `skills/` 的动态枚举（`installTaskloopAssetsUnlocked` 内 `readdirSync`，`install.mjs:664-669`），新目录自动纳入管理与 manifest；`LEGACY_CORE_DIGESTS`（`install.mjs:648-657`）仅是历史目录一次性接管白名单，与全新 skill 无关。
- **判据**（`default`，出生观察为 unsatisfied）：grep 断言新 skill 关键小节存在 + `npm test`（skill-closure 与 installer 套件）通过。
- **envelope**：`skills/judgmentloop/**`、`skills/loop-core/ADAPTERS.md`、`AGENTS.md`、`tests/**`。
- **risk/review**：章程与安装面变更 → substantial → fresh-context。
- **not-covered**：rubric 的品味质量本身不可判据化（A1 边界）；satisfied 只证明文本存在与安装闭合，不证明配方好用——后者由真实使用与验收沉淀。

## 最佳性检查

- **判优准则**（预注册）：① 直接修复被验证的不变量破口 ② 不越内核边界（scheduler 外置、skill 可移植、hook 协议变更须文档化）③ 运行时只在可机器裁决信号上行动 ④ 新增表面最小 ⑤ 每片独立可验证。
- **胜者**：定点修复四件套。唯一在 ①③ 全胜的机制。
- **最接近替代方案**：宿主/驱动器侧缓解（调宿主配置、靠外部驱动器兜底）。败因：宿主单方面结束回合时，只有裁决者自己能产出生命周期事件——诚实退出无法外包。
- **失败条件**：若宿主在 Stop payload 中暴露"即将强制放行"信号（如带计数的 `stop_hook_active`），P1 应改为消费宿主信号而非自计数。
- **边际收益停点**：P1–P6 之后的内核强化（context_manifest、六级效果分类、TaskSpec）在真实案例积累前收益低于成本，停在这里。dispatch 层不默认做 SessionStart 每会话注入（每会话付 token 成本）；仅当探针 B 口径（开场带硬判据占比、硬凑判据率）回退时，由 installer 加 5 行注入作为升级路径。

## 根问题与公理

**根问题**（结果化表述）：在真实宿主下，taskloop 承诺的"无静默退出、无未授权外效、无自述账目"存在已验证破口。受害者是无人值守运行的用户和接手的下一个 agent。解决 = 三条不变量重新被机器兑现，判断层规则预注册为 skill 文本，全部有判据证明。"吸收文章建议"是解形状的表述；根是"修复公理实现"。

五条公理（taskloop 存在理由的展开）：

- **A1 证据公理**：成功只能来自新鲜执行的预注册判据；prose 不能收口。
- **A2 预注册公理**：判据先于工作存在并指纹化；意图变更必须重新注册（新 generation）。
- **A3 有界效应公理**：写与对世界的效应必须先验有界（envelope/grants）；读永远自由。
- **A4 诚实终局公理**：每次退出要么是诚实的终态/挂起，要么在账上可见地开着——不存在静默退出。
- **A5 裁决分离公理**：裁停者独立于驱动者与工作者。

破口与公理的映射：P1 修 A4+A5；P2 修 A3；P3 把 A1 贯彻到账目层；P4 是 A2 在判断层的对应物；P5 把 A1 用到闸门自身的引导语上（不诱导发明检查）；P6 将 judgment 环配方入仓为第二个 bundled skill（用户拍板修订章程）。P4/P5/P6 合起来是卡片退役的**加载时机分派**：always-on 归 hook 消息，环内纪律与组合配方归 bundled skill。

## 约束拆分与假设审计

**真实约束**（源码/文档实读）：hook 协议 byte-exact 除非文档化变更（`AGENTS.md`）；lifecycle 迁移只在 `lib/task-engine.mjs`；叶模块只 import `lib/prims.mjs`；scheduler 仓库外；skill 可移植无宿主名；schema v2 封闭和类型；零依赖 Node。

**惯例**（可变）：rounds 默认 8、词法类清单、report 输出格式。

| # | 假设 | 类型 | 若错 | 验证 |
|---|---|---|---|---|
| 1 | 宿主 8 连块强制放行、且与默认 rounds 预算同值 | 已验证（`skills/loop-core/HOSTS.md`：真机双宿主 spike，Claude Code 2.1.207 / Codex CLI 0.144.1） | — | 已录入仓库文档，不再复证 |
| 1b | 宿主"连续"计数是否被轮间写入重置 | 已验证（探针 A2：会重置——20 轮跑满未见强制放行，out_of_budget 先行自挂起） | — | 探针结果小节 |
| 2 | publish 命令当前零授权放行 | 已验证（`commandSafetyFailure` 通读：`npm publish` 不匹配 `(i\|install\|add)`，`gh` 不在任何正则） | P2 收缩为空 | 复现时模拟 payload 再确认 |
| 3 | report 所需数据全在 task.json | 已验证（task 字段封闭校验枚举 grants/reviews/attempts/episodes） | P3 需扩状态则重估 | 实现前 fixture 核对 |

交叉事实（评审后修正）：`open` 默认轮次预算 8 与宿主常数同值是**有意对齐**（HOSTS.md 明文记录），默认预算下 out_of_budget 自挂起恰在第 8 次 metered Stop 先行兜住。P1 的真实缺口只剩三处：amend 预算 >8 的任务单回合内输给宿主连块计数；判据尾非确定时 same-signature stuck（×3）失焦；轮次跨回合累计与宿主按回合连块计数不同步。

## 明确不做与观察名单

每条排除对应一次公理应用：

- **TaskSpec/YAML 运行时解析**：契约语义不可机器验证，加解析面不强化任何公理；编译是判断步骤，编译层就是运行 workloop skill 的 LLM（A1 的边界）。诊断（入口偏协议设计者）真实，出口是 P4.1 的索要技法。
- **六级效果分类**（network_read/remote_write/publish/communicate/git_local/git_remote）：守卫兑现不了的类是虚假声明（A1 用于守卫自身）；git 已按操作逐个授权，"commit 与 push 同级"系对现状的误读。可兑现的核即 P2。
- **deliverables 状态字段**：不可判据化的都是 prose，prose 不参与收口（A1）；excluded 是 envelope 本职。残余价值并入 P3 报告展示。
- **export-template / queue**：驱动器侧（A5；`AGENTS.md`："schedulers that trigger another round remain outside this repository"）。ledger 本是树外 JSONL，scheduler 自读自取。
- **恢复 vault 共享卡片（压缩版）**：双源腐烂当日实证——卡片残留了 `done`/`keep-green` 两个失效机制名整整一个版本；source of truth 应跟机制走，skill/hook 文本随仓库分发且被 skill-closure 套件守卫。反超条件：常在未装 taskloop hook 的机器上工作。
- **默认 SessionStart 每会话注入**：为未证实的需求付每会话 token 成本；仅作升级路径备案（见最佳性检查的边际停点，判停器为探针 B 口径）。
- **观察名单：context_manifest**（决策上下文漂移 ≠ 判据输入漂移）：观察是深的，但 `hold_closure` 会让运行时在不可裁决信号上设闸（hash 变了机器可判，"方案是否仍成立"不可判）。现有部分覆盖：每次写入与实质 amend 使 review 失效；权威文档可声明为判据输入。攒真实案例后再议，起步形态是 report/review 的输入约定，不是 closure hold。

## 来源

- OpenAI Prompting 指南：learn.chatgpt.com/docs/prompting（Goal/Context/Output/Boundaries、Steer/Queue、最终检查）
- Anthropic Claude Code Best Practices：code.claude.com/docs/en/best-practices（验证阶梯、Stop hook 8 连块覆盖、fresh-context 评审、advisory 过度工程告警、上下文轮换）
- GPT-5.6 外部分析（用户提供）：八条建议——采纳其 report/steer 内核，publish 缺口由其六级分类的可兑现残核导出，其余按公理排除
- work-loop 全局卡片（2026-07-13 退役删除）：其无机械兜底的三件纪律按加载时机分派至 P4/P5/P6；与 vault 操作契约重叠的诚实性/git 硬约束由契约继续承载
