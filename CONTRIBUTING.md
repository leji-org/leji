# Contributing

The Leji spec is at 1.0, extracted from lived practice; the reference SDKs and tooling are at 1.4.1. The 1.0 spec line is GA and frozen at the v1.3.0 reference-tooling release: schema changes within it are additive only, and breaking changes require a new line per spec/versioning.md.

## Development setup

```bash
npm install      # JS deps
npm run setup:py # Python: creates packages/sdk-py/.venv with ruff/mypy/pytest/coverage/build
npm run setup:go # Go: installs goreleaser (the only Go dev tool not bundled with Go itself)
npm test         # runs the Node, Python, and Go suites
```

Prerequisites: Node 24+, a Python >=3.10 (the Python SDK pins 3.12 via `packages/sdk-py/.python-version`), and Go 1.26.6+. The `setup:*` scripts detect each toolchain and print install hints if it is missing. Both are idempotent and machine-local (the Python `.venv` is git-ignored), so re-run them after cloning or switching machines.

**Running your work-in-progress CLI**, two channels, one machine-wide at a time:

- `npm run cli:live` links the source tree; rebuilds flow through instantly. For iterating.
- `npm run cli:packed:refresh` builds, packs, and globally installs the publish-identical
  tarball (fingerprinted). Use before declaring packaging-sensitive or adoption-sensitive
  work ready; a LIVE pass proves logic, never packaging.
- `npm run cli:mode` says which is active (version strings can't); `npm run cli:assert -- live|packed`
  fails loudly on a mismatch. Full discipline: `docs/practice/testing-cli-adoptions.md`.

- **Spec proposals.** Open an issue first: the problem, the intent, and the lived case behind it. Leji specifies proven practice; proposals grounded in something a real team does carry more weight than ideas in the abstract.
- **Pull requests.** Normative changes (anything under `spec/` or `schemas/`) ride PR review and require a `CHANGELOG.md` entry plus a machine-readable `CHANGELOG.json` entry. Yes, the spec dogfoods itself.
- **Contributor terms.** Every commit needs a DCO sign-off (`git commit -s`); contributions ship under the license for their content type. See [Contributor terms](#contributor-terms).
- **Tooling.** SDK changes need tests and must keep `leji validate` passing against `examples/`. The Node, Python, and Go SDKs (`packages/sdk`, `packages/sdk-py`, `packages/sdk-go`) are behaviorally identical: a behavior change in one rides into all three, pinned by the shared `fixtures/` suite. Behavior develops and proves out fully in the TypeScript SDK first, the canonical implementation, against the LIVE channel ([testing-cli-adoptions](docs/practice/testing-cli-adoptions.md)); the Go and Python ports are made only from settled TypeScript behavior, pinned by the shared fixtures at port time. The Go SDK builds with Go 1.26.6+; `gofmt`, `go vet ./...`, and `go test ./...` must pass.
- **Language policy (Node side).** TypeScript + ESM everywhere: SDK source and tests, the site (`astro.config.ts` included), and repo scripts (run natively by Node's type stripping; develop on Node 24+). The one deliberate exception is `packages/create-leji/index.js`, a zero-build published shim. No `.mjs`: every package declares `"type": "module"`.
- **Style.** Spec prose is plain English, normative keywords per RFC 2119 (MUST/SHOULD/MAY), human-readable first.

## Contributor terms

These terms exist so that everyone, including you, knows what happens to a contribution. They are deliberately light: **you keep the copyright in what you write**, and there is no contributor license agreement to sign.

**Sign off your commits (DCO).** Every commit in a pull request carries a `Signed-off-by` line:

```bash
git commit -s -m "fix: correct the federation pin example"
```

The line certifies the Developer Certificate of Origin, version 1.1, whose canonical text is published at [developercertificate.org](https://developercertificate.org/): that you wrote the contribution, or have the right to submit it under the license below, and that you understand the contribution and the sign-off are public and permanent. Sign off with the name you are known by and an address you can be reached at; anonymous contributions cannot be accepted. A CI check verifies the sign-off on every commit in a pull request, and the pull request template asks you to acknowledge these terms.

At least one of the DCO 1.1 certifications must truthfully apply to every part of what you submit. The certificate covers material you created, material you took under an appropriate license, and material another person provided to you, and it treats each of those differently. Say where substantial copied or assistant-generated material came from, in the pull request.

**Your contribution ships under the license its content type already uses**, the same split that governs everything in this repository apart from the logo assets, which sit outside both licenses ([LICENSE.md](LICENSE.md)):

- Code, schemas, templates, and examples: **Apache-2.0**, including its patent grant.
- Specification prose, rationale, adoption guides, and repository documentation: **CC-BY-4.0**, with attribution.

Submitting a pull request means you license your contribution under whichever of the two applies to the content you wrote. Where one file mixes both, code blocks, schemas, and examples are Apache-2.0 wherever they appear, and the prose around them is CC-BY-4.0. You also license your contribution under the other of the two licenses, to the extent it is later moved across that boundary, so moved content stays licensed where it lands with no further grant, and its attribution travels with it. Nothing is assigned to the steward, and no separate copyright grant is asked for.

In return, the copyright licenses you grant are irrevocable, subject to their own conditions. Your contribution stays available under the license it landed under, and no steward, this one or a later one, can withdraw that grant. The patent promise below carries its own stated termination and is the one exception. Relicensing contributor-owned material under different terms would take each contributor's permission, or the replacement of their work.

**A patent promise for normative text.** If you contribute text that becomes a normative requirement of the specification, you promise not to assert any patent claim you own or control that is necessarily infringed by implementing that contribution. The promise is royalty-free and runs to everyone. It ends only for a party that asserts a patent claim against an implementation of the specification. Anyone who later acquires the patent claims it covers takes them subject to it.

**Attribution.** Contributors are credited in the repository's history, which is the record. Specification prose carries the editor line and the project attribution, not per-section credits, because the specification is read as one document. By contributing, you agree that credit in the repository history together with the project attribution satisfies CC-BY-4.0 attribution for your contribution, both in this repository and in distributed renderings, and that distributed renderings of the specification carry the project attribution, a link to the repository's contributor history, and the license notice.
