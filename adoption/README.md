# Adopting Leji

This guide takes a repository from scaffold to a useful context layer. You will map existing writing, connect entrypoints, add checks, and choose where it lives. Everyone has one dependable place to begin.

<span id="scaffold"></span>

## <span class="step-num">01</span>Scaffold

`leji adopt` reuses `docs/`, `doc/`, or `documentation/` without moving your work. It writes:

- A `leji.json` with `name` from the directory, `rootPath` set, and `owners` from an available git identity.
- A boot profile, category indexes, onboarding brief, and complete first decision with `status: accepted`.
- An `AGENTS.md` pointer when none exists.

```bash
leji adopt --dry-run       # preview every write; nothing is written
leji adopt                 # existing repo: scaffold around what you already have
leji init                  # new repo: scaffold leji.json, a boot profile, category seeds, a first decision
leji adopt --wire-adapters # finish an adoption over a vendor entrypoint (CLAUDE.md, AGENTS.md)
```

Or, in one step with nothing installed: `npm create leji` reads the directory and runs `leji adopt`
here, or `leji init` on a repository with nothing to adopt. It replaces this step rather than
preceding it, so take it and continue at the next heading.

Map lived paths instead of renaming them. `docs/engineering/START-HERE.md` conforms as a boot profile; new layers should use the lowercase-kebab defaults.

<span id="make-it-yours"></span>

## <span class="step-num">02</span>Make it yours

First, classify what you have already written. The seeded index files govern only the placeholders the scaffold itself wrote, so nothing you wrote earlier is governed until someone lists it. Hand the onboarding brief to your agent and approve the mapping it proposes, or edit the index files yourself.

Nothing needs to move. A category maps to curated index files, and an entry there selects either a single file or a whole directory, so an existing `docs/` tree can stay exactly where it is ([content categories](../spec/content-categories.md)).

Bring your decision history along. An existing ADR directory fits once its records carry the frontmatter the [decision-record schema](../schemas/decision-record.schema.json) requires; the scaffold has already written `<rootPath>/decisions/0001-adopt-leji.md` as the first one.

Next, wire discovery. Adopting over an existing `CLAUDE.md`, `GEMINI.md`, `.cursor/rules`, or `AGENTS.md` leaves that file untouched by design, which means the adoption is still a draft: the old entrypoint does not redirect yet, `leji validate` reports `vendor-adapter-redirect`, and `leji conformance` verifies `none` against the `core` you claimed.

`leji adopt --wire-adapters` migrates that content into the context layer and replaces the entrypoint with: `Read ./<bootProfilePath> first. It is the canonical context entrypoint for this repository.` Validation can then pass at `core`.

`AGENTS.md` is the portable adapter, read natively by most hosts. `init` and `adopt` create a pointer-only file when absent; `--no-agents` skips it. Single-vendor entrypoints are never created.

For manual adoption, copy [`templates/leji.json`](https://github.com/leji-org/leji/blob/main/templates/leji.json) and [`templates/boot-profile.md`](https://github.com/leji-org/leji/blob/main/templates/boot-profile.md), create indexes, and use [`templates/decision-record.md`](https://github.com/leji-org/leji/blob/main/templates/decision-record.md). Remove every placeholder named by `leji validate` before claiming `core`; drop unneeded `agents` entries or categories.

<span id="put-it-to-work"></span>

## <span class="step-num">03</span>Put it to work

The layer earns its keep when an agent reads it before the task, not after. `leji start` opens your coding agent from the context root, so it begins with the boot profile instead of whatever it inferred.

```bash
leji start                                  # detect a host and open it in the context layer
leji start --agent codex                    # pin the host instead of detecting
leji start --agent claude-code -- --chrome  # pass flags through to that host
```

`leji detect` lists hosts; `leji start --help` explains pass-through. Scripts use `bootProfilePath`. An `agents` binding, even `default`, records profiles but never loads them; only boot-profile instructions do.

<span id="keep-it-honest"></span>

## <span class="step-num">04</span>Keep it honest

An honest context layer describes the repository now. These checks fail on broken references and an index that no longer matches its sources. Unindexed markdown and leftover placeholders are reported, not rejected, so you can see drift before agents follow stale guidance.

`leji validate --content` finds placeholder and thin content. `leji status` finds unindexed, dangling, or stale material. `leji conformance` reports progress.

At `indexed`, `leji index` generates `context-index.json`; `leji index --check` fails when it is stale. `leji changelog check` verifies the machine changelog.

Without CI conventions, `leji ci` generates a workflow; `leji ci --hooks` installs the gates as a pre-commit. `leji ci --help` explains CLI resolution.

In an established pipeline, run `leji validate` and `leji index --check` in required jobs and hooks. Declare the CLI as a dev dependency so a clean install brings it: `leji init`/`leji adopt` detect the package manager this repository uses and, on your explicit yes, run its own add command (pip and pre-1.24 Go get the printed line instead).

At `governed`, add reviewed changes, valid agent profiles, freshness checks, and required CI.

### Show your conformance

`leji badge` writes `leji-badge.svg` at the repository root and prints the line to paste into your README:

```bash
leji badge                        # write leji-badge.svg and print the snippet
leji badge --out docs/badge.svg   # somewhere else; the snippet follows the path
```

```markdown
[![Leji 1.0 · governed · self-attested](leji-badge.svg)](https://leji.org/agent-ready/)
```

The badge is self-attested and honest about this run: it states the level `leji conformance` verified, which is never above what `leji.json` claims and is sometimes below it. A claim the offline run could not confirm is named on stdout rather than badged.

Run it on a committed tree. An uncommitted changelog leaves the `indexed` check unverifiable, so a working copy that has not been committed badges `core` whatever it claims.

The snippet's image path is relative to the repository root. A README in a subdirectory needs the path adjusted to reach the file from there.

<span id="where-it-lives"></span>

## <span class="step-num">05</span>Where it lives

One repository keeps one context layer beside its work.

When many repositories consume one layer, use a docs-only submodule. Create its repository, mount it in each consumer at `context/`, and pin it per repository. Raise reviewable, scripted pin updates. Builds and runtime must not depend on it.

Point agents at `context/docs/boot-profile.md`; retained vendor files redirect there. See the [multi-repo example](https://github.com/leji-org/leji/tree/main/examples/multi-repo) and [distribution specification](../spec/distribution.md).

Federation is for teams that each own a layer. Its [guide](/federation/) covers declarations, hydration, status, routing, and `federated` checks.

<span id="optional-cases"></span>

## <span class="step-num">06</span>Optional cases

<details class="fold">
<summary>Several actors can fill one role</summary>

One role normally binds to one profile; `host` and `invocation` describe engagement. For several participants or role-specific invocations, optional `actors` list eligible roles and command templates. See the [context-manifest schema](../schemas/context-manifest.schema.json).

Actors grant no approval authority. The orchestrator chooses; Leji 1.0 defines no selection rule.

</details>

<details class="fold">
<summary>Intent and records share a directory</summary>

Govern statuses and readouts as records. A file selector keeps intent in the same directory:

````markdown
```leji-index record
- path: docs/operations/
```

```leji-index intent
- path: docs/operations/escalation-policy.md
```
````

The file selector wins. Agents load the policy as required intent; the records return separately as dated candidates, loaded only when the task selects one or someone asks. See [content categories](../spec/content-categories.md).

</details>

<details class="fold">
<summary>Present the context layer in a viewer</summary>

`context-index.json` supports documentation tools. CLI commands:

```bash
leji viewer serve      # localhost preview at http://127.0.0.1:5354/
leji viewer build      # export a self-contained static folder for internal hosting
```

`serve` is not hosting. Publish only for the context layer's audience. The build writes inside the repository (`.leji/dist/` by default, or a `--out` path within it) and the output folder is yours: copy it wherever your host reads from. Governed H1s provide navigation; manifest `viewer` fields provide branding and pins. MkDocs can use the index. See the [machine-readable surface specification](../spec/machine-readable-surface.md).

</details>

<details class="fold">
<summary>Read from synced or sandboxed surfaces</summary>

Leji reads a git tree presented by a clone, sandbox mount, or git-preserving Google Drive or Dropbox folder.

Uploads, pasted text, and docs without `.git` lack version metadata. Their currency is unknown; the git checkout stays canonical. See [governance](../spec/governance.md).

</details>

<p class="next-step">Next: the <a href="/manifest/">manifest reference</a> for every field, or the <a href="/spec/">specification</a> for the rules behind them.</p>
