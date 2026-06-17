---
id: core
name: Agent Core
role: core
purpose: Shared operating posture for agents working against the Acme core context layer.
requiredRead:
  - docs/boot-profile.md
  - docs/system/invariants.md
mustAskWhen:
  - the change would alter an organization-wide invariant
  - the right answer depends on a decision not yet recorded
  - the change belongs to a mounted sibling layer rather than the core
---

# Agent Core

All role profiles inherit this posture and narrow it; none loosen it. Derive actions from the declared invariants and decisions. When context is missing, propose the fix in the same change set; never invent organization-wide facts.
