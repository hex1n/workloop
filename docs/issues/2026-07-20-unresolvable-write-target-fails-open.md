# 写目标无法解析时控制面保护静默放行

## 问题摘要

`canonicalWriteTarget`(`lib/supervision.mjs:1638`)把三种语义完全不同的情况
压成同一个返回值 `null`:

1. 目标为空(确实没有写目标)
2. 目标含 shell 元字符 `$`、反引号、glob、`~`(**明知不确定**,由 `pathMeta`
   专门检出)
3. 路径规范化失败

调用点 `controlPlaneWriteFailure:1670` 写作:

```js
const target = canonicalWriteTarget(repo, expanded);
if (target && roots.some((root) => pathInside(target, root))) return "...denied...";
```

`target &&` 把第 2、3 类"我无法确定这个目标是什么"读成了第 1 类"这里没有威胁",
于是**不确定性默认等于安全**。这是三态压二态的类型语义错误,不是某个平台的
特例缺陷。

`~` 之所以能正常拒绝,是因为 1668 行在调用前手工展开了它——一个针对单一形态
的补丁,说明这个洞被撞见过,但只补了一处出口。

## 实际行为(已实证)

```sh
$ git init -q && echo "ORIGINAL" > .git/config
$ bash -c 'echo PWNED > $(echo .git)/config'
$ cat .git/config
PWNED
```

命令替换真实改写了 `.git/config`,而同一条命令经 `controlPlaneWriteFailure`
判定为放行。控制面(`.git/`、`.workloop/`)可被绕过,运行时的全部监督随之失效。

各不确定性形态的实测判定(repo 内 `.git/config` 为目标):

| 命令形态 | 当前判定 | 真实 shell 的写入结果 |
|---|---|---|
| `echo x > .git/config` | DENY | 命中 |
| `echo x > <绝对路径,正斜杠>` | DENY | 命中 |
| `echo x > "<绝对路径,反斜杠>"` | DENY | 命中 |
| `echo x > <绝对路径,反斜杠未加引号>` | **放行** | 写不到(POSIX 吃掉反斜杠) |
| `echo x > $HOME/.git/config` | **放行** | **命中主目录 git 配置** |
| `echo x > .git/con*` | **放行** | glob 展开后命中 |
| `echo x > $(echo .git)/config` | **放行** | **命中** |
| ``echo x > `echo .git`/config`` | **放行** | **命中** |
| `echo x > ~/.workloop/outcomes.jsonl` | DENY | 命中 |

`analysis.resolution`、`analysis.local.destinations.resolved` 在以上**全部**
场景均为 `resolved` / `true`,即现有的置信度标志没有任何区分能力。

## 与 Windows 测试失败的关系

`tests/workloop.test.mjs:1182`(session-scoped PreToolUse)在 Windows 上失败,
就是本问题的一个下游症状:未加引号的 Windows 绝对路径被 POSIX 词法吃掉反斜杠,
目标变成 `C:UsershexinAppData...`,不再匹配保护根。

该症状本身**无害**(真实 Git Bash 同样写不到目标),真正可利用的是变量展开与
命令替换两类。Linux/macOS 不触发该症状是因为 `path.join` 产出正斜杠,但这两个
平台**同样**存在变量展开与命令替换的绕过。

在 `windows.test.mjs:89` 的陈旧断言修复前,Windows CI 在 workflow 第 63 步即
失败,行为套件(第 129 步)从未被执行,因此该失败从未在 CI 暴露。

## 建议方案:按不确定性分级 fail-closed

不能对所有 unresolvable 一律拒绝——那会毙掉 `echo x > $HOME/notes.txt`、
`cp file $DEST/` 等日常命令,误报会使工具不可用。分级:

| 不确定性 | 形态 | 处置 |
|---|---|---|
| 完全不可知 | 写目标位置出现 `$(...)` / 反引号 | 无条件拒绝(目标由运行时决定,静态分析无法给出任何保证) |
| 部分可知 | `$HOME/.git/config`、`.git/con*` | raw 含 `.git` / `.workloop` 字面量则拒绝 |
| 可知 | 其余 | 维持现有精确判定 |

设计要点:fail-closed 的范围限定在"命令自身提到了控制面",而非"命令存在任何
不确定性",使误报面收缩到接近零,同时覆盖上表全部已证实的绕过——包括顺带修复
Windows 那条测试。

拒绝措辞复用既有的 "resolve the write target"(`workloop.test.mjs:1197/1198`
已断言该 fragment),将 hook 接口变更压到最小。

## 未验证事项(执行前必须先查)

`canonicalWriteTarget` 另有 6 个调用点未逐一核查是否存在同样的 `target &&`
fail-open 模式:`lib/supervision.mjs` 的 1520、1539、1902、1939、1950、2004。
若它们同样漏,则属同一个洞的其他出口,方案范围需相应扩大。

## 备选方案

`canonicalWriteTarget` 全量三态化(返回 `{resolved} | {unresolvable} | null`,
7 个调用点全改)。类型语义最干净、根治最彻底,但改动面大且误报显著上升。改名已于
2026-07-20 落地,此项可独立评估。
