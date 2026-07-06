# taskloop — task-first 循环工程(净室 v2 实现)

设计出处:[docs/plans/2026-07-06-loop-v2-task-first.md](../docs/plans/2026-07-06-loop-v2-task-first.md)。
这是那份白纸设计的**独立实现**,与 v1(`bootstrap/` 的 agent-loop 机器)平行
共存:自己的状态目录(`.taskloop/`,gitignored)、自己的结局账
(`~/.taskloop/outcomes.jsonl`)、零共享代码。v1 仍是生产系统;两套的去留由
设计文档里预注册的第二波判别探针裁决,不由偏好裁决。

## 对象模型:Task 是一等公民,Episode 挂在它下面

```
.taskloop/task.json
  goal / criterion(出生即红,输入文件指纹)/ alignment(必填)
  envelope(files/git/destructive/network)
  budget(rounds/writes/wall-clock)→ 挂在任务上,episode 永不重置
  spent + evidence(writes、touched_files——监理观察所得)
  episodes[]:每次连续运行一条,outcome ∈ green|stuck|out_of_budget|needs_input|detached
  state ∈ open|done|not_needed|abandoned
```

与 v1 的语义分野,一句话一条:

- **预算挂任务上**:挂起/换会话/重开 episode 都不重置轮次——v1 的
  "re-init 洗预算"在这个模型里没有对应操作。
- **success 只有一条路**:新鲜的绿判据(stop 闸门或 `done` 动词,都现场跑)。
  不存在任何 claim-based 成功;`not_needed` 要证据,`abandoned` 要理由。
- **挂起是常态中间态**:`needs_input | stuck | out_of_budget` 关闭的是
  episode,任务保持 open;续跑=下一个 episode 直接继续,横幅自动复现
  快照两半(机器半边:touched_files;判断半边:suspend 时的三行)。
- **读永远自由**:envelope 与预算只约束写形调用;超预算的任务永远还能
  验证、挂起、诚实收口。
- **对齐行必填**:`open --alignment` 是一等字段,不是 prose 纪律。
- **无 partitioned 模式**:并行 = 每 worktree 一个 `.taskloop/` + 人做集成
  (设计的"不做"清单)。

## 用法

```bash
node taskloop/bin/taskloop.mjs help          # 动词表
node taskloop/bin/taskloop.mjs open --repo . \
  --goal "……" --criterion "<red-until-done check>" \
  --alignment "green ⇒ goal because …; not covered: …" --files "src/**"
```

Hook 接线(dogfood 用;不随 v1 安装器分发):把 PreToolUse/Stop 指到
`node <repo>/taskloop/bin/taskloop.mjs`,payload 走 stdin——与 v1 hook 协议
相同,可并挂。控制器程序卡在 [programs/](programs/)。

## 担保边界(与 v1 同一信任模型,更少的门)

协作式 fail-open。硬担保只有一条且刻意收窄:**环境健康、状态文件未被直接
改写时,红判据不可能把任务收成 done**——因为写 done 的两条路(stop 闸门、
`done` 动词)都现场跑判据,没有第三条路。两组独立 fresh-context 审计尽力
攻击后确认此不变量成立(报告见本会话记录)。

围绕不变量的**缓解**经审计加固:判据输入文件在绿判时比对指纹,glob 引用的
检查文件也会被展开指纹(不再能靠 `check1.cjs`→`check*.cjs` 一字之差绕过),
无法枚举的多层 glob 标记 `criterion_input_coverage: partial` 并诚实记入
结局账;`done` 红判计入轮次,flaky 判据不能靠免费重试钓假绿;命令级安全门
(远程执行 `curl|sh`、网络、install、secret dump、destructive)在 write-shaped
短路**之前**对所有命令执行,读与验证命令永不受影响。

**明确不防**(威胁模型让步,非缺陷):刻意规避的 agent 直接改 `.taskloop/`
状态;规避性判据(如 `realcheck || test -f skip.txt` 靠新建文件翻绿——done
时判据确实 exit 0,属判据质量问题,由 alignment 与判据幂等性纪律承接);
shell 变量间接绕过(`x=push; git $x`)。安全门是抬高成本的协作式 guardrail,
不是 sandbox。

## 测试

```bash
node --test taskloop/tests/taskloop.test.mjs
```
