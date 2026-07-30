# Versioning

Three things version independently: the specification, the schemas, and any implementing tooling.

## The specification

1. The spec carries a SemVer version (currently **1.0.0**). Breaking changes require a major version; every change is recorded in the repository changelog.
2. A context layer declares the spec line it targets in `leji.json` via the self-naming `leji` key (e.g. `"leji": "1.0"`), following the OpenAPI convention. The value is the spec **line** (`major.minor`), never the spec's patch version: a patch release (`1.0.0` to `1.0.1`) refines wording or tooling without moving the line, so the manifest stays `"1.0"` across every patch. Tooling **MUST** validate a context layer against the declared line, not the newest one.

## Preview lines

A spec line **MAY** be designated **preview**. A preview line is revisable in place: it **MAY** change in ways that would otherwise be breaking, rather than being bumped to a new version, until it is frozen at general availability (GA). The "breaking changes require a major version" rule (item 1) and the "`$id` moves on an incompatible shape change" rule (item 3) apply from the GA freeze onward, not while a line is in preview. At GA the line is frozen and both rules take effect.

A line that ships before general availability **MUST** declare that at its initial release.

The 1.0 line is **frozen at the v1.3.0 reference-tooling release**. Within the line, schema changes are additive only and the `$id` stays on `v1.0`; any incompatible change ships as a new line, never in place.

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
