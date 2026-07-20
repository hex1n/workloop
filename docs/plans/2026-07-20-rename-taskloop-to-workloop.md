# taskloop → workloop 改名迁移方案

日期:2026-07-20 · 状态:已批准命名,待执行

## 决定

- 仓库、运行时、CLI 改名 **workloop**;skill 层四个名字(`loop-core`、`workloop`、
  `judgmentloop`、`meta-loop`)**全部不动**。整体与旗舰 skill 同名,即 JS 工具链的
  旗舰模式(webpack 仓库 + webpack 包,babel + @babel/core)。README 第一句自证
  旗舰排位:machine-verifiable agent work 是主战场。
- 备选名七轮筛选史(warden/arbiter/marshal → andon → warrant/earnest → anchor →
  greenloop/testloop/passloop)全部被口味否决;结论:用户第一直觉正确,拆除的
  是"整体部分不得同名"这条反对,不是名字本身。npm `workloop` 已核实空闲(404)。
- **历史文档一字不改**:`docs/decisions/`、已落盘的 `docs/plans/`、`docs/research/`、
  `docs/reviews/`、`docs/e2e-test/`、`.taskloop/archive/` 里的 "taskloop" 保持原样。
  历史是证据;与 review receipt 不回填翻译同一原则。
- **消歧规约**(写入 loop-core):skill 散文里不加限定的 "workloop" 指 skill;
  运行时首次点名写 "the workloop runtime",此后一律 "the runtime"(现有文本
  已基本如此:"The runtime is the stop gate"、"the runtime never launches a
  reviewer")。

## 命名映射

| 旧 | 新 | 备注 |
|---|---|---|
| CLI `taskloop` / `bin/taskloop.mjs` | `workloop` / `bin/workloop.mjs` | |
| npm `@hex1n/taskloop` | `workloop`(unscoped,已核实空闲) | 保底 `@hex1n/workloop` |
| GitHub `hex1n/taskloop` | `hex1n/workloop` | GitHub 自动重定向旧 URL |
| 状态目录 `.taskloop/` | `.workloop/` | 需迁移 verb,见 Phase 2 |
| `TASKLOOP_SESSION_ID` 等三个环境变量 | `WORKLOOP_*` | 过渡期双读,新名优先 |
| 判据协议前缀 `TASKLOOP_CRITERION:` | `WORKLOOP_CRITERION:` | 解析端双收,发射端一律新 |
| `~/bin/.taskloop-runtime/` + shim | `~/bin/.workloop-runtime/` + shim | |
| `tests/taskloop*.test.mjs` | `tests/workloop*.test.mjs` | package.json scripts 同步 |

## 前置条件

- `tests/taskloop.test.mjs:1182`(session-scoped PreToolUse)在干净 HEAD 上就
  失败(2026-07-20 复核,与 receipt 语言改动无关)。改名会大面积触碰 deny 文
  案断言,**必须先修复或记录此先在失败**,否则无法区分新旧破坏。
- 工作区有两组未提交改动待分开提交:receipt 语言规则(REFERENCE.md)、
  supervisor 定位句(AGENTS.md + HOSTS.md,本方案 Phase 0 的一部分)。

## 阶段

### Phase 0 — 记录(部分已做)

- [x] AGENTS.md:35 定位句从 "The runtime is the stop gate" 升级为完整监督面:
  授权、实时执法、裁决、存证、停线。
- [x] HOSTS.md:3 同款措辞修正,保留 gate-vs-driver 站位对比。
- [ ] `docs/decisions/2026-07-20-flagship-rename-workloop.md`:命名决策、七轮
  筛选依据、旗舰模式先例、历史不改原则。
- [ ] 建议 dogfood:用运行时自己 `open` 此工作,criterion 见"完成判据"。

### Phase 1 — 源码与活文档(纯内部,test-gated)

- 替换范围:`bin/` `lib/` `tests/` `hooks/` `install.mjs` `package.json`
  `README*` `AGENTS.md` `skills/` `.github/workflows/`、根目录 `acceptance-*.mjs`。
  排除:历史目录(见"决定")。
- 接口字符串按 AGENTS.md 规则记为 deliberate interface change:CLI tagline、
  deny/nudge 文案中的 `taskloop amend` / `run taskloop join`(tests 匹配 reason
  fragments)。
- 检查 runtime-contract-5 fixture 冻结消息是否含 "taskloop";若含,属 contract
  变更,升版本并记录,不做静默改动。
- loop-core REFERENCE.md:3 绑定句改为 "The workloop runtime supervises one
  durable task...",并落消歧规约一句。

### Phase 2 — 状态迁移与协议过渡 —— 已作废,改为硬切换(2026-07-20)

**决定推翻本阶段的过渡期设计:不做任何兼容层。** 用户基数为一,过渡期只
存在于本机本仓库,兼容代码的维护成本高于它消除的风险。三项均已实现后删除:

- ~~新 verb `migrate-state-dir`~~:不做。`.taskloop/` 由人手改名一次;
  遗留目录对运行时不可见,读作 no task。
- ~~环境变量双读~~:不做。只读 `WORKLOOP_*`。
- ~~判据输出前缀双收~~:不做。只收 `WORKLOOP_CRITERION:`;
  捆绑 `acceptance-*.mjs` 发射端已全部为新前缀。

本仓库自身的 `.taskloop/` 已于 2026-07-20 手工迁入 `.workloop/`(过程见下)。

### Phase 3 — 安装器与宿主 hook

**必须先做 manifest 迁移,否则首次安装必然阻塞**(2026-07-20 读码确认,
修正本方案初稿"发布阻塞不触发"的错误判断):

改名把 managed skills manifest 从 `.taskloop-managed-skills.json` 换成
`.workloop-managed-skills.json`。新装时 `readManagedSkills` 读不到新文件,
返回空 `legacyNames`(`install.mjs:653/668`),而 `~/.claude/skills/` 与
`~/.codex/skills/` 下四棵 skill 树由旧运行时装着、真实存在。于是
`legacySkillCanBeAdopted(skill, actual, false, current)`(`install.mjs:687`)
两个条件都不成立——`LEGACY_CORE_DIGESTS` 只收历史 digest,当前 skill 内容早已
变化——`install.mjs:735` 判为 error,`installWorkloop` 在 `install.mjs:790` 写下
`needs_manual_intervention` 并 return,**`activateRuntimeShims` 永不执行**:
`workloop` shim 装不上,旧 `taskloop` shim 继续服务旧运行时,且失败是静默的
(journal 里才看得到)。

迁移动作(择一,推荐前者):

1. 安装前把 `~/bin/.taskloop-managed-skills.json` 改名为
   `.workloop-managed-skills.json`。manifest 内部格式不含产品名,改名即可被
   `readManagedSkills` 正常认领,四棵树按 owned 走正常 update 路径。
2. 或安装前手工删除 `~/.claude/skills/` 与 `~/.codex/skills/` 下的
   `loop-core`、`workloop`、`judgmentloop`、`meta-loop` 四棵树,让新装当作
   全新分发。代价:本地对 skill 的任何修改会丢失。

验证:在临时 `WORKLOOP_INSTALL_HOME` 下先造出"旧 manifest + 四棵树"的状态,
再跑 `node install.mjs`,断言 journal 状态为已完成且 `workloop` shim 存在。

- [x] 新 runtime 目录 + `workloop` shim。旧 `taskloop` shim **不做转发提示,
  直接删除**(硬切换后转发层同属兼容层);`~/bin` 下六项遗留已于 2026-07-20
  清除,删前确认无任何可执行配置引用它们。
- [x] `~/.claude/settings.json` 的 PreToolUse/Stop 已指向 `workloop.mjs`;
  `~/.codex/config.toml` 的 `writable_roots` 与 project trust 条目已清理。
- [x] `lib/host-hooks.mjs` recipes **无需更新**(命令路径自引用推导,见风险段)。
  两侧宿主 hook 配置已核对到与 recipe 逐字节一致,`~/.codex/hooks.json` 的
  旧 shim 路径已修;claude 与 codex-safe 均已 `record-install` 留痕。
  覆写配置会删掉宿主上无关的 hook(ai-notifier、SessionStart 等),故只逐项改。

### Phase 4 — 对外(不可逆,逐项确认后执行)

- [x] GitHub 仓库改名(旧 URL 自动 redirect)。已完成;本地 remote 一度仍指旧名,
  靠 redirect 工作,2026-07-20 已 `set-url` 到 `hex1n/workloop`。
- npm 发布 `workloop@0.2.0`;`@hex1n/taskloop` 执行 `npm deprecate` 指向新名,
  不删除。
- README / README.zh-CN 开头段重写(定位句同步升级为完整监督面)。

## 风险与回退

- GitHub redirect 兜底旧链接;npm 旧包只 deprecate 不删。
- Windows 套件与 CI workflow 中的名字必须同批改,否则矩阵门禁失真。

### 硬切换的实测代价:产品名嵌进持久化路径(2026-07-20)

根因一条:**产品名同时是状态目录名、manifest 文件名、sandbox 可写根和宿主
hook 命令行**,而运行时会按需自建状态目录。于是"改名"这个动作在四处各自失败
一次,形态不同,共同点是**静默**——没有一处报错,全部表现为"看起来正常但
账本不见了"。

1. **仓库状态目录——嵌套而非改名。** 手工 `mv .taskloop .workloop` 时
   `.workloop/` 已被运行时建出(它先写了 `.gitignore`),`mv` 于是把旧目录
   *移进*新目录,得到 `.workloop/.taskloop/`。3.0MB 事件账本与 1033 行观察
   记录被孤立,`status` 静默报 no task,其后每次写入都被记成 untracked work。
   2026-07-20 22:52 恢复,`audit` 验证 valid、2363 records / 3003 events、
   无 recovered tail。
2. **HOME 级产出账本——静默孤立,且当时尚未触发。** `~/.workloop` 压根没被
   创建,而 `~/.taskloop` 里存着活的 4552 行跨仓库 outcome 投影。下一次终态
   事件会新建空账本,跨仓库历史从此对 meta-loop 不可见。此处目标不存在,
   `mv` 是干净改名;`audit-outcomes` 验证 valid、4552 行全部认领。
3. **managed skills manifest——阻塞发布且静默。** manifest 名为
   `.taskloop-managed-skills.json`,改名后 `readManagedSkills` 读不到新名,
   四棵已装 skill 树全部判为"非 workloop 所有",`install.mjs` 写下
   `needs_manual_intervention` 并在 `activateRuntimeShims` 之前 return——新
   shim 装不上,旧 shim 继续服务旧运行时,失败只在 journal 里可见。手工把
   manifest 改名即解。
4. **Codex hook 配置——清理旧 shim 时打断了监督。** `~/.codex/hooks.json` 的
   PreToolUse 与 Stop 都硬编码 `node "~/bin/taskloop.mjs"`。删除旧 shim 时只
   检查了 `~/.claude/settings.json` 与 `~/.codex/config.toml`,遗漏这个文件,
   于是两个 hook 一并指向不存在的路径(实证:`MODULE_NOT_FOUND`),直到下一
   次排查才发现。修复即把两处命令与 statusMessage 换成 workloop;matcher 与
   timeout 本就与 `codex-safe` recipe 一致,无需改动。

**注意 recipe 本身不需要改。** `buildHookRecipe` 接收命令作为参数,路径由
`lib/application.mjs` 从 `process.argv[1]` 自引用推导,不含硬编码产品名——
所以"更新 recipes"这条按构造已满足;真正带名字的是**各宿主已落盘的 hook
配置**,而那不在本仓库内,也不会出现在任何 diff 里。

三条可迁移的结论:

- **改名前先盘点"名字进了哪些持久化路径"**,而不是只 grep 源码。本次四处
  全部在版本控制之外(状态目录、HOME 目录、`~/bin` manifest、宿主 hook 配置),
  没有 git 兜底,也不会出现在任何 diff 里。
- **`mv A B` 不是改名,是"B 存在与否决定语义"。** 迁移已存在的目标目录必须
  逐项移动内容并对每个碰撞 fail-closed;整目录 `mv` 只在目标确不存在时安全。
  作废的 `migrate-state-dir` verb 原本要编码的正是这条,现由本节承载。
- **确认"没有引用"时不要用会静默截断的检查。** 第 4 处正是这么漏掉的:
  `grep -r ... | head -20` 被会话记录的匹配灌满,活配置被挤出输出,而截断的
  结果被当成了完整结论。删除前的引用排查要么全量输出,要么按文件名收窄,
  不能让 `head` 决定证据边界。删除是不可逆的,检查却是可以重跑的。

## 完成判据

1. [x] `npm test` 全绿。2026-07-20 实测:behavioral 132/132;matrix 214 项中
   207 通过、7 项 Windows 用例在 darwin 跳过、0 失败。方案初稿担心的
   `tests/taskloop.test.mjs:1182` 先在失败已不复现。
2. [x] 活范围 `grep -r "taskloop"` = 0。仅 AGENTS.md 三处散文有意保留旧名
   (历史文档引用、硬切换规则本身、manifest 手工改名步骤)。
3. [x] `WORKLOOP_INSTALL_HOME` 临时家下的全新安装干净。**原文写的"安装→卸载
   往返"不可执行**:本项目没有安装器卸载入口,`uninstall` 只存在于
   `hooks --action record-uninstall`(纯留痕)。改按实际能验的做,2026-07-20
   全部通过:
   - dry-run 0 条 error 行,且不写入家目录(事后仍为空);
   - 全新家实装 `0 error`,journal 正常清理;
   - 产物全部新命名,`find` 全家搜 `*taskloop*` 为空;
   - 四棵 skill 树在 `.claude/` 与 `.codex/` 两侧齐全;
   - 重装幂等收敛(26 ok / 0 error);
   - 装出的 shim 端到端可用:无任务时 Stop 放行,判据未满足时
     `block ... not_ready(criterion_unsatisfied)`,满足后转为
     `held(sensor_drift,criterion_assurance_gap,change_review_unaccepted)`。

   注:本机原有家目录的实装当初走的是手工改名 manifest 的路径,与此处的全新
   安装路径不同;上述验证覆盖的是新用户会遇到的路径。
