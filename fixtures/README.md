# Conformance fixtures

Shared test fixtures consumed by **both** SDK test suites (`packages/sdk` via
`node --test`, `packages/sdk-py` via pytest). They are the contract that keeps
the two implementations behaviorally identical: every fixture is a miniature
repository plus an `expected.json` stating what `leji validate` must report.

## Matching rules

- Findings match on the triple **(rule, severity, path)**, sorted by
  (path, rule). Message text is implementation-specific and never compared.
- Paths are POSIX, repository-root-relative, exactly as the CLI reports them.
- `expected.json` carries the expected process exit code (`0` clean or
  warnings only, `1` at least one error) and the full findings list; the match
  is exact, no extra or missing findings allowed.
- Git-dependent rules (`changelog-append-only`, `changelog-unverifiable`) are
  exercised in unit tests with injected baselines, not in fixtures: fixture
  behavior would depend on the host repository's git state.
- Beyond `validate`, a fixture may pin other commands with optional blocks:
  `"conformance": {exit, claimedLevel, verifiedLevel}` and
  `"indexCheck": {exit, stale}`. Harnesses assert them only when present.
- Schema-violation fixtures keep one violation per artifact entry so finding
  multiplicity stays identical across validator engines (Ajv vs jsonschema).

## Adding a fixture

1. Create the smallest layer that triggers exactly the finding under test
   (start from `valid-minimal-core`).
2. Run `leji validate --root fixtures/<name>` with both SDKs; confirm they
   agree before baking `expected.json`.
3. One failure mode per fixture. A fixture that fires three rules is three
   fixtures.
