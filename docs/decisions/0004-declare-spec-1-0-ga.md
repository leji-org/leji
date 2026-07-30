---
id: declare-spec-1-0-ga
title: Declare spec 1.0 GA and freeze the line
status: accepted
date: 2026-07-01
deciders:
  - Vuong Nguyen
affectedPaths:
  - spec/versioning.md
  - spec/README.md
  - CHANGELOG.md
  - CHANGELOG.json
  - README.md
affectedCategories:
  - decisions
links:
  - 0003-category-index-files.md
---

# Declare spec 1.0 GA and freeze the line

## Context

The 1.0 spec line is complete: the content model, the machine-readable surface, federation, and conformance all have their shape, and the reference SDKs implement them at parity. A spec that can still change in place is not a spec anyone can build on. Independent implementers need the manifest shape, the schema `$id`, and the stability set to hold still before they will commit to them, and adopters need the same guarantee before they encode a context layer against the line.

## Decision

Spec 1.0 is **GA at the reference-tooling v1.3.0 release**, and frozen from it:

- Within the line, schema changes are additive only; the `$id` stays on `v1.0`.
- Any incompatible change ships as a new spec line with migration support, never in place.
- A line that ships before general availability declares that at its initial release; the mechanism is not applied to a line later.

The freeze is recorded in `spec/versioning.md`, the spec README status row, and both changelogs against the release that carries it rather than a calendar date, so it is auditable from public history and nothing has to be restamped if the release date moves.

## Consequences

Adopters and independent implementers can build against 1.0 with the manifest shape, the schema `$id`, and the stability set fixed. The cost lands on us: the next incompatible manifest or schema change buys a 2.0 line and a migration path, so shape questions have to be settled before they ship rather than after.
