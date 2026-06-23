<!-- Leji onboarding brief. Transient: written by `leji init`/`adopt` so an AI agent
     can populate this context layer from the real repository. It is not canonical
     context; its finalize step deletes this brief file once the layer is populated.
     It lives under a dot-directory (`<root>/.leji/`, gitignored) alongside the
     generated viewer, so it is excluded from the index, the viewer, and the changelog. -->

# Onboarding brief for the agent

You have been pointed at a freshly scaffolded **Leji context layer**. Turn the placeholder
scaffold into a small, accurate, repository-specific layer that people and agents can work
from. Do this **with the owner, not around them.**

Leji's governance is a circle: **anyone proposes, people approve.** You are proposing; the
owner approves. The load-bearing, hardest-to-infer facts, the **system invariants**, what
needs a **human gate**, and **ownership**, must be confirmed by the owner before they become
canonical. Draft them, but do not assert them as settled.

## What a Leji context layer is

A versioned, governed set of human-readable markdown documents encoding how this team thinks:
domain language, system invariants, conventions, guardrails, decision records. The machine
files (`leji.json`, index, changelog) only help tooling locate and check that meaning.

## The files you will populate

`leji.json` at the repository root declares the context root (default `docs/`) and the owner.
Read it first. Under the root:

- **boot-profile.md**: the entrypoint: **Identity** (what this repo is, who it serves, its
  stage), **Loading** (the small always-read set + task routing), **Posture** (proceed / ask / never).
- **domain/**: what core terms mean here, including what they do *not* mean (5-10 terms).
- **system/**: the hard invariants every change lives with; what must never be lost/leaked/silently changed.
- **practice/** (if mapped): conventions proven at least twice.
- **governance/** (if mapped): what an agent may do unprompted, what needs a human gate, what is sensitive.
- **decisions/**: one short record per real decision; copy the shape of `0001-adopt-leji.md`.

Diagrams help: a fenced `mermaid` code block in any document renders as a diagram in the
viewer, so reach for one when an architecture, flow, or relationship is clearer drawn than described.

## Phase 1: inspect and draft

1. **Inspect the repository**: `package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml`, the
   layout, the README, CI config, the main entry points. Build an accurate picture before writing.
2. **Draft specific, repo-grounded facts.** Where you must infer a HIGH-STAKES fact you cannot
   verify from the repo, mark it unconfirmed instead of asserting it:
   - a system invariant → `TODO(confirm-invariant): <your inference>`
   - a human gate / posture rule → `TODO(confirm-gate): <your inference>`
   - the owner / continuity owner → `TODO(confirm-owner): <your inference>`
   - an inferred decision → write the record with `status: proposed` (not `accepted`).
   For anything you simply do not know, use a plain `TODO: <what is still needed>`.
3. **Never invent to look finished.** `leji validate --content` counts your `TODO(confirm-…)`
   markers and `status: proposed` decisions as **owner confirmations pending**.

## STOP: confirm with the owner

Before you finalize, present a **short** confirmation summary and get an explicit yes. Confirm
only the load-bearing claims, not every term:

- the **system invariants** you drafted,
- the **proceed / ask / never** posture (what an agent may do unprompted vs. must gate),
- the **primary owner** and **continuity owner** (or an explicit solo / no-continuity posture).

Ask only what you could not verify. A few sharp questions beat a long interview.

## Phase 2: finalize (only after the owner confirms)

- Replace each `TODO(confirm-…)` with the confirmed wording (or correct it to what the owner said).
- Flip each confirmed `status: proposed` decision to `status: accepted`.
- Leave any genuinely-unknown plain `TODO:` in place and call it out.
- Run `leji validate`, `leji validate --content` (no remaining unconfirmed markers unless an
  intentional, flagged TODO), and `leji conformance`; report the level reached.
- Invite the owner to read what you built: `leji view` generates the viewer, serves it
  locally on 127.0.0.1, and opens it in the browser. Offer to run it (or hand them the
  command); seeing the layer is what closes the loop for the humans who will rely on it.
- As your last step, once everything above passes, delete this transient brief file
  (`<root>/.leji/onboarding-brief.md`): it is scaffolding, not context. Leave the rest of
  `<root>/.leji/` in place (it holds the generated viewer and is gitignored).

In your final report, **quote the owner's confirmation** of the invariants and gates. The tool
cannot prove a conversation happened; your report and the repository's review gate are the record.

## Boundaries

Only create or edit files Leji owns under the context root. Treat existing `CLAUDE.md`,
`AGENTS.md`, `.cursor/rules`, `.github/copilot-instructions.md` and similar as **read-only inputs
to learn from**; never rewrite them, and never wire a vendor redirect without showing the owner
the exact change and getting a yes.
