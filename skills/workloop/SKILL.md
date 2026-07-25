---
name: workloop
description: workloop drives a goal to a verified finish through an append-only ledger. Use when work must survive across sessions or processes, when several sessions share one repository, or when "done" has to rest on a check the runtime ran itself rather than on an agent's word.
---

# 宿主工作流

一个宿主(人、agent、CI)如何驱动一个循环。**每一步的完成条件都是一条命令的输出**,
而不是一种感觉。

运行时只做两件事:回答下一步合法的是什么,记下你带回来的结果。**工作由你做**——
它没有路径去执行工作、建 worktree、切分支或绕过审批。

它对拿不准的一律**失败关闭**:读不出判据的裁决就退回"不知道",不能归因的证据
就报 `uncertain`,对账没走完就说"没找完"。**绿是唯一绝不会靠意外发生的答案。**
你写判据、读输出时,用同一条尺子。

## 前置

### 1. 找到或建立 store

```
workloop ready                      # 从当前目录向上找
workloop init --root <path>         # 找不到时,显式建立
```

`init` 只在你打这条命令时发生。运行时在你恰好站着的地方开一本账,是它明确不做的事。

**完成条件**:`ready` 返回一个 JSON 数组(可以为空)而不是 `NO_STORE_FOUND`。

### 2. 写判据,并让它红过一次

判据是运行时唯一的**锚**,也是它自己验不了的那一环——**写判据之前读
[CRITERION.md](CRITERION.md)**,它讲形状、退出码约定,以及两种"说了等于没说"的
写法。

写完立刻问运行时,别手跑:

```
workloop try --root <path> --criterion <可执行文件> [--loop <loop_id>]
```

`try` 照 `observe` 的方式跑一次——**同样的工作目录、超时、进程组、输出窗口**——
然后打印它读出的东西,**零记录零字节,不花预算**。手跑用的是你所站的目录、没有
超时、留全部输出;**手跑绿而运行时红,是最难查的那种红**。

**完成条件**:对着**尚未实现的需求**跑 `try`,输出里 `verdict` 是 `unsatisfied`、
`failures` 点得出名字、`exit_code` 是 3、`output_truncated` 是 `false`。四条都对上,
这个判据才可以拿去开单。

## 开一个循环

### 3. 声明目标、范围、判据、证据体制

```
workloop open --goal <目标> --claim <路径> [--claim <路径>...] \
  --criterion <可执行文件> --budget <轮数> --session <会话> \
  --reason <为什么开> --granted-by self|user --receipts none|git|fs \
  [--depends-on <loop_id>[@<认证 digest>]...] --command <命令 id>
```

四件事必须想清楚:

- **claims** 是字面路径,不是模式。它的作用是让两个循环的意图**可判定地**不重叠。
- **criterion** 是运行时亲自启动的只读程序。它说了算,不是你说了算。
- **receipts** 决定这个循环凭什么算完成:`git` 要制品落进提交,`fs` 绑一份文件
  digest 集,`none` 只看判据。
- **depends-on** 一经声明不可更改。换依赖等于换一个循环。

**完成条件**:输出里有 `loop_id`。后面每条命令都要它——**给前缀就行**,像 git;
歧义会被拒绝,不会被猜。

## 每一轮

### 4. 问下一步

```
workloop next --loop <loop_id> [--root <workspace>]
```

| decision | 意思 |
| --- | --- |
| `implement` | 还没有观测,去做事 |
| `repair` | 上一轮失败了,且失败是新的 |
| `collect_evidence` | 判据没能给出结论,先让它能说话 |
| `produce_receipt` | 做了事但没有在场的证据 |
| `judge` | 证据已就位,还没被判过 |
| `blocked` | 依赖未满足,做完也认证不了 |
| `stuck` | 同一个失败反复出现且制品没动 |
| `achieved` / `suspend` | 结束或暂停,附原因 |

`repair` 的 `feedback.failures` 是判据报的那串**结构化**失败标识,不用回去解析散文。

**完成条件**:拿到一个 `decision`。**同样的状态问几次都是同一个答案**,所以崩溃
之后重问是安全的。

### 5. 做事

这一步没有运行时的输出,也不该有。谁来做、是否允许做,全是宿主的事。

**完成条件**:`workloop try` 说 `satisfied`。这是**免费**的——把它当作"我改完了"
的判定,而不是自己看一眼觉得像。

### 6. 出具证据(仅 `--receipts git` 或 `fs`)

```
workloop receipt --loop <loop_id> --mode commit --session <会话> --command <命令 id>
```

**完成条件**:输出里 `status` 是 `clean` 或 `uncertain`。

`uncertain` 不是错误,是失败关闭:index 里有运行时无法归因于本循环的内容,于是它
不为这次操作背书。**伪造一个 `clean` 是它唯一不会做的事。**

### 7. 提交观测

```
workloop observe --loop <loop_id> --session <会话> \
  --criterion <可执行文件> --command <命令 id>
```

运行时亲自启动判据,读它的退出码与 `WORKLOOP_VERDICT` 行,把裁决、失败标识与随之
而来的决策记进同一次事务。

**完成条件**:日志里多了一条 `round_observed` 和一条 `round_decided`。用同一个
`--command` 重跑是**重放**——不会再付一次判据的钱,也不会多出一轮。

## 查看与收尾

### 8. 看一个循环的全貌

```
workloop status --loop <loop_id>
workloop log [--loop <loop_id>] [--limit <n>]
```

**完成条件**:`status.next` 与 `workloop next` 逐字相同——它们是同一个函数。
`log` 给的是记录本身,可以和磁盘上的字节对照。

### 8.1 账本否认的提交

`status.unrecorded_commits` 列出**这个循环造过、而账本没有记下的提交**。它只在一种
情况下非空:进程死在 git 提交与账本追加之间。那个窗口关不掉——提交先于任何关于它
的记录存在。

用**它给出的那个 `command_id`** 重跑一次 `receipt`,git 会说无可提交,运行时转而
为那个已存在的提交作证并落账。

**完成条件**:`unrecorded_commits.commits` 为空数组。`exhausted` 为真表示历史比
对账上限还长——那是"没找完",按失败关闭读,不是"没有"。

### 9. 留档

```
workloop export > ledger.json
```

**完成条件**:导出物里有 `records` 与 `head_digest`,链可以脱离原 store 独立校验。

**趁 store 还在时做。** store 住在它所描述的根里,根被删除历史随之消失——这是设计
显式接受的取舍,而 `export` 是唯一的对策。
