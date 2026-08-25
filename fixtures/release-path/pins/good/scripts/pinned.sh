#!/usr/bin/env sh
# A comment may name pip install build or npm install -g npm@latest without
# installing anything; the checker reads executable lines only.

"$1/bin/pip" install --quiet "pip==${PIP_VERSION}" "build==${BUILD_VERSION}"

# The one expanded-target exception, one shape for both installers: an artifact
# this run built, rooted at $ROOT or $TMP, ending in a literal archive suffix,
# declared by the marker that closes the line. These are the smoke's three cold
# installs.
npm i -g --prefix "$2" "$ROOT/$TGZ_STEM.tgz" >/dev/null 2>&1 # release-pins: local artifact built above
npm i --prefix "$2" --offline --no-audit --no-fund "$ROOT/$CTGZ_STEM.tgz" "$ROOT/$TGZ_STEM.tgz" >/dev/null 2>&1 # release-pins: local artifact built above
"$1/bin/pip" install --quiet "$TMP/pybuild/dist/$WHL_STEM.whl" >/dev/null 2>&1 # release-pins: local artifact built above
