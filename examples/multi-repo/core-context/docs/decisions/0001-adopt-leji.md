---
id: adopt-leji
title: Adopt the Leji context layer for the organization
status: accepted
date: 2026-06-10
deciders:
  - Sam Park
affectedCategories:
  - governance
---

# Adopt the Leji context layer for the organization

## Context

Acme runs many product repositories. Organization-wide domain language and invariants lived in scattered wikis and chat threads, so each product team and its agents drifted from the shared meaning.

## Decision

Stand up a dedicated core context layer at the `federated` shape: product repositories mount it read-only and pin a version, and sibling team context layers mount under federation with ownership intact.

## Consequences

The core context layer stays small and owned by a named team. Product repositories consume it as a docs-only submodule; nothing builds against it. Sibling context layers compose without being absorbed.
