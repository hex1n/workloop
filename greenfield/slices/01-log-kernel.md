# 切片 1:日志内核规格书

日期:2026-07-25
地位:实现规格。上承[设计稿](../../docs/plans/2026-07-25-greenfield-redesign.md)
与 [LK 族场景](../scenarios/01-log-kernel.md)(13 条保留),下接实现。
完成判据:本文 §5 的性质测试与 §6 的崩溃注入矩阵全绿,且 LK 族保留场景全绿。

内核是**领域无关**的:它不知道 Loop、Round、Judgment 是什么。它提供追加、
重放、幂等、并发与恢复;领域投影由调用方以 reducer 注入(切片 2 才出现)。

## 1. 磁盘格式

```text
<store>/
  manifest.json          # 仅不可变事实
  segments/000001.log    # 帧序列;编号从 1 起,零填充 6 位
  snapshots/000042.json  # 文件名 = 该快照覆盖到的 seq
  locks/<class>-<resource>/owner.json
```

**活动段由目录列举推导**(编号最大者),manifest 不记可变指针——崩溃后
没有"指针与现实不一致"这种状态,是构造性的崩溃安全。

### 1.1 帧

```text
LEN   u32 小端   = PAYLOAD 字节长度
PAYLOAD LEN 字节 = 记录的规范 JSON(UTF-8)
CRC   u32 小端   = crc32(PAYLOAD)   // CRC-32/IEEE,取自 node:zlib
```

校验和取 **CRC-32/IEEE**,由 `node:zlib` 的 `crc32` 提供(需 Node ≥ 22.2)。
选内置而非自带 Castagnoli 表:它的用途是检测意外损坏,不是安全原语,而平台
内置意味着没有自己维护的位运算表。**算法必须由已知向量测试钉住**——校验和是
线上契约的一部分,别的读者要能复现,不能靠"我们两边用了同一个函数"来自洽。

帧长 = 8 + LEN。**LEN 与 CRC 各有不可替代的职责**:LEN 让"写了一半"成为
可机械判定的事实(可用字节 < 声明长度);CRC 让"写完了但内容坏了"与前者
区分开。§4 的恢复策略完全建立在这个区分上。

### 1.2 记录

```json
{
  "v": 1,
  "seq": 42,
  "prev": "sha256:…",
  "cmd": "…",
  "kind": "…",
  "payload": { },
  "digest": "sha256:…"
}
```

- `seq` 全 store 单调,从 1 起,无空洞。
- `prev` = 前一记录的 `digest`;首记录的 `prev` = manifest 的 `genesis_digest`。
- `digest` = sha256(规范 JSON(去掉 `digest` 字段后的本记录))。
- 规范 JSON:键按 code unit 序、无多余空白、UTF-8、拒绝 `NaN`/`Infinity`/
  `-0`/非有限数,整数不带小数点。**规范化是内核的一等契约**——digest 稳定性
  依赖它,故它自身要有性质测试(§5 P0)。

### 1.3 manifest(仅不可变事实)

```json
{
  "store_schema": 1,
  "store_id": "…",
  "genesis_anchor": { "platform": "…", "kind": "git_common|root", "dev": "…", "ino": "…", "birthtime_ns": "…" },
  "genesis_digest": "sha256:…"
}
```

`genesis_anchor` 是碰撞检测的全部依据(设计稿存储层):读取时比对当前位置的
物理锚,不符即判碰撞、拒绝一切写入。**`store_id` 含随机成分,不从锚推导**
——否则复制体会得到不同 id,碰撞反而检不出来(见 FS-01)。

## 2. 分段与容量

- 追加前若 `活动段大小 + 帧长 > SEGMENT_MAX`,先封段:向活动段写入最后一帧
  `kind: "segment_sealed"`,payload 含 `{state_digest, next_segment}`,随后创建
  新段;链跨段延续(新段首帧的 `prev` = 封段帧的 `digest`)。
- `SEGMENT_MAX` 是旧值锚意义上的可调数值(建议 4 MiB),**不是契约**。

**容量储备不存在,因为不需要。** 语料 LK-13 要求"终结动词永远可写";在轮转
模型下这是结构性成立的——store 自身没有总量上限,故不存在"写满导致无法收尾"
的状态。磁盘配额耗尽是环境故障(所有写入一并失败),不在内核语义内。
**这是对 LK-13 的收紧而非放宽**:原场景描述的是储备额度,此处以更强的
"内核不引入任何总量上限"取代。

## 3. 锁

| 类 | 资源 | 用途 |
| --- | --- | --- |
| `store` | store 路径 | 单写者:一切追加 |
| `git_index` | git common dir | receipt 期间的 index 独占(切片 2 消费) |
| `criterion` | loop id | 长判据租约,防两进程重复执行(切片 2 消费) |

规则(LK-01 的不变式,分类集按审计收缩至 3 类):

1. **无重入**:同类嵌套即抛。
2. **`store` 最内**:`git_index → store`、`criterion → store` 允许;反向禁止。
3. **外层类之间不嵌套**:`git_index` 与 `criterion` 不可同持。
4. **两个不同 store 的锁不可同持**。
5. 临界区回调必须同步;返回 Promise 即抛(异步临界区无法保证释放时机)。

`owner.json` = `{lock_class, resource_id, pid, token, acquired_at_ms,
deadline_ms}`。调用方提供的 owner 附加字段**不得覆盖**上述保留键,发布前校验
(LK-03)。收割:持有者 pid 已死**且**超过 `deadline_ms` 才可收割——两个条件
都要,只看 pid 会误杀 pid 复用,只看 deadline 会拖慢正常恢复(WN-05)。

释放失败即**毒化本进程**:此后任何锁获取直接拒绝(含只读观察者),现场文件
保留供人工检查(LK-04)。理由:释放失败意味着我们不知道锁还在不在,继续
获取就是在猜。

## 4. 完整性与恢复

读取时自段 1 起扫描(或自最近合法快照起),逐帧判定:

| 观察 | 判定 | 处置 |
| --- | --- | --- |
| 可用字节 < 8 + 声明 LEN,且位于最后一段末尾 | **不完整写入** | 自动截断,追加 `tail_truncated` 记录 |
| 帧完整但 CRC 不符 | **内容损坏** | 失败关闭,需人工授权 |
| `prev` 与前帧 `digest` 不符 | 链断裂 | 失败关闭 |
| `digest` 重算不符 | 伪造 | 失败关闭 |
| `seq` 非连续 | 空洞 | 失败关闭 |
| 未知 `v` 或 `kind` | 词汇超前 | 失败关闭 + 升级提示 |
| 非最后一段末尾出现不完整帧 | 中段损坏 | 失败关闭 |

### 4.1 对 LK-10 的修订(已确认,语料已回写)

语料 LK-10 要求**一切**撕裂尾部失败关闭,并由人提交双证明后恢复。本规格
把"不完整写入"改为**自动恢复**,理由是推导出来的:

旧世界必须要人,是因为它的帧是 JSON 行,**截断的行与损坏的行在字节上不可
区分**——分不清就只能一律交给人。本设计选了长度前缀帧,这个区分变成机械的:
声明 LEN 而字节不足,只可能是写到一半死了,而**写到一半的记录从未被确认过**
(调用方没拿到返回),丢弃它不丢任何已承诺的事实。要求人工介入等于让每一次
崩溃都需要人,这对"必须能跨崩溃恢复"的运行时是自相矛盾的。

保守边界:**帧完整但 CRC 不符不自动处理**。那种情况无法区分"部分写入"与
"位腐/篡改",而若原写入曾被确认,自动丢弃就是静默丢失已承诺事实。这类仍走
`recover-tail`(双证明 + user 溯源)。

净效果:`recover-tail` 从"每次崩溃都要"降级为"只在真损坏时要"。

## 5. 性质测试

生成器:随机 `(cmd, kind, payload)` 序列,payload 覆盖嵌套对象、数组、
Unicode(含代理对与组合字符)、极端整数、空对象;随机穿插封段边界。

| # | 性质 | 断言 | 对应场景 |
| --- | --- | --- | --- |
| P0 | 规范化稳定 | 同一值任意键序输入 → 同一字节;规范 JSON 往返后仍规范;非有限数与 `-0` 被拒 | — |
| P1 | 重放确定性 | 同一日志重放两次 → 投影深等且投影 digest 相同 | LK-07 |
| P2 | 快照等价 | 快照 + 尾段 ≡ 自 genesis 全量重放 | LK-07/12 |
| P3 | 幂等 | 同 `cmd` 同入参重放 → 第二次零新帧,返回首次结果 | LK-09 |
| P4 | 幂等冲突 | 同 `cmd` 异入参 → 拒绝,日志字节不变 | LK-09 |
| P5 | 链完整 | 任意前缀:`prev` 逐一相接、`digest` 重算相符、`seq` 无洞 | LK-08 |
| P6 | OCC | `expect` 陈旧 → 拒绝且零副作用;`expect` 相符 → 应用 | 设计稿一致性模型 |
| P7 | 单写者 | N 进程并发追加 → 帧无交错、无丢失,`seq` 恰为 1..总数 | LK-02 |
| P8 | 只读零变化 | 读取/重放/查询前后,所有文件字节与 mtime 不变 | LK-11 |
| P9 | 投影可弃 | 删除或写坏快照 → 重放结果不变,且不静默改写坏文件 | LK-12 |
| P10 | 分段等价 | 任意 `SEGMENT_MAX` 下重放结果相同;链跨段相接 | LK-13 |
| P11 | 失败关闭 | §4 表中每一种非法态 → 特定诊断的拒绝,且从不部分应用 | LK-08 |
| P12 | 拒绝原子性 | 任何拒绝路径之后,日志字节与 mtime 与拒绝前逐字节相同 | LK-05 |

P7 用真实子进程,不用线程模拟——锁是文件系统事实,进程内模拟证明不了它。

## 6. 崩溃注入矩阵

追加的执行序列(相位名即注入点名):

```text
lock_acquired → tail_read → idempotence_checked → occ_checked
  → [segment_sealed] → [segment_created] → frames_written → frames_fsynced
  → [snapshot_written] → [snapshot_fsynced] → lock_released
```

| 注入点 | 崩溃后必须成立 |
| --- | --- |
| C1 `occ_checked` 之后、写入之前 | 日志字节不变;命令未应用;原命令重跑应用之 |
| C2 写入中途,k ∈ {1, 3, 4, 8, 8+⌊LEN/2⌋, 8+LEN-1} 字节 | 判为不完整写入 → 自动截断至上一合法帧;命令未应用;原命令重跑应用之 |
| C3 `frames_written` 之后、fsync 之前 | 帧或在或不在,两者皆合法;**绝不允许部分应用**——在则 CRC 必合法且命令视为已应用(重跑幂等空操作),不在则等同 C1 |
| C4 fsync 之后、快照之前 | 命令已应用;快照陈旧;P2 保证重放结果不变 |
| C5 快照写入中途 | 半截快照在读取时自证不合法并被跳过,回退到更早快照或全量重放;结果与 P1 相同 |
| C6 快照完成、锁释放之前 | 锁目录残留;后续进程按 §3 收割规则(pid 已死 **且** 超 deadline)恢复 |
| C7 封段帧已写、新段未建 | 新段缺失不是错误;下次追加建之;链自封段帧延续 |
| C8 新段已建、首帧未写 | 空段合法(零帧);重放跳过 |

实现手段:注入点在内核里是一个显式的 `onPhase(name)` 钩子(仅测试注册),
子进程在钩子里 `process.kill(process.pid, "SIGKILL")` —— **必须真杀进程**,
抛异常模拟不了未 fsync 的页缓存状态。父进程随后独立打开 store 校验上表。

C2 的 k 取值覆盖:长度前缀写了一部分(1、3)、长度前缀恰好写完(4)、
载荷零字节(8)、载荷中途、以及只差最后一个 CRC 字节(8+LEN-1)——最后这个
是最刁钻的一档,它证明判定依据是"字节数不足"而非"末尾看起来像 JSON"。

## 7. 内核 API(领域无关)

```text
createStore({ location, anchor, commandId, kind, payload }) -> Store
openStore(location) -> Store            // 发现 + 完整性 + 锚比对
store.append({ commandId, records, expect? }) -> { seq, digests, replayed: bool }
store.read({ fromSeq? }) -> Record[]
store.replay({ reduce, initial, useSnapshot? }) -> { state, seq }
store.recoverTail({ expectValidEndOffset, expectTailDigest, grantedBy, reason })
store.close()
```

- `append` 是唯一写入口,自身完成锁、幂等、OCC、封段、fsync、快照。
- `reduce(state, record) -> state` 由调用方提供;内核不解释 `kind` 与 `payload`,
  只校验它们**存在且规范**。词汇校验(声明式描述符)属切片 2。
- `expect` 形如 `{ entityId: revision }`,内核只做"调用方声明的 revision 与
  它在重放态里读到的是否一致"这一层比较,实体语义不归内核。

## 8. 非目标(切片 1 内)

领域词汇与描述符校验、循环状态机、criterion、git receipt、图与边、CLI。
内核不认识它们,也不为它们预留字段。

## 9. 修订记录

- 2026-07-25:§4.1 对 LK-10 的修订(不完整写入自动恢复)已确认,语料
  `../scenarios/01-log-kernel.md` 已回写。
- 2026-07-25:§1.1 的校验和由 `crc32c` 更正为 `crc32`(CRC-32/IEEE,
  `node:zlib`)。代码评审发现规格与实现分叉:实现一直用的是内置 `zlib.crc32`。
  裁定改规格而非改实现(理由见 §1.1),并补已知向量测试防止再次静默分叉。
