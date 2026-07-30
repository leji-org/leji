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

If a task fits none of these types, locate its slice through `docs/context-index.json`; when nothing matches, load only the read-before-any-task set above and say that no task-specific context was routed.

<!-- Federated siblings. Only for a layer that declares federation.mounts in leji.json:
     name each mounted sibling in prose here, and carry the checkable form in a fenced
     block whose info string is leji-mounts, one record per declared mount:

     - mount: name of the sibling layer, matching the declaration
       owner: the declared owner.name, byte for byte
       carries: what that sibling holds, in your own task language
       read-when: the tasks that require it

     Fields are indented exactly two spaces and each appears once. Locate a hydrated
     sibling with `leji mounts locate <name>`; never infer a mount path. The fence is
     spelled out rather than shown, because a layer with no mounts that carried an
     empty leji-mounts block would fail validation. -->

## Posture

- Proceed without asking when: <defaults>
- Stop and ask when: <escalation triggers>
- Never: <hard lines>

Role-specific posture lives in `docs/agents/` (start with `core.md`).

## Viewing

A human-readable viewer renders this layer for people. At the start of a working session, offer to open it for the owner before you begin the task: `leji view` builds and serves it locally, then opens the browser. Ask first; never launch it unprompted, and don't re-offer within the same session.

## Maintenance

If a task surfaces missing or wrong context, fix it in the same change set. Every context layer change rides review; people approve.

When you change anything in this context layer:

- Append an entry to `docs/context-changelog.json`: id, date, type, one-line summary, affected paths.
- Decisions get a record in `docs/decisions/`; copy the shape of an existing one.
- Regenerate `docs/context-index.json` when files are added, moved, or retitled.
