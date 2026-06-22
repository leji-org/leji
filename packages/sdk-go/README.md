# leji (Go)

Reference SDK and CLI for the [Leji specification](https://leji.org): the open
specification for the shared context layer of AI-native teams.

```bash
go install github.com/leji-org/leji/packages/sdk-go/cmd/leji@latest
# or build a local binary:
#   cd packages/sdk-go && go build -o leji ./cmd/leji

leji init               # bootstrap a context layer interactively
leji validate           # manifest, artifacts, frontmatter, lint rules
leji index              # generate the context index
leji index --check      # fail when the index is stale
leji changelog check    # append-only discipline
leji freshness          # review-horizon report
leji conformance        # score the layer against its claimed level
leji viewer             # generate the static viewer (viewer serve to preview, view to open)
leji detect             # find installed agent hosts
leji start              # open the layer in a detected agent host
leji adopt              # map an existing entrypoint into a context layer
leji ci                 # add a validate workflow (--provider github|gitlab|circleci|azure)
leji agent --name <n>   # bind an additional named agent into the layer
```

See the full command reference (flags, exit codes, examples) at
https://leji.org/cli/.

This is the Go reference SDK. It is behaviorally identical to the `@leji-org/leji` npm
package and the `leji` Python package: same commands, same flags, same findings,
same exit codes (0 clean, 1 findings, 2 usage error). All three implementations
are tested against one shared fixture suite under `fixtures/`; the Go SDK's
`internal/conformancetest` reproduces that contract (validate findings,
conformance scoring, and index-check staleness) for every fixture.

Supports spec line **1.0**. Schemas, templates, and `cli.json` for that line are
embedded in the binary (`go:embed`); no network access is needed at runtime.

## Build and test

```bash
cd packages/sdk-go
go build ./...     # clean build
go vet ./...       # clean
gofmt -l .         # prints nothing
go test ./...      # all green, including the shared fixtures
```

The SDK version is a build-time constant defaulting to `1.2.0`; override it with
`-ldflags "-X github.com/leji-org/leji/packages/sdk-go/internal/schemas.SDKVersion=<v>"`.

- Specification: https://leji.org
- Source: https://github.com/leji-org/leji (`packages/sdk-go`)
- License: Apache-2.0
