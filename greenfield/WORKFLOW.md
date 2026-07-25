# 宿主工作流

一个宿主(人、agent、CI)如何驱动一个循环。每一步都有**可判定的完成条件**——
不是"感觉做完了",是一条命令的输出能回答的事。

运行时不主动做任何一步。它只回答"下一步合法的是什么",以及记录回来的结果。

## 前置:这个仓库有账本吗

### 1. 找到或建立 store

```
workloop ready                      # 从当前目录向上找
workloop init --root <path>         # 找不到时,显式建立
```

**完成条件**:`ready` 返回一个 JSON 数组(可以为空)而不是 `NO_STORE_FOUND`。

`init` 从不被自动执行。运行时不会在你恰好站着的地方悄悄开一本账。

## 开一个循环

### 2. 声明目标、范围、判据、证据体制

```
workloop open --goal <目标> --claim <路径> [--claim <路径>...] \
  --criterion <可执行文件> --budget <轮数> --session <会话> \
  --reason <为什么开> --granted-by self|user --receipts none|git \
  [--depends-on <loop_id>[@<认证 digest>]...] --command <命令 id>
```

四件事必须想清楚:

- **claims** 是字面路径,不是模式。它的作用是让两个循环的意图不重叠。
- **criterion** 是运行时**亲自启动**的只读程序。它说了算,不是你说了算。
- **receipts** 决定这个循环凭什么算完成。`git` 要求制品落进提交;`none` 只看判据。
- **depends-on** 一经声明不可更改。换依赖等于换一个循环。

**完成条件**:输出里有 `loop_id`。记下它——后面每条命令都要它。

## 每一轮

### 3. 问下一步

```
workloop next --loop <loop_id> [--root <workspace>]
```

可能的回答与含义:

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

**完成条件**:拿到一个 `decision`。**同样的状态问几次都是同一个答案**,所以崩溃
之后重问是安全的。

### 4. 做事(宿主的,不是运行时的)

运行时**没有任何路径**可以自己执行工作、建 worktree、切分支或绕过审批。谁来做、
是否允许做,全是宿主的事。

**完成条件**:claims 范围内的文件到了你认为该到的状态。这一步没有运行时的输出——
它本来就不该有。

### 5. 出具证据(仅 `--receipts git`)

```
workloop receipt --loop <loop_id> --mode commit --session <会话> --command <命令 id>
```

**完成条件**:输出里 `status` 是 `clean` 或 `uncertain`。

`uncertain` 不是错误,是诚实:index 里有运行时无法归因于本循环的内容,于是它不为
这次操作背书。**它永远不会伪造 `clean`。**

### 6. 提交观测

```
workloop observe --loop <loop_id> --session <会话> \
  --criterion <可执行文件> --command <命令 id>
```

运行时亲自启动判据,读它的退出码与 `WORKLOOP_VERDICT` 行,记录裁决与随之而来的
决策。

**完成条件**:日志里多了一条 `round_observed` 和一条 `round_decided`。用同一个
`--command` 重跑不会再付一次判据的钱,也不会多出一轮。

## 查看与收尾

### 7. 看一个循环的全貌

```
workloop status --loop <loop_id>
workloop log [--loop <loop_id>] [--limit <n>]
```

**完成条件**:`status.next` 与 `workloop next` 逐字相同——它们是同一个函数。
`log` 给的是记录本身,可以和磁盘上的字节对照。

### 8. 留档

```
workloop export > ledger.json
```

**完成条件**:导出物里有 `records` 与 `head_digest`,链可以脱离原 store 独立校验。

**必须事先做。** store 住在它所描述的根里,根被删除,历史随之消失——这是设计显式
接受的取舍,而 `export` 是唯一的对策。事后没有补救手段。
