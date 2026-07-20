# open 判据 indeterminate 时提交 task_opened 却拒绝投影，仓库无 CLI 出路

## 问题摘要

`open` 在判据观察为 `indeterminate` 时报 "task not opened",但 `task_opened`
事件**已经提交进 `.workloop/events.jsonl`**。此后每一条读取路径都要重放这条
事件,而 `lib/task-engine.mjs:420` 无条件抛出:

```js
if (facts.observation.verdict === "indeterminate") throw new Error("criterion indeterminate; task not opened");
```

于是仓库进入一个**没有任何 CLI 动作能离开**的状态:消息说任务没开,账本说
开了,两者都不肯让步。

这不是"判据写错了"的用户错误——判据写错是**触发条件**,不是问题本身。问题是
一次失败的 `open` 会留下不可撤销的持久化后果。

## 触发条件(极常见)

任何在 open 时产生 `indeterminate` 的判据都可触发。`indeterminate` 的来源见
`lib/criterion.mjs:117-127`,包括:

- 判据命令不存在(拼写错误、缺解释器、PATH 问题)
- 把 shell 内建当命令用,例如 `--criterion "exit 3"`(`exit` 无可执行文件,
  spawn 直接失败)
- tri-state 适配器返回约定外的退出码(`invalid_adapter_exit`)
- 适配器退出 0 但没给判定(`adapter_silent`)
- 判据超时或崩溃

本次验证中**连续两次意外触发**,均属第一、二类。

## 实际行为(已实证)

最小复现,源码树 HEAD,非安装产物:

```sh
$ git init -q repro && cd repro && git commit -q --allow-empty -m init
$ node bin/workloop.mjs open --repo . --goal g \
    --criterion "definitely-not-a-real-command" --criterion-policy default \
    --alignment-because b --files '*' --reason r
workloop: criterion indeterminate; task not opened

$ node bin/workloop.mjs status --repo .
workloop: criterion indeterminate; task not opened
```

此时 `.workloop/events.jsonl` 有 1 条**格式合法**的 `task_opened` 记录,
而 `task.json` 从未写出(投影在写快照前就抛了)。

各出路均被堵死:

| 动作 | 结果 |
| --- | --- |
| 重新 `open` | `criterion indeterminate; task not opened` |
| `abandon` | `criterion indeterminate; task not opened` |
| `status` | `criterion indeterminate; task not opened` |
| `audit` | `valid: false`,`EVENT_STORE_AUDIT_FAILED`,同一消息 |
| `archive-incompatible-state --granted-by user` | `ENOENT ... .workloop/task.json` |

`archive-incompatible-state` 是文档里的兜底逃生口,但它以 `task.json` 为操作
对象(`lib/task-store.mjs:220`),而这条路径下快照根本不存在,所以兜底失效。

Stop 门的表现按 profile 分裂:

```
claude    : {"decision":"block","reason":"workloop: task state unavailable (criterion indeterminate; task not opened); refusing to adjudicate Stop"}
codex-safe : (空,放行)
```

即 Claude 宿主下该仓库的**每个会话都无法结束**;codex-safe 因其绝不硬阻塞的
契约而幸免,但 `status`/`abandon`/`open` 对所有 profile 一律不可用。

唯一实际逃生方式是绕过 CLI 手工删除 `.workloop/events.jsonl`——即要求用户
手工破坏审计账本,这与运行时"账本是权威"的立场直接冲突。

## 预期行为

二者取一,均可接受,但必须成立其一:

1. **open 失败即无副作用。** 判据 indeterminate 时不提交 `task_opened`,
   消息 "task not opened" 与持久化状态一致。这是最小改动,也最符合该消息的
   字面承诺。
2. **提交了就必须可操作。** 若保留事件(为留存"曾尝试开启"的证据),则
   indeterminate 的任务必须能被投影成某种可读状态,并至少允许 `abandon`
   和重新 `open`。

现状是两者皆非:既提交了事件,又拒绝投影它。

## 不要求

- 不要求运行时替用户判断 indeterminate 判据的意图。
- 不要求放宽 Stop 门在**真正**不可读状态下的 fail-closed 立场;本问题的
  状态是可读的,只是投影器主动拒绝了它。
- 不要求为此新增逃生 verb,若采纳方案 1 则不需要。

## 发现路径

2026-07-20 执行改名方案完成判据 3(`WORKLOOP_INSTALL_HOME` 临时家安装验证)
时,构造探针任务连续两次误写判据而撞上,遂就地最小化复现。与改名本身无关,
属既有缺陷。
