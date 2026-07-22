# Host Hook capability conformance

日期：2026-07-22  
状态：Phase 0 实现门禁通过；Codex CLI release seal 通过；整体发布门禁未通过

## 结论

当前证据足以确定实现必须采用“直接回执 + repository reconciliation”的双轨架构，但不足以把任一 Codex profile 宣称为写入历史全覆盖，也不足以授予 Claude completion authority。

- Codex CLI 0.144.5 在实现候选 `7d0c737` 上复跑：成功的 Bash 与直接 `apply_patch` 都观察到共享 `tool_use_id` 的 Pre/Post；nonzero Bash 与失败 `apply_patch` 都只观察到 Pre。Post 证明工具返回，不证明仓库最终状态。
- Codex App code-mode 的嵌套 shell 路径可见，但 specialized patch 路径可在没有相应 Hook receipt 时落地修改。当前 Workloop Contract 5 任务也再次表现为仓库已发生写入而 `spent.writes=0`。
- Claude Code 2.1.216 已安装，但本轮没有获得修改真实 Hook 配置并启动宿主探针的额外授权。因此 Write、Edit、Bash failure 和 partial-write-before-failure 都保持 `unverified`，不得从文档或配置存在推断为成功回执。

这使 Phase 0 的生产实现门禁成立：所有未验证或不可穷举的 surface 都有明确的保守分支，Contract 6 可以实现并通过离线 fixture 验证。Codex CLI release-candidate 复跑已完成；发布激活门禁仍要求 Claude 与全新的 Codex App thread。

## Codex CLI release-candidate 复跑

在独立临时 Git 仓库中，对 Codex CLI 0.144.5 执行四种动作，得到 6 条去标识化事件：

- Bash success：Pre/Post 同一操作 ID，Post response 存在，文件结果符合预期。
- `apply_patch` success：Pre/Post 同一操作 ID，Post response 存在，文件结果符合预期。
- Bash nonzero：只有 Pre，没有 Post；不得授予 completion authority。
- `apply_patch` failure：只有 Pre，没有 Post，文件保持成功路径后的内容；不得授予 completion authority。

原始 payload、session ID、tool use ID、命令和绝对路径均未写入仓库。CLI 即使使用 ephemeral 与跳过 hook trust 参数，仍临时追加了项目 trust 元数据；每轮都只移除该探针生成的精确条目，并以探针前后的 `config.toml` SHA-256 一致确认真实配置恢复。

## 去标识化 fixtures

纯测试读取以下 registry facts：

- `tests/fixtures/host-hook-capabilities/codex-cli.json`
- `tests/fixtures/host-hook-capabilities/codex-app.json`
- `tests/fixtures/host-hook-capabilities/claude-code.json`

fixtures 只保留宿主、版本、canonical tool、事件可见性、关联语义和 receipt quality；不保留原始 payload、命令、路径、prompt、session、response 或 transcript。

## Capability 决策

| host/surface | 当前状态 | operation receipt | exhaustive | Contract 6 行为 |
|---|---|---|---|---|
| Codex CLI direct function tool | degraded | correlated Post 可记 `tool_specific` | 否 | artifact-only 允许执行并 reconcile；complete history fail closed |
| Codex App nested shell | degraded | correlated Post 可记 `tool_specific` | 否 | 同上 |
| Codex App specialized patch | degraded | 无直接 receipt | 否 | 仅由 reconcile 发现；history partial/unknown |
| Claude direct tools | unverified | unknown | 否 | 不授予 completion authority；依赖 reconcile；complete history fail closed |

`exhaustive=false` 是 task-level 权限判断，不否认某一次 direct operation 的相关回执。因为 Codex hook payload 不能可靠区分 CLI 与 App specialized surface，单次 exact/tool-specific receipt 永远不能回填此前未覆盖的 mutation interval。

## Release seal

激活 Contract 6 前必须补齐：

1. Claude Write、Edit、Bash success/failure/partial-write-before-failure 的真实 Pre/Post/PostToolUseFailure 组合与关联字段。
2. 新 Codex App thread 的嵌套 shell 和 specialized patch 两条路径。
3. Codex CLI 成功/失败 patch 与 nonzero shell 的 release-candidate 复跑。已完成；结果与保守 fixture 一致。
4. 所有原始探针只存在于临时目录；生成 sanitized fixture 后删除或移入废纸篓。

任一复跑与 fixture 不同，先将 capability 降为 `unknown`，不得通过调整报告措辞绕过 closure gate。
