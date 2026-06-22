# The Boot Profile

The **boot profile** is the agent-agnostic entrypoint of the context layer: one human-readable document that every agent host, and every person, can start from. It answers "what is this context layer, what do I load, and how do I behave here."

## Requirements

1. The context layer **MUST** have exactly one boot profile, located at the path declared by `bootProfilePath` in the manifest. The **RECOMMENDED** default is `docs/boot-profile.md`.
2. The boot profile **MUST** be plain markdown, readable by a person with no tooling. It **MUST NOT** depend on any vendor's configuration syntax.
3. The boot profile **MUST** cover:
   - **Identity**: what this repository or product is, in a paragraph.
   - **Loading**: what context to read for which kind of task, by category, by path, or via the context index.
   - **Posture**: the agent's operating expectations (when to proceed, when to ask, what to never do). This **MAY** be carried by reference to governance content or a core agent profile.
4. The boot profile **SHOULD** link to the manifest, the index (if present), and the agent profiles (if present), so that an agent entering through any host can discover the whole machine-readable surface.
5. The boot profile **MUST** speak task language: it names literal paths and concrete load order, and following it requires no knowledge of this specification. The manifest and schemas exist for tooling, not for agents; a boot profile that requires spec literacy to follow is a conformance smell.
6. The boot profile **SHOULD** state the context layer's maintenance duties: where its changes are recorded (the declared changelog) and how decisions are captured (the declared decision-records location). Validators warn when the boot profile references neither.
7. Vendor entrypoint files redirect to the boot profile per the vendor-adapter rule in [context-layer.md](context-layer.md).
8. The boot profile's unconditional load set (what it says to read before any task) **SHOULD** be bounded to what every task needs. Context only some tasks need **SHOULD** be routed by task, category, or the index rather than preloaded; and decision records **SHOULD** be routed by their declared `affectedPaths` / `affectedCategories` rather than loaded as a whole directory, since they accrue without bound. Everything in the unconditional set is paid on every task.

## Agent profiles

A context layer **MAY** define role-specific profiles (for example a reviewer profile, a release profile, a QA profile) under a directory declared by `machine.agentProfilesPath`. Each profile:

1. **MUST** be markdown with YAML frontmatter valid against [`agent-profile.schema.json`](../schemas/agent-profile.schema.json).
2. **MUST** declare what the role reads first (`requiredRead`) and when it must stop and ask (`mustAskWhen`).
3. **MAY** inherit from a core profile (`inherits`), so shared posture is written once.

Profiles tune *what a role loads and how it behaves*; they don't duplicate context layer content.

## Notes (non-normative)

The boot profile is deliberately boring: a map and a posture, not a knowledge base. If the boot profile grows past a few screens, content is living in the entrypoint that belongs in a category.

The failure mode this design guards against is indirection: every hop between an agent's first context and the actual constraint costs attention. A context layer implemented well needs no vendor entrypoints at all (invocation can point straight at the boot profile), and the boot profile walks straight to content. Depth belongs in the context layer's documents, never in the path to them.

Every document the boot profile says to read before any task is paid on every task, so the unconditional set is the context layer's most expensive space. Keep it to what is genuinely universal, and route the rest through task-typed loads, the categories, the index, and the scope each decision record declares. The index exists so an agent can load the slice a task needs instead of the whole tree; decisions accrue without bound, so they are routed, never preloaded as a directory.
