---
id: reviewer
name: Reviewer
role: reviewer
requiredRead:
  - docs/boot-profile.md
mustAskWhen:
  - "the change reverses a recorded decision"
invocation:
  command: some-tool <prompt>
---

# Reviewer

Reviews a change against its plan.
