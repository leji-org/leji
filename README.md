# Leji

[![CI](https://github.com/leji-org/leji/actions/workflows/ci.yml/badge.svg)](https://github.com/leji-org/leji/actions/workflows/ci.yml)
[![Leji 1.0 · governed · self-attested](leji-badge.svg)](https://leji.org/agent-ready/)

**An open specification for the shared context layer of AI-native teams.** Leji (from the word *legible*, pronounced LEH-jee) defines a versioned, repo-owned context layer of how a team thinks: domain language, constraints, decision records, conventions, agent guardrails, one reviewed body of context that people and AI agents both read, changed through the same review gate as the code.

> **Status: 1.5.2.** The reference SDKs (`@leji-org/leji` on npm and JSR, `leji` on PyPI, and the Go module) are at 1.5.2. The specification and schemas are on the v1.0 line, **GA and frozen at the v1.3.0 reference-tooling release**: any incompatible change ships as a new line. See [spec/versioning.md](spec/versioning.md).

## Principles

1. **Intent over instructions.** Most AI adoption writes imperative, per-tool instructions. Leji captures durable intent: what things mean, what must hold, why it is so, and lets people and agents derive actions from declared intent plus task context.
2. **A circle, not a tier.** Human-to-human, human-to-AI, and human-to-AI-to-human are first-class flows around one shared context layer. Equal access, not equal authority: everyone with access to a context layer reads all of it, anyone proposes, people approve. Access is the version control system's to grant; restricted context lives in its own permissioned context layer.
3. **Mechanism over goodwill.** Shared context decays by default: reality moves, documents don't, and nothing forces a wiki current. Leji's forcing functions are mechanical, not goodwill: changes ride the same review gate as code, tooling fails on mechanical drift, freshness horizons flag what has aged, and context past its review horizon is surfaced by `leji freshness` and `leji route`, not presented as current.

The name is the thesis: the context layer makes a team's operating context **legible** to everyone working in it, human or agent.

## What's here

| Path | Contents |
|---|---|
| `spec/` | The normative specification (CC-BY-4.0) |
| `schemas/` | JSON Schemas for the machine-readable parts (Apache-2.0) |
| `templates/` | Copyable starters: manifest, boot profile, core and role agent profiles, decision record, onboarding brief, solo identity and writing-style starters |
| `examples/` | Reference context layers: monorepo and multi-repo (pinned federation) |
| `adoption/` | Adoption guides: monorepo, multi-repo setup, vendor-adapter wiring |
| `rationale/` | Non-normative: why a circle, why intent, why this is not a wiki |
| `packages/sdk`, `packages/sdk-py`, `packages/sdk-go` | The reference SDKs and CLI (npm, PyPI, Go), held to identical behavior by the shared `fixtures/` suite and the byte-level parity harness: validate, index, changelog, freshness, conformance, init |
| `packages/mcp` | The MCP server (`@leji-org/mcp`): the spec, schemas, validation, and conformance as read-only tools for coding agents |
| `packages/create-leji` | `npm create leji`: the zero-install bootstrap, routing to the SDK's `init` or `adopt` by what the target directory already holds |
| `packages/site/` | The spec website (plain Astro; deployable by anyone) |

## Generated files

The CLI keeps its disposable working artifacts under one `.leji/` directory at the repository root, in four roles: `mounts/` (materialized federation mounts), `viewer/` (generated viewer chrome), `dist/` (exported viewer builds), and `work/` (the transient onboarding workspace). All of it is machine-local, and none of it is committed. What the CLI generates for you to keep is not in there: the context index, the changelog, the badge, and the CI workflow land in the tree and are committed like everything else. The first time a command creates one of those roles, the CLI writes `.leji/.gitignore` containing `*`, so the directory ignores itself; an existing `.leji/.gitignore` is left as it is, with a notice on stderr. `leji init` and `leji adopt` also add a bare `.leji/` line to the repository's root `.gitignore`.

One file the CLI writes is not generated output: `overview.md` at the context root. It is seeded once, when no `overview.md` stands there, and is never rewritten after that. The layer map lives between the `leji:generated-map` markers the seed leaves empty, and is rendered into the page when the page is read: by `leji view` and by `leji export`. A reindex therefore leaves `overview.md` alone: it writes `context-index.json`, and seeds a context changelog when the context layer claims `indexed` or above and has none yet. If an older version of the CLI wrote a map into your `overview.md`, that block is ignored now; delete the lines between the markers whenever it suits you.

An exported viewer under `.leji/dist/` is plain static files whose Content-Security-Policy travels in the page's `<meta>` element, and a meta policy cannot carry `frame-ancestors`, so a host serving an export sets that directive as a response header itself, the way this repository's own site does in [`packages/site/public/_headers`](packages/site/public/_headers).

`.leji/mounts.local.json` is a per-machine hints file: it points the resolver at local checkouts of the context layers a federation mounts. The CLI reads it and never writes it. Do not commit it; a path on one machine is not a path on another.

Migrating from an earlier version:

- If `.leji/mounts.local.json` was committed, untrack it with `git rm --cached .leji/mounts.local.json`, and keep the bare `.leji/` line in the root `.gitignore`. Onboarding refuses to run while anything under `.leji/` is tracked, and the nested `.leji/.gitignore` takes precedence over any negation written at the root.
- A `docs/.leji/` tree left by 1.3.x is unused since 1.4 and can be deleted; `leji validate` reports it as `legacy-leji-dir`.

Because the hints file stays uncommitted, a fresh clone hydrates its mounts through the resolver store or the manifest's remote URLs, so a pinned commit has to be reachable on its remote.

### From 1.3.x

A repository on 1.3.x moves to the current version in seven steps. Work on a branch:

1. Install and pin the current version through your package manager (npm, PyPI, or Go), and declare it locally if it is only installed globally. The installed Node and Python CLIs hand off to the copy your repository declares, so everyone runs one version; the Go CLI does not, so you run it as `go tool leji`.
2. Delete `docs/.leji/` (untrack it first if it is tracked), keep the bare `.leji/` line in the root `.gitignore`, and untrack `.leji/mounts.local.json` if it was ever committed.
3. Run `leji validate` and fix what it reports at the source. Two errors are new since 1.3.x, `link-unresolved` and `decision-number-duplicate`, so a context layer that was green can go red.
4. Run `leji index`. The viewer's sidebar follows the order in the index files, so reorder them if the old order mattered.
5. Re-run `leji ci` for your provider, with `--hooks` if you generated hooks, and review the diff: on GitHub Actions, CircleCI, and Azure Pipelines it replaces an unedited 1.3.x workflow and leaves an edited one alone with a snippet to merge by hand; on GitLab it owns a marked block inside the shared `.gitlab-ci.yml` and replaces that block, edits inside it included.
6. Check that `viewer.theme.primary`, if you set it, is a hex value, and delete the lines between the `leji:generated-map` markers in `overview.md`, keeping the markers.
7. Finish with `leji validate`, `leji index --check`, and `leji conformance`.

To hand the upgrade to an agent, give it this prompt:

```
Upgrade this repository's Leji context layer from 1.3.x to the current version. Work on a branch, commit nothing, and end with a report of what changed and what `leji validate` says.

1. Install and pin the current version through this repository's package manager: npm `@leji-org/leji`, PyPI `leji`, or Go `github.com/leji-org/leji/packages/sdk-go/cmd/leji@v1.5.2`. If it is only installed globally, declare it locally too. The installed Node and Python CLIs hand off to the repository-declared copy, so everyone runs one version (`LEJI_NO_LOCAL` opts out); Go does not hand off, so use `go tool leji`. Python: reinstall the console script so the hand-off applies. Building the Go CLI from source needs Go 1.26.6 or newer; the release binaries do not.
2. The tool's own tree moved to a single root `.leji/` in 1.4. Delete `docs/.leji/`; if it is tracked, run `git rm -r --cached docs/.leji` first. Make sure the root `.gitignore` carries the bare line `.leji/`. If `.leji/mounts.local.json` was ever committed, `git rm --cached` it: it is a per-machine file the CLI reads and never writes, and once it is gone a fresh clone needs every pinned commit reachable on its remote.
3. Run `leji validate`. Version 1.5 added two errors, `link-unresolved` and `decision-number-duplicate`, so a context layer that was green on 1.3.x can go red on a dangling link or a duplicated record number. Fix the sources; do not suppress. A `boot-profile-sections` warning means the boot profile lacks one of its identity, loading, or posture headings.
4. Run `leji index` to regenerate the index. Since 1.5 the viewer's sidebar follows the order in the index files, so reorder or alphabetize them if the old order mattered.
5. Re-run `leji ci` for the repository's provider (pass `--provider` if it is not inferred; CircleCI never is), and add `--hooks` if hooks were generated. It refreshes the managed hook block. On GitHub Actions, CircleCI, and Azure Pipelines it recognizes an unedited 1.3.x workflow and replaces it, and leaves an edited workflow alone with a snippet to merge by hand; on GitLab it owns a marked block inside the shared `.gitlab-ci.yml` and replaces that block, edits inside it included. Review the diff before keeping it.
6. If `leji.json` sets `viewer.theme.primary`, the value must be hex (3, 4, 6, or 8 digits) since 1.4. The map in `overview.md` is rendered at read time, so delete the lines between the `leji:generated-map` markers, keeping the markers; the file itself is never rewritten.
7. Finish with `leji validate`, `leji index --check`, and `leji conformance`. Report failures, unknowns, and the process items that need a person's confirmation; a federated context layer also runs `leji conformance --federation verify` so pin reachability is checked rather than unknown.
```

## License

Code, schemas, templates, and the SDK: Apache-2.0. Specification prose and rationale: CC-BY-4.0. See [LICENSE.md](LICENSE.md).

## Governance

See [GOVERNANCE.md](GOVERNANCE.md) and the direction in [ROADMAP.md](ROADMAP.md). Leji was created by [Vuong Nguyen](https://vuongnguyen.com); [Contexing, LLC](https://contexing.com) is the steward.
