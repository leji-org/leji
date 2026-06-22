# Adopting Leji

Existing repositories **SHOULD** map their lived paths rather than rename (a boot profile at `docs/Agent.md` is as conformant as the default); new context layers **SHOULD** start from the lowercase-kebab defaults.

However you adopt, you end at the same place: one context layer that every participant reads.

## Start with the CLI

The reference CLI does the adoption for you. The guides below are what it writes, and how to do each step by hand.

```bash
leji adopt              # existing repo: reuse docs/, migrate CLAUDE.md / AGENTS.md into the context layer
leji init               # new repo: scaffold leji.json, a boot profile, category seeds, a first decision
leji adopt --dry-run    # preview every write first
leji detect             # list the agent hosts installed on this machine
leji adopt --wire-adapters      # convert an existing CLAUDE.md/AGENTS.md into a one-line redirect
```

`adopt` reuses your existing `docs/` tree and migrates any vendor entrypoints (`CLAUDE.md`, `AGENTS.md`) into the context layer without changing the originals. `--wire-adapters` then converts those entrypoints into one-line redirects; `--agent <host>` instead opens that host in the layer afterward (an interactive handoff that writes no vendor file). `init` writes an onboarding brief you hand to your agent. Both refuse when a `leji.json` already exists, and `--dry-run` previews every write.

## Monorepo

1. Copy `templates/leji.json` to your repository root; set `name`, `rootPath` (default `docs/`), and the owner.
2. Copy `templates/boot-profile.md` to the boot profile path and fill in identity, loading, posture.
3. Map the categories you actually have. An existing `docs/` tree conforms by mapping, not by renaming: point `domain`/`system`/`practice`/`governance`/`decisions` at the directories where that kind of content already lives.
4. Write (or adopt) your first decision record; `templates/decision-record.md` is the shape. An existing Architecture Decision Record (ADR) directory already qualifies: map it.
5. Delete or empty every vendor file (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules`) you can; enter the context layer by direct invocation instead (see "Entering the context layer"). Any vendor file you must keep becomes a one-line redirect to the boot profile, never content.

That's `core` conformance. `indexed` adds the generated index and the machine changelog (`leji index` generates the index; `leji changelog check` verifies the changelog).

## Multi-repo

1. Create a dedicated context repository; adopt the monorepo steps inside it.
2. Mount it in each consuming repository as a git submodule at `context/`, docs-only: no build or runtime step may touch it.
3. Pin per repository; raise pin updates as scripted pull requests.
4. Enter consuming repositories by direct invocation pointed into the mount (`context/docs/boot-profile.md`); any vendor files you must keep redirect there.

See `examples/multi-repo/` and [spec/distribution.md](../spec/distribution.md).

## Teams that already have a context repo

Don't merge it. Mount it as a sibling context layer (`federation.mounts`), ownership and workflow unchanged. The circle composes ownership; it doesn't centralize it.

## Entering the context layer

The cleanest entry needs no vendor files at all: point the agent host at the boot profile in the invocation itself, so it is the agent's first context with zero hops.

```bash
claude "Read ./docs/boot-profile.md, follow all instructions, and tell me when you are ready to begin."
codex "Read ./docs/boot-profile.md and follow it before doing anything else."
```

Package the invocation so the whole team enters the same way:

```json
{
   "scripts": {
      "start": "claude \"Read ./docs/boot-profile.md, follow all instructions, and tell me when you are ready to begin.\"",
      "start:codex": "codex \"Read ./docs/boot-profile.md, follow all instructions, and tell me when you are ready to begin.\""
   }
}
```

Vendor entrypoint files are the fallback for cold starts: someone who opens the repository and launches an agent host without the script still starts from the context layer.

## Presenting the context layer

The context layer can be presented directly from its markdown; a viewer projects the index rather than duplicating content, and the generated viewer is itself a derived surface (see [spec/machine-readable-surface.md](../spec/machine-readable-surface.md)). `context-index.json` already carries what a viewer needs (title, category, path, summary per document), so any docs tool that can consume it can render the context layer. The CLI ships the reference projection:

```bash
leji viewer            # generates the contained viewer under <root>/.leji/viewer/ from the index
leji viewer serve      # same, then serves it at http://127.0.0.1:5354/ (5354: LEJI on a phone keypad); leji view also opens a browser
leji viewer build      # exports a self-contained static folder for internal hosting
```

The generated viewer strips YAML frontmatter before rendering and opens on the boot profile. The contained viewer lives under `<root>/.leji/viewer/` (gitignored); `leji viewer build` exports a self-contained copy you can serve with anything static (`python -m http.server`, `npx serve`, GitHub Pages), on infrastructure whose audience matches the context layer's: a public host like GitHub Pages only for a public context layer, since the viewer is a derived surface (see [spec/machine-readable-surface.md](../spec/machine-readable-surface.md)). `leji viewer serve` is a localhost preview, never hosting. Teams can declare a preferred preview port in the manifest (`"viewer": { "port": 5354 }`); `--port` overrides it.

Already on MkDocs or another docs tool? Point it at the context root and project its nav from `context-index.json`; MkDocs ignores frontmatter natively. The index is the contract; the viewer is your choice.

## Reading from synced or sandboxed surfaces

The context layer is read from a git working tree on a filesystem. How an agent reaches that working tree does not change how Leji works: a local clone, a synced folder that preserves the git working tree (Google Drive, Dropbox), or a sandbox that mounts that working tree all present the same checkout. The agent, or the person driving it, reads `leji.json` and the boot profile from the checkout and resolves paths the same way everywhere. An agent that can run code interacts with git directly; otherwise the person does, in the terminal.

Some interfaces expose only file *content*, never an accessible git working tree or version metadata: a file uploaded into a chat, a docs folder copied without its `.git`, a document read through a storage API, or text pasted into a prompt. There is no git there to ask how current the copy is, so a reader in that position treats the context layer's checkout currency as unknown rather than current (see [spec/governance.md](../spec/governance.md)), and the git checkout stays the one canonical copy.

## Vendor wiring (fallback only)

Implemented properly, the context layer needs none of these files: invocation points straight at the boot profile and there is nothing to redirect. Vendor files serve repositories that cannot control how agents are launched, or hosts that auto-load their own entrypoint on a cold start. If a vendor file exists, it is a pointer, never a home.

Leji never writes one for you: `leji detect` lists the agent hosts installed on this machine, and `leji adopt --wire-adapters` converts a *present* entrypoint into a redirect after migrating its content. To open a host in the layer without any vendor file, use `leji start` (or `--agent <host>` on `init`/`adopt`).

| Agent-host entrypoint | Contents |
|---|---|
| `CLAUDE.md` | `Read <bootProfilePath> and follow it. Canonical context lives there, not here.` |
| `AGENTS.md` | same |
| `.cursor/rules` / `.cursorrules` | same |
| `.github/copilot-instructions.md` | same |

The entrypoint files tell each agent host where to look; the context layer is what the agent finds.
