# Conformance

Partial adoption is by design. Four levels, each containing the previous; a team claims its level in the manifest (`conformance.claimedLevel`) and the claim is checkable by tooling. Self-attestation only: there is no certification program.

## Level 1: `core`

A context layer exists and both people and agents can work from it.

- [ ] The context layer lives in a git repository, versioned with the work it describes (per [context-layer.md](context-layer.md), Requirements).
- [ ] `leji.json` at the repository root, valid against the manifest schema.
- [ ] A boot profile at the declared path, covering identity, loading, and posture.
- [ ] At least `domain` or `system` mapped and populated, plus `decisions` with at least one real decision record.
- [ ] A named primary owner.
- [ ] Vendor entrypoint files, if present, redirect to the boot profile.

## Level 2: `indexed`

The context layer is legible to tooling.

- [ ] All of `core`.
- [ ] A generated context index, current with the tree.
- [ ] A machine-readable changelog; context layer changes append entries.

## Level 3: `governed`

The forcing functions are mechanical, not goodwill.

- [ ] All of `indexed`.
- [ ] Context layer changes ride the repository's review gate; people approve.
- [ ] Agent profiles (at least a core profile) valid against the profile schema.
- [ ] CI validates the surface: manifest, index matches the tree, changelog discipline, profile frontmatter, link integrity.
- [ ] Freshness horizons are declared and checked (report-only is acceptable).

## Level 4: `federated`

The context layer spans a multi-repo organization.

- [ ] All of `governed`.
- [ ] The context layer is consumed by at least one other repository as a docs-only mount, pinned, with pin updates arriving as reviewable change sets.
- [ ] Stale-pin reporting is in place.
- [ ] Any sibling context layers are mounted with ownership intact per [distribution.md](distribution.md).

## Notes (non-normative)

`core` is an afternoon, `indexed` is a tooling run, `governed` is where the context layer stops depending on anyone's discipline, and `federated` is for organizations that need one truth across many repositories. Most teams should reach `governed` and stop; `federated` exists for those organizations, not as a maturity badge.
