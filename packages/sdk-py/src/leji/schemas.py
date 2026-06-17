"""Vendored schema loading and validation (JSON Schema draft 2020-12)."""

from __future__ import annotations

import json
from functools import lru_cache
from importlib.resources import files
from pathlib import Path

from jsonschema.validators import Draft202012Validator

SUPPORTED_LINES = ["1.0"]

try:
    from importlib.metadata import PackageNotFoundError, version

    SDK_VERSION = version("leji")
except PackageNotFoundError:  # running from a source tree without install
    SDK_VERSION = "0.0.0-dev"

SchemaName = (
    str  # context-manifest | context-index | context-changelog | agent-profile | decision-record
)


def _assets_dir() -> Path:
    return Path(str(files("leji").joinpath("_assets")))


def schemas_dir() -> Path:
    return _assets_dir() / "schemas"


def templates_dir() -> Path:
    return _assets_dir() / "templates"


@lru_cache(maxsize=None)
def get_validator(name: SchemaName) -> Draft202012Validator:
    schema = json.loads((schemas_dir() / f"{name}.schema.json").read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def schema_errors(name: SchemaName, data: object) -> list[str]:
    """Human-readable schema violations; [] when valid."""
    validator = get_validator(name)
    out = []
    for error in sorted(validator.iter_errors(data), key=lambda e: list(e.absolute_path)):
        where = (
            "/" + "/".join(str(p) for p in error.absolute_path) if error.absolute_path else "(root)"
        )
        out.append(f"{where} {error.message}")
    return out
