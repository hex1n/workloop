# 场景覆盖表

语料里**每一条未出局的场景**,以及它在哪里被满足。两种去处,没有第三种:

- 一个**测试文件**——那条场景的断言住在里面;
- 一条 **DEBT 编号**——它被明确推迟了,`DEBT.md` 里记着为什么。

`tests/spec-corpus.test.mjs` 用门禁压着这张表:漏一条、指向不存在的文件、指向
不存在的欠账编号,都会红。

**它证明的是什么,不证明什么。** 它证明每条场景都有一个明确的、活着的去处——
上一轮"声称 WN-04 全绿而它根本没有测试"这类事,从此进不来。它**不**证明那个
文件里的断言真的覆盖了那条场景的语义;那仍然靠评审和非空验证。把它当成"有没有
人认领"的账,不是"认领得对不对"的证明。

出局的场景不在表内——它们的去处是 [AUDIT](scenarios/AUDIT-2026-07-25.md)。


## 01-log-kernel

| 场景 | 满足于 |
| --- | --- |
| **LK-01** 锁分类有全序,违序与重入即抛 | `tests/locks.test.mjs` |
| **LK-02** 单写者互斥带所有者记账,跨进程生效 | `tests/locks.test.mjs` |
| **LK-03** 保留的 owner 元数据字段禁止伪造 | `tests/locks.test.mjs` |
| **LK-04** 释放失败毒化进程内后续锁操作,且不销毁现场 | `tests/locks.test.mjs` |
| **LK-05** 事务相位固定,任一相位失败留下如实的部分状态收据 | `tests/store-crash.test.mjs` |
| **LK-07** 重放确定性(性质测试) | `tests/graph.test.mjs` |
| **LK-08** hash 有效但语义非法的记录在重放时拒绝 | `tests/record.test.mjs` |
| **LK-09** 命令幂等:同 command_id 同入参重放返回原结果,零新记录 | `tests/store.test.mjs` |
| **LK-10** 不完整写入自动恢复;真损坏才失败关闭〔切片 1 §4.1 修订〕 | `tests/store.test.mjs` |
| **LK-11** 只读动词零持久化字节变化 | `tests/cli.test.mjs` |
| **LK-12** 投影是可弃缓存,损坏不毒化、删除可重建、绝不静默改写 | `tests/store-snapshot.test.mjs` |
| **LK-13** 段轮转封印,终结动词永远可写 | `tests/store.test.mjs` |
| **LK-14** 崩溃注入:任意写入中断点恢复后不重复、不丢失 | `tests/store-crash.test.mjs` |

## 02-single-loop

| 场景 | 满足于 |
| --- | --- |
| **SL-01** open 需要显式 command id、真实会话身份与溯源 | `tests/loop-guards.test.mjs` |
| **SL-02** claims 必须是结构化仓库相对路径,有界 | `tests/loop-guards.test.mjs` |
| **SL-03** 跨会话三轮修复循环 | `tests/loop-e2e.test.mjs` |
| **SL-04** progress signature 只在失败同且制品无实质变化时判重复 | `tests/loop-e2e.test.mjs` |
| **SL-05** 预算耗尽进入可恢复挂起,不是 abandoned | `tests/loop-e2e.test.mjs` |
| **SL-06** satisfied judgment 终结为 achieved 并绑定 receipt | `tests/receipt.test.mjs` |
| **SL-07** judgment 的 CAS 是节点级的 | `tests/loop-e2e.test.mjs` |
| **SL-08** indeterminate 不消耗轮次判重,进入 collect_evidence | `tests/domain-policy.test.mjs` |
| **SL-09** criterion 由运行时亲自执行,超时杀全进程树 | `tests/loop-e2e.test.mjs` |
| **SL-10** verdict 通道独占:JSON 末行优先,tri-state 退出码兜底 | `tests/loop-e2e.test.mjs` |
| **SL-11** suspend/resume/abandon 要求参与会话与溯源 | `tests/loop-guards.test.mjs` |
| **SL-12** terminal 节点拒绝一切后续变更且不触碰外部状态 | `tests/loop-e2e.test.mjs` |
| **SL-13** amend 作废受影响的旧 judgment 并记录溯源 | `DEBT:D-04` |

## 03-claims-concurrency

| 场景 | 满足于 |
| --- | --- |
| **CC-01** 一个 attachment 承载多个不相交节点 | `tests/claims.test.mjs` |
| **CC-02** claims 重叠一律拒绝且零日志增长 | `tests/graph.test.mjs` |
| **CC-03** claim 身份是规范化物理身份:符号链接与大小写别名闭合 | `tests/claims.test.mjs` |
| **CC-04** 会话身份只是 provenance,不限制并发也不参与路由〔审计改写〕 | `tests/claims.test.mjs` |
| **CC-05** join 增加参与会话,溯源必填 | `tests/loop-guards.test.mjs` |
| **CC-07** 不相交并发全程互不作废(图的地基) | `tests/graph.test.mjs` |

## 04-receipts-git

| 场景 | 满足于 |
| --- | --- |
| **GR-01** 任务范围 stage 保留他人 index 条目,commit 只带任务路径 | `tests/receipt.test.mjs` |
| **GR-02** clean stage 因果绑定 clean commit | `tests/receipt.test.mjs` |
| **GR-03** stage 之后的宿主 index 突变使 commit receipt 退化为 uncertain | `tests/receipt.test.mjs` |
| **GR-04** 直接 Git 竞争不失败宿主操作,只如实降级 receipt | `tests/receipt.test.mjs` |
| **GR-05** receipt 排除控制平面路径 | `tests/receipt.test.mjs` |
| **GR-06** achieved 要求 clean receipt 仍然落在 HEAD 祖先链上 | `tests/domain-policy.test.mjs` |
| **GR-07** receipt 之后的任务路径漂移拒绝 achieved | `tests/receipt.test.mjs` |

## 05-worktrees-attachments

| 场景 | 满足于 |
| --- | --- |
| **WT-02** 嵌套子仓是独立 store;整仓复制体判碰撞〔审计改写〕 | `tests/worktrees.test.mjs` |
| **WT-03** 主与链接工作树共享 store,attachment 各自独立 | `tests/site.test.mjs` |
| **WT-04** 工作树移动保持 attachment 身份,只更新路径观察 | `tests/site.test.mjs` |
| **WT-05** 移除/prune 保留旧节点真相,同路径重建不复用身份 | `tests/worktrees.test.mjs` |
| **WT-06** 复制的 store 不能冒充原身份,原根消失也不自动转正〔审计改写〕 | `tests/worktrees.test.mjs` |
| **WT-09** 选择既有 worktree 必须显式验证 branch 与 base | `DEBT:D-07` |
| **WT-13** export 是 maintenance 锁下的字节精确出版,禁止落在活体根内 | `tests/cli.test.mjs` |
| **WT-15** append 冲突从不伪造成功,原命令重跑幂等续行〔审计改写〕 | `tests/store.test.mjs` |

## 06-store-fs

| 场景 | 满足于 |
| --- | --- |
| **FS-01** 显式根创建 store,数据就住在根内〔审计改写〕 | `tests/site.test.mjs` |
| **FS-02** 控制路径永不路由 | `tests/site.test.mjs` |
| **FS-03** 移动保身份;删除即消失;同路径重建得新 store〔审计改写〕 | `tests/site.test.mjs` |
| **FS-04** 嵌套根双向拒绝 | `tests/site.test.mjs` |
| **FS-07** fs store 无 Git 动词面;根内 git init 是 store 种类冲突 | `tests/site.test.mjs` |

## 07-graph

| 场景 | 满足于 |
| --- | --- |
| **GE-01** depends_on 在开启时声明、校验、冻结 | `tests/graph.test.mjs` |
| **GE-02** 上游未 achieved 时下游 judgment 拒绝 | `tests/graph.test.mjs` |
| **GE-03** pinned digest 逐字匹配上游认证 | `tests/graph.test.mjs` |
| **GE-04** git store 中上游认证 commit 必须是下游 HEAD 祖先 | `tests/graph.test.mjs` |
| **GE-05** ready 是只读前沿投影,不是调度 | `tests/graph.test.mjs` |
| **GE-06** 图场景端到端跨会话 | `tests/graph.test.mjs` |

## 08-host-face

| 场景 | 满足于 |
| --- | --- |
| **HF-06** 安装幂等、版本化激活、从不改写宿主配置〔审计改写〕 | `DEBT:D-05` |
| **HF-08** 打包闭包只含现行运行时 | `tests/cli.test.mjs` |
| **HF-09** skill 工作流每步有显式完成条件 | `tests/cli.test.mjs` |

## 09-windows

| 场景 | 满足于 |
| --- | --- |
| **WN-01** 安装可重复,cmd/Windows PowerShell/pwsh 三壳可用 | `DEBT:D-05` |
| **WN-02** 路径变体:空格、Unicode、盘符大小写、junction | `tests/platform.test.mjs` |
| **WN-04** criterion 超时全进程树终止,含降级路径 | `tests/platform.test.mjs` |
| **WN-05** criterion 租约:死亡持有者按声明的 deadline 等待后回收 | `tests/platform.test.mjs` |
| **WN-06** 安装锁收割已死持有者 | `DEBT:D-05` |

## 语料自身的一处矛盾(留档)

**CC-05** 仍带着"已在其他节点活动的会话 join 拒绝"这一句,而它正是审计改写
**CC-04** 时随 M7 删掉的会话唯一性——旧世界"一会话一活动节点"与图目标正面冲突。
实现按 CC-04 的改写走:**一个会话可以同时推进多个节点**。CC-05 的那半句作废,
其余(join 追加参与者、溯源必填、join 是显式变更命令)有效。

