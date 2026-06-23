---
id: raise-to-governed
title: Raise the Leji context layer to governed conformance
status: accepted
date: 2026-06-21
deciders:
  - Vuong Nguyen
affectedPaths:
  - leji.json
  - docs/
affectedCategories:
  - domain
  - system
  - practice
  - decisions
links:
  - 0001-adopt-leji.md
---

# Raise the Leji context layer to governed conformance

## Context

[Decision 0001](0001-adopt-leji.md) adopted Leji at `core` and named raising the level "future work, gated on `leji conformance` passing each level honestly." Since then the layer grew a `practice` category (the porting discipline) and agent profiles (`core`, `porter`, `reviewer`), and the reference tooling now generates the full machine-readable surface. A project whose pitch is machine-legible, governed context should run its own layer at the level it asks adopters to reach, not stop at the entry tier.

## Decision

Raise the claim to `governed`, earning each gate rather than asserting it:

- Generate and commit the context index (`docs/context-index.json`) and a machine changelog (`docs/context-changelog.json`); declare both paths in `leji.json`.
- Declare freshness horizons (`freshness.reviewAfter`) on the durable category docs, reported by `leji freshness`.
- Have CI validate the surface with the repo's own built CLI: the `dogfood` job runs `validate --content`, `index --check`, `conformance`, and `freshness` on every push and pull request, so a drifted index, a malformed or rewound changelog, or an over-claimed level fails the build. Appending a changelog entry for each change stays review discipline; the build proves the changelog exists, validates, and is append-only, not that every change brought one.
- Record the `practice` category and the `core`, `porter`, and `reviewer` agent profiles that grew the layer past 0001's original `system` / `domain` shape.

### The review gate for a single-owner layer

This repository has one owner, so name how "people approve" actually works here rather than perform a multi-reviewer process that does not exist. A change is proposed (often drafted by an agent), then **independently reviewed by a different agent** bound to the `reviewer` role in the `agents` map, then **approved by the owner on a pull request**: an approving review record bound to the change set, which is the auditable record [governance.md](../../spec/governance.md) requires, not a bare commit. The independent agent restores the at-the-gate perspective a second person provides, the structural answer to rubber-stamping one agent's own output; approval stays human and rides the review mechanism the spec names. This is the spec's team-of-one circle (see [rationale](../../rationale/README.md)): agents review and advise, the person owns and approves. It is not a relaxation of the governed gate, it is what that gate looks like at one person.

## Consequences

`leji conformance` checks the mechanical `governed` gates, index currency, changelog discipline, and freshness, and CI runs them on every push and pull request. The gate a tool cannot check, that a person approved the change through a review record, rides the pull request; together they make the `governed` claim honest rather than asserted. The repository now demonstrates the machine-readable and governed surfaces an adopter would copy, not just the minimum to boot, and shows that `governed` is reachable by a solo team through agent review plus human approval on a pull request rather than a committee. Index currency and changelog discipline are enforced mechanically, so the layer cannot silently drift from the tree. Reaching `federated` stays out of scope: it needs another repository to mount this layer as a pinned, docs-only sibling, which no real consumer does yet. A continuity owner remains unnamed; the layer honestly signals single-owner succession until a second accountable person exists.
