---
summary: What the core terms of this repository mean, in our own words.
freshness:
  reviewAfter: 2027-06-21
---

# Glossary

- **Spec.** The normative text in `spec/*.md`. The product of this repo, not its documentation. When people say "Leji" they usually mean the spec.
- **SDK.** The reference implementation of the `leji` CLI, shipped in three languages under `packages/` (TypeScript, Python, Go). It is a conformance checker and scaffolder, not a runtime or an agent. The spec is valid without it.
- **Site.** The Astro source under `packages/site` that builds leji.org. It renders the spec; it is never the source of normative text.
- **Parity.** The property that the three SDKs behave identically: same commands, same exit codes, same results on the shared fixtures. Not "roughly equivalent"; byte-checked by the parity script.
- **Fixtures.** The shared `fixtures/` cases (valid and invalid context layers, each with an `expected.json`) that every SDK runs. The single definition of correct CLI behavior.
- **Single-source.** Spec text and schemas each have exactly one canonical location; every other copy is generated or synced from it, never edited in place.
