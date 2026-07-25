# Workloop 绿地重设计(零继承)

日期:2026-07-25
状态:设计稿(未开工);Value Gate:BUILD(来源 = owner 显式决定)
前提:不继承现有 repo 实现;不引用 `docs/` 既有决策结论;旧实现中唯一计划
搬走的是验收场景语料,不是代码
经济性:全新实现约 13–21 工程日起,不含与旧实现全部边角用例的对齐
关联:[图进化计划](2026-07-25-graph-evolution.md)(增量路线;本稿是其绿地对照);
场景语料:`greenfield/scenarios/`(2026-07-25 已完成,含对本稿动词表的三条修订反馈)

## 使命一句话

一个**宿主中立的循环账本运行时**:目标可以跨进程、跨会话、跨 agent 持续迭代;
任何兼容宿主取得确定的下一步,提交可验证的结果,由持久状态机决定继续、调整、
暂停或终结。运行时拥有**状态与真相**,永不拥有**执行与审批**。

## 设计公理(所有决定从这五条推出)

1. **重放即真相**:唯一权威是 append-only 日志;任何投影可丢弃可重建。
2. **锚点不可争辩**:进入判断的只有运行时亲自观测的事实(退出码、digest、
   commit oid),agent 的话永远只是线索。
3. **失败即关闭**:损坏、未知词汇、验证不过 → 拒绝写入并诊断,不静默降级。
4. **每次调用一个转换**:没有隐藏的 while 循环;宿主反复驱动,每步幂等可重放。
5. **实体只经 digest 耦合**:任何两个实体(任务、轮次、边)之间的引用都是
   内容寻址的,互不复制事实、互不隐式共享状态。

## 领域模型

```text
Loop        目标、claims、criterion、预算、策略 —— 图的节点
  Round     一次 行动→观察→判断→决策 的完整周期
  Directive 系统给出的下一步契约(幂等:状态不变则重复返回同一份)
  Observation 宿主提交的实际结果 + receipt
  Judgment  criterion 对结果的裁决(结构化 verdict)
  Decision  continue | repair | collect_evidence | review | suspend | terminal
Edge        节点间有类型的 digest 引用(v1 仅 depends_on)
Receipt     制品证据(git: commit oid + 任务路径 diff digest;fs: 文件 digest 集)
Amendment   用户对目标/预算/claims/criterion 的显式变更,作废受影响的旧判断
```

## 存储层(从第一天就没有容量墙)

```text
<root>/.workloop/
  manifest.json          # store id、schema 世代、活动 segment
  segments/000001.log    # 长度前缀帧 + sha256 链 + CRC;写满即封段
  snapshots/000040.json  # 每 N 段一份投影快照,重放 = 快照 + 尾段
  locks/                 # 单写者目录锁(stale 可收割);读者无锁(封段不可变)
```

- 封段记录携带状态 digest,链跨段延续;torn tail = 截到最后一个完整帧并追加
  恢复记录。
- 终结/挂起永远可写:段轮转内建储备,"写满导致无法收尾"在结构上不存在。

## 一致性模型

- 每个变更命令携带 `command_id`(重放去重,幂等)与 `expected_revision`
  (所改实体的乐观并发版本)。
- **修订版本是实体级的,不是全局的**:认证、观察、边校验都只绑自己实体的
  revision 与相关 digest。邻居节点的任何活动不影响你——这是图能并发的前提,
  是公理 5 的直接推论。

## 事件模型:schema 是数据

- 每个 event kind 一份带版本的声明式描述符(字段、类型、边界、有界长度),
  一个通用校验器执行全部验证;新增词汇 = 新增描述符。
- 未知 kind/版本 → fail closed + 升级提示。降级兼容按"只增不改"约定:
  新运行时读旧日志永远可以,反向诚实拒绝。

## 循环状态机与默认策略(机械、无 LLM)

```text
open → ready → directive_issued → observed → judged → (ready | suspended | terminal)
```

| 状态事实 | 决策 |
| --- | --- |
| 无制品变化 | implement |
| 有变化无 receipt | produce_receipt |
| 有 receipt 未判断 | judge |
| verdict satisfied | terminal: achieved |
| 新 failure signature | repair |
| 同 progress signature 达阈值 | review / stuck |
| verdict indeterminate | collect_evidence |
| 预算耗尽 | suspended: out_of_budget |
| 需人决定 | suspended: needs_input |

`progress_signature = H(artifact_checkpoint + criterion_digest +
规范化 failure identifiers + receipt digest)`——只有失败相同且制品无实质变化
才算重复。

## 验证协议(criterion)

- criterion 是运行时亲自 spawn 的只读可执行文件(锚点公理);定义以 digest
  绑进每次 judgment。
- 输出契约:stdout 末行
  `WORKLOOP_VERDICT {"verdict":"unsatisfied","failures":[{id,expected,actual}],"metrics":{...}}`;
  tri-state 退出码作为降级兼容。failures 有界,原始输出只存 digest 与有界截断。
- Judge 与 Strategy 分离:criterion 只说哪里不满足,决策由上表机械给出。

## 图模型

- v1 唯一边类型 `depends_on {loop_id, pinned_certification_digest|null}`,
  开单时声明、不可变、开单时查环。
- 认证下游时校验:上游 terminal achieved(+ pin 匹配 + git 场景下上游认证
  commit 是本节点 HEAD 祖先)。
- `ready` 是只读投影。调度器、监督边、仲裁边显式列为非目标,各带准入条件。

## 公开接口

- **service-first**:`@workloop/core` 可 import 的应用服务是唯一语义入口;
  CLI 是薄壳(参数解析 + JSON 打印);宿主/MCP/测试都走服务层,测试不起进程。
- 动词表:`open · next · observe · amend · suspend · resume · abandon ·
  status · log · ready`。`next` 是纯读(状态不变则逐字节相同);`observe` 是
  唯一会触发 judgment+decision 的写入口。

## 宿主契约

宿主决定是否允许执行,agent 决定怎么实现,workloop 只决定循环状态与合法下一步。
hook 是可选证据通道,永不做控制;运行时没有任何路径可以自己执行修复动作或
越过审批。

## 测试策略(把上一代的教训写进结构)

1. **场景语料即规格**:先写验收场景再写实现——三轮跨会话修复循环
   (round 1 失败 → 换 session 携带 failure signature → round 2 制品变化允许
   继续 → round 3 achieved → 再调 `next` 只返回同一 terminal)、不相交并发
   互不作废、崩溃后 directive 重放、双 session 不能消费同一 directive。
2. **性质测试**:replay 确定性(同日志必同投影)、命令幂等、任意截断点的
   崩溃注入。
3. **门禁 glob 一切**,fixture 的环境隔离进共享 helper——腐化在结构上不可能。

## 交付切片(绿地施工顺序)

| 切片 | 内容 | 完成判据 | 估算 |
| --- | --- | --- | --- |
| 1 日志内核 | 段/链/快照/锁/OCC/幂等 + 崩溃注入与性质测试 | 性质测试全绿 | 4–6 天 |
| 2 单节点闭环 | 状态机 + 默认策略 + criterion 协议 + git receipt 适配器 | 三轮修复场景端到端 | 5–8 天 |
| 3 图 | depends_on + ready 投影 | 多节点场景 + 查环 | 2–3 天 |
| 4 宿主面 | CLI 壳、skill 文本、fs receipt 适配器 | 双 provider 场景 | 2–4 天 |

旧日志不迁移(新世界零包袱);若旧状态需要保留,单独做一次性导出工具,不进内核。

## 非目标(永久或带准入条件)

不做调度器、不做 LLM strategy、不调模型、不建 sandbox、不存对话、不做多语言
移植;监督/仲裁边等"图的高级拓扑"在单边类型有真实使用前不入词汇表。

## Bestness Check

- **判准**:五公理无一妥协、每切片独立可验收、宿主边界零越界。
- **胜者**:"账本内核 + 机械策略 + digest 图"。
- **最接近替代**:先做全功能 loop runtime 再补图。输在:图的前提(实体级 OCC、
  digest 耦合)必须在内核层就定下,后补等于重写内核。
- **什么会击败它**:如果真实使用证明"宿主驱动"太繁琐(每轮要人/agent 调三个
  动词),需要引入 runner——那是对公理 4 的修订,须重新过 Value Gate。
- **停止点**:切片 3 后,任何新机制都要等真实使用证据。

## 最大风险(如实记)

**二次系统效应**与**丢失旧边角**。缓解只有一个:切片 1 之前,先把旧仓库的
验收场景(worktree 矩阵、attachment/tail recovery、Windows 语义)翻译成
新世界的场景语料——**旧实现里唯一值得搬走的是测试,不是代码**。这一步做完
之前不写内核第一行。

## 下一步

写切片 1 的性质测试规格(重放确定性 + 幂等 + 崩溃注入点清单),它同时是
日志内核的规格书。
