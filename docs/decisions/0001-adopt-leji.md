---
id: adopt-leji
title: Adopt the Leji context layer
status: accepted
date: 2026-06-18
deciders:
  - Vuong Nguyen
---

# Adopt the Leji context layer

## Context

Leji defines a shared context layer for other teams to adopt, but the repository that defines it did not run one. The spec preaches a practice its own home did not follow, and there was no single place an agent or a contributor could read how this project thinks before changing the spec, the schemas, or the three SDKs.

## Decision

Adopt Leji in this repository at the `core` level: a root `leji.json`, a boot profile, the `system` and `domain` categories populated with the repo's real invariants and vocabulary, and this decision record. Claim only `core`; the layer has no generated index or machine changelog yet, so claiming `indexed` or higher would be dishonest.

## Consequences

The spec's own repository now demonstrates conformance and an agent can boot it through Leji. Context fixes ride the same pull-request review as the work that surfaces them. Raising to `indexed` (a generated index plus a machine changelog) and `governed` (CI validation, agent profiles, freshness checks) is future work, gated on `leji conformance` passing each level honestly.
