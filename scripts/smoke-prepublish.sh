#!/usr/bin/env bash
# Pre-publish smoke test for the Leji reference SDKs.
#
# Builds the exact publishable artifacts (npm tarball, PyPI wheel, Go binary),
# cold-installs each into a throwaway sandbox, and runs the CLI battery end to end.
# Touches no registry (pack/build/dry-run only). Run before tagging (tags are final).
#
#   scripts/smoke-prepublish.sh
#
# Requires: node + npm, git, python3 (>= 3.10; the release series is 3.12), go,
# tar, gzip, unzip, and Docker. (The jsr step uses npx.) Every one of them is
# probed before anything is built, because a tool discovered late reads as an
# artifact failure. Docker is a release machine prerequisite: without it the Node
# 22 leg is skipped, and the final line says so.
#
# Environment:
#   CI=true          untracked or ignored files on the paths this run reads are
#                    a failure rather than a warning (a runner checkout has none)
#   REQUIRE_DOCKER=1 the Node 22 leg is mandatory: no Docker is a failure, never
#                    a skip. Set by the workflows on the release path.
#   SKIP_DOCKER=1    the Node 22 leg is deliberately not run (the lighter
#                    pull-request rehearsal). Overrides REQUIRE_DOCKER.
#   PYTHON=<path>    the interpreter to run the PyPI battery with.
#
# Host temp dirs and fresh venvs give clean isolation. For a true "clean
# machine", re-run the install+battery inside a container, e.g.:
#   docker run --rm -v "$PWD":/w -w /w node:22 \
#     bash -c 'npm i -g ./packages/sdk/leji-*.tgz && leji --version && leji validate --root examples/monorepo'
#   python -m build --outdir dist packages/sdk-py   # this run builds into a temp dir
#   docker run --rm -v "$PWD":/w -w /w python:3.12 \
#     bash -c 'pip install dist/leji-*.whl && leji --version && leji validate --root examples/monorepo'

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
EX="$ROOT/examples/monorepo"          # known-good layer
INV="$ROOT/fixtures/invalid-bad-profile"  # known-bad layer (findings -> exit 1)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$ROOT"/packages/sdk/leji-*.tgz "$ROOT"/packages/create-leji/create-leji-*.tgz 2>/dev/null' EXIT

# The distribution gate the PyPI upload performs, shared with the pre-push hook,
# CI, and the release workflow so the five callers cannot drift apart. It reads
# the pin tuple from LEJI_ROOT, which is already resolved here.
LEJI_ROOT="$ROOT"
# shellcheck source=scripts/lib/twine-check.sh
. "$ROOT/scripts/lib/twine-check.sh"

# Expected version, read from the canonical npm manifest. All three SDKs must
# report it (the release workflow separately checks tag == each SDK's version).
VER="$(node -p "require('$ROOT/packages/sdk/package.json').version")"

# Python for the PyPI battery: the wheel's requires-python is >=3.10, and a stock
# macOS python3 is 3.9 (pip then refuses the wheel and the whole battery 127s).
PYBIN="$(select_python)"
[ -n "$PYBIN" ] || PYBIN=python3   # nothing suitable found; the battery will fail visibly below

PASS=0; FAIL=0
ok(){ printf "  \033[32mPASS\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
no(){ printf "  \033[31mFAIL\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); }
# chk <expected-exit> <label> -- <cmd...>
chk(){ local exp="$1" lbl="$2"; shift 3; "$@" >/dev/null 2>&1; local got=$?; [ "$got" = "$exp" ] && ok "$lbl (exit $got)" || no "$lbl (exit $got, want $exp)"; }
_md5(){ if command -v md5sum >/dev/null 2>&1; then md5sum | awk '{print $1}'; else md5 -q; fi; }
# The `command` field of a scaffold --json document, read from stdin.
_jsoncmd(){ node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).command' 2>/dev/null; }

echo "== Prerequisites: the tools this run must not discover late =="
# A missing unzip, a stopped Docker daemon, or a Python below the wheel's floor
# surfaces as a battery failure that says nothing about the artifacts, several
# minutes after the run began. Each is named here instead, before anything is
# built, and a missing one ends the run rather than colouring a later line red.
MISSING=""
for _tool in bash node npm git tar gzip unzip go; do
   command -v "$_tool" >/dev/null 2>&1 || MISSING="$MISSING $_tool"
done
# Not merely a Python: the wheel declares requires-python >= 3.10 and the release
# workflows install 3.12, so a runner on another series would rehearse a
# toolchain the tag does not publish through. Locally any supported series runs,
# and the version is printed either way.
PY_RELEASE_SERIES="3.12"   # mirrors python-version in the release workflows
PYVER="$("$PYBIN" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null)"
if [ -z "$PYVER" ]; then
   MISSING="$MISSING python3(>=3.10)"
elif [ "${CI:-}" = "true" ] && [ "${PYVER%.*}" != "$PY_RELEASE_SERIES" ]; then
   MISSING="$MISSING python$PY_RELEASE_SERIES(found $PYVER)"
fi
# An absent docker binary and a daemon that will not answer read the same here:
# the floor leg needs a working docker either way. What differs is the
# consequence, and the caller says which it wants.
N22_SKIPPED=0
N22_SKIP_WHY=""
if [ "${SKIP_DOCKER:-}" = "1" ]; then
   N22_SKIPPED=1
   N22_SKIP_WHY="SKIP_DOCKER=1"
elif ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
   if [ "${REQUIRE_DOCKER:-}" = "1" ]; then
      MISSING="$MISSING docker(daemon)"
   else
      N22_SKIPPED=1
      N22_SKIP_WHY="docker not found"
   fi
fi
if [ -n "$MISSING" ]; then
   echo "  missing:$MISSING"
   echo
   echo "== RESULT: prerequisites missing =="
   echo "Pre-publish smoke RED. Do NOT tag until resolved."
   exit 1
fi
DOCKER_STATE="daemon reachable"
[ "$N22_SKIPPED" = 1 ] && DOCKER_STATE="node 22 leg skipped ($N22_SKIP_WHY)"
ok "prerequisites (node $(node -v), python $PYVER, $(go env GOVERSION), tar, gzip, unzip; docker: $DOCKER_STATE)"

echo "== Clean inputs: stale output cleared, nothing untracked on the paths read =="
# Outputs first. A stale dist directory or a tarball left by an earlier run is an
# input to the packing steps below, and nothing downstream would notice it is
# old: the build writes over what it produces now and leaves the rest in place.
# The incremental build state goes with the output it describes - tsc reads it,
# decides the deleted files are current, and reports success having written
# nothing - which is also why a clean checkout, carrying neither, is the case
# this run has to behave like.
# Both commands are checked, and so is what survives them: a read-only tree, a
# directory whose parent denies writes, a file another process holds - each ends
# with the run building against exactly the stale output this step exists to
# remove, and none of them announces itself. So an incomplete clean stops the run
# here rather than colouring a packing result red several minutes later.
CLEAN_FAILED=""
rm -rf "$ROOT"/packages/*/dist "$ROOT"/.cache/tsc 2>/dev/null || CLEAN_FAILED="dist + tsc build state"
rm -f "$ROOT"/packages/sdk/leji-*.tgz "$ROOT"/packages/create-leji/create-leji-*.tgz 2>/dev/null \
   || CLEAN_FAILED="$CLEAN_FAILED packed tarballs"
LEFTOVER="$(ls -d "$ROOT"/packages/*/dist "$ROOT"/.cache/tsc "$ROOT"/packages/sdk/leji-*.tgz \
   "$ROOT"/packages/create-leji/create-leji-*.tgz 2>/dev/null)"
if [ -z "$CLEAN_FAILED" ] && [ -z "$LEFTOVER" ]; then
   ok "stale build output cleared (packages/*/dist, tsc build state, packed tarballs)"
else
   no "stale build output not cleared${CLEAN_FAILED:+ (failed: $CLEAN_FAILED)}"
   [ -n "$LEFTOVER" ] && printf '%s\n' "$LEFTOVER" | sed "s|^$ROOT/|       still present: |"
   echo
   echo "== RESULT: $PASS passed, $FAIL failed =="
   echo "Pre-publish smoke RED. Do NOT tag until resolved."
   exit 1
fi
# Then the sources. `--others` with no exclusion list is deliberate: a file that
# git ignores is exactly as absent from a fresh clone as one that was never
# added, and either one changes what this run builds from what the tag will.
DIRTY="$(git -C "$ROOT" ls-files --others -- spec schemas templates fixtures 'packages/*/src' packages/sdk-go 2>/dev/null)"
if [ -z "$DIRTY" ]; then
   ok "input paths carry no untracked or ignored file"
elif [ "${CI:-}" = "true" ]; then
   no "untracked or ignored files under the paths this run reads"
   printf '%s\n' "$DIRTY" | sed 's/^/       /'
else
   printf "  \033[33mWARN\033[0m %s\n" "untracked or ignored files under the paths this run reads (CI refuses them)"
   printf '%s\n' "$DIRTY" | sed 's/^/       /'
fi

echo "== Layer 0: version coherence + assets sync + release pins + build =="
# All 9 version locations must agree before we build artifacts that bake the
# version in; a drifting Go SDKVersion would otherwise ship mismatched.
npm run version:check >/dev/null 2>&1 && ok "version coherent ($VER)" || no "version drift (run: npm run version:set <x>)"
# Every install on the release path names an exact version: the tag must publish
# through the toolchain this run rehearsed, not through whatever moved since.
sh "$ROOT/scripts/check-release-pins.sh" >/dev/null 2>&1 && ok "release-path pins exact" || no "release-path pins (run: sh scripts/check-release-pins.sh)"
npm run assets:check >/dev/null 2>&1 && ok "assets in sync" || no "assets drift (run: npm run assets)"
npm run build -w packages/sdk >/dev/null 2>&1 && ok "JS SDK build" || no "JS SDK build"

echo "== npm artifact =="
( cd packages/sdk && npm pack >/dev/null 2>&1 )
TGZ="$(ls -t packages/sdk/leji-*.tgz 2>/dev/null | head -1)"
TGZ_STEM="${TGZ%.tgz}"   # so the install target below ends in .tgz, visibly
[ -n "$TGZ" ] && ok "npm pack -> $(basename "$TGZ")" || no "npm pack"
# grep -c (not -q) so the pipe is fully consumed: -q exits early, and with
# pipefail the upstream SIGPIPE would fail the pipeline on a successful match.
[ "$(tar tzf "$TGZ" 2>/dev/null | grep -ciE 'package/(src/|test/|\.env)')" -eq 0 ] && ok "tarball clean (no src/test/.env)" || no "tarball has stray src/test/.env"
[ "$(tar tzf "$TGZ" 2>/dev/null | grep -c 'package/cli.json')" -gt 0 ] && ok "tarball has cli.json + assets" || no "tarball missing cli.json"
NPM="$TMP/npm/bin/leji"
npm i -g --prefix "$TMP/npm" "$ROOT/$TGZ_STEM.tgz" >/dev/null 2>&1 && ok "cold install (clean prefix)" || no "cold install (npm)" # release-pins: local artifact built above
[ "$("$NPM" --version 2>/dev/null)" = "$VER" ] && ok "npm --version = $VER" || no "npm --version (want $VER)"
chk 0 "npm validate (valid layer)"   -- "$NPM" validate --root "$EX"
chk 1 "npm validate (invalid layer)" -- "$NPM" validate --root "$INV"
chk 2 "npm bogus command"            -- "$NPM" bogus

echo "== create-leji (cold, offline) =="
# `npm create leji` is the first command a new adopter runs, and it is the one path
# where two published packages must resolve each other. Both tarballs go into one
# dependency graph under --offline, so a resolution that would have reached the
# registry fails here instead of on an adopter's machine: what is being proved is
# that create-leji's `@leji-org/leji` range is satisfied by the SDK built alongside
# it, at this version. The npm cache is the shared one on purpose - the SDK's own
# runtime dependencies (ajv, yaml) have to come from somewhere, and a throwaway
# cache turns the leg into an ENOTCACHED failure that says nothing about Leji.
( cd packages/create-leji && npm pack >/dev/null 2>&1 )
CTGZ="$(ls -t packages/create-leji/create-leji-*.tgz 2>/dev/null | head -1)"
CTGZ_STEM="${CTGZ%.tgz}"   # as above: the target reads as a tarball, not a name
[ -n "$CTGZ" ] && ok "npm pack -> $(basename "$CTGZ")" || no "npm pack (create-leji)"
[ "$(tar tzf "$CTGZ" 2>/dev/null | grep -c 'package/index.js')" -gt 0 ] && ok "tarball has the router" || no "tarball missing index.js"
CRE="$TMP/create"
mkdir -p "$CRE"
npm i --prefix "$CRE" --offline --no-audit --no-fund "$ROOT/$CTGZ_STEM.tgz" "$ROOT/$TGZ_STEM.tgz" >/dev/null 2>&1 \
   && ok "cold install (both tarballs, offline)" || no "cold install (create-leji + SDK, offline)" # release-pins: local artifact built above
CBIN="$CRE/node_modules/.bin/create-leji"
CVER="$(node -p "require('$CRE/node_modules/@leji-org/leji/package.json').version" 2>/dev/null)"
[ "$CVER" = "$VER" ] && ok "create-leji resolves @leji-org/leji $VER (no registry)" || no "create-leji resolved @leji-org/leji '$CVER' (want $VER)"
mkdir -p "$TMP/new-repo" "$TMP/existing-repo/docs"
[ "$("$CBIN" "$TMP/new-repo" --yes --dry-run --json 2>/dev/null | _jsoncmd)" = "init" ] && ok "empty directory -> leji init" || no "empty directory did not route to init"
[ "$("$CBIN" "$TMP/existing-repo" --yes --dry-run --json 2>/dev/null | _jsoncmd)" = "adopt" ] && ok "docs/ directory -> leji adopt" || no "docs/ directory did not route to adopt"

echo "== Node 22 (published-package floor) =="
# create-leji and @leji-org/mcp publish `engines.node >=22`, and every layer above
# runs on whatever node the release machine has (24). A floor nothing ever
# executes is a claim, so the tarballs this run built are installed into a Node 22
# container and driven there: the CLI, the router, and the MCP server, on the
# oldest runtime the packages say they accept. The image names an exact patch for
# the reason every other install on this path does - 22.23.2 is the current 22.x
# LTS patch on Docker Hub, verified 2026-08-24. Unlike the create-leji layer this
# one cannot be --offline: a fresh container has no npm cache, so the third-party
# dependencies (ajv, yaml, the MCP SDK) come from the registry. The three Leji
# packages never do, and the resolved SDK version is asserted below to prove it.
N22_OUT=""
# One marker line per check, so a container that half-ran cannot read as a pass.
n22_has() { printf '%s\n' "$N22_OUT" | grep -qF -- "$1"; }
if [ "$N22_SKIPPED" = 1 ]; then
   # Decided in the prerequisite probe above, where a missing daemon is either a
   # failure or a skip depending on what the caller asked for. What a release
   # machine looks for is one line it cannot miss.
   echo "SKIP node 22 leg ($N22_SKIP_WHY)"
else
   # The MCP tarball is built and packed here rather than in layer 0: it is the
   # only artifact this leg adds, and nothing above it needs one.
   npm run build -w packages/mcp >/dev/null 2>&1 && ok "MCP server build" || no "MCP server build"
   mkdir -p "$TMP/n22"
   ( cd packages/mcp && npm pack --pack-destination "$TMP/n22" >/dev/null 2>&1 )
   MTGZ="$(ls -t "$TMP/n22"/leji-org-mcp-*.tgz 2>/dev/null | head -1)"
   [ -n "$MTGZ" ] && ok "npm pack -> $(basename "$MTGZ")" || no "npm pack (mcp)"
   # Fixed names under the mount, so the install targets inside the container are
   # literal paths a reader and the pin checker can both see, not expansions of a
   # version that moves every release.
   cp "$MTGZ" "$TMP/n22/mcp.tgz" 2>/dev/null
   cp "$ROOT/$TGZ_STEM.tgz" "$TMP/n22/sdk.tgz"
   cp "$ROOT/$CTGZ_STEM.tgz" "$TMP/n22/create-leji.tgz"
   # The MCP server speaks JSON-RPC over stdio and nothing else, so its smoke is a
   # real session: initialize, then validate_layer over the mounted example layer.
   # stdin reaching EOF closes the transport, which is how the process exits.
   printf '%s\n' \
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"leji-smoke","version":"1"}}}' \
      '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"validate_layer","arguments":{"root":"/layer"}}}' \
      > "$TMP/n22/mcp-session.jsonl"
   # Both mounts are read-only: the container installs into its own /usr/local and
   # writes nothing back into the temp tree this run cleans up.
   N22_OUT="$(docker run --rm -v "$TMP/n22":/w:ro -v "$EX":/layer:ro -w /w node:22.23.2-bookworm bash -c '
set -u
mkdir -p /tmp/n22-repo
echo "n22-node $(node -v)"
npm i -g --no-audit --no-fund /w/sdk.tgz /w/create-leji.tgz /w/mcp.tgz >/dev/null 2>&1 && echo "n22-install ok" || { echo "n22-install FAILED"; exit 1; }
echo "n22-resolved $(node -p "require(\"$(npm root -g)/@leji-org/leji/package.json\").version")"
echo "n22-leji $(leji --version)"
echo "n22-validate $(leji validate --root /layer >/dev/null 2>&1; echo $?)"
echo "n22-create $(create-leji /tmp/n22-repo --yes --dry-run --json | node -pe "JSON.parse(require(\"fs\").readFileSync(0,\"utf8\")).command")"
echo "n22-mcp $(leji-mcp < /w/mcp-session.jsonl 2>/dev/null | tail -1 | grep -c "\"ok\":true")"
' 2>&1)" || printf '%s\n' "$N22_OUT" | sed -n '1,20p'
   n22_has "n22-node v22." && ok "node 22: the container runs Node 22" || no "node 22: container is not Node 22"
   n22_has "n22-install ok" && ok "node 22: cold install (SDK + create-leji + MCP tarballs)" || no "node 22: cold install"
   n22_has "n22-resolved $VER" && ok "node 22: create-leji and MCP resolve @leji-org/leji $VER" || no "node 22: @leji-org/leji resolved to something other than $VER"
   n22_has "n22-leji $VER" && ok "node 22: leji --version = $VER" || no "node 22: leji --version (want $VER)"
   n22_has "n22-validate 0" && ok "node 22: leji validate (valid layer, exit 0)" || no "node 22: leji validate (valid layer)"
   n22_has "n22-create init" && ok "node 22: create-leji routes an empty directory to init" || no "node 22: create-leji routing"
   n22_has "n22-mcp 1" && ok "node 22: MCP server answers validate_layer over stdio" || no "node 22: MCP server session"
fi

echo "== PyPI artifact =="
# The wheel and the sdist are built and checked by the same function the publish
# action's twine stands behind: a distribution that will not render is refused
# here, not after the tag. The wheel it produces feeds the cold install below.
if twine_check "$PYBIN" "$ROOT/packages/sdk-py" "$TMP/pybuild" >"$TMP/twine.log" 2>&1; then
   ok "twine check --strict (wheel + sdist)"
else
   no "twine check --strict (wheel + sdist)"
   sed -n '1,20p' "$TMP/twine.log"
fi
# And the gate is proven able to fail: an unrenderable distribution goes through
# the same function, which must reject it. Its content is tracked, reviewable
# text under fixtures/release-path/twine-reject - a PKG-INFO declaring
# text/x-rst beside a long description docutils refuses - and only the archive
# around it is generated, so nothing on this path is a binary nobody can read in
# a diff. It is archived by Python rather than by tar because every field tar
# fills in from the machine is a field that makes the archive differ between two
# runs: the format, the ownership, the names, the modes, the member order, and
# both timestamps are written explicitly here, so the same sources yield the same
# bytes on any platform and in any timezone. Same interpreter as the battery.
REJ_SRC="$ROOT/fixtures/release-path/twine-reject"
REJ_TGZ="$TMP/reject-dist/leji-invalid-0.0.0.tar.gz"
mkdir -p "$TMP/reject-dist"
"$PYBIN" - "$REJ_SRC" "$REJ_TGZ" leji-invalid-0.0.0 <<'PY'
import gzip, io, os, sys, tarfile

src, out, prefix = sys.argv[1], sys.argv[2], sys.argv[3]
members = ("PKG-INFO", "README.rst")   # fixed order, not a directory listing
with gzip.GzipFile(out, "wb", mtime=0) as gz:
    with tarfile.open(fileobj=gz, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for name in members:
            with open(os.path.join(src, name), "rb") as fh:
                data = fh.read()
            info = tarfile.TarInfo(prefix + "/" + name)
            info.type = tarfile.REGTYPE
            info.size = len(data)
            info.mtime = 0
            info.mode = 0o644
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            tar.addfile(info, io.BytesIO(data))
PY
# What was built is verified before it is judged. An archive that never got
# written, or got written without its metadata, would still be refused - for a
# reason that says nothing about the gate this line exists to prove.
REJ_MEMBERS="$(tar tzf "$REJ_TGZ" 2>/dev/null | tr '\n' ' ')"
if [ "$REJ_MEMBERS" = "leji-invalid-0.0.0/PKG-INFO leji-invalid-0.0.0/README.rst " ]; then
   ok "invalid sdist built from the tracked sources (PKG-INFO + README.rst)"
else
   no "invalid sdist not built as expected (members: ${REJ_MEMBERS:-none})"
fi
# And the rejection is asserted, never inferred from a non-zero exit. A generator
# that failed leaves an empty directory, and twine_check refuses an empty
# directory too; so does a venv that would not build or an install that could not
# reach the index. Each of those is an infrastructure failure of this smoke and
# is reported as one: the gate counts as fired only on twine's own refusal, which
# is status 1 carrying the diagnostic. The log is squeezed to one line first,
# because twine wraps that sentence at the console width.
if [ ! -s "$REJ_TGZ" ]; then
   no "invalid sdist could not be generated; the rejection cannot be asserted"
else
   twine_check "$PYBIN" "$ROOT/packages/sdk-py" "$TMP/pybuild" "$TMP/reject-dist" > "$TMP/reject.log" 2>&1
   REJ_STATUS=$?
   if [ "$REJ_STATUS" = 0 ]; then
      no "invalid sdist passed twine check --strict"
   elif [ "$REJ_STATUS" = 1 ] && tr -s '[:space:]' ' ' < "$TMP/reject.log" | grep -q 'long_description` has syntax errors in markup'; then
      ok "invalid sdist rejected by twine check --strict (unrenderable long_description)"
   else
      no "invalid sdist: infrastructure failure of the smoke, not a rejection (exit $REJ_STATUS)"
      sed -n '1,20p' "$TMP/reject.log"
   fi
fi
WHL="$(ls -t "$TMP/pybuild/dist"/*.whl 2>/dev/null | head -1)"
WHL_NAME="$(basename "$WHL" 2>/dev/null)"
WHL_STEM="${WHL_NAME%.whl}"   # so the install target below ends in .whl, visibly
[ -n "$WHL" ] && ok "wheel built -> $WHL_NAME" || no "wheel build"
[ "$(unzip -l "$WHL" 2>/dev/null | grep -c '_assets/schemas/')" -gt 0 ] && ok "wheel bundles schemas + templates" || no "wheel missing data files"
PY="$TMP/pyrun/bin/leji"
"$PYBIN" -m venv "$TMP/pyrun" >/dev/null 2>&1
# The wheel this run built, installed from the temp directory it was built into.
# The path is spelled out and ends in .whl so the target is visibly a local
# artifact rather than a name an index resolves; the marker declares it, and the
# pin checker counts every line that carries one.
"$TMP/pyrun/bin/pip" install -q "$TMP/pybuild/dist/$WHL_STEM.whl" >/dev/null 2>&1 && ok "cold install (clean venv)" || no "cold install (venv)" # release-pins: local artifact built above
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
( cd packages/sdk && npx --yes jsr@0.14.3 publish --dry-run --allow-dirty >/dev/null 2>&1 ) && ok "jsr publish --dry-run" || no "jsr publish --dry-run"

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
   # A skipped floor leg is carried into the verdict line: a release machine that
   # reads a plain GREEN must be one where the floor actually ran.
   if [ "$N22_SKIPPED" = 1 ]; then
      echo "Pre-publish smoke GREEN (node 22 leg skipped: $N22_SKIP_WHY)."
   else
      echo "Pre-publish smoke GREEN."
   fi
   exit 0
else
   echo "Pre-publish smoke RED. Do NOT tag until resolved."
   exit 1
fi
