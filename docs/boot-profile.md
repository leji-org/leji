# Boot Profile

<!-- The agent-agnostic entrypoint of this context layer. Every agent host loads this file;
     every person can start here. Keep it a map and a posture, not a knowledge base. -->

## Identity

This is the Leji repository: the home of the Leji specification, its reference SDKs and tooling, and the leji.org site. Leji is an open specification for the shared context layer of AI-native teams: a versioned, repo-owned record of how a team thinks, read by people and AI agents alike. It is public. Everything here is single-sourced: the normative spec (`spec/`) and its JSON Schemas (`schemas/`), the reference `leji` CLI in TypeScript, Python, and Go (`packages/sdk`, `packages/sdk-py`, `packages/sdk-go`), the MCP server and `create-leji` scaffolder (`packages/mcp`, `packages/create-leji`), and the website (`packages/site`). The spec and schemas are on the v1.0 line (GA, frozen at the v1.3.0 reference-tooling release); the packages release together, currently 1.3.1.

## Loading

Read before any task (keep this set small; it is paid on every task):

- `docs/system/invariants.md`: the constraints every change lives with.

Load by task type (only the slice the task needs):

- Editing the spec → `spec/` (normative; single-sourced, so change the source, not a copy).
- Schema change → `schemas/` plus each SDK's vendored copy (they must stay in sync).
- SDK or CLI change → `packages/sdk`, `packages/sdk-py`, `packages/sdk-go`, and `fixtures/` (all three SDKs at parity).
- Testing the CLI against a real repository → `docs/practice/testing-cli-adoptions.md` (LIVE vs PACKED evidence channels).
- MCP server or scaffolder change → `packages/mcp`, `packages/create-leji`.
- Site change → `packages/site`.
- Term meanings → `docs/domain/`. Recorded decisions → `docs/decisions/`.

Decision records declare the paths they govern; load the decisions that touch your task, not the whole directory.

If a task fits none of these types, fall back to `docs/context-index.json` to locate its slice; when nothing matches, load only the read-before-any-task set and say that no task-specific context was routed.

## Posture

- Proceed without asking when: inspecting the repo read-only, running local builds and tests, or drafting content inside this context layer.
- Stop and ask when: changing normative spec text, bumping a published version, touching the public/private boundary, or making a change that would break SDK parity.
- Never: re-publish an already-released version, commit internal or business content to this public repo, or loosen a posture rule in a role profile.

Role-specific posture lives in `docs/agents/` (start with `core.md`).

## Maintenance

If a task surfaces missing or wrong context, fix it in the same change set. Every context layer change rides review; people approve.

When you change anything in this context layer:

- Append an entry to `docs/context-changelog.json`: id, date, type, one-line summary, affected paths.
- Decisions get a record in `docs/decisions/`; copy the shape of an existing one.
- Regenerate `docs/context-index.json` when files are added, moved, or retitled.
