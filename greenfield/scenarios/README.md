# 绿地场景语料(spec-before-code)

日期:2026-07-25
地位:绿地重设计的**规格**。按 [greenfield-redesign](../../docs/plans/2026-07-25-greenfield-redesign.md)
的约定,切片 1(日志内核)开工前必须先完成本语料;实现以逐条满足这些场景为完成判据。
来源:旧仓库 `npm test` 门禁 11 个测试文件(2026-07-25 全绿基线 82/82)逐案翻译 +
重设计新增场景。旧实现的代码不搬,只搬它证明过的行为。

## 场景格式

每条场景:

```text
### <族>-<序号> <一句话不变式>
来源:<旧测试文件「case 名」| new: 设计稿 §节>
- 前置:...
- 动作:<新世界动词序列>
- 断言:...
```

状态标注:无标注 = 必须实现;`[defer]` = 对应能力进入后才生效;`[hygiene]` = 旧仓库
的源码文本断言,不翻译,由新仓库自己的等价卫生测试替代。

## 语义不变式与旧世界任意值(2026-07-25 清理)

判据一句话:**把这个具体值换掉,行为契约还成立吗?** 成立 → 它是旧世界任意值;
不成立 → 它本身就是不变式。

**默认规则(全库生效)**:场景中引号或括号里的具体诊断措辞、错误码名、事件
kind 名、routing reason 等枚举 token、CLI 动词与选项名、退出码数值、上限数值,
一律是**旧值锚**——只用于对照旧测试出处与失败形态,新世界可以重定,约束只有
两条:同一语义全库自洽,且机器可判别(测试能断言到它)。

例外用两种行内标注显式声明:

- **〔冻结〕**:token/数值本身就是不变式,改了就破坏契约(多为宿主协议与
  幂等字节语义)。
- **〔新定〕**:绿地新引入、需要在实现首个切片时定版冻结的 token。

真正的语义不变式是**可判别的区分集**,与叫什么名字无关。全库承重的区分集:

| 区分集 | 语义(名字任意,区分必达) |
| --- | --- |
| 不可路由原因 | 碰撞 / 认领挂起 / 范围未认领 / 会话不匹配 / locator 不可用 / 根不可用 / Git 管理不可用 / 锚不匹配——八种原因必须可区分 |
| verdict 三态 | satisfied / unsatisfied / indeterminate——三态必须可区分,承载退出码的具体数值任意 |
| receipt 二态 | clean / uncertain——从不伪造 clean |
| append 提交三值 | 已提交 / 未提交 / 不可知——失败收据必须三值如实 |
| 溯源二值 | user / self——user 独占的动作集(恢复、归档、reattach、fork、export、放弃 placement)是语义 |
| 生命周期 | active / suspended / terminal(achieved·abandoned)——状态集与合法转换是语义 |

已冻结的少数例外(全库):证据通道释放 = **退出码 0 + 空 stdout**(宿主协议:
非零或有 stdout 会改变宿主行为)〔冻结〕;`next` 在状态不变时**逐字节相同输出**
〔冻结〕;判据进程的**只读契约**〔冻结〕。

每个场景文件头部带一行指回本规则。

## 词汇映射(旧 → 新)

| 旧世界 | 新世界 |
| --- | --- |
| authority / authority journal | store / segmented log(账本) |
| task | loop(图的节点) |
| attachment | **Site(现场)**〔审计 M5 改名〕——保留"一 store 多现场"这个 git 性质,去掉 locator 时代的 epoch/claim token/reattach/fork 恢复机制;非 git 场景下 Site 与 Store 一一对应 |
| write claims | claims |
| open / join / suspend / resume / abandon | 同名动词 |
| stage / commit(任务范围 Git receipt) | `receipt`(git receipt 适配器动词) |
| certify(tri-state 一次性裁决) | `observe` 触发 judgment;satisfied → terminal: achieved |
| status / audit / ledger / tasks | status / audit / log / ready |
| hook(nudge/observe/deny) | evidence channel(语义不变) |
| command_id + granted_by + reason | command provenance(语义不变) |
| recover-torn-tail / reattach / fork-identity / export-authority / archive-incompatible-state | recovery 动词族(语义不变,名称待定) |

## 对设计稿的反馈(翻译过程强制出的设计修订)

1. **动词表不完整**:设计稿的 `open · next · observe · amend · suspend · resume ·
   abandon · status · log · ready` 缺少语料承重的 `join`(多会话参与)与
   `receipt`(git receipt 采集),以及 recovery 动词族(torn-tail、reattach、
   fork-identity、export、archive、abandon-placement)。这些在旧语料中各有
   不可丢弃的不变式,已按族收录。
2. **锁分类协议是内核公理的一部分**:旧语料的锁序(见 01 族)不是实现细节,
   是"两个 store 不可同持""同步临界区"这类可测不变式,新内核必须显式继承。
3. **exclusive placement 的 pending intent 需要公开放弃出口**(05 族 WT-08),
   旧世界缺此出口是已定位缺陷,新世界从第一天就有。

## 文件索引

## 审计状态(2026-07-25)

语料已过一轮[第一性推导审计](AUDIT-2026-07-25.md):**59 保留 / 7 改写 /
20 出局**。出局由 8 条机制裁决驱动,其中影响最大的三条是证据通道(hook)、
目标优先路由+locator、exclusive placement 创建。每个场景文件头部带本族处置,
出局场景**原文保留并标注驱动机制**,以便 flip 条件触发时整族恢复。

设计稿 `docs/plans/2026-07-25-greenfield-redesign.md` 有 7 处待改点(见审计
§三),**修订完成前不开工切片 1**。

## 文件索引

| 文件 | 族 | 主要来源 |
| --- | --- | --- |
| `01-log-kernel.md` | LK 日志内核 | authority-transaction、git-main(torn tail/伪造记录) |
| `02-single-loop.md` | SL 单节点循环 | git-task-receipts(certify)、filesystem(certify)+ 设计新增 |
| `03-claims-concurrency.md` | CC claims 与并发 | git-partitioned-multitask |
| `04-receipts-git.md` | GR Git receipt | git-task-receipts |
| `05-worktrees-attachments.md` | WT 工作树与绑定 | git-main、git-linked、git-exclusive、attachment-recovery |
| `06-store-fs.md` | FS 分离文件系统 | filesystem-detached |
| `07-graph.md` | GE 图与边 | new: 设计稿 |
| `08-host-face.md` | HF 宿主面 | hook 用例、provider-installer、skills |
| `09-windows.md` | WN Windows 语义 | windows |
