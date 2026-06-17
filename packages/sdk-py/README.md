# leji (Python)

Reference SDK and CLI for the [Leji specification](https://leji.org): the open
specification for the shared context layer of AI-native teams.

```bash
pip install leji        # or: uv tool install leji / pipx install leji
leji init               # bootstrap a context layer interactively
leji validate           # manifest, artifacts, frontmatter, lint rules
leji index              # generate the context index
leji index --check      # fail when the index is stale
leji changelog check    # append-only discipline
leji freshness          # review-horizon report
leji conformance        # score the layer against its claimed level
leji docs               # generate the static docs viewer (Docsify)
leji docs --serve       # generate, then preview on 127.0.0.1
```

Behaviorally identical to the `leji` npm package: same commands, same flags,
same findings, same exit codes (0 clean, 1 findings, 2 usage error). Both
implementations are tested against one shared fixture suite. Install whichever
matches your toolchain; agents and CI see the same tool either way.

Supports spec line **1.0**. Schemas and templates for that line ship inside
the package; no network access is needed.

- Specification: https://leji.org
- Source: https://github.com/leji-org/leji (`packages/sdk-py`)
- License: Apache-2.0
