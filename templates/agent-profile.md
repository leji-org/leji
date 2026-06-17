---
id: <role-id>
name: <Role name>
role: <role>
purpose: <one line>
# host + invocation only for agents engaged as external CLIs; omit for the resident agent
host: <agent host, e.g. codex>
invocation:
  command: <command template with <prompt> placeholder>
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
