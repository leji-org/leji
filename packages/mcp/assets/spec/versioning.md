# Versioning

Three things version independently: the specification, the schemas, and any implementing tooling.

## The specification

1. The spec carries a SemVer version (currently **1.0.0**). Breaking changes require a major version; every change is recorded in the repository changelog.
2. A context layer declares the spec line it targets in `leji.json` via the self-naming `leji` key (e.g. `"leji": "1.0"`), following the OpenAPI convention. Tooling **MUST** validate a context layer against the declared line, not the newest one.

## The schemas

3. Each schema carries a stable `$id` of the form `https://leji.org/schemas/v<major>.<minor>/<name>.schema.json`. The `$id` line moves only when the schema's shape changes incompatibly.
4. Within a published line, schema changes **MUST** be additive (new optional fields). Field removals or semantic changes require a new line.
5. Machine-readable artifacts other than the manifest declare the schema line they were written against via `schemaVersion`; the manifest declares its target spec line via the self-naming `leji` key (item 2).

## Stability set

The following are frozen within a spec line; tooling (including future commercial implementations) builds against them with no parallel schema:

- the manifest shape and its fixed filename `leji.json`,
- the category identifiers (`domain`, `system`, `practice`, `governance`, `decisions`),
- the conformance level identifiers (`core`, `indexed`, `governed`, `federated`),
- identifier and path normalization rules per [machine-readable-surface.md](machine-readable-surface.md),
- the index entry, changelog entry, agent profile, and decision record shapes.

## Implementing tooling (non-normative)

SDKs and CLIs version on their own SemVer and declare which spec lines they support. The reference SDKs in this repository are the `@leji-org/leji` npm package (packages/sdk), the `leji` PyPI package (packages/sdk-py), and the `leji` Go module (packages/sdk-go, a single static binary); they are behaviorally identical and tested against one shared fixture suite.
