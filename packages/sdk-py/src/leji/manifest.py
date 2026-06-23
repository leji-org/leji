"""Manifest (leji.json) loading and structural validation."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from .findings import Finding
from .fsx import resolved_within_root
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

    findings: list[Finding] = []
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
        return ManifestLoad(manifest=None, findings=findings)
    return ManifestLoad(manifest=data, findings=findings)


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
    return (manifest.get("machine") or {}).get(
        "indexPath"
    ) or f"{manifest['rootPath']}context-index.json"


def effective_changelog_path(manifest: Manifest) -> str:
    return (manifest.get("machine") or {}).get("changelogPath") or (
        f"{manifest['rootPath']}context-changelog.json"
    )


def effective_agent_profiles_path(manifest: Manifest) -> str:
    return (manifest.get("machine") or {}).get(
        "agentProfilesPath"
    ) or f"{manifest['rootPath']}agents/"


def effective_decision_records_path(manifest: Manifest) -> str:
    return (manifest.get("machine") or {}).get(
        "decisionRecordsPath"
    ) or f"{manifest['rootPath']}decisions/"


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
    so a newly created ``agents`` / ``vendorAdapters`` key lands in schema
    position."""
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


def declare_vendor_adapter_in_manifest_text(text: str, adapter: str) -> tuple[str, bool]:
    """Declare a vendor adapter path in the manifest's ``vendorAdapters`` array.
    Creates the array (before ``owners``) when absent, otherwise prepends the
    entry. Idempotent: an already-declared path leaves the text untouched."""
    arr = json.loads(text).get("vendorAdapters")
    if isinstance(arr, list) and adapter in arr:
        return text, False
    entry = f'"{adapter}"'
    if not isinstance(arr, list):
        return _insert_before_owners(text, ['  "vendorAdapters": [', f"    {entry}", "  ],"]), True
    return _insert_after_marker_line(text, '"vendorAdapters": [', f"    {entry},"), True
