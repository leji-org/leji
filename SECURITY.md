# Security

Leji is a specification plus a local SDK that runs on your machine. There is no account and no telemetry: nothing reports back. Contexing, LLC, Leji's steward, is developing a hosted service at leji.ai; the reference tooling never contacts it. `leji viewer serve` starts a local HTTP server on the loopback interface, and the federation commands you invoke deliberately (`leji mounts hydrate --fetch`, `leji mounts update-pin --fetch`, `leji conformance --federation=verify`) contact the repository you named.

To report a vulnerability in the SDK or tooling, use GitHub private vulnerability reporting on [leji-org/leji](https://github.com/leji-org/leji/security/advisories/new), or email security@leji.org. Please don't file public issues for vulnerabilities before a fix is available.

## Supported versions and patching

Security reports are acknowledged and triaged on a best-effort basis, typically within 7 days. Where a compatible fix exists, a forward-only patch release follows, typically within 7 days for high or critical findings and at the next release otherwise; where none exists, we publish status and mitigation. Only the latest minor line receives patches.

The pinning, refresh, and audit policy behind that commitment is recorded in [decision 0008](docs/decisions/0008-dependency-pinning-and-refresh.md).
