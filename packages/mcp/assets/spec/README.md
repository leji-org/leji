# The Leji Specification

**Leji is an open specification for the shared context layer of AI-native teams.** It defines how a team stores, governs, loads, and maintains the repo-owned context that people and AI agents both read on every task.

| | |
|---|---|
| **Spec version** | 1.0.0 |
| **Status** | Released. Breaking changes require a new major version. |
| **Editor** | Vuong Nguyen |
| **One page** | [The full specification on a single page](/spec/full/) |

## Principles (non-normative)

1. **Intent over instructions.** Leji captures durable intent (what things mean, what must hold, why it is so) instead of imperative, per-vendor instructions. People and agents derive actions from declared intent plus task context.
2. **A circle, not a tier.** Human-to-human, human-to-AI, and human-to-AI-to-human are first-class flows around one shared context layer. Equal access, not equal authority: everyone with access to a context layer reads all of it, anyone proposes, people approve. Participation is role-based, not tool-based: a participant who never touches git directly is first-class in the circle. Access itself is the version control system's to grant, not Leji's; the circle is scoped to a context layer's audience.

The rest of this specification is the normative consequence of those two principles.

## Conformance language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** in this specification are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## Citing this specification (non-normative)

Cite a section by its title and the spec version, with a permalink to the section anchor. On the spec site every heading reveals its anchor on hover.

- **Format:** Leji 1.0, §_Section_: `https://leji.org/spec/<document>/#<anchor>`
- **Example:** Leji 1.0, §The circle, normatively: `https://leji.org/spec/governance/#the-circle-normatively`

Always cite the version (`Leji 1.0`): breaking changes ship as a new major version, so a version-pinned citation stays accurate after the spec evolves.

## Vocabulary

These terms are used consistently across all normative documents:

| Term | Meaning |
|---|---|
| **context layer** | The artifact this specification governs: a repo-owned, versioned set of human-readable documents and machine-readable artifacts encoding a team's durable operating context. "Leji context layer" is the full disambiguating form. Always write "context layer"; bare "layer" is reserved for naming a countable sibling, host, or mounted context layer under federation. |
| **agent** | An AI system that acts: it loads repository context, performs or assists work, and may propose changes. The normative actor noun. |
| **person** / **people** | Human participants. People hold approval authority. |
| **participant** | A person or an agent. |
| **audience** | The people and agents admitted to read a context layer by its repository permissions and any filesystem or shared-drive permissions that expose the checkout. "Everyone reads" is scoped to a context layer's audience; different audiences are served by separate context layers, never by gating content within one. |
| **agent host** | The product or runtime an agent operates through (for example Claude Code, Codex, Cursor). Vendor adapters configure agent hosts. |
| **tool** | A callable capability an agent uses (shell, search, an MCP server). Never a product name. |
| **vendor adapter** | An agent-host-specific entrypoint file (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules`) that redirects to the boot profile. |
| **boot profile** | The agent-agnostic entrypoint of the context layer, for people and agents alike. |
| **agent profile** | A role-specific loading-and-posture document for agents. |
| **AI** | Used adjectivally (AI-native) and in the flow names **human-to-human**, **human-to-AI**, **human-to-AI-to-human**. In flow names, "AI" refers to agents operating through an agent host. |
| **model** | The predictive engine an agent runs on. Models don't read the context layer; agents do. Appears only where the engine must be distinguished from the actor (for example, model selection as a host-specific mechanic). |

The hierarchy, in one line: a **model** powers an **agent**; an **agent** operates through an **agent host** and calls **tools**; the context layer addresses agents and hosts, never models directly. The specification is agnostic at every level of that stack: any model, powering any agent, operating through any host, reading the same context layer. "LLM" is deliberately not part of this vocabulary: it names one class of model, and the specification is model-agnostic by the same principle.

**Scope boundary.** Leji 1.0 governs agents and the agent hosts that load repository context. Non-agentic AI (autocomplete, inline suggestions, chat without repository context) is out of normative scope, except where it operates as part of an agent host that loads the context layer.

## Normative documents

In reading order:

| Document | Defines |
|---|---|
| [context-layer.md](context-layer.md) | The context layer, the manifest, the root, the vendor-adapter rule |
| [content-categories.md](content-categories.md) | The five logical content categories and path mapping |
| [boot-profile.md](boot-profile.md) | The agent-agnostic entrypoint every agent host loads |
| [machine-readable-surface.md](machine-readable-surface.md) | Manifest, index, changelog, profiles, decision records |
| [decisions.md](decisions.md) | Decision records |
| [governance.md](governance.md) | Propose/approve, ownership, inclusion and removal, freshness |
| [distribution.md](distribution.md) | Monorepo, multi-repo submodule, federation |
| [conformance.md](conformance.md) | The four conformance levels and the checklist |
| [versioning.md](versioning.md) | Spec and schema versioning |

The JSON Schemas in [`../schemas/`](../schemas/) are normative for the machine-readable artifacts. The documents in [`../rationale/`](../rationale/) and [`../adoption/`](../adoption/) are non-normative.

## Scope of 1.0

**In scope:** providing context, setting constraints, recording decisions, reviewing changes, and capturing reusable patterns; agent-agnostic wiring and vendor adapters (lightly); ownership and continuity semantics (lightly).

**Extension boundary.** Leji 1.0 specifies the canonical shared context layer: how team context is written, owned, versioned, proposed, approved, indexed, and read. It deliberately does **not** specify the execution protocols that operate *around* that context layer: task envelopes, a generalized evidence protocol, agent-to-agent handoff, tool-permission protocols, and orchestration. These are **extension protocols, not prerequisites**: a conforming 1.0 context layer **MUST** remain useful without them, and an implementation **MUST NOT** require them to read, propose, review, approve, or validate the context layer. They complete the language as live practice proves them; they aren't invented in the abstract.

Leji is **not** a programming language, a DSL, a runtime, or a SaaS. It is markdown conventions, small JSON schemas, and governance semantics.
