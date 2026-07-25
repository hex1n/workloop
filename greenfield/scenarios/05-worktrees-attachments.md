# 05 工作树与绑定(WT)

来源主体:`tests/git-main-authority.test.mjs`、`tests/git-linked-worktree-authority.test.mjs`、
`tests/git-exclusive-worktree-authority.test.mjs`、`tests/attachment-recovery-authority.test.mjs`。
具体措辞/错误码/枚举/数值按 README「语义不变式与旧世界任意值」默认规则为旧值锚。

## 路由矩阵

### WT-01 目标优先路由覆盖 tracked/untracked/ignored/未创建路径
来源:git-main「current Git tracer selects containment and replays…」、
git-partitioned「tracked state never selects authority…」
- 断言:claim 范围内四类目标(已跟踪、未跟踪、被忽略、尚不存在)全部路由到
  同一节点;Git tracked 状态从不参与 store 选择。

### WT-02 别名、大小写、嵌套仓、仓外与控制目标各归其位
来源:git-main「target-first routing covers canonical aliases, case, nesting,
external and control targets」
- 断言:符号链接别名路由等价物理路径;大小写变体在 win32/darwin 路由等价、
  linux 拒绝;仓外目标拒绝;git 控制文件、运行时控制目录、投影文件作为目标
  一律以失败退出码拒绝且零日志变化;嵌套子仓是独立 store(不路由父仓节点);
  整仓复制体 → routable=false,reason=attachment_collision,且查询不改副本字节。

## 主/链接工作树

### WT-03 主与链接工作树共享 store,attachment 各自独立
来源:git-linked「main and linked worktrees share authority while target routing
preserves attachment identity across move」
- 断言:两处 open 得同 store id、不同 attachment id、不同节点 id;各自目标
  路由到各自节点;同一宿主 operation 落在两个节点各一条证据。

### WT-04 工作树移动保持 attachment 身份,只更新路径观察
来源:git-linked(worktree move)、git-main「main worktree move preserves…」
- 断言:`git worktree move` / 主仓改名后,目标照常路由,attachment id 与节点
  id 不变;path_status=moved,claimed 与 observed 根路径分别如实。

### WT-05 移除/prune 保留旧节点真相,同路径重建不复用身份
来源:git-linked「remove, prune, and same-path recreation retain old tasks without
reusing attachment identity」
- 断言:worktree remove → 该 attachment unavailable(git_admin_unavailable),
  节点记录保留;同路径新 worktree 的 open 得新 attachment 新节点;旧 attachment
  永久 unavailable(anchor_mismatch);prune 同理;目录清单如实列出全部代际。

### WT-06 复制的 locator 不能在别的活体锚上路由旧历史
来源:git-linked「a copied locator cannot route old task history at another live
Git admin anchor」、filesystem「copied locator is never accepted as an automatic move」
- 断言:把 locator 复制进另一 worktree/根后,查询识别出同 store 同 attachment
  但 routable=false,reason=attachment_collision;原根消失也不自动转正。

## exclusive placement

### WT-07 显式 exclusive 创建:一次开出 worktree+分支+节点,不动调用方现场
来源:git-exclusive「explicit exclusive placement creates one linked attachment…」
- 断言:open 携带 placement=exclusive + worktree 路径 + branch + base:创建
  linked worktree(HEAD=base、branch 正确),主仓 HEAD 与调用方 cwd 不变;
  日志开头为 genesis → placement_intent → placement_ready,结尾 node_opened;
  exclusive attachment 上二次 open 拒绝;主仓 partitioned open 照常。

### WT-08 pending placement intent 绑定完整请求,有公开放弃出口
来源:git-exclusive「pending exclusive creation binds the complete request and never
adopts partial Git state」+ new: 设计反馈(旧世界缺出口)
- 前置:worktree 创建注定失败(父路径是文件)
- 断言:失败后留 pending intent(含 request digest、会话、action);原样重跑
  → 提示 attended recovery;改任何入参重跑 → 拒绝(conflicts with durable
  intent);intent 不重复追加;**放弃动词(名〔新定〕,旧世界无此出口)以
  user 溯源幂等放弃该 intent,此后新 exclusive open 不再被封锁**;从不吸纳
  部分 Git 状态。

### WT-09 选择既有 worktree 必须显式验证 branch 与 base
来源:git-exclusive「existing linked worktree selection verifies explicit branch
and base before any task append」
- 断言:branch 不匹配 → 拒绝且 store 零创建;匹配 → 节点绑定该 branch/base。

### WT-10 exclusive 输入显式有界、幂等,从不猜测清理
来源:git-exclusive「exclusive placement input is explicit, bounded, idempotent…」
「…rejects invalid claims and nested Git worktrees before durable or Git side effects」
「exclusive worktree removal preserves unavailable task truth…」
- 断言:缺 branch/base、partitioned 带 worktree 路径 → 拒绝零副作用;claims
  超界拒绝零副作用;目标路径嵌套于其他 worktree/无关仓 → 拒绝且不创建;
  同 command_id 重放幂等(intent/ready 各一条);工作树被删后节点 unavailable
  但 branch 永不被清理,原样重跑要求 attended recovery。

## attachment 恢复

### WT-11 复制体经显式 reattach 换代推进,epoch CAS 保护
来源:attachment-recovery「filesystem copied identity enters collision, explicit
reattach advances epoch, and command replay is idempotent」
- 断言:复制根 → 碰撞;reattach 要求调用方提交**双证明——期望 epoch +
  期望 locator digest**(选项名为旧值锚,双证明 CAS 是语义)+ user 溯源 →
  复制体转正(epoch+1),locator 换代;重放幂等;原根从此不可路由。

### WT-12 fork-identity 开新 store,不带走旧节点
来源:attachment-recovery「filesystem identity fork creates a fresh detached
authority without copying source tasks」
- 断言:fork 得新 store id 新 attachment id、零节点;重放幂等;改 reason 重放
  拒绝(fork replay input differs);源根不受影响。

### WT-13 export 是 maintenance 锁下的字节精确出版,禁止落在活体根内
来源:git-main「authority export is a maintenance-locked, byte-exact publication
outside live roots」
- 断言:目标在活体根内 → 拒绝零创建;合法目标 → 日志字节逐字节相同 +
  manifest(store id、sha256、granted_by=user)。

### WT-14 不兼容旧状态:先不透明归档,后开工;归档过期即再封锁
来源:git-main「hard cut refuses incompatible state until an exact opaque archive
proves the current bytes」「incompatible repository artifacts can only be copied
opaquely with explicit user provenance」
- 断言:根内存在旧运行时状态 → open 拒绝并指路归档动词;归档要求 user 溯源
  (self 拒绝零创建),字节不透明复制 + manifest sha256,源文件原位保留;
  归档后 open 放行;旧状态在归档后再被改动 → 一切动词重新拒绝。

### WT-15 locator/append 冲突从不伪造成功,可显式恢复
来源:git-main「append and locator conflicts never fabricate a successful format open」
- 断言:locator 位被外来文件占据 → open 失败,日志停在 intent 前缀,状态
  reason=attachment_pending;他人 open 被 pending 拒绝且零日志增长;移除
  障碍后原 command 重跑走完(幂等续行);store 目录位被文件占据 → append
  失败且不留半个 locator。
