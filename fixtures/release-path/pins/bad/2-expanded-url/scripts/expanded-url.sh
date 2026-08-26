#!/usr/bin/env sh
# Rule 2: a slash proves nothing. This target is a URL a variable decides, so
# what gets installed is chosen off the release path entirely.

bad_url_install() {
   "$1/bin/pip" install --quiet "$URL/tool.whl"
}
