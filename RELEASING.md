# Releasing

All reference packages version together as one coherent release: the three SDKs
(npm, PyPI, Go), the `create-leji` initializer, and the `@leji-org/mcp` server.
CI (`.github/workflows/ci.yml`) gates every change on asset-sync drift and the
three SDK suites; releases are tag-driven, one workflow per package (see the
tagging model below).

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

## Tagging model: per-package, path-prefixed

Each package publishes from its **own** path-prefixed tag, and each release
workflow triggers on **only** its own tag. Never push a plain repo-wide
`v1.0.0`: the Go submodule will not resolve from it, and a cross-triggered
publish is irreversible.

| Tag | Publishes |
|---|---|
| `packages/sdk/v1.2.0` | npm `@leji-org/leji` **and** JSR `@leji-org/leji` (one tag, two jobs) |
| `packages/create-leji/v1.2.0` | npm `create-leji` |
| `packages/sdk-py/v1.2.0` | PyPI `leji` |
| `packages/sdk-go/v1.2.0` | Go module index + goreleaser binaries |
| `packages/mcp/v1.2.0` | npm `@leji-org/mcp` |

Cut all five at the same version once the pre-flight (above) is green. Tag `mcp`
last so `@leji-org/leji` is live on npm before it resolves against it:

```
git tag packages/sdk/v1.2.0          && git push origin packages/sdk/v1.2.0
git tag packages/create-leji/v1.2.0  && git push origin packages/create-leji/v1.2.0
git tag packages/sdk-py/v1.2.0       && git push origin packages/sdk-py/v1.2.0
git tag packages/sdk-go/v1.2.0       && git push origin packages/sdk-go/v1.2.0
git tag packages/mcp/v1.2.0          && git push origin packages/mcp/v1.2.0
```

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
no stored token; attestations ride trusted publishing). A published `1.2.0` is
immutable, so inspect the wheel and sdist before tagging
(`npm run smoke:prepublish`).

## Go module (the `packages/sdk-go` tag)

The Go module lives at `packages/sdk-go`, so its import path is
`github.com/leji-org/leji/packages/sdk-go`. Go resolves versions of a module in
a subdirectory **only** from tags that carry the module subpath prefix
(`packages/sdk-go/v1.2.0`); a plain `v1.2.0` will **not** make
`go install github.com/leji-org/leji/packages/sdk-go/cmd/leji@v1.2.0` resolve.
There is no upload step: pkg.go.dev indexes the tag on first request.

## One-time setup (before the first tag)

Configure, each pointing at this repo and its release workflow: the npm Trusted
Publisher, the PyPI Trusted Publisher (a pending publisher for the first
release), and the JSR `@leji-org` scope with OIDC.
