# The Machine-Readable Surface

Five artifacts make the context layer legible to tooling. Everything else in the context layer is prose for humans that agents happen to read; these five are the contract tools build against.

| Artifact | Default location | Schema |
|---|---|---|
| Manifest | `leji.json` (repository root, fixed) | [`context-manifest.schema.json`](../schemas/context-manifest.schema.json) |
| Context index | `<root>/context-index.json` | [`context-index.schema.json`](../schemas/context-index.schema.json) |
| Context changelog | `<root>/context-changelog.json` | [`context-changelog.schema.json`](../schemas/context-changelog.schema.json) |
| Agent profiles | `<root>/agents/*.md` (frontmatter) | [`agent-profile.schema.json`](../schemas/agent-profile.schema.json) |
| Decision records | `<root>/decisions/*.md` (frontmatter) | [`decision-record.schema.json`](../schemas/decision-record.schema.json) |

All locations except the manifest are manifest-declared; the table shows defaults.

## Requirements

1. **Manifest.** `leji.json` **MUST** exist at the repository root and validate against its schema. It is the only fixed filename in Leji: the file tooling reliably looks for.
2. **Index.** A context layer claiming `indexed` conformance or above **MUST** carry a context index that is **generated, never hand-maintained**. Each entry carries a stable `id`, a `path`, a `title`, and a `category` identifier. A stale index (one that no longer matches the tree) **MUST** be treated as a validation failure.
3. **Changelog.** A context layer claiming `indexed` conformance or above **MUST** carry a machine-readable changelog of context layer changes. Entries carry a stable `id`, a UTC `date`, a `type`, a one-line `summary`, and the affected `paths`. Canonical order is **derived, not positional**: tooling **MUST** order entries by `(date, id)` ascending, and array position carries no meaning. Because `id` is unique within the changelog (Identifiers), `(date, id)` is a total order even when two changes share a `date`. Surviving entries are immutable: tooling **MUST** treat modification of a published entry as a validation failure; reordering the array is not. The changelog is a **recency surface, not an archive**: a long-lived context layer **SHOULD** compact it rather than let it grow without bound, and **MAY** compact it at any time by removing entries from the oldest end of that order, provided the same change set appends an entry of type `compaction` whose `compacted` field records the count and the first and last removed ids. Removal of anything but the oldest entries, removal without a compaction entry, and compaction to an empty file are validation failures. Append-only discipline is **set-keyed by `id`** and checked against the prior committed state, so it needs git at authoring time; the file itself stays git-free for consumers, and git history holds the full record. A human-readable changelog **MAY** exist alongside; the JSON record is the one tooling reads.
4. **Frontmatter artifacts.** Agent profiles and decision records are markdown documents whose YAML frontmatter validates against their schemas. The prose body stays free-form; the frontmatter is the machine contract. Pure-JSON profiles or decisions **MUST NOT** be required: people read these documents.
5. **Identifiers.** All `id` values **MUST** be stable once published: renames and moves update `path`, never `id`. Identifiers are lowercase, hyphen-separated, unique within their artifact type.
6. **Timestamps.** Changelog `date` values are ISO 8601 in **UTC**: either a calendar date `YYYY-MM-DD` (ordered as that day's start, `T00:00:00Z`) or a full timestamp ending in `Z` (for example `2026-06-13T15:04:05Z`). Zoneless times and non-UTC offsets are **not** permitted, so a lexical sort of `date` is a chronological sort. Other artifacts' dates follow ISO 8601 and **MAY** be date-only. **Paths** are POSIX-style, relative to the repository root, no leading `./`.
7. Every JSON artifact except the manifest **MUST** declare the schema line it was written against (`schemaVersion`), per [versioning.md](versioning.md); the manifest declares its target spec line with the self-naming `leji` key.
8. **Derived surfaces inherit access constraints.** The index, the changelog, the generated viewer, and any compiled or exported view built from context layer content are *derived surfaces*, as is the output an agent produces from that content. A derived surface carries the access constraints of the most restricted content it draws from. Tooling **MUST NOT** write or copy a derived surface to a location with a broader audience than that content without an explicit, reviewed redaction step that produces a separate surface for that audience, and an agent **MUST NOT** quote or summarize restricted context into a broader-audience or less-restricted surface (a pull request, ticket, chat, commit message, or public context layer). The index of a restricted context layer can be as sensitive as its prose: titles, paths, and summaries all describe it.

## Notes (non-normative)

The index doubles as the navigation source for presentation tooling: `leji viewer` projects it into a static viewer, and any docs tool can do the same. The surface is deliberately small. Five shapes are enough for tooling to validate a context layer, diff it, score its freshness, and route an agent to the right slice, and few enough that a team can adopt them in an afternoon. Anything beyond these five is post-1.0 territory, gated on lived practice.
