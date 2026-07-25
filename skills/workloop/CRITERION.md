# 写一个判据

判据是运行时唯一的**锚**:agent 说做完了是线索,运行时启动的进程的退出码是事实。
整个循环压在这一个程序上,所以它是最值得多花半小时的地方。

**运行时识不破一个一贯说错的判据。** 它只识破一种:判据自相矛盾——末行说的话与
自己的退出码打架。写对它是你的事,`workloop try` 是你唯一的杠杆。

## 一个能用的形状

```js
import { spawnSync } from "node:child_process";
const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap"], { encoding: "utf8" });
process.stdout.write(run.stdout);

// 钉死你解析的格式,别赌运行环境替你选一个。
const ran = /^# tests \d+/mu.test(run.stdout);
const failures = [...run.stdout.matchAll(/^not ok \d+ - (.+)$/gmu)].map((m) => ({ id: m[1].trim() }));

// 承重的一行:检查器自己跑起来了吗?
// 「没找到失败」和「没能去找」是两件事,而只有前者是绿的。
const verdict = !ran ? "indeterminate" : failures.length === 0 ? "satisfied" : "unsatisfied";

console.log("WORKLOOP_VERDICT " + JSON.stringify({ verdict, failures }));
// exitCode,不是 exit():见「两种说了等于没说的写法」。
process.exitCode = verdict === "satisfied" ? 4 : verdict === "unsatisfied" ? 3 : 1;
```

`4 = satisfied`、`3 = unsatisfied`、**其余一律 indeterminate**。0 与 1 不能是成功
——文件不存在、解释器崩溃、误跑了个 `true` 产生的都是这个区间的码。

## 让它红过

**一个从没红过的判据,和没有判据是一样的。**

作者第一次拿这套东西跑真实仓库时,自己的判据就撒了谎:它用正则从测试输出里找
失败,而测试运行器**根本没跑起来**(参数用错),于是零个失败,于是报告 satisfied。
退出码与 verdict 行完全一致,运行时毫无理由怀疑。

对着**尚未实现的需求**跑一次 `workloop try`,看它说 `unsatisfied` 且 `failures`
点得出名字。那一次红,是这个判据全部可信度的来源。

## 三条经验

- **给"不知道"留专属出口。** indeterminate 不累积 stuck、不参与判重——**失败关闭
  的成本比错报绿低一个量级**。
- **别只信字符串匹配。** 匹配不到,可能是没有失败,也可能是输出根本不是你以为的
  那个格式。把运行器自己的退出码一并算进判断。
- **钉死输出格式。** Node 的 `--test` 在 TTY 与管道下用不同的 reporter;显式
  `--test-reporter=tap` 之后,你解析的东西才是稳定的。

## 两种"说了等于没说"的写法

**一、大量输出之后立刻 `process.exit()`。** 写向管道的输出是缓冲的,`exit()` 不等
它排空。实测:一行 125KB 的 verdict,`console.log` 之后立刻 `process.exit(3)`,
运行时只收到 **65536 字节**——verdict 行被从中间切断,读不出来。

用 `process.exitCode = N` 让进程自然结束,输出才会冲干净。

**二、verdict 行超过 256KB。** 只有末尾 256KB 会被搜索 verdict 行(整份输出仍然
进 digest)。失败清单本来就有界——最多 50 条、每条 id 200 字符,超出的由运行时
截断——所以正常写法碰不到;把整份测试输出塞进 `failures` 才会。

两种情形运行时都失败关闭:读不出 verdict 就退回退出码,说不出可辨识的失败就让
签名为 null。**但降级之后你就只剩一个退出码**,指令里那份"哪条检查失败了"也跟着
空掉——这正是 `try` 要在开单前替你查出来的东西。

## 判据变了,就是换了一把尺子

`workloop amend --criterion <新文件>` 使此前所有轮次**失效**:那些裁决是对另一把
尺子量出来的。失效的轮次仍然计入预算(它们真的花掉了),但不再作为反馈递出去,
也不再累积 stuck。
