#!/usr/bin/env sh
# Rule 3: the right shape without the declaration. The exception is the marker,
# not the path: an unmarked expansion is a violation however local it looks.

bad_unmarked() {
   npm i "$ROOT/x.tgz"
}
