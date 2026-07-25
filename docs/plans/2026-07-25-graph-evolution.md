# 图进化:节点先行、边用 digest、调度留宿主

日期:2026-07-25
状态:计划(未开工);Value Gate:BUILD(来源 = owner 显式要求)
前提约束:本计划仅基于当前源码与当日实测证据推导,未引用 `docs/` 既有决策结论
证据基线:干净环境 `npm test` 82/82;三个底座缺陷均已在源码定位
(`lib/git-authority-provider.mjs:933` 全局 sequence CAS、三 provider 共用
4 MiB 统一 append 上限、placement intent 状态枚举无放弃出口)

## 方案一句话

把 workloop 做成**图的账本**,永远不做**图的调度器**:先让节点互不干扰(地基),
再让节点有可被消费的持久状态(观察),然后用 digest 引用落第一种边(认证依赖),
调度与监督拓扑留给宿主。

## Bestness Check

- 判准:每阶段独立可验收;边只用不可争辩的锚(digest / commit oid);
  不与宿主争调度;旧 journal 可重放。
- 胜者:账本形态的图(节点 → 观察 → 依赖边 → 只读前沿投影)。
- 最接近替代:直接建 DAG 调度器。输在:调度失忆节点无意义,认证互碎缺陷会被
  并发放大;其全部前置本计划都会做完,证据出现时随时可加。
- 停止点:Phase 2 落地后,在"宿主编排实际失手"的证据出现前,不再新增图机制。

## Phase 0 — 地基:让并发节点互不干扰(约 4–7 天)

图的最低要求是节点独立。当前认证 CAS 绑全局 journal sequence,任何邻居节点的
任何活动都会作废认证——结构上是反图的,先修它。

### 0.1 测试语料清理(S)

- 删除或修复 5 个失效文件:`tests/runtime-v5.test.mjs`、`tests/roadmap-e2e.test.mjs`
  (import 已删除的 `lib/event-store.mjs`/`lib/outcome-projector.mjs`)、
  `tests/foreign-session-scope.test.mjs`(31/31 失败)、`tests/host-authority.test.mjs`
  (9/10 失败)、`tests/host-hooks.test.mjs`(9/12 失败)。
- 修 fixture 会话隔离:`tests/git-linked-worktree-authority.test.mjs:54` 只覆写
  `WORKLOOP_SESSION_ID`,未清除 `CLAUDE_CODE_SESSION_ID`,导致宿主会话内
  `npm test` 出现 3 项假失败。
- 门禁外仅保留显式标注的 benchmark/verify 脚本。

验收:宿主会话内外 `npm test` 结果一致且全绿。

### 0.2 任务级认证 CAS(M,schema 变更)

- 投影层为 task 增加 `task_revision`:凡 payload 指向该 task 的记录
  (join/receipt/suspend/resume/观察)递增之(`lib/authority-state.mjs` 各 kind 分支)。
- `prepareCurrentGitCertification` 改绑
  `{task_id, task_revision, attachment_final_digest, claim_digest, criterion_digest, commit_oid}`;
  保留既有 merge-base 与 task-paths drift 检查(本就是任务级的)。
- `task_certified` payload v2:`prepared_task_revision` 取代 `prepared_sequence`;
  replay 验证器按 payload 形态分支——旧形态维持
  `prepared_sequence === sequence - 1`(`lib/authority-state.mjs:293`),
  新形态校验 task_revision。旧 journal 原样可重放。
- `lib/filesystem-authority-provider.mjs` 同步。

验收:A(`src`)与 B(`docs`)并发,B 在 A 的 criterion 执行窗口内 `join`/`commit`,
A 认证成功;A 自身被并发触碰时仍然 `CERTIFICATION_STALE`。

### 0.3 容量储备 + 分层设计定稿(S 实现 + 设计)

- 立即实现:普通 append 上限改为 `MAX - RESERVE`(建议 64 KiB);
  `task_suspended`/`task_terminal`/abandon/recovery 记录可用满 4 MiB
  (三 provider 的统一检查各改一处)。
- 同批出 epoch rollover 设计(封印记录携带 state digest,新 epoch 文件以
  digest 为 genesis);实现放 Phase 1——观察记录才是 append 放大器。
  与 0.2 的 CAS 粒度、Phase 1 的观察形态共用同一份持久化契约设计稿,避免返工。

验收:写满 journal 后 suspend 与 abandon 仍成功。

### 0.4 placement intent 公开出口(S)

- 新增 `abandon-placement` 动词(进 `lib/provider-application.mjs` COMMANDS 与 help):
  对 pending intent 幂等追加放弃记录;状态枚举 `{pending, ready}` 加 `abandoned`;
  解除 `EXCLUSIVE_PLACEMENT_PENDING` 对后续 exclusive open 的封锁。

验收:人为卡住 intent 后,不重跑原命令即可恢复 exclusive open。

## Phase 1 — 节点状态:边未来消费的东西(约 3–4 天,含 rollover)

- 新记录 kind `task_observed`:`certify` 失败/不确定时(当前
  `lib/provider-application.mjs` cmdCertify 直接丢弃处)追加
  `{task_id, task_revision, verdict, criterion_digest, artifact_checkpoint,
  failure_identifiers(有界), summary(有界截断)}`。默认记录,`--no-record` 退出。
- 实现 epoch rollover(按 0.3 定稿设计)。
- 运行时契约版本随 schema 变更递增(`lib/prims.mjs` 契约常量与
  `bin/workloop.mjs` help 同步)。rollout 顺序:先 `node install.mjs` 升级装机
  runtime,再产生第一条新 kind 记录(旧 runtime 对未知 kind fail-closed)。

验收(图语义最小闭环):session 1 认证失败退出;session 2 仅凭 journal 读出
上一轮 verdict、failure identifiers 与 artifact checkpoint。

## Phase 2 — 第一种边:认证依赖(约 2–3 天)

- `open --depends-on <task_id>[@<certification_digest>]`(可重复):
  task intent/task 增加 `depends_on: [{task_id, pinned_digest|null}]`。
  开单校验:同 authority、非自身、无环(现存边 DFS)、上游非 abandoned;
  边一经开单不可变。
- 认证校验:每个上游 lifecycle 为 `terminal: achieved`;pin 了 digest 则逐字匹配;
  git provider 额外要求上游认证 `commit_oid` 是本任务 HEAD 的祖先
  (复用 merge-base 模式)。不满足报 `DEPENDENCY_UNMET`。
- 只读前沿:`tasks` 输出附带依赖满足状态;新增 `tasks --ready` 过滤器。
  这是投影不是调度——谁去做 ready 节点由宿主/agent 决定。

验收(端到端图场景):A、B 不相交 claim,B 依赖 A;B 先 certify 报
`DEPENDENCY_UNMET`;A 认证后 `tasks --ready` 出现 B;跨 session 后 B 认证成功
且祖先检查生效;开单时构造 A→B→A 环被拒;全 journal 重放通过。

## 明确不建(边界,各带准入条件)

| 不建 | 准入条件 |
| --- | --- |
| runtime 内 frontier 调度器 | 宿主编排跨任务顺序实际失手记录 ≥2 次 |
| 监督/审计边(loop watching loop) | Phase 1 观察数据出现真实重复失败模式 |
| 跨 authority 边 | 单 authority 边有真实使用后再议 |
| 边的运行时自动重规划 | 永不——人工修订(amend 类动词)即可 |

## 风险与回滚

- 最尖锐风险:replay 兼容。journal fail-closed,验证器写错会锁死存量仓库。
  缓解:每个 schema 变更配旧格式 fixture journal 重放测试(进 `npm test` 门禁,
  符合 AGENTS.md change contract);payload 形态分支而非字段改写。
- 容量:观察记录有界化(identifiers 数量与 summary 长度封顶,原始输出只存 digest)。
- 回滚:各阶段独立可回退;新 kind 只增不改,回退运行时即回退能力,
  已写记录按未知 kind fail-closed(诚实失败,不静默降级)。

## 下一步

写 Phase 0.2 + 0.3 + Phase 1 共用的持久化契约设计稿(CAS 粒度、容量分层、
观察记录形态,一页纸),首条验收用例即"不相交任务并发认证互不作废"。

## 翻盘条件

若"图"的真实需求是多 agent 实时协同编排(而非持久任务依赖),主战场在宿主
编排层,本计划 Phase 2 及之后价值趋零,应止步于 Phase 0/1。
