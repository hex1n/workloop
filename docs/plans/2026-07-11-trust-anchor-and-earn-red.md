# taskloop 信任锚改进方案:收口不变量 + earn-red + 收口三角

**类型**: 设计方案(P0 已撤回,方向修订,详见下节)
**日期**: 2026-07-11
**触发**: 使用中的 issue —— 窄判据绿后过早 done;结构性迁移流程成本高;"出生即红"感觉不通用
**依据**: `lib/criterion.mjs` / `lib/task-engine.mjs` / `lib/application.mjs` 机制实读;本会话双宿主档 1 实测;10 份 loop-engineering canon(见 `../research/2026-07-11-taskloop-vs-loop-engineering.md`)

> ## 决策更新(2026-07-11 晚):撤回自动 P0,改采显式 trust-exception
>
> 原方案的 **P0 自动 drift 二类化(用 envelope 推断 subject)经三轮 Codex 实现评审 + 一轮方案层评审后撤回**。已从工作树外科移除(`npm test` 62/60/0,回到安全基线)。
>
> **撤回理由(Codex 方案层判定,已接受)**:
> - **envelope(可写权限)≠ sensor trust(判据豁免)** 是两种不同授权;把二者合并正是三轮持续出洞的设计根因。本文档下方"信任锚定收口不变量;envelope 是主体/传感器的分类器"这半句**推导不成立**。
> - **静态推断"哪个判据输入是 checker、哪个是数据"本质不可赢**(wrapper、复合命令、eval、动态 import、版本化解释器、criterion-file 传递依赖)。三轮换形不换根因即反证。
> - drift 拒关应保持**安全默认**:checker theater 是错误关闭、amend 只是成本,损失不对称。
>
> **修订后方向与优先级(Codex 建议,采纳)**:
> 1. 停止自动 subject-reclassification 与词法分类器(**已撤回**)。
> 2. **先交付不碰信任面的 premature-close 改进**:done/Stop 回显 alignment + not-covered + coverage(full/partial/unknown);收口三角改为**诚实 telemetry**(措辞 "declared but not machine-witnessed / not attributed",非"机械解",非硬闸门);audit 展示归因缺口。**not-covered 回显最先做**。
> 3. **结构性任务配方提前**(迁移清单模板 + 只读验证守则 + 顺滑 amend/re-bless)。
> 4. `--criterion-subject` 作为**独立、显式、可审计的 trust-exception** 单独立项:默认无 subject、必须在 envelope 内、必须带 reason、改动路径与目击状态结构化上账、close 横幅显式、过宽 glob 或 checker 本体需 provisional、amend subject 单独记录不随 envelope 自动扩展。
> 5. earn-red 基于显式角色模型再实现(first-red 冻结 sensor identity;amend/coverage-unknown 使旧 red witness 失效)。
> 6. 可靠 sensor manifest/tracing 最后(仅在有运行时文件访问证据后自动补 sensor evidence,不自动授予 subject relief)。
>
> **保留成立的核心**:"红的目击时刻应从 open 一般化到 close 前"(earn-red);收口报告方向。**撤回的**:"envelope 是分类器"这条自动推断。下文原始推导保留作上下文,但 P0 章节按上述已作废。

**推导轮次**: 第一性推导 → canon 交叉校准 → 反演互攻 → 实现接触面检(三轮 Codex)→ 方案层评审(撤回自动 P0)

## 根问题

taskloop 把信任锚定在**开生瞬间**,而真正的不变量属于**收口之门**。三处机制都是这个错位的实例:

1. 指纹在 open 时拍下且钉死**全部**输入 → 传感器与工作对象混淆(drift 误伤);
2. 红被要求在 open 时存在 → "挣红"被赶到任务**之外**、不受 envelope/预算治理;
3. 溯源/覆盖在 open 时定谳 → 工作中合法生灭的路径被误读为 unresolved/drift。

拓扑观察:canon 标准环是 **gather → act → verify → repeat**,验证在行动**之后**。taskloop 却有两件信任机制锚在行动**之前**(open 拍指纹、open 要红)——这是它的超纲发明,issue 里的全部误伤都从这个"前置锚"里长出来。**"信任锚定收口不变量"不是妥协,是把锚搬回 canon 放验证的位置。**

## 收口不变量(重述"出生即红"要守的东西)

不许在"从未被目击过能分辨对错"的传感器上收绿。分辨力证明 = 同一传感器上**先见过红、后见过新鲜绿、且两次观测之间传感器未被挪动**。

出生即红只是这个不变量的最严实现(红的目击点 = open)。它对一种任务形状不通用:**传感器本身是工作产物**(先写红测试)——红尚不存在,而造红恰恰该被任务治理。今日两次 chicken-egg 实证(`npm test` 绿 → gate 拦写测试 → 绕道 scratchpad 复现器 → amend 回 npm test)证明这不止"不通用",是**反治理**:把挣红赶出了 envelope/预算范围。

推论:该一般化的不是"要不要红",是**红的目击时刻**——从"open 时"放宽为"收绿之前、任务之内"。指纹窗口相应从 open→close 迁移为 **first-red→close**(出生即红退化为 first-red=open 的特例)。收口担保一字不变。

## 方案(一条原则:信任锚定收口不变量;envelope 是主体/传感器的分类器)

### P0 —— drift 二类化 + 升级①目击标注(issue 根因,止血)

close 时把变化的判据输入按 `insideEnvelope(path, envelope.files)` 分流:

- **envelope 内 = 工作对象**:随工作移动/删除,**不拦**;一行上报 + 账本记 `criterion_subject_changed`。删除(指纹读为 `missing`)同理。
- **envelope 外 = 挪传感器**:照旧拒关(现行为不变)。

**升级①**:放行 envelope 内变更时,报告标注该文件是否出现在机器目击的 `touched_files` 里 —— `changed (machine-witnessed write)` vs `changed outside machine-witnessed writes`。把分类器丢掉的严格性以**信息**形式收回,audit 可查,零闸门零仪式。措辞用 "not machine-witnessed"(归因缺口漏记 ≠ 没碰),与升级②统一。

代价具名:envelope 内 checker theater(往被查文件写期望内容)不再被 drift 机器拦——由**红目击 + alignment + 人验收 + 账本可见性**四层兜底。注:此类行为今天本就能靠不透明判据(`npm test` 无指纹)绕过,二类化同时消除"透明判据挨打、`npm test` 免疫"的倒挂 —— 相对现状**净收紧**。

### P1 —— earn-red + 收口交接

**earn-red 开生模式**(出生即红一般化):
- 默认不变:绿即拒(拒绝携带信息,不能拿掉);
- 新增显式 `open --earn-red --reason`:允许绿态/无红开生,任务带 `red_witnessed: false`;**收口门封死**直到闸门(Stop/verify)现场目击一次红;首红瞬间拍传感器指纹(envelope 外输入),此后到绿保持稳定;
- 遥测(Böckeler "unmeasured changes are vibes"):账本记 `red_witnessed_at`、pending 时长;
- pending 反馈(12-factor #9 错误压缩):收口拒绝把可行动原因喂回环体 —— "close barred: criterion has not yet been witnessed red — write the failing check first";
- 自限性:永不红的任务永不能绿收 → 预算耗尽/suspend,损害有界。

**done 收口横幅**:关单输出回显 alignment 的 `not covered:` 子句 —— 把"过早关闭"感在关单瞬间递到验收者眼前(声明层)。一行,零闸门。

**升级②收口三角报告**(事实层交叉,issue "判据绿≠完整目标" 的机械解):
```
declared(envelope 声明要碰的) ∖ touched(实际机器目击碰的)  = 声明了却未动
declared ∖ criterion_inputs(判据看过的)                    = 声明了却未验
```
纯集合差、零语义判断、不碰 Goodhart。**诚实性修正**:`criterion_input_coverage === "unknown"`(如 `npm test`,inputs 为空)时抑制"未验"三角,如实输出"判据覆盖未知,无法三角化",不放空炮;"未动"一行措辞用 **not machine-witnessed**。

### P2 —— 结构性任务配方(进 `skills/loop-core/REFERENCE.md` 或 `ADAPTERS.md`)

- 迁移清单式 criterion-file 范式:`test ! -e <target>`(目标已删)+ 引用清零 grep(现役引用为空)+ 定位断言(README/所有权语义已同步);
- 只读验证守则:Python 验证步骤 `PYTHONDONTWRITEBYTECODE=1`(遵守 ADAPTERS.md:22 checker 只读幂等),避免 `__pycache__` 触发额外 destructive grant。
- P0 落地后这类清单判据才写得动,一个任务收全程。

### schema 兼容

沿用既有"缺字段不伪造"惯例:`red_witnessed` 等新字段仅在任务实际携带时上账;pre-schema 任务无字段 → 按现有 kind/opened_dirty 的处理方式回退,不伪造默认。

## 拒绝清单(及理由)

- 把"语义完整性"做成闸门 → Goodhart;不可机器化,验收归人;
- close 时上 LLM 评审当闸 → canon 立场(Anthropic:LLM-judge "not a very robust method"),review 保持 provenance 记录而非闸门;
- 取消出生即红默认 → 丢掉唯一的机器目击分辨力证明;
- touched_files 当分类器(而非 envelope)→ 已知归因缺口(`python -c`、`sed -i`),false-deny 税回归;其目击价值改以升级① 的**标注**形式保留;
- 绿即自动 pending(而非显式 earn-red)→ 丢 feedforward 经济学:坏传感器该在花预算**前**被抓;
- 开生允许后补判据 → 违反 canon 入口纪律(先有清晰成功判据);earn-red 只推迟红,不豁免判据;
- 显式 `--criterion-subject` 声明主体 → 输给 envelope 复用(envelope 本就是意图声明,零新仪式)。

## 六失效模式回归检查(方案后)

| 失效模式 | 方案后 |
|---|---|
| hallucinated success | 担保不变(目击红 + 新鲜绿 + 传感器钉定) ✓ |
| reward hacking | 超纲机制保留,误伤面切除,`npm test` 免疫倒挂消除 → **净收紧** ✓ |
| no-progress / cost | pending 有界(预算)+ 新遥测 ✓ |
| compounding errors / context | 未触碰 ✓ |

## 验证计划(落地时红测试先行)

1. envelope 内主体变动 → 可收 + 账本 `criterion_subject_changed`;
2. envelope 外传感器变动 → 仍拒关;
3. 升级① 目击标注:witnessed write vs not-machine-witnessed 两分支文案;
4. earn-red:无红不许收、首红后指纹钉住、红→绿可收、pending 拒绝喂回可行动理由;
5. done 收口横幅回显 not-covered;
6. 升级② 三角:declared∖touched 与 declared∖criterion_inputs 各一例 + coverage unknown 抑制分支。

## 停止点声明

四视角各一轮,产出递减:整案 → 两升级 → 一措辞级修正 → 零。此后候选均已检验且更差(见拒绝清单)。**这是分析能给出的最佳方案;剩余不确定性是经验性的(earn-red 是否被滥用成口袋任务、envelope 内 theater 是否真发生),分析买不到,已由 `red_witnessed_at` 遥测与 `criterion_subject_changed` 旗标预埋收集管道,靠落地后的账本回答。**

## 落地切片

- **切片 1 = P0**(drift 二类化 + 升级①):issue 直接根因,自足于 criterion/task-engine/application 报告路径,红测试清晰。先落。**(已撤回,见决策更新)**
- **切片 2 = P1**(earn-red + 遥测 + pending 反馈 + done 横幅 + 升级②三角)。(done 横幅与三角已落地;earn-red 见切片 5)
- **切片 3 = P2**(配方文档)。(已落地)
- **切片 4 = 决策更新第 4 条**:`--criterion-subject` 显式 trust-exception。设计见下节。(已落地)
- **切片 5 = 决策更新第 5 条**:earn-red,显式角色模型。设计见下节。(已落地)

## 切片 4 落地设计:`--criterion-subject`(2026-07-11)

**一句话**:显式声明"判据读的这个文件是工作对象本身"——其变更是工作在发生,不是传感器被挪。声明是一次授权(grant,带溯源),不是任何形式的推断。

**与被撤回的自动二类化的本质区别**:envelope 成员从"充分条件"(撤回案:在 envelope 内 ⇒ 自动豁免)降为"必要条件之一"(本案:豁免 = 显式声明 ∧ envelope 内 ∧ 非 checker)。可写权限与免证信任保持两种授权,分别授予、分别上账;静态推断为零。

**CLI 面**:
- `open --criterion-subject <仓库相对文件>`(可重复);
- `amend --criterion-subject <path> --reason`(增量并集;作为独立 amendment 记录,不随 `--files` 扩展)。

**验证规则**(open/amend 共用,全部精确判断、无推断):
1. 精确文件路径,禁 glob——信任豁免必须点名;
2. 仓库内相对路径(拒绝绝对路径/越界);
3. 拒绝 `.taskloop/` 下任何路径;
4. 拒绝等于 `--criterion-file` 本体:checker 永不可为 subject,checker 的合法移动只走 `amend --criterion --reason`(比 Codex 草案"checker 本体需 provisional"更严:无合法用例,直接拒绝);
5. 必须落在 envelope 内(`insideEnvelope`)——声明"任务要改它"却无写权限不自洽;
6. 咨询性警告(非拒绝):声明的文件不在当前指纹输入中 → 该声明暂无效果;
7. 命令形判据的 checker 不可静态识别(已证不可赢)→ 不加词法守卫,由声明显式性 + 溯源 + 收口回显 + 账本兜底。

**裁决**(`adjudicateGreen`,done 与 stop gate 两扇门共用):
`changed = criterionInputDrift(...)`;`drift = changed ∖ subject` 照旧拒关;`subjectChanged = changed ∩ subject` 放行并记录。混合变更(两类都有)仍拒关,拒关文案只点名非 subject 文件,另加一行说明 subject 部分已豁免。

**升级①目击标注**(方案原文保留项在此兑现):放行的每个 subject 变更标注是否出现在机器目击的 `touched_files` —— `machine-witnessed write` vs `not machine-witnessed`(归因不完备如实说)。

**上账与可见性**:
- grant scope `criterion-subject`(granted_by self|user,计入账本 `self_granted`);
- 任务:`criterion_subject: [paths]`(仅声明时携带,同 `criterion_file` 惯例);`evidence.criterion_subject_changed` + 结构化 `evidence.criterion_subject_changes: [{path, witnessed}]`;
- 账本行:`criterion_subject`(声明数)+ `criterion_subject_changed`(布尔),与 `criterion_input_drift` 同纹理;
- `status` 增一行(仅声明时);close 时显式回显豁免横幅。

**amend --criterion/--criterion-file 清空 subject**:与 review 用 `criterion_hash` 盖章同一原理——豁免是对特定判据授予的,判据挪动后旧豁免不得静默随行到新检查;同一条 amend 可当场重新声明(即替换语义)。协议-only 变更(`--criterion-protocol`)不清空:subject 关乎输入身份,不关乎裁决协议。

**明确不做**:glob subject;checker-as-subject(即使 provisional);任何词法/静态推断;移除单个 subject 的动词(v1 经 `amend --criterion` 重置或重开任务)。

## 切片 5 落地设计:`--earn-red`(2026-07-11)

**不变量(重述,非新造)**:绿收口要求判据在本任务、本传感器上**至少被目击过一次红**。出生即红只是把目击点钉在 open 的最严实现;earn-red 把目击点从"open 时"一般化为"收口之前、任务之内"。

**显式角色模型**(Codex 要求:显式,不推断):
- `open --earn-red --reason`:绕过绿态开生拒绝,任务带 `earn_red: true`、`red_witnessed:`(= open 那次跑是否为红,红态开生即刻置真);
- 默认(birth-red)与 keep-green **不带这两个字段** → 收口门只在 `red_witnessed === false` 显式为假时触发,二者与 pre-schema 任务天然免疫;
- `red_witnessed` 在任一**计量闸门**目击红时翻真:Stop 的 `criterion-failure`、`done-failure` 两处 transition;
- 收口门(`adjudicate-green`,done 与 Stop 共用)新增 `unearned` 出局:earn_red 且未挣红 → 拒关,喂回可行动理由("write the failing check / make it fail once");不烧轮(同 drift/weak);
- **amend 判据重置目击**:红只为旧传感器背书,判据挪动后 `red_witnessed` 归假(与 review/subject 用 `criterion_hash` 失效同源);
- 自限性:永不红的任务永不能绿收 → 预算耗尽/suspend,损害有界;
- `--earn-red` 与 `--keep-green` 意图相反(红将至 vs 绿稳态),互斥拒绝;`--earn-red` 需 `--reason`;
- 上账 `earn_red`/`red_witnessed`;status 增一行;audit 信号 `earn-red N (unearned M)`;open 横幅提示收口被封。

**刻意缩窄(相对决策更新第 5 条草案)**:
- **不做 "first-red 冻结 sensor identity" 的重新指纹**:earn-red 的典型判据是**命令形聚合测试**(`npm test` / `pytest` / `cargo test` / `go test` / 自建脚本等,随项目而异,关键是无路径 token → coverage unknown → 无指纹 → 无 drift),重新指纹无对象;criterion-file 形态判据在 open 即存在并被指纹,传感器挪动由既有 drift 拒关 + amend 重置双管覆盖,再加一层 first-red 指纹是重复机制、徒增与 drift 的交互面。
- **不做 "coverage-unknown 使旧 witness 失效"**:witness 绑定的是"本任务本传感器见过红",与指纹覆盖度正交;coverage unknown 的命令形判据(上述聚合测试即是)恰是 earn-red 主用例,若因 unknown 反复失效则该特性对主场景失效,自相矛盾。传感器挪动的失效已由 amend 重置精确承载。
- **verify 不翻 witness**(偏离草案"闸门(Stop/verify)"):verify 契约是只读、不改生命周期;让只读 verify 翻一个改变收口门行为的持久位,会使 verify 变成收口的承重件,违背"读与验证永远自由"。红的目击只经计量闸门(Stop 的 criterion-failure、done-failure)——它们本就写状态、烧轮。REFERENCE 与收口拒绝文案均明说"red `done`/Stop 计数,只读 verify 不翻",doc==code。
