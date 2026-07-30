# The Boot Profile

The **boot profile** is the agent-agnostic entrypoint of the context layer: one human-readable document that every agent host, and every person, can start from. It answers "what is this context layer, what do I load, and how do I behave here."

## Requirements

1. The context layer **MUST** have exactly one boot profile, located at the path declared by `bootProfilePath` in the manifest. The **RECOMMENDED** default is `docs/boot-profile.md`.
2. The boot profile **MUST** be plain markdown, readable by a person with no tooling. It **MUST NOT** depend on any vendor's configuration syntax.
3. The boot profile **MUST** cover:
   - **Identity**: what this repository or product is, in a paragraph.
   - **Loading**: what context to read for which kind of task. This **MUST** give an unconditional set (what to read before any task), then task-typed selectors that route by path, by category, or via the context index, and a defined fallback for a task that matches no selector. Stated in task language, this is the boot-profile-level expression of the Task routing algorithm ([machine-readable-surface.md](machine-readable-surface.md)); following it requires no knowledge of that algorithm.
   - **Posture**: the agent's operating expectations (when to proceed, when to ask, what to never do). This **MAY** be carried by reference to governance content or a core agent profile.
4. The boot profile **SHOULD** link to the manifest, the index (if present), and the agent profiles (if present), so that an agent entering through any host can discover the whole machine-readable surface.
5. The boot profile **MUST** speak task language: it names literal paths and concrete load order, and following it requires no knowledge of this specification. The manifest and schemas exist for tooling, not for agents; a boot profile that requires spec literacy to follow is a conformance smell.
6. The boot profile **SHOULD** state the context layer's maintenance duties: where its changes are recorded (the declared changelog) and how decisions are captured (the declared decision-records location). Validators warn when the boot profile references neither.
7. Vendor entrypoint files redirect to the boot profile per the vendor-adapter rule in [context-layer.md](context-layer.md).
8. The boot profile's unconditional load set (what it says to read before any task) **SHOULD** be bounded to what every task needs. Context only some tasks need **SHOULD** be routed by task, category, or the index rather than preloaded; and decision records **SHOULD** be routed by their declared `affectedPaths` / `affectedCategories` rather than loaded as a whole directory, since they accrue without bound. Everything in the unconditional set is paid on every task.
9. **Federated siblings.** A context layer that declares `federation.mounts` (per [distribution.md](distribution.md)) **MUST** surface those siblings in the boot profile in a machine-checkable form: one or more fenced blocks whose info string is `leji-mounts`, placed anywhere in the document, whose entries concatenate in document order and carry exactly one entry per declared mount. An entry names the sibling, its owner, what it carries, and when to read it, the last two in the author's task language. The worked example is below the requirements.

   The grammar is fixed so every implementation reads it identically. A block **opens** with a line of three or more backticks followed by the info string and **closes** with the next line of three or more backticks; the closing fence's backtick count need not match the opening fence's. The info string is `leji-mounts` alone; a fence carrying any token after it is an error, never an ignored fence. The fence lines **MAY** carry space or tab indent and padding, and the records between them **MUST NOT**: a record begins at column 1 with `- mount: `, and its fields are indented exactly two ASCII spaces. Within a record `owner`, `carries`, and `read-when` each appear exactly once, in any order; unknown fields, duplicate fields, and missing fields are errors. A value is the nonempty remainder of its line after the `key: ` prefix, with no leading or trailing space or tab and no control or line-separator character. Whitespace in this grammar is ASCII space (U+0020) and tab (U+0009) and nothing else, in the fence line's indent and padding as much as in a content line's; implementations **MUST NOT** use a runtime whitespace class here, since those disagree about characters such as U+0085 and U+00A0 and would disagree about whether a block exists. A leading UTF-8 byte order mark is stripped before parsing. Lines split on LF with a trailing CR tolerated, blank lines and full lines starting `#` are ignored (as in the category index blocks of [content-categories.md](content-categories.md)), and the file is UTF-8. The scan is line based and does not consult markdown structure: a line carrying three or more backticks and the tag, after optional space or tab indent, opens a real block wherever it sits in the document, including inside a longer fenced example or inside a list item. An example meant to illustrate rather than to declare is therefore fenced with a **different tag**, never with an extra token after `leji-mounts`: the tag is what the scanner matches on, so `leji-mounts example` opens a real block and reports a parse error, while a fence tagged `text` opens nothing. `mount` **MUST** match a declared mount's `name` and `owner` **MUST** match that mount's declared `owner.name`, compared as decoded strings; an entry for an undeclared mount, a second entry for one mount, and a declared mount with no entry are all errors. A layer that declares no mounts **MUST NOT** carry a `leji-mounts` block.

   The sibling's location is deliberately not an element: a mount is materialized in a machine-local, content-addressed projection, so a reader resolves it with `leji mounts locate <name>` rather than inferring a path (per [distribution.md](distribution.md)). Prose around the block **SHOULD** explain the routing naturally; the block is the checkable core, never a replacement for that prose or for the declaration in `leji.json`. Mounted siblings are distinct, named sources, never merged into the host's categories; the boot profile routes the agent into a sibling only when the task matches its routing or the profile requires it. What stays unchecked is deliberate: `carries` and `read-when` are free text, and their fidelity to the mount's routing metadata is attested by the team rather than verified by tooling, which checks enumeration, identity, and presence. Surfacing siblings here keeps mount discovery in the agent's task-language entrypoint, so following requirement 5 still needs no manifest reading.

### A worked `leji-mounts` block

One entry, for a host that declares a single mount named `acme-product-context`. The block sits at column 1 in the boot profile, exactly as it reads here; the outer four-backtick fence is this document's wrapper and is not part of it.

````markdown
```leji-mounts
- mount: acme-product-context
  owner: Product team
  carries: product-side domain language and the decisions behind the customer-facing surface
  read-when: a task touches product behavior, product terminology, or billing
```
````

## Agent profiles

A context layer **MAY** define role-specific profiles (for example a reviewer profile, a release profile, a QA profile) under a directory declared by `machine.agentProfilesPath`. Each profile:

1. **MUST** be markdown with YAML frontmatter valid against [`agent-profile.schema.json`](../schemas/agent-profile.schema.json).
2. **MUST**, once inheritance is resolved, carry what the role reads first (`requiredRead`) and when it must stop and ask (`mustAskWhen`). A profile that declares `inherits` **MAY** omit either one where its base supplies it; a profile that does not **MUST** declare both itself.
3. **MAY** declare `inherits`, which is operative in the 1.0 line: it names exactly one other profile in the layer's profile set, whose `role` **MUST** be `core`, and whose posture and body this profile extends. The layer's profile set is every document under the declared `machine.agentProfilesPath` together with every document named in the manifest's `agents` map, wherever that document sits. Resolution is single level, so a profile whose `role` is `core` **MUST NOT** declare `inherits`, and the named target **MUST** exist, **MUST** be unique by `id`, and **MUST NOT** declare `inherits` itself. Resolution composes:
   - **Posture arrays** (`requiredRead`, `defaultContext`, `mustAskWhen`, `mustRefuseWhen`): the base's entries in their authored order, then the derived profile's entries in theirs, dropping any the base already carries. Authored order is loading intent, so nothing is sorted.
   - **Every other field** (`id`, `name`, `role`, `purpose`, `version`, `host`, `invocation`, `escalation`, `owners`, `freshness`): the derived profile's own, never inherited. `inherits` is a resolution directive and is not itself part of the resolved profile.
   - **Body**: both bodies are normative, the base's first, then the derived profile's.

   A consumer that cannot resolve an inherited profile **MUST NOT** apply the derived file on its own; the derived file is one half of a profile, so the consumer reports it unsupported instead. Where an ask condition and a refuse condition both apply to the same situation, refusal governs.

   Resolution guarantees composition, not semantic narrowing: derived prose that contradicts or weakens the base is nonconforming, and no tooling detects a natural-language contradiction.

Profiles tune *what a role loads and how it behaves*; they don't duplicate context layer content.

A profile's optional `host` and `invocation` are the single-actor shorthand: they say how to engage the one participant that fills this role. Its `command` is a template following the same rule as actor command templates, including the `<prompt>` placeholder and its placement (see [context-layer.md](context-layer.md), Requirements). Where a role has more than one eligible participant, or where the same participant needs a different invocation depending on which role it is filling, the manifest's optional `actors` registry carries that instead (same section). A role uses one mechanism or the other, never both.

## Notes (non-normative)

The boot profile is deliberately boring: a map and a posture, not a knowledge base. If the boot profile grows past a few screens, content is living in the entrypoint that belongs in a category.

The failure mode this design guards against is indirection: every hop between an agent's first context and the actual constraint costs attention. A context layer implemented well needs no vendor entrypoints at all (invocation can point straight at the boot profile), and the boot profile walks straight to content. Depth belongs in the context layer's documents, never in the path to them.

Every document the boot profile says to read before any task is paid on every task, so the unconditional set is the context layer's most expensive space. Keep it to what is genuinely universal, and route the rest through task-typed loads, the categories, the index, and the scope each decision record declares. The index exists so an agent can load the slice a task needs instead of the whole tree; decisions accrue without bound, so they are routed, never preloaded as a directory.
