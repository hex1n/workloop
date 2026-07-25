# 06 分离文件系统 store(FS)

来源主体:`tests/filesystem-detached-authority.test.mjs`。fs receipt 适配器 +
分离 store 存放(store 数据在受管 home,根内只有 locator)。
具体措辞/错误码/枚举/数值按 README「语义不变式与旧世界任意值」默认规则为旧值锚。

**审计处置**([AUDIT-2026-07-25](AUDIT-2026-07-25.md)):3 保留 / 2 改写 / 3 出局。
**能力保留、形态重做**:"在非 Git 目录上跑循环"是真实需求;但 store 数据改为
住在根内(`<root>/.workloop/`),取消 home 托管与 locator(M3)。
改写:**FS-01**(store 在根内)、**FS-03**(根删除 = store 消失,不再留档)。
出局:**FS-05**(已删根仍可审计——这是 M3 显式接受的代价,留档改用 export)、
**FS-06**(locator 精确绑定整族,随 M3)、**FS-08**(证据通道,随 M1)。
保留:FS-02(控制路径不路由)、FS-04(嵌套根双向拒绝,世界性)、FS-07(种类冲突)。

### FS-01 显式根创建 store,数据就住在根内〔审计改写〕
来源:filesystem「explicit filesystem root creates a detached authority and
locator-only root with partitioned lifecycle」——**托管形态换血**:store 不再
托管在受管 home、根内也不再放 locator(随 M3)。
- 断言:无显式 root 声明的 open 拒绝(指路 Git worktree 或显式根);创建后
  store 完整住在 `<root>/.workloop/`(manifest + segments + snapshots + locks),
  受管 home 不再参与;**store id 不可从物理锚推导**(含随机成分,故复制体的
  id 相同而锚不同——这正是碰撞可检出的原因);genesis 记录物理锚;不相交
  claims 的第二节点共享同 store;join/suspend/resume/audit/log 生命周期完整可用。

### FS-02 控制路径永不路由
来源:filesystem「filesystem root claims never route Workloop control paths」
- 断言:`.` claim 下,locator 文件、旧运行时目录、不兼容归档目录作为目标
  一律以失败退出码拒绝。

### FS-03 移动保身份;删除即消失;同路径重建得新 store〔审计改写〕
来源:filesystem「same-object move keeps detached identity; deletion retains shard
and same-path recreation gets a new authority」——**"删除留档"半边已作废**:
store 住在根内,根没了 store 就没了(M3 显式接受的取舍)。
- 断言:根改名/移动后 store 随之移动,身份不变(物理锚同一对象),路径观察
  如实更新为 moved;**根被删除时其循环历史随之消失**——这是取舍不是缺陷,
  留档手段是事前显式 `export`(WT-13);同路径新建目录再 open → 全新 store id
  (新物理锚),不与已消失的旧 store 发生任何关联。

### FS-04 嵌套根双向拒绝
来源:filesystem「detached roots reject nested authority claims in either order」
- 断言:已认领根的子目录再认领 → 拒绝(overlaps existing);先认领子目录、
  再认领父目录 → 拒绝(contains existing);两种失败都不写 locator。

### FS-05 已删根仍可审计,只能经 store 选择器 abandon
来源:filesystem「deleted filesystem root remains auditable and can be abandoned
only by its bounded authority selector」
- 断言:根删除后按 store 选择器查询 routable=false(root_unavailable),
  audit integrity=pending;suspend 拒绝(需活体绑定)且零追加;abandon 放行
  → 节点 terminal,日志记录 node_terminal。

### FS-06 locator 必须逐字节绑定其日志认领
来源:filesystem「locator must exactly bind its ledger attachment and default Hook
mode fails open」「orphaned and staged locators reject open before creating
authority records」
- 断言:伪造 claim token 的 locator(digest 自洽)→ routable=false
  (locator_unavailable),open 拒绝(attended recovery)且零追加;store 目录
  被删后原根 open 拒绝(attended recovery)不重建;只有 staged 行的 locator →
  拒绝(incomplete locator claim);空 locator → 拒绝(no claim record);
  三者都不创建任何新 store;证据通道对不可路由根释放并诊断,零记录。

### FS-07 fs store 无 Git 动词面;根内 git init 是 store 种类冲突
来源:filesystem「a Git initialization inside a claimed filesystem root is an
authority-kind conflict and filesystem exposes no Git operation surface」
- 断言:receipt(git)动词对 fs store 拒绝(unavailable for detached);认领
  后根内出现 `.git` → 一切动词拒绝并诊断种类冲突。

### FS-08 fs 证据通道正常记录,不主张执行权
来源:filesystem「filesystem Hook records receipts without claiming host execution
authority」
- 断言:claim 范围内目标的证据事件落 store 一条 operation 记录;stdout 为空、
  零阻断。
