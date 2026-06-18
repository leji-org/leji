"""Manifest (leji.json) loading and structural validation."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from .findings import Finding
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
