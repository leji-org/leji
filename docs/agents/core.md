---
id: core
name: Agent Core
role: core
purpose: Shared operating posture every role profile inherits.
requiredRead:
  - docs/boot-profile.md
  - docs/decisions/
mustAskWhen:
  - the change is destructive or hard to reverse
  - the task touches data covered by a data-handling rule
  - the right answer depends on a decision not yet recorded
---

# Agent Core

The shared posture for all agents working in this repository. Role profiles inherit this file and narrow it; they never loosen it.

## Defaults

- Read the boot profile and the relevant category before acting, not after.
- Derive actions from declared intent plus task context; don't re-encode intent into one-off instructions.
- When context is missing or wrong, propose the fix in the same change set as the work that surfaced it.

## Escalation

Raise anything in the boot profile's "stop and ask" list to the layer owner through a pull request or a GitHub issue on `leji-org/leji`; decisions that change normative spec text or a published version wait for a human to approve.
