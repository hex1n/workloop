---
name: workloop
description: workloop drives a goal to a verified finish through an append-only ledger. Use when work must survive across sessions or processes, when several sessions share one repository, or when "done" has to rest on a check the runtime ran itself rather than on an agent's word.
---

# 宿主工作流

一个宿主(人、agent、CI)如何驱动一个循环。**每一步的完成条件都是一条命令的输出**,
而不是一种感觉。

运行时只做两件事:回答下一步合法的是什么,记下你带回来的结果。**工作由你做**——
它没有路径去执行工作、建 worktree、切分支或绕过审批。

它对拿不准的一律**失败关闭**——**绿是唯一绝不会靠意外发生的答案**。你写判据、
读输出时,用同一条尺子。

准备一次(§1–§4),然后**跑到 terminal**(§5)。

## 准备

### 1. 确认运行时在,再找到或建立 store

```
workloop --version                  # 不在 PATH 上,就先装:
                                    #   npm i -g <tarball 路径 或 git+ssh://…#main>
workloop ready                      # 从当前目录向上找
workloop init --root <path>         # 找不到时,显式建立
```

**这一步先做。** 本文只讲怎么驱动运行时,不构成运行时在场的证据。

`init` 只在你打这条命令时发生,而且每个仓库一次。

**完成条件**:`--version` 打出一个版本号,且 `ready` 返回一个 JSON 数组(可以为空)
而不是 `NO_STORE_FOUND`。

### 2. 写判据,让它红

判据是这个循环的**锚**——**写它之前读 [CRITERION.md](CRITERION.md)**,那里讲它为什么
是锚、该长什么样,以及两种"说了等于没说"的写法。

写完立刻问运行时,别手跑:

```
workloop try --root <path> --criterion <可执行文件> [--loop <loop_id>]
```

`try` 照 `observe` 的方式跑一次——**同样的工作目录、超时、进程组、输出窗口**——
然后打印它读出的东西,**零记录零字节,不花预算**。手跑用的是你所站的目录、没有
超时、留全部输出;**手跑绿而运行时红,是最难查的那种红**。

**完成条件**:对着**尚未实现的需求**跑 `try`,输出里 `verdict` 是 `unsatisfied`、
`failures` 点得出名字、`exit_code` 是 3、`output_truncated` 是 `false`。四条都对上
——**这一次红,是这份判据全部可信度的来源**。

### 3. 交给人确认一次

判据由你写,由人确认**一次**,此后钉住。**这是自动驾驶里唯一停下来等人的地方。**

一并给全四样:

1. **它检查什么**——一句话,对着目标。
2. **`try` 的那四项输出**,原样贴出。
3. **不做真正的工作、最省力能让它变绿的办法是什么。** 说不出这一条,说明你还没
   看懂自己写的判据;而人要判的正是这条能不能接受。
4. **它明确不管什么**——判据之外的东西不会因为循环 achieved 就变好。

确认之后这把尺子被钉住:`observe` 比对判据文件的 digest,对不上就
`CRITERION_CHANGED` 拒绝;要换只能 `amend --criterion`,而那在账本里记作
`granted_by: user`,并让此前所有轮次失效。**你无法在人不知情时换掉它。**

**完成条件**:人明确说了可以。**§4 在人点头之后才开始。**

### 4. 开循环

```
workloop open --goal <目标> --claim <路径> [--claim <路径>...] \
  --criterion <可执行文件> --budget <轮数> --session <会话> \
  --reason <为什么开> --granted-by self|user --receipts none|git|fs \
  [--depends-on <loop_id>[@<认证 digest>]...] --command <命令 id>
```

四件事必须想清楚:

- **claims** 是字面路径,不是模式。它的作用是让两个循环的意图**可判定地**不重叠。
- **criterion** 是 §3 里人点过头的那一份。
- **receipts** 决定这个循环凭什么算完成:`git` 要制品落进提交,`fs` 绑一份文件
  digest 集,`none` 只看判据。
- **budget** 是自动驾驶的刹车:轮次用尽,循环挂起而不是无限跑下去。

`depends-on` 一经声明不可更改——换依赖等于换一个循环。

**完成条件**:输出里有 `loop_id`。后面每条命令都要它——**给前缀就行**,像 git;
歧义会被拒绝,不会被猜。

## 驱动

### 5. 跑到 terminal

**这是一个循环,不是一串步骤。** 问一次、做一件事、观测,再问——直到循环终结,
或者它把决定权交回给人。

```
while true:
  d = workloop next --loop <loop_id>
  if d.terminal:                              break        # achieved / abandoned
  if d.decision ∈ {blocked, stuck, suspend}:  停,交给人
  if d.decision ∉ 下表:                        停,交给人
  <做下表说的那一件事>
  workloop observe --command <本轮唯一的 id>                # §5.1
```

**`terminal` 不是唯一的出口。** 一个挂起的循环 `terminal` 是 `false`——它还能被
`resume`。实测:漏掉那两行的驱动器空转了 **423 次**,而运行时每次都以 `NOT_LIVE`
拒绝——账本一条没多,**代价只是时间**。

| `d.decision` | 你做什么 |
| --- | --- |
| `implement` | 照 `d.goal` 做事 → §5.1 观测 |
| `repair` | 读 `d.feedback.failures`(结构化的,不用解析散文),修那几条 → §5.1 |
| `collect_evidence` | 判据没能给出结论:用 `try` 查它、按 CRITERION.md 修好 → §5.1 |
| `produce_receipt` | §5.2 出具证据 → §5.1 |
| `judge` | 证据已就位、还没被判过:直接 §5.1 |
| `blocked` | 上游没完成,做完也认证不了 → **停,把 `d.reason` 交给人** |
| `stuck` | 同一失败重复且制品没动 → **停,把 `d.feedback` 交给人** |
| `suspend` | 预算耗尽或被挂起 → **停,把 `d.reason` 交给人** |
| **不在此表中的** | **停,把 `d` 原样交给人** |

最后一行是这张表的失败关闭:决策的词汇会长(设计里 `review` 就等着 reviewer 出现),
而**一个不认识的指令是"我不知道",不是"没事发生"**。

交回给人不是失败,是循环在说**这一步不该由我决定**——比自己再试一轮诚实。

**`--command` 每一轮都要不同的值。** 同一个 id 拿到的是**重放**——原样返回上次的
结果、不新增记录。自动驾驶复用它,`next` 就会永远返回同一个决策,**循环原地打转**。
轮号或 UUID 都行。

**完成条件**:`next` 返回 `terminal: true`(`achieved` 是达成,`abandoned` 是被人
放弃),或者你在一个交回给人的决策上停下、并把它的原因给了人。

### 5.1 提交观测

```
workloop observe --loop <loop_id> --session <会话> \
  --criterion <可执行文件> --command <本轮唯一的命令 id>
```

运行时亲自启动判据,读它的退出码与 `WORKLOOP_VERDICT` 行,把裁决、失败标识与随之
而来的决策记进同一次事务。

**完成条件**:日志里多了一条 `round_observed` 和一条 `round_decided`。回到 §5 再问
一次。

### 5.2 出具证据(仅 `--receipts git` 或 `fs`)

```
workloop receipt --loop <loop_id> --mode commit --session <会话> --command <命令 id>
```

**完成条件**:输出里 `status` 是 `clean` 或 `uncertain`。

`uncertain` 不是错误,是失败关闭:index 里有运行时无法归因于本循环的内容,于是它
不为这次操作背书。

## 查看与收尾

### 6. 看一个循环的全貌

```
workloop status --loop <loop_id>
workloop log [--loop <loop_id>] [--limit <n>]
```

**完成条件**:`status.next` 与 `workloop next` 逐字相同——它们是同一个函数,所以
问几次都是同一个答案,崩溃之后重问是安全的。`log` 给的是记录本身,可以和磁盘上
的字节对照。

### 6.1 账本否认的提交

`status.unrecorded_commits` 列出**这个循环造过、而账本没有记下的提交**。它只在一种
情况下非空:进程死在 git 提交与账本追加之间。那个窗口关不掉——提交先于任何关于它
的记录存在。

用**它给出的那个 `command_id`** 重跑一次 `receipt`,git 会说无可提交,运行时转而
为那个已存在的提交作证并落账。

**完成条件**:`unrecorded_commits.commits` 为空数组。`exhausted` 为真表示历史比
对账上限还长——那是"没找完",按失败关闭读,不是"没有"。

### 7. 留档

```
workloop export > ledger.json
```

**完成条件**:导出物里有 `records` 与 `head_digest`,链可以脱离原 store 独立校验。

**趁 store 还在时做。** store 住在它所描述的根里,根被删除历史随之消失——这是设计
显式接受的取舍,而 `export` 是唯一的对策。
