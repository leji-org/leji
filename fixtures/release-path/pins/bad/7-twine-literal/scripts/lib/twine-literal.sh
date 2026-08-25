#!/usr/bin/env sh
# Rule 7: exactly pinned, so rule 2 is satisfied, and still wrong: the version
# is a literal that no longer matches the tuple in scripts/release-pins.env.

bad_twine() {
   "$1/bin/pip" install --quiet "twine==6.1.0"
}
