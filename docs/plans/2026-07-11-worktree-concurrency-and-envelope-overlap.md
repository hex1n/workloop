# taskloop 并发归属修正 + 跨 worktree envelope 重叠发现左移

**类型**: 设计方案(只出方案,未实现)
**日期**: 2026-07-11
**触发**: 实测中两个 session 共享同一 worktree,Stop hook 按 worktree 定界导致旁观 session 的回合去裁决/被诱导驱动另一个 session 的任务;并延伸到跨 worktree envelope 重叠的晚发现问题
**依据**: `lib/task-engine.mjs`(`ensureEpisode`)/`lib/application.mjs`(`hookStop`/`hookPretool`/`cmdOpen`/`cmdAmend`)/`lib/supervision.mjs`(`envelopeDirty`/`insideEnvelope`/`currentRepoFiles`)机制实读 + 第一性原理分析 + Codex fresh-context 只读评审
**推导轮次**: 第一性根问题拆解 → worktree 模型校准 → "不要人分树"边界 → envelope 登记左移 Alt A/B 对比 → Codex 新线程评审(修正两处 + 重排优先级)

---

## 根问题

taskloop 的**写隔离**在物理上只能是 worktree 级(同一棵树里对 `foo.js` 的写就是那一个 `foo.js`),这是真约束。但两个作用域被合并了:

| 作用域 | 正确单位 | 现状 |
|---|---|---|
| 写隔离(envelope) | worktree(物理约束) | worktree ✓ |
| 回合裁决(该不该 hold 这次 stop / 该由谁驱动) | session(谁在驱动这个任务) | worktree ✗ ← 缺口 |

两者都用 worktree,于是一个纯旁观、与任务无关的 session,回合结束被别人的任务 hold 住,还被单-session 假设写的判据消息(如 earn-red 红目击)诱去驱动别人的任务——从噪音升级成正确性/安全问题。

结构性解是 taskloop 文档已有的模型:**一个 worktree 一个写者任务;并行用独立 git worktree(各带自己的 `.taskloop/`);一个 integrator session 负责跨 worktree 的 git 合并**——因为 worktree 隔离工作树但共享 `.git`(object store/refs),集成分支是单一可变目标需串行。本方案在此模型下补两层诊断/归属,不改写隔离的物理边界,也不改判据裁决。

---

## 贯穿三层的不变量

fail-open;advisory 不设闸门;drive-gate 分离;git 需 `--git-allowed`;缺字段不伪造;每片 born-red 先行。以下全部只加**归属/诊断**。

---

## P0(必做)跨 session Stop/PreToolUse 归属 —— 根因

**现状 bug**(`ensureEpisode`, lib/task-engine.mjs):活跃 episode 的 `session` ≠ 当前 hook 的 session 时,**无条件** `closeEpisode(…, "detached")` 并接管,随后对当前 worktree 跑判据。这是旁观者被 hold + 被诱导驱动的直接根因。

**改法 —— 显式交接优先,TTL 只当"主人消失"的逃生口**(对齐 taskloop"显式胜过推断",与撤回自动 drift 分类器同一立场):

1. 给活跃 episode 加租约:已有 `session` + 新增 `last_seen_at`,**每次 owner 的 hook 触碰刷新**。
2. 外来 session 的 hook(session ≠ 活跃 episode owner)分三路:
   - **任务已 suspend** → 干净交接,`resume` 路径照旧(文档既有的交接方式);
   - **租约陈旧**(`now - last_seen_at ≥ TTL`,owner 大概率已消失/崩溃)→ 允许接管(current 行为),作为逃生口;
   - **租约新鲜 + 未 suspend** → **bystander**,不接管、不裁决别人的任务:
     - `hookStop`:release(return 0)+ advisory:"另一活跃 session 持有本 worktree 的任务;这是单写者争用——去开独立 worktree,或让 owner 先 suspend 再交接",**替换掉误导的判据消息**;
     - `hookPretool`:把该写**走无任务/untracked 路径**(owner 的 envelope 不治理外来 session),同一条 advisory。coherent:owner 的写边界只约束 owner。
3. TTL = 并发窗口的显式化(可调,默认保守如 5 分钟);全程 advisory,双向误判都便宜,TTL 只兜"主人崩溃"这一窄口。
4. **范围**:lib/task-engine.mjs(`ensureEpisode` 归属 + 租约刷新)、lib/application.mjs(`hookStop`/`hookPretool` 归属分路)、hook 测试。
5. **born-red 复现器**(双 session 交替):① 新鲜外来 Stop 被 release+advisory,不接管、不烧 owner 的轮;② suspend 后外来 resume 正常接管;③ 陈旧租约允许接管;④ 外来 PreToolUse 走 untracked 路径、不套 owner envelope。

---

## P1(值得做)兄弟 worktree envelope 重叠 advisory —— Alt B + Codex 修正

**为什么 Alt B(查兄弟 task.json)胜过 Alt A(ledger 登记表)**:envelope 已完整写入 `task.envelope.files`(lib/task-engine.mjs `createTask`),`task.json` 用临时文件+rename 是当前 worktree 的**权威快照**(lib/task-store.mjs);ledger 是 per-HOME、会被 sandbox/异 HOME 打洞的历史遥测(实测 README 任务丢了全部 ledger 行),且需 schema 改动 + 历史归约。但 Codex 修正:sibling `task.json` **不是原子注册表**,而是分布式快照集合——双方同时 open 会双漏报,陈旧 open 会假阳性;对 advisory telemetry 可接受。

**改法**:`cmdOpen` **和** `cmdAmend --files`(Codex:只在 open 查会漏后续扩边)时:

1. `git worktree list --porcelain` 枚举兄弟 worktree,读各自 `<wt>/.taskloop/task.json`;
2. 条件 `state === "open"`(**Codex 修正**:`suspend` 不改 `state`,仍为 `"open"` 另加 `task.suspension`,故这一条已涵盖活跃+挂起,不必区分 open/suspended),跳过自身路径;
3. 与新 envelope 比对,**两级重叠**降告警疲劳:
   - **明确重叠**:当前仓库确有 `git ls-files` 文件同时匹配双方 glob(复用 `currentRepoFiles` + `insideEnvelope`)→ 强提示;
   - **潜在重叠**:仅静态前缀相容(取首个 `*`/`?` 前的**字符前缀**,非目录段,严格对齐 lib/prims.mjs `globToRegExp` 语义)→ 弱提示。`src/*.js` vs `src/*.md` 只算潜在且明确级查无同匹配文件 → 不误报;
4. 消息**可操作**(Codex):列出兄弟 worktree 路径、那边的任务、双方**具体冲突 pattern**;
5. advisory-only、fail-open:非 git/单 worktree/读失败 → **静默跳过**(对齐 `envelopeDirty` 异常退化);**不做** merge-base/branch reachability 过滤(Codex:声明空间相交不需要,过滤会漏掉之后才决定合并的任务);
6. **范围**:lib/supervision.mjs(只读 worktree 枚举 + 两级重叠分析)、lib/application.mjs(接入 `cmdOpen`/`cmdAmend`)、测试。
7. **born-red 复现器**(两 worktree):① 同匹配文件→明确重叠告警;② 仅前缀相容无同匹配→潜在级/或不报;③ 不相交→静默;④ 单 worktree/非 git→静默;⑤ `amend --files` 新增重叠也报。

---

## P2(可选)陈旧性上下文 + 审计

- 消息附 opened time / suspended 状态,**不擅自判 inactive**(只给上下文,人判断);
- overlap warning 记 ledger **仅在确有审计需求后**再做,且作可丢失 telemetry,不参与在线发现、不 gating。

---

## 排序与风险

- **P0 先于 P1**:P0 修的是用户实际撞上的 bystander 假 hold + 被诱导驱动(正确性/安全);P1 只降多 worktree 流程的晚发现成本(便利)。
- **P0 唯一实质抉择**:TTL 的值。无法完美(纯 TTL 是活性代理,一个真闲置超 TTL 却仍活的 session 会被误判为可接管);但全程 advisory + 显式交接优先,TTL 只兜"主人崩溃"窄口,风险有界。
- **P1 诚实边界**:ledger 打洞不影响 P1(读 task.json 不读 ledger);sibling task.json 非原子注册表,双方同时 open 双漏报,对 advisory 可接受。
- **YAGNI 检查**:P1 只对"真跑并行 worktree"有收益。并发少则 P1 可推迟,先落 P0。

---

## 拒绝清单(及理由)

- **session 化写隔离/闸门**(只 hold 任务主人、放行旁观写)→ 否决:写隔离仍 worktree 级,放行旁观写=让第二写者自由污染树,作用域劈裂不自洽。
- **纯 TTL 自动接管**(无显式交接)→ 降级为逃生口:优先 suspend/resume 显式交接,TTL 只兜主人消失。
- **taskloop 自动建 worktree**→ 否决:门≠驱动器,且无授权动 git;自动化隔离属启动器/驱动器层,且应按 session 分一次(不是每任务),因为并发单位是 session。
- **envelope 登记进 ledger(Alt A)**→ 输给 Alt B:登记表已分布式存在于各 worktree task.json,ledger 会打洞且需 schema 改动。
- **overlap 当闸门**→ 否决:声明空间相交只是冲突预警,合不合、怎么合是 integrator 的判断,advisory 不 gating。

---

## 落地切片

- **切片 P0** = 跨 session 归属 + 租约(根因,自足):hook 路径 + `ensureEpisode` + hook 测试。先落。
- **切片 P1** = 兄弟 worktree 重叠 advisory:supervision 枚举/两级重叠 + 接入 open/amend + 测试。依"多 worktree 是否常态"决定是否紧随。
- **切片 P2** = 陈旧性上下文 + 可选审计。

## P0 落地记录(2026-07-11)

在独立 worktree(分支 `p0-cross-session-attribution`,基线 commit `4bbcc51`=暂存快照,`main` 保持 `17746a6` 不动)落地并提交 `4ee4827`。`npm test` 47/45/0/2skip。

**实现**:`episodeOwnership(task,session,nowMs,ttlMs)`(owner/handoff/bystander)+ 毫秒精度租约 `last_seen_ms`(`TASKLOOP_LEASE_TTL_MS` 可调,默认 5min);`hookStop`/`hookPretool` 在 begin-episode 前判归属,bystander 短路(Stop 释放、写不套 owner envelope);suspended 任务在 dispatch 层统一处理(读自由、写拒、Stop 释放,**零 episode 变更**)。

**Codex 评审(CONDITIONAL-GO,fresh 线程)**,已处置:
- **blocker(已修)**:`hookPretool` 原本先 begin-episode 再查 suspension,导致 suspended 时外来读也 detach owner。改为 dispatch 层 `suspendedHookOutcome` 在归属/begin-episode 之前拦截,读写皆不动 episode。
- **#2 时间精度(已修)**:租约改毫秒 `last_seen_ms`,消除 utcNow 秒截断导致的最多 ~999ms 提前过期;未来时钟偏移下负龄 < ttl,保守保留 owner。
- **#6 断言(已修)**:token 测试 suspended 行断言 `>=1`→`===1`;毫秒租约使 TTL=1 测试确定不再靠秒截断。
- **#5 first-touch(已文档化+测试)**:`open` 不记 session,首个 hook 得 owner——加了显式回归测试。
- **#3 bystander 跳过安全检查(策略明示)**:bystander 是外来 session,其 envelope/预算/git 授权/命令安全属于**它自己 worktree 的任务**,taskloop 是协作式 fail-open 非 sandbox,故不代管——代码注释显式声明此策略。
- **新增回归**:suspended owner/foreign 的 Stop/读/写三态 episode 不变性;first-touch 归属。

**延后(Codex should-fix/concern,非 GO 阻断)**:
- **#8 归属判定与持久化非原子**:每个 hook 独立 load→save,并发首触/陈旧租约可能双方都自认 owner、last-writer-wins——这是 hook 模型固有(所有 hook 皆然,非 P0 引入),留待整体 hook 并发加固。
- **#4 resume 清 suspension 不建 episode**:回到 first-touch 语义(resumer 下一个 hook 得 owner),已由 first-touch 测试覆盖其行为。

**待整合**:p0 分支 = 基线快照 + P0;`main` 的 slice4/5 与并发工作仍未提交,合并回 main 是 integrator 的活。

## P1 落地记录(2026-07-11)

在独立 worktree(分支 `p1-worktree-envelope-overlap`,栈在 P0 尖端 `4ee4827` 上)落地并提交 `b1873e2`。`npm test` 55/53/0/2skip。栈式历史:基线 `4bbcc51` → P0 `4ee4827` → P1 `b1873e2`;`main` 仍 `17746a6`。

**实现**:`siblingWorktreeOpenTasks(repo)`(`git worktree list --porcelain -z` 枚举、读兄弟权威 task.json、`state==="open"`、realpath 跳过自身/别名);`envelopeOverlap(new, other, repo, otherPath)` 两级(definite=文件在**两个** worktree 都存在且同时匹配双方 glob;potential=前缀+后缀启发式可能共匹配);`warnSiblingEnvelopeOverlap` 接入 `cmdOpen` 与 `cmdAmend --files`,advisory/fail-open/静默降级。

**Codex 评审(CONDITIONAL-GO,fresh 线程,第二次重跑才出结论——第一次卡死)**,已处置:
- **BUG(已修)**:definite 只枚举当前 worktree 的 `currentRepoFiles`,会误判兄弟已删文件、漏兄弟独有文件。改为 definite 候选须在**兄弟 worktree 也 `existsSync`**;兄弟独有文件(假阴)降级 potential,advisory 可接受。
- **#1 potential 噪声(已修)**:加 `globStaticSuffix` + 后缀相容检查,`src/*.js` vs `src/*.md`(后缀不容)不再误报 potential;`lib/**`(无后缀约束)vs `lib/*.md`、`a/b*` vs `a/bc*` 仍保留。
- **#3(已修)**:`fs.realpathSync` 跳过符号链接别名的自身;`git worktree list -z` 处理含换行路径。
- **#6(已修)**:新增 suffix-incompatible 静默、closed 任务跳过、兄弟删文件 definite→potential 降级、corrupt task.json 跳过四条回归。
- **#4/#5**:Codex 判本就 OK(amend 只累加 --files 无 remove;fail-open 静默合理)。

**Codex 卡死观察**:两次 P1 审查第一次都在"读完 diff、写结论前"卡死(与 P0 第二次同);收紧提示(要简短分级结论、别用 code-review 子代理、别跑 npm test)后第二次成功。已把该经验用于提示。

**待整合**:p1 分支 = 基线 + P0 + P1(栈式);合并回 main 连同 slice4/5 与并发工作是 integrator 的活。

## P2 落地记录(2026-07-11)

在独立 worktree(分支 `p2-overlap-staleness`,栈在 P1 尖端 `b1873e2` 上)落地并提交 `383cb45`。`npm test` 56/54/0/2skip。栈式:基线 → P0 → P1 → P2。

**实现**:`siblingWorktreeOpenTasks` 的返回对象加 `opened_at`(`task.spent.opened_at`)与 `suspended`(`task.suspension.outcome` 或 null);`warnSiblingEnvelopeOverlap` 消息在 sibling 行追加 `(opened <ts>; suspended: <outcome>)`。纯上下文,**不判 inactive**——suspended 任务仍是 open、仍报重叠。无逻辑/闸门/信任面改动,直接提交(未走 Codex,用户认可其量级)。

**刻意不做**:P2 的 ledger-audit 半——overlap warning 记账本按计划"仅在确有审计需求后再做"(YAGNI),未投机建。

**样例消息**:
```
warning: this envelope overlaps an open task in a sibling worktree, so a later merge can conflict:
  · <sibling path> — "migrate the ledger schema" (opened 2026-07-11T13:57:55Z; suspended: needs_input)
  · definite overlap on: lib/**
  re-scope to disjoint files, or coordinate the integration.
```

## 停止点声明

第一性根问题拆解 → Alt A/B 对比 → Codex fresh 评审(修正 state 判断、补 amend 覆盖、加两级重叠、重排 P0>P1),产出收敛。剩余不确定性是经验性的(TTL 取值、多 worktree 是否常态),分析买不到,靠落地后观察。
