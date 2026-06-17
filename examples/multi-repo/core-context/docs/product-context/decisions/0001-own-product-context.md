---
id: own-product-context
title: Own the product context as a federated sibling
status: accepted
date: 2026-06-10
deciders:
  - Rin Mehta
affectedCategories:
  - domain
---

# Own the product context as a federated sibling

## Context

Product-side domain language was being pulled into the core context layer, separating it from the team accountable for keeping it true.

## Decision

Keep product context in its own context layer, owned by the product team, and mount it into the core context layer under federation rather than copying it in.

## Consequences

The product team approves its own context changes. The core context layer reads this context layer at a pinned version; ownership and accountability stay with the product team.
