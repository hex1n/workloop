# 切片 2:单节点循环规格书

日期:2026-07-25
状态:**追写**。切片 1 立的规矩是"先写规格书再写代码",本切片没做到——我从
场景语料与设计稿直接进了实现。第三轮代码评审指出了这一点,并且说对了要害:
本次漏掉的东西(git receipt、开单溯源、claims 形状)**恰好是一份写在前面的
规格会逼我摊开的那几个决定**。本文补记已定的裁决,并把未做的部分显式挂账。

上承:[SL 族场景](../scenarios/02-single-loop.md)(13 条)、
[GR 族场景](../scenarios/04-receipts-git.md)(7 条)、
[设计稿](../../docs/plans/2026-07-25-greenfield-redesign.md)。
完成判据:SL 族与 GR 族保留场景全绿。**已达成**;GR 族见
[02-git-receipt](02-git-receipt.md),剩余挂账见 §6。

## 1. 分层

```text
src/vocabulary.mjs        通用描述符校验器(领域无关)
src/domain/vocabulary.mjs 循环词汇:每种记录的字段、类型、边界
src/domain/projection.mjs 纯折叠:记录 → 循环状态
src/domain/policy.mjs     纯函数:状态 → 下一步
src/domain/criterion.mjs  判据进程的执行与读取
src/domain/loop.mjs       服务层:宿主驱动的动词
```

内核(`src/store.mjs` 等)不 import 本层任何文件。方向是单向的。

## 2. 词汇即数据

每个 kind 一份描述符,一个通用校验器执行全部。字段**精确匹配而非超集**:多出
的字段会被下一个读者静默丢弃,而写入方会以为自己记下了什么。描述符本身在
构建词汇表时校验,不是用的时候——否则笔误要等到一条真命令写入才暴露。

`nullable` 必须显式声明。

**`review` 决策不入词汇表**(裁决):设计稿的策略表把它列为 `stuck` 的并列
选项,但本切片没有任何东西能产生一个 reviewer。**没有写入者的词汇正是审计花
时间清掉的那类残留**,它等 reviewer 出现时再回来。

## 3. 默认策略(判定顺序是承重的)

```text
未开单                        → implement
terminal                      → 恒定返回其结局
suspended                     → suspend(带挂起原因)
最近一轮 satisfied            → achieved(terminal)
轮次用尽                      → suspend: out_of_budget
无观察                        → implement
最近一轮 indeterminate        → collect_evidence
同 progress signature 达阈值  → stuck
最近一轮无 receipt            → produce_receipt
其余(unsatisfied 且失败是新的) → repair
```

三条顺序不可调换,各有一条测试押着:

- **satisfied 压过预算耗尽**——最后一轮成功了就是成功,不是挂起。
- **预算在提出新工作之前检查**——否则会多跑一轮。
- **terminal 恒定**——包括之后又来了本领域不认识的记录时。

### 3.1 progress signature

`H(criterion digest + artifact checkpoint + receipt digest + 规范化失败标识)`。

于是一个正在改代码的循环,即使错误信息一字不变也算在动。而判据没说出任何
**可辨识**的失败时,**signature 为 null,且 null 不参与相同判定**——三次沉默
是三个未知,不是同一个失败见了三次;把它算作 stuck 等于因为检查器嘴笨就停掉
一个还在推进的循环。

## 4. 判据协议

- 运行时**亲自 spawn**判据(设计稿公理 2)。这是运行时唯一保留给自己的执行,
  理由是锚点:agent 说做完了是线索,运行时启动的进程的退出码是事实。
- 输出契约:stdout 末行 `WORKLOOP_VERDICT {json}`。取**最后**一条匹配行。
- 退出码兜底〔本切片定版〕:**4 = satisfied、3 = unsatisfied、其余一律
  indeterminate**。0 与 1 不能是成功——文件不存在、解释器崩溃、误跑了个 `true`
  产生的都是这个区间的码,每一个都必须读作"不知道"而不是绿。
  **成功是唯一绝不能靠意外发生的答案。**
- **说的话与自己的退出码矛盾 → indeterminate**。判据是锚,自相矛盾的锚不是锚。
- 超时杀**整个进程组**(POSIX 负 pid;Windows `taskkill /T`)。只杀直接子进程
  会把它启动的东西留在"运行时以为判据已经结束"之后。
- 输出**增量哈希、不累积**:每流一个 sha256 滚动更新,只保留有界窗口。判据
  打印一 GB 不会让运行时持有一 GB。digest 分流计算,两条流不会互相混淆。
- 保留的是**尾部**不是头部:检查失败时,出错的地方在它打印的末尾。

## 5. 服务层

- `open` 要求 goal、claims、criterion、budget、session、**reason 与 granted_by**。
  没有溯源的循环是事后没人能审计的循环。
- `next` 是纯读,状态不动时逐字节相同。
- `observe`:
  - **先查该 commandId 是否已落账**,是则直接返回重放结果——不重跑判据。
    崩溃后的重试不该再付一次判据的钱(有时是几分钟)。
  - **判据在锁外运行**。它可能跑几分钟,持锁那么久会让循环不可用。
  - 陈旧性由写入时比对**该循环自己的 revision** 抓。于是别处发生的事永远无法
    作废本轮——这正是旧实现里认证被不相交邻居打碎的那个失效模式,在设计层
    就不存在。
  - `requestDigest` 取自**请求**(轮次+会话+receipt+判据 digest)而非结果:
    判据每次运行都可能说出新东西,拿结果做 digest 会让每次重试看起来都是
    另一条命令。
- `join` 是取得资格的唯一显式途径;`suspend`/`resume` 要求发起者是参与会话。
  **知道一个循环的地址,不等于有资格移动它。**
- `amend` 的 `granted_by` 枚举只有 `user`:运行时不得改写自己的目标。

### 5.1 claims

claims 是字面路径:相对、去重、互不包含、不含通配。理由不是洁癖——**运行时
无法逐字比较的 claim,就是两个循环无法被证明不相交的 claim**,而"我的路径"
可判定正是 claims 存在的唯一理由(设计稿"claims 与 receipt 的关系")。

artifact checkpoint 用 `lstat` 不跟随符号链接(否则会被引出 claim 之外或绕圈),
深度与条目数有上限,不可读的条目**记为事实而非抛错**——判据此时已经跑完了,
为了一个读不了的文件丢掉整次观察是不划算的。

## 6. 未完成(显式挂账)

| 项 | 状态 | 备注 |
| --- | --- | --- |
| **git receipt(GR 全族)** | **已做** | 见 [02-git-receipt](02-git-receipt.md)。`observe` 不再接受调用方传入的 `receiptDigest`——receipt 由运行时自己产生、自己复核,补上了公理 2 一直敞着的那一半。 |
| SL-13 amend 使旧 judgment stale | 已做 | 见 [08-amendment](08-amendment.md)。此前「靠 signature 漂移隐式生效」只对了一半:改判据会让 stuck 归零,只改目标不会,而且两种情形下指令都仍把旧裁决当反馈递出去 |
| `status` / `log` / `ready` 动词 | 已做 | 查询面,见 [04-host-face](04-host-face.md) |
| 运行时被 SIGKILL 时判据进程组成孤儿 | 已知限制 | DEBT D-03 |

## 7. 修订记录

- 2026-07-25(第三轮代码评审后):本文追写。同批修复:判据输出改增量哈希
  (原为无界累积)、summary 取尾而非取头(原实现先取末 4000 再取前 2000,
  恰好丢掉了出错的那一段)、`runCriterion` 加双重 settle 保护与退出时清理、
  checkpoint 加符号链接/深度/条目/不可读处理、`observe` 加命令重放前置检查、
  补 SL-01 溯源 / SL-02 claims 形状 / SL-11 参与资格 / `join` 动词、
  删除无写入者的 `review` 决策。
- 2026-07-25:`src/domain/criterion.mjs` 曾含一个字面 NUL 字节(用作 digest
  分隔符),使 git 与 grep 把整个文件当二进制——**该文件在两轮评审里是隐形的**。
  已改为分流 digest,并加了一条门禁外的检查思路:源码树中不得出现非文本文件。
