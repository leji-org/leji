#!/usr/bin/env sh
# Rule 3: marked, rooted, and still refused. The target ends in a variable, so
# nothing in this text says it is an archive: only a literal suffix does. The
# fix is to spell the suffix out, as the smoke does.

bad_var_tail() {
   npm i -g "$ROOT/$TGZ" >/dev/null 2>&1 # release-pins: local artifact built above
}
