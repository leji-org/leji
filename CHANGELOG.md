# Changelog

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
