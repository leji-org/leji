#!/usr/bin/env sh
# Rule 2: a glob installs whatever happens to match at the time, which is one
# stale artifact away from publishing the wrong bytes.

bad_glob() {
   "$1/bin/pip" install --quiet ./wheels/*.whl
}
