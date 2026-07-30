<!-- What does this change, and why? Link the issue if there is one. -->

## Checklist

- [ ] `npm run assets:check` passes (schemas/templates/cli.json vendored copies in sync)
- [ ] Behavior changes land in all three SDKs (npm, PyPI, Go) with `npm run parity` green, or the PR says why not
- [ ] Tests cover the change; the three suites pass (`npm test`)
- [ ] Spec/schema changes respect the frozen 1.0 line (clarifications and additive only; see spec/versioning.md)
- [ ] Did this change alter the context? If yes, the context-layer delta (docs/, changelog entry, index) rides in this change set
