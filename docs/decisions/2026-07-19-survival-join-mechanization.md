# 存活 join 机械化：分层裁决（NO_BUILD / DEFER）

- 日期：2026-07-19
- 类型：first-principles 取舍裁决（非 loop-engineering 票）
- 状态：已裁；DEFER 由 fresh-context 证伪测试坐实
- 关联：`docs/research/2026-07-19-loops-to-graphs-vs-taskloop.md`（缺口来源与 spike）、提交 `ec0e328`（阶段 1 落地）、`docs/decisions/2026-07-16-gate-input-epistemology.md`（票 16，冻结边界定价）

## 问题

阶段 1 落地了 `queries.terminal_write_sets`（终态写集）与 meta-loop 的有人值守 join 步骤。随之的取舍：**"写集文件关单后被 rename/delete"这个纯机械、确定性、零解读的扫描，是否应从有人值守 git 考古升格为机器计算？升到哪一层？**

## 根据（一句话）

**账本是单一权威（事件流）的投影；存活 join 是两个权威（事件流 × git 历史）的连接。把连接放进账本，等于让账本用它的 integrity 信封为一个它不拥有、且有独立完整性问题的第二权威背书。**

## 分层裁决

### 1. 放进 `cmdLedger`（问题原本提的机制）：NO_BUILD

- 依赖层面不是障碍：taskloop 早已 shell out git（`lib/criterion.mjs:56` 的 `git ls-files`），git 是通用 VCS 而非 host，host-neutral 不破。
- 真正的障碍是**授权数**。账本今天所有查询都是 `.taskloop/events.jsonl` 单一权威的纯函数，可从持久事件流重放；其认识论（integrity valid/covered、unknown-not-zero）全建立在此。git 历史可变（rebase、GC、shallow clone、改名又改回），它有**自己的**完整性问题，而这些问题人能判（我知不知道自己 rebase 过、是不是浅克隆），账本判不了。
- 故技能把 join 留在有人值守层不只是因为"解读（supersede vs regression）需要人"——是因为**第二权威的完整性判断也需要人**。这条边界永久不破，与票 16 的冻结边界同源。

### 2. 独立的、带测试的 helper（最便宜可信 build 机制）：DEFER

- 形态：一个独立小工具，读 `ledger --json` 拿写集 + 读 git 拿 D/R，按旧路径匹配 rename，只打印机械命中、不做判定、不进账本 integrity 信封。单一权威模型不破，rename-源路径这类确定性 legwork 不必每次手推。原型即本 session 的 scratch `meta-join.mjs`。
- 属"用现成能力/独立工具"族，非"改内核"；成本约 1–2 小时 + 一个临时 git fixture 测试。
- **预登记候选**：spec 与原型就绪，等一个更干净的证伪证据再点火。

### 3. 技能文本：当前终态，已实测有效

阶段 1 已把两个陷阱写进 `skills/meta-loop/SKILL.md` 的 Discipline 项（rename 按旧路径匹配；landing 按主题+角色排除而非按重叠比例）。

## 证据

- **首次正规 meta-loop join 运行**（本 session）：窗口 11 终态任务，integrity valid/covered。手跑在得到正确结果前失败两次，都指向伪造"survived"——rename 源路径陷阱、landing 重叠比例陷阱。两个陷阱随即写进技能文本。
- **真实 supersede n=1**：`ed7df509` 的判据锚 `tests/runtime-v4.test.mjs`、`tests/fixtures/runtime-contract-4.mjs` 被 `50dd6ab`「Use stable artifact filenames」双双改名（R079/R097），契约 4→5。achieved 记录仍在账本，其证明过的契约已翻篇。
- **fresh-context 证伪测试（干净样本）**：子代理只拿技能文本（含两个陷阱条）、无 spike、无 scratch、无答案，独立按旧路径匹配抓到该 rename、按主题+时序正确排除 landing、三个未落地任务读作 unknown。**技能文本足够**——DEFER 坐实，helper 现在不必建。

## 翻转条件

一次**干净的**未来运行仍产出假 survived——即一个比 n=1 更 subtle 的 supersede（跨多提交的改名、delete-then-recreate、改名又改回）被仅凭技能文本的手跑漏掉——那一刻 BUILD 第 2 层的独立 helper，**不是**第 1 层的账本内置。BUILD 由那个证据点火，非投机。

## 遵守的约束

- 账本单一权威模型（第 1 层 NO_BUILD 的根据）。
- 记账优于闸门（三票先例）：helper 只打印观测，不做闸门。
- 记观测不记解读（票 13）：机械命中是观测，supersede/regression 判定是解读，留有人值守。
- meta-loop 只读 `ledger --json` 契约、driver/调度器在仓外：helper 是有人值守会话里的独立工具，不是常驻进程。

## 失败模式（照实记）

DEFER 的失败模式：这缺口只有 n=1、月度低频、有人值守,可能永远不值得那个 helper——那 DEFER 就是永久正解,技能文本是终态。fresh-context 测试是 n=1 干净样本,且该 supersede 相对干净(当天改名、主题明显);更刁钻形态未被测过。
