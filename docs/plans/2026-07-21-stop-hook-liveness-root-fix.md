# Stop Hook 有界裁决与任务锁隔离根治方案

- 日期：2026-07-21
- 基线：`99e55edaa992ea076f8824c6e0bef19f40f36f14`
- 模式：Plan
- 深度：Deep
- 状态：仓库实现与自动化回归已完成；真实 Host 迁移/探针待用户授权
- 输入来源：现场 Codex Stop 行为、`.workloop` task snapshot、`lib/application.mjs`、`lib/host-hooks.mjs`、`lib/task-store.mjs`、相关测试与既有 Host Hook/CLI observation 设计文档

## 实施记录（2026-07-21）

- 用户随后明确要求设定目标并落地本计划，仓库内代码、测试和任务文档的实施授权已取得。
- capability-first Stop、runtime-owned budget、三阶段 observation transaction、完整仓库内容指纹、criterion single-flight lease、installer 只读迁移诊断与 portable 文档均已实现。
- `npm test` 干净运行通过：behavioral 140/140；其余套件 220 passed、9 Windows-only skipped、0 failed；`git diff --check` 通过。
- 独立双轴复审确认实现与仓库标准无剩余问题；唯一未满足的 Oracle 是 Slice 4 的真实 Codex App/CLI 与 Claude probes。
- Slice 4 已拆成可直接交接的 Delta E2E 计划：`docs/e2e-test/stop-hook-liveness/2026-07-21-stop-hook-liveness-e2e-test-plan.md`，包含 10 个场景、fixture 配方、执行 DAG、门禁、脱敏回执与安全回退。
- 当前用户 Host recipe 仍是旧的 300 秒 timeout。Installer dry-run 能准确诊断并保持原文件；依照本计划的所有权边界，安装新 runtime、人工合并 45 秒 recipe、重新 trust 与创建真实 session 仍等待用户明确授权，不以 encoder/unit tests 冒充 live evidence。

## TL;DR

当前最佳路径不是把 Hook timeout 从 300 秒调到 900 秒以上，而是同时落实三条运行时不变量：

1. **按 Host 能力分流 Stop**：`codex-safe` 这类 release-only profile 的 Stop 永不运行 criterion；只有能恢复同一会话的 hard-stop profile 才允许内联运行短 criterion。
2. **运行时自己保证有界**：Stop 内联预算由 workloop runtime 强制执行，Host recipe timeout 只做第二道保险；超过内联预算的 criterion 直接给出显式 `verify --record` / `achieve` 路径，不启动子进程。
3. **外部验收永不持有 task lock**：统一改为“锁内取快照 → 独立 criterion lease 下执行 → 锁内 compare-and-commit”；状态变化则丢弃 stale observation，绝不阻塞 PreToolUse、suspend 或其他控制命令。

下一步最便宜的证伪检查：添加一个会休眠 60 秒并写启动 sentinel 的 criterion fixture，固定当前 `codex-safe` Stop 确实会启动它；随后只实现 release-only fast path，要求同一用例在 Windows/Linux 上 2 秒内释放、sentinel 不存在、task round 和 observation 均不变化。

## 决策信封

```yaml
decision: BUILD
decision_source: 用户要求基于已定位根因制定根治方案
target_outcome: Codex 不再长时间显示 Running Stop hook，任意 criterion 执行都不占用任务控制锁，hard-stop Host 仍保有可证明的短判据门禁
baseline_and_frequency: owner Stop 对 npm test 使用900秒criterion timeout；现场实际运行900339ms后才以timeout/indeterminate落盘，期间控制命令等待task lock 15000ms后失败；active owner task每次Stop都会重复该路径
expected_benefit: codex-safe Stop 从现场约900秒降至目标2秒内，延迟降低超过99.7%；criterion 对task lock的占用从整个执行期降为两次短事务；长验收仍可通过显式CLI完整执行
delivery_and_maintenance_cost: 预计4.5–6.5人日；以后每增加一种真实Stop capability约0.25–0.5人日契约与live E2E成本
status_quo_or_existing_mechanism: 人工suspend、禁用Codex Stop、在工作结束时显式运行verify --record或achieve
decision_flip_condition: 若所有受支持Host都取消Stop continuation，则应删除全部内联criterion路径，只保留release-only Stop与显式验证；若Host提供稳定异步job/continuation契约，可用该契约替代hard-stop内联执行
review_scope: implementation-authorization
review_budget: 实施前一次plan review；完成后一次完整code review；Host契约或并发token发生material edit时重审受影响范围
```

## 验收 Oracle

以下观察必须同时成立：

1. task criterion timeout 为 900 秒时，`codex-safe` Stop 在本地和 Windows CI 中 2 秒内返回，不启动 criterion、不新增 round/attempt/observation。
2. migration/unknown release-only profile 同样不运行 criterion；PreToolUse 保护保持不变。
3. `claude` 对 timeout 超过内联预算的 criterion 在 2 秒内返回 actionable hold，明确给出 `workloop verify --record` 或 `workloop achieve`，不启动 criterion。
4. `claude` 对预算内短 criterion 保留 hard Stop：unsatisfied 时 hold，satisfied 时按 policy 关闭。
5. Stop、`verify --record`、`achieve` 和 `open` 执行 criterion 时均不持有 `.workloop/.task.lock`。
6. criterion 运行期间，PreToolUse、status、suspend 能在固定小预算内完成，不出现 `TASKLOCK_TIMEOUT`。
7. criterion 期间若 task id、source cursor、task/artifact revision、criterion generation/hash 或 owner episode 变化，observation 被判为 stale，不提交、不计 round、不关闭任务。
8. 并发 Stop 最多运行一个 criterion；其他 hard-stop 调用快速得到 `criterion_in_progress`，release-only 调用立即释放。
9. criterion 子进程超时、异常或被宿主杀死后，独立 lease 能在声明 deadline 后恢复，不误删活跃 lease。
10. runtime 内联预算严格小于 recipe timeout 并留有清理余量；即使 Host 忽略 recipe timeout，runtime 仍自行有界。
11. Hook byte contract、runtime-contract fixture、behavioral/architecture/Windows suites 与真实 Codex/Claude probes 全部通过。

## 根问题

问题不是 Node.js，也不是 PowerShell，更不是单纯的 `900 > 300` 配置错误。根问题是 **Host 能力、外部执行和任务原子性被错误地塞进同一个同步临界区**：

- `hookStop()` 不区分 profile 的控制能力，统一进入 `closeAttempt()`。
- `adjudicateClosure()` 在 `withTaskLock()` 内调用 `runObservation()`；task 的完整 criterion timeout 同时成为 UI 等待时间和控制锁持有时间。
- `codex-safe` 的差异只发生在 observation 完成后的 encoder：即使 held Stop 最终只能安全 release，它仍先支付完整 criterion 成本。
- Host recipe 声明 `timeout: 300`，task criterion 声明 `timeout_seconds: 900`，两个预算没有共享来源、没有启动前校验，也没有 runtime Stop 专用 watchdog。

解决后的状态应是：Host 能力先决定“Stop 是否有资格执行 criterion”；外部进程永远不在 authority lock 内运行；任何 observation 只有在执行前后的 authority token 完全一致时才能落盘。

## 已验证事实

1. `lib/host-hooks.mjs:54` 为 Stop recipe 固定写入 `timeout: 300`。
2. 现场 task criterion 是 `npm test`，`timeout_seconds: 900`；最新 observation 的 `duration_ms` 为 `900339`，`execution_error` 为 `timeout`，verdict 为 `indeterminate`。
3. 当前 Codex surface 没有用 recipe 的 300 秒形成可依赖上限；具体是 Host 未执行、配置未消费还是 timeout 契约不同，尚无权威证据。正确性不能依赖 Host timeout。
4. `lib/application.mjs:814-823` 在 task lock 内读取任务并执行 `runObservation()`；只有 no-task、suspended、terminal、foreign session 会快速返回。
5. `lib/application.mjs:752-757` 的 `verify --record` 明确使用与 Stop 相同的 lock-held shape；只修 Stop 会把问题留在显式验证路径。
6. `lib/task-store.mjs:44` 的 task lock 默认等待上限为 15000ms。现场 Stop 运行期间，一次 suspend 正好因 `task lock unavailable after 15000ms` 失败；Stop 完成后相同操作成功。
7. 既有 `verify --record` 已能持久化 `cli_verify` observation 并按 policy 推动 suspend/close；无需在本仓库新增 daemon 或 scheduler。

## 约束、约定与承重假设

### 真实约束

1. 保持 dependency-free Node.js CLI；`lib/application.mjs` 仍是唯一 assembly，leaf module 只依赖 `lib/prims.mjs`。
2. lifecycle mutation 继续由 `lib/task-engine.mjs` 决定；`.workloop/events.jsonl` 继续是 task authority。
3. criterion 仍基于真实仓库内容运行，side-effect detection、drift、generation、artifact revision 和 review 语义不能弱化。
4. PreToolUse 对不可解析目标和 control state 继续 fail closed；release-only Stop 不能伪装成 hard gate。
5. 用户拥有 Host Hook 配置；installer 只能诊断和生成 recipe，不能静默改写。
6. 锁、deadline 和进程清理使用 Node 标准库，在 Windows、macOS、Linux 上保持同一语义。

### 可改变的历史约定

- “profile 只改变 wire encoding，不能改变是否 adjudicate”不是外部约束；它与 Host continuation 能力冲突。
- “criterion 必须在 task lock 内运行才能原子”只是当前实现；snapshot token + compare-and-commit 能提供更精确的并发正确性。
- recipe 的 `timeout: 300` 不是 runtime watchdog，也不能作为 safety proof。
- “Stop 必须自动运行任意时长 criterion”不是产品目标；Stop 的目标是有界地决定 hold/release/close。

### 承重假设

| # | 假设 | 类型 | 如果错误 | 验证 |
|---|---|---|---|---|
| A1 | `codex-safe` 不能可靠恢复 held Stop | 已有 profile 设计和现场支持 | 若未来 Host 提供稳定 continuation，可升级为 hard capability | Codex App/CLI 各连续 10 次 Stop probe |
| A2 | 30 秒足以覆盖值得在 hard Stop 内联的 cheap criterion | 未验证默认值 | 调整 portable cap，但仍保持 runtime 自限和锁隔离 | 统计 criterion 时长；P95 超过 30 秒则重新定界 |
| A3 | authority token 能识别所有受监督并发写入 | 高置信源码推断 | 必须加入 repo content fingerprint | 并发写 + evidence gap characterization |
| A4 | `verify --record`/`achieve` 足以承接长验收 | 已有 CLI 能力 | scheduler 应在仓库外补齐 | 真实 Codex/Claude task probe |

## 当前最佳架构

```text
Host payload
   │
   ▼
profile capability
   ├─ release_only: census → immediate release
   │                  no task lock, no criterion
   └─ hard_stop
        ├─ inactive / foreign → immediate release
        ├─ criterion timeout > inline budget → actionable hold
        ├─ criterion already running → criterion_in_progress hold
        └─ short criterion → observation transaction

observation transaction
   1. .task.lock: prepare immutable authority token
   2. .criterion.lock: execute child with runtime deadline
   3. .task.lock: compare token, then commit or discard stale
```

### 1. Capability-first Stop

`lib/host-hooks.mjs` 从单纯 wire encoder 扩展为 capability owner：

```js
{ profile: "codex-safe", stop_control: "release_only", inline_criterion_budget_seconds: 0 }
{ profile: "claude", stop_control: "hard", inline_criterion_budget_seconds: 30 }
```

- `release_only` 最多追加 degrade-open census 后直接 release；不读取 task authority、不取 task lock、不运行 criterion、不改变 round/lifecycle。
- `hard` 才读取 task 并准备 closure observation。
- `codex-cli-legacy` 只有真实 live contract 证明能恢复同一 session 时才能声明 hard。
- unknown migration path 永远 release-only。

这会有意替换现有“profiles change Stop encoding without changing adjudication”测试。新不变量是：**相同 capability 的 profiles adjudication-invariant；不同 capability 的 side effects 符合各自契约。**

### 2. Runtime-owned Stop budget

引入平台无关内联预算，例如：

```text
STOP_INLINE_CRITERION_SECONDS = 30
STOP_CLEANUP_MARGIN_SECONDS = 10
STOP_RECIPE_TIMEOUT_SECONDS >= 40
```

具体数值由 A2 决定，但关系由同一模块生成并由测试锁定：

```text
task criterion timeout <= inline budget < runtime deadline < recipe timeout
```

- task timeout 大于内联预算时，Stop 不启动 child。
- hard profile 返回稳定 reason code `criterion_requires_explicit_verification` 和可复制命令。
- runtime 给 criterion runner 传绝对 deadline；即使 recipe timeout 未生效，child 也不能超过 Stop 预算。
- recipe timeout 只回收 runtime 卡死，是 defense-in-depth。

### 3. Observation 三阶段事务

在 `lib/application.mjs` 建立共享 orchestration，供 Stop、`verify --record`、`achieve`、`open` 使用：

```text
prepare(repo, intent) under .task.lock -> snapshot + token + budget
execute(snapshot.criterion) outside .task.lock -> observation
commit(repo, token, observation) under .task.lock -> committed | stale | no_longer_applicable
```

token 至少绑定 `task_id`、source cursor、task/artifact revision、criterion generation/hash、owner episode id 和 intent。commit 前任一字段变化都返回 stale，不“尽量合并”。若 evidence coverage 无法证明所有写入都会推进 token，则 A3 失败，必须加入 observation 前后的 repo content fingerprint。

`open` 也采用同一边界：锁内确认没有 active/suspended task，锁外执行 birth observation，重新加锁再次确认 authority 为空后提交。

### 4. 独立 criterion single-flight lease

在 `lib/task-store.mjs` 基于 owned-directory-lock primitive 增加 `.workloop/.criterion.lock`：

- 只串行化 criterion，不保护 task/event mutation；PreToolUse 不等待它。
- Hook acquisition 近似 non-blocking；已有 runner 时立即返回 metadata/deadline。
- metadata 记录 token、PID、started_at、deadline、intent，不记录业务输出或敏感路径。
- stale window 按 execution deadline + cleanup margin 计算，不能复用 task lock 的 5 秒窗口。
- 正常、异常和 timeout 都 finally release；强杀只允许 deadline 后 reaper 接管。

### 5. 长验收走显式路径

- `codex-safe` agent 在最后一次 substantive write 后运行 `workloop verify --record`；default policy 沿用现有自动关闭语义。
- explicit policy 运行 `workloop achieve`。
- 两条 CLI 路径复用三阶段 observation，可使用 task 的 900 秒 timeout，却不占 task lock。
- skill、help 和 hold 文案明确：release-only Stop 不产生 proof；长 criterion 由显式 verb 或仓库外 driver 调度。

## 机制比较与最佳性检查

| 机制 | 优点 | 失败模式 | 决策 |
|---|---|---|---|
| 保持现状 + 人工 suspend | 零开发成本 | 每个 active owner Stop 都复发；suspend 本身会被锁挡住 | 淘汰 |
| 把 recipe timeout 提高到 900+ 秒 | 改动最小 | 允许 UI 与控制锁合法卡 15 分钟；Host timeout 也不可依赖 | 淘汰 |
| 把 task timeout 降到 300 秒以下 | 数值暂时合法 | 仍等待数分钟并持锁；大型 suite 被截断 | 淘汰 |
| 换 Rust/Go/PowerShell | 可能减少启动开销 | 同步等待、锁边界和 capability 错配不变 | 淘汰 |
| 全 Host 禁用 Stop | 立即消除卡顿 | Claude hard gate 与自动 close 一并丢失 | 最近低成本替代 |
| capability Stop + runtime budget + observation 锁隔离 | 保留低延迟、hard gate 和长验收 | 需要并发协议与 live E2E | 赢家 |

- **适配条件**：Codex 低延迟、Claude hard gate 不退化、runtime 自限、外部进程不占 authority lock、状态变化不提交旧观察、跨平台、可回滚。
- **赢家**：capability-first Stop + runtime-owned budget + 三阶段 observation + criterion single-flight。
- **最近替代**：所有 Host 禁用 Stop，只保留显式验证。
- **击败条件**：若 Claude hard continuation 也不再支持，最近替代以更少代码胜出；三阶段 observation 仍应保留。
- **边际停止点**：完成 `release_only|hard`、一个固定内联 cap、一个 criterion lease 与三端 live probes 后停止；不做 capability DSL、daemon、自动 Host 猜测或语言重写。

### 反转测试

如果 authority token 漏掉真实并发写，释放 task lock 会使 criterion 读取混合状态，而 commit 又错误接受 observation，本方案反而最危险。因此 A3 是实施门禁：先用两个独立 Node 进程复现 criterion 运行中 authorized write，再注入 evidence gap 和绕过 Hook 的直接写入。存在 token 看不见的路径就必须加入 repo content fingerprint。

## 实施范围与成本

| 范围 | 组件 | 工作量 | 风险 | 价值 |
|---|---|---:|---|---|
| Core | Host capability matrix 与 release-only fast path | 0.5–0.75 日 | 改变 profile-invariance 契约 | 消除 Codex 长 Stop |
| Core | Observation prepare/execute/commit 与 stale token | 1.5–2 日 | 并发状态误判 | 验收不再占 authority lock |
| Core | Criterion lease、runtime deadline、recipe coherence | 0.75–1.25 日 | crash recovery、Windows 时序 | runtime 自限且不重复执行 |
| Supporting | Behavioral/architecture/Windows 并发回归 | 1–1.5 日 | timing 波动 | liveness/safety 可执行 |
| Supporting | Skill/help/installer 诊断、迁移与 live E2E | 0.75–1 日 | 用户配置需人工更新 | 可发现、可回滚 |
| **总计** | | **4.5–6.5 人日** | | |

## 可能修改的文件

- `lib/host-hooks.mjs`：capability、runtime/recipe budget 常量和生成契约。
- `lib/application.mjs`：release-only fast path、共享三阶段 orchestration。
- `lib/task-store.mjs`：criterion lease 与 non-blocking acquisition。
- `tests/workloop.test.mjs`：profile、too-long criterion、stale observation、显式验证。
- `tests/workloop-architecture.test.mjs`：证明 task-lock callback 内不运行 external criterion；并发锁测试。
- `tests/windows.test.mjs`：Windows child timeout、lease recovery。
- `skills/workloop/SKILL.md`、`skills/loop-core/REFERENCE.md`、`skills/loop-core/HOSTS.md`：Host capability 与显式长验收。
- `install.mjs`、`tests/installer.test.mjs`：只读发现旧 recipe，不编辑用户配置。
- `AGENTS.md`：落地后记录 Host timeout 非 correctness boundary 和 observation 锁边界。

本方案不需要修改 task/event schema 或 runtime contract；existing observation event shape 保持不变。

## 实施切片与退出条件

### Slice 1 — Characterization 与 release-only fast path

固定 sleeping criterion 会被当前 `codex-safe` Stop 启动、Stop 持锁导致控制命令超时的红测；再加入 capability fast path。

退出条件：Oracle 1–2；PreToolUse byte contract 不变。可独立发布止血。

### Slice 2 — Observation 三阶段事务

依次迁移 Stop、`verify --record`、`achieve`、`open`。每迁移一个入口，先保持 event/lifecycle characterization，再删除旧 lock-held 路径。

退出条件：Oracle 5–7；源码中不存在 task-lock callback 内调用 `runCriterionSource()`。

### Slice 3 — Single-flight 与 runtime budget

加入 criterion lease、portable cap、child deadline、too-long/in-progress disposition 和 recipe 余量关系。

退出条件：Oracle 3–4、8–10；Host timeout 只作为 defense-in-depth。

### Slice 4 — 迁移与真实 Host 验证

先安装含 release-only fallback 的 runtime，再由用户生成并人工合并新 recipe、重新 trust。Codex App/CLI 各连续触发 10 次 Stop；Claude 分别运行 short、too-long、in-progress、stale observation；Windows 验证 child cleanup 与 lease recovery。

退出条件：Oracle 11；live receipt 不含 transcript、账号或本机绝对路径。

## 测试、迁移与回滚

最小相关命令：

```text
node --test tests/workloop.test.mjs --test-name-pattern "Stop|observation|verify --record"
node --test tests/workloop-architecture.test.mjs --test-name-pattern "task lock|criterion"
node --test tests/windows.test.mjs --test-name-pattern "W0"
node bin/workloop.mjs hooks --profile codex-safe
node bin/workloop.mjs hooks --profile claude
npm test
git diff --check
```

Timing test 不实际 sleep 30/900 秒：fixture child 写 sentinel 后等待；release-only/too-long 分支断言 sentinel 不存在并在宽松 2–5 秒 CI 窗口返回。runtime timeout 使用可注入短预算覆盖。并发 test 使用两个独立 Node 进程和 barrier，断言只有 criterion lease 冲突，`.task.lock` 始终可在小预算内取得。

迁移顺序：先发布/安装新 runtime，再更新 skill，最后由用户人工合并/重新 trust recipe。不能用 encoder test 替代真实 Host consumption。

回滚不涉及 authority schema；但 Codex Stop 必须保持 disabled/release-only，不能恢复已知长执行路径。criterion lease 只有超过持久化 deadline 才允许 reaper 清理；若 stale token 无法证明一致性，回滚三阶段切片但保留 release-only fast path。

## 权限与明确不做

- 本文只授权计划存档，不授权修改 runtime、Host 配置、安装文件或真实 live E2E。
- 不修改历史 event store、session transcript 或 outcome ledger。
- 不通过杀进程、删除 lock 目录或修改 task snapshot 作为常规恢复。
- 不把 Hook timeout 提高到 900 秒以上。
- 不用 fire-and-forget 子进程伪装 Stop 已返回。
- 不在本仓库实现 scheduler、daemon 或自动下一轮。
- 不自动猜 Host capability。
- 不因该问题重写语言；机制修复后 Node 标准库足以提供平台无关锁、deadline 和进程管理。
