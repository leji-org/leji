---
id: agents-md-discovery-adapter
title: Recognize AGENTS.md as the portable discovery adapter and generate it by default
status: accepted
date: 2026-07-17
deciders:
  - Vuong Nguyen
affectedPaths:
  - adoption/README.md
  - packages/sdk/
  - packages/sdk-py/
  - packages/sdk-go/
affectedCategories:
  - practice
  - decisions
---

# Recognize AGENTS.md as the portable discovery adapter and generate it by default

## Context

The spec's vendor-adapter rule treats every agent-host entrypoint file the same way: it MAY exist, it MUST redirect to the boot profile, and it never holds canonical content. The adoption guide went further in tone, advising teams to delete or empty every vendor file they could, and the reference CLI never created one. That flat bucket no longer matches the ecosystem. `AGENTS.md` is stewarded by the Linux Foundation's Agentic AI Foundation and is read natively by a broad set of agent hosts (Codex, Copilot, Cursor, and others); it is a cross-host discovery convention, not one vendor's file. Coverage is not universal: Gemini CLI defaults to `GEMINI.md` and reads `AGENTS.md` only when its context filename is configured, so a pointer-only `AGENTS.md` cold-starts most hosts, not all. Treating it as vendor noise costs adopters the one cold-start path most hosts already follow, for no governance benefit: a pointer-only entrypoint concedes nothing about where the truth lives.

The distinction that holds is role, not origin: canonical governed context (the context layer), discovery adapters that point to it, and host-specific mechanics. Whether an adapter is portable or single-vendor changes tooling defaults, never canonicality.

## Decision

Recognize `AGENTS.md` as the portable discovery adapter. `leji init` and `leji adopt` write a pointer-only root `AGENTS.md` by default when none exists (`--no-agents` skips it); an existing file is never touched, and adopt's migrate / `--wire-adapters` flow for present entrypoints is unchanged. Single-vendor entrypoints (`CLAUDE.md`, `GEMINI.md`, `.cursorrules`, and the rest of the well-known set) keep today's behavior: never created, converted to redirects only with consent. The adoption guide drops the delete-what-you-can posture in favor of the discovery-adapter framing: direct invocation stays the cleanest entry, and a pointer-only `AGENTS.md` covers everyone who cold-starts without it.

No spec or schema change. The vendor-adapter rule's requirements (pointer-only, MUST redirect, MUST NOT hold canonical content) apply to `AGENTS.md` exactly as before, and the 1.0 GA freeze ([0004](0004-declare-spec-1-0-ga.md)) is untouched.

Out of scope, deliberately: the cross-host skills convention (`SKILL.md`, `.agents/skills/`) is not added to the spec or the reference tooling. Skills are procedural, executable extensions with their own lifecycle, trust, and permission questions, and they have their own standard and steward. Any Leji-side support waits for the extraction gate: real adopters sharing skills across hosts from governed repositories, with the review and freshness lifecycle demonstrated, before any normative move.

## Consequences

A scaffolded layer now cold-starts correctly in every host that auto-loads `AGENTS.md`, with zero content outside the context layer. The one-source-of-truth rule is unchanged and easier to hold to, because the default path gives hosts a sanctioned pointer instead of tempting per-host files. The CLI stays deterministic across the three SDKs. The recognition test this decision applies (public specification, governance outside one product team, multiple independent implementations) is the bar any future entrypoint convention must meet before tooling treats it as portable.
