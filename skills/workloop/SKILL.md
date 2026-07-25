---
name: workloop
description: Drive a goal to a verified finish through the workloop ledger. Use when work must survive across sessions or processes, when several sessions share one repository, or when "done" has to rest on a check the runtime ran itself rather than on an agent's word. Covers opening a loop, writing and trying a criterion, asking for the next legal step, producing receipts, and reading the ledger.
---

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

### 2.1 判据怎么写(这里最容易出错)

判据是运行时唯一的锚。**一个写错的判据,运行时检测不出来**——它能识破的只有
"判据自相矛盾"(末行说的话与自己的退出码打架),识不破"判据一贯地错"。

第一次拿这套东西跑真实仓库时,作者自己的判据就撒了谎:它用正则从测试输出里找
失败,而测试运行器**根本没跑起来**(参数用错),于是零个失败,于是报告 satisfied。
退出码和 verdict 行完全一致,运行时毫无理由怀疑。

所以判据要**朝失败的方向写**:

```js
import { spawnSync } from "node:child_process";
const run = spawnSync(process.execPath, ["--test"], { encoding: "utf8" });
process.stdout.write(run.stdout);

const failures = [...run.stdout.matchAll(/^✖ (.+?) \(\d/gmu)].map((m) => ({ id: m[1].trim() }));

// 关键的一行:检查器本身跑起来了吗?
// 「没找到失败」和「没能去找」是两件事,而只有前者是绿的。
if (run.status !== 0 && failures.length === 0) process.exit(1);   // → indeterminate

console.log("WORKLOOP_VERDICT " + JSON.stringify({
  verdict: failures.length === 0 ? "satisfied" : "unsatisfied", failures,
}));
// exitCode,不是 exit():见下。
process.exitCode = failures.length === 0 ? 4 : 3;
```

三条经验:

- **让"不知道"有专属出口。** 任何非 3 非 4 的退出码都读作 indeterminate,而
  indeterminate 不消耗判重、不累积 stuck——所以宁可退不知道,不要退绿。
- **别只信字符串匹配。** 匹配不到,可能是没有失败,也可能是输出根本不是你以为的
  那个格式。把运行器自己的退出码一并算进去。
- **先让它红一次。** 在开单之前手工跑一遍,确认它对着一个已知坏掉的仓库真的说
  unsatisfied。一个从没红过的判据,和没有判据是一样的。

**完成条件**:见下一节——用 `workloop try` 问,而不是手工核对。

### 2.2 先试跑判据(免费,不进账)

```
workloop try --root <path> --criterion <可执行文件> [--loop <loop_id>]
```

照 `observe` 的方式跑一次:**工作目录设为工作区、同样的超时、同样杀整个进程组、
同样的输出截断窗口**——然后把读出的东西打印出来,**零记录零字节**。

自己手跑一遍判据不是同一回事。手跑用的是你所站的目录、没有超时、留全部输出;
**手跑绿而运行时红,是最难查的那种红。**

不需要账本:判据还在写的时候循环通常还不存在,而那正是最该问的时候。给了
`--loop` 时,它顺便告诉你这是不是那个循环开单时钉住的判据(`loop.matches`)。

**完成条件**:在**尚未修复**的仓库上 `try`,输出里 `verdict` 是 `unsatisfied`、
`failures` 非空、`exit_code` 是 3、`output_truncated` 是 `false`。四条都对上,
这个判据才可以拿去开单。

### 2.3 两种让判据"说了等于没说"的写法

**一、大量输出之后立刻 `process.exit()`。** 写向管道的输出是缓冲的,`exit()` 不等
它排空。实测:一行 125KB 的 verdict,`console.log` 之后立刻 `process.exit(3)`,
运行时只收到 **65536 字节**——verdict 行被从中间切断,读不出来,于是退回退出码。
结果是一轮 `unsatisfied` 而**没有任何可辨识的失败**。

用 `process.exitCode = N` 让进程自然结束,输出才会冲干净。

**二、verdict 行超过 256KB。** 只有末尾 256KB 会被搜索 verdict 行(整份输出仍然
进 digest)。失败清单本来就有界——最多 50 条、每条 id 200 字符,超出的由运行时截断
——所以正常写法碰不到这条;把整份测试输出塞进 `failures` 才会。

两种情形运行时都**降级而不是猜**:读不出 verdict 就退回退出码,说不出可辨识的失败
就让签名为 null,而 null 永远不计入 stuck。**但降级之后你就只剩一个退出码了**,
指令里那份"哪条检查失败了"也跟着空掉。

**完成条件**:`workloop try` 的输出里 `output_truncated` 是 `false`,且 `verdict`
不是 `indeterminate`——运行时替你回答这两条,不用去数字节。

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

### 6.1 账本否认的提交

`status` 里的 `unrecorded_commits` 列出**这个循环造过、而账本没有记下的提交**。
它只会在一种情况下非空:进程死在 git 提交与账本追加之间。那个窗口关不掉——提交
先于任何关于它的记录存在。

**完成条件**:`unrecorded_commits.commits` 为空数组。不为空时,用**它给出的那个
`command_id`** 重跑一次 `receipt`:

```
workloop receipt --loop <loop_id> --mode commit --session <会话> --command <那个 command_id>
```

git 会说无可提交,运行时转而为那个已经存在的提交作证并落账,缺口补上。

`exhausted` 为真表示**没走完**——历史比对账的上限还长。那不是"没有",是"没找完"。

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
