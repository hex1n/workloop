# 02 单节点循环(SL)

来源主体:旧 certify 流(`tests/git-task-receipts.test.mjs`、
`tests/filesystem-detached-authority.test.mjs`)+ 设计稿新增的循环状态机。
旧世界认证失败零持久化;新世界失败落 observation——本族是绿地最大的净新增。
具体措辞/错误码/枚举/数值按 README「语义不变式与旧世界任意值」默认规则为旧值锚。

**审计处置**([AUDIT-2026-07-25](AUDIT-2026-07-25.md)):13 条**全数保留**。
本族是绿地核心,几乎无旧世界继承。

## 开启

### SL-01 open 需要显式 command id、真实会话身份与溯源
来源:git-main「current open requires replayable command provenance…」、
git-partitioned「…host session required」
- 断言:缺 command_id 拒绝(explicit command id),缺会话身份拒绝(real host
  session identity),缺 reason/granted-by 拒绝;三者任一失败时 store 零创建。

### SL-02 claims 必须是结构化仓库相对路径,有界
来源:git-partitioned(`--files` 未知选项、glob 拒绝)、git-exclusive「…rejects
invalid claims…」
- 断言:glob(`alpha/**`)拒绝并诊断需要结构化仓库相对路径;claims 数量超过
  **文档化的有限上限**拒绝且零副作用(上限数值为旧值锚:64;不变式是上限
  存在、文档化、超限时先拒绝后副作用);旧世界遗留选项不复活。

## 三轮修复闭环(验收主场景)

### SL-03 跨会话三轮修复循环
来源:new: 设计稿·测试策略(整合旧 certify 语义)
- 前置:open 携带 goal、claims、criterion、rounds=3 预算
- 动作与断言逐步:
  1. `next` 返回 implement directive;状态不变时重复调用逐字节相同(幂等)。
  2. host 修改制品、取得 receipt;`observe` 触发 judgment,criterion 输出
     `WORKLOOP_VERDICT {verdict: "unsatisfied", failures: [...]}` → 落
     observation 记录(含 failure identifiers、criterion digest、artifact
     checkpoint),decision = repair。
  3. 进程退出,另一 session `join` 后 `next` → round 2 repair directive,
     **携带 round 1 的 failure signature**。
  4. 第二次失败但 artifact checkpoint 变化 → decision = repair(允许继续)。
  5. 第三次 verdict satisfied 且 receipt 校验通过 → terminal: achieved。
  6. 再次 `next` 只返回同一 terminal decision,零新记录。

### SL-04 progress signature 只在失败同且制品无实质变化时判重复
来源:new: 设计稿·默认策略 §5.1
- 断言:signature = H(artifact checkpoint + criterion digest + 规范化 failure
  identifiers + receipt digest);同 signature 连续达阈值 → decision = stuck;
  制品变化或 failure 变化即不判重复;criterion 沉默(无 failures)时 signature
  为 null,null 不参与相同判定。

### SL-05 预算耗尽进入可恢复挂起,不是 abandoned
来源:new: 设计稿·默认策略
- 断言:rounds 用尽 → suspended: out_of_budget;`resume` + `amend` 加预算后
  循环继续;挂起与终结记录在任何日志容量状态下可写(引用 LK-13)。

## 判断协议

### SL-06 satisfied judgment 终结为 achieved 并绑定 receipt
来源:git-task-receipts「certify achieves a Git task only while its clean receipt
remains landed」、filesystem「certify achieves a filesystem task without a Git receipt」
- 断言:git store:achieved 绑定 clean receipt 的 commit oid;fs store:
  receipt 为文件 digest 集,commit oid 为 null;achieved 后节点不可再变更。

### SL-07 judgment 的 CAS 是节点级的
来源:new: 设计稿·一致性模型(修复旧世界全局 sequence CAS 缺陷)
- 前置:节点 A(claims src)与节点 B(claims docs)并发
- 动作:A 的 criterion 执行窗口内,B 被 join/receipt/observe 触碰
- 断言:A 的 judgment 正常完成;只有 A 自身 revision 变化才拒绝
  (judgment stale);B 的一切活动对 A 零影响。

### SL-08 indeterminate 不消耗轮次判重,进入 collect_evidence
来源:new: 设计稿·默认策略(承接旧 tri-state 的 indeterminate 语义)
- 断言:criterion 超时/崩溃/非法输出 → verdict indeterminate;decision =
  collect_evidence;不产生 failure signature,不累计 stuck。

### SL-09 criterion 由运行时亲自执行,超时杀全进程树
来源:windows「criterion timeout terminates the child…」「…fallback terminates
descendants…」(语义平台无关化)
- 断言:criterion 以只读契约 spawn,timeout 后父进程与其派生的后代进程全部
  终止(首次树杀失败时降级路径仍然全灭);判定 verdict indeterminate,
  execution_error = timeout;耗时接近 timeout 而非挂死。

### SL-10 verdict 通道独占:JSON 末行优先,tri-state 退出码兜底
来源:new: 设计稿·验证协议
- 断言:stdout 末行合法的 verdict 前缀行(前缀 token `WORKLOOP_VERDICT`
  〔新定,切片 2 定版冻结〕)以其为准;无 JSON 时按 tri-state 退出码兜底
  (三态区分是语义,承载各态的具体退出码数值〔新定〕);两者矛盾按
  indeterminate 处理并诊断;failures 有界截断,原始输出只存 digest 与有界 tail。

## 生命周期

### SL-11 suspend/resume/abandon 要求参与会话与溯源
来源:git-partitioned「explicit task selection and lifecycle mutations cannot cross
target attachment or session」、authority-state 旧重放规则
- 断言:非参与会话的 suspend/resume/abandon 拒绝(participant session);跨
  attachment 指定节点拒绝;suspend→resume 状态往返正确;abandon 后节点
  terminal,claims 释放。

### SL-12 terminal 节点拒绝一切后续变更且不触碰外部状态
来源:git-task-receipts「receipt commands reject a terminal task before changing
the Git index or HEAD」
- 断言:对 terminal 节点的 receipt/observe/amend 以失败退出码拒绝,且 Git
  index、HEAD、工作区完全不变(先校验后副作用)。

### SL-13 amend 作废受影响的旧 judgment 并记录溯源
来源:new: 设计稿·领域模型
- 断言:amend criterion 后,旧 observation 保留但其 judgment 标记 stale;
  下一轮 judgment 用新 criterion digest;amend 需要 user 溯源。
