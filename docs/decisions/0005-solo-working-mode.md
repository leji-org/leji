---
id: solo-working-mode
title: Add a solo working mode with an owner interview and artifact-drop onboarding
status: accepted
date: 2026-07-16
deciders:
  - Vuong Nguyen
affectedPaths:
  - templates/onboarding-brief.md
  - templates/identity.md
  - templates/writing-style.md
  - packages/sdk/
  - packages/sdk-py/
  - packages/sdk-go/
affectedCategories:
  - practice
  - decisions
---

# Add a solo working mode with an owner interview and artifact-drop onboarding

## Context

Onboarding was extraction-shaped: `init` asked structural questions, and the brief told the agent to inventory the repository and classify what exists, asking the owner only what it could not verify. That serves teams with an existing docs tree. A team of one is served twice badly: a fresh repo offers nothing to extract, and the context that matters most for a solo owner (identity, audience, business vocabulary, writing voice) is not code-adjacent, so accretion never captures it either. Typed answers alone are also too narrow an input: the owner's best evidence is usually existing artifacts (a bio, a brand document, real writing samples).

## Decision

Add `--mode <solo|team>` to `init` and `adopt` (`team` is the default and today's behavior; interactive `init` asks on a TTY only, so piped runs are unchanged). Solo scaffolds `domain/identity.md` and `practice/writing-style.md` starters, maps `practice`, routes both in the boot profile by task, and stamps the brief, whose interview elicits identity, business voice, and writing style. Every interview question accepts text, attached files, pasted paths, or a drop folder (`<root>/.leji/onboarding-inputs/`); the agent synthesizes from artifacts and the owner approves a safe-to-commit summary. Raw artifacts live only in the transient gitignored `.leji/` workspace and are deleted at finalize; `init`/`adopt` refuse while `.leji/` files are tracked, the ignore entry lands before any transient write, and seeded changelogs exclude dot-paths.

The mechanism is deliberately bounded: one-shot onboarding evidence, no ingestion commands, no source retention, no URL fetching, no recurring optimization. Owner-declared identity and writing conventions are domain facts and conventions; the proven-twice gate keeps applying to prompt and workflow patterns. No spec or schema change: the five categories carry the new content, and the 1.0 GA freeze ([0004](0004-declare-spec-1-0-ga.md)) is untouched.

## Consequences

A team of one gets a real onboarding path instead of an empty scaffold, and fresh teams get a compact organizational interview when extraction comes up thin. The CLI stays deterministic across the three SDKs (the interview richness lives in the brief). Reference tooling gains a privacy boundary it must keep honoring: raw owner artifacts are evidence, never content, and never enter git.
