#!/usr/bin/env sh
# The distribution gate the PyPI upload performs, run before anything is tagged.
#
# pypa/gh-action-pypi-publish runs `twine check --strict` on what it is given and
# refuses a distribution whose metadata will not render. That refusal arrives
# after the tag exists, where it cannot be corrected in place, so the same check
# runs here: in the pre-publish smoke, in the pre-push hook on the refs that lead
# to a tag, in CI, and in the release workflow immediately before the upload.
# One function, so those five callers cannot drift apart.
#
# Source it, then call:
#
#   . scripts/lib/twine-check.sh
#   twine_check <python> <src-dir> <out-dir> [existing-dist-dir]
#
# With no existing dist, it builds a wheel and an sdist from <src-dir> into
# <out-dir>/dist and checks both; with one, it checks exactly those files and
# builds nothing. The venv at <out-dir>/venv is deleted and rebuilt on every
# call. Returns twine's own exit status.
#
# Versions come from scripts/release-pins.env, where TWINE_VERSION is the twine
# the pinned publish action bundles: a rejection here is the rejection the upload
# would have produced.

# select_python: the first interpreter satisfying the SDK's requires-python floor
# (3.10); $PYTHON overrides. A stock macOS python3 is 3.9, which cannot install
# the wheel at all. Prints the interpreter, or nothing when none qualifies.
select_python() {
   for _sp_c in ${PYTHON:+"$PYTHON"} python3 python3.14 python3.13 python3.12 python3.11 python3.10; do
      command -v "$_sp_c" >/dev/null 2>&1 || continue
      if "$_sp_c" -c 'import sys; raise SystemExit(sys.version_info < (3, 10))' 2>/dev/null; then
         printf '%s\n' "$_sp_c"
         return 0
      fi
   done
   return 1
}

twine_check() {
   _tc_python="$1"
   _tc_src="$2"
   _tc_out="$3"
   _tc_dist="${4:-}"

   _tc_root="${LEJI_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
   if [ ! -f "$_tc_root/scripts/lib/release-pins.sh" ]; then
      echo "twine_check: cannot read scripts/lib/release-pins.sh" >&2
      return 2
   fi
   # shellcheck source=scripts/lib/release-pins.sh
   . "$_tc_root/scripts/lib/release-pins.sh"
   load_release_pins "$_tc_root/scripts/release-pins.env" || return 2

   # Built from nothing on every call. A venv that merely contains something
   # named twine is not evidence of the pinned twine, and this gate stands in for
   # an upload that cannot be taken back.
   _tc_venv="$_tc_out/venv"
   rm -rf "$_tc_venv"
   mkdir -p "$_tc_out" || return 2
   "$_tc_python" -m venv "$_tc_venv" >/dev/null || return 2
   "$_tc_venv/bin/pip" install --quiet --disable-pip-version-check "pip==${PIP_VERSION}" || return 2
   "$_tc_venv/bin/pip" install --quiet "build==${BUILD_VERSION}" "twine==${TWINE_VERSION}" || return 2

   if [ -n "$_tc_dist" ]; then
      set -- "$_tc_dist"/*
   else
      rm -rf "$_tc_out/dist"
      ( cd "$_tc_src" && "$_tc_venv/bin/python" -m build --outdir "$_tc_out/dist" ) || return 2
      set -- "$_tc_out/dist"/*
   fi
   if [ ! -e "$1" ]; then
      echo "twine_check: no distribution files to check" >&2
      return 2
   fi

   "$_tc_venv/bin/twine" check --strict "$@"
}
