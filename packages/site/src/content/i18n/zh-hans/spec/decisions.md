---
source: "9550ceea3130bc921e029e51d882c675dbcc3564"
---

# 决策

决策记录是上下文层中带日期的“为什么”：架构决策、厂商选型、范围边界，以及有意作出的“不做决定”。它们可以避免同一问题被反复讨论，也让智能体获得决策背后的推理，而不只是规则本身。

决策记录是**记录**的正式子类型（见 [content-categories.md](/zh-hans/spec/content-categories/) 的“意图与记录”）：它们本质上就是记录，并拥有普通记录所没有的统一 schema 与生命周期。它们生成的索引条目携带 `kind: record`；决策记录自身不声明 `kind` 键（其 schema 是封闭的，显式写 `kind` 会导致校验失败）。

## 要求

1. 决策记录是带 YAML frontmatter 的 markdown，frontmatter 对 [`decision-record.schema.json`](../schemas/decision-record.schema.json) 有效，一份记录一个文件。决策语料由清单声明的两个收录来源取并集得到，上下文层**可以**使用其中之一或两者：所声明的记录路径（`machine.decisionRecordsPath`，默认 `<root>/decisions/`），以及 `decisions` 类别的索引文件所解析出的条目。一份记录**必须**至少能通过其中一条途径到达。
2. frontmatter **必须**携带：`id`（稳定）、`title`、`status` 与 `date`。`status` 取 `proposed`、`accepted`、`superseded`、`deprecated`、`rejected` 之一。
3. 正文**必须**用散文写明：背景（是什么局面迫使做出决策）、决策本身，以及它的后果。**推荐**的章节标题是 `## Context`、`## Decision`、`## Consequences`；记录**可以**再加一节 `## Alternatives`。
4. 记录是**仅可追加的历史**：**不得**把一份记录改写成另一个决策。随着决策变老，frontmatter 中有两个字段是**可变的**：`status`（它的生命周期）与 `supersededBy`（在它被取代时设置）；其余一切，`id`、原始的 `title` 与 `date`、所声明的作用域，以及散文正文，一经发布即**不可变**。翻案或变更是一份新记录，其 frontmatter 设置 `supersedes`，而旧记录的 `status` 变为 `superseded` 并设置 `supersededBy`。取代关系的链接**必须**在两个方向上保持一致：当记录 B 设置 `supersedes: A` 时，记录 A 携带 `status: superseded` 与 `supersededBy: B`，而 `superseded` 的记录**必须**在 `supersededBy` 中指名它的后继者。两份记录都保留。参考工具目前会强制执行取代关系的双向一致性。它尚未验证不可变性本身（即已发布记录被冻结的字段与正文相对某个基线版本未被改动）；那是路线图上的一项报告式检查，尚未成为阻断性关卡。在它发布之前，不可变性靠流程担保的评审纪律来保障（见 [conformance.md](/zh-hans/spec/conformance/)）。
5. 记录**可以**声明 `affectedPaths` 与 `affectedCategories`，使工具能够从一项任务的作用域路由到治理它的那些决策。任务作用域如何选中记录（考虑重叠的路径包含、狭义的类别匹配、`accepted` / `deprecated` 的约束力，以及对两者都不声明的记录按组织级处理），见 [machine-readable-surface.md](/zh-hans/spec/machine-readable-surface/) 中的“任务路由”算法。
6. 被否决的提案同样属于记录（`status: rejected`）。将未被采纳的决策记录下来，是成本最低的防止重复讨论的方式。

## 与 ADR 的兼容（非规范性）

Leji 的决策记录刻意与架构决策记录（ADR）兼容：既有的 ADR 目录只需为每份记录（或此后的新记录）添加那些 frontmatter 字段，并在清单中映射该目录，即可满足 `decisions`。不需要任何 ADR 工具，也不排斥任何 ADR 工具。
