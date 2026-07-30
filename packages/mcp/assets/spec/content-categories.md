# Content Categories

Leji defines five **logical** content categories. They classify what a document is *for*, not where it lives: category names are stable identifiers used by the manifest, the index, and tooling. Directory names are the team's own.

## The five categories

| Category | What belongs in it |
|---|---|
| `domain` | Business language and product semantics, in the team's own words: what the core nouns mean, how they relate, the terms with local meaning. Business-state records (an engagement status, a market snapshot) classify here too, as records. |
| `system` | Architecture and its invariants: service boundaries, data ownership, integration contracts, consistency models, failure contracts, the constraints every change lives with. Technical assessments and system readouts classify here, as records. |
| `practice` | Conventions and patterns applied automatically: code conventions, testing patterns, and the prompt and workflow patterns that have proven out (see capture gate below). Records of applying a method (a retro, a runbook execution log) classify here, as records. |
| `governance` | Agent guardrails and operating rules: what agents may do unprompted, what needs a human gate, data-handling rules, escalation triggers, compliance controls. Governance evidence (an audit log, a review report) classifies here, as records. |
| `decisions` | Dated records of why things are the way they are, per [decisions.md](decisions.md). |

## Intent and records

Every governed document is either **intent** or a **record**, independent of its category:

- **Intent** is maintained present truth: glossaries, invariants, conventions, guardrails. Readers rely on it as current, so when reality moves, the document is corrected. Intent is what review horizons and the freshness mechanism exist for (see [governance.md](governance.md)).
- A **record** preserves claims within an explicit temporal or event boundary: statuses, assessments, ledgers, readouts, meeting outcomes, archives. Later state **supersedes** a record rather than correcting it; the original stays a valid account of its time. A record's currency surface is its **date**, never a review horizon.

The classification test is one question: *if later information disagrees with this document, must the document be corrected because readers rely on it as current, or does the new information supersede it while the original remains a valid account of its time?* Corrected means intent; superseded means record.

A record is governed exactly like intent: indexed, reviewed, owned, and routed. What differs is what a reader may do with it: a reader **MUST NOT** treat a record as current intent; it is dated evidence (see [context-layer.md](context-layer.md), Reading a record). Decision records are the formal record subtype: they are inherently records, with their own schema and lifecycle per [decisions.md](decisions.md).

Some questions about records are deliberately out of 1.0 and acknowledged rather than hidden: there is no machine notion of a record *series* (so tooling never certifies which record is "the latest"), no stream-recency mechanism (whether the next expected record is overdue), and no section-level kinds for documents that materially mix intent and record content. A mixed document **SHOULD** be split; where splitting is disproportionate, classify by the contract downstream readers principally rely on. Content that honestly fits no category stays reference; classification is not promised to be judgment-free.

## Requirements

1. The manifest **MUST** map each category it claims to one or more repository-root-relative **index files** (`categories.<id>.indexes`); each index file **SHOULD** fall under the declared context root, per [context-layer.md](context-layer.md). An index file declares inclusion, it does not relocate: content stays where the team already keeps it (for example `business/`, `technology/`, `architecture/`), and one directory may contribute documents to more than one category without renaming anything.
2. An index file is curated markdown carrying one or more fenced `leji-index` code blocks. A block **opens** with a line of three or more backticks followed by the block's info string and **closes** with the next line of three or more backticks; the closing fence's backtick count need not match the opening fence's. Exactly three info strings are valid: `leji-index` (an intent block), `leji-index intent` (the same, explicit), and `leji-index record` (a record block, whose entries resolve as records). Any other token after `leji-index` is a parse error, never silently ignored: the grammar is finite by design. Each block lists content one entry per line as `- path: <repository-root-relative-path>`, where a path is a directory (its markdown is included recursively) or a single markdown file. A path **MUST** be repository-root-relative POSIX: a leading `/`, a `..` segment, or a backslash is invalid and rejected. Blank lines and full-line `#` comments are ignored, and an entry **MAY** carry a trailing whitespace-preceded `# comment`. Whitespace in this grammar is ASCII space (U+0020) and tab (U+0009) and nothing else, everywhere the grammar consults it: around the fence backticks and the info string, as leading and trailing padding on an entry line, and before the `#` that opens a trailing comment. A leading UTF-8 byte order mark is stripped before parsing. Lines split on LF with a trailing CR tolerated, and the file is UTF-8. Implementations **MUST NOT** use a runtime whitespace class here: any other character a runtime happens to classify as whitespace, U+0085 and U+00A0 among them, is ordinary path content, so an entry whose path carries one is reported missing rather than silently trimmed. The `leji-mounts` blocks of [boot-profile.md](boot-profile.md) are frozen on the same alphabet, so one scanner reads both grammars and three implementations cannot disagree about whether a fence is even there. Multiple blocks in one file are concatenated in document order. Prose and headings around the blocks are allowed, so an index file doubles as a human-readable map of the category. The scan is line based and does not consult markdown structure: a line carrying three or more backticks and the tag, after optional space or tab indent, opens a real block wherever it sits in the document, including inside a longer fenced example or inside a list item. An example meant to illustrate rather than to declare is therefore fenced with a **different tag**, never with an extra token after `leji-index`: the tag is what the scanner matches on, so `leji-index example` opens a real block and reports a parse error, while a fence tagged `text` opens nothing. The **RECOMMENDED** location is `context/<id>.md` under the context root; the location is configurable and the tooling never hardcodes it.
3. A context layer **MUST** map at least `domain` or `system`, plus `decisions`, to claim any conformance level (see [conformance.md](conformance.md)), and the populated `domain`/`system` minimum **MUST** include at least one **intent** document: a context layer of records alone preserves history but carries no operating context. The other categories accrete as the team hits real questions; an empty category (one whose index files resolve to no documents) **MUST NOT** be mapped to satisfy a checklist.
4. A document resolves to exactly one category and one kind. Index entries are **selectors**, and resolution follows **selector specificity**: a direct file selector beats any directory selector, and a deeper directory selector beats an ancestor directory selector. The most-specific selector covering a document determines its category and its block kind; a document a broader selector covers but a more-specific selector wins is simply not that broader selector's content (which is how one kept-current file inside a record directory, or one team's decision log inside a broader mapped tree, is expressed without moving anything). Selectors of **equal** specificity that disagree on category or kind are an error, never resolved by index order; identical equal-specificity assignments resolve once, while a literally duplicated entry within one index file is rejected. Tooling **SHOULD** surface a selector whose every covered document was won by more-specific selectors (a *shadowed* selector): dead weight in the curated map, never an error. Resolution is otherwise deterministic: a directory entry expands to its markdown in POSIX-lexical order (by Unicode code point; **RECOMMENDED** paths stay ASCII so order is unambiguous across implementations), and any path whose real location (after resolving symlinks) escapes the **repository root** is excluded rather than followed. Index entries (see [machine-readable-surface.md](machine-readable-surface.md)) carry the category identifier and the kind.
5. A document **MAY** declare its kind in frontmatter (`kind: intent` or `kind: record`); frontmatter overrides the winning selector's block kind and **never** the category. Any other `kind` value is an error. Decision records take no `kind` key (their schema is closed and they are inherently records). A record **MAY** carry a frontmatter `date` (`YYYY-MM-DD`); tooling reads a record's date **only** from that field, never from prose, header conventions, or filenames. A record **MUST NOT** carry `freshness.reviewAfter` (a review horizon is an intent mechanism; on a record it promises a currency the document cannot have, and it is an error).
6. Practice content describing prompt or workflow patterns **SHOULD** be captured only after the pattern has worked at least twice (the proven-twice gate). Premature capture is how practice directories fill with aspiration.

## Notes (non-normative)

Not every category is present on day one. The minimum viable context layer is whatever the first month of work actually relies on. Categories exist so that a human or an agent can ask "what kind of truth is this?" and load the slice that matters for the task at hand, instead of the whole tree.

The two kinds exist because a real repository's documentation is two interleaved corpora with different truth models, and forcing the operational half under intent semantics fails both ways: freshness promises that cannot be honored, or the majority of the repository exiled outside governance. A worked shape, with one intent exception inside a record directory:

````markdown
# Domain context

```leji-index
- path: docs/glossary.md
```

Operational state is governed as records; the escalation policy stays intent.

```leji-index record
- path: docs/operations/
```

```leji-index intent
- path: docs/operations/escalation-policy.md
```
````
