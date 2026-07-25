# 04 Git receipt(GR)

来源主体:`tests/git-task-receipts.test.mjs`。receipt 动词属 git receipt 适配器;
clean/uncertain 二态语义与任务范围隔离全部保留。
具体措辞/错误码/枚举/数值按 README「语义不变式与旧世界任意值」默认规则为旧值锚。

**审计处置**([AUDIT-2026-07-25](AUDIT-2026-07-25.md)):7 条**全数保留**。
receipt 的 clean/uncertain 二态是世界性质(运行时不控制 index,只能诚实报告);
GR-01 同时是 claims 得以保留的理由——没有 claims,receipt 无法界定"我的路径"。

### GR-01 任务范围 stage 保留他人 index 条目,commit 只带任务路径
来源:git-task-receipts「task-scoped stage preserves another task index entry and
commit leaves it staged」
- 前置:节点 A(src)与外部已 `git add docs/b.txt`
- 断言:A 的 stage 后 index 同时含两者,receipt 判 clean=false/status=uncertain
  (index 里有非任务内容即不洁);A 的 commit 只提交 src/a.txt,docs/b.txt
  留在 index;commit receipt 同样 uncertain。

### GR-02 clean stage 因果绑定 clean commit
来源:git-task-receipts「a clean stage receipt causally binds a clean task-scoped commit」
- 断言:干净前置下 stage.clean=true;commit.clean=true 且
  prior_head == parent_oid、diff_paths == 任务路径集。

### GR-03 stage 之后的宿主 index 突变使 commit receipt 退化为 uncertain
来源:git-task-receipts「a post-stage host index mutation persists an uncertain
commit receipt」
- 断言:stage clean 后外部 add 其他文件 → commit 仍成功(宿主优先)但
  receipt.clean=false/uncertain;外部内容不被吞入提交。

### GR-04 直接 Git 竞争不失败宿主操作,只如实降级 receipt
来源:git-task-receipts「a direct Git race keeps host success but records an
uncertain receipt」
- 断言:open 前已有外部 staged 内容时,stage 成功但 receipt uncertain。
  诚实降级,永不伪造 clean。

### GR-05 receipt 排除控制平面路径
来源:git-task-receipts「repository-root receipts exclude Workloop control and
incompatible-archive paths」
- 前置:`.` claim 节点,仓内存在运行时控制目录与不兼容归档目录
- 断言:stage/commit 的路径集只含任务数据,控制与归档路径永不入 receipt,
  保持 untracked。

### GR-06 achieved 要求 clean receipt 仍然落在 HEAD 祖先链上
来源:git-task-receipts「certify achieves a Git task only while its clean receipt
remains landed」
- 断言:judgment satisfied 时校验 receipt commit 是 HEAD 祖先;achieved 记录
  绑定该 commit oid。

### GR-07 receipt 之后的任务路径漂移拒绝 achieved
来源:git-task-receipts「certify rejects a receipt whose task paths were subsequently
changed」「certify rejects unstaged and staged task-path drift…」
- 断言:clean receipt 后任务路径出现 已提交的后续变更 / 未暂存漂移 / 已暂存
  漂移,三种情形 judgment 一律拒绝(task paths changed after the clean receipt
  commit),且只看**任务路径**——非任务路径的漂移不影响(引用 SL-07)。
