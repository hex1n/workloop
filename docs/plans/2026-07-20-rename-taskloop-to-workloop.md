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

- 新 runtime 目录 + `workloop` shim;旧 `taskloop` shim 替换为一行提示转发,
  journal 记录。
- `lib/host-hooks.mjs` recipes 更新;各宿主 repo 重装 hook,
  `hooks --action record-install` 留痕。**本仓库自身的会话 hook 也指向
  `~/bin/taskloop.mjs`,重装前当前会话仍受旧运行时保护。**

### Phase 4 — 对外(不可逆,逐项确认后执行)

- GitHub 仓库改名(旧 URL 自动 redirect)。
- npm 发布 `workloop@0.2.0`;`@hex1n/taskloop` 执行 `npm deprecate` 指向新名,
  不删除。
- README / README.zh-CN 开头段重写(定位句同步升级为完整监督面)。

## 风险与回退

- GitHub redirect 兜底旧链接;npm 旧包只 deprecate 不删。
- 硬切换的代价已实测:手工 `mv .taskloop .workloop` 在 `.workloop/` 已存在时
  会**嵌套而非改名**(运行时先建了目录),3MB 事件账本被孤立,`status` 静默
  报 no task。这是本次改名唯一真实伤害;`.workloop/` 不在版本控制内,无 git
  兜底。已于 2026-07-20 22:52 恢复并 `audit` 验证链完整。
- Windows 套件与 CI workflow 中的名字必须同批改,否则矩阵门禁失真。

## 完成判据(建议,供 dogfood open 用)

1. `npm test` 全绿(132 项,含先在失败的处置)。
2. 活范围 `grep -r "taskloop"`(排除历史目录与本方案自身)= 0。
3. `TASKLOOP_INSTALL_HOME` 临时家下 `node install.mjs` 安装→卸载往返干净,
   dry-run 无 error 行。
