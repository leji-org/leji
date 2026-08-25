---
id: dependency-pinning-and-refresh
title: Dependency pinning and refresh policy
status: accepted
date: 2026-08-24
deciders:
  - Vuong Nguyen
affectedPaths:
  - SECURITY.md
  - .github/workflows/dependency-audit.yml
  - .github/workflows/ci.yml
  - packages/sdk-py/pyproject.toml
  - package.json
affectedCategories:
  - governance
  - decisions
---

# Dependency pinning and refresh policy

## Context

This repository publishes into three package ecosystems, and every install on the
release path is pinned to an exact version, so that the toolchain and the
JavaScript and Go dependency sets are the same for any two builds of one commit;
the Python runtime dependencies are the one deliberate range, below. An exact pin without a rule that refreshes it is
drift with a timestamp on it: the versions stop moving, and the advisories keep
arriving.

Two things were missing. Nothing said when pins move, so they moved when someone
noticed. And `SECURITY.md` said how to report a vulnerability without saying what
gets patched or how fast, which leaves a reporter guessing and leaves the project
free to answer differently every time.

Dependabot covers part of the ground: security updates and the dependency graph
are on, scheduled version-update pull requests are off. Its security updates
reach direct dependencies in the ecosystems it parses, which is neither the whole
shipped dependency surface nor a schedule anyone committed to.

## Decision

### Pin classes

- **Build and publish toolchain, GitHub Actions, JavaScript runtime
  dependencies: exact.** Actions are pinned to full commit SHAs with the version
  in a trailing comment. The `^1.4.0` ranges between packages inside this
  monorepo are the one deliberate exception; they are aligned to the released
  version at every release.
- **Python runtime dependencies: compatible ranges** (`jsonschema>=4.18,<5`,
  `PyYAML>=6,<7`). A library on PyPI that pins its dependencies exactly makes
  itself uninstallable next to everything else in an application's environment,
  so the range is what the SDK owes its users. CI runs the supported range at
  both ends rather than only at the newest interpreter.
- **Python development tools: exact**, since nothing installs them alongside
  anything else.
- **Go: the minimal versions in `go.mod`**, verified against `go.sum`.
- **No `latest` and no `--upgrade` on the release path**, in any workflow,
  manifest, or script. A check enforces this.

### A release is a refresh

Every release bumps each exact pin to the latest compatible version, re-pins
Actions to current commit SHAs, and runs the three dependency audits below.
Between releases, pins move only under the patching rule.

### Security response

Security reports are acknowledged and triaged on a best-effort basis, typically within 7 days. Where a compatible fix exists, a forward-only patch release follows, typically within 7 days for high or critical findings and at the next release otherwise; where none exists, we publish status and mitigation. Only the latest minor line receives patches.

This covers shipped runtime dependencies, transitive dependencies, and the
publish path alike. For a transitive finding, `npm audit fix` is a first attempt
to be verified, never the resolution on its own. Released artifacts are never
modified: a fix is a new version.

### The 90-day floor

If no release goes out for 90 days, the refresh runs anyway. It ends in either a
maintenance patch release or a recorded finding that nothing needed to change.

### The audit workflow

`.github/workflows/dependency-audit.yml` runs monthly on a schedule, on demand,
on pull requests that touch a dependency manifest or the workflow itself, and on
every push to a release-candidate branch. It runs three scanners, each pinned:
`npm audit` over the root lockfile, `pip-audit` over a resolved export of the
Python SDK's dependencies, and `govulncheck` over the Go SDK.

The failure threshold differs by ecosystem because the tools differ. `npm audit`
fails the run at high severity or above. `pip-audit` and `govulncheck` fail on
any finding: neither reports a severity that could be thresholded, and each
already narrows its report, `pip-audit` to what is installed and `govulncheck` to
what the code actually calls.

## Consequences

A scheduled run goes red when a genuine advisory lands against an unchanged pin,
including on a quiet month when nothing was committed. That is the point of the
schedule, and it is the only signal that arrives without a code change to trigger
it. The response rule above is what bounds it.

Scheduled version-update pull requests stay off. The release refresh is the
mechanism that moves pins, and a parallel stream of update pull requests between
releases would compete with it while adding review load. Dependabot security
updates and the dependency graph stay on.

Exact pins mean this project carries the cost of its own refresh at every
release, in exchange for a toolchain that resolves identically, JavaScript and Go
dependency sets that do too, and a supply chain where every version that ships
was chosen by someone.

Compatible ranges on the Python runtime dependencies mean an adopter's installed
versions may differ from the ones CI resolved. That is the deliberate trade for
being installable, and it is why the Python audit runs against a resolved export
taken at audit time rather than against a checked-in list.
