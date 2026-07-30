---
id: category-index-files
title: Map categories to curated index files and derive the viewer from the repository tree
status: accepted
date: 2026-06-23
deciders:
  - Vuong Nguyen
affectedPaths:
  - leji.json
  - spec/
  - schemas/
  - packages/
affectedCategories:
  - system
  - decisions
links:
  - 0001-adopt-leji.md
---

# Map categories to curated index files and derive the viewer from the repository tree

## Context

The 1.0 model maps each category to content directory paths in the manifest, and the viewer renders a flat boot-to-category-to-document map from the generated index. Adopting into a repository that already has a large, multi-directory documentation tree fails in practice:

- A real topical directory holds documents of more than one category, so it cannot carry a single category. Mapping the whole directory either forces one wrong label on everything or floods one category with unrelated files.
- The viewer cannot mirror the repository's own navigation, so it does not replace the hand-maintained sidebars teams already keep, and a large tree either flattens into an unreadable list or stays outside the layer entirely.
- Classification (what a document is) and location (where it lives) were bound together in the directory, when they are independent.

## Decision

Separate classification from location.

- **Categories map to curated index files, not content paths.** Each category in `leji.json` declares one or more index files (`categories.<id>.indexes`). A category may have several, so a large category can be split and different area owners can own different index files within it.
- **Index files are authored markdown with a constrained inclusion block.** Each index file carries human prose plus a fenced `leji-index` block listing the directories and files that belong to that category. Listing a directory includes it wholesale; listing files selects from a mixed directory. Content stays wherever it already lives and is never moved.
- **The generated index stays the machine contract.** `leji index` compiles the index files into `context-index.json`; agents and the viewer read the compiled output. The authored markdown is the single source; the JSON is generated from it.
- **Inclusion is an explicit, reviewed act.** A document becomes governed context only when an owner lists it in a category index file, under review. Documents left unlisted are reference: present and browsable, not governed, not loaded as context.
- **The viewer derives navigation from the repository tree.** It renders the governed spine as a grouped section, then the repository's own directory structure as a browsable section below it, so the layer surfaces its governed context and mirrors the team's navigation in one view.
- **Layout is never hardcoded.** Every path the tooling writes is manifest-declared; the scaffolder is the only place a default name appears, and `adopt` detects collisions with existing directories and resolves them before writing.
- **`adopt` proposes a classification, it does not impose one.** Scaffolding stays deterministic; the handoff brief drives an agent to read the whole tree, classify each document, and populate the index files as a reviewed proposal, applying the inclusion bar so reference content is not absorbed.

The five-category vocabulary stays closed, and decision records keep their own schema and append-and-review discipline; this changes how content is mapped and navigated, not what the categories mean.

## Consequences

A repository adopts Leji over its existing structure instead of bending to it. Classification scales to large, mixed trees because it is per-document and authored in one reviewable surface per category, rather than inferred from a directory. The viewer becomes useful as the team's actual documentation view, which removes the reason to hand-maintain a separate sidebar. The inclusion gate moves to the category index files, where promotion is visible and reviewed, and `leji status` reports unindexed, stale, or dangling entries so the curation stays honest over time.

This revises the manifest shape and the index pipeline. The `categories.<id>.paths` form is removed rather than carried. The 1.0 line is not yet frozen, so it is reset in place rather than bumped: the schema shape changes under the same `v1.0` `$id`, and the line freezes at general availability. The change lands across the spec, the schemas, and all three SDKs at parity, with the conformance and viewer surfaces updated to match.
