#!/usr/bin/env sh
# Bootstrap the sdk-go dev environment. Go bundles build/test/vet/fmt and fetches
# modules on demand, so the only extra dev tool is goreleaser, used by the Go lint
# to run `goreleaser check` on .goreleaser.yaml (config is version 2, so goreleaser
# v2 is required). Idempotent: re-run any time.
set -eu

if ! command -v go >/dev/null 2>&1; then
   echo "leji sdk-go: Go not found on PATH." >&2
   echo "  Install Go 1.26.6+ from https://go.dev/dl/ (or 'brew install go'), then re-run 'npm run setup:go'." >&2
   exit 1
fi
echo "leji sdk-go: using $(go version)"

if command -v goreleaser >/dev/null 2>&1; then
   echo "leji sdk-go: goreleaser already on PATH; nothing to do."
   exit 0
fi

if command -v brew >/dev/null 2>&1; then
   echo "leji sdk-go: installing goreleaser (v2) via Homebrew..."
   brew install goreleaser
else
   echo "leji sdk-go: installing goreleaser (v2) via 'go install'..."
   go install github.com/goreleaser/goreleaser/v2@latest
   if ! command -v goreleaser >/dev/null 2>&1; then
      BINDIR="$(go env GOBIN)"; [ -n "$BINDIR" ] || BINDIR="$(go env GOPATH)/bin"
      echo "leji sdk-go: goreleaser was installed to $BINDIR, which is not on your PATH." >&2
      echo "  Add it so the Go lint can find it:  export PATH=\"$BINDIR:\$PATH\"" >&2
      exit 1
   fi
fi
echo "leji sdk-go: dev tooling ready."
