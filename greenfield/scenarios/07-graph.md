# 07 图与边(GE)

来源:new: 设计稿·图模型(旧世界无对应物;CC-07 的节点独立性是本族前提)。
本族错误码 token(如依赖未满足)均〔新定〕,切片 3 定版冻结;区分语义先行。

**审计处置**([AUDIT-2026-07-25](AUDIT-2026-07-25.md)):6 条**全数保留**。
另记:审计删除 M7 会话唯一性,直接解锁本族——旧世界"一会话一活动节点"
禁止一个 agent 同时推进 DAG 的多个节点,与图目标正面冲突。

### GE-01 depends_on 在开启时声明、校验、冻结
来源:new: 设计稿·图模型
- 断言:`open --depends-on <loop_id>[@<digest>]` 可重复;上游必须在同一 store、
  非自身、非 abandoned;构造 A→B→A 环在 open 时拒绝且零追加;边一经开启不可
  amend。

### GE-02 上游未 achieved 时下游 judgment 拒绝
来源:new: 设计稿·图模型
- 断言:B 依赖 A;A 未终结时 B 的 satisfied judgment 被拒,错误可判别为
  依赖未满足(token〔新定〕),B 的 observation 照常落账;A achieved 后 B
  重新 judgment 放行。

### GE-03 pinned digest 逐字匹配上游认证
来源:new: 设计稿·图模型
- 断言:`@digest` pin 过的边,上游 achieved 的 certification digest 不匹配 →
  依赖未满足;未 pin 的边任意 achieved 即可。

### GE-04 git store 中上游认证 commit 必须是下游 HEAD 祖先
来源:new: 设计稿·图模型(复用 GR-06 机制)
- 断言:A achieved 于 commit X;B 的工作分支不含 X → B judgment 拒绝;
  合入 X 后放行。

### GE-05 ready 是只读前沿投影,不是调度
来源:new: 设计稿·图模型
- 断言:`ready` 列出依赖全满足的活动节点;调用零持久化字节变化(引用
  LK-11);A achieved 前 B 不在 ready,之后在;runtime 不存在任何主动派发
  路径。

### GE-06 图场景端到端跨会话
来源:new: 设计稿·交付切片 3 完成判据
- 动作:A、B 不相交 claims,B 依赖 A;交错推进两者的 SL-03 闭环,中途换
  session
- 断言:B 先 judgment → DEPENDENCY_UNMET;A achieved;新 session `ready`
  见 B;B achieved 且祖先检查生效;全日志重放通过(LK-07)。
