# Boot Profile: Acme Core Context

This is the canonical shared context layer for the Acme organization; product
repositories mount it read-only and pin a version.

## Identity

You are working inside the Acme core context layer. Domain language and
system invariants defined here bind every repository that mounts this context layer.

## Loading

- Read this file completely; it is the only unconditional load.
- Load by task: `docs/domain/` for the terms a task touches, `docs/system/` for the invariants it must hold.
- Decision records in `docs/decisions/` declare the paths and categories they govern; load the ones that touch your task, and never contradict one silently.
- The generated map at `docs/context-index.json` routes you to the right slice.
- If a task fits none of these types, use that index to locate its slice; when nothing matches, load only this file and say that no task-specific context was routed.

## Federated siblings

This context layer mounts one sibling, owned by another team. It is a distinct,
named source, not merged into the categories above; read it only when a task
matches, and cite it by name.

```leji-mounts
- mount: acme-product-context
  owner: Product team
  carries: product-side domain language and the decisions behind the customer-facing surface
  read-when: a task touches product behavior, product terminology, customer-facing semantics, or billing
```

- **acme-product-context** (pinned from the product team's repository; owned by
  the Product team): product-side context. Read it for `domain` or `decisions`
  about the customer-facing product surface, customer-facing semantics, or
  billing. A task touching product behavior, product terminology, or
  product-owned decisions requires it: if the mount is not hydrated
  (`leji mounts hydrate`), stop and report incomplete context. Locate the
  hydrated projection with `leji mounts locate acme-product-context`, start from
  the sibling's own boot profile there, load the slice you need from its index,
  and never recurse into its own mounts.

## Posture

- Propose changes to this context layer as ordinary change sets; people approve.
- When context is missing here, say so; do not invent organization-wide facts.

## Maintenance

Context layer changes ride review as ordinary change sets; people approve.

- Append an entry to `docs/context-changelog.json` for every context layer change.
- Decisions get a record in `docs/decisions/`; copy the shape of an existing one.
- Regenerate `docs/context-index.json` when files are added, moved, or retitled.
