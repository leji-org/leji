#!/usr/bin/env sh
# The one reader of scripts/release-pins.env.
#
# The file is data, but `.` executes it, and it is read by a git hook and by CI.
# So it is validated lexically first: blank lines, `#` comments, and exactly the
# expected keys, one assignment each, each value in its own shape. Anything else
# (a command, an unknown key, a second assignment, a malformed version) is an
# environment error, not a warning.
#
#   . scripts/lib/release-pins.sh
#   load_release_pins scripts/release-pins.env || exit 2
#
# On success the seven values are set in the calling shell. On failure it prints
# `release-pins.env:<line>: <what>` on stderr and returns 2.

# The expected keys, and the shape each value must have.
#   X.Y.Z   PIP_VERSION BUILD_VERSION TWINE_VERSION JSR_VERSION
#   vX.Y.Z  PYPI_PUBLISH_ACTION_VERSION GORELEASER_VERSION
#   40 hex  PYPI_PUBLISH_ACTION_SHA
load_release_pins() {
   _rp_file="$1"
   if [ ! -f "$_rp_file" ]; then
      echo "release-pins: missing $_rp_file" >&2
      return 2
   fi

   _rp_seen=""
   _rp_line=0
   _rp_bad=0
   while IFS= read -r _rp_text || [ -n "$_rp_text" ]; do
      _rp_line=$((_rp_line + 1))
      case "$_rp_text" in
         "" | "#"*) continue ;;
      esac
      _rp_key="${_rp_text%%=*}"
      _rp_val="${_rp_text#*=}"
      if [ "$_rp_key" = "$_rp_text" ]; then
         echo "release-pins.env:$_rp_line: not a KEY=value assignment: $_rp_text" >&2
         _rp_bad=1
         continue
      fi
      case " $_rp_seen " in
         *" $_rp_key "*)
            echo "release-pins.env:$_rp_line: $_rp_key is assigned twice" >&2
            _rp_bad=1
            continue
            ;;
      esac
      case "$_rp_key" in
         PIP_VERSION | BUILD_VERSION | TWINE_VERSION | JSR_VERSION) _rp_shape='^[0-9]+\.[0-9]+\.[0-9]+$' ;;
         PYPI_PUBLISH_ACTION_VERSION | GORELEASER_VERSION) _rp_shape='^v[0-9]+\.[0-9]+\.[0-9]+$' ;;
         PYPI_PUBLISH_ACTION_SHA) _rp_shape='^[0-9a-f]{40}$' ;;
         *)
            echo "release-pins.env:$_rp_line: unexpected key: $_rp_key" >&2
            _rp_bad=1
            continue
            ;;
      esac
      if ! printf '%s' "$_rp_val" | grep -Eq "$_rp_shape"; then
         echo "release-pins.env:$_rp_line: $_rp_key value does not match $_rp_shape: $_rp_val" >&2
         _rp_bad=1
         continue
      fi
      _rp_seen="$_rp_seen $_rp_key"
   done < "$_rp_file"

   for _rp_key in PIP_VERSION BUILD_VERSION TWINE_VERSION JSR_VERSION \
      PYPI_PUBLISH_ACTION_VERSION PYPI_PUBLISH_ACTION_SHA GORELEASER_VERSION; do
      case " $_rp_seen " in
         *" $_rp_key "*) ;;
         *)
            echo "release-pins.env: missing $_rp_key" >&2
            _rp_bad=1
            ;;
      esac
   done

   [ "$_rp_bad" -eq 0 ] || return 2

   # Proven to be nothing but the expected assignments.
   # shellcheck source=scripts/release-pins.env
   . "$_rp_file"
}
