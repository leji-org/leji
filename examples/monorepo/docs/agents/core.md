---
id: core
name: Agent Core
role: core
purpose: Shared operating posture for all agents in this repository.
requiredRead:
  - docs/boot-profile.md
  - docs/system/invariants.md
mustAskWhen:
  - the change touches settlement math
  - the change deletes or exports customer data
  - the right answer depends on a decision not yet recorded
---

# Agent Core

All role profiles inherit this posture and narrow it; none loosen it. Derive actions from the declared invariants and decisions; when context is missing, propose the fix in the same change set.
