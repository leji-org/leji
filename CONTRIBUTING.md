# Contributing

The Leji spec is at 1.0, extracted from lived practice; the reference SDKs and tooling are at 1.3.0. The 1.0 spec line is GA and frozen at the v1.3.0 reference-tooling release: schema changes within it are additive only, and breaking changes require a new line per spec/versioning.md.

## Development setup

```bash
npm install      # JS deps
npm run setup:py # Python: creates packages/sdk-py/.venv with ruff/mypy/pytest/coverage/build
npm run setup:go # Go: installs goreleaser (the only Go dev tool not bundled with Go itself)
npm test         # runs the Node, Python, and Go suites
```

Prerequisites: Node 24+, a Python >=3.10 (the Python SDK pins 3.12 via `packages/sdk-py/.python-version`), and Go 1.23+. The `setup:*` scripts detect each toolchain and print install hints if it is missing. Both are idempotent and machine-local (the Python `.venv` is git-ignored), so re-run them after cloning or switching machines.

**Running your work-in-progress CLI**, two channels, one machine-wide at a time:

- `npm run cli:live` links the source tree; rebuilds flow through instantly. For iterating.
- `npm run cli:packed:refresh` builds, packs, and globally installs the publish-identical
  tarball (fingerprinted). Use before declaring packaging-sensitive or adoption-sensitive
  work ready; a LIVE pass proves logic, never packaging.
- `npm run cli:mode` says which is active (version strings can't); `npm run cli:assert -- live|packed`
  fails loudly on a mismatch. Full discipline: `docs/practice/testing-cli-adoptions.md`.

- **Spec proposals.** Open an issue first: the problem, the intent, and the lived case behind it. Leji specifies proven practice; proposals grounded in something a real team does carry more weight than ideas in the abstract.
- **Pull requests.** Normative changes (anything under `spec/` or `schemas/`) ride PR review and require a `CHANGELOG.md` entry plus a machine-readable `CHANGELOG.json` entry. Yes, the spec dogfoods itself.
- **Tooling.** SDK changes need tests and must keep `leji validate` passing against `examples/`. The Node, Python, and Go SDKs (`packages/sdk`, `packages/sdk-py`, `packages/sdk-go`) are behaviorally identical: a behavior change in one rides into all three, pinned by the shared `fixtures/` suite. The Go SDK builds with Go 1.23+; `gofmt`, `go vet ./...`, and `go test ./...` must pass.
- **Language policy (Node side).** TypeScript + ESM everywhere: SDK source and tests, the site (`astro.config.ts` included), and repo scripts (run natively by Node's type stripping; develop on Node 24+). The one deliberate exception is `packages/create-leji/index.js`, a zero-build published shim. No `.mjs`: every package declares `"type": "module"`.
- **Style.** Spec prose is plain English, normative keywords per RFC 2119 (MUST/SHOULD/MAY), human-readable first.
