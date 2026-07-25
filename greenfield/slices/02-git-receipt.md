# 切片 2(下半):git receipt 规格书

日期:2026-07-25
状态:规格先行。本文在实现之前写定,兑现 [02-single-loop](02-single-loop.md) §6
挂的账:**GR 全族未做,是切片 2 完成判据的另一半**。

上承:[GR 族场景](../scenarios/04-receipts-git.md)(7 条,审计全数保留)、
[设计稿「claims 与 receipt 的关系」](../../docs/plans/2026-07-25-greenfield-redesign.md)。
完成判据:GR-01 … GR-07 全绿,且 SL 族不回归。

## 1. 出发点:现状违反公理 2

当前 `observe` 接受调用方传入的 `receiptDigest`,既不计算也不校验。设计公理 2 是:

> 进入判断的只有**运行时亲自观测**的事实(退出码、digest、commit oid),
> agent 的话永远只是线索。

调用方递来的一个 digest 恰好就是"agent 的话"。判据这一侧已经守住了(运行时亲自
spawn、亲自读退出码),receipt 这一侧还敞着——而认证一个循环 achieved 的两条腿
正是这两个。**本切片把第二条腿接上:receipt 由运行时自己产生并自己复核。**

于是有一处破坏性变更:`observe` 不再接受 `receiptDigest` 参数。

## 2. receipt 是什么

一次运行时亲自执行的 git 操作,加上它对结果的诚实记录。两种模式、两种状态:

| 模式 | 做什么 |
| --- | --- |
| `stage` | 把 claims 内的路径加入 index |
| `commit` | 把 claims 内的路径提交,**保留 index 里其他条目** |

| 状态 | 含义 |
| --- | --- |
| `clean` | 操作时刻,index 与提交范围内**只有**本循环 claims 内的内容 |
| `uncertain` | 出现了运行时无法归因于本循环的内容 |

**二态而非三态,是世界的性质不是设计选择**:运行时不拥有 git index。宿主、用户、
编辑器插件、另一个 agent 随时可以动它,运行时既拦不住也无法回溯。因此它只有两种
诚实答案——"我确认干净"和"我不确认"。

**`clean` 是绝不能靠意外发生的答案**(与判据的 `satisfied` 同一条原则)。任何
一点无法归因的内容都退化为 `uncertain`,永不伪造 clean。

## 3. 宿主优先:receipt 退化,但不失败宿主操作

GR-03、GR-04 的共同断言:外部内容存在时,stage/commit **仍然成功**,只是 receipt
退化为 uncertain。理由:运行时不是审批者(设计稿「宿主契约」),它没有立场因为
index 里有别人的东西就拒绝宿主的操作;它的立场只是**不为这次操作背书**。

区分两件事:

- **有外来内容** → 操作照做,receipt `uncertain`。
- **git 本身失败**(不是仓库、路径冲突、提交为空)→ 拒绝并诊断(公理 3 失败即关闭)。
  没有产生 receipt 与产生一个假 receipt 是不同的事。

## 4. 任务范围隔离

### 4.1 机制(已验证)

```
stage:  git add                       -- <claims> :(exclude)<控制面>
commit: git add + git commit --only   -- <claims> :(exclude)<控制面>
```

**两种模式都先做那次任务范围的 `add`**〔实现期修订〕。`--only` 只认 git 已知的
文件,pathspec 匹配不到任何已跟踪文件时直接报错退出——于是"本轮新建的文件"这个
最常见的情形会拿不到 commit receipt。实测:全新 `src/a.txt` 上 `git commit --only
-- src` 报 `pathspec 'src' did not match any file(s) known to git`。

先 add 还有第二个好处:**决定"任务的路径"是什么的,就是那一次 add**,两种模式
因此对范围的含义完全一致。GR-01/GR-03 不受影响——add 带着同样的 claims 与排除
pathspec,外来内容既不会被它加入,也不会被 `--only` 带走(已测)。

`--only` 是给定路径时 `git commit` 的默认模式:只提交命名路径,**其余 index 条目
原样留着**。这正是 GR-01 的断言。已实测确认:外部 `git add docs/b.txt` 后,
`git commit --only -- src` 只提交 `src/a.txt`,`docs/b.txt` 提交后仍在 index。

**`--only` 取的是工作树内容,不是 index 内容**(已实测)。因此 stage 之后工作树
又变了再 commit,提交的是较新的那份。这不是缺陷——receipt 记录的是**它实际提交了
什么**,而 GR-02 要求的因果绑定是 HEAD 层面的(`prior_head == parent_oid`),
不是内容层面的。

### 4.2 控制面永不入 receipt(GR-05)

`.git` 与**账本自身的目录**始终排除。理由是直接的:账本可以
就放在仓库里,而一个 `.` 的 claim 会把账本自己 stage 进去——**循环把记录自己的
账本提交进被记录的仓库**,是一个自指的荒谬。已实测确认排除 pathspec 生效,账本
在 `.` claim 下保持 untracked。

排除**只对写操作用 pathspec**(`add`/`commit` 会动手,事后过滤来不及);读命令
在代码里过滤〔实现期修订〕——`git ls-tree` 明确拒绝 exclude magic
(`pathspec magic not supported by this command`),而 receipt 的正确性不该取决于
哪个 git 子命令支持哪种 pathspec 语法。

场景 GR-05 原文还提到"不兼容归档目录"。**该目录随审计 M8 出局,已不存在**;
GR-05 保留的语义不变式是"运行时的控制面路径永不进入 receipt",归档目录只是旧世界
的一个具体实例(语料 README 的旧值锚规则)。

## 5. 证据体制在开单时声明

`open` 新增必填字段 `receipts: "none" | "git"`。**不设默认值。**

理由:这决定了这个循环凭什么算 achieved。非 git 宿主是一等公民(设计稿「宿主
中立」),而"要不要 git 证据"是**认证标准**——认证标准不能是隐式的。

反面的做法是运行时自己探测工作区是不是 git 仓库。那会让循环的认证标准随着有人
在中途 `git init` 而改变,而这个改变不会留下任何记录。

## 6. 认证:receipt 必须仍然描述现实(GR-06 / GR-07)

`receipts: "git"` 的循环,判据 satisfied **不足以** achieved。还要求在场的
commit receipt 同时满足:

1. `status == clean`
2. receipt 的 commit 仍是 **HEAD 的祖先**(GR-06)——被 reset/rebase 掉的提交
   不能再支撑认证
3. **任务路径**自该 commit 以来没有漂移(GR-07)

### 6.1 漂移的四种,以及为什么是四种

| 漂移 | 检测 | 出处 |
| --- | --- | --- |
| 后续提交 | `git diff --name-only <receipt> HEAD -- <claims>` | GR-07 |
| 未暂存 | `git diff --name-only -- <claims>` | GR-07 |
| 已暂存 | `git diff --cached --name-only -- <claims>` | GR-07 |
| 未跟踪 | `git ls-files --others --exclude-standard -- <claims>` | **推导** |

前三种来自场景。第四种是推导的,理由与前三种同一条:**receipt 必须仍然描述任务
路径的全部内容**。一个 claim 目录下新出现的未跟踪文件,是判据跑过、但 receipt
没有覆盖的内容——认证这个 commit 等于认证一份没被测过的东西。而 `touch src/new.mjs`
就能到达,不是边角情形。`--exclude-standard` 让 `.gitignore` 里的构建产物不算数
(已实测)。

四种检测全部带 `-- <claims>`:**非任务路径的漂移不影响本循环**(GR-07 末句,
引 SL-07)。这也是 claims 在绿地被保留的那个唯一理由的兑现。

### 6.2 漂移了怎么办:不在场,而不是抛弃这一轮

场景措辞是"judgment 一律拒绝"。直译会是让 `observe` 抛错——但判据此时**已经跑完
了**,抛错等于把一次真实的观测连同它的代价一起丢掉。

裁决:**漂移的 receipt 不在场(not in force),该轮 `receipt_digest` 记为 null**,
于是策略表里 satisfied 不再走向 achieved,而走向 `produce_receipt`。认证被拒绝的
效果完全相同,而观测这个事实被保留了下来。

为了让读日志的人能区分"从未产生过 receipt"和"产生过但漂移了",观测记录增加
`receipt_state` 字段:`none | in_force | drifted | unlanded | uncertain`。
`receipt_digest: null` 单独一个字段说不出这两者的差别,而这两者对排查的人是
完全不同的处境。

## 7. 记录形状

新 kind `loop_receipt`:

```
mode         enum stage|commit
status       enum clean|uncertain
reasons      strings   为什么 uncertain,有界
paths        strings   实际纳入的任务路径(仓库相对)
head_before  string|null  操作前的 HEAD
commit_oid   string|null  commit 模式的产物
parent_oid   string|null
tree_digest  digest    操作后任务路径的 [路径, blob oid] 摘要
recorded_by  string
```

轮次绑定的是**这条 receipt 记录自身的链上 digest**,不是 payload 的某个字段——
实体之间只经内容寻址耦合(公理 5)。

## 8. 锁

receipt 在 `git_index` 锁内执行,账本追加在 `store` 锁内。锁类全序已声明为
**store 最内**,所以顺序是 git_index → store,与切片 1 定的一致。

判据在锁外跑(它可能几分钟);git 操作在锁内跑(它是毫秒级,而 index 是真正的
共享可变状态)。

## 9. 不做

- **merge / rebase / 冲突处理**:receipt 只记录,不解决。冲突是宿主的事。
- **push / 远端**:运行时没有任何对外副作用的路径(设计稿「宿主契约」)。
- **多仓库、submodule**:一个循环一个工作区。
- **stash**:动别人的工作树是执行,不是观测。

## 10. 修订记录

- 2026-07-25:本文写定于实现之前。四条 git 机制(exclude pathspec、`--only` 保留
  index、`--only` 取工作树内容、四种漂移检测 + 祖先检查)在写规格前已实测。
- 2026-07-25(实现后):两处机制修订,均由实现期的红测试逼出来,已就地标注
  〔实现期修订〕——commit 模式先做任务范围 add;读命令的排除改为代码内过滤。
  GR-01 … GR-07 全绿(`tests/receipt.test.mjs`,11 项)。
  **非空验证**:逐条摘除机制后重跑,漂移检测(untracked)、祖先检查、控制面排除、
  `--only`、认证守卫各自都有测试变红(依次 1、1、1、9、2 项),没有一条是绿得
  毫无意义的。
