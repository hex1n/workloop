# 08 宿主面(HF)

来源主体:git-main/git-partitioned/filesystem 的 hook 用例、
`tests/provider-installer.test.mjs`、`tests/skills.test.mjs`。
公理:宿主拥有执行审批;证据通道只记账,唯显式 deny 模式可拒。
具体措辞/错误码/枚举/数值按 README 默认规则为旧值锚;例外:证据通道释放的
**退出码 0 + 空 stdout** 是宿主协议〔冻结〕。

## 证据通道

### HF-01 证据事件按目标路由,默认模式永不阻断
来源:git-main「current Git Hook receipts are target-routed and default nudge stays
nonblocking」
- 断言:PreToolUse/PostToolUse 证据落目标所属节点(operation intent + tool
  completion 配对,operation id 关联);stdout 为空、exit 0;从不输出执行
  否决(permissionDecision 类字段不存在)。

### HF-02 不可路由目标释放并诊断,零记录
来源:git-main(unreadable/control 目标)、git-partitioned(control 目标)、
filesystem(forged locator)
- 断言:仓外、控制路径、不可路由 store 的目标:exit 0 + 空 stdout〔冻结〕、
  stderr 一行固定前缀诊断(前缀措辞为旧值锚:provider evidence unavailable;
  host retains execution authority;不变式是**存在稳定可 grep 的单行前缀**),
  日志零增长;多目标 patch 含仓外目标 → 整体释放并诊断,不部分记账。

### HF-03 跨 store 目标各归各账,分片隔离
来源:git-partitioned「external and multi-authority Hook targets are target-owned
and shard-local」
- 断言:cwd 在 A 仓、目标在 B 仓 → 证据落 B 的 store,A 零增长;一次多目标
  patch 跨 A、B → 各自 store 恰一条,节点归属各自正确;无管辖目标释放。

### HF-04 唯显式 deny 可拒,配置过期/不支持时释放
来源:provider-installer「only explicit deny PreToolUse rejects an unsupported Hook
profile」「Stop releases before validating stale Hook mode or profile configuration」
- 断言:observe/nudge 遇到不支持的 profile/过期配置 → 释放 + 诊断 + 零记录;
  显式 deny 同情形 → 拒绝;Stop 事件在校验配置之前先释放(永不困住宿主)。

### HF-05 Stop 通道分档:release-only 档必须快速释放且不启动长 criterion
来源:windows「[W06] codex-safe Stop releases without launching a long criterion」
(语义平台无关化)
- 断言:release-only 档的 Stop:限时内返回、空 stdout、不 spawn criterion、
  节点状态零变化。

## 安装与打包(新世界等价物)

### HF-06 安装幂等、版本化激活、从不改写宿主 Hook 配置
来源:provider-installer「provider installer activates an exact current release
without mutating valid host Hooks」「…never rewrites the source repository Git hook
configuration」、windows(repeatable install)
- 断言:重复安装幂等;升级切换 release 原子(激活清单指向唯一现行版本,旧
  版本清理);宿主既有 Hook 配置与源仓 git hooks 字节不变;安装锁遇已死持有
  者可收割(引用 LK-04 的 owner 记账)。

### HF-07 安装前置拒绝歧义 Hook 配置
来源:provider-installer「provider installer refuses stale or ambiguous Hook
profiles before staging skills or activating a shim」
- 断言:发现无法证明属于本运行时、或 profile 歧义的既有 handler → 安装在落
  任何资产前拒绝并诊断;只替换可证明自有的资产。

### HF-08 打包闭包只含现行运行时
来源:provider-installer(package closure)、skills(current Contract material)
[hygiene] 旧断言为源码文本检查;新世界以自己的打包清单测试替代,不变式保留:
发行物不含退役模块,skill 文本只引用公开动词表中的动词,文档化的判据契约与
运行时实现一致。

### HF-09 skill 工作流每步有显式完成条件
来源:skills「each Skill workflow has an explicit completion condition for every step」
[hygiene] 形式检查随新 skill 文本重建;不变式保留:随发行的工作流文本每步
可判定完成。
