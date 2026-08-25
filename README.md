# Leji

[![CI](https://github.com/leji-org/leji/actions/workflows/ci.yml/badge.svg)](https://github.com/leji-org/leji/actions/workflows/ci.yml)
[![Leji 1.0 · governed · self-attested](leji-badge.svg)](https://leji.org/agent-ready/)

**An open specification for the shared context layer of AI-native teams.** Leji (from the word *legible*, pronounced LEH-jee) defines a versioned, repo-owned context layer of how a team thinks: domain language, constraints, decision records, conventions, agent guardrails, one reviewed body of context that people and AI agents both read, changed through the same review gate as the code.

> **Status: 1.4.1.** The reference SDKs (`@leji-org/leji` on npm and JSR, `leji` on PyPI, and the Go module) are at 1.4.1. The specification and schemas are on the v1.0 line, **GA and frozen at the v1.3.0 reference-tooling release**: any incompatible change ships as a new line. See [spec/versioning.md](spec/versioning.md).

## Principles

1. **Intent over instructions.** Most AI adoption writes imperative, per-tool instructions. Leji captures durable intent: what things mean, what must hold, why it is so, and lets people and agents derive actions from declared intent plus task context.
2. **A circle, not a tier.** Human-to-human, human-to-AI, and human-to-AI-to-human are first-class flows around one shared context layer. Equal access, not equal authority: everyone with access to a context layer reads all of it, anyone proposes, people approve. Access is the version control system's to grant; restricted context lives in its own permissioned context layer.
3. **Mechanism over goodwill.** Shared context decays by default: reality moves, documents don't, and nothing forces a wiki current. Leji's forcing functions are mechanical, not goodwill: changes ride the same review gate as code, tooling fails on mechanical drift, freshness horizons flag what has aged, and stale context is never silently treated as current.

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
| `packages/sdk`, `packages/sdk-py`, `packages/sdk-go` | The reference SDKs and CLI (npm, PyPI, Go), behaviorally identical and tested against the shared `fixtures/`: validate, index, changelog, freshness, conformance, init |
| `packages/mcp` | The MCP server (`@leji-org/mcp`): the spec, schemas, validation, and conformance as read-only tools for coding agents |
| `packages/create-leji` | `npm create leji`: the zero-install bootstrap, routing to the SDK's `init` or `adopt` by what the target directory already holds |
| `packages/site/` | The spec website (plain Astro; deployable by anyone) |

## Generated files

The CLI keeps everything it generates under one `.leji/` directory at the repository root, in four roles: `mounts/` (materialized federation mounts), `viewer/` (generated viewer chrome), `dist/` (exported viewer builds), and `work/` (the transient onboarding workspace). All of it is machine-local, and none of it is committed. The first time a command creates one of those roles, the CLI writes `.leji/.gitignore` containing `*`, so the directory ignores itself; an existing `.leji/.gitignore` is left as it is, with a notice on stderr. `leji init` and `leji adopt` also add a bare `.leji/` line to the repository's root `.gitignore`.

One file the CLI writes is not generated output: `overview.md` at the context root. It is seeded once, when no `overview.md` stands there, and is never rewritten after that. The layer map lives between the `leji:generated-map` markers the seed leaves empty, and is rendered into the page when the page is read: by `leji view` and by `leji export`. A reindex therefore changes `context-index.json` and nothing else. If an older version of the CLI wrote a map into your `overview.md`, that block is ignored now; delete the lines between the markers whenever it suits you.

An exported viewer under `.leji/dist/` is plain static files whose Content-Security-Policy travels in the page's `<meta>` element, and a meta policy cannot carry `frame-ancestors`, so a host serving an export sets that directive as a response header itself, the way this repository's own site does in [`packages/site/public/_headers`](packages/site/public/_headers).

`.leji/mounts.local.json` is a per-machine hints file: it points the resolver at local checkouts of the context layers a federation mounts. The CLI reads it and never writes it. Do not commit it; a path on one machine is not a path on another.

Migrating from an earlier version:

- If `.leji/mounts.local.json` was committed, untrack it with `git rm --cached .leji/mounts.local.json`, and keep the bare `.leji/` line in the root `.gitignore`. Onboarding refuses to run while anything under `.leji/` is tracked, and the nested `.leji/.gitignore` takes precedence over any negation written at the root.
- A `docs/.leji/` tree left by 1.3.x is unused in 1.4.x and can be deleted.

Because the hints file stays uncommitted, a fresh clone hydrates its mounts through the resolver store or the manifest's remote URLs, so a pinned commit has to be reachable on its remote.

## License

Code, schemas, templates, and the SDK: Apache-2.0. Specification prose and rationale: CC-BY-4.0. See [LICENSE.md](LICENSE.md).

## Governance

See [GOVERNANCE.md](GOVERNANCE.md). Leji was created by [Vuong Nguyen](https://vuongnguyen.com); [Contexing, LLC](https://contexing.com) is the steward.
