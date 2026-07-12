# taskloop Review Skill 调度协议改进方案

**日期**：2026-07-12  
**状态**：最小纵向验证通过，待正式实现  
**范围**：review request、宿主调度、skill adapter、review receipt、closure gate

## TL;DR

taskloop 不直接调用某个 review skill。最佳边界是：taskloop 生成与当前任务和产物
revision 绑定的结构化 review request；宿主/workloop 按所需独立性选择可用 skill；skill
通过 adapter 返回结构化 receipt；taskloop 校验绑定关系并从 findings 自行计算阻塞项，
只有当前 revision 上零 blocking findings 的 review 才解除 `change_review_unaccepted`。

review 发生在 criterion satisfied 之后、`terminal(achieved)` 之前。Stop hook 不同步承担
长耗时 reviewer 调度，避免超时、递归、重复运行以及插件缓存路径失效。

## 最小验证结论

2026-07-12 使用一个临时、已删除的纯逻辑原型复用了现有 `task-engine` 状态机，验证：

1. `task_id + criterion_generation_id + last_substantive_task_revision + artifact_revision + required_level`
   可以确定性生成 review request ID。
2. 状态不变时重复生成相同 request ID，可供宿主去重。
3. 包含 blocking finding 的 receipt 被记录后，closure 仍为
   `held(change_review_unaccepted)`。
4. 后续写入提高 artifact/substantive revision，生成不同 request ID，旧 review 自动失效。
5. 新 revision 上的 second-model、零 blocking receipt 使 closure 变为 `eligible`。
6. receipt 中的 blocking/advisory 数量可以由规范 findings 推导，无需信任调用者手填汇总。

实际原型输出：

```json
{
  "result": "validated",
  "first_request": "rr-c20b56a5276ff049ffd718d2",
  "first_receipt": "blocking",
  "second_request": "rr-26142dd9f636fc4085fb9e82",
  "second_receipt": "advisory-only",
  "final_closure": { "state": "eligible" }
}
```

该验证只证明状态模型和绑定机制可行，尚未验证真实 Codex/Claude skill 调度、后台任务
恢复和跨进程去重。

## 根问题

目标不是“让 taskloop 能运行一个 skill 名字”，而是保证：机器判据通过后，如果变更风险
要求独立审查，系统能够可靠触发具备足够独立性的 reviewer，把发现反馈到工作循环，并且
只接受针对当前代码 revision 的审查结果。

review skill 是宿主能力，不是 taskloop 可依赖的稳定可执行接口：

- Codex、Claude Code 对 skill 的发现和执行方式不同。
- taskloop 是可移植 Node.js kernel，不能假设某个外部 skill 已安装。
- 项目方向明确规定 scheduler 在仓库外，核心技能文本不得引用特定外部 skill/tool。
- Stop hook 内同步 review 容易超时、递归和重复触发。
- 版本化插件缓存会被升级替换，长会话不能持有将被删除的 `${PLUGIN_ROOT}`。

## 当前最佳架构

```text
criterion satisfied
  → taskloop projects review requirement
  → taskloop emits deterministic review request
  → host adapter resolves a capable review skill
  → skill executes review
  → adapter normalizes findings into a receipt
  → taskloop validates binding and records receipt
  → blocking findings feed another work round
  → current zero-blocking receipt makes closure eligible
```

职责分配：

| 组件 | 拥有的职责 | 不拥有的职责 |
|---|---|---|
| taskloop | requirement、request、revision binding、receipt validation、closure | skill 发现、模型调用、后台调度 |
| host/workloop adapter | capability mapping、调用、去重、重试、递归保护 | 修改 review 验收标准、自动 waiver |
| review skill | 实际审查、findings、not-covered | 宣布 task terminal、绕过 criterion |

## 协议设计

### Review Request

新增只读命令：

```text
taskloop review-request --repo .
```

有要求时输出：

```json
{
  "schema_version": 1,
  "state": "required",
  "request_id": "rr-...",
  "required_level": "second_model",
  "reasons": ["declared_critical", "public_contract"],
  "binding": {
    "task_id": "...",
    "criterion_generation_id": "...",
    "task_revision": 7,
    "artifact_revision": 4
  },
  "acceptance": { "maximum_blocking_findings": 0 }
}
```

request ID 由 schema version、binding 和 required level 的 canonical JSON 哈希派生。没有
任务、无需 review 或 review 已接受时仍退出 0，并输出 `state: not_required`。命令不启动
reviewer，也不修改 task state。

### Capability Resolution

宿主配置使用能力而非核心硬编码的 skill 名：

```text
fresh_context → installed capability with fresh-context-review
second_model → installed capability with second-model-review
```

解析顺序：满足最低独立性、支持结构化输出、能回传 request binding、满足本地可用性。
不存在适配能力时任务保持 held；不得自动降级 reviewer level 或生成 waiver。

具体 skill 映射只能出现在宿主/插件配置中，不能进入 taskloop 的 portable core 文档。

### Review Receipt

新增导入命令：

```text
taskloop record-review --receipt-file <path>
```

Receipt v1：

```json
{
  "schema_version": 1,
  "request_id": "rr-...",
  "binding": {
    "task_id": "...",
    "criterion_generation_id": "...",
    "task_revision": 7,
    "artifact_revision": 4,
    "required_level": "second_model"
  },
  "reviewer": {
    "adapter_id": "host-review-adapter",
    "execution_id": "...",
    "level": "second_model"
  },
  "findings": [
    {
      "severity": "blocking",
      "summary": "...",
      "location": "lib/example.mjs:42"
    }
  ],
  "not_covered": [],
  "completed_at": "2026-07-12 15:20:30"
}
```

taskloop 必须：

- 重算 request ID 并精确校验所有 binding 字段。
- 校验 reviewer level 不低于 required level。
- 从 findings 推导 blocking/advisory counts。
- 保存阻塞和非阻塞 review，供审计及循环反馈使用。
- 只让当前 generation/revisions 上零 blocking 的 receipt 满足 requirement。
- 拒绝未知 severity、超限 receipt、空 reviewer identity 和不匹配 request。

taskloop 仍是协作式信任边界：它能证明 receipt 自洽和版本绑定，不能密码学证明外部模型
身份或审查质量。

## 循环与失败语义

```text
blocking > 0
  → record receipt
  → remain held(change_review_unaccepted)
  → expose findings to worker
  → next write changes artifact revision
  → old receipt expires
  → issue a new request
```

```text
blocking = 0
  → accept current receipt
  → surface advisories
  → closure eligible
  → automatic policy waits for fresh satisfied Stop
     or explicit policy runs achieve
```

review 调度失败、模型不可用、receipt 非法都不得改变 task assurance 或自动 waive。

## 宿主调度要求

宿主 adapter 至少需要：

- 以 request ID 做幂等键，同一 request 同时只运行一个 job。
- 持久化 `queued | running | failed_retryable | receipt_ready | accepted` 调度状态。
- reviewer 自身会话携带 recursion guard，不能再次调度同一个 review。
- 使用稳定 launcher；不要把长会话绑定到可能被升级删除的版本化插件缓存目录。
- Stop 只查询/触发调度，不无限等待后台 reviewer。
- reviewer 不可用时明确报告 capability 缺失并保持 task held。

调度状态属于宿主，不进入 task schema；taskloop 只持久化 task facts 和 review receipts。

## 落地顺序

| 优先级 | 纵向切片 | 预计工作量 | 验证结果 |
|---|---|---:|---|
| P0 | request projector、canonical request ID、只读 CLI | 0.5 天 | 相同 revision 幂等；写入后 ID 改变 |
| P0 | receipt schema、导入、findings 派生、binding 校验 | 1 天 | blocking 保持 held；clean 变 eligible |
| P1 | workloop capability handoff 文本和 adapter contract | 0.5 天 | 无特定 skill 名泄漏到 core |
| P1 | 外部 host adapter：解析、去重、重试、递归保护 | 1–2 天 | 相同 Stop 不产生重复 job |
| P1 | ledger、advisory、失败信息和最终报告 | 0.5 天 | 完整审计链可重放 |
| P2 | 废弃手填 finding counts 的旧 review 接口 | 0.5 天 | 迁移和兼容测试通过 |
| **总计** | | **4–5 天** | |

先做 request + receipt 的单仓纵向切片，再连接一个 fake adapter，最后才连接真实 review
skill。不要先建设通用 scheduler。

## 正式实现验收场景

1. 打开 `critical + strong criterion` 任务并使 criterion satisfied。
2. `review-request` 返回 `second_model` request。
3. 相同状态重复调用得到相同 request ID。
4. fake adapter 返回一个 blocking finding，任务保持 held。
5. 修复写入使旧 receipt 失效并产生新 request ID。
6. fake adapter 返回新 revision 的零 blocking receipt，closure 变为 eligible。
7. 旧 request、错误 task/revision、低等级 reviewer 和伪造计数全部被拒绝。
8. 重复 Stop 不启动重复 job。
9. reviewer 失败时 task 保持 active/held，hook 协议自身不以 code 1 崩溃。
10. advisory findings 进入 ledger 和最终 closeout。

## 方案比较与停止条件

- **taskloop 直接调用 skill**：耦合宿主、破坏可移植性，并放大 hook 生命周期问题，淘汰。
- **只在 workloop 文本里提醒 agent 调 skill**：实现便宜但不可确定去重，receipt 仍可能靠手填；可作过渡，不是终态。
- **结构化 request/receipt + host adapter**：满足职责、可移植和审计要求，当前最佳。
- **通用事件总线或完整 agent scheduler**：能力更强但超出 kernel 边界，当前边际收益不足。

如果 taskloop 未来被明确收缩为单宿主、单 reviewer 产品，直接调用固定 reviewer 才可能优于
adapter；在当前多宿主、portable kernel 约束下，不应反转该选择。
