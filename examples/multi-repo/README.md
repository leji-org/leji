# Example: multi-repo setup with a federated context layer

A dedicated context repository (`core-context/`) consumed by a product repository (`app-payments/`) as a docs-only git submodule, with a sibling context layer mounted under federation.

```
core-context/                  # the context layer's own repo (would be its own git repo)
├── leji.json                  # claims `federated`; declares the sibling mount
└── docs/
    ├── boot-profile.md
    ├── domain/ system/ governance/ decisions/   # categories, as in the monorepo example
    ├── agents/core.md
    ├── context-index.json     # generated
    ├── context-changelog.json
    └── product-context/       # ← sibling layer mounted under federation (its own leji.json + content)

app-payments/                  # one of N consuming repos
├── CLAUDE.md                  # → "Read context/docs/boot-profile.md"
└── context/                   # ← git submodule, pinned to a core-context commit
```

What to notice:

- The submodule is a leaf: `app-payments` has no build or runtime step that touches `context/`, so a stale pin degrades knowledge, never the build.
- Pin updates arrive as scripted pull requests in each consuming repo: context changes are visible, reviewable, attributable.
- The sibling mount in `core-context/leji.json` (`federation.mounts`) declares another team's context layer as a distinct named source with its `owner` and upstream `source`. It is read, not absorbed: the sibling is never merged into the host's categories, and its owner still approves its own changes. In a real org the sibling is a pinned docs-only submodule from the product team's repository.

`core-context/` is fully materialized and validates clean at `federated` (`leji validate`, `leji conformance`), including the `product-context/` sibling, which carries its own `leji.json` and validates on its own. What stays described rather than materialized is the cross-repo machinery that can't live inside one example repository: the `app-payments/context/` submodule, its pinned revision, external consumption, and stale-pin reporting. Those are exactly the items `leji conformance` reports as `manual` at the `federated` level: the tool checks the mechanical parts (manifest, index, changelog, profiles, mount presence with ownership intact), and the cross-repo relationships are verified in a real multi-repo setup, not in a checked-in example.
