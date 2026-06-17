# Boot Profile

<!-- The agent-agnostic entrypoint of this context layer. Every agent host loads this file;
     every person can start here. Keep it a map and a posture, not a knowledge base. -->

## Identity

<One paragraph: what this repository/product is, who it serves, what stage it is at.>

## Loading

Read before any task (keep this set small; it is paid on every task):

- `docs/system/invariants.md`: the constraints every change lives with

Load by task type (only the slice the task needs):

- <task type> → <paths or category>
- <task type> → <paths or category>

The generated map at `docs/context-index.json` routes you to the right slice. Decision records declare the paths and categories they govern; load the decisions that touch your task, not the whole `docs/decisions/` directory.

## Posture

- Proceed without asking when: <defaults>
- Stop and ask when: <escalation triggers>
- Never: <hard lines>

Role-specific posture lives in `docs/agents/` (start with `core.md`).

## Maintenance

If a task surfaces missing or wrong context, fix it in the same change set. Every context layer change rides review; people approve.

When you change anything in this context layer:

- Append an entry to `docs/context-changelog.json`: id, date, type, one-line summary, affected paths.
- Decisions get a record in `docs/decisions/`; copy the shape of an existing one.
- Regenerate `docs/context-index.json` when files are added, moved, or retitled.
