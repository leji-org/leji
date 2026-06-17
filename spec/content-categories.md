# Content Categories

Leji defines five **logical** content categories. They classify what a document is *for*, not where it lives: category names are stable identifiers used by the manifest, the index, and tooling. Directory names are the team's own.

## The five categories

| Category | What belongs in it |
|---|---|
| `domain` | Business language and product semantics, in the team's own words: what the core nouns mean, how they relate, the terms with local meaning. |
| `system` | Architecture and its invariants: service boundaries, data ownership, integration contracts, consistency models, failure contracts, the constraints every change lives with. |
| `practice` | Conventions and patterns applied automatically: code conventions, testing patterns, and the prompt and workflow patterns that have proven out (see capture gate below). |
| `governance` | Agent guardrails and operating rules: what agents may do unprompted, what needs a human gate, data-handling rules, escalation triggers, compliance controls. |
| `decisions` | Dated records of why things are the way they are, per [decisions.md](decisions.md). |

## Requirements

1. The manifest **MUST** map each category it claims to one or more repository-root-relative paths (`categories.<id>.paths`); those paths **SHOULD** fall under the declared context root, per [context-layer.md](context-layer.md). Mapping is how a lived context layer with its own directory names (for example `business/`, `technology/`, `architecture/`, `conventions/`) conforms without renaming anything.
2. The **RECOMMENDED** default directory names for a new context layer are `domain/`, `system/`, `practice/`, `governance/`, and `decisions/` under the context root.
3. A context layer **MUST** map at least `domain` or `system`, plus `decisions`, to claim any conformance level (see [conformance.md](conformance.md)). The other categories accrete as the team hits real questions; an empty category **MUST NOT** be mapped to satisfy a checklist.
4. A document **SHOULD** belong to exactly one category. Index entries (see [machine-readable-surface.md](machine-readable-surface.md)) carry the category identifier.
5. Practice content describing prompt or workflow patterns **SHOULD** be captured only after the pattern has worked at least twice (the proven-twice gate). Premature capture is how practice directories fill with aspiration.

## Notes (non-normative)

Not every category is present on day one. The minimum viable context layer is whatever the first month of work actually relies on. Categories exist so that a human or an agent can ask "what kind of truth is this?" and load the slice that matters for the task at hand, instead of the whole tree.
