# Releasing

All reference packages version together as one coherent release: the three SDKs
(npm, PyPI, Go), the `create-leji` initializer, and the `@leji-org/mcp` server.
CI (`.github/workflows/ci.yml`) gates every change on asset-sync drift and the
three SDK suites. Releases are tag-driven: one shared `release.yml` dispatches on
each per-package tag and runs only that package's publish job (see the tagging
model below).

## Before tagging

1. `npm run assets`: re-vendor schemas/templates/cli.json into every SDK.
2. `npm run assets:check`: must report `assets in sync`.
3. `npm test` (root) plus `go test ./...` and `pytest -q`: all green.
4. Bump all 9 version locations at once with `npm run version:set <x>` (one
   command sets every SDK manifest, the Python pyproject, and the Go SDKVersion
   constant); confirm coherence with `npm run version:check`.
5. `npm run smoke:prepublish` (`scripts/smoke-prepublish.sh`): builds each publishable artifact (npm tarball,
   PyPI wheel, Go binary), cold-installs it in a throwaway sandbox, and runs the
   CLI battery plus cross-SDK parity. Must print `Pre-publish smoke GREEN`. It
   publishes nothing; it rehearses the artifacts before the irreversible tag.
6. For changes touching CLI behavior, adoption, templates, schemas, assets, or
   viewer packaging: complete one representative adoption run on a real
   repository using a PACKED artifact (`npm run cli:packed:refresh`; see
   `docs/practice/testing-cli-adoptions.md`), and record the tarball fingerprint
   with the outcome. This supplements the smoke; it never replaces it.
7. **Stamp the release date.** Every prose claim about the spec freeze names the
   release that carries it, not a calendar date, so nothing else needs touching.
   Two places do hold a real date and are `unreleased` or stale until this step:
   the `CHANGELOG.md` release heading (`## <version> · unreleased`) and the
   matching `CHANGELOG.json` entry's `date`. Set both to the day you tag.
   `CHANGELOG.json` declares the context-changelog schema, so its date must stay
   `YYYY-MM-DD`; do not park a word there.

## Tagging model: per-package, path-prefixed

Each package publishes from its **own** path-prefixed tag, and each release
workflow triggers on **only** its own tag. Never push a plain repo-wide
`v1.0.0`: the Go submodule will not resolve from it, and a cross-triggered
publish is irreversible.

| Tag | Publishes |
|---|---|
| `packages/sdk/v1.3.0` | npm `@leji-org/leji` **and** JSR `@leji-org/leji` (one tag, two jobs) |
| `packages/create-leji/v1.3.0` | npm `create-leji` |
| `packages/sdk-py/v1.3.0` | PyPI `leji` |
| `packages/sdk-go/v1.3.0` | Go module index + goreleaser binaries |
| `packages/mcp/v1.3.0` | npm `@leji-org/mcp` |

Cut all five at the same version once the pre-flight (above) is green. Tag the
sdk first: `create-leji` and `@leji-org/mcp` both depend on
`@leji-org/leji@^<version>`, and an npm publish is irreversible. **Wait for the
sdk's npm publish job to go green and confirm the version is live**
(`npm view @leji-org/leji version`), then cut the rest:

```
# 1. The sdk tag; then WAIT for the npm publish to be green and live.
git tag packages/sdk/v1.3.0          && git push origin packages/sdk/v1.3.0
npm view @leji-org/leji version      # must print 1.3.0 before continuing

# 2. Only after @leji-org/leji@1.3.0 is live on npm:
git tag packages/sdk-py/v1.3.0       && git push origin packages/sdk-py/v1.3.0
git tag packages/sdk-go/v1.3.0       && git push origin packages/sdk-go/v1.3.0
git tag packages/create-leji/v1.3.0  && git push origin packages/create-leji/v1.3.0
git tag packages/mcp/v1.3.0          && git push origin packages/mcp/v1.3.0
```

## Finalize: publish the Go binaries (required)

Tagging is not the last step. The Go release job runs GoReleaser with
`--skip=publish` and leaves a **draft** GitHub Release, so the binaries are not
public until the separate `release-finalize` workflow publishes it. Skipping this
leaves the announcement pointing at a release nobody can download.

After every publish job is green, run the `release-finalize` workflow manually and
give it the Go tag as `release_tag` (e.g. `packages/sdk-go/v1.3.0`). It publishes
the draft release and enables Discussions. Confirm the release is no longer marked
draft before announcing.

## npm + JSR (the `packages/sdk` tag)

The `packages/sdk/v*` tag drives two publish jobs for the one JS SDK:

- **npm `@leji-org/leji`** via Trusted Publishing (OIDC, no stored token). Provenance is
  **automatic** under trusted publishing; the `--provenance` flag is only for the
  older token path.
- **JSR `@leji-org/leji`** via OIDC from the same tag. It publishes the TS source per
  `packages/sdk/jsr.json` (scoped `@leji-org`, ESM / source-oriented).

`create-leji` publishes from its own `packages/create-leji/v*` tag (npm, OIDC).

## PyPI (the `packages/sdk-py` tag)

`leji` publishes to PyPI from `packages/sdk-py/v*` via Trusted Publishing (OIDC,
no stored token; attestations ride trusted publishing). A published version is
immutable, so inspect the wheel and sdist before tagging
(`npm run smoke:prepublish`).

## Go module (the `packages/sdk-go` tag)

The Go module lives at `packages/sdk-go`, so its import path is
`github.com/leji-org/leji/packages/sdk-go`. Go resolves versions of a module in
a subdirectory **only** from tags that carry the module subpath prefix
(`packages/sdk-go/v1.3.0`); a plain `v1.3.0` will **not** make
`go install github.com/leji-org/leji/packages/sdk-go/cmd/leji@v1.3.0` resolve.
There is no upload step: pkg.go.dev indexes the tag on first request.

## One-time setup (before the first tag)

Configure, each pointing at this repo and its release workflow: the npm Trusted
Publisher, the PyPI Trusted Publisher (a pending publisher for the first
release), and the JSR `@leji-org` scope with OIDC.
