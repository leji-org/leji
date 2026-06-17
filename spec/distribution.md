# Distribution

Where the context layer lives relative to the work it describes. Three patterns; one rule throughout: the context layer is docs-only and **MUST NOT** introduce a build or runtime dependency into any consuming repository.

## Pattern 1: Monorepo (default)

The context layer lives in the same repository as the code and infrastructure it describes, at the context root. This is the **RECOMMENDED** pattern wherever the team's work lives in one repository: code, infra, and context version together, and drift is structurally hard.

## Pattern 2: the docs-only submodule for multi-repo setups

When work spans many repositories, the context layer lives in a dedicated context repository, and consuming repositories mount it as a git submodule.

1. The context repository is a normal git repository with its own `leji.json`, branch policies, and review gate.
2. Consuming repositories **MUST** mount it at a fixed path (**RECOMMENDED**: `context/`) and **MUST NOT** couple any build or runtime step to its presence: a missing or stale mount degrades knowledge, never the build.
3. Each consuming repository pins a specific version of the context layer. Pin updates **MUST** arrive as reviewable change sets (scripted or bot-raised pull requests), so context changes are visible, reviewable, and attributable per repository.
4. Tooling **SHOULD** report stale pins (how far each consuming repository is behind the context layer). Stale-pin reporting **MUST** precede any blocking enforcement: visibility first, gates later.

## Pattern 3: federation of sibling context layers

Patterns 1 and 2 each have a single context layer: a monorepo owns one, and a multi-repo organization consumes one. Federation is the pattern for an organization where **more than one team already owns a context layer of its own**, and the goal is to make those context layers legible to each other without anyone surrendering control.

The instinct is to merge them: one context repository, every team's knowledge pulled in. Resist it. A context layer stays current because the people who own it read it on every task and fix what's wrong in the same change set. Pull product's context into platform's repository and you have separated product's content from product's accountability; it rots while everyone assumes someone else now owns it. Centralizing knowledge recreates the bottleneck that put it in heads and threads to begin with.

Federation composes the context layers instead of absorbing them. A team's context layer joins another team's graph as a **sibling**: mounted, referenced, and read, never copied.

1. A sibling context layer mounts as its own docs-only submodule, declared in the host manifest's `federation.mounts` with the sibling's `name` and `owner` named, and **SHOULD** carry its `source` repository so stale pins can be reported. The docs-only rule from pattern 2 still holds: nothing in the host builds or runs against the mount.
2. The sibling keeps everything that makes it alive: its own repository, owner, review gate, changelog, and conformance claim. The host **MUST NOT** copy sibling content into itself. Content separated from the team that owns it goes stale with nobody responsible, which is the exact failure federation exists to prevent.
3. The host references the sibling at a pinned version; pin updates arrive as reviewable change sets and stale-pin reporting applies per pattern 2. A mount records *which version of another team's truth this repository was reading*, not a fork of it.
4. **Mounting enables reading, not authority, and does not grant access.** A host that mounts a sibling routes readers and agents into it when they already have access to it; mounting neither grants that access nor approves the sibling's changes. Each context layer's writes are still approved by its own owner, and who may read it is still the version control system's to decide. Federation composes readable context for the participants the relevant repositories already admit; it leaves who-approves, and who-may-read, exactly where they were.
5. **Mounts are direct and flat.** A host composes the siblings it names; tooling **MUST NOT** recurse into a sibling's own mounts. Each mount's `path` and `name` **MUST** be unique within the host manifest, and a mount **MUST NOT** reuse the host context layer's own `name`. Because nothing traverses past a context layer's declared siblings, diamonds and cycles are inert: `A` mounting `B` and `C` while `B` also mounts `C` is three direct relationships, not a graph to walk.

Mounted context layers are **distinct, named sources, not merged** into the host's categories. The host's own context layer is authoritative for the host's repository; each sibling is authoritative for its own. There is no organization-wide namespace, and so no cross-sibling precedence to resolve: an agent loads the slice it needs from the context layer that owns it, named. Stale-pin reporting reads the pinned revision from the submodule itself; the manifest's `source` is an optional convenience mirror of that upstream, not the pin of record.

A context layer reaches `federated` conformance only when these relationships are real and checkable: the context layer is consumed by at least one other repository as a pinned mount, stale-pin reporting is in place, and any sibling mounts are present with ownership intact (see [conformance.md](conformance.md)). The reference SDK validates the mechanical parts: that each declared mount exists, carries its own `leji.json`, matches the declared name, and is unique within the manifest.

A worked manifest for this shape is in [`examples/multi-repo/`](../examples/multi-repo/).

The circle composes ownership; it doesn't centralize it. A monorepo is one team's circle of people and agents reading one context layer; a multi-repo organization is a circle of those circles, each still owned by the people who keep it true.

### Restricted mounts

Federation crosses an access boundary when the layers composed have different audiences (see [governance.md](governance.md)). Access stays the version control system's to enforce: a reader either can resolve a mount's repository or cannot. The spec's job is to keep that boundary from leaking and from failing silently.

1. A restricted layer **MUST NOT** be declared as a mount in a host whose audience is broader than the restricted layer's own: every participant the host admits must already be admitted to the mounted layer. The mount declaration itself (its presence, `name`, `owner`, `role`, and `source`) **MUST NOT** disclose anything the host's audience may not see. Where a broader audience needs a restricted decision, publish a redacted companion layer or a public decision summary, not a mount to the restricted layer.
2. A mount is a reference, not an access grant. Declaring a mount never widens who may read the mounted layer beyond what the version control system already allows; whether a given reader can resolve it is decided there, not by the host manifest.
3. **Fail closed, never silently.** A reader that cannot resolve a mounted layer a task requires **MUST** stop and report incomplete context. It **MUST NOT** proceed as though the inaccessible layer does not exist: an agent acting on partial context it cannot see is the failure this rule exists to prevent.

## Notes (non-normative)

The submodule pattern's bad reputation comes from code submodules with build coupling. A docs-only leaf has none of those failure modes: nothing compiles against it, nothing breaks when it lags, and the pin is just a recorded "which version of the truth was this repository working from", which is information, not risk.

Federation looks like more moving parts than a merge, and is less. A merge is cheap once and expensive forever: every cross-team edit thereafter routes through whoever owns the central repository, and the parts no single team reads daily are the parts that rot. Sibling mounts keep each context layer small, owned, and read, and pay only the price of a pin update, which is a reviewable diff, not a meeting.
