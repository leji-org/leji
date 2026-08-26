#!/usr/bin/env sh
# Rule 2: the right shape without the declaration. The exception is the marker,
# not the path: an unmarked expansion is a violation however local it looks, and
# the pip half of the exception is no looser than the npm half.

bad_unmarked_wheel() {
   "$1/bin/pip" install --quiet "$TMP/pybuild/dist/$WHL_STEM.whl"
}
