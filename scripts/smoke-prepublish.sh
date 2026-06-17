#!/usr/bin/env bash
# Pre-publish smoke test for the Leji reference SDKs.
#
# Builds the exact artifacts that will be published (npm tarball, PyPI wheel,
# Go binary), installs each one COLD into a throwaway sandbox, and runs the CLI
# battery end to end. It touches no registry: pack/build/dry-run only. Run it
# before cutting the release tag, because the tag is irreversible.
#
#   scripts/smoke-prepublish.sh
#
# Requires: node + npm, python3, go. (jsr step uses npx.)
#
# Host temp dirs and fresh venvs give clean isolation. For a true "clean
# machine", re-run the install+battery inside a container, e.g.:
#   docker run --rm -v "$PWD":/w -w /w node:22 \
#     bash -c 'npm i -g ./packages/sdk/leji-*.tgz && leji --version && leji validate --root examples/monorepo'
#   docker run --rm -v "$PWD":/w -w /w python:3.12 \
#     bash -c 'pip install packages/sdk-py/dist/leji-*.whl && leji --version && leji validate --root examples/monorepo'

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
EX="$ROOT/examples/monorepo"          # known-good layer
INV="$ROOT/fixtures/invalid-bad-profile"  # known-bad layer (findings -> exit 1)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$ROOT"/packages/sdk/leji-*.tgz "$ROOT"/packages/sdk-py/dist 2>/dev/null' EXIT

# Expected version, read from the canonical npm manifest. All three SDKs must
# report it (the release workflow separately checks tag == each SDK's version).
VER="$(node -p "require('$ROOT/packages/sdk/package.json').version")"

PASS=0; FAIL=0
ok(){ printf "  \033[32mPASS\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
no(){ printf "  \033[31mFAIL\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); }
# chk <expected-exit> <label> -- <cmd...>
chk(){ local exp="$1" lbl="$2"; shift 3; "$@" >/dev/null 2>&1; local got=$?; [ "$got" = "$exp" ] && ok "$lbl (exit $got)" || no "$lbl (exit $got, want $exp)"; }
_md5(){ if command -v md5sum >/dev/null 2>&1; then md5sum | awk '{print $1}'; else md5 -q; fi; }

echo "== Layer 0: assets sync + build =="
npm run assets:check >/dev/null 2>&1 && ok "assets in sync" || no "assets drift (run: npm run assets)"
npm run build -w packages/sdk >/dev/null 2>&1 && ok "JS SDK build" || no "JS SDK build"

echo "== npm artifact =="
( cd packages/sdk && npm pack >/dev/null 2>&1 )
TGZ="$(ls -t packages/sdk/leji-*.tgz 2>/dev/null | head -1)"
[ -n "$TGZ" ] && ok "npm pack -> $(basename "$TGZ")" || no "npm pack"
# grep -c (not -q) so the pipe is fully consumed: -q exits early, and with
# pipefail the upstream SIGPIPE would fail the pipeline on a successful match.
[ "$(tar tzf "$TGZ" 2>/dev/null | grep -ciE 'package/(src/|test/|\.env)')" -eq 0 ] && ok "tarball clean (no src/test/.env)" || no "tarball has stray src/test/.env"
[ "$(tar tzf "$TGZ" 2>/dev/null | grep -c 'package/cli.json')" -gt 0 ] && ok "tarball has cli.json + assets" || no "tarball missing cli.json"
NPM="$TMP/npm/bin/leji"
npm i -g --prefix "$TMP/npm" "$ROOT/$TGZ" >/dev/null 2>&1 && ok "cold install (clean prefix)" || no "cold install (npm)"
[ "$("$NPM" --version 2>/dev/null)" = "$VER" ] && ok "npm --version = $VER" || no "npm --version (want $VER)"
chk 0 "npm validate (valid layer)"   -- "$NPM" validate --root "$EX"
chk 1 "npm validate (invalid layer)" -- "$NPM" validate --root "$INV"
chk 2 "npm bogus command"            -- "$NPM" bogus

echo "== PyPI artifact =="
python3 -m venv "$TMP/pybuild" >/dev/null 2>&1
"$TMP/pybuild/bin/pip" install -q build >/dev/null 2>&1
( cd packages/sdk-py && "$TMP/pybuild/bin/python" -m build >/dev/null 2>&1 )
WHL="$(ls -t packages/sdk-py/dist/*.whl 2>/dev/null | head -1)"
[ -n "$WHL" ] && ok "wheel built -> $(basename "$WHL")" || no "wheel build"
[ "$(unzip -l "$WHL" 2>/dev/null | grep -c '_assets/schemas/')" -gt 0 ] && ok "wheel bundles schemas + templates" || no "wheel missing data files"
PY="$TMP/pyrun/bin/leji"
python3 -m venv "$TMP/pyrun" >/dev/null 2>&1
"$TMP/pyrun/bin/pip" install -q "$WHL" >/dev/null 2>&1 && ok "cold install (clean venv)" || no "cold install (venv)"
[ "$("$PY" --version 2>/dev/null)" = "$VER" ] && ok "py --version = $VER" || no "py --version (want $VER)"
chk 0 "py validate (valid layer)"   -- "$PY" validate --root "$EX"
chk 1 "py validate (invalid layer)" -- "$PY" validate --root "$INV"
chk 2 "py bogus command"            -- "$PY" bogus

echo "== Go binary =="
GO="$TMP/leji-go"
( cd packages/sdk-go && go build -o "$GO" ./cmd/leji ) >/dev/null 2>&1 && ok "go build" || no "go build"
[ "$("$GO" --version 2>/dev/null)" = "$VER" ] && ok "go --version = $VER" || no "go --version (want $VER)"
chk 0 "go validate (valid layer)"   -- "$GO" validate --root "$EX"
chk 1 "go validate (invalid layer)" -- "$GO" validate --root "$INV"
chk 2 "go bogus command"            -- "$GO" bogus

echo "== JSR (dry-run, no publish) =="
( cd packages/sdk && npx --yes jsr publish --dry-run --allow-dirty >/dev/null 2>&1 ) && ok "jsr publish --dry-run" || no "jsr publish --dry-run"

echo "== Cross-SDK parity =="
# Exit codes are part of the parity contract and are asserted per-battery above.
# A valid layer yields byte-identical --json across SDKs; a findings layer may
# differ in --json shape (the contract is path|rule|severity triples + exit,
# enforced by each SDK's suite against the fixture expected.json), so only the
# clean case is asserted byte-identical here.
J_NPM="$("$NPM" validate --root "$EX" --json 2>/dev/null | _md5)"
J_PY="$("$PY"  validate --root "$EX" --json 2>/dev/null | _md5)"
J_GO="$("$GO"  validate --root "$EX" --json 2>/dev/null | _md5)"
{ [ -n "$J_NPM" ] && [ "$J_NPM" = "$J_PY" ] && [ "$J_PY" = "$J_GO" ]; } && ok "valid-layer --json byte-identical across SDKs" || no "valid-layer --json diverges ($J_NPM / $J_PY / $J_GO)"

echo
echo "== RESULT: $PASS passed, $FAIL failed =="
if [ "$FAIL" = 0 ]; then
   echo "Pre-publish smoke GREEN. Proceed to the clean-room gate, then tag."
   exit 0
else
   echo "Pre-publish smoke RED. Do NOT tag until resolved."
   exit 1
fi
