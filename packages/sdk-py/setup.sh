#!/usr/bin/env sh
# Bootstrap the sdk-py dev environment: a Python >=3.10 virtualenv (.venv) with
# the dev toolchain (ruff, mypy, pytest, coverage, build) from pyproject [dev].
# Idempotent: re-run any time to recreate the venv from scratch.
set -eu

cd "$(CDPATH= cd "$(dirname "$0")" && pwd)"

# Find a Python interpreter that satisfies requires-python (>=3.10).
PY=""
for cand in python3.13 python3.12 python3.11 python3.10 python3 python; do
   command -v "$cand" >/dev/null 2>&1 || continue
   if "$cand" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 10) else 1)' 2>/dev/null; then
      PY="$cand"
      break
   fi
done

if [ -z "$PY" ]; then
   echo "leji sdk-py: no Python >=3.10 found on PATH." >&2
   echo "  Install one, then re-run 'npm run setup:py'. For example:" >&2
   echo "    macOS:  brew install python@3.12" >&2
   echo "    other:  https://www.python.org/downloads/  (or pyenv / uv)" >&2
   exit 1
fi

echo "leji sdk-py: bootstrapping .venv with $PY ($("$PY" --version 2>&1))"
rm -rf .venv
"$PY" -m venv .venv
./.venv/bin/python -m pip install --quiet --upgrade pip
./.venv/bin/python -m pip install -e '.[dev]'
echo "leji sdk-py: .venv ready (ruff, mypy, pytest, coverage, build installed)."
