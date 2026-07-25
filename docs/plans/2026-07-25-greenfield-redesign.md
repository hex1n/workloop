# Workloop 绿地重设计(零继承)

日期:2026-07-25(修订 1:按[第一性推导审计](../../greenfield/scenarios/AUDIT-2026-07-25.md)重裁 8 条机制)
状态:设计稿(未开工);Value Gate:BUILD(来源 = owner 显式决定)
前提:不继承现有 repo 实现;不引用 `docs/` 既有决策结论;旧实现中唯一计划
搬走的是验收场景语料,不是代码
经济性:修订 1 后规模下降(证据通道与 placement 层出局),约 10–16 工程日起
关联:图进化计划(增量路线,本稿曾是其绿地对照)——该稿随上一版实现的文档一并
清理,绿地已取代它;
场景语料:`greenfield/scenarios/`(86 条,审计后 59 保留 / 7 改写 / 20 出局)

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
5. **实体只经 digest 耦合**:任何两个实体(节点、轮次、边)之间的引用都是
   内容寻址的,互不复制事实、互不隐式共享状态。

**修订 1 的推论(审计 M1)**:公理 2 与公理 4 合起来意味着运行时**不需要**
旁路观测通道。宿主提交 observation 是唯一入口;hook 类证据既不进判断,也就
不进内核(见「非目标」)。

## 领域模型

```text
Store       一个循环账本的边界与身份 —— 日志、锁、投影都属于它
  Site      Store 内的一个工作现场(git: 一个 worktree;非 git: 根本身)
  Loop      目标、claims、criterion、预算、策略 —— 图的节点
    Round     一次 行动→观察→判断→决策 的完整周期
    Directive 系统给出的下一步契约(幂等:状态不变则重复返回同一份)
    Observation 宿主提交的实际结果 + receipt
    Judgment  criterion 对结果的裁决(结构化 verdict)
    Decision  continue | repair | collect_evidence | review | suspend | terminal
  Edge      节点间有类型的 digest 引用(v1 仅 depends_on)
Receipt     制品证据(git: commit oid + 任务路径 diff digest;非 git: 文件 digest 集)
Amendment   用户对目标、预算、claims、criterion 的显式变更,作废受影响的旧判断
```

**Site 取代旧世界的 attachment**(审计 M5):保留的是"一个 store 对应多个
工作现场"这个 **git 的性质**;去掉的是 locator 时代的 epoch、claim token、
reattach、fork-identity 那套恢复机制。非 git 场景下 Site 与 Store 一一对应,
该层退化为空壳。

## 存储层(store 住在它描述的位置)

```text
git:      <git-common-dir>/workloop/     # 多 worktree 共享,删 worktree 不丢历史
非 git:   <root>/.workloop/

  manifest.json          # store id、genesis 物理锚、schema 世代、活动 segment
  segments/000001.log    # 长度前缀帧 + sha256 链 + CRC;写满即封段
  snapshots/000040.json  # 每 N 段一份投影快照,重放 = 快照 + 尾段
  locks/                 # 单写者目录锁(stale 可收割);读者无锁(封段不可变)
```

- 封段记录携带状态 digest,链跨段延续;torn tail = 截到最后一个完整帧并追加
  恢复记录。
- 终结/挂起永远可写:段轮转内建储备,"写满导致无法收尾"在结构上不存在。
- **无 locator**(审计 M3):store 不再托管在受管 home,因而不需要指向它的
  正向指针,也就没有两阶段认领、claim token、伪造与孤儿检测。
- **碰撞检测保留,手段简化**:`cp -r` 与 clone 让两个位置声称同一 store 身份,
  这是文件系统与 git 的性质,必须检测。genesis 记录物理锚(dev/ino/birthtime,
  或 git common dir 身份),读取时比对不符即判碰撞并拒绝写入。

**显式接受的取舍**:根被删除时其循环历史随之消失。留档手段是显式 `export`,
不是把数据藏到别处。git 场景不受影响——store 在 common dir,删 worktree 不丢。

## 寻址模型(审计 M2)

- **显式优先**:命令接受 store 路径与 loop id。
- **便利发现**:未显式给出时,从 cwd 向上走目录树找 store 目录——与 git 自己
  发现 `.git` 同构,零额外机制。
- **不做**从任意文件路径反查"这个写入属于哪个节点"的目标优先路由。它在旧世界
  存在只是为了让旁路证据能归属,随 M1 一并出局。

## 一致性模型

- 每个变更命令携带 `command_id`(重放去重,幂等)与 `expected_revision`
  (所改实体的乐观并发版本)。
- **修订版本是实体级的,不是全局的**:judgment、observation、边校验都只绑
  自己实体的 revision 与相关 digest。邻居节点的任何活动不影响你——这是图能
  并发的前提,是公理 5 的直接推论。
- **会话身份只是 provenance**(审计 M7):记录谁开的、谁参与、谁下的判断,
  但**不参与路由,也不限制一个会话同时推进多个节点**。旧世界的"一会话一活动
  节点"只为让旁路证据无歧义归属而存在,且与图正面冲突——一个 agent 推进 DAG
  多个节点是图工程的常态。

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

## claims 与 receipt 的关系

claims 不是访问控制——运行时不控制文件系统,拦不住任何写入。它的作用是让两个
节点的**意图**不重叠,从而 **receipt 能界定"我的路径"**:任务范围的 stage 与
commit 只收自己 claims 内的路径,index 里出现外来内容时 receipt 诚实降级为
uncertain,永不伪造 clean。这是 claims 在绿地保留的**唯一**理由,也是它足够的
理由(审计 M9)。

## 图模型

- v1 唯一边类型 `depends_on {loop_id, pinned_certification_digest|null}`,
  开单时声明、不可变、开单时查环。
- 认证下游时校验:上游 terminal achieved(+ pin 匹配 + git 场景下上游认证
  commit 是本节点 HEAD 祖先)。不满足以可判别的"依赖未满足"拒绝。
- `ready` 是只读前沿投影。调度器、监督边、仲裁边显式列为非目标,各带准入条件。

## 公开接口

- **service-first**:可 import 的应用服务是唯一语义入口;CLI 是薄壳(参数
  解析 + JSON 打印);宿主/测试都走服务层,测试不起进程。
- 循环面:`open · next · observe · amend · join · receipt · suspend · resume · abandon`
- 查询面(只读、零字节变化):`status · log · ready`
- 维护面(非首切片):`export`(留档)、`recover-tail`(撕裂尾部,双证明 +
  user 溯源)
- **`next` 是纯读**,状态不变时逐字节相同;**`observe` 是唯一触发
  judgment + decision 的写入口**。
- 出局的动词(审计):`reattach`、`fork-identity`、`archive-incompatible-state`
  (随 M5/M8),`hook`/`hooks`(随 M1),placement 相关全部(随 M4)。
  open 遇中断的幂等续行由同 command_id 重跑覆盖,不需要独立恢复动词。

## 宿主契约

宿主决定是否允许执行,agent 决定怎么实现,workloop 只决定循环状态与合法下一步。
运行时**不存在**任何自行执行工具、创建工作树、修改分支或越过审批的路径——
这也是 placement 层出局的直接理由(创建 worktree 与分支是执行)。

节点可以绑定到一个**已存在**的隔离现场,并在绑定时**只读校验**其 branch/base
符合预期。校验不是执行。

## 测试策略(把上一代的教训写进结构)

1. **场景语料即规格**:`greenfield/scenarios/`,先写场景再写实现。核心验收:
   三轮跨会话修复循环(round 1 失败 → 换 session 携带 failure signature →
   round 2 制品变化允许继续 → round 3 achieved → 再调 `next` 只返回同一
   terminal)、不相交并发互不作废、崩溃后 directive 重放、双 session 不能
   消费同一 directive。
2. **性质测试**:replay 确定性(同日志必同投影)、命令幂等、任意截断点的
   崩溃注入。
3. **门禁 glob 一切**,fixture 的环境隔离进共享 helper——腐化在结构上不可能。

## 交付切片(修订 1 后)

| 切片 | 内容 | 完成判据 | 估算 |
| --- | --- | --- | --- |
| 1 日志内核 | 段/链/快照/锁/实体级 OCC/幂等 + 崩溃注入与性质测试 | LK 族保留场景全绿 | 3–5 天 |
| 2 单节点闭环 | 状态机 + 默认策略 + criterion 协议 + git receipt | SL 三轮闭环 + GR 全族 | 5–8 天 |
| 3 图 | depends_on + ready 投影 | GE 全族 + 查环 | 2–3 天 |
| 4 收尾 | CLI 壳、非 git store、skill 文本、export | FS 保留场景 + 打包闭包 | 1–2 天 |

修订 1 的规模变化:切片 4 的主体(hook 适配器 + 安装期 hook 协商)出局;
切片 1 的锁分类集缩到 2–3 类、事务相位缩到 append + snapshot(旧世界的
locator 与 outcome 发布相位随 M3/M6 消失)。

旧日志不迁移(新世界零包袱);旧状态如需保留,单独做一次性导出工具,不进内核。

## 非目标(永久或带准入条件)

- **旁路证据通道(hook)**:出局(审计 M1)。它永不做控制,故对判断零贡献;
  它买到的只是"agent 越界"的提前量,而 receipt 时刻同样会发现。
  **Flip 条件**:判定 claims 边界需要实时拦截写入——那同时要求修订"宿主拥有
  执行审批"的公理,须重过 Value Gate。
- **placement / 运行时创建工作树**:出局(审计 M4),与执行边界冲突。
- **store 托管在受管 home + locator**:出局(审计 M3)。
- **跨 store 全局投影**:出局(审计 M6),需要时做纯客户端聚合。
- 不做调度器、不做 LLM strategy、不调模型、不建 sandbox、不存对话、不做多语言
  移植;监督/仲裁边等图的高级拓扑,在单边类型有真实使用前不入词汇表。

## Bestness Check

- **判准**:五公理无一妥协、每切片独立可验收、宿主边界零越界。
- **胜者**:"账本内核 + 机械策略 + digest 图"。
- **最接近替代**:先做全功能 loop runtime 再补图。输在:图的前提(实体级 OCC、
  digest 耦合、会话不绑路由)必须在内核层就定下,后补等于重写内核。
- **什么会击败它**:如果真实使用证明"宿主驱动"太繁琐(每轮要人/agent 调三个
  动词),需要引入 runner——那是对公理 4 的修订,须重新过 Value Gate。
- **停止点**:切片 3 后,任何新机制都要等真实使用证据。

## 最大风险(如实记)

1. **M1 是最可能被推翻的一条裁决**。它假定循环判断不需要实时拦截写入。若该
   假定错,目标优先路由、会话唯一性及其约 10 条衍生场景要整体回流。出局场景
   在语料中原文保留并标注驱动机制,按族恢复,不用重写。
2. **二次系统效应与丢失旧边角**。缓解:场景语料已完成并过审计,实现以逐条
   满足它为完成判据;旧实现的代码不看,行为证据只从语料读。

## 下一步

写切片 1 的性质测试规格(重放确定性 + 幂等 + 崩溃注入点清单),它同时是
日志内核的规格书。
