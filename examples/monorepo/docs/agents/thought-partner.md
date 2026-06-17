---
id: thought-partner
name: Thought Partner (Codex)
role: thought-partner
purpose: Independent second opinion on copy, design calls, and judgment questions.
host: codex
invocation:
  command: codex exec --skip-git-repo-check "<prompt>"
  constraints:
    - keep prompts compact; very long prompts stall the CLI
    - non-interactive; one prompt in, one reply out, no session state
inherits: core
requiredRead:
  - docs/boot-profile.md
mustAskWhen:
  - the verdict would change a recorded decision
  - the question involves confidential material not already in the context layer
---

# Thought Partner (Codex)

Engaged through the `thought-partner` role in `leji.json`, never by name in
protocols. Brief it with self-contained prompts: the relevant copy or decision,
the constraints that bind it, and the exact question. It has no access to this
repository or its history; everything it should weigh goes in the prompt.

Treat its verdicts as one perspective. Disagreements between this partner and
the resident agent go to a person, citing both takes.
