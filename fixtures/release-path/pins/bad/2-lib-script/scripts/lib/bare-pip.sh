#!/usr/bin/env sh
# Rule 2: a library script installs through a venv's own pip, which is where an
# unpinned install hides once the workflows themselves are clean.

bad_install() {
   "$1/bin/pip" install --quiet twine
}
