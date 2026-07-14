# Host Hook Adapter 与 Codex Safe Stop 实施计划

日期：2026-07-15
仓库基线：`6d33f407a597305c7c20098bf82b1230bcf545d5`（`agent/schema-v3-event-sourcing`）
模式：Plan
深度：Deep
状态：仓库实现已落地并通过自动化回归；真实 Codex App/Claude live E2E 仍需用户授权修改本机 Hook 配置后执行
输入来源：Codex 会话证据、当前 `lib/application.mjs`、`tests/taskloop.test.mjs`、`tests/taskloop-architecture.test.mjs`、`install.mjs`、`README.md`、`skills/loop-core/HOSTS.md`、仓库 `AGENTS.md`、当前 Codex Hooks 官方手册

## TL;DR

当前最佳路径是在 taskloop 内建立一个真正的 **Host Hook seam**：taskloop 核心只产生 host-neutral 的 canonical disposition，`lib/host-hooks.mjs` 负责按显式 profile 解码输入、编码输出和生成配置。

- 保留 schema v3、事件溯源、task engine、driver-outside-repo 和单包结构；不做 schema v4。
- `claude` 保留 Stop hard block；`codex-safe` 的 held Stop 只给受支持的告警并安全释放；`codex-cli-legacy` 仅作为显式、版本钉住的实验 profile。
- 新增 `taskloop hook --profile ...` 和 `taskloop hooks --profile ...`；禁止依靠 payload 或环境变量猜测 host/surface。
- 旧的无参数 Hook 调用进入迁移安全模式：PreToolUse 继续保护写操作，Stop 不再发出 `decision:block`，只安全释放并告警。
- 安装器只诊断旧配置并给出迁移命令，不覆盖用户拥有的 Codex/Claude Hook 文件。
- 预计 6–9 人日。第一道门禁是一个不改 taskloop 状态的 Codex App 最小输出探针；失败就把 `codex-safe` 收敛到零 stdout，而不是继续猜协议。

## 实施记录（2026-07-15）

- `lib/host-hooks.mjs` 已建立 canonical invocation/disposition 与显式 profile encoder；`unknown` 仅保留给无参数迁移路径。
- `codex-safe` 已采用预注册 fallback：held Stop 为零 stdout、stderr 告警；未把未经真实 App 探针证明的 continuation 字段写入协议。
- `application.mjs` 已拆分 closure adjudication、CLI presenter 与 Hook presenter；profile 不进入事件裁决。
- installer 只读诊断 JSON/TOML 旧配置，无法安全识别 TOML 时告警，绝不改写用户 Hook 文件。
- 自动化覆盖 H01–H14 的本地可执行部分；Windows 用例在非 Windows 环境保持固定 skip，L01–L06 尚未执行。

## 最终验收 Oracle

只有以下观察同时成立，才能把新 runtime 作为发布候选：

1. Codex App 在 `codex-safe` 下连续经历至少 10 次 held Stop 后仍能提交下一条真实用户消息，且不再出现 `invalid_id_prefix`。
2. 对应 session JSONL 中不存在由 taskloop Hook 生成、带非 `msg...` 显式 ID 的 user message。
3. `codex-safe` 和无 profile 的迁移路径在任何 Stop 分支（正常 held、task state unavailable、supervisor unavailable）都不输出 `decision:block`。
4. Claude profile 的 unsatisfied/held Stop 仍恢复同一 session，satisfied/terminal/suspended/foreign-session Stop 仍释放。
5. PreToolUse 的 deny、pass、`updatedInput` rewrite 在 Claude 与 Codex profile 下保持正确；保护 task/git control state 的 fail-closed 行为不变。
6. 同一任务输入在不同 profile 下提交完全相同的 authoritative events、task projection 和 budget 变化；只有 host wire output 可以不同。
7. `RUNTIME_CONTRACT=4`、schema v3 snapshot、event record schema 和 outcome projection schema 均不变化，也不需要迁移或重写 `.taskloop/events-v3.jsonl`。
8. 安装器面对旧 Hook 配置只产生可操作警告，配置文件字节保持不变。
9. `npm test`、architecture suite、installer suite、Windows 固定矩阵和真实 Claude/Codex live E2E 全部通过。

## 下一步验证

实施前先做一个 30–60 分钟的 Codex App 无状态探针，只让临时 Stop handler 返回：

```json
{"continue":true,"systemMessage":"taskloop probe: held"}
```

连续触发 10 次 Stop，再提交一条普通用户消息并检查新 session JSONL。预先冻结分支：

- 若无坏 ID、无 `<hook_prompt>` resume message，`codex-safe` 使用该输出；
- 若仍生成坏 ID 或恢复提示，把 `codex-safe` 固定为 **stdout 为空、stderr 告警、exit 0**；
- 无论探针结果如何，都不把 `continue:false` 当作“继续下一轮”的替代品，因为官方语义只承诺停止 hook run，没有承诺注入新的模型轮次。

该探针会临时修改用户 Hook 配置并产生真实 App session，执行前必须单独获得用户授权，先备份、后恢复。

## 决策信封

```yaml
decision: BUILD
decision_source: 用户要求基于完整仓库分析生成实施计划；当前证据已证明 taskloop Stop 输出是可重复触发源
implementation_authorization: 尚未授予
target_outcome: taskloop 在不同 host/surface 上只发出该 surface 支持的 Hook 输出，Codex App 会话不会再被 taskloop Stop 注入不可重放的 message id
baseline_and_frequency: 同一 Codex App session 已观察到 11 条 taskloop Stop prompt 带非 msg 显式 ID（当前文件 1 条、坏 ID 备份 10 条）；现有测试 184 项全绿仍未覆盖 host consumption
expected_benefit: 默认 Codex 路径 100% 消除 taskloop 自己发出的 legacy decision:block；保留 PreToolUse 保护；Claude hard gate 不退化
delivery_and_maintenance_cost: 交付 6–9 人日；以后每增加一个真正不同的 host profile 约 0.5–1 人日契约与 live E2E 成本；机会成本约 1–2 个工程周
status_quo_or_existing_mechanism: 永久移除 Codex Stop，仅保留 taskloop PreToolUse，并依赖显式 achieve 或外部 driver
decision_flip_condition: 若 Codex App 明确不在支持范围且可接受永久失去 session-internal gate，则只禁用 Codex Stop 的方案经济性更好；若 Codex 后续提供稳定的 surface 标识和 continuation 契约，可简化 Codex adapter
review_scope: implementation-authorization
review_budget: 实施前 1 次 plan-review；release candidate 1 次完整 code review，material edit 后只重审受影响范围
```

## 根问题

问题不是“一个 ID 少了 `msg` 前缀”，也不是 schema v3 生成了错误 ID。taskloop 从未创建该 message ID；它输出 legacy Stop block，Codex App 把 block reason 转成 user-shaped hook prompt 并赋予 UUID，随后 API 重放要求该 ID 必须以 `msg` 开头。

真正的系统问题是：taskloop 把 domain adjudication、host 识别、host wire encoding 和进程输出混在 `lib/application.mjs` 中，并假设同一份 `decision:block` 能跨 Claude、Codex CLI 和 Codex App 成立。现有测试只证明 taskloop stdout 字节符合自己的历史约定，没有证明 host 能安全消费、持久化和重放这些字节。

解决后的状态应是：任务裁决只回答“pass / deny / rewrite / hold / release”，host adapter 再回答“这个 host 能安全表达什么”；未知 host 永远不获得会话内自动继续能力。

## 已验证事实与约束

### 直接证据

- 当前 session 中 1 条、备份中 10 条 taskloop `<hook_prompt>` user message 带 UUID 型显式 ID；报错所指 ID 与其中一条完全一致。
- `lib/application.mjs` 当前通过 `block(message)` 固定输出 `{"decision":"block",...}`，所有 held Stop 与 Stop error 都走这条路径。
- `cmdHooks()` 当前生成一个无 host profile 的通用 PreToolUse + Stop 配方。
- 当前官方 Codex Hooks 手册为 Stop 记录的公共输出是 `continue`、`stopReason`、`systemMessage`、`suppressOutput`；没有把 `decision:block` 记录为 Codex continuation contract。
- 官方 payload 没有稳定的 App-vs-CLI surface 字段；不能安全地从 `session_id`、`model` 或环境变量推断 surface。
- 当前 suite 全绿但存在盲区：大量测试直接锁定 `decision:block` 字节，真实 Codex App consumption 不在测试面内。
- schema v3 event authority、pure `decide/evolve` 和 snapshot/outcome projection 与坏 ID 无因果关系。

### 真实约束

1. 保持 dependency-free Node.js CLI。
2. `lib/application.mjs` 仍是唯一 assembly；leaf module 只能 import `lib/prims.mjs`。
3. task lifecycle mutation 继续由 `lib/task-engine.mjs` 决定，host adapter 不读取或修改 task state。
4. PreToolUse 写保护必须 fail closed；Stop transport 在未知/不安全 host 上必须 release-safe，不能再次损坏会话。
5. Driver 和 scheduler 继续在仓库外；本方案不伪造 Codex 的下一轮。
6. 用户拥有的 `~/.codex/hooks.json`、`config.toml` 或 Claude 配置不能被安装器静默覆盖。
7. 当前 worktree 已有未提交修改；实施必须逐文件保留并围绕这些修改工作。

### 可改变的历史约定

- “所有 host 共用无参数 stdin dispatcher”不是外部约束。
- “Hook stdout 必须全局 byte-exact”应缩小为“每个显式 profile 内 byte-exact”。
- “Codex CLI live spike 成功即可代表 Codex App”必须废止。
- “Stop 错误一律 fail closed”不能跨越 host transport 安全；未知 host 的 Stop 应保留 authority 错误并安全释放。

### 承重假设

| # | 假设 | 类型 | 如果错误 | 验证 |
|---|---|---|---|---|
| A1 | Codex App 能安全消费 `systemMessage` 而不创建 resume prompt | 未验证 | `codex-safe` 必须零 stdout | 首个 10-Stop App 探针 |
| A2 | Claude 继续支持当前 `decision:block` continuation | 已有 live 证据，但版本敏感 | Claude adapter 需更新，不能发布 | release candidate Claude live E2E |
| A3 | PreToolUse hookSpecificOutput 在当前 Codex/Claude 仍兼容 | 已有测试与 live 证据 | 需要拆分 PreToolUse encoder | 双 host contract + live E2E |
| A4 | profile 可以由生成的 command 显式携带 | 可验证设计事实 | 需环境配置或独立 executable | CLI recipe tests |
| A5 | host adapter 不需要持久状态 | 高置信推断 | 需额外 session mapping，方案成本上升 | canonical replay/profile invariance tests |

## 目标架构

```text
host stdin JSON
      │
      ▼
Host Hook module: decodeHook(profile, payload)
      │ canonical invocation
      ▼
application assembly
  ├─ supervision / criterion / event commit
  └─ canonical HookDisposition
      │
      ▼
Host Hook module: encodeHook(profile, disposition)
      │
      ├─ stdout wire JSON
      ├─ stderr warning
      └─ exit code

taskloop hooks --profile P
      └─ Host Hook module: buildHookRecipe(P, command)
```

这是一条真实 seam：Claude 与 Codex 已有两个不同 adapter，且 profile 差异同时影响输入解释、Stop 输出和配置生成。删除该 module 会让 profile matrix、fallback 和 wire literals 重新散落到 assembly、测试和文档中，因此它通过 deletion test。

## Host Hook module 接口

新增 `lib/host-hooks.mjs`，保持纯函数、无 filesystem/process 访问，只允许 import `lib/prims.mjs`。

```js
decodeHook({ profile, payload })
// -> { profile, event, repo, sessionId, transcriptPath, toolName, toolInput }

encodeHook({ invocation, disposition })
// -> { stdout, stderr, exitCode }

buildHookRecipe({ profile, command })
// -> host-owned config object
```

模块内部拥有：

- profile 名称、验证、能力矩阵和未知 profile 错误；
- host payload 的最小规范化；
- 所有 `decision`、`reason`、`hookSpecificOutput`、`permissionDecision`、`updatedInput`、`continue`、`systemMessage` wire literals；
- 旧无参数调用的 migration-safe encoding；
- hook recipe 的 matcher、timeout 和显式 handler command。

`application.mjs` 不再直接构造 host JSON；它只执行 I/O 与业务编排，然后一次性写入 `encodeHook()` 返回值。

## Canonical disposition

第一阶段固定最小 union，不把 task lifecycle 或 closure projection 整体暴露给 adapter：

```js
{ event: "pre_tool_use", action: "pass" }
{ event: "pre_tool_use", action: "deny", reason: "..." }
{ event: "pre_tool_use", action: "rewrite", updatedInput: { ... } }

{ event: "stop", action: "release", notice: null | "..." }
{ event: "stop", action: "hold", code: "change_review_unaccepted", reason: "..." }
```

约束：

- `reason` 是 host-neutral 人类说明；只有 encoder 添加 `taskloop: ` 前缀。
- `code` 是稳定、可断言的原因枚举；不把完整 task state 交给 adapter。
- disposition 不包含 stdout、JSON 字段名、host 名或是否发起下一轮。
- `closeAttempt()` 拆成内部的 `adjudicateClosure()` 与两个 presenter：CLI `achieve` presenter 和 Hook disposition presenter。事件提交顺序、错误边界和 task lock 不移动到新 module。
- 对同一 authority/input，profile 只能改变 encoding，不能改变 adjudication 或 committed events。

## Profile 契约

| Profile | PreToolUse | held Stop | release Stop | 支持级别 |
|---|---|---|---|---|
| `claude` | deny/pass/rewrite 使用 Claude-compatible hook output | 当前 `decision:block` + reason | stdout 空；必要信息走 stderr | 正式支持，需真实 Claude E2E |
| `codex-safe` | 使用 Codex 已支持的 `hookSpecificOutput` | 探针通过则 `continue:true + systemMessage`；否则 stdout 空、stderr 告警 | stdout 空；必要信息走 stderr | Codex App/CLI 默认支持路径 |
| `codex-cli-legacy` | 与 `codex-safe` 相同 | 当前 `decision:block` | stdout 空 | 实验、显式 opt-in、版本钉住；不允许用于 App |
| `unknown` / 旧无参数 | 保留当前 PreToolUse 保护与 rewrite | stdout 空、stderr 迁移警告 | stdout 空 | 仅迁移 fallback，不是可生成 profile |

禁止新增 host 自动探测。Codex payload 当前不能证明 App/CLI surface；启发式检测会把安全性建立在未承诺字段上。

## CLI 与配置契约

### 新入口

```text
taskloop hook --profile claude
taskloop hook --profile codex-safe
taskloop hook --profile codex-cli-legacy

taskloop hooks --profile claude
taskloop hooks --profile codex-safe
taskloop hooks --profile codex-cli-legacy
```

- `hook` 是 host handler，读取 stdin 并写编码结果。
- `hooks` 只生成 recipe，不写用户配置。
- `hooks` 没有 `--profile` 时返回 exit 2，并列出受支持 profile，避免继续生成歧义配置。
- 当前无参数 invocation 保留一个发布周期，只进入 `unknown` migration fallback；下一次 runtime contract 评审再决定是否删除。
- 生成的 handler command 必须显式包含 `hook --profile <profile>`，Windows quoting 纳入现有跨平台测试。

### 安装器诊断

`install.mjs` 增加只读检查：

- 检查用户层 `~/.codex/hooks.json` 和可安全读取的 `~/.codex/config.toml` 是否存在匹配 taskloop Stop 且 command 仍为无参数调用或 legacy profile；
- 输出 profile-specific 迁移命令和风险说明；
- JSON/TOML 无法安全解析时只警告，不尝试修复；
- `--configure-codex` 仍只负责 outcome projection writable root，不获得修改 Hook 的权限；
- installer tests 断言配置文件前后 digest 相同。

## 实施阶段

### Phase 0 — 风险隔离与探针（0.25–0.5 日）

1. 经用户授权后备份当前 Codex Hook 配置。
2. 临时移除或替换 **仅 taskloop Stop**；保留 notifier 和 taskloop PreToolUse。
3. 运行前述 10-Stop `systemMessage` 探针，记录 App 版本、Codex runtime 版本、session path、结果和恢复步骤。
4. 冻结 `codex-safe` held encoding；恢复到“Stop disabled”的安全基线，而不是恢复已知不安全配置。

退出条件：A1 已被证伪或确认，且用户配置回到可证明的安全状态。

### Phase 1 — 冻结 domain 行为并提取 canonical result（1.5–2 日）

可能修改：

- `lib/application.mjs`
- `tests/taskloop.test.mjs`
- 新增 `tests/host-hooks.test.mjs` 的 disposition fixtures

工作：

1. 给 no task、foreign session、suspended、terminal、criterion side effect、budget exhaustion、stuck、review held、criterion unsatisfied/satisfied 和 supervisor errors 建 characterization tests。
2. 测试同时断言 stdout 之外的 event record、task projection、round/write/token budget 和 lifecycle。
3. 把 `closeAttempt()` 的业务结果改为 canonical closure result，再分别映射到 CLI 和 Hook disposition。
4. 把 `deny()`、`allowTaskloopCommand()`、`block()` 的直接进程输出替换为 disposition 返回值；最外层 dispatcher 统一输出。

退出条件：尚未切换 profile 时，现有公开 CLI 行为与 authoritative event bytes 不变；application 已不需要 host wire literals。

### Phase 2 — 建立 Host Hook deep module 与 profile matrix（1.5–2 日）

可能修改：

- 新增 `lib/host-hooks.mjs`
- `lib/application.mjs`
- `tests/host-hooks.test.mjs`
- `tests/taskloop-architecture.test.mjs`
- `package.json`

工作：

1. 实现 `decodeHook`、`encodeHook`、`buildHookRecipe`。
2. 实现 `claude`、`codex-safe`、`codex-cli-legacy`、internal `unknown` capability matrix。
3. 增加 `npm run test:host-hooks` 并纳入 `npm test`。
4. architecture test 将 `host-hooks.mjs` 纳入 leaf list，证明只 import `prims.mjs`。
5. architecture test 证明 host wire 字段只存在于 `host-hooks.mjs` 和对应 contract tests，不回流到 assembly。
6. profile invariance test 对同一 fixture 分别运行三个 profile，比较 event store 与 task snapshot 的语义/字节结果。

退出条件：所有 profile 的输入、输出、fallback 和 error matrix 可只通过 module interface 完整测试。

### Phase 3 — 显式 CLI profile 与迁移安全默认（0.75–1 日）

可能修改：

- `lib/application.mjs`
- `lib/host-hooks.mjs`
- `tests/taskloop.test.mjs`
- `tests/windows.test.mjs`

工作：

1. 增加 `hook --profile` 与 `hooks --profile` 参数解析和 help。
2. recipe command 始终写明 profile；固定 macOS/Linux/Windows quoting。
3. 旧无参数 handler 走 `unknown`：PreToolUse 继续 deny/rewrite，Stop stdout 为空并告警。
4. 无 profile 的 generator fail fast，不再生成新的歧义配置。
5. 将原有 Stop tests 显式标注为 `claude` 或目标 Codex profile，禁止测试 helper 隐式选择 legacy。

退出条件：新配置无法意外落入 legacy Stop；旧配置升级 runtime 后不会继续注入 block prompt。

### Phase 4 — 安装器诊断与文档迁移（0.75–1 日）

可能修改：

- `install.mjs`
- `tests/installer.test.mjs`
- `README.md`
- `skills/loop-core/HOSTS.md`
- 必要时仓库 `AGENTS.md` 增加一条已验证 host contract 事实

工作：

1. 加入 read-only legacy Hook 检测及 byte-preservation tests。
2. 把 HOSTS 支持矩阵拆为 Claude、Codex App safe、Codex CLI safe、Codex CLI legacy experimental。
3. 删除“Codex CLI 成功代表 Codex 全 surface”的表述。
4. 写出 containment、迁移、显式 `achieve`/外部 driver 和 rollback runbook。
5. 明确 `codex-safe` 不提供 session-internal continuation，不把 warning 描述成 hard gate。

退出条件：新用户能生成正确 profile；旧用户升级时获得明确但非破坏性的迁移指引。

### Phase 5 — 自动化与真实 host E2E（1–1.5 日）

自动化 contract cases：

| ID | 场景 | 期望 |
|---|---|---|
| H01 | 每个 profile 解码合法 payload | 只得到 canonical invocation |
| H02 | 无效显式 profile | exit 2，不执行 adjudication |
| H03 | PreToolUse deny/pass/rewrite | 每个 profile wire exact；状态效果一致 |
| H04 | Claude held Stop | byte-exact `decision:block` |
| H05 | Codex-safe held Stop | 永不包含 `decision:block` 或 resume prompt 字段 |
| H06 | Legacy CLI held Stop | 只有显式 legacy profile 才输出旧 block |
| H07 | 旧无参数 held Stop | stdout 空、stderr 有迁移警告 |
| H08 | Stop supervisor/task-state error | Claude block；Codex-safe/unknown release-safe |
| H09 | no task/suspended/terminal/foreign Stop | 所有 profile release；authority 不变 |
| H10 | profile invariance | event records、projection、budget 完全相同 |
| H11 | recipe generation | handler command 含显式 profile；matcher/timeout 正确 |
| H12 | installer 检测旧配置 | 只警告；输入 digest 不变 |
| H13 | schema/runtime handshake | contract 4 与 schema versions 不变 |
| H14 | Windows path/quoting | Node 22/24 × Windows 2022/2025 全绿 |

真实 host cases：

| ID | Host | 场景 | 发布门禁 |
|---|---|---|---|
| L01 | Codex App | 10 次 held Stop 后发送下一条消息 | 无 API error；无非 `msg` taskloop prompt ID |
| L02 | Codex App | PreToolUse 越界写与 taskloop command rewrite | deny/rewrite 可见且不损坏会话 |
| L03 | Codex CLI | `codex-safe` held/release | 无 legacy prompt；任务事件正确 |
| L04 | Codex CLI | 显式 legacy profile | 仅记录为当前钉住版本的实验结果，不外推到 App |
| L05 | Claude Code | held Stop 恢复、terminal Stop 释放 | hard gate 语义保留 |
| L06 | Unknown/no profile | 升级旧 recipe | Stop 安全释放；PreToolUse 仍保护 |

退出条件：H01–H14 与 L01–L06 全部留存版本、命令、结果和已知未覆盖面；不得用 CLI 结果替代 App 结果。

### Phase 6 — 发布切换与观察（0.25–0.5 日）

1. 先发布含 safe fallback 的 runtime，再迁移用户 recipe；顺序不可反转。
2. 安装后生成 `codex-safe` recipe，由用户显式更新并在 Codex `/hooks` 中重新 review/trust。
3. Claude 配置迁移到显式 `claude` profile。
4. 保持 Codex taskloop Stop disabled，直到 L01/L02 在发布候选上通过。
5. 发布后首个真实 Codex App task 检查 session JSONL 与错误流；有一次 bad ID 即回退为 Stop disabled。

退出条件：所有受支持 host 都在显式 profile 下运行，用户配置不再依赖无参数 fallback。

## 建议提交切片

实施时保持每个提交可独立验证；这里只规定切片，不授权 commit：

1. `test: characterize host-neutral hook dispositions`
2. `refactor: return canonical closure and hook results`
3. `feat: add host hook adapters and contract matrix`
4. `feat: require explicit hook profiles in generated recipes`
5. `feat: warn on legacy Codex Stop configuration`
6. `docs: publish host support and migration runbook`
7. `test: record live Codex App CLI and Claude evidence`

任何提交若同时改变 task-engine event schema 和 host encoding，应拆回；本计划没有这种耦合需求。

## 验证命令

```sh
npm run test:host-hooks
npm run test:behavioral
npm run test:architecture
npm run test:installer
npm run test:windows
npm test
node bin/taskloop.mjs hooks --profile codex-safe
node bin/taskloop.mjs hooks --profile claude
node bin/taskloop.mjs info
git diff --check
```

真实 host E2E 不能由上述命令替代；其 receipt 应放入新建的 `docs/e2e-test/host-hook-adapters/` 运行目录，不把原始 session transcript 或用户绝对路径提交进仓库。

## 迁移与回滚

### 迁移

1. 盘点 user/project/plugin 各层 Hook 来源，确认 taskloop Stop 的唯一来源。
2. 备份用户拥有的配置；记录 digest，不把备份提交到仓库。
3. 在旧 runtime 仍运行时先禁用 Codex taskloop Stop，保留 PreToolUse。
4. 安装新 runtime；验证旧无参数 Stop 已安全释放。
5. 生成并人工合并 `codex-safe` recipe，重新 review/trust。
6. L01/L02 通过后再保留 Codex Stop；否则维持 Stop disabled。

### 回滚

- 代码/runtime 回滚不需要 event migration，schema 与 authority 未变化。
- 回滚新 runtime 时，Codex taskloop Stop 必须保持 disabled；不得直接恢复含旧无参数 `decision:block` 的备份。
- PreToolUse 可继续使用旧 runtime；若其行为也异常，再单独禁用 taskloop Hook，不影响 `.taskloop/events-v3.jsonl`。
- Claude 可恢复原 recipe，但优先保留显式 `claude` profile 配置。
- installer 从不自动回写 Hook，因此回滚只涉及 runtime shim 与人工配置选择。

## 权限与安全边界

- 仓库内新增/修改代码、测试和文档属于实施授权范围；当前请求只授权计划文档。
- 读取用户 Hook 配置用于诊断可执行；修改、备份恢复、重启 Codex App、重新 trust Hook 和创建真实 session 均需用户明确授权。
- 不修补或批量重写现有 session JSONL；坏 session 只作为只读证据。会话恢复属于单独、显式授权的操作。
- E2E receipt 只保存脱敏摘要，不保存原始 transcript、账号信息或机器绝对路径。

## 范围与成本

| 范围 | 组件 | 工作量 | 风险 | 价值 |
|---|---|---:|---|---|
| Core | canonical closure/hook result 与 application 输出分离 | 1.5–2 日 | 中：可能改变事件提交/错误路径 | 让 domain 行为与 host encoding 可独立证明 |
| Core | Host Hook deep module 与 3 个显式 profile | 1.5–2 日 | 中：wire contract 错配 | 从根上消除跨 host 假设 |
| Core | 显式 `hook/hooks --profile` 与 migration-safe fallback | 0.75–1 日 | 中：配置兼容 | 阻止新旧配置继续制造不安全输出 |
| Supporting | contract、invariance、architecture、Windows tests | 1–1.5 日 | 低 | 关闭当前 suite 的 host 协议盲区 |
| Supporting | installer 诊断与文档迁移 | 0.75–1 日 | 低 | 让升级可发现、可回滚且不夺取配置所有权 |
| Supporting | Codex App/CLI + Claude live E2E | 1–1.5 日 | 中：依赖真实 host | 提供唯一能证明用户目标的验收证据 |
| **Total（Core + Supporting）** | | **6–9 人日** | | |
| Optional（不计入） | 自动化 GUI App harness | 2–4 日 | 高、易碎 | 初期不如人工 release gate 划算 |
| Optional（不计入） | 通用 plugin/host registry、独立 npm package | 3–6 日 | 高 | 当前只有少量内建 adapter，不产生额外价值 |

## 方案比较与最佳性检查

### 比较

| 机制 | 优点 | 失败模式 | 决策 |
|---|---|---|---|
| 保持现状 | 零开发成本 | 已观察到会话不可继续；每次 held Stop 都可能再次触发 | 淘汰 |
| 永久禁用 Codex Stop | 最小、立即安全 | 永久失去 Codex 内部 gate，只剩显式 achieve/外部 driver | 最接近替代方案 |
| 全局把 block 改成 `continue:false` | 改动小 | 官方未承诺产生下一轮；可能直接停止而非继续；Claude 回归 | 淘汰 |
| 自动识别 App/CLI/Claude | 用户配置简单 | payload 无稳定 surface 字段，误判即安全事故 | 淘汰 |
| 显式 profile + canonical disposition + adapter | 安全、可测、保留 Claude 能力、迁移可控 | 增加一个 module 和 live E2E 维护成本 | 赢家 |

### 最佳性检查

- **适配条件**：不损坏 Codex App、保留 PreToolUse、保留 Claude hard gate、无 schema 迁移、显式可测试、配置归用户所有。
- **赢家**：显式 Host Hook profile + canonical disposition seam；它是当前约束下的最佳方案。
- **最近替代**：永久禁用 Codex Stop，仅保留 PreToolUse 与外部 driver。
- **击败条件**：如果 Codex App 不属于支持范围，或项目明确接受 Codex 永久没有 session-internal gate，则替代方案以约 0.5 日成本胜出。
- **边际停止点**：完成三个 profile、safe fallback、迁移诊断和三端 live E2E 后停止；不做 schema v4、package split、自动 host 探测、通用 registry、内置 driver 或 GUI 自动化。

### 反转测试

本方案在以下条件下会成为最差方案：只有一个 host、所有 host 已共享同一稳定协议、或 Codex App 完全不支持且不需要 Stop。当前事实相反：至少两个真实 adapter 的 wire contract 已不同，Codex App 已被 legacy block 损坏，Claude 又仍需要 block。因此 seam 是实际变化点，不是为未来假设增加的抽象。

另一个失败条件是 `systemMessage` 仍被 App 序列化成不安全 user prompt。该风险已由 Phase 0 的预注册 fallback 消解：`codex-safe` 退为零 stdout，不影响整体架构与事件语义。

## 明确不做

- 不修改 task-engine lifecycle、criterion、review assurance 或 budget 语义。
- 不修改 runtime contract 4 或任何 schema version。
- 不迁移、重写或“修复”历史 event store/session transcript。
- 不在 taskloop 内实现 scheduler、下一轮 driver 或 App 自动重试。
- 不宣称 `codex-cli-legacy` 支持 Codex App。
- 不通过环境变量、binary path、model slug 或 session ID 猜测 host surface。
- 不让安装器静默编辑用户 Hook 配置。
