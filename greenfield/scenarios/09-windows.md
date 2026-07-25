# 09 Windows 语义(WN)

来源主体:`tests/windows.test.mjs`。注意:该文件约半数用例针对旧运行时动词面
(`open --repo --criterion-file --risk` 等),此处只翻译平台语义,不翻译动词。
全族 `skip: 非 win32`,但路径规范化断言(WN-02)在三平台都跑其可跑子集。
具体措辞/错误码/枚举/数值按 README「语义不变式与旧世界任意值」默认规则为旧值锚。

### WN-01 安装可重复,cmd/Windows PowerShell/pwsh 三壳可用
来源:windows「Windows install is repeatable and exposes workloop to cmd and both
PowerShell editions」
- 断言:含空格与 CJK 字符的 home 路径下安装两次幂等;升级后激活清单换代且
  运行时目录只剩现行版本;三种 shell 各自能调用 CLI 并得到正确契约版本。

### WN-02 路径变体:空格、Unicode、盘符大小写、junction
来源:windows「[W01] genesis and replay survive spaces, Unicode, and drive-case
path variants」、git-main/git-partitioned(win32 分支)
- 断言:含空格 + CJK 的仓路径全流程可用;盘符大小写变体路由等价;创建过程
  无 `.tmp` 残留;win32 下目录别名用 junction,路由等价(引用 WT-02、CC-03
  的 win32 分支)。

### WN-03 生成的 hook 命令带正确引号与显式 profile,三壳透传真实 payload
来源:windows「Windows generated hook command carries a real PreToolUse payload
through …」×3
- 断言:hooks 配置生成的命令对含空格路径正确引用;经 cmd/powershell/pwsh
  实跑,payload 完整到达;响应不含执行否决;会话身份注入采用对应 shell 的
  正确语法(环境变量名与前缀形态为旧值锚;不变式是**注入语法对目标 shell
  正确且身份完整到达**)。

### WN-04 criterion 超时全进程树终止,含降级路径
来源:windows「criterion timeout terminates the child and returns promptly」
「…fallback terminates descendants after the first tree-kill attempt fails」
- 断言:见 SL-09;win32 特有断言:首次树杀(taskkill 类)失败注入后,降级
  路径仍在限时内消灭父进程与孙进程;返回及时不挂死。

### WN-05 criterion 租约:死亡持有者按声明的 deadline 等待后回收
来源:windows「[W06] criterion lease waits for a dead owner's declared deadline
before recovery」
- 断言:锁目录 owner 的 pid 已死但 deadline 未到 → 等待方按 in_progress 处理
  不抢占;deadline 已过 → 回收租约、正常执行、锁目录清理。语义平台无关,
  win32 上必须实测(进程存活探测语义不同)。

### WN-06 安装锁收割已死持有者
来源:windows「Windows installer reaps a stale lock owned by an exited process」
- 断言:安装锁 owner 进程已死且超过 stale 阈值 → 收割并继续安装(引用
  HF-06);win32 上实测。
