# taskloop Hook 闸门（Stop + PreToolUse）按 Session 隔离改进方案

**日期**：2026-07-12
**状态**：实现、真实宿主取证与本地验证完成
**范围**：hook 分发（Stop/PreToolUse）、episode 绑定、`join` 动词、task.json 级归属

## 实施状态（2026-07-12）

- 已实现：session-bound Stop/PreToolUse、锁内 owner 复核、控制面永久 deny、
  foreign 四级写入规则与命令白名单、episode cursor、`join`、
  `lifecycle_log`、`status.session_binding`、安装矩阵和 portable 文档。
- 验证：`npm test` 75/75；固定的 runtime-contract 3 兼容夹具覆盖旧 ledger
  白名单、task 顶层加法字段和旧 cursor 对新三元组的读取；最终 Standards 与
  Spec 双轴只读复核均无可操作 finding。
- 第 0 步 Codex CLI 0.144.1 实证：同一次 fresh ephemeral 会话的 PreToolUse 与
  Stop payload 均有 `session_id`，exec env 均有 `CODEX_THREAD_ID`，但两值不
  相等；payload 无 `thread_id`/`conversation_id`。因此实现不消费
  `CODEX_THREAD_ID`。后续依据 Codex 官方 Hooks 契约补齐：允许的 taskloop CLI
  调用由 PreToolUse 通过 `updatedInput` 临时注入 payload 域 `session_id` 为
  `TASKLOOP_SESSION_ID`；缺失/非法 identity 才按 unbound gate-all 退化，显式
  冲突 override 会被拒绝。Codex 子代理 hook 使用父 session id，因而继承同一
  ownership domain。
- 第 0 步 Claude Code 2.1.207 实证：父会话与其 Task 子代理均导出
  `CLAUDE_CODE_SESSION_ID`，但两值不同。按本修订冻结决策，子代理属于 foreign，
  不继承父 episode 的 envelope 写权；需要写入时显式 join 或使用独立 worktree。

## TL;DR

同一 worktree 中，一个 session 开的 active task 会阻断其他无关 session 的每次
Stop：旁观 session 被迫现场跑判据、烧任务 rounds 预算、token 被记到别人账上，
envelope 外写入也被一律 deny。根因不是"Stop hook 没过滤"，而是**闸门的作用域
键取错了**：task 是 worktree 级资源，但"这一回合能不能收口"是 session 级问题。

最佳路径：把"驱动权"绑定到 session，复用任务里已有的
`episodes[].host_session_id` 做裁决键——owner = 最新 episode 的
`host_session_id`，且 owner 核验必须发生在任务锁临界区内。hook 端按 payload 的
session 标识裁决：非 owner 的 Stop 静默放行；非 owner 的写入面收敛为**可枚举
的放行白名单**（控制面对所有人永久 deny → envelope 内 deny → 不可证明的写形
fail-closed deny → 经 realpath 与大小写归一**可证全外**才走 untracked 路径；网
络命令仅 stdout-only 放行、git 仅只读子命令放行、install/remote-exec 类一律
deny）。接管必须显式 `taskloop join --reason`（仅限 active，要求真实宿主身
份）。transcript 计量 cursor 改绑 episode，杜绝回扫串账；lifecycle 归属由新增
的 append-only `lifecycle_log` 承担（仅审计，不参与裁决）。不改 task 的
worktree 级存储，不改 task schema v2 的既有字段（新增顶层字段旧校验器不封
闭），**join 不写 v2 ledger 行、不递增事件序列**（ledger 形状与序列语义零变
更），不动 hook 的全局 matcher。

## 问题现象

多个 session（Codex 实测，Claude Code 同构）共用一个仓库/工作树时：

1. Session A 开 task 并达到 criterion satisfied，但 review 未接受
   （`held(change_review_unaccepted)`）；
2. Session B 只做只读问答，结束回复时仍被 A 的任务阻断；
3. 阻断提示作为新 prompt 注入，助手回应后再次触发 Stop hook，形成循环。
   Claude Code 连续 8 次 block 会强制放行（HOSTS.md 有记载），Codex 没有这个
   止损，所以表现为无限循环。

## 根因

`dispatchHook`（lib/application.mjs）只用 `payload.cwd` 定位 task，找到就把**任意
session** 的 Stop 交给 `hookStop` → `closeAttempt(stop: true)` 全量裁决。task 状态
里没有被 hook 消费的 session 所有权，hook 执行时也不按当前 session 过滤。

由此产生的串扰不止阻断提示：

1. 旁观 session 每次结束回复都现场跑一次判据（可能是整套测试，Stop hook 超时
   预算 300 秒），纯浪费；
2. 判据红时，旁观 session 的每次 Stop 都 `observe` 记 attempt、烧任务 rounds
   预算，攒够 `STUCK_REPEATS` 会把 A 的任务自动挂成 `stuck`
   （`failureSuspension`，lib/application.mjs）；
3. `hookStop`/`hookPretool` 把旁观 session 的 transcript token 记到任务 token 账上
   （`tallyTranscript`）；
4. 任务活跃时，旁观 session 在整个 worktree 内任何 envelope 外写入都被 deny
   （`write outside envelope`）——同一根因的另一表现；
5. 一个 session 可能顺着注入的 block prompt 意外评审/关闭另一个 session 的任
   务；task 状态与账本都无法归属某次 review/closure 属于哪个 session。

模型层其实早已备好槽位：Episode 就是"一个 session 服务这个任务的一段时间"，
`host_session_id` 字段存在——但默认创建路径的填充值是
`process.env.TASKLOOP_SESSION_ID ?? "cli"`（`cmdOpen`/`cmdResume`），该变量通常
无人设置，所以**默认创建且未显式覆盖的存量 episodes 通常为 `"cli"`**（旧版允
许任意显式值，schema 也允许空 episodes——见第 1 步的 unbound 判定表）；且
hook 路径从不读它。**缺的不是新模型，是把已有字段接上真值、再让闸门消费
它。**

## 约束拆分

**真约束（本会话已验证）**

- Claude Code hook payload 携带 `session_id`——`lib/untracked.mjs` 已在消费它，
  且是 dual-host spike 挣来的代码；
- Claude Code 向 Bash 工具环境导出 `CLAUDE_CODE_SESSION_ID`（2026-07-12 在
  Claude Code 会话内 `printenv` 直接证实）——agent 经 Bash 跑的 CLI 动词
  （`open`/`resume`/`join`）可以直接从 env 拿到宿主 session id，不需要旁路通道；
- hook 与 CLI 动词是两次独立进程调用，唯一共享通道是文件系统（state dir）；
- 宿主的 hook matcher 无法按 session 匹配——配置层无解；
- ledger v2 的 `EVENT_KINDS` 与 `PAYLOAD_FIELDS` 是封闭白名单
  （lib/outcome-ledger.mjs），新 kind 或新 payload 字段会被旧 runtime 的
  `audit` 判为 corruption——**v2 ledger 形状不可增量扩展**；`audit` 同时校验
  `task_event_sequence` 连续性——**不入账的动词绝不能消耗序列号**；
- 现有识别器对写盘命令的覆盖是**不完备的**：`writeFileTargets` 只从工具文件字
  段、patch 文件块、shell 重定向提取目标；`sed -i`/`rm`/`mv`/`tee`/SQL 由正则
  判形但无法提取目标；`npm/pip install` 不判写形却确定写盘；`curl -o`/裸
  `wget`/`Invoke-WebRequest -OutFile` 的文件输出参数完全不被识别；`gitOps` 只
  匹配九个写动词，`git clone/init/config/stash/tag/branch/worktree add` 等写
  worktree 或控制面的子命令漏网（lib/supervision.mjs）——**foreign 的放行判定
  不能建立在这些识别器的否定结论上**（"没识别出写"≠"不写"），只能建立在
  可枚举的白名单上；
- `repoRelative`/`insideEnvelope` 是**词法**判断，不解析 symlink 与平台大小写
  （lib/prims.mjs、lib/supervision.mjs）——"目标在 envelope 外"的词法结论不等
  于物理写面在外；
- `runtime_contract: 3` 被架构测试与安装清单双重断言
  （tests/taskloop-architecture.test.mjs、install.mjs 的 journal/manifest）。

**惯例（本方案有意修订其中一条并机器化另一条）**：task 按 worktree 存储；
suspended/terminal 的 Stop 已静默放行；`.taskloop/` 状态与账本只经 CLI 动词变
更、不手写（本方案将其机器化为对所有 session 生效的控制面 deny）。原
"one writer per worktree"（loop-core REFERENCE.md）在本方案后收窄为
**"one owner per task/envelope"**：envelope 是 owner 的独占写面，非 owner 在
envelope 外的**可证明**写入按无任务规则对待——REFERENCE.md 措辞随第 4 步同
步更新。

**第 0 步已验证事实（不改变本修订冻结的 foreign deny 决策）**

- Codex CLI 0.144.1 hook payload 带 `session_id`，没有 `thread_id` 或
  `conversation_id`；
- Codex exec shell 导出 `CODEX_THREAD_ID`，但与同一会话 payload 的
  `session_id` 不相等，因此不是可用的同域绑定值；
- Claude Code 2.1.207 Task 子代理导出自己的 `CLAUDE_CODE_SESSION_ID`，与父
  session 不同。

## 方案对比

| 机制 | 判决 |
|---|---|
| A. episode 驱动权 + hook 按 session 裁决 | **胜**：复用既有模型，改动集中在 hook 分发与 id 填充 |
| B. task 状态按 worktree×session 拆分 | 否：破坏 envelope 单 owner 语义（两 session 可开重叠 envelope 互不知情）、破坏"A 挂起 B 续跑"，PreToolUse 不知用哪个 task 裁决 |
| C. 配置层（matcher/独立 hook） | 不可行：宿主无 session 级 matcher |
| D. 对 foreign session 的 block 去重/退避 | 否：治标——预算烧蚀、token 串账、envelope 误拒全都还在 |

**Bestness Check**

- **判优标准**：旁观 session 零阻断且不获得比今天更宽的写面（控制面、
  envelope 物理写面、写盘命令类不放宽）；不破坏跨 session suspend/resume 与
  envelope 单 owner 模型；兼容存量 task.json、无 session id 的宿主与 v2 ledger
  回滚；lifecycle 变更跨 resume 仍可归属；改动小、可分阶段验证。
- **胜者**：session 绑定的 episode 驱动权（owner = 最新 episode 的
  `host_session_id`，锁内核验），foreign 放行面为可枚举白名单。
- **最近替代**：方案 B（per-session task 状态），因破坏既有语义被否。
- **何时会被击败**：宿主原生支持 session 作用域的 hook 注册时，配置层解法更
  薄。目前 Claude Code/Codex 都没有该能力。
- **边际收益止损点**：foreign session 显式执行 CLI 动词不设硬门——"意外参
  与"的主要向量是被注入的阻断提示，泄漏消除后，显式动词以 actor 归属记录
  （见第 3 步 `lifecycle_log`）而非拒绝来治理。

## 实施方案（分阶段，每步独立可验）

### 第 0 步：取证（先于一切代码）

- Codex session 里给 Stop/PreToolUse hook 临时套一层 `tee`，抓真实 payload，确
  认 session 标识字段名；
- 同一 Codex session 里检查 exec shell 的 session/thread env：记录"payload 有
  id / env 有 id / 两者同域相等"三个独立事实；
- Claude Code 里派一个子代理跑 `printenv CLAUDE_CODE_SESSION_ID`，确认子代理
  id 语义（父 id 还是独立 id）。

以上三项已完成；结果见本文「实施状态」与「已验证事实」。

**范围冻结**：取证结果只决定第 2 步 `payloadSessionId` 的字段兜底表与
`hostSessionId` 的 env 优先级表。foreign envelope 内写 **deny 在本修订中已冻
结**。取证已显示子代理身份独立；若未来委托工作流需要放宽为授权或放行，那是
一次实质性方案变更，必须形成新修订并重新过评审，不允许借第 0 步证据静默切换
行为。

### 第 1 步：填真值——session id 进 episode

- 新增 `hostSessionId()` 助手，优先级：`TASKLOOP_SESSION_ID`（显式覆盖）→
  `CLAUDE_CODE_SESSION_ID`（已证实）→ `"cli"`。Codex 的
  `CODEX_THREAD_ID` 已证实与 payload 异域，明确不消费。
- **同域契约**：绑定值必须与 hook payload 的 session id 同域——
  `TASKLOOP_SESSION_ID` 的文档语义收紧为"宿主 payload 域的 session id 覆盖"。
  设了异域自定义值的后果是 owner 判定在 hook 域永不匹配、该任务对所有带 id
  session 放行（表现为 Stop 不再驱动本 session）；发现与出路见第 3 步
  `session_binding` 投影（CLI 身份匹配与 hook 域证据分列）。行为入测试固化。
- `cmdOpen` 与 `cmdResume` 改用它填 `episodes[].host_session_id`。
- **unbound 判定表**（存量兼容的唯一真源，owner 判定与测试都引用它）：
  episodes 为空数组、末元素缺失/非字符串/空白 `host_session_id`、或值为
  `"cli"` → **unbound**（维持现行为，gate-all）；其他任何真实值 → **bound**。
  历史上显式设置过 `TASKLOOP_SESSION_ID` 的存量任务因此保留其 opt-in 绑定语
  义。

### 第 2 步：闸门按驱动权裁决（核心修复）

- 新增 `payloadSessionId(payload)`：按第 0 步证据取 `session_id` 及 Codex 变体，
  作为**唯一**的 payload session 解析点；`observeUntracked` 改为注入已规范化的
  session id，不再自行读取 `payload.session_id`。
- 驱动权规则：**owner = `task.episodes.at(-1).host_session_id`**（最新 episode，
  而非历史并集——A 挂起、B resume 后，A 的 Stop 不该再裁决）；unbound 按第
  1 步判定表回退 gate-all。
- **原子性**：owner 核验必须发生在裁决所持的同一 `withTaskLock` 临界区内，对
  锁内重读的 task 重新判定；hook 入口处的判断只是免跑判据的快速路径，不作为
  最终依据。否则 B 在间隙 `join` 后，旧 owner A 仍可能跑判据、烧预算或关掉 B
  已接管的任务（join-vs-Stop 竞态）。
- `hookStop`：payload session 已知、任务 bound 且非 owner → 返回 0 静默放行；
  不跑判据、不记 attempt、不烧 rounds、不触碰 transcript cursor。unbound 或
  payload 无 session id → 维持现行为（fail-closed，单 session 宿主零回归）。
- **控制面永久 deny（第 0 级，先于 owner/foreign 分流，对所有 session 生
  效）**：任何可提取写目标经归一后落在控制面根集合内 → 无条件 deny。控制面
  根集合为**规范化绝对路径**：本 worktree 的 `.taskloop/`、实际 git
  dir 与 common dir（`git rev-parse --git-dir --git-common-dir`，兼容 worktree
  中 `.git` 是文件的形态）、以及 HOME 下的 `~/.taskloop/`（ledger 家）。词法路
  径与 realpath 双重检查。运行时状态、锁、账本与仓库元数据不属于任何 session
  的自由写面（".taskloop 只经 CLI 动词变更"的机器化——CLI 动词经由
  `node taskloop.mjs <verb>` 执行，不带可提取写目标，不受影响）；owner 的
  whole-repo envelope 也不豁免。直接文件工具调用（Write/Edit 指向 task.json
  等）与 shell 重定向同样覆盖。
- `hookPretool` 对 foreign session 的写形调用按**四级规则**处理（第 0 级已在分
  流前执行），判定按写形迹象**逐源**进行，不按整条命令：
  1. **任一可提取目标在 envelope 内** → deny，消息指向 `taskloop join`；
  2. **存在任何不可提取目标或不可归一目标的写形迹象**——写动词正则命中
     （`sed -i`/`rm`/`mv`/`cp`/`tee`/SQL）、目标含 `~`、glob 元字符、命令替换
     （`$(`/反引号）或未展开变量、以及 git 子命令不在只读 allowlist 内（见下
     文命令类白名单）→ fail-closed deny 并指向 `join`，**即使同一命令还有可提
     取且在外的目标**（混合命令如 `sed -i in.txt && echo x > outside.txt` 必须
     落入本级）；
  3. **可证全外** → 走 `observeUntracked` 无任务路径。"可证"要求：写形迹象
     全部来自可提取目标源（工具文件字段、patch 文件块、shell 重定向、网络命
     令的显式输出参数），且每个目标为字面路径、经**最近存在祖先目录的
     realpath 解析 + 平台大小写折叠**归一后仍在 envelope 与控制面之外；任何
     目标不可归一 → 落回第 2 级 deny。词法上的"在外"不作数——symlink 与
     macOS/Windows 大小写别名可以把词法外路径写进物理 envelope。
  - foreign 走 untracked 路径时使用 **foreign 专用指引**（不是现有的 open 模
    板——同 worktree 已有 active task，`open` 必然失败）："并行工作请使用独
    立 worktree；确需接续本任务则 `taskloop join`"。
- foreign session 的**命令类白名单**（"没识别出写"≠"不写"，放行只能来自白
  名单，不能来自识别器的否定结论）：
  - **网络命令**：仅 **stdout-only** 形态放行（如 `curl URL` 无输出参数）；带
    可提取输出目标的形态（`curl -o/--output F`、`Invoke-WebRequest -OutFile
    F`）把 F 作为写目标进入四级规则；裸 `wget`（默认写盘）、`curl -O/
    --remote-name`（目标名来自远端）及其他不可完整解析输出的形态一律 deny；
  - **git**：只读子命令 allowlist 放行（`status`/`log`/`diff`/`show`/`blame`/
    `ls-files`/`rev-parse`/`describe`/`shortlog`/`grep`/`worktree list`/
    `config --get|--list` 等，实现时定稿并入测试）；**其余一切 git 子命令
    fail-closed deny**（`clone`/`init`/`config` 写形态/`stash`/`tag`/`branch`/
    `worktree add` 都写 worktree 或控制面，现有 `gitOps` 九动词正则不构成完备
    分类）；
  - **install/remote-exec/destructive/secret-dump**：以"零 grants 视图"一律
    deny（`npm|pnpm|yarn|bun i/install/add`、`pip install`、下载管道进 shell、
    destructive 模式、secret-dump——非写形却写盘/外泄，untracked 无法归因）；
  - 其余非写形命令放行。owner 的 grants 绝不外溢给 foreign。
- envelope 外的 foreign 写不构成任务 artifact，不推进 `artifact_revision`、不使
  review 失效；判据输入被外部改动由既有 `criterionDrift` 指纹兜住——注意该保
  护只覆盖 `declared_inputs`（coverage 缺口本就通过
  `criterion_input_coverage`/proof assurance 显式可见，不因本方案扩大或缩小）。
- **transcript 计量改绑 episode**：cursor 记录
  `{ task_id, episode_id, offset }`（保留 `task_id` 供旧 runtime 回滚读取）。
  hook 侧 tally 时，cursor 的 `episode_id` 不等于当前 open episode 的 id →
  **快进**：把 offset 置为 transcript 当前末尾、本轮计 0，之后从新位置正常累
  计。**unbound/存量任务兜底**：episodes 为空或当前 episode 缺 id 时，以按
  task 隔离的 legacy sentinel（如 `legacy:<task_id>`）作为 cursor 键，沿用 task
  级连续计量语义（含既有 `created_at` 时间戳过滤）——否则存量任务每次 hook
  都触发快进、token 永久不计（相对今天是回归）。bound 任务由此不再需要时间
  戳过滤与无时间戳行特判，A→B→A 同 transcript 的 foreign 阶段 token 在
  re-join 快进时被整体跳过。foreign 的 hook（Stop 与 PreToolUse）完全不触碰
  cursor。代价：bound 任务每个新 episode 首次 hook 之前的 token 不计——token
  估计本就是 best-effort 遥测，接受。
- Stop 产生的 lifecycle 变更所关联的会话身份，统一取自传入 `closeAttempt` 的规
  范化 payload session id，不读 hook 进程自身 env（两者可能不一致）。

### 第 3 步：显式接管——`taskloop join`（仅限 active）

- 新动词 `join --reason R`：**仅对 active 任务有效**，作为 task-engine 的封闭
  transition 实现：关闭当前 open episode，追加以本 session（`hostSessionId()`）
  为 `host_session_id` 的新 episode。suspended 任务不提供 join——挂起是 sticky
  的，接管挂起任务的正确动词是既有 `resume --reason`（第 1 步后 resume 天然绑
  定新 session，且保留预算守卫）。
- **join 的 revision 语义**：只推进普通 `task_revision`，**不推进**
  `last_substantive_task_revision` 与 `artifact_revision`；旧 episode 的
  `end_task_revision` 与新 episode 的 `start_task_revision` 绑定同一个新
  revision。接管没有改变工作产物——已接受的 review 不因 join 过期。
- **join 要求真实身份**：`hostSessionId()` 解析为 `"cli"`/空白时 join 拒绝执行，
  报错指引"设置 TASKLOOP_SESSION_ID（宿主 payload 域）或在导出 session id 的
  宿主内执行"——否则追加的是 unbound episode，表面接管、实际 gate-all 未
  变。异域 override 造成的错绑同样要求先清除/纠正 override 再 join。
- **join 不写 v2 ledger 行，也不递增 `last_issued_event_sequence`**：序列号只
  随真实入账事件消耗，否则 join 后的下一条事件在 `audit` 中形成 sequence
  gap。task.json 的 episodes 序列就是接管记录。v2 事件白名单封闭，复用
  `task_resumed` 虽形状合法但把 active→active 的驱动权移交伪装成
  suspended→active 的恢复，语义不诚实。ledger 级 `task_joined` 事件推迟到未来
  ledger-v3（届时一并考虑记 session id 摘要而非原始值）。回滚由此天然干净。
- **lifecycle 归属的权威记录：新增顶层 append-only `lifecycle_log` 数组**。每次
  lifecycle 变更与驱动权移交（`open`/`suspend`/`resume`/`join`/`achieve`/
  `not-needed`/`abandon`）追加一行
  `{ event, source: "cli"|"stop", reason?, acting_session: string|null, at, task_revision }`：
  CLI 动词取 `hostSessionId()`，Stop 驱动的变更取规范化 payload id，payload 无
  id 时记 `null`（unknown 的稳定语义）。挂起者身份由此**跨 resume 存活**
  （suspended lifecycle 对象会被 resume 整体替换，不能作为归属载体）。
  **初始化与校验**：`createTask` 初始化为含 open 行的数组；存量任务首次追加
  时 lazy 初始化（`?? []`）；字段存在时严格校验（event 枚举、`at` 与
  `task_revision` 单调不减）；**该字段只作审计投影输入，绝不参与裁决**。
  **回滚语义的诚实表述**：旧 runtime 回滚期间状态兼容但不追加此日志——再升
  级后归属遥测存在缺口；行内携带的 `task_revision` 使缺口可被诊断（revision
  跳变即断档证据），不做补录。`review` 记录另带可选 `acting_session`。旧
  `assertTaskSchema` 不封闭顶层字段与 review 行字段集，回滚安全。foreign
  session 显式执行这些动词不设硬门——显式敲命令不是"意外"，治理靠归属可
  见，不靠拒绝。
- **episode 区间语义**：episode 归属区间为 `[started_at, ended_at)`；同一时刻
  的边界事件按 episodes 数组顺序归属（后开的 episode 承接），避免 join 同秒歧
  义。
- `status` 投影增加 `session_binding`：
  `{ bound, cli_identity_matches_owner: true|false|null, last_observed_owner_hook_contact: { episode_id, at } | null, next_action }`。
  `cli_identity_matches_owner` 由 `hostSessionId()` 与 owner 比对得出，unbound
  或无 CLI 身份时为 `null`（区分"已知 foreign"与"不可判定"）；hook 接触戳
  在 owner 侧本就落盘的 hook 事件（record-write、Stop 裁决）上顺带盖章，**与
  episode_id 成对存储**——open/resume/join 换 episode 后旧戳不再匹配当前
  episode，新 owner 不会继承旧 owner 的接触证据；命名带 "observed" 明示它是
  best-effort 证据而非活性探针。CLI 身份匹配但当前 episode 的 hook 接触从不出
  现，就是 env/payload 异域错配的现场证据。原始 owner id 不进默认投影
  （task.json 本就可读，省略是输出卫生而非保密）。`next_action` 对悬置任务给
  出 `join` 提示。

### 第 4 步：测试、发布矩阵与文档

- 测试沿用现有 stdin-JSON 驱动模式（tests/taskloop.test.mjs 的 hook 用例）：
  - foreign Stop 放行且 task 文件字节不变、rounds 不增、cursor 不被触碰；
  - owner Stop 照常裁决；
  - unbound 任务（episodes 空 / 缺 host_session_id / 空白 / `"cli"` 各一例）全员
    裁决（回归保护）；
  - payload 无 session id 全员裁决（回归保护）；无 id Stop 触发的
    suspended/terminal 在 `lifecycle_log` 记 `acting_session: null`；
  - **控制面（owner 与 foreign 都要测）**：直接文件工具写 `.taskloop/task.json`
    deny（含 owner whole-repo envelope）；重定向写 `.git/config` deny；写
    `~/.taskloop/outcomes-v2.jsonl`（绝对 HOME 路径）deny；worktree 的 `.git`
    为文件的形态；正常 CLI 动词（open/amend/review）不受影响；
  - foreign 四级：envelope 内可提取目标 deny 带 join 指引；targetless 写形
    （`sed -i`）、git 非只读子命令、**混合命令**（`sed -i` + envelope 外重定
    向）、目标含 `~`/glob/命令替换/未展开变量均 fail-closed deny；纯可提取且
    经 realpath/大小写归一后全外的目标走 untracked 且收到 foreign 专用指引；
  - **symlink/大小写别名**：envelope 外 symlink 指向 envelope 内、以及仅大小写
    不同的别名路径，均被归一后判为 envelope 内 → deny；
  - **网络命令**：foreign 的 `curl URL`（stdout-only）放行；`curl -o
    outside.txt` 进四级规则按目标裁决；`curl -o inside.txt`（envelope 内）
    deny；裸 `wget` 与 `curl -O` deny；`Invoke-WebRequest -OutFile` 同覆盖；
  - **git 白名单**：foreign 的 `git status`/`git log` 放行；`git clone`/
    `git config user.name x`/`git stash` deny；
  - foreign 的 `npm install`/`pip install`/remote-exec/secret-dump 以零 grants 视
    图 deny；owner 的 grants 不外溢；
  - join-vs-Stop 并发：join 后旧 owner 的 Stop 在锁内被判 foreign 放行；
  - **A→B→A 同 transcript**：re-join 后 cursor 因 episode_id 不匹配而快进，
    foreign 阶段 token 不入账；
  - **cursor 兜底与双向回滚**：unbound/存量任务走 legacy sentinel、token 计量
    与今天等价（无永久快进回归）；新 runtime 读旧 `{task_id, offset}` cursor
    （视为不匹配 → 快进）；旧 runtime 读新三元组 cursor（`task_id` 在场，继
    续计量不炸）；
  - foreign PreToolUse 不推进 token/writes 账目；
  - suspended 任务 join 被拒、resume 正常重绑；
  - join 在 `hostSessionId()` 为 `"cli"` 时拒绝并给指引；
  - **join 不递增事件序列**：join → review/terminal 后 `audit` exit 0、无
    sequence gap；
  - **join 不使 review 过期**：join 前已接受的 review 在 join 后仍满足接受条件；
  - env/payload 异域不匹配：owner 在 hook 域永不匹配 → 带 id session 全放行；
    `status` 显示 `cli_identity_matches_owner: true` 而当前 episode 无 hook 接
    触戳（文档化行为固化）；**hook 接触戳跨 episode 重置**：join 后旧戳不匹
    配新 episode；
  - **foreign suspend → resume 后归属仍在**：`lifecycle_log` 保留挂起者
    `acting_session`；**缺 `lifecycle_log` 的存量任务**首次事件 lazy 初始化不
    炸；
  - open/resume 绑定真实 session id；
  - **回滚验证**：新 runtime 的全部 ledger 行通过旧 `validateEvent` 白名单、
    `audit` exit 0；带 `lifecycle_log`/`acting_session` 的 task.json 通过旧
    `assertTaskSchema`；**旧 runtime 间奏后的 lifecycle_log 断档**可由
    `task_revision` 跳变诊断（测试固化该诊断语义）；
  - `status` 加法兼容：既有字段形状不变，仅新增 `session_binding`。
- 发布矩阵同步：`OPTIONS` 表与 `cmdHelp` 增加 `join`；hook I/O 形状、task
  schema 既有字段、ledger schema 均不变 → `runtime_contract` 维持 3（架构测试
  `{ runtime: 3, task: 2, ledger: 2 }` 断言不动）；安装矩阵测试增加"shim 分发
  后 `join` 可用"断言。
- REFERENCE.md：episodes 段补绑定语义，"one writer per worktree"改写为
  "one owner per task/envelope"并说明 foreign 的 envelope 外自由度与控制面例
  外；HOSTS.md 各宿主小节补 session id 来源与同域要求；`skills/workloop` 提示
  词若引用 Stop 行为需同步。

## 失败模式与边界

- **Codex payload/env 异域（已实证）**：payload 有 `session_id`，但 exec env
  只有不相等的 `CODEX_THREAD_ID`。已用官方支持的 PreToolUse `updatedInput`
  在 taskloop CLI 命令上瞬时桥接，不把两个 ID 混为一谈，也不维护持久映射；
  只有 payload id 缺失/非法时退化为 unbound gate-all。
- **payload 有 id、exec env 无同域 id 的宿主**：hook 侧能判 foreign，但
  `open`/`resume`/`join` 拿不到真实身份、只能绑 `"cli"`——绑定功能在该宿主上
  整体退化为现行为（unbound gate-all），join 也不可用（按第 3 步拒绝）。列为
  宿主退化条件，出路是显式设置同域 `TASKLOOP_SESSION_ID` 或等宿主导出。
- **Claude 子代理写 envelope 被拒（已实证子代理 id 独立）**：本修订冻结 deny；
  Codex 官方契约则让子代理 hook 使用父 session id，属于同一 owner。若委托
  工作流需要放宽，处理路径是提出新修订（候选方向：会话级写授
  权，或"放行但推进 `artifact_revision`、不烧 owner 预算"）并重新过评审——
  不在本修订内预留开关。
- **task 状态损坏时的 fail-closed block**（`task state unavailable; refusing to
  adjudicate Stop`）会继续阻断所有 session——状态不可读时无从判 owner，保守
  正确，保持不变。
- **owner session 已死、任务悬着**：新 session 静默放行意味着没人被 Stop 提醒收
  口。`status` 的 `session_binding` 投影与账本仍可见（开而不收，账上可见），
  `join` 一条命令即可接管；不做自动认领——静默认领正是本 bug 的镜像。存量
  任务若绑着一个永不再现的显式 session id（含 env/payload 异域错配），同样走
  `status`/`join` 出口。
- **foreign 白名单外命令被误拒**：四级规则第 2 级与命令类白名单是保守面——
  旁观 session 的 `sed -i`、git 非只读子命令、裸 `wget`、install 类命令会被
  deny 并看到指引。这是 envelope 单 owner 的机器化，接受为设计后果而非缺陷。
- **新 episode 首段 token 漏计**（仅 bound 任务）：episode 级 cursor 快进的固有
  代价，token 估计是 best-effort 遥测，接受。
- **回滚间奏的归属断档**：旧 runtime 不追加 `lifecycle_log`，再升级后归属遥测
  有缺口——状态兼容但遥测不完整，`task_revision` 跳变可诊断，不补录。

## 完成验证

第 0 步真实宿主取证、TDD 行为矩阵、runtime-contract 3 回滚夹具、安装后 `join`
冒烟、完整 `npm test` 与 Standards/Spec 双轴复核均已完成。后续若 Codex 或
Claude Code 改变 payload/env identity 契约，应重跑第 0 步并更新 HOSTS.md，
不得沿用本次版本结论。
