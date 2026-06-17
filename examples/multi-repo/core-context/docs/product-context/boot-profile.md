# Boot Profile: Acme Product Context

This is the product team's context layer. The Acme core context layer mounts it as a federated sibling; the product team owns and approves every change here.

## Identity

Product-side domain language and decisions for Acme's customer-facing product surface.

## Loading

- Read this file completely.
- Load `domain/` for product domain language.
- Decision records live in `decisions/`.

## Posture

- Propose changes as ordinary change sets; the product team approves.
- This context layer is authoritative for product context only; defer to the core context layer for organization-wide invariants.

## Maintenance

Changes ride review as ordinary change sets; people approve. Record decisions in `decisions/`; copy the shape of an existing one.
