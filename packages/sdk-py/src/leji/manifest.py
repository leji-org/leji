"""Manifest (leji.json) loading and structural validation."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, cast

from .findings import Finding
from .fsx import join_under_root, resolved_within_root
from .schemas import SUPPORTED_LINES, schema_errors

CATEGORY_IDS = ["domain", "system", "practice", "governance", "decisions"]
CONFORMANCE_LEVELS = ["core", "indexed", "governed", "federated"]
MANIFEST_FILENAME = "leji.json"

Manifest = dict[str, Any]


@dataclass
class ManifestLoad:
    manifest: Optional[Manifest]
    findings: list[Finding]


def load_manifest(root: str) -> ManifestLoad:
    """Existence, JSON parse, declared spec line, manifest schema.

    Content-level checks (paths existing, categories populated) live in
    the validate command.
    """
    abs_path = Path(root) / MANIFEST_FILENAME
    if not abs_path.is_file():
        return ManifestLoad(
            manifest=None,
            findings=[
                Finding(
                    "manifest-missing",
                    "error",
                    f"no {MANIFEST_FILENAME} at the repository root",
                    MANIFEST_FILENAME,
                )
            ],
        )
    # Confine the read: a symlinked leji.json that resolves outside the layer root
    # must not be read (an MCP exposes this read to an agent). Mirrors Node's
    # readTextWithin.
    if not resolved_within_root(str(Path(root).resolve()), abs_path):
        return ManifestLoad(
            manifest=None,
            findings=[
                Finding(
                    "manifest-parse",
                    "error",
                    f"{MANIFEST_FILENAME} resolves outside the layer root",
                    MANIFEST_FILENAME,
                )
            ],
        )
    try:
        data = json.loads(abs_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        return ManifestLoad(
            manifest=None,
            findings=[Finding("manifest-parse", "error", f"invalid JSON: {e}", MANIFEST_FILENAME)],
        )

    return validate_manifest_object(data)


_SURROGATE_RE = re.compile("[\ud800-\udfff]")


def is_scalar_string(s: str) -> bool:
    """A well-formed Unicode scalar sequence: no unpaired surrogate. A JSON parser
    accepts an escaped lone surrogate, but strict UTF-8 encoding of one raises in
    some runtimes and silently substitutes U+FFFD in others, so the same document
    would crash one implementation and produce output in another."""
    return _SURROGATE_RE.search(s) is None


def all_strings_scalar(v: object) -> bool:
    """Every string in a parsed JSON value, object keys included, is a well-formed
    Unicode scalar sequence."""
    if isinstance(v, str):
        return is_scalar_string(v)
    if isinstance(v, list):
        return all(all_strings_scalar(item) for item in v)
    if isinstance(v, dict):
        return all(
            isinstance(k, str) and is_scalar_string(k) and all_strings_scalar(val)
            for k, val in v.items()
        )
    return True


def validate_manifest_object(data: object) -> ManifestLoad:
    """Validate an already-parsed manifest object: supported spec line, then
    manifest schema. Filesystem-independent, so a caller that holds the object
    directly can validate it without writing it to disk. ``load_manifest`` calls
    this after read + parse."""
    findings: list[Finding] = []
    # Before anything reads a value: a manifest string that is not a well-formed
    # Unicode scalar sequence is refused whole, never carried into a hash, a sort,
    # or output. The message quotes nothing back — echoing the offending text is
    # exactly the outcome the check exists to prevent.
    if not all_strings_scalar(data):
        return ManifestLoad(
            manifest=None,
            findings=[
                Finding(
                    "manifest-not-scalar",
                    "error",
                    f"{MANIFEST_FILENAME} carries a string that is not a well-formed Unicode "
                    "scalar sequence (an unpaired surrogate)",
                    MANIFEST_FILENAME,
                )
            ],
        )
    line = data.get("leji") if isinstance(data, dict) else None
    if isinstance(line, str) and re.fullmatch(r"\d+\.\d+", line) and line not in SUPPORTED_LINES:
        findings.append(
            Finding(
                "manifest-line",
                "error",
                f'declared spec line "{line}" is not supported by this SDK '
                f"(supported: {', '.join(SUPPORTED_LINES)})",
                MANIFEST_FILENAME,
            )
        )
        return ManifestLoad(manifest=None, findings=findings)

    schema_violations = schema_errors("context-manifest", data)
    for err in schema_violations:
        findings.append(Finding("manifest-schema", "error", err, MANIFEST_FILENAME))
    if schema_violations:
        # The 1.2 category shape fails as a pile of raw schema text ("must NOT have
        # additional properties"), which never names the thing to change. One sentence
        # turns that into an actionable read.
        if _declares_category_paths(data):
            findings.append(
                Finding(
                    "manifest-schema",
                    "error",
                    'a category declares "paths", the 1.2 form: 1.3 categories declare '
                    '"indexes" instead (see "Migrating a 1.2 manifest" in the changelog)',
                    MANIFEST_FILENAME,
                )
            )
        return ManifestLoad(manifest=None, findings=findings)
    return ManifestLoad(manifest=cast("Manifest", data), findings=findings)


def _declares_category_paths(data: object) -> bool:
    """True when any category maps to an object carrying the removed 1.2 ``paths`` key."""
    if not isinstance(data, dict):
        return False
    cats = data.get("categories")
    if not isinstance(cats, dict):
        return False
    return any(isinstance(v, dict) and "paths" in v for v in cats.values())


def claimed_level(manifest: Manifest) -> str:
    """Effective conformance claim: absent claim is treated as core."""
    return (manifest.get("conformance") or {}).get("claimedLevel") or "core"


def level_at_least(level: str, threshold: str) -> bool:
    return CONFORMANCE_LEVELS.index(level) >= CONFORMANCE_LEVELS.index(threshold)


# Effective foundational-path resolvers. The spec (machine-readable-surface.md)
# defines default locations under rootPath for the machine surface, so tooling
# resolves an undeclared path to its default rather than failing: leji.json
# lives at the repository root; everything else defaults under rootPath/.
def effective_index_path(manifest: Manifest) -> str:
    return (manifest.get("machine") or {}).get("indexPath") or join_under_root(
        manifest["rootPath"], "context-index.json"
    )


def effective_changelog_path(manifest: Manifest) -> str:
    return (manifest.get("machine") or {}).get("changelogPath") or join_under_root(
        manifest["rootPath"], "context-changelog.json"
    )


def effective_agent_profiles_path(manifest: Manifest) -> str:
    return (manifest.get("machine") or {}).get("agentProfilesPath") or join_under_root(
        manifest["rootPath"], "agents/"
    )


def effective_decision_records_path(manifest: Manifest) -> str:
    return (manifest.get("machine") or {}).get("decisionRecordsPath") or join_under_root(
        manifest["rootPath"], "decisions/"
    )


# --- In-place manifest text edits --------------------------------------------
#
# `leji agent` (and any future post-init command that touches leji.json) edits
# the raw manifest text rather than parsing and re-serializing the whole object.
# This is deliberate: it preserves the user's field order, formatting, and any
# keys this SDK does not model, and it is the only way the three reference SDKs
# can produce byte-identical output (a generic parse + re-serialize diverges,
# e.g. Go alphabetizes map keys). The edits below assume the canonical two-space
# layout every SDK emits, and `owners` (a required key) as a stable anchor for
# inserting a new top-level key in schema position (right after `agents` would
# sit, before `owners`).


def _insert_after_marker_line(text: str, marker: str, line: str) -> str:
    """Insert ``line`` (already indented) as the first member directly after the
    line that opens ``marker`` (e.g. ``"agents": {`` or ``"vendorAdapters": [``).
    Prepending sidesteps fixing up the previous last member's trailing comma."""
    at = text.find(marker)
    if at < 0:
        raise RuntimeError(f"leji.json: cannot locate {marker!r} to anchor the edit")
    nl = text.find("\n", at)
    if nl < 0:
        raise RuntimeError(f"leji.json: malformed {marker!r} block")
    return text[: nl + 1] + line + "\n" + text[nl + 1 :]


def _insert_before_owners(text: str, lines: list[str]) -> str:
    """Insert a multi-line top-level block immediately before the ``owners`` key,
    so a newly created ``agents`` key lands in schema position."""
    anchor = '\n  "owners":'
    at = text.find(anchor)
    if at < 0:
        raise RuntimeError('leji.json: cannot locate the "owners" key to anchor the edit')
    return text[: at + 1] + "\n".join(lines) + "\n" + text[at + 1 :]


def bind_agent_in_manifest_text(text: str, name: str, profile_rel: str) -> tuple[str, bool]:
    """Bind a named agent to its profile path in the manifest's ``agents`` map.
    Creates the map (before ``owners``) when absent, otherwise prepends the
    entry. Idempotent: an already-bound name leaves the text untouched."""
    agents = json.loads(text).get("agents")
    if isinstance(agents, dict) and name in agents:
        return text, False
    entry = f'"{name}": "{profile_rel}"'
    if not agents:
        return _insert_before_owners(text, ['  "agents": {', f"    {entry}", "  },"]), True
    return _insert_after_marker_line(text, '"agents": {', f"    {entry},"), True


# --- The mount pin span -------------------------------------------------------
#
# `leji mounts update-pin` moves one declared pin. The agent edits above anchor on
# the canonical two-space layout, which the manifest schema does not require, so a
# pin move gets a lexical scanner instead: it walks the document as JSON tokens,
# finds ``federation.mounts[i]`` whose ``name`` equals the addressed mount, and
# returns the byte span of THAT object's ``pin`` string value. Only that span is
# replaced. Nothing is reserialized or normalized, so field order, indentation,
# line endings, escapes, unmodeled keys, and every other byte of the file survive
# untouched.


class PinScanError(Exception):
    """A lexical failure: the document is not shaped the way a manifest is. Callers
    turn it into the same "cannot locate" refusal as a missing mount, because both
    mean the same thing operationally -- this text has no such pin to move."""


class PinAmbiguityError(Exception):
    """A duplicate key on the path to the pin. JSON does not forbid one, and the two
    readers of this document disagree about which wins: a lexical scan takes the
    FIRST member, ``json.loads`` keeps the LAST. So a manifest carrying two ``pin``
    keys on the addressed mount could have its first span rewritten while the pin
    every parser reads stays exactly as it was -- a reported change that changed
    nothing. The scanner refuses that document instead of picking a winner, and this
    error carries its own message out rather than collapsing into "cannot locate"."""


@dataclass
class _Member:
    """One object member: its decoded key, and the index its value begins at."""

    key: str
    value_at: int


@dataclass
class _ScannedString:
    """One JSON string: its decoded value (escapes resolved, for comparison only)
    and the span of its RAW contents between the quotes, which is the only thing an
    edit ever replaces."""

    value: str
    content_start: int
    end: int


_HEX4_RE = re.compile(r"[0-9a-fA-F]{4}")
_JSON_WS = " \t\n\r"
_JSON_VALUE_STOP = " \t\n\r,}]"


def _quoted(s: str) -> str:
    """A JSON string literal, the way Node's ``JSON.stringify`` spells one: the
    non-ASCII characters a mount name may carry stay themselves."""
    return json.dumps(s, ensure_ascii=False)


def _unique_member(members: list[_Member], key: str, where: str) -> Optional[_Member]:
    """The one member named ``key``, or None when there is none. Two or more is
    refused: every key this scanner reads sits on the path to the pin, so an
    ambiguous one makes the whole edit ambiguous."""
    matches = [m for m in members if m.key == key]
    if len(matches) > 1:
        raise PinAmbiguityError(f"duplicate key {_quoted(key)} {where}")
    return matches[0] if matches else None


def _skip_json_ws(text: str, i: int) -> int:
    """Index of the first character at or after ``i`` that is not JSON whitespace."""
    while i < len(text) and text[i] in _JSON_WS:
        i += 1
    return i


def _scan_json_string(text: str, i: int) -> _ScannedString:
    """One JSON string starting at the opening quote."""
    if i >= len(text) or text[i] != '"':
        raise PinScanError("expected a string")
    content_start = i + 1
    out: list[str] = []
    saw_surrogate = False
    j = content_start
    n = len(text)
    while j < n:
        c = text[j]
        if c == '"':
            value = "".join(out)
            if saw_surrogate:
                # Code units are appended as they come: a surrogate PAIR spelled as
                # two escapes reassembles into its astral character by the same rule
                # the parser uses, so an escaped name compares equal to a raw one.
                value = value.encode("utf-16-le", "surrogatepass").decode(
                    "utf-16-le", "surrogatepass"
                )
            return _ScannedString(value=value, content_start=content_start, end=j + 1)
        if c != "\\":
            out.append(c)
            j += 1
            continue
        esc = text[j + 1] if j + 1 < n else ""
        j += 2
        if esc in ('"', "\\", "/"):
            out.append(esc)
        elif esc == "b":
            out.append("\b")
        elif esc == "f":
            out.append("\f")
        elif esc == "n":
            out.append("\n")
        elif esc == "r":
            out.append("\r")
        elif esc == "t":
            out.append("\t")
        elif esc == "u":
            hex_digits = text[j : j + 4]
            if _HEX4_RE.fullmatch(hex_digits) is None:
                raise PinScanError("malformed \\u escape")
            code = int(hex_digits, 16)
            saw_surrogate = saw_surrogate or 0xD800 <= code <= 0xDFFF
            out.append(chr(code))
            j += 4
        else:
            raise PinScanError("unknown escape")
    raise PinScanError("unterminated string")


def _skip_json_value(text: str, i: int) -> int:
    """Index just past the value beginning at ``i``, whatever it is. Objects and
    arrays are skipped STRUCTURALLY (nesting counted through their own members), so
    a ``pin`` key inside some unrelated nested object is never mistaken for a
    mount's."""
    i = _skip_json_ws(text, i)
    c = text[i] if i < len(text) else ""
    if c == '"':
        return _scan_json_string(text, i).end
    if c in ("{", "["):
        close = "}" if c == "{" else "]"
        j = i + 1
        while True:
            j = _skip_json_ws(text, j)
            if j >= len(text):
                raise PinScanError("unterminated container")
            if text[j] == close:
                return j + 1
            if text[j] in (",", ":"):
                j += 1
                continue
            j = _skip_json_value(text, j)
    # A literal or a number: everything up to the next structural character.
    j = i
    while j < len(text) and text[j] not in _JSON_VALUE_STOP:
        j += 1
    if j == i:
        raise PinScanError("expected a value")
    return j


def _json_members(text: str, i: int) -> tuple[list[_Member], int]:
    """Each member of the object beginning at ``i``, as (decoded key, index of its
    value); plus the index just past the object."""
    i = _skip_json_ws(text, i)
    if i >= len(text) or text[i] != "{":
        raise PinScanError("expected an object")
    members: list[_Member] = []
    j = i + 1
    while True:
        j = _skip_json_ws(text, j)
        if j >= len(text):
            raise PinScanError("unterminated object")
        if text[j] == "}":
            return members, j + 1
        if text[j] == ",":
            j += 1
            continue
        key = _scan_json_string(text, j)
        j = _skip_json_ws(text, key.end)
        if j >= len(text) or text[j] != ":":
            raise PinScanError('expected ":"')
        value_at = _skip_json_ws(text, j + 1)
        members.append(_Member(key=key.value, value_at=value_at))
        j = _skip_json_value(text, value_at)


def _find_mount_pin_span(text: str, name: str) -> Optional[tuple[str, int, int]]:
    """The raw span of ``federation.mounts[i].pin`` for the mount named ``name``, as
    (current value, content start, content end). None when no such mount, or no
    ``pin`` on it."""
    root_members, _ = _json_members(text, 0)
    federation = _unique_member(root_members, "federation", "in the manifest root")
    if federation is None:
        return None
    federation_members, _ = _json_members(text, federation.value_at)
    mounts_key = _unique_member(federation_members, "mounts", 'in "federation"')
    if mounts_key is None:
        return None
    i = _skip_json_ws(text, mounts_key.value_at)
    if i >= len(text) or text[i] != "[":
        raise PinScanError("expected an array")
    i += 1
    while True:
        i = _skip_json_ws(text, i)
        if i >= len(text):
            raise PinScanError("unterminated array")
        if text[i] == "]":
            return None
        if text[i] == ",":
            i += 1
            continue
        if text[i] != "{":
            i = _skip_json_value(text, i)
            continue
        entry_members, entry_end = _json_members(text, i)
        # A mount whose own name is ambiguous cannot be told apart from the addressed
        # one, so the document is refused before any element is matched.
        name_member = _unique_member(entry_members, "name", "in a federation mount")
        if (
            name_member is not None
            and text[name_member.value_at] == '"'
            and _scan_json_string(text, name_member.value_at).value == name
        ):
            pin_member = _unique_member(entry_members, "pin", f"in mount {_quoted(name)}")
            if pin_member is None:
                return None
            if text[pin_member.value_at] != '"':
                raise PinScanError("pin is not a string")
            pin = _scan_json_string(text, pin_member.value_at)
            return pin.value, pin.content_start, pin.end - 1
        i = entry_end


def replace_mount_pin_in_manifest_text(
    text: str, name: str, from_pin: str, to_pin: str
) -> tuple[str, bool]:
    """Move one declared mount's pin, in place. ``from_pin`` is what the span must
    currently hold -- the value the comparison was computed against -- so a manifest
    that moved underneath the run is refused rather than overwritten. Everything
    outside the pin value's own bytes is returned exactly as it came in.

    Raises when the pin cannot be located, or holds something other than
    ``from_pin``. Both are internal refusals after the manifest has already parsed
    and validated."""
    try:
        span = _find_mount_pin_span(text, name)
    except PinAmbiguityError as e:
        # An ambiguous document is refused on its own terms; a merely malformed one
        # is the same answer as a mount that is not there.
        raise RuntimeError(f"{MANIFEST_FILENAME}: {e}") from e
    except PinScanError:
        span = None
    if span is None:
        raise RuntimeError(f"{MANIFEST_FILENAME}: cannot locate the pin of mount {_quoted(name)}")
    value, content_start, content_end = span
    if value != from_pin:
        raise RuntimeError(
            f"{MANIFEST_FILENAME}: pin of mount {_quoted(name)} is not {_quoted(from_pin)}"
        )
    if from_pin == to_pin:
        return text, False
    return text[:content_start] + to_pin + text[content_end:], True
