# 03 claims 与并发(CC)

来源主体:`tests/git-partitioned-multitask-authority.test.mjs`。
具体措辞/错误码/枚举/数值按 README「语义不变式与旧世界任意值」默认规则为旧值锚。

**审计处置**([AUDIT-2026-07-25](AUDIT-2026-07-25.md)):5 保留 / 1 改写 / 2 出局。
改写:**CC-04**(删会话唯一性与会话路由判据,只留参与者记账——会话唯一性
与图目标冲突,见 M7)。出局:**CC-06**(随 M2 目标优先路由)、**CC-08**(随
M1 证据通道)。WT-01 的"claims 范围内路径归属该节点"语义并入 CC-02。

### CC-01 一个 attachment 承载多个不相交节点
来源:git-partitioned「one attachment hosts disjoint tasks…」
- 断言:同仓两个不相交 claims 的 open 共享 store 与 attachment,节点 id 不同;
  目录清单同时列出(1 attachment, 2 loops)。

### CC-02 claims 重叠一律拒绝且零日志增长
来源:git-partitioned(overlap/nested/root overlap)、filesystem(overlap)
- 断言:嵌套(alpha 与 alpha/nested)、相同、根claim(.)与任何子 claim——
  重叠 open 全部拒绝(write scope overlap),日志长度不变;suspended 节点
  **保留** claims(对其范围的新 open 仍拒绝);abandon 后同范围可重新 open。

### CC-03 claim 身份是规范化物理身份:符号链接与大小写别名闭合
来源:git-partitioned「canonical claim identity closes symlink and case aliases…」
- 断言:经符号链接开出的 claim 记录为物理路径;物理重叠经别名仍拒绝;
  win32/darwin 上大小写变体重叠拒绝(linux 大小写敏感放行);claims 排序
  确定性、与 locale 无关(code unit 序);字面目录名 `...` 不做展开,按
  普通目录处理。

### CC-04 会话身份只是 provenance,不限制并发也不参与路由〔审计改写〕
来源:git-partitioned(session uniqueness、session_task_mismatch)——**原断言
已作废**,旧世界的"一会话一活动节点"只为让旁路证据无歧义归属而存在(审计 M7),
且与图正面冲突。
- 断言:**一个会话可以同时持有并推进多个活动节点**(图工程常态,GE 族前提);
  每个变更命令记录发起会话,open 记录创建者、join 记录参与者,均可查;
  生命周期变更要求发起者是该节点的参与会话(SL-11),这是**授权**判据而非
  **路由**判据;寻址一律显式(store + loop id),不存在"按会话猜节点"的路径。

### CC-05 join 增加参与会话,溯源必填
来源:git-partitioned(join-beta)、git-linked(join-moved-replay)
- 断言:join 后 participant_session_ids 追加新会话;已在其他节点活动的会话
  join 拒绝;join 也是显式变更命令(可触发投影重建)。

### CC-06 仓库根目标必须显式根 claim 才可路由
来源:git-partitioned「repository-root routing requires an explicit root claim」
- 断言:目标为仓库根且无 `.` claim → task_scope_unclaimed(显式指定节点 id
  也不例外);open 的 target 必须落在其 canonical claims 内(root 目标 + 子
  claim 拒绝);`.` claim 的节点可路由任意仓内目标。

### CC-07 不相交并发全程互不作废(图的地基)
来源:new: 设计稿·一致性模型(旧世界此处是缺陷)
- 动作:A、B 不相交节点在彼此的整个生命周期(receipt、observe、judgment 窗口)
  内交错活动
- 断言:双方各自走完 SL-03 闭环,零 stale、零互相拒绝。

### CC-08 同一宿主 operation id 在两个参与会话各留一条证据
来源:git-partitioned「same host operation id from two participant sessions keeps
both receipts」
- 断言:两条 operation 证据都在,按 session_id 区分,不去重不覆盖。
