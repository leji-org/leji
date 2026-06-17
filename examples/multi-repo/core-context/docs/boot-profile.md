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

## Posture

- Propose changes to this context layer as ordinary change sets; people approve.
- When context is missing here, say so; do not invent organization-wide facts.

## Maintenance

Context layer changes ride review as ordinary change sets; people approve.

- Append an entry to `docs/context-changelog.json` for every context layer change.
- Decisions get a record in `docs/decisions/`; copy the shape of an existing one.
- Regenerate `docs/context-index.json` when files are added, moved, or retitled.
