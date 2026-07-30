# Adopting Leji

Existing repositories **SHOULD** map their lived paths rather than rename: a boot profile at `docs/engineering/START-HERE.md` is as conformant as one at the default path. New context layers **SHOULD** start from the lowercase-kebab defaults.

However you adopt, you end at the same place: one context layer that every participant reads.

## Start with the CLI

Running `leji adopt` against an existing repository writes most of what this guide covers. The manifest arrives pre-filled: `name` from the directory, `rootPath` set, and `owners` taken from your git config where an identity is set, left as a `<named owner>` placeholder to replace where it is not. The boot profile is written fully structured, with only its prose left for you to fill in. The category index files are written and already wired into `leji.json`. The first decision record, `<rootPath>/decisions/0001-adopt-leji.md`, is written fully authored with `status: accepted`. An `AGENTS.md` pointer is written when none exists. And an onboarding brief is written for you to hand to an agent. All of this reuses your existing docs root, whichever of `docs/`, `doc/`, or `documentation/` it finds, and migrates vendor entrypoint content (from `CLAUDE.md`, `AGENTS.md`) into the context layer without changing the originals.

```bash
leji adopt --dry-run       # preview every write; nothing is written
leji adopt                 # existing repo: scaffold around what you already have
leji init                  # new repo: scaffold leji.json, a boot profile, category seeds, a first decision
leji adopt --wire-adapters # finish an adoption over a vendor entrypoint (CLAUDE.md, AGENTS.md)
```

Two things remain yours to do.

First, the scaffold does not classify your existing documents. The seeded index files govern the placeholder documents the scaffold itself writes; nothing you wrote earlier is governed until someone lists it. Hand the written onboarding brief to an agent; it proposes which documents belong to which category, and you approve the mapping before anything becomes canonical. Editing the seeded index files directly, without going through the brief, is fine too.

Second, adopting over a vendor entrypoint produces an **adoption draft**, not a conformant context layer. Because the originals are left untouched by design, an old `CLAUDE.md` still does not redirect to the boot profile, so `leji validate` fails with `vendor-adapter-redirect`, and `leji conformance` verifies `none` against the claimed `core`. `leji adopt --wire-adapters` converts those entrypoints into one-line redirects, after which `leji validate` passes and the context layer is `core`-conformant.

To check progress: run `leji validate --content` for placeholder and thin-content warnings, `leji status` for anything unindexed, dangling, or stale, and `leji conformance` for the level reached and what remains to reach the next one.

## Monorepo

One repository, one context layer.

1. Run `leji adopt` (or `leji init` on a fresh repository, which has nothing yet to reuse). Nothing of yours moves: the scaffold is written around what is already there.
2. Hand the written onboarding brief to your agent and approve the mapping it proposes. A category maps to one or more curated **index files** (`categories.<id>.indexes`), not directly to directories: each index file's `leji-index` block lists the directories or files holding that kind of content. An existing `docs/` tree conforms by listing what it already has, not by renaming, and one directory can feed more than one category.
3. Bring your decision history along. An existing Architecture Decision Record (ADR) directory fits once its records carry the frontmatter the decision-record schema requires (`id`, `title`, `status`, `date`); `adopt` has already written `<rootPath>/decisions/0001-adopt-leji.md` as an accepted record for you to build on.
4. Finish the entrypoints with `leji adopt --wire-adapters`. An entrypoint is a pointer, never a home; content that used to live in one belongs in the context layer.

That's `core` conformance. `indexed` additionally requires the generated index and the machine changelog (`leji index` generates the index; `leji changelog check` verifies the changelog). The reference CLI's `leji init` and `leji adopt` write the index at every level, so a fresh scaffold is ready for the CI job below without claiming a level it did not choose; a hand-authored `core` context layer with no index still conforms. To keep the context layer honest as it grows, `leji ci` wires a CI job that runs `leji validate` and `leji index --check` on every change (provider inferred from the origin remote), and `leji ci --hooks` installs the same two gates as a local pre-commit mirror. The generator's detection is npm-manifest-only: when a repository's root `package.json` declares `@leji-org/leji`, generated CI runs that lockfile-pinned install (`npm ci`, then the local binary) instead of `npx @leji-org/leji@1`; a repository that does not declare it gets the `npx @leji-org/leji@1` job. The generated hook is independent of that detection: at commit time it prefers a runtime-present `node_modules/.bin/leji` over a global `leji`, whether or not the dependency is declared. Pin however your stack pins (a lockfile'd npm dependency, a pinned PyPI `leji`, the Go module or a release binary); that governs what the team installs and runs, not what the generator emits.

For a repository that already runs an established CI pipeline and git-hook battery, the cleaner integration is not a separate generated workflow but a repo-native script (one that runs `leji validate` and `leji index --check`) invoked from your existing required CI job and your existing hooks, with `@leji-org/leji` pinned as a lockfile devDependency. `leji ci` is the standalone default for repositories that have no CI conventions of their own to slot into, not the more-correct topology; where conventions exist, fold the two gates into them.

The CLI is a convenience, not the spec. A hand-authored `core` context layer conforms just as well: copy `templates/leji.json` and `templates/boot-profile.md`, create the index files your categories need, write a first decision record from `templates/decision-record.md`, and point every entrypoint at the boot profile. The templates ship with placeholders, and `core` is not met until they are gone: set `name`, `rootPath`, and a real primary owner in the manifest; point its `agents` entries at profiles that exist or drop them, rather than leaving the `<profile>` path; keep only the categories you actually have, giving each one an index file that resolves to real documents and removing the rest; and write the boot profile's identity, loading, and posture in place of its `<...>` prompts. Run `leji validate` and it names every one still outstanding. Everything above about mapping still applies; you are simply performing the proposal step yourself.

## Multi-repo

1. Create a dedicated context repository; adopt the monorepo steps inside it.
2. Mount it in each consuming repository as a git submodule at `context/`, docs-only: no build or runtime step may touch it.
3. Pin per repository; raise pin updates as scripted pull requests.
4. Enter consuming repositories by direct invocation pointed into the mount (`context/docs/boot-profile.md`); any vendor files you must keep redirect there.

See `examples/multi-repo/` and [spec/distribution.md](../spec/distribution.md).

## Teams that already have a context repo

Don't merge it. Mount it as a sibling context layer (`federation.mounts`), ownership and workflow unchanged. The circle composes ownership; it doesn't centralize it.

This is federation (pattern 3), and it differs from the multi-repo submodule above in what the host repository holds. A submodule commits a checkout of the context repository into the consuming repo. A mount commits **nothing**: the host manifest declares where the sibling lives and which commit of it this repository reads, and the content is materialized on demand into an ignored cache.

Declare each sibling in `federation.mounts` with a normalized `source`, a full commit `pin` as the version of record, an optional `trackingRef` to judge staleness against, the sibling's `owner`, and the routing metadata that tells an agent when the mount is relevant (`categories`, plus `topics` or `requiredWhen`):

```jsonc
"federation": {
   "mounts": [
      {
         "name": "product-context",
         "source": "https://github.com/acme/product-context",
         "pin": "7d3f2a19c4e8b6a0d5f1c2e9b8a7f6d5c4b3a2e1",
         "trackingRef": "refs/heads/main",
         "owner": { "name": "Product team", "contact": "product@acme.example" },
         "role": "product-side context, owned by the product team",
         "categories": ["domain", "decisions"],
         "requiredWhen": ["a task changes how a plan or entitlement is represented"]
      }
   ]
}
```

Then work it with three commands:

```bash
leji mounts hydrate --fetch   # materialize each sibling's layer projection at its pin
leji mounts status            # availability, integrity, and how far each pin is behind
leji mounts locate <name>     # where a reader should read the sibling from
```

`hydrate` extracts only the sibling's **layer projection** into a gitignored cache, resolved from a git object store at the pin. The projection is the deduplicated union of everything the sibling's own manifest makes readable at that commit: its `leji.json`, the tree under its context root, its boot profile, its machine index and changelog files when present, its agent-profiles and decision-records trees when present, every agent profile its `agents` map binds, every category index file, and every governed path its pinned generated index lists, wherever those live. The failure boundary follows the same line: a referenced or schema-required file absent at the pin (the boot profile, a category index, a bound agent profile, an indexed governed path) fails the projection, while an absent directory or an absent machine artifact contributes nothing and fails nothing. Nothing is committed into the host, and readers ask `mounts locate` for the path rather than assuming one.

Pin bumps are ordinary reviewed commits to `leji.json`, which is the point: the manifest records which version of another team's truth this repository was reading.

Two things worth knowing before you claim `federated`. An unhydrated mount is a **warning**, never a build failure, because a missing sibling degrades knowledge rather than breaking the work; `leji validate --federation=available|required` is the opt-in way to make CI insist. And local availability is not conformance: at `federated` the pin has to be reachable from an advertised ref of `source`, which needs the network, so run `leji conformance --federation=verify`. A check that cannot reach the source reports `unknown`, and `unknown` never awards the level.

## Entering the context layer

Entry needs no vendor file at all. `leji start` detects an installed host, launches it from the context root, and points it at the boot profile, so the context layer is the agent's first context with zero hops:

```bash
leji start                              # detect a host and open it in the context layer
leji start --agent codex                # pin the host instead of detecting
leji start --agent claude-code -- --chrome   # pass flags through to that host
```

With several hosts detected it asks which; with none detected, or in a non-interactive shell, it prints the command to run instead of guessing. Anything after a literal `--` goes verbatim to the launched binary, and host-specific flags ride with a pinned `--agent` so a flag never reaches whichever host happened to win detection. `leji detect` lists what is installed; `claude-code` and `codex` are the hosts it can launch today, and everything else enters through its vendor-file redirect.

For a scripted or CI run, or a host `leji start` cannot launch, point the agent at the boot profile directly. Read the path from the manifest rather than hardcoding it, since `bootProfilePath` is whatever your repository declares:

```bash
claude "Read ./docs/boot-profile.md, follow all instructions, and tell me when you are ready to begin."
codex "Read ./docs/boot-profile.md and follow it before doing anything else."
```

Vendor entrypoint files are the fallback for cold starts: someone who opens the repository and launches an agent host without either path still starts from the context layer.

Only the boot profile's own instructions cause anything to be read. Binding a profile in the manifest's `agents` map, including at the `default` key, never auto-loads it: the `agents` map records which profiles exist and who they are, not a load order. If a profile should always be in context, the boot profile must say to read it (or it should be part of the boot profile itself). A `default` binding that the boot profile then loads unconditionally is indirection, not routing; keep one canonical boot document instead.

## Discovery adapters

Entrypoint files solve discovery: they tell an agent host where to look on a cold start. Leji defines what the agent finds there. Every entrypoint is a pointer to the boot profile, never a home for content; that rule is what keeps one source of truth while embracing the conventions hosts actually follow.

They come in two kinds, and the difference drives the defaults, not the rule:

- **`AGENTS.md` is the portable adapter.** It is a cross-host convention (stewarded by the Linux Foundation's Agentic AI Foundation and read natively by Codex, Copilot, Cursor, and many others; some hosts, Gemini CLI among them, read it only once configured), so `leji init` and `leji adopt` write a pointer-only `AGENTS.md` when none exists. `--no-agents` skips it, and an existing file is never touched.
- **Single-vendor entrypoints** (`CLAUDE.md`, `GEMINI.md`, `.cursor/rules`) serve one host each. Leji never creates these: `leji detect` lists the hosts installed on this machine, and `leji adopt --wire-adapters` converts a *present* entrypoint into a redirect after migrating its content. To open a host in the context layer without any vendor file, use `leji start` (or `--agent <host>` on `init`/`adopt`).

| Agent-host entrypoint | Contents |
|---|---|
| `AGENTS.md` (portable; generated by default) | `Read ./<bootProfilePath> first. It is the canonical context entrypoint for this repository.` |
| `CLAUDE.md` | same |
| `.cursor/rules` / `.cursorrules` | same |
| `.github/copilot-instructions.md` | same |

The entrypoint files tell each agent host where to look; the context layer is what the agent finds.

## More than one actor for a role

A role binds to one agent profile, and that profile's own `host` and `invocation` say how to engage the participant filling it. That is the right shape for most roles.

Two situations need more. A role may have several eligible participants, and the same participant may need a different invocation depending on which role it is currently filling: a reviewer that must run detached from the repository, for instance, and a builder that must run inside it. A single command per profile cannot express either.

The manifest's optional `actors` covers both. Each actor declares the roles it is eligible for and a command template per role:

```jsonc
"actors": {
   "actor-one": {
      "roles": ["reviewer"],
      "commands": { "reviewer": "your-tool --detached <prompt>" }
   },
   "actor-two": {
      "roles": ["reviewer", "builder"],
      "commands": {
         "reviewer": "other-tool --detached <prompt>",
         "builder": "other-tool <prompt>"
      }
   }
}
```

An actor's `roles` and its `commands` keys must be the same set, every template carries `<prompt>` as its own unquoted shell word (never inside quotes, never joined to other text), and a role that has actors takes its command from them: its profile must not also declare `invocation`, so there is never a question which one wins. Declaring an actor grants no authority. It says who may be asked to fill a role, never who may approve.

Choosing between eligible actors is the orchestrator's, not the manifest's. Leji 1.0 records who is eligible and how to invoke them, and deliberately defines no selection rule.

## Governing records

Most repositories carry more operational state than durable intent: statuses, assessments, ledgers, readouts, archives. Govern them as **records** (see [spec/content-categories.md](../spec/content-categories.md)) rather than leaving them unlisted or pretending they are kept-current intent. A record block lists them; selector specificity handles the mixed directory without touching any file:

````markdown
# Domain context

```leji-index
- path: docs/glossary.md
```

```leji-index record
- path: docs/operations/
```

```leji-index intent
- path: docs/operations/escalation-policy.md
```
````

Everything under `docs/operations/` is governed as dated evidence; the escalation policy, the one file readers rely on as current, resolves as intent because a file selector beats a directory selector. Give a record a frontmatter `date` when one date describes it, and never a `freshness.reviewAfter` (horizons are for intent; validation rejects them on records). Agents load intent as required context and see records as dated candidates, so a ledger never becomes mandatory reading and a stale status can never masquerade as the present.

## Presenting the context layer

The context layer can be presented directly from its markdown; a viewer projects the index rather than duplicating content, and the generated viewer is itself a derived surface (see [spec/machine-readable-surface.md](../spec/machine-readable-surface.md)). `context-index.json` already carries what a viewer needs (an id, title, category and path per document, plus an optional summary), so any docs tool that can consume it can render the context layer. The CLI ships the reference projection:

```bash
leji viewer            # generates the contained viewer under <root>/.leji/viewer/ from the index
leji viewer serve      # same, then serves it at http://127.0.0.1:5354/ (5354: LEJI on a phone keypad); leji view also opens a browser
leji viewer build      # exports a self-contained static folder for internal hosting
```

The generated viewer strips YAML frontmatter before rendering and opens on the boot profile. The contained viewer lives under `<root>/.leji/viewer/` (gitignored); `leji viewer build` exports a self-contained copy you can serve with anything static (`python -m http.server`, `npx serve`, GitHub Pages), on infrastructure whose audience matches the context layer's: a public host like GitHub Pages only for a public context layer, since the viewer is a derived surface (see [spec/machine-readable-surface.md](../spec/machine-readable-surface.md)). `leji viewer serve` is a localhost preview, never hosting. Teams can declare a preferred preview port in the manifest (`"viewer": { "port": 5354 }`); `--port` overrides it.

The viewer brands and organizes itself entirely from governed surfaces, so there is no hand-maintained sidebar to rot. The manifest's `viewer` object takes `title`, `logo`, `favicon`, and `theme.primary` for the brand, and `pins` for a few pages surfaced at the top of the sidebar (a dashboard, a TODO). The spine below the pins groups by **curated index file**: each file's own H1 is its group label (emoji and phrasing included), in manifest order, and a document appears in the group of the index file whose selector won it. Records carry a small dated badge, so evidence reads as evidence at a glance. Replacing a hand-built docs dashboard usually means: split your categories' index files along your existing sidebar groups, title each with the H1 you want, pin the few top pages, and set the brand fields.

Already on MkDocs or another docs tool? Point it at the context root and project its nav from `context-index.json`; MkDocs ignores frontmatter natively. The index is the contract; the viewer is your choice.

## Reading from synced or sandboxed surfaces

The context layer is read from a git working tree on a filesystem. How an agent reaches that working tree does not change how Leji works: a local clone, a synced folder that preserves the git working tree (Google Drive, Dropbox), or a sandbox that mounts that working tree all present the same checkout. The agent, or the person driving it, reads `leji.json` and the boot profile from the checkout and resolves paths the same way everywhere. An agent that can run code interacts with git directly; otherwise the person does, in the terminal.

Some interfaces expose only file *content*, never an accessible git working tree or version metadata: a file uploaded into a chat, a docs folder copied without its `.git`, a document read through a storage API, or text pasted into a prompt. There is no git there to ask how current the copy is, so a reader in that position treats the context layer's checkout currency as unknown rather than current (see [spec/governance.md](../spec/governance.md)), and the git checkout stays the one canonical copy.
