# Changelog

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
- **Reference SDKs 1.0.0**: `leji` on npm (TypeScript), `leji` on PyPI
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

Patches and additive changes ride SemVer from here; the machine record of
context layer changes is `CHANGELOG.json`.
