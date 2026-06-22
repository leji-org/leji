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
leji viewer             # generate the static viewer for the context layer
leji view               # generate, serve, and open it in your browser
leji detect             # find installed agent hosts
leji start              # open the layer in a detected agent host
leji adopt              # map an existing entrypoint into a context layer
leji ci                 # add a validate workflow (--provider github|gitlab|circleci|azure)
leji agent --name <n>   # bind an additional named agent into the layer
```

See the full command reference (flags, exit codes, examples) at
https://leji.org/cli/.

Behaviorally identical to the `leji` package on PyPI and the Go SDK: same
commands, same flags, same findings, same exit codes (0 clean, 1 findings, 2
usage error). All three implementations are tested against one shared fixture
suite. Install whichever matches your toolchain; agents and CI see the same
tool either way.

Supports spec line **1.0**. Schemas and templates for that line ship inside
the package; no network access is needed.

A programmatic API is exported alongside the CLI:

```js
import { validateLayer, writeIndex, conformanceReport } from '@leji-org/leji';

const { findings } = validateLayer('.');
```

- Specification: https://leji.org
- Source: https://github.com/leji-org/leji (`packages/sdk`)
- License: Apache-2.0
