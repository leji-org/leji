---
id: <role-id>
name: <Role name>
role: <role>
purpose: <one line>
# host + invocation only for agents engaged as external CLIs; omit for the resident agent.
# In command, <prompt> stands as its own unquoted shell word (never inside quotes).
host: <agent host, e.g. codex>
invocation:
  command: some-cli exec <prompt>
  constraints:
    - <operational constraint worth machine-knowing>
inherits: core
requiredRead:
  - docs/boot-profile.md
  - <paths this role loads before any task>
defaultContext:
  - system
  - practice
mustAskWhen:
  - <condition>
---

# <Role name>

<What this role does in this repository, and how its posture differs from core. Narrower than core, never looser.>
