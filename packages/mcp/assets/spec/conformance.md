# Conformance

Partial adoption is by design. Four levels, each containing the previous; a team claims its level in the manifest (`conformance.claimedLevel`). Self-attestation only: there is no certification program.

Conformance is evaluated against **the context layer as it is materialized where the check runs**, not against a canonical layer that a copy might represent. A copy reached without its repository is read in the degraded mode of [context-layer.md](context-layer.md), and degraded reading is never a path to canonical authority: such a copy does not verify, and the tooling says so rather than leaving the question open.

Most checklist items are **machine-verified**: the reference tooling checks them against the layer and fails a claim they do not hold. Four outcomes are reported, and they are deliberately not interchangeable:

- **`fail`**: the evidence was gathered and the requirement is not met.
- **(process-attested)**, reported as **`manual`**: the item describes a team practice (a review gate, a CI job, an external consumer) that no tool can confirm from the repository alone, so the team stands behind it. Only items tagged **(process-attested)** below are ever reported this way.
- **`unknown`**: a machine item whose evidence was unobtainable in this run, such as the federated pin-reachability check without access to the source, or append-only discipline with no git baseline to compare against. `unknown` never awards a level, and never refutes a claim that an evidence-bearing run could confirm.
- **`not applicable`**: a conditional machine item that does not apply to this layer, such as the federated mount items on a layer that declares no mounts. It is not scored, and it is not evidence in either direction.

The `verifiedLevel` the tooling reports is the highest level whose applicable **machine-verified** items all pass, **never above the level the layer claims**; `fail` and `unknown` both prevent an award, and items that are process-attested or not applicable are not scored. The cap on the claim is deliberate: verification answers whether the claim holds, not what the layer could claim, so a layer claiming `core` whose evidence would carry it to `governed` still reports `core`, and the way to raise the reported level is to raise the claim. `verifiedLevel` never asserts the process-attested items, so a passing `verifiedLevel` is necessary but not sufficient for a level that carries them. Each item below is machine-verified unless tagged **(process-attested)**.

Two machine-verified items behave differently in a degraded copy, and the difference follows from what evidence each has. **Git presence** is answered: a copy that is not in a git repository does not meet the `core` requirement that the context layer lives in one, so the item is a `fail`. **Changelog append-only discipline** is not answered: the file may be entirely well-formed while the prior committed state needed to compare against is unreachable, so the item is `unknown` and the layer simply does not verify at `indexed` from that copy. Neither is reported `manual`, which is reserved for the tagged process-attested items. Separately, the freshness reader rule (surface stale loaded context, and stop or ask on an expired **required** item, per [governance.md](governance.md)) is reader-behavioral, not a conformance gate: the reference `leji route` stamps each routed document with its review horizon and expiry so an agent can apply it.

Three items are verified today at less depth than their stated intent, and the gap is named here rather than left for a reader to discover. The boot-profile item is verified as presence at the declared path; whether it actually covers identity, loading, and posture is reported by the opt-in `--content` lint as warnings, not gated. The real-decision item is verified as schema-valid frontmatter on at least one resolved record; body substance (an actual decision, not a stub) likewise rides `--content`. The changelog item is the third: append-only discipline is checked against the file's state at `HEAD`, which catches a rewrite still in the working tree, the case a pre-commit hook exists for. In a continuous-integration checkout the working tree **is** `HEAD`, so a rewrite that arrives already committed is not visible to the check, and the review of the change set is what covers it. The item therefore verifies the working tree, not the history. The intent stated in each of the three items remains normative for what a conforming context layer carries; deepening the machine checks, and comparing the changelog against an explicit base revision, are on the reference-tooling roadmap. Verification of `federated` additionally requires at least one declared `federation.mounts` entry: a provider-only context layer (one that is consumed by other repositories but declares no mounts of its own) verifies at `governed`, and its federated standing rests on the process-attested consumption items.

## Level 1: `core`

A context layer exists and both people and agents can work from it.

- [ ] The context layer lives in a git repository, versioned with the work it describes (per [context-layer.md](context-layer.md), Requirements).
- [ ] `leji.json` at the repository root, valid against the manifest schema.
- [ ] A boot profile at the declared path, covering identity, loading, and posture.
- [ ] At least `domain` or `system` mapped (via its index files) and populated with at least one resolved **intent** document (records alone carry no operating context), plus `decisions` with at least one **real** decision record: a record carrying a concrete `status` and an actual decision in its body, not an empty stub or placeholder.
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
- [ ] Context layer changes ride the repository's review gate; people approve. **(process-attested)**
- [ ] Agent profiles (at least a core profile) valid against the profile schema.
- [ ] CI validates the surface: manifest, index matches the tree, changelog discipline, profile frontmatter, declared paths resolve. **(process-attested)**
- [ ] Freshness horizons are declared and checked (report-only is acceptable).

## Level 4: `federated`

The context layer spans a multi-repo organization.

- [ ] All of `governed`.
- [ ] The context layer is consumed by at least one other repository as a pinned mount, with pin updates arriving as reviewable change sets. **(process-attested)**
- [ ] Stale-pin reporting is in place: consumers can see how far their pins trail the witness ref. The reference SDK's ancestry-aware report covers declared federation mounts; consumption-side reporting beyond that is the team's. **(process-attested)**
- [ ] Any sibling context layers are declared as complete pinned mounts per [distribution.md](distribution.md): a normalized `source` and a full commit `pin`, ownership intact. Materialization state on any one machine is not a conformance input.
- [ ] Each declared mount's pin is reachable from an advertised ref of its `source` (the declared `trackingRef`, or the source's default branch). This check needs source access: without it the result is `unknown`, and `unknown` never awards the level. A pin resolvable only through a machine-local hint is availability, not conformance.
- [ ] Each declared mount carries routing metadata: at least `categories`, plus `topics` or `requiredWhen`, so an agent can decide relevance without reading the sibling.
- [ ] The boot profile surfaces every mounted sibling, and the generated index carries the `mounts` routing array, so an agent discovers and loads siblings without reading the manifest (per [boot-profile.md](boot-profile.md), [machine-readable-surface.md](machine-readable-surface.md)).

## Notes (non-normative)

`core` is the minimum that makes a context layer real, `indexed` adds the generated surface tooling reads, `governed` is where the context layer stops depending on anyone's discipline, and `federated` is for organizations where more than one team already owns a context layer worth keeping whole. Most teams should reach `governed` and stop; `federated` exists for those organizations, not as a maturity badge.
