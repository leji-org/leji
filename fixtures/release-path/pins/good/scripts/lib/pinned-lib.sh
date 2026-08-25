#!/usr/bin/env sh
# A library script under scripts/lib is scanned exactly like the rest.

good_install() {
   "$1/bin/pip" install --quiet "twine==${TWINE_VERSION}"
}
