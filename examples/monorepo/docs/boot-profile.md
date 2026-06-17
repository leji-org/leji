# Boot Profile

## Identity

Acme Billing is a B2B invoicing platform: a TypeScript monorepo with three services (invoicing, payments, ledger) and one web client, in production since 2024.

## Loading

Read before any task (kept small; it is paid on every task):

- `docs/system/invariants.md`: the rules every change lives with

Load by task:

- billing or invoicing work → `docs/domain/glossary.md` (what invoice, credit note, and settlement mean here)
- changing settled behavior → the decision records that govern it (each declares its `affectedPaths` / `affectedCategories`)

The generated map at `docs/context-index.json` routes you to the right slice. Load the decisions that touch your task, not the whole `docs/decisions/` directory.

## Posture

- Proceed without asking: refactors with passing tests, additive schema changes, doc fixes.
- Stop and ask: anything touching settlement math, deletion of customer data, new external dependencies.
- Never: write secrets to the repo, bypass the ledger API to mutate balances.

Role posture starts at `docs/agents/core.md`.

## Maintenance

If a task surfaces missing or wrong context, fix it in the same change set. Every context layer change rides review; people approve.

When you change anything in this context layer:

- Append an entry to `docs/context-changelog.json`: id, date, type, one-line summary, affected paths.
- Decisions get a record in `docs/decisions/`; copy the shape of an existing one.
- Regenerate `docs/context-index.json` when files are added, moved, or retitled.
