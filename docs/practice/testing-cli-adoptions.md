---
title: CLI Testing (LIVE/PACKED)
summary: The two evidence channels for testing the leji CLI against real repositories, LIVE (linked source) and PACKED (installed artifact), and the discipline for using them.
freshness:
  reviewAfter: 2026-12-21
---

# Testing the CLI against real adoptions: LIVE and PACKED

The `leji` CLI is developed and dogfooded at the same time: the machine that edits this
repository also runs `leji adopt` on real sibling repositories. Which build those runs
execute is not a detail; it decides what a passing run proves. There are two evidence
channels, switched and inspected with the `cli:*` scripts in the root `package.json`.

## LIVE: linked source

`npm run cli:live` checks assets, builds the TypeScript SDK, and `npm link`s it, so the
global `leji` resolves into this checkout and **every rebuild flows through instantly**.

- **Proves:** CLI logic and behavior, at iteration speed.
- **Conceals:** packaging entirely: the `files` whitelist, bin wiring, and whether
  templates, schemas, fonts, and `cli.json` actually ship. A LIVE pass says nothing about
  the artifact a user would install.
- **Use for:** the fix-rebuild-rerun loop while working a problem.

## PACKED: installed artifact

`npm run cli:packed:refresh` cleans `dist/` *and* the tsc buildinfo (a half-clean lets
tsc emit nothing and pack a dist-less tarball), rebuilds, packs the exact tarball
`npm publish` would upload, installs it globally (remove-then-install, from outside the
workspace, because `npm i -g` misbehaves under `npm run` and inside a workspaces project), and
records a fingerprint sidecar (`var/cli-packed.json`: sha256, pack time, source revision,
dirty state). `npm run cli:packed` reinstalls the recorded artifact without rebuilding.

- **Proves:** the publish-identical package works cold: contents, bin, asset resolution.
- **Costs:** no flow-through; a source fix needs `cli:packed:refresh` to reach the CLI.
- **Use for:** any adoption-on-record, and before declaring packaging-sensitive work
  (dependencies, `files`, templates, schemas, assets, viewer chrome) ready.

## Discipline

- **An investigation records its channel at the start and never switches silently.**
  `npm run cli:mode` says which is active; `npm run cli:assert -- live|packed [sha256]`
  fails loudly on a mismatch; run it at the start and end of an adoption-on-record.
- **The fingerprint is the evidence, not the mode.** Two PACKED observations are only
  comparable if the sha256 matches; a refresh starts a new investigation epoch.
- **A PACKED adoption supplements the release gate, never replaces it.** The reproducible
  gate remains `scripts/smoke-prepublish.sh` (all registries' artifacts, cold-installed);
  a PACKED pass covers the npm artifact only.
- **Version strings cannot distinguish the channels**: both print the same version.
  Trust `cli:mode`'s resolved path and fingerprint, never the version banner.
