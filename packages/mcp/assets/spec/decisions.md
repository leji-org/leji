# Decisions

Decision records are the context layer's dated account of *why*: architecture decisions, vendor selections, scope boundaries, intentional non-decisions. They stop re-litigation, and they give agents the reasoning rather than just the rule.

## Requirements

1. Decision records **MUST** live under the path(s) the manifest maps to `decisions` (default `<root>/decisions/`), one record per file, markdown with YAML frontmatter valid against [`decision-record.schema.json`](../schemas/decision-record.schema.json).
2. Frontmatter **MUST** carry: `id` (stable), `title`, `status`, and `date`. `status` is one of `proposed`, `accepted`, `superseded`, `deprecated`, `rejected`.
3. The body **MUST** state, in prose: the context (what situation forced a decision), the decision itself, and its consequences. The **RECOMMENDED** section headings are `## Context`, `## Decision`, `## Consequences`; a record **MAY** add `## Alternatives`.
4. Records are **append-only history**: a record **MUST NOT** be edited into a different decision. A reversal or change is a new record whose frontmatter sets `supersedes`, and the old record's `status` becomes `superseded` with `supersededBy` set. Both records remain.
5. A record **MAY** declare `affectedPaths` and `affectedCategories`, so tooling can route from a file to the decisions that govern it.
6. Rejected proposals are records too (`status: rejected`). A decision not taken, written down, is the cheapest re-litigation insurance there is.

## ADR compatibility (non-normative)

Leji decision records are deliberately compatible with Architecture Decision Records: an existing ADR directory satisfies `decisions` by adding the frontmatter fields to each record (or to new records going forward) and mapping the directory in the manifest. No ADR tooling is required, and none is excluded.
