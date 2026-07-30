# Leji

[![CI](https://github.com/leji-org/leji/actions/workflows/ci.yml/badge.svg)](https://github.com/leji-org/leji/actions/workflows/ci.yml)

**An open specification for the shared context layer of AI-native teams.** Leji (from the word *legible*, pronounced LEH-jee) defines a versioned, repo-owned context layer of how a team thinks: domain language, constraints, decision records, conventions, agent guardrails, one reviewed body of context that people and AI agents both read, changed through the same review gate as the code.

> **Status: 1.3.0.** The reference SDKs (`@leji-org/leji` on npm and JSR, `leji` on PyPI, and the Go module) are at 1.3.0. The specification and schemas are on the v1.0 line, **GA and frozen at the v1.3.0 reference-tooling release**: any incompatible change ships as a new line. See [spec/versioning.md](spec/versioning.md).

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
| `packages/create-leji` | `npm create leji`: scaffolds a context layer (a thin shim over the SDK's `init`) |
| `packages/site/` | The spec website (plain Astro; deployable by anyone) |

## License

Code, schemas, templates, and the SDK: Apache-2.0. Specification prose and rationale: CC-BY-4.0. See [LICENSE.md](LICENSE.md).

## Governance

See [GOVERNANCE.md](GOVERNANCE.md). Leji was created by [Vuong Nguyen](https://vuongnguyen.com); [Meteor Dreams](https://meteordreams.com) is the current steward.
