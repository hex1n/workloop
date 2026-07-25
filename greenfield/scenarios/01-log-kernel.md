# 01 日志内核(LK)

来源主体:`tests/authority-transaction.test.mjs`、`tests/git-main-authority.test.mjs`
(torn tail、hash-valid 伪造)、`tests/git-linked-worktree-authority.test.mjs`
(重复锚)。新增:分段、储备、崩溃注入、性质测试。
具体措辞/错误码/枚举/数值按 README「语义不变式与旧世界任意值」默认规则为旧值锚。

实现规格见 [切片 1 规格书](../slices/01-log-kernel.md)(磁盘格式、锁规则、
完整性策略、性质测试 P0–P12、崩溃注入矩阵 C1–C8)。

**审计处置**([AUDIT-2026-07-25](AUDIT-2026-07-25.md)):13 保留 / 1 出局。
出局:**LK-06**(多 store 顺序操作,随 M1 证据通道)。
另:LK-01 的锁分类集与 LK-05 的相位数随 M6/M11 收缩,不变式不变。

## 锁协议

### LK-01 锁分类有全序,违序与重入即抛
来源:authority-transaction「physical lock protocol…」
- 前置:锁分类集(旧值锚:{store, git_operation, criterion_lease, outcome,
  maintenance};新世界的分类集随架构重定,不变式是**存在固定全序**)
- 动作:各种嵌套获取
- 断言:全序允许的嵌套方向通过;同类重入抛;一切逆序对抛序违例;
  **两个不同 store 的锁不可同持**(语义,不随分类词汇变);临界区回调必须
  同步(async 回调直接抛);无有效 lock manager 时任何事务入口拒绝执行且
  零副作用。

### LK-02 单写者互斥带所有者记账,跨进程生效
来源:authority-transaction「physical authority lock is owner-recorded…」
- 前置:进程 A 持有 store 锁
- 动作:进程 B 尝试获取并执行事务
- 断言:B 获取失败(带超时);事务失败携带结构化收据,如实回答四问:
  哪类失败、哪个相位、append 是否已提交、动作是否已开始(字段名与 code 名
  为旧值锚);锁持有含 owner 记账(分类、资源、pid);A 释放后锁现场消失,
  B 可获取。

### LK-03 保留的 owner 元数据字段禁止伪造
来源:authority-transaction「reserved owner metadata is rejected…」
- 动作:以 ownerExtra 携带 pid/token 获取锁
- 断言:发布锁文件之前拒绝(reserved fields),文件系统零残留。

### LK-04 释放失败毒化进程内后续锁操作,且不销毁现场
来源:authority-transaction「unreleased acquire and release failures poison…」
- 前置:注入锁释放失败 / 获取后清理失败 / 释放不可证明(release unproven)
- 断言:失败收据如实区分 append_committed ∈ {true, false, indeterminate} 与
  failed_action_state ∈ {not_started, completed, indeterminate};同进程后续任何
  锁获取被 LOCK_STATE_POISONED 拒绝(含只读观察者);第一个锁/claim 文件保留
  供人工检查;伪造 action_completed 的错误不能把状态洗成成功。

## 事务与部分状态

### LK-05 事务相位固定,任一相位失败留下如实的部分状态收据
来源:authority-transaction「provider-neutral transaction binds lock boundaries…」
- 前置:事务 = append 先行,各投影发布相位随后(相位名与个数为旧值锚;
  不变式是 **append 是唯一权威写、投影相位在其后且可各自缺席**)
- 动作:在每个相位边界注入失败
- 断言:失败收据相位精确、append 提交状态与实际一致;已执行副作用集合与
  相位边界一致;可选相位跳过时结果为空;操作抛出的错误(含伪造相位错误)
  归为操作失败且 append 提交状态 = 不可知;返回 Promise 的 append 同样拒绝。

### LK-06 多 store 顺序操作非原子,部分完成有精确收据
来源:authority-transaction「multi-authority work prevalidates ids…」
- 动作:一个 operation 跨多个 store 顺序执行,第二个失败
- 断言:入参预校验(operation id 非空、store id 唯一非空、trim 规范化)在任何
  执行前完成;失败收据 {completed 列表, failed_store, failed_action_state,
  results} 如实;第一个 store 的已提交结果不回滚(显式非原子)。

## 完整性与重放

### LK-07 重放确定性(性质测试)
来源:new: 设计稿·测试策略
- 断言:任意有效日志,重放两次投影逐字节相同;快照 + 尾段重放 ≡ 全量重放。

### LK-08 hash 有效但语义非法的记录在重放时拒绝
来源:git-main「replay rejects Git certification without…」「persisted schema and
authority-state transitions reject…」、git-linked「hash-valid duplicate stable anchors…」
- 前置:手工追加链正确、digest 正确的记录
- 断言:以下各自 fail closed 且诊断具体——伪造的 achieved judgment(无匹配的
  clean receipt);重复的节点开启转换;payload 多出未声明字段(schema 违例);
  重复 command_id;重复的稳定锚。任何读动词此后以失败退出码拒绝。

### LK-09 命令幂等:同 command_id 同入参重放返回原结果,零新记录
来源:git-main「current open requires replayable command provenance…」、
filesystem「reused filesystem command ids must bind scope and provenance」、
attachment-recovery(reattach/fork 重放)
- 断言:重复调用返回与首次相同的实体 id 集,日志长度不变;同 command_id 改
  入参(scope/provenance/goal 任一)→ 拒绝并诊断 conflicts with durable intent。

### LK-10 不完整写入自动恢复;真损坏才失败关闭〔切片 1 §4.1 修订〕
来源:git-main「torn authority tails fail closed…」、filesystem「detached authority
torn tails recover by exact authority selector…」——**"一律要人"已修订**。
推导:旧世界的帧是 JSON 行,截断的行与损坏的行在字节上不可区分,分不清就只能
一律交给人;长度前缀帧让这个区分变成机械的,而**写到一半的记录从未被确认过**
(调用方没拿到返回),丢弃它不丢任何已承诺事实。要求每次崩溃都有人介入,与
"必须能跨崩溃恢复"自相矛盾。
- **不完整写入**(最后一段末尾,可用字节 < 8 + 声明 LEN):自动截断至上一
  合法帧,追加 `tail_truncated` 记录(携带被弃字节数与 digest);读写照常;
  被中断的原命令重跑即应用(与崩溃注入 C2 同一条路径)。
- **真损坏**(帧完整但 CRC 不符、链断裂、digest 不符、seq 空洞、中段不完整):
  一切读写失败关闭并给出具体诊断;`recover-tail` 要求调用方提交**双证明——
  有效末端字节偏移 + 被弃尾部 digest**(选项名为旧值锚,双证明是语义)且溯源
  为 user;self 溯源拒绝且字节不变;恢复后追加恢复记录携带被弃字节 digest。
- 保守边界的理由:帧完整而 CRC 不符时,无法区分部分写入与位腐/篡改;若原
  写入曾被确认,自动丢弃就是静默丢失已承诺事实——故这一类必须要人。
- 两种 store 语义一致(非 git 者以 store 路径寻址)。

### LK-11 只读动词零持久化字节变化
来源:git-main「query verbs observe authority and collisions without changing durable bytes」
- 断言:status/audit/log/ready 前后,日志段、manifest、快照与任何投影文件的
  字节与 mtime 全部不变;对碰撞副本的查询也不改副本的任何字节。

### LK-12 投影是可弃缓存,损坏不毒化、删除可重建、绝不静默改写
来源:git-main「…replays after disposable projections are removed」「Git outcome
shards are per-authority caches…」、filesystem「filesystem outcome shard rebuilds…」
- 断言:删除快照/投影后读动词照常工作且不隐式重建文件;写入垃圾到投影后读
  动词不触碰它;下一次显式变更命令重建正确投影;一个 store 的投影损坏对另一
  store 零影响(分片隔离)。

## 分段与容量(新)

### LK-13 段轮转封印,终结动词永远可写
来源:new: 设计稿·存储层
- 断言:活动段写满→封段(携带状态 digest)→新段继续,链跨段延续;人为填满
  存储配额场景下 suspend/abandon/terminal 仍可追加;重放跨段等价单段。

### LK-14 崩溃注入:任意写入中断点恢复后不重复、不丢失
来源:new: 设计稿·测试策略(旧世界由 LK-05 部分状态收据近似覆盖)
- 动作:在 append 的 write/fsync/rename 各中断点 kill 进程
- 断言:重启后重放要么看到完整帧要么按 LK-10 的 torn-tail 协议失败关闭;
  已确认提交的 command_id 重放幂等,未确认的可安全重试。
