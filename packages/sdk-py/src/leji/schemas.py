"""Vendored schema loading and validation (JSON Schema draft 2020-12)."""

from __future__ import annotations

import json
import re
from functools import lru_cache
from importlib.resources import files
from pathlib import Path
from typing import Optional

from jsonschema.exceptions import ValidationError
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


@lru_cache(maxsize=None)
def load_cli_spec() -> dict[str, object]:
    """The canonical CLI description, single-sourced from the vendored cli.json
    (byte-identical to packages/sdk/cli.json). The terminal help renders from
    this so it cannot drift from the Node/Go SDKs or the docs site."""
    return json.loads((_assets_dir() / "cli.json").read_text(encoding="utf-8"))


def _q(value: object) -> str:
    """JSON string quoting, the same relation ``jsonenc`` reproduces in Go and
    ``JSON.stringify`` in Node: ``"``, ``\\`` and C0 controls escape, and every other
    rune is carried through as itself."""
    return json.dumps(value, ensure_ascii=False)


def _plural(limit: object, one: str, many: str = "") -> str:
    """Agree the count noun with the limit, so a bound of 1 does not read as
    "1 items". The limit is a schema constant, so the branch resolves identically in
    all three SDKs."""
    if limit == 1:
        return one
    return many or f"{one}s"


def _normalized_message(kind: str, prop: Optional[str], want: object) -> Optional[str]:
    """The Leji sentence for a violation kind, or None to fall back to the
    validator's own text.

    Three validators phrase and order the same violation differently (ajv, Go's
    santhosh-tekuri, and this one), and the parity harness compares stdout byte for
    byte, so any schema failure that reaches output has to be phrased here rather
    than passed through. The kinds covered are the ones the five shipped schemas can
    actually produce; anything else keeps the fallback, so a schema keyword added
    later degrades to un-normalized text instead of to a wrong sentence.

    The offending value never appears. A schema violation is about shape, and the
    path already tells a reader where to look; echoing authored bytes would push
    context-layer content into CI logs, pull-request comments, and the MCP tool
    response, which is exactly what the derived-surface rule
    (machine-readable-surface.md, Requirement 8) exists to prevent. Property names
    are the exception: an unexpected or missing key is the thing the reader has to
    act on, and the message is useless without it. Constraint operands come from the
    schema, not from the document, so they are always safe to name."""
    if kind == "required":
        return f"is missing required property {_q(prop)}"
    if kind == "additionalProperties":
        return f"has unexpected property {_q(prop)}; this object declares a closed set"
    # Anchored at the document root by the caller, not at the offending object: Go's
    # validator records no instance location for a property-name failure, and a
    # cross-SDK guarantee that holds in two of three is not a guarantee. The property
    # name is the actionable part; the path precision is the deliberate trade.
    if kind == "propertyNames":
        return f"has an invalid property name {_q(prop)}"
    if kind == "type":
        wants = want if isinstance(want, list) else [want]
        return "must be of type " + " or ".join(str(w) for w in wants)
    if kind == "pattern":
        return f"must match pattern {_q(want)}"
    if kind == "enum":
        return "must be one of: " + ", ".join(
            _q(w) for w in (want if isinstance(want, list) else [])
        )
    if kind == "minLength":
        return f"must be at least {want} {_plural(want, 'character')}"
    if kind == "minItems":
        return f"must have at least {want} {_plural(want, 'item')}"
    if kind == "minProperties":
        return f"must have at least {want} {_plural(want, 'property', 'properties')}"
    if kind == "minimum":
        return f"must be at least {want}"
    if kind == "maximum":
        return f"must be at most {want}"
    if kind == "uniqueItems":
        return "must not contain duplicate items"
    return None


def _extra_properties(error: ValidationError) -> list[str]:
    """The property names an ``additionalProperties: false`` object carries beyond
    what it declares. This validator reports them only inside its message text, so
    they are recomputed from the instance and the schema that judged it, which is the
    same set the other two SDKs enumerate one error at a time."""
    schema = error.schema if isinstance(error.schema, dict) else {}
    instance = error.instance if isinstance(error.instance, dict) else {}
    declared = set(schema.get("properties") or {})
    patterns = [re.compile(p) for p in (schema.get("patternProperties") or {})]
    return [k for k in instance if k not in declared and not any(p.search(k) for p in patterns)]


def _missing_properties(error: ValidationError) -> list[str]:
    """The required property names absent from the instance. This validator yields
    one error per missing property but names it only in the message, so the set is
    recomputed; the duplicate messages that produces collapse in the final dedupe."""
    required = error.schema.get("required") or [] if isinstance(error.schema, dict) else []
    instance = error.instance if isinstance(error.instance, dict) else {}
    return [p for p in required if p not in instance]


def _leaf_errors(errors: object) -> list[ValidationError]:
    """Branch failures beneath a combinator, not the combinator itself. ``anyOf`` and
    ``oneOf`` are wrappers in the same sense as ``if``: what is actually wrong is the
    per-branch failure, and this validator reports only the wrapper while the other
    two report the branches. Descending here makes all three say the branches."""
    out: list[ValidationError] = []
    for error in errors:  # type: ignore[attr-defined]
        if error.context and str(error.validator) in ("anyOf", "oneOf"):
            out.extend(_leaf_errors(error.context))
        else:
            out.append(error)
    return out


def schema_errors(name: SchemaName, data: object) -> list[str]:
    """Human-readable schema violations, phrased identically in all three SDKs; []
    when valid."""
    validator = get_validator(name)
    rendered: list[str] = []
    for error in _leaf_errors(validator.iter_errors(data)):
        path = "/" + "/".join(str(p) for p in error.absolute_path) if error.absolute_path else ""
        kind = str(error.validator) if error.validator is not None else ""
        want: object = error.validator_value
        props: list[Optional[str]] = [None]
        # A property-name failure arrives as the keyword that judged the name, with
        # the name itself as the instance; `propertyNames` in the schema path is what
        # identifies it. Reported at the root, per _normalized_message.
        if "propertyNames" in list(error.schema_path):
            kind, props, path = "propertyNames", [str(error.instance)], ""
        elif kind == "required":
            props = list(_missing_properties(error))
        elif kind == "additionalProperties":
            props = list(_extra_properties(error))
        for prop in props:
            message = _normalized_message(kind, prop, want)
            rendered.append(f"{path or '(root)'} {message or error.message}")
    # Deduplicate and order identically in all three SDKs: bytewise over the rendered
    # line. The three validators emit the same failures in different orders, and a
    # stable total order is what makes the byte comparison meaningful.
    return sorted(set(rendered))
