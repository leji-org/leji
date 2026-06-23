# Contributing

The Leji spec is at 1.0, extracted from lived practice; the reference SDKs and tooling are at 1.2.0. The 1.0 spec line is stable: schema changes within it are additive only, and breaking changes require a new line per spec/versioning.md.

- **Spec proposals.** Open an issue first: the problem, the intent, and the lived case behind it. Leji specifies proven practice; proposals grounded in something a real team does carry more weight than ideas in the abstract.
- **Pull requests.** Normative changes (anything under `spec/` or `schemas/`) ride PR review and require a `CHANGELOG.md` entry plus a machine-readable `CHANGELOG.json` entry. Yes, the spec dogfoods itself.
- **Tooling.** SDK changes need tests and must keep `leji validate` passing against `examples/`. The Node, Python, and Go SDKs (`packages/sdk`, `packages/sdk-py`, `packages/sdk-go`) are behaviorally identical: a behavior change in one rides into all three, pinned by the shared `fixtures/` suite. The Go SDK builds with Go 1.23+; `gofmt`, `go vet ./...`, and `go test ./...` must pass.
- **Language policy (Node side).** TypeScript + ESM everywhere: SDK source and tests, the site (`astro.config.ts` included), and repo scripts (run natively by Node's type stripping; develop on Node 24+). The one deliberate exception is `packages/create-leji/index.js`, a zero-build published shim. No `.mjs`: every package declares `"type": "module"`.
- **Style.** Spec prose is plain English, normative keywords per RFC 2119 (MUST/SHOULD/MAY), human-readable first.
