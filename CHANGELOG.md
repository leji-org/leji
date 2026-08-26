# Changelog

## Unreleased

A hardening release. The CLI keeps its own generated tree out of git, the viewer takes the
brand's typography, the federation commands say which act failed and how to recover, and the
release path is pinned end to end under a recorded refresh policy. No normative specification
change and no schema constraint change (one description string is clarified); the spec stays on
the frozen v1.0 line and all reference packages move to 1.4.1 together.

### Added

- **A recorded dependency pinning and refresh policy**, at
  `docs/decisions/0008-dependency-pinning-and-refresh.md`: which dependency classes are pinned
  exactly and which stay compatible ranges, that every release refreshes the exact pins and
  re-pins actions to current SHAs, and a 90-day floor that runs the refresh even when no
  release is cut. `SECURITY.md` carries the matching public commitment: reports acknowledged
  and triaged on a best-effort basis, typically within 7 days; a forward-only patch release
  where a compatible fix exists; patches on the latest minor line only.
- **A scheduled dependency audit** (`.github/workflows/dependency-audit.yml`): monthly, and on
  any change to a dependency manifest, `npm audit` runs over the root lockfile at high or
  above, `pip-audit` over the Python SDK's resolved runtime closure, and `govulncheck` over the
  Go SDK. The scanners are pinned like everything else on the release path.
- **A pin check for the release path**, `scripts/check-release-pins.sh`: it refuses `@latest`,
  `--upgrade`, a `pip install` or `npm install -g` without an exact version, a `go-version`
  without a patch component, and a `uses:` without a 40-hex SHA. Contributors get it as a stage
  of the pre-push hook; CI runs it as its own job, with a self-test that proves each rule still
  fires, and the pre-publish smoke runs it in layer 0. Alongside it, the PyPI upload's own
  `twine check --strict` now runs on the gates that come before a tag: in the pre-publish
  smoke, in CI on every pull request, and in the pre-push hook when a `release/*` or `rc/*`
  ref is pushed. The tag-triggered release workflow runs the same check once more on the
  distribution it built, so the upload action is never the first thing to see a rejection.
- **A browser smoke suite** at `packages/e2e` (Playwright on Chromium) over the served viewer,
  an exported tree, and the site, so the live and static renderings are checked against one
  set of assertions: `npm run e2e` locally, a `ui-smoke` job in CI that keeps traces and
  screenshots on failure. It is a private workspace and ships in no published package.

### Changed

- **The layer map is rendered, not written.** `overview.md` is seeded once and never
  rewritten after that: the map between its `leji:generated-map` markers is substituted
  when the page is read, by `leji view` and by `leji export`, so reindexing a layer
  changes `context-index.json` and leaves the committed page alone. Nothing rewrites an
  existing file, and a map an earlier version left in your `overview.md` is now ignored
  at render. To clear it by hand, delete every line between
  `<!-- leji:generated-map:start -->` and `<!-- leji:generated-map:end -->`.
- **The CLI ignores its own directory from inside.** The first time a command creates a role
  under `.leji/` (`mounts/`, `viewer/`, `dist/`, `work/`), it writes `.leji/.gitignore` holding
  exactly `*`, so a repository whose root `.gitignore` never received the `.leji/` line commits
  none of that tree either. `leji init` and `leji adopt` still add the root line. An existing
  `.leji/.gitignore` is left byte-identical and never merged, with one notice per invocation on
  stderr (on stderr under `--json` too, never in the document), so your own file is kept by
  being left alone. The write refuses like every other: a symlinked `.leji`, or an entry that
  is not a regular file, is never written through.
- **The generated tree and the local hints file are documented** in the root and SDK READMEs:
  the four `.leji/` roles, that none of it is committed, and that `.leji/mounts.local.json` is
  a per-machine hints file the CLI reads and never writes. Migrating from an earlier version:
  if that hints file was committed, untrack it with `git rm --cached .leji/mounts.local.json`
  and keep the bare `.leji/` line at the root, since onboarding refuses while anything under
  `.leji/` is tracked and the nested ignore file takes precedence over a negation written at
  the root; a `docs/.leji/` tree left by 1.3.x is unused in 1.4.x and can be deleted. With the
  hints file uncommitted, a fresh clone hydrates through the resolver store or the manifest's
  remote URLs, so a pinned commit has to be reachable on its remote.
- **The viewer takes the brand's typography.** Headings and emphasis, body copy, and a muted
  tone are declared once as `--leji-text`, `--leji-text-body`, and `--leji-text-muted`, and
  replace the stock theme's neutral greys throughout the shell and the content. Body links and
  inline code now take the fixed accessible green `--leji-link` (`#007D59`, AA on white and on
  the inline-code ground) instead of the accent, so contrast holds for every value of
  `viewer.theme.primary`; the chrome (navigation, active sidebar entries, search highlights,
  the progress bar) still takes the accent, and the accent's own fallback is Leji green rather
  than the stock docsify green, so a context layer that declares none is rendered in the brand
  color. The manifest schema's description of `viewer.theme.primary` says the same: it drives
  the viewer chrome, active states, and diagram accents, and body text does not follow it. The
  field's validation is unchanged.
- **leji.org ships analytics-free.** The site source loads nothing third-party: the analytics
  script, and its origin in `img-src`, `script-src`, and `connect-src`, appear only when a
  build sets both `PUBLIC_ANALYTICS_SCRIPT` and `PUBLIC_ANALYTICS_SITE`. `public/_headers`
  carries a first-party-only policy to match. A deployment adds its own analytics, and the
  Trust page states it that way.
- **The published floors are exercised.** CI runs the Python SDK at 3.10, 3.12, and 3.14 (the
  `requires-python` floor, the version the rest of CI uses, and the newest classifier) and the
  MCP server on Node 22 and 24, the floor its `engines.node` declares. The pre-publish smoke
  installs the SDK, `create-leji`, and the MCP server tarballs into a Node 22 container and
  drives all three there, and its result line says so when Docker is absent and the leg is
  skipped. The Go SDK is built and tested at Go 1.27.0, which is now also the floor its
  `go.mod` declares, so every floor named here is a floor CI exercises.
- **The Go floor moves to 1.27.0.** `packages/sdk-go/go.mod` declares `go 1.27.0` (up from
  `go 1.23`), and `golang.org/x/text` moves to v0.41.0 with it. Building the Go SDK, or
  `go install`ing the `leji` binary from source, now needs Go 1.27.0 or newer; the published
  release binaries are unaffected, since they carry no toolchain requirement. `CONTRIBUTING.md`
  and the Go setup script state the new floor.
- **The test suites pin what they used to sample**: the badge and canary suites in all three
  SDKs share one directory-snapshot helper held to a golden fixture, the capture-cap test
  asserts bytes and termination rather than elapsed time, and the homepage's hero transcript is
  pinned to what the CLI actually prints.

### Fixed

- **`mounts update-pin --fetch` names the act that failed.** A `--fetch` run observes the
  declared source in three acts (retain the current pin, refresh the witness, retain the
  target) and a refusal reported only the rule. Findings now carry an optional `detail` string,
  serialized immediately after `message`, reading `<act>: <reason>` with the act named as
  `current pin`, `target`, or `witness`; the human line appends the same as
  `(detail: <act>: <reason>)`. Where the current pin is the act that failed, the message also
  gives the route forward: run without `--fetch` against a local hint that holds the current
  pin and the target with complete ancestry, or pass `--to <oid> --allow-non-fast-forward`
  against such a hint to move past an upstream that rewrote its history.
- **`mounts hydrate --fetch` reports the same detail** on its per-mount findings, so a
  hydration that could not establish the store or refresh the witness says which act it was and
  what the resolver ran into. Neither command's flow changes: a failed act still refuses.
- **The viewer's meta CSP no longer claims `frame-ancestors`.** A `<meta>` policy cannot
  deliver that directive, so the browser ignored it and logged an error on every page.
  `leji viewer serve` still sends it as a response header. A static host serving an export from
  `.leji/dist/` sets that directive itself, the way this repository's site does in
  `packages/site/public/_headers`.
- **The pre-commit secret scan sees non-ASCII paths.** The staged list reached the scanner
  through `git diff --cached --name-only`, which octal-quotes a non-ASCII path, so those files
  failed `lstat` and went unscanned. The hook pipes the `-z` form straight into `xargs -0`
  instead. The pre-push hook now also runs every stage and exits once, so a missing tool skips
  its own stage and never the ones after it.

## 1.4.0 · 2026-08-21

The OSS feature program: export, badge, pin updates, rendering parity, a unified `.leji/`
layout, ecosystem-aware adoption, and the hand-off that keeps every clone on one CLI
version. No normative specification or schema change; the spec stays on the frozen v1.0 line and all
reference packages move to 1.4.0 together.

### Added

- **`leji export`** generates the complete, self-contained static site from a context
  layer: the same content the local viewer serves, hostable on any static host, subpaths
  included, no build step and no network path. `leji viewer build` is a co-equal name for
  the same operation. Output lands in `.leji/dist/`; a consolidated
  `third-party-licenses.txt` ships with every generated tree.
- **`leji badge`** emits a deterministic, self-attested conformance badge: the SVG is
  scored locally by `leji conformance`, byte-identical on rerun, with one markdown line
  that embeds it. The badge face reads `Leji 1.0 · <level>`; the full self-attestation
  claim rides the SVG title, its accessible label, and the markdown alt text, and the
  linked page explains it. No registry, no endpoint, no account.
- **`leji mounts update-pin`** completes the federation lifecycle: it moves a declared
  mount pin with the witness comparison in hand, fast-forward by default with a narrow
  audited override, fetching from the declared source only.
- **Rendering parity**: the supported markdown subset is documented at
  `adoption/rendering.md`, export lints the out-of-subset constructs, and rendering
  fixtures (sample repos with canonical golden trees) join the shared suite so any
  renderer can verify against identical expectations.
- **Ecosystem-aware adoption**: `leji init` and `leji adopt` detect the repository's
  package manager (npm, pnpm, yarn, bun; uv, poetry, pdm, pipenv, pip; Go 1.24 tools) and,
  on your explicit consent, run that manager's own add command so the Leji CLI is declared
  as a tracked dev dependency and a clean install brings it. Hooks and generated CI run
  the CLI through the manager the repository actually uses.
- **The pinned-CLI hand-off**: inside a repository that declares the Leji CLI and has it
  installed, the installed Node and Python executables run that copy for every
  invocation, so a person typing `leji`, the hooks, CI, and every teammate use one
  version. Eligibility is decided on verified evidence only; `LEJI_NO_LOCAL` (any value)
  opts out; the Go CLI does not hand off (use `go tool leji`). Note for Python upgraders:
  an already-installed console script gains the hand-off after a reinstall, which rebakes
  the entry point.
- **`leji start` preflight**: on an adopted repository, `start` first prints a terse Setup
  block (the repository's CLI, your agent's MCP registration, the team `.mcp.json`, the
  git hook) with `ok` / `you` / `team` ownership words, exact fix commands, and TTY-only
  status color, then offers the personal repairs and launches. `--json` gives the same
  checks as one scriptable document.
- **Grouped CLI help** generated from one shared description in all three SDKs, with an
  agent-ready page at leji.org linked from every badge.
- **`create-leji` is a one-time smart bootstrap**: `npm create leji` routes a new
  repository to `init` and an adopted one to `adopt`, with honest scaffold starters.

### Changed

- **Contexing, LLC is disclosed as steward.** `GOVERNANCE.md` names the steward and its
  independence commitments, the Trust page carries the stewardship story, and the
  trademark policy is published at `/trademark/`; contributor terms with DCO sign-off
  land alongside. Vuong Nguyen remains creator and editor; conformance requires no
  steward product or service, as before.
- **One `.leji/` directory** at the repository root with role subdirectories (`mounts/`,
  `viewer/`, `dist/`, `work/`); the mounts cache is structurally unservable and
  unexportable.
- **Write-path hardening**: every user-influenceable write in the three SDKs goes through
  a chokepoint that judges root containment and the `.leji/` role rule immediately before
  the act; the check-before-act contract is documented at `docs/practice/trust-boundary.md`.
- **Viewer accent validation** is strict hex (3, 4, 6, or 8 digits).
- The CI matrix adds a Node 22/24 leg and a named Windows regressions job.

### Fixed

- **In-page relative links stay inside the viewer's router** instead of escaping to the
  server, live and static-exported alike.
- **Relative image paths in governed markdown resolve against their document**, raw-HTML
  `img` sources included, with containment enforced at render time.
- **`leji start` explains an `agents.default` binding at bind time** (`leji agent` teaches
  the boot semantics; a binding alone never loads a profile, per spec rule 2).
- **`--check-integrity` help and behavior agree**: verification stages in the OS temp
  directory, exactly as the help text says.

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
