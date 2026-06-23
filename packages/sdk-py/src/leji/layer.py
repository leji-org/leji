"""Shared layer scanning: category docs, agent profiles, decision records."""

from __future__ import annotations

import json
import posixpath
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from .findings import Finding
from .frontmatter import parse_frontmatter
from .fsx import resolved_within_root, under_path, walk_md
from .manifest import (
    CATEGORY_IDS,
    Manifest,
    effective_agent_profiles_path,
    effective_decision_records_path,
)
from .schemas import schema_errors


@dataclass
class ScannedDoc:
    rel_path: str
    category: str
    frontmatter: Optional[dict[str, Any]]
    body: str


@dataclass
class ScannedProfile:
    rel_path: str
    frontmatter: Optional[dict[str, Any]]
    findings: list[Finding] = field(default_factory=list)


def excluded_from_categories(manifest: Manifest) -> Callable[[str], bool]:
    """Files validate/index must not treat as category content."""
    profiles_dir = effective_agent_profiles_path(manifest)

    def excluded(rel_path: str) -> bool:
        if rel_path == manifest["bootProfilePath"]:
            return True
        if under_path(rel_path, profiles_dir):
            return True
        if posixpath.basename(rel_path).lower() == "readme.md":
            return True
        return False

    return excluded


def scan_categories(root: str, manifest: Manifest) -> list[ScannedDoc]:
    """Category documents; on overlap the longest declared path wins,
    manifest order breaks ties."""
    excluded = excluded_from_categories(manifest)
    by_file: dict[str, tuple[str, int]] = {}
    for category in CATEGORY_IDS:
        mapping = manifest["categories"].get(category)
        if not mapping:
            continue
        for declared in mapping["paths"]:
            for rel_path in walk_md(root, declared):
                if excluded(rel_path):
                    continue
                prev = by_file.get(rel_path)
                if prev is None or len(declared) > prev[1]:
                    by_file[rel_path] = (category, len(declared))

    docs: list[ScannedDoc] = []
    for rel_path in sorted(by_file):
        category = by_file[rel_path][0]
        text = (Path(root) / rel_path).read_text(encoding="utf-8")
        fm = parse_frontmatter(text)
        docs.append(
            ScannedDoc(rel_path=rel_path, category=category, frontmatter=fm.data, body=fm.body)
        )
    return docs


def _scan_frontmatter_artifacts(
    root: str, directory: str, schema_name: str, rule: str
) -> list[ScannedProfile]:
    out: list[ScannedProfile] = []
    for rel_path in walk_md(root, directory):
        if posixpath.basename(rel_path).lower() == "readme.md":
            continue
        text = (Path(root) / rel_path).read_text(encoding="utf-8")
        fm = parse_frontmatter(text)
        findings: list[Finding] = []
        if fm.error:
            findings.append(Finding(rule, "error", fm.error, rel_path))
        elif fm.data is None:
            findings.append(Finding(rule, "error", "missing YAML frontmatter", rel_path))
        else:
            for err in schema_errors(schema_name, fm.data):
                findings.append(Finding(rule, "error", err, rel_path))
        out.append(ScannedProfile(rel_path=rel_path, frontmatter=fm.data, findings=findings))
    return out


def scan_agent_profiles(root: str, manifest: Manifest) -> list[ScannedProfile]:
    directory = effective_agent_profiles_path(manifest)
    return _scan_frontmatter_artifacts(root, directory, "agent-profile", "profile-frontmatter")


def scan_decision_records(root: str, manifest: Manifest) -> list[ScannedProfile]:
    # Scan the declared records path and every mapped decisions path; a layer
    # may map several and valid records can live in any of them.
    dirs: list[str] = [effective_decision_records_path(manifest)]
    decisions = manifest["categories"].get("decisions")
    for p in (decisions or {}).get("paths", []):
        if p not in dirs:
            dirs.append(p)
    seen: set[str] = set()
    out: list[ScannedProfile] = []
    for directory in dirs:
        for scanned in _scan_frontmatter_artifacts(
            root, directory, "decision-record", "decision-frontmatter"
        ):
            if scanned.rel_path in seen:
                continue
            seen.add(scanned.rel_path)
            out.append(scanned)
    return out


def duplicate_id_findings(items: list[tuple[Any, str]], scope: str) -> list[Finding]:
    """Duplicate-id findings across (id, rel_path) pairs."""
    seen: dict[str, str] = {}
    findings: list[Finding] = []
    for item_id, rel_path in items:
        if not isinstance(item_id, str) or item_id == "":
            continue
        first = seen.get(item_id)
        if first is not None and first != rel_path:
            findings.append(
                Finding(
                    "id-duplicate",
                    "error",
                    f'{scope} id "{item_id}" already used by {first}',
                    rel_path,
                )
            )
        else:
            seen[item_id] = rel_path
    return findings


def read_json_artifact(root: str, rel_path: str) -> tuple[Optional[object], Optional[Finding]]:
    abs_path = Path(root) / rel_path
    if not abs_path.is_file():
        return None, None
    if not resolved_within_root(root, abs_path):
        return None, Finding(
            "artifact-parse",
            "error",
            f"artifact {rel_path} resolves outside the layer root",
            rel_path,
        )
    try:
        return json.loads(abs_path.read_text(encoding="utf-8")), None
    except json.JSONDecodeError as e:
        return None, Finding("artifact-parse", "error", f"invalid JSON: {e}", rel_path)
