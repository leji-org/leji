# Changelog

## 1.3.1 · 2026-07-31

A patch release for two Windows-only defects, plus a documentation pass. No specification,
schema, or manifest change; the spec stays on the frozen v1.0 line and all reference packages
move to 1.3.1 together.

### Fixed

- **The viewer served nothing under `/content/` on Windows.** Route keys were derived with
  `path.normalize`, which follows the host platform and rewrote separators to backslashes, so
  every `/content/*` request missed its mount and 404ed while the app shell loaded normally. Route
  keys are now canonicalized with POSIX semantics in all three SDKs.
- **Adoption recorded a guessed docs-root casing.** Detection tested for `docs/` and returned the
  candidate it searched for, so a directory named `Docs` produced a `rootPath` that did not match
  disk on a case-insensitive filesystem, and was missed entirely on a case-sensitive one.
  Detection now reports the directory as it is named on disk, matching case-insensitively and
  preferring an exact spelling.
- **A request target beginning with `//` was parsed as protocol-relative** by the Node viewer,
  moving its first path segment into the host, so `//content/x.md` 404ed where the other SDKs
  served it.

### Changed

- **Federation has its own guide** at `/federation/`: the sibling mount model, the pinned
  `federation.mounts` declaration, the `leji mounts` commands, and what `federated` conformance
  requires.
- **The adoption guide is staged**, from scaffold to a context layer an agent reads, with the
  edge cases behind disclosures rather than in the main path.
- **Documentation corrections**: the layer projection closure, `federated` conformance
  conditions, category index selectors, what validation enforces, record routing, the `agents`
  map, and the MCP server's capability and network claims now match the specification and the
  reference SDK.

## 1.3.0 · 2026-07-30

The content-model revision and the GA freeze of the specification. **Spec 1.0 is declared GA at
this release**: the line is frozen from here, so any incompatible change ships as a new line. All
reference packages move to 1.3.0 together.

**Migrating a 1.2 manifest**: replace each `categories.<id>.paths` with `categories.<id>.indexes`
pointing at one or more index markdown files (e.g. `docs/context/<id>.md`), and declare the old
content paths inside each file's fenced `leji-index` block. `leji validate` confirms the result;
`leji index` regenerates the context index.

### Added

- **`leji status`**: an informational health report over the context layer. Reports markdown under
  the context root that no category index lists, index entries whose path does not resolve,
  stored-index paths the index files no longer resolve to, shadowed selectors, skipped READMEs, and
  whether the layer at `HEAD` would project completely if a host mounted it. Report-only by default;
  `--strict` fails the run for CI.
- **`leji route`**: prints the slice of governed context a task's scope selects per the Task routing
  algorithm, given `--paths`, `--categories`, and `--topics`: the expanded and signalled categories,
  each governed document with its review horizon and expiry, the record candidates, the live
  decisions routed to the task, and the sibling mounts the topic and category signals match.
- **`leji mounts hydrate`**: materializes each declared mount's layer projection at its pin into the
  gitignored cache, resolved from a local object store and offline by default; `--fetch` establishes
  the resolver-managed store. The only mutating mounts command.
- **`leji mounts status`**: read-only availability plus an ancestry-aware pin report against the
  witness ref (up-to-date, behind N, ahead, diverged, unrelated, or unknown); `--check-integrity`
  re-derives the projection and compares it byte for byte against the cache.
- **`leji mounts locate`**: prints where a reader should read one mount from, with its pin and
  whether the bytes are present and verified this run.

### Changed

- **Categories map to curated index files**, not content paths. An index file is markdown carrying
  `leji-index` blocks that list directories or single files, so content stays where it lives and one
  directory can feed more than one category. `categories.<id>.paths` is removed.
- **Intent and records**: every governed document is `intent`, kept current and carrying freshness
  horizons, or a `record`, dated evidence a later state supersedes. Records are governed like intent
  but never certified as latest, and horizons on them are a validation error.
- **Federation reworked to resolver-hydrated pinned mounts**: a mount declares a `source` and a full
  commit `pin` rather than a path, and `leji mounts hydrate / status / locate` materialize, compare
  and locate a sibling's projection without committing anything into the host. The projection is the
  **closure** of what the sibling's manifest makes readable (boot profile, machine artifacts,
  category indexes, bound agent profiles, and indexed governed paths, wherever they live), and
  `leji status` reports whether the layer at `HEAD` would project completely if a host mounted it.
- **Task routing: path scope selects, it no longer expands.** A task path selects the entries it
  reaches and signals their category; only an explicitly named category expands its documents.
- **Conformance outcomes are four, and distinct**: `fail`, process-attested `manual`, `unknown` for
  evidence this run could not obtain, and not-applicable for a conditional item. Conformance judges
  the directory it is given, so a copy outside its repository fails `core` rather than verifying it.
- **Optional `actors` in the manifest**: a role may name several eligible participants, each with a
  command template per role, because one participant can need a different invocation in different
  roles. Optional, and a profile's own `host` / `invocation` still serve the simple case. Both
  command surfaces follow one template rule: `<prompt>` is schema-required and stands as its own
  unquoted shell word, substituted one-pass into exactly one argument.
- **Solo working mode**: `--mode solo` on `init` / `adopt` seeds identity and writing-style starters
  and runs an owner interview in the onboarding brief, with raw artifacts confined to a transient
  gitignored workspace.
- **Portable `AGENTS.md` pointer**, written when none exists, so the cross-host entrypoint convention
  cold-starts an agent into the context layer with no content outside it.
- **MCP install offer** during `init` / `adopt`, so a launched session starts with native spec and
  validation tools.
- **Scaffolds carry a generated index at every level**, so the CI job `leji ci` writes passes on the
  first run.
- **`leji ci` is provider-aware and pinned**: the provider is inferred from the origin remote,
  `--hooks` installs a local mirror that respects `core.hooksPath`, and generated CI prefers a
  repository's lockfile-pinned install over `npx @leji-org/leji@1`.
- **`agents.default` is a directory entry, not a load order**, with a validator warning when a boot
  profile loads that path.
- **Viewer, evolved**: a live sidebar, a Reference drawer over ungoverned files, per-page
  classification, vendored webfonts, and a generated `📄 Manifest` page rendering `leji.json` with a
  federation view.
- **CLI ergonomics and parity**: every value flag accepts `--flag=value`, and invalid `--level`,
  numeric range and unknown-option errors read identically across the three SDKs.

## 1.2.0 · 2026-06-19

Schema and naming hardening before public launch and adoption, plus new surfaces. The
spec stays on the v1.0 line; all reference packages move to 1.2.0 together.

- **MCP server** (`@leji-org/mcp`): serves the spec and schemas and runs `validate` /
  `conformance` as read-only tools, so a coding agent reaches Leji natively.
- **New commands**: `leji agent`, `leji start`, and `leji ci` (GitHub, GitLab, CircleCI, or Azure DevOps via `--provider`).
- **Reworked viewer**: `leji viewer` (+ `viewer serve` / `viewer build`, `view`): a
  contained, themeable viewer. Replaces the old `leji docs`.
- **Pre-adoption hardening**: finalized the manifest schema and viewer naming, and closed
  security gaps in the viewer export, while the spec has no public adopters yet.

## 1.1.0 · 2026-06-18

Agent onboarding. New commands and flags let an AI agent bring a repository into a
context layer and hand off cleanly. The specification and schemas are unchanged
(still the v1.0 line); all three SDKs move to 1.1.0 together. Backward compatible.

- **`leji adopt`**: adopt an existing repository. Reuses its `docs/` root and
  migrates vendor files (`CLAUDE.md`, `AGENTS.md`) into the layer, originals untouched.
- **`leji detect`** and **`init --agent <host>`**: detect installed coding agents
  (Claude Code, Codex, Copilot, Gemini, Cursor, Windsurf) and wire a one-line
  redirect, never overwriting an existing file.
- **`init`** writes an onboarding brief that walks an agent through filling the
  layer; **`--dry-run`** previews every write first.
- **`validate --content`** flags placeholder, thin, and owner-unconfirmed content;
  **`conformance --explain`** says what reaching the next level takes.
- **`leji changelog compact`** folds old changelog entries; undeclared machine
  paths resolve to their `rootPath` defaults, so a minimal `leji.json` just works.

## 1.0.0 · 2026-06-12

Initial public release. Everything ships together as one coherent v1: the
specification, the schemas, and the reference tooling.

- **Specification 1.0.0**: 9 normative documents covering the context layer,
  the boot profile, content categories, decision records, the machine-readable
  surface, distribution, conformance, versioning, and governance, plus
  adoption guides and rationale.
- **Schemas v1.0 line**: 5 JSON Schemas (draft 2020-12) for the manifest
  (`leji.json`), context index, context changelog, agent-profile frontmatter,
  and decision-record frontmatter, published at
  `https://leji.org/schemas/v1.0/`.
- **Reference SDKs 1.0.0**: `@leji-org/leji` on npm (TypeScript), `leji` on PyPI
  (Python), and the Go module `github.com/leji-org/leji/packages/sdk-go`,
  behaviorally identical: `validate`, `index` / `index --check`,
  `changelog check`, `freshness`, `conformance`, interactive `init`, and a
  `docs` viewer generator (Docsify vendored locally, no CDN) with a localhost
  preview server, with shared exit codes and findings, tested against one
  shared fixture suite.
- **`create-leji` 1.0.0**: `npm create leji` bootstraps a context layer from
  the templates.
- **Templates and examples**: copyable starters (manifest, boot profile, core
  and role agent profiles, decision record) and two reference context layers
  (monorepo, multi-repo setup) that validate clean with the SDKs.

Patches and additive changes ride SemVer from here. `CHANGELOG.json` is the machine
mirror of this release record; changes to this repository's own context layer are
recorded in `docs/context-changelog.json`.
