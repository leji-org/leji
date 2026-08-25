# leji

Reference SDK and CLI for the [Leji specification](https://leji.org): the open
specification for the shared context layer of AI-native teams.

```bash
npm install -g @leji-org/leji   # or: npx @leji-org/leji / npm create leji
leji init               # bootstrap a context layer interactively
leji validate           # manifest, artifacts, frontmatter, lint rules
leji index              # generate the context index
leji index --check      # fail when the index is stale
leji changelog check    # append-only discipline
leji freshness          # review-horizon report
leji conformance        # score the layer against its claimed level
leji badge              # write the self-attested conformance badge and its markdown
leji status             # unindexed, dangling, and stale documents
leji route              # the governed context a task's scope routes to
leji viewer             # generate the static viewer for the context layer
leji viewer serve       # generate and serve it locally
leji viewer build       # export a self-contained static viewer folder
leji view               # generate, serve, and open it in your browser
leji detect             # find installed agent hosts
leji start              # open the layer in a detected agent host
leji adopt              # map an existing entrypoint into a context layer
leji ci                 # add a validate workflow (--provider github|gitlab|circleci|azure)
leji agent --name <n>   # bind an additional named agent into the layer
leji mounts hydrate     # materialize declared federation mounts into the resolver cache
leji mounts status      # each mount's availability, integrity, and pin ancestry
leji mounts locate      # resolver state for one mount: projection path, pin, verification
leji mounts update-pin  # move one mount's declared pin, verified against the source
leji changelog compact  # fold the oldest changelog entries into one compaction entry
```

See the full command reference (flags, exit codes, examples) at
https://leji.org/cli/.

Inside a repository that declares `@leji-org/leji`, has it installed under
`node_modules`, and whose copy meets the layer's minimum, `leji` runs that copy;
set `LEJI_NO_LOCAL` to any value to run this one. Yarn Plug'n'Play installs no
`node_modules`, so there is no installed copy to run and this one answers.

Behaviorally identical to the `leji` package on PyPI and the Go SDK: same
commands, same flags, same findings, same exit codes (0 clean, 1 findings, 2
usage error); the one runtime-specific behavior is the hand-off above, which the
Node and Python CLIs perform and the Go CLI does not (there, run the pinned copy
with `go tool leji`). All three implementations are tested against one shared fixture
suite. Install whichever matches your toolchain; agents and CI see the same
tool either way.

Supports spec line **1.0**. Schemas and templates for that line ship inside
the package; no network access is needed.

A programmatic API is exported alongside the CLI:

```js
import { validateLayer, writeIndex, conformanceReport } from '@leji-org/leji';

const { findings } = validateLayer('.');
```

## Generated files

The CLI keeps everything it generates under one `.leji/` directory at the
repository root, in four roles: `mounts/` (materialized federation mounts),
`viewer/` (generated viewer chrome), `dist/` (exported viewer builds), and
`work/` (the transient onboarding workspace). All of it is machine-local, and
none of it is committed. The first time a command creates one of those roles,
the CLI writes `.leji/.gitignore` containing `*`, so the directory ignores
itself; an existing `.leji/.gitignore` is left as it is, with a notice on
stderr. `leji init` and `leji adopt` also add a bare `.leji/` line to the
repository's root `.gitignore`.

`.leji/mounts.local.json` is a per-machine hints file: it points the resolver
at local checkouts of the context layers a federation mounts. The CLI reads it
and never writes it. Do not commit it; a path on one machine is not a path on
another.

Migrating from an earlier version:

- If `.leji/mounts.local.json` was committed, untrack it with
  `git rm --cached .leji/mounts.local.json`, and keep the bare `.leji/` line in
  the root `.gitignore`. Onboarding refuses to run while anything under
  `.leji/` is tracked, and the nested `.leji/.gitignore` takes precedence over
  any negation written at the root.
- A `docs/.leji/` tree left by 1.3.x is unused in 1.4.x and can be deleted.

Because the hints file stays uncommitted, a fresh clone hydrates its mounts
through the resolver store or the manifest's remote URLs, so a pinned commit has
to be reachable on its remote.

- Specification: https://leji.org
- Source: https://github.com/leji-org/leji (`packages/sdk`)
- License: Apache-2.0
