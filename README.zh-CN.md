# taskloop

[English README](README.md)

taskloop 是一个零依赖 Node.js CLI，也是面向 coding agent 的可移植循环内核。它一次监督一个 durable task：运行时约束写入、重新执行新鲜的 done-when 判据、记录可审计证据，并裁决任务是否可以关闭。下一轮调度、定时器和 OS 级 sandbox 不在本仓库内。

本仓库随 runtime 一起发布四个 kernel skills：

- `skills/loop-core`：共享 task、criterion、lifecycle、envelope、budget 和 host binding 词汇。
- `skills/workloop`：从已来源化判据到诚实终态的机器可验证工作闭环。
- `skills/judgmentloop`：面向文案、设计、命名等品味型交付物的 rubric 与人工验收闭环。
- `skills/meta-loop`：基于 ledger 复盘循环是否收敛、停滞、挂起或绕过监督。

## 架构图

![taskloop architecture](docs/taskloop-balsamiq-architecture.svg)

![taskloop loop engineering model](docs/taskloop-loop-engineering-balsamiq.svg)

## 仓库结构

- `bin/taskloop.mjs` 只是进程入口。
- `lib/application.mjs` 是唯一装配层，负责 CLI verb、hook dispatch、事件提交、snapshot、projection 和 report。
- `lib/` 下叶子模块只能导入 `lib/prims.mjs`，架构测试会强制这个边界。
- `lib/task-engine.mjs` 拥有生命周期转移、策略决策、closure、assurance、budget、stuck 检测和 review requirement。
- `lib/event-store.mjs` 拥有 hash-chained `.taskloop/events-v3.jsonl` 权威日志。
- `lib/task-store.mjs` 拥有 digest 校验的 schema-v3 snapshot wrapper 和跨进程 task lock。
- `lib/supervision.mjs`、`lib/host-hooks.mjs`、`lib/evidence-ledger.mjs`、`lib/untracked.mjs` 分别承载 hook 写入仲裁、宿主协议编码、有界证据遥测和无任务写入提示。
- `install.mjs` 在当前用户 home 下安装版本化 runtime、稳定 shim 和四个 managed skills。
- `tests/` 覆盖行为、架构、hook 协议、runtime contract 4、事件存储、snapshot、installer、skill closure 和 Windows gates。

## 核心模型

Criterion observation 只有三种：`unsatisfied`、`satisfied`、`indeterminate`。Task lifecycle 是 `active`、`suspended(reason)` 或 `terminal(outcome)`，其中终态 outcome 是 `achieved`、`not_needed`、`abandoned`。Criterion `satisfied` 只是证据，不等于任务完成；closure 另行投影为 `not_ready`、`held` 或 `eligible`。

三个具名 policy 定义 open、witness 和 close 行为：

- `default`：以 unsatisfied 打开，需要 unsatisfied witness，自动关闭。
- `deferred-witness`（状态中为 `deferred_witness`）：以 determinate 打开，需要 witness，自动关闭。
- `steady-satisfied`（状态中为 `steady_satisfied`）：以 determinate 打开，不需要 witness，显式关闭。

每个 criterion definition 都有稳定的 `criterion_definition_hash` 和不可复用的 `criterion_generation_id`。修改 criterion 或 policy 会创建新 generation，旧 witness 和 review 不跨 generation 继承。

## 基本使用

```sh
node bin/taskloop.mjs open --repo . --goal "observable outcome" \
  --criterion "npm test" --criterion-policy default \
  --alignment-because "the suite exercises the requested behavior" \
  --not-covered "deployed environment" \
  --files "lib/**" --files "tests/**"

node bin/taskloop.mjs status --repo .
node bin/taskloop.mjs verify --repo .
node bin/taskloop.mjs achieve --repo .
```

可移植工作优先使用仓库相对的 criterion 文件：

```sh
taskloop open --repo . --goal "observable outcome" \
  --criterion-file "acceptance.mjs" \
  --criterion-protocol tri-state \
  --criterion-policy default \
  --alignment-because "the adapter checks the requested behavior" \
  --not-covered "external deployment" \
  --files "lib/**" --files "tests/**"
```

Tri-state adapter 使用 protocol version 2：退出码 `4` 表示 `satisfied`，`3` 表示 `unsatisfied`，`2` 表示 `indeterminate`。退出码 `0` 会被当作 silent/indeterminate，所以旧的 0/1 adapter 必须先升级。

其他生命周期命令：

```sh
taskloop suspend --repo . --reason needs-input --remaining "credential" \
  --failure "cannot authenticate" --next-action "provide test access"
taskloop resume --repo . --reason "access supplied"
taskloop join --repo . --reason "continue this active task in this session"
taskloop not-needed --repo . --evidence "read-only probe showed the goal already holds"
taskloop abandon --repo . --reason "superseded"
```

## 运行时权威

Runtime contract 4 把 `.taskloop/events-v3.jsonl` 作为仓库内唯一权威。`.taskloop/task.json` 是 schema-v3 snapshot wrapper，可以删除并从事件重建，永远不会被提升为权威。每个公开 mutation 都先提交一条 hash-chained transaction，再刷新 snapshot。

`~/.taskloop/outcomes-v3.jsonl` 是 home 下的 best-effort projection，不是 task authority。可以幂等重建和审计：

```sh
taskloop sync-outcomes --repo .
taskloop audit --repo .
taskloop audit-outcomes
```

Schema-2 task 和 orphan/mixed snapshot 都 fail closed。只有带显式 user provenance 时才保留 incompatible state 的原始字节：

```sh
taskloop archive-incompatible-state --repo . \
  --reason "runtime-contract-4 hard cutover" --granted-by user
```

`taskloop info` 暴露当前版本：

- `runtime_contract: 4`
- `criterion_adapter_protocol_version: 2`
- `task_snapshot_schema_version: 3`
- `event_record_schema_version: 2`
- `outcome_projection_schema_version: 3`

## Budget 与安全

Round 默认有上限。Write、wall-clock 和 output-token budget 可以作为独立上限叠加。任何配置过的 budget 耗尽后都会拒绝继续写入，但读取和验证仍可用。新鲜 unsatisfied Stop 或显式 `achieve` 会以 `out_of_budget` 挂起；新鲜 satisfied criterion 仍然可以关闭任务。重复等价失败会以 `stuck` 挂起。

Command safety 默认拒绝。Git mutation 和权限扩张必须显式 grant，并记录 provenance：

```sh
taskloop amend --repo . --git-allowed add \
  --git-reason "prepare the user-requested commit" \
  --granted-by user --reason "user requested staging"
```

Network、destructive、install-script 和 publish-shaped command 都需要对应 grant。远程下载后直接 pipe 到 shell 需要同时具备 network 和 destructive grant。Secret dump 始终默认拒绝。

## Hooks 与宿主

Hook recipe 必须显式指定 profile：

```sh
taskloop hooks --profile codex-safe --mode nudge
taskloop hooks --profile claude --mode nudge
```

`codex-safe` 保留 PreToolUse deny/rewrite 行为，但 held Stop 会输出零 stdout，并在 stderr 给出解释；继续下一轮要依靠外部 driver 或显式运行 `taskloop achieve`。`claude` 保留 Claude Code session 内部的 `decision:block` continuation。`codex-cli-legacy` 只用于固定版本实验，不能用于 Codex App。

最新 episode 在其 `host_session_id` 被绑定时拥有 Stop adjudication 和 write envelope。Foreign session 可以自由读取和验证，但不能写 envelope 或 task/git control state；继续 active task 用 `join --reason` 转移所有权，并行工作用单独 worktree。

## Assurance 与 Review

Proof assurance 和 change assurance 是两件事。Artifact write 之后修改 criterion 或 policy 会产生 `criterion_assurance_gap`；要么增强并重新见证 proof，要么用 `accept-proof-gap` 显式记录 provisional downgrade。

Change review 由 declared risk 和 machine floor 共同驱动。默认情况下，`routine` 不需要 review，`substantial` 需要 `fresh-context`，`critical` 需要 `second-model`。`--review-policy required|waived` 可以显式覆盖；每个 waiver 都必须有 reason，并保留在审计里。

```sh
taskloop review --repo . --level fresh-context --reviewer peer \
  --blocking-findings 0 --advisory-findings 0
```

Machine floor 只计价 active PreToolUse hook 实际观察到的 authority use。未使用的 grant 和不存在的 sensor 不会伪造使用事实。当有界 evidence stream 腐坏、缺口或被截断时，`ledger --json` 会返回 unknown，而不是把缺失历史转换成干净的 false。

## 安装与验证

```sh
node install.mjs
npm test
npm run bench:event-store -- --json
node bin/taskloop.mjs help
```

手动安装测试使用 `TASKLOOP_INSTALL_HOME`。Installer 会保护未归属、本地修改、symlink 或外部接管的 skill tree，并对 Claude/Codex skill root 指向同一目录的情况去重。它只读取用户级 Codex Hook 配置来提示 legacy taskloop Stop command；除非显式传入 `--configure-codex`，否则不会改写 Hook 配置。该 flag 也只用于 outcome projection writable root。

Windows release gate 在 Windows 2022/2025 和 Node 22/24 上运行 W01-W08。完整契约见 [loop-core reference](skills/loop-core/REFERENCE.md)、[host binding recipes](skills/loop-core/HOSTS.md) 和 [adapter contract](skills/loop-core/ADAPTERS.md)。
