# Example: multi-repo setup with a federated context layer

A dedicated context repository (`core-context/`) consumed by a product repository (`app-payments/`) as a docs-only git submodule, with a sibling context layer joined as a pinned federation mount.

```
core-context/                  # the context layer's own repo (would be its own git repo)
├── leji.json                  # claims `federated`; declares the sibling mount (source + pin)
└── docs/
    ├── boot-profile.md
    ├── domain/ system/ governance/ decisions/   # categories, as in the monorepo example
    ├── agents/core.md
    ├── context-index.json     # generated; carries the mounts routing array
    └── context-changelog.json

product-context/               # the sibling layer's own repo (the product team's)
├── leji.json
├── boot-profile.md
└── context/ domain/ decisions/

app-payments/                  # one of N consuming repos
├── CLAUDE.md                  # → "Read context/docs/boot-profile.md"
└── context/                   # ← git submodule, pinned to a core-context commit
```

What to notice:

- The pattern-2 submodule (`app-payments/context/`) is a leaf: no build or runtime step touches it, so a stale pin degrades knowledge, never the build.
- The federation mount in `core-context/leji.json` declares the product team's layer as a distinct named source with its `owner`, upstream `source`, and a full commit **`pin`** — the manifest-held version of record. Pin updates arrive as reviewable change sets.
- Mounted content is never committed into the host. `leji mounts hydrate` materializes the pinned **layer projection** into the gitignored `.leji/mounts/` cache (resolved from a git object store — a machine-local hint, the resolver store, or `--fetch` from the source), and `leji mounts locate acme-product-context` tells readers where it landed. Unhydrated, `leji validate` reports an honest availability warning and nothing breaks.
- Keeping the pin current is one loop: `leji mounts hydrate --fetch` observes the sources, `leji mounts status` shows how far the pin has fallen behind, `leji mounts update-pin acme-product-context` moves it forward to the witnessed commit, and `leji mounts hydrate` materializes the new pin. `update-pin` is offline by default (it promotes the last witness a run observed) and moves the pin forward only; pass `--fetch` to observe the declared source during the run, and `--dry-run` to see the comparison without rewriting the manifest (with `--fetch` the store and network acts still happen, so fetched objects and refs land in the managed store). It rewrites the pin's own bytes and nothing else, so the change is a one-line reviewable diff. The cache entry for the old pin is left behind: remove it under `.leji/mounts/` by hand when you want the space, as there is no prune command.
- The sibling is read, not absorbed: never merged into the host's categories, and its owner still approves its own changes.

`core-context/` validates clean (`leji validate`; the unhydrated mount is a warning by design) and reports `claimedLevel: federated, verifiedLevel: governed` from `leji conformance`: the pinned declaration, routing metadata, and boot-profile surfacing are machine-verified, while the pin-reachability item reports `unknown` without source access — run `leji conformance --federation=verify` against a real source for the networked probe, and `unknown` never awards the level. The cross-repo machinery that can't live inside one example (external consumption, consumer-side pins) stays `manual`/process-attested, verified in a real multi-repo organization rather than a checked-in example.
