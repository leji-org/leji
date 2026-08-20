# Security

Leji is a specification plus a local SDK that runs on your machine. There is no account and no telemetry: nothing reports back. Contexing, LLC, Leji's steward, is developing a hosted service at leji.ai; the reference tooling never contacts it. `leji viewer serve` starts a local HTTP server on the loopback interface, and the federation commands you invoke deliberately (`leji mounts hydrate --fetch`, `leji mounts update-pin --fetch`, `leji conformance --federation=verify`) contact the repository you named.

To report a vulnerability in the SDK or tooling, use GitHub private vulnerability reporting on [leji-org/leji](https://github.com/leji-org/leji/security/advisories/new), or email security@leji.org. Please don't file public issues for vulnerabilities before a fix is available.
