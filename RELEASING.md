# Releasing

All reference packages version together as one coherent release: the three SDKs
(npm, PyPI, Go), the `create-leji` initializer, and the `@leji-org/mcp` server.
CI (`.github/workflows/ci.yml`) gates every change on asset-sync drift and the
three SDK suites. Releases are tag-driven: one shared `release.yml` dispatches on
each per-package tag and runs only that package's publish job (see the tagging
model below).

## How changes reach main

Every change lands on `main` by pull request; direct pushes are blocked by ruleset for
everyone, maintainers included. Branch names follow `feat/*`, `chore/*`, `fix/*`,
`context/*`, `release/*`, or `rc/*`. Maintenance PRs squash-merge; a release PR carries one
commit for the whole release, signed off for DCO, and is rebase-merged. Rebase-merging
writes a new sha, so `main` gets a different commit object with the same content: its
tree is byte-identical to what CI proved on the `rc/*` candidate branch, verified at
merge, and the message, the `Signed-off-by` line, and the authorship carry over, while
the committer becomes GitHub. Release candidates push to `rc/*`, which exists only for
that proof. Every commit carries a DCO `Signed-off-by` line (see CONTRIBUTING.md,
"Contributor terms"); the required status checks are the full CI matrix. A PR normally
merges only when they are green; a maintainer can merge past a failing check as a
recorded exception, and direct pushes stay blocked either way.

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
   Four of its lines are preconditions of the **first** tag, not just of a green
   run, because the PyPI upload repeats them after the tag exists, where nothing
   can be corrected in place: `release-path pins exact`, `wheel built`,
   `twine check --strict (wheel + sdist)`, and `invalid sdist rejected by twine
   check --strict (unrenderable long_description)` (the gate proving it can still
   fail). Read them: a tag cut past any of the four is a publish that can still
   fail once it is too late to change anything. That last line asserts twine's
   own refusal, status and diagnostic both, so an infrastructure failure is
   reported as one instead of counting as a gate that fired; the distribution it
   refuses is built during the run from tracked, reviewable text (a metadata file
   and the unrenderable long description it declares), so nothing on this path is
   a stored binary. The smoke also clears stale build output, stopping the run if
   it cannot, and refuses on CI to run against a tree carrying untracked or
   ignored files on the paths it reads.
   This local run is the earliest of several, never the only one: see the
   rehearsal below.
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

## The rehearsal: the release path runs before there is a tag

A check that executes for the first time on the irreversible path reports after
the tag exists, where it cannot be corrected in place. So every release check
that writes nothing lives in one reusable workflow,
`.github/workflows/release-checks.yml`, and three callers run it:

| Caller | When | What runs |
|---|---|---|
| `ci.yml` → `Release rehearsal` | every pull request | smoke (no Node 22 container leg), version comparison, Python test + build + twine |
| `ci.yml` → `Release rehearsal` | every push to `rc/*` | all of the above with the Node 22 leg required, plus the cross-platform Go build |
| `release.yml` → `Release checks` | every release tag | the full set again, on the tagged bytes |

It carries the pre-publish smoke, the version comparison that holds all five
packages to one version, the Python test + build + `twine check --strict`, and
`goreleaser release --clean --skip=publish` with every expected archive and its
checksum asserted. `release.yml` calls it before anything else and its remaining
jobs do nothing but write: the npm, JSR, and PyPI publishes and the draft GitHub
release.

Two consequences for the procedure:

- **The binding proof is the `rc/*` run, not the local one.** A local run reads
  the machine it runs on; the runner reads a clean checkout, which is what the
  tag will publish from. After the last amend to the release commit, push the
  candidate again and let the full rehearsal go green on those exact bytes.
- **Verify tree identity before tagging.** The tag must name a commit whose tree
  equals the rc-proven one (`git rev-parse <tag>^{tree}` against
  `git rev-parse <rc-commit>^{tree}`). A rehearsal binds to the bytes it saw.

## Tagging model: per-package, path-prefixed

Each package publishes from its **own** path-prefixed tag, and each release
workflow triggers on **only** its own tag. Never push a plain repo-wide
`vX.Y.Z`: the Go submodule will not resolve from it, and a cross-triggered
publish is irreversible.

| Tag | Publishes |
|---|---|
| `packages/sdk/v1.4.1` | npm `@leji-org/leji` **and** JSR `@leji-org/leji` (one tag, two jobs) |
| `packages/create-leji/v1.4.1` | npm `create-leji` |
| `packages/sdk-py/v1.4.1` | PyPI `leji` |
| `packages/sdk-go/v1.4.1` | Go module index + goreleaser binaries |
| `packages/mcp/v1.4.1` | npm `@leji-org/mcp` |

Cut all five at the same version once the pre-flight (above) is green. Tag the
sdk first: `create-leji` and `@leji-org/mcp` both depend on
`@leji-org/leji@^<version>`, and an npm publish is irreversible. **Wait for the
sdk's npm publish job to go green and confirm the version is live**
(`npm view @leji-org/leji version`), then cut the rest:

```
# 1. The sdk tag; then WAIT for the npm publish to be green and live.
git tag packages/sdk/v1.4.1          && git push origin packages/sdk/v1.4.1
npm view @leji-org/leji version      # must print 1.4.1 before continuing

# 2. Only after @leji-org/leji@1.4.1 is live on npm:
git tag packages/sdk-py/v1.4.1       && git push origin packages/sdk-py/v1.4.1
git tag packages/sdk-go/v1.4.1       && git push origin packages/sdk-go/v1.4.1
git tag packages/create-leji/v1.4.1  && git push origin packages/create-leji/v1.4.1
git tag packages/mcp/v1.4.1          && git push origin packages/mcp/v1.4.1
```

## Finalize: publish the Go binaries (required)

Tagging is not the last step. The Go release job runs GoReleaser with
`--skip=publish` and leaves a **draft** GitHub Release, so the binaries are not
public until the separate `release-finalize` workflow publishes it. Skipping this
leaves the announcement pointing at a release nobody can download.

After every publish job is green, run the `release-finalize` workflow manually and
give it the Go tag as `release_tag` (e.g. `packages/sdk-go/v1.4.1`). It publishes
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
(`packages/sdk-go/v1.4.1`); a plain `v1.4.1` will **not** make
`go install github.com/leji-org/leji/packages/sdk-go/cmd/leji@v1.4.1` resolve.
There is no upload step: pkg.go.dev indexes the tag on first request.

## One-time setup (before the first tag)

Configure, each pointing at this repo and its release workflow: the npm Trusted
Publisher, the PyPI Trusted Publisher (a pending publisher for the first
release), and the JSR `@leji-org` scope with OIDC.
