# Rationale

Non-normative: the reasoning behind the spec's shape.

## Intent over instructions

Imperative instructions ("do this, in this format, for this vendor file") must be re-encoded for every agent host, task, and new hire. Durable intent (what things mean, what must hold, why) is written once for any host and task to derive from.

The context layer's categories are therefore topic axes drawn from durable meaning (domain, system, governance, decisions), not from tasks. A future version may add task envelopes drawn from live practice; 1.0 deliberately standardizes the smaller surface.

## A circle, not a tier

Most context work today is written *for agents*: people author instructions, agent hosts load them, and the flow runs one way down a tier. That speeds up individual work and leaves the older problem untouched: human-to-human knowledge stays in heads and threads, and each agent host gets its own slowly diverging copy of the truth.

Leji treats three flows as first-class around one context layer: **human-to-human** (onboarding, review, settling debates), **human-to-AI** (work delegated to an agent), and **human-to-AI-to-human** (agent-produced work reviewed by people).

Everyone reads that one context layer; people and agents both propose changes. Equal access, not equal authority: every write enters as a proposal, and a person approves what becomes true. Content serving all three flows is itself a forcing function: a page only agents read can rot unnoticed, but a page people rely on too gets fixed from both sides.

## Intent and records

A real repository's documentation has two interleaved kinds with different truth models. Intent (glossaries, invariants, conventions, guardrails) must be *kept* true: when reality changes, the document is corrected. Records (statuses, assessments, ledgers, readouts, archives) are *born* true within a boundary; later state supersedes them, and their date defines their currency.

Treating records as intent creates review promises nobody can honor. Excluding them leaves much of the repository outside governance. Leji instead governs both, distinctly.

Records are indexed, reviewed, and owned like intent, but they route as dated candidates rather than as required context. Their reader contract differs: dated evidence, never current truth. Freshness horizons apply to intent alone. The five categories remain topic axes, while kind is orthogonal: a system assessment is both *about* the system and *true as of its date*.

The spec never certifies which record is "the latest," because 1.0 declares neither record series nor their ordering. Readers judge recency from dates surfaced in the index. The spec's own decision records, dated, append-only, and never stale, exemplify this pattern.

## Why this is not a wiki

Wikis rot because nothing forces them current. The context layer has three forcing functions a wiki lacks:

- Agents read it on every task, so wrong context produces wrong output someone feels the same day.
- Changes ride code review, so there's no separate process to forget.
- Mechanical drift (a stale index, a rewound changelog, a broken profile) is a check that fails, which at `governed` runs in CI on every change.

## Why vendor files redirect

Canonical context in one vendor's config format becomes fragmented and locked to that host. Because agent hosts look for their own entrypoints, Leji uses them as adapters: one line pointing at the boot profile. One source of truth outlives any host.

## Why federation composes instead of centralizing

Centralizing every team's knowledge breaks the ownership loop that keeps context current. Owners fix their layer while using it on every task; a central repository separates content from accountability and queues cross-team edits behind gatekeepers.

Federation keeps ownership and legibility together. Each team's context layer remains in its repository, where its circle reads and approves it. A host mounts a sibling at a pinned version to read it and route agents into it; no content is copied or committed into the host.

The sibling's owner still approves changes, so mounting grants reading, not authority. Most teams never need `federated`; it matters only when more than one team already owns a context layer worth keeping whole.

## A team of one

Nothing in the circle requires more than one person. The same individual can propose, delegate to an agent, and approve. Even then, agents review and advise while the person owns and approves; the manifest's `agents` map does not transfer accountability.

A team of one is the smallest circle, not a different shape. The model scales from one person to one team to an organization of teams without adding parts.
