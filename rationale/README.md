# Rationale

Non-normative: the reasoning behind the spec's shape.

## A circle, not a tier

Most context work today is written *for agents*: people author instructions, agent hosts load them, and the flow runs one way down a tier. That speeds up individual work and leaves the older problem untouched: human-to-human knowledge stays in heads and threads, and each agent host gets its own slowly diverging copy of the truth.

Leji treats 3 flows as first-class around one context layer: **human-to-human** (onboarding, review, settling debates), **human-to-AI** (work delegated to an agent), and **human-to-AI-to-human** (agent-produced work reviewed by people). Everyone reads the same context layer; people and agents both propose changes. Equal access, not equal authority: every write enters as a proposal, and a person approves what becomes true. The same content serving all three flows is itself a forcing function: a page only agents read can rot unnoticed, but a page people rely on too gets fixed from both sides.

## Intent over instructions

Imperative instructions ("do this, in this format, for this vendor file") have to be re-encoded for every agent host, every task, every new hire. Durable intent (what things mean, what must hold, why it is so) is written once and derived from endlessly. That's why the context layer's categories are intent-shaped (domain meaning, system invariants, governance rules, decision rationale) rather than task-shaped. Task envelopes may come in a future version, extracted from live practice; 1.0 deliberately standardizes the part that's proven.

## Why this is not a wiki

Wikis rot because nothing forces them current. The context layer has 3 forcing functions a wiki lacks: agents read it on every task, so wrong context produces wrong output someone feels the same day; changes ride code review, so there's no separate process to forget; and tooling fails the build on mechanical drift (stale index, missing changelog entry, broken profile). Maintenance is one delta at a time, riding work that's happening anyway.

## Why vendor files redirect

Writing canonical context into one vendor's config format fragments it and locks it to that host. The entrypoint conventions are useful (agent hosts genuinely look for them), so Leji embraces them as adapters: one line that points at the boot profile. One source of truth outlives any single agent host.

## Why federation composes instead of centralizing

The first instinct for an organization is to merge: one context repository, every team's knowledge pulled in. It fails for the same reason a wiki fails, only faster. A context layer stays current because the people who own it read it on every task and fix what's wrong in the same change. Merge product's context layer into a central repository and you have separated product's content from product's accountability; it rots while everyone assumes someone else owns it, and cross-team edits now queue behind whoever holds the central repository.

Federation keeps ownership and legibility together instead of trading one for the other. Each team's context layer stays its own repository, its own circle of people and agents reading and approving. An organization becomes a circle of those circles: a team mounts a sibling context layer to read it and route agents into it, pinned to a known version, with nothing copied. The sibling's owner still approves the sibling's changes; mounting grants reading, not authority. It is the boot profile's "equal access, not equal authority" scaled from one repository to an organization, which is also why `federated` is the level most teams never need: you reach for it only when more than one team already owns a context layer worth keeping whole.

## A team of one

Nothing in the circle requires more than one person. The same individual can propose, delegate to an agent, and approve, which makes a team of one a personal context layer: an operating system for how you and your agents work, where present-you governs what future-you and your agents treat as true. The forcing functions are tighter at this size, not looser; you are both the author of the context and the first to feel it when it is wrong.

Solo rarely means one agent. The second participant in the chain is usually a second agent in a different role, a thought-partner or reviewer bound in the manifest's `agents` map. The loop runs human-to-AI-to-AI-to-human: one agent does the work, another critiques it, and the person approves. That second agent is not a teammate restored, but it restores the function a teammate served at the gate, an independent perspective before approval, which is the structural answer to rubber-stamping your own agent's output.

Two lines hold even at one person. Agents review and advise; people own and approve. The critic sharpens your approval and never becomes it, and ownership stays human: a context layer's continuity owner is a different person or no one, because an agent cannot be accountable. A team of one is the smallest circle, not a different shape, which is the same reason the model scales the other way without new parts: one person, one team, an organization of teams, all the same circle.
