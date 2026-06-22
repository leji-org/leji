---
summary: The constraints every change to this repository lives with.
freshness:
  reviewAfter: 2027-06-21
---

# System Invariants

- The spec is normative and single-sourced. `spec/*.md` is the only source of normative text; the site and the SDKs render or reference it and never fork it. Explanatory prose elsewhere on the site is non-normative.
- The spec versions by semver. A breaking change to the spec requires a new major version; within a major version, changes stay backward-compatible.
- Schemas have one source. `schemas/*.schema.json` at the repo root are canonical and are served at their canonical `$id` URLs under `https://leji.org/schemas/v1.0/`. Each SDK carries a synced copy that must match the root; the sync and parity scripts enforce it.
- The three reference SDKs stay at parity. TypeScript, Python, and Go implement the same `leji` CLI surface and pass the same shared `fixtures/`. A behavior change lands in all three and ships at one coordinated version, never one SDK ahead of the others.
- The SDK runs locally. It makes no network calls and collects no telemetry or data; validation and scaffolding work fully offline.
- Released artifacts are immutable. A published version on npm, PyPI, JSR, or Go is never re-published. Fixes go forward in a new version.
- This repository is public and carries only public content: the spec, the schemas, the reference SDKs and tooling, and the site. No business, engagement, or otherwise internal material belongs here.
- The repository is dual-licensed: Apache-2.0 for code and schemas, CC-BY-4.0 for the spec prose.
- Conformance claims are honest and checkable. This repo's own `leji.json` claims only the level it actually meets, verified by `leji conformance`.
