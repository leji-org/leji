"""Context index generation, currency checking, and serialization."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import posixpath
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from .findings import Finding
from .fsx import is_contained
from .gitutil import git_last_modified, git_toplevel
from .layer import duplicate_id_findings, read_json_artifact, scan_categories
from .manifest import Manifest
from .schemas import SDK_VERSION, SUPPORTED_LINES, schema_errors

ID_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")

ENTRY_KEY_ORDER = [
    "id",
    "path",
    "title",
    "category",
    "summary",
    "tags",
    "owners",
    "lastModified",
    "contentHash",
    "freshness",
    "links",
]


@dataclass
class IndexResult:
    index: Optional[dict]
    findings: list[Finding]
    stale: Optional[bool] = None


def _slugify(stem: str) -> str:
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", stem.lower()))


def _first_heading(body: str) -> Optional[str]:
    m = re.search(r"^#\s+(.+)$", body, re.MULTILINE)
    return m.group(1).strip() if m else None


def _content_hash(root: str, rel_path: str) -> str:
    digest = hashlib.sha256((Path(root) / rel_path).read_bytes()).hexdigest()
    return "sha256:" + digest[:16]


def _str(v: Any) -> Optional[str]:
    return v if isinstance(v, str) and v != "" else None


def _str_array(v: Any) -> Optional[list[str]]:
    if not isinstance(v, list):
        return None
    out = [x for x in v if isinstance(x, str)]
    return out or None


def declared_index_path(manifest: Manifest) -> Optional[str]:
    return (manifest.get("machine") or {}).get("indexPath")


def load_stored_index(root: str, manifest: Manifest) -> Optional[dict]:
    rel = declared_index_path(manifest)
    if not rel:
        return None
    abs_path = Path(root) / rel
    # Refuse an artifact whose real path escapes the repo root (e.g. a symlinked
    # index pointing outside the tree); a layer's index lives inside the layer.
    if not abs_path.is_file() or not is_contained(root, abs_path):
        return None
    data, _ = read_json_artifact(root, rel)
    return data if isinstance(data, dict) else None


def generate_index(root: str, manifest: Manifest) -> IndexResult:
    """Generate the context index from the tree.

    Id stability, in priority order: document frontmatter ``id``, the stored
    index's id for the same path, the stored index's id for the same
    contentHash (a pure move), then a filename slug (de-collided with the
    parent directory).
    """
    findings: list[Finding] = []
    docs = scan_categories(root, manifest)
    stored = load_stored_index(root, manifest)
    stored_by_path: dict[str, dict] = {}
    stored_by_hash: dict[str, dict] = {}
    for stored_entry in (stored or {}).get("entries", []):
        stored_by_path[stored_entry.get("path", "")] = stored_entry
        if stored_entry.get("contentHash"):
            stored_by_hash[stored_entry["contentHash"]] = stored_entry

    in_git = git_toplevel(root) is not None
    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
    used: dict[str, str] = {}
    entries: list[dict] = []

    for doc in docs:
        fm = doc.frontmatter or {}
        content_hash = _content_hash(root, doc.rel_path)
        carried = stored_by_path.get(doc.rel_path) or stored_by_hash.get(content_hash)

        entry_id = _str(fm.get("id")) or (carried or {}).get("id")
        if not entry_id:
            stem = posixpath.basename(doc.rel_path).removesuffix(".md")
            entry_id = _slugify(stem)
            if entry_id in used:
                parent = _slugify(posixpath.basename(posixpath.dirname(doc.rel_path)))
                entry_id = f"{parent}-{entry_id}" if parent else entry_id
            candidate, n = entry_id, 2
            while candidate in used:
                candidate = f"{entry_id}-{n}"
                n += 1
            entry_id = candidate
        if not ID_PATTERN.fullmatch(entry_id):
            findings.append(
                Finding(
                    "id-pattern",
                    "error",
                    f'derived id "{entry_id}" is not lowercase-hyphen',
                    doc.rel_path,
                )
            )
        if entry_id in used:
            findings.append(
                Finding(
                    "id-duplicate",
                    "error",
                    f'index id "{entry_id}" already used by {used[entry_id]}',
                    doc.rel_path,
                )
            )
        used[entry_id] = doc.rel_path

        entry: dict = {
            "id": entry_id,
            "path": doc.rel_path,
            "title": _str(fm.get("title"))
            or _first_heading(doc.body)
            or posixpath.basename(doc.rel_path).removesuffix(".md"),
            "category": doc.category,
        }
        summary = _str(fm.get("summary")) or (carried or {}).get("summary")
        if summary:
            entry["summary"] = summary
        tags = _str_array(fm.get("tags"))
        if tags:
            entry["tags"] = tags
        owners = _str_array(fm.get("owners"))
        if owners:
            entry["owners"] = owners
        entry["lastModified"] = (git_last_modified(root, doc.rel_path) if in_git else None) or today
        entry["contentHash"] = content_hash
        freshness = fm.get("freshness") or {}
        review_after = _str(freshness.get("reviewAfter")) if isinstance(freshness, dict) else None
        if review_after:
            entry["freshness"] = {"reviewAfter": review_after}
        links = _str_array(fm.get("links"))
        if links:
            entry["links"] = links
        entries.append(entry)

    index = {
        "$schema": "https://leji.org/schemas/v1.0/context-index.schema.json",
        "schemaVersion": "1.0",
        "generatedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
        "generator": {"name": "leji", "version": SDK_VERSION},
        "rootPath": manifest["rootPath"],
        "entries": entries,
    }
    return IndexResult(index=index, findings=findings)


def _comparable(entry: dict) -> dict:
    """Currency-comparison view of an entry; volatile fields excluded."""
    return {k: v for k, v in entry.items() if k != "lastModified"}


def _stable_stringify(value: object) -> str:
    """Key-order-insensitive serialization, mirrored by the Node SDK."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def check_index(root: str, manifest: Manifest) -> IndexResult:
    """Check the stored index against a regeneration.

    ``generatedAt``, ``generator``, and ``lastModified`` are excluded from the
    comparison: content drift is what ``contentHash`` catches deterministically.
    """
    rel = declared_index_path(manifest)
    findings: list[Finding] = []
    if not rel or not (Path(root) / rel).is_file() or not is_contained(root, Path(root) / rel):
        findings.append(
            Finding(
                "index-required",
                "error",
                f"declared index {rel} does not exist; run `leji index`"
                if rel
                else "no machine.indexPath declared in leji.json",
                rel or "leji.json",
            )
        )
        return IndexResult(index=None, findings=findings, stale=True)

    stored = load_stored_index(root, manifest)
    if stored is None:
        findings.append(Finding("artifact-parse", "error", "stored index is not valid JSON", rel))
        return IndexResult(index=None, findings=findings, stale=True)
    for err in schema_errors("context-index", stored):
        findings.append(Finding("artifact-schema", "error", err, rel))
    stored_version = stored.get("schemaVersion")
    if isinstance(stored_version, str) and stored_version not in SUPPORTED_LINES:
        findings.append(
            Finding(
                "schema-version",
                "error",
                f'schemaVersion "{stored_version}" is not supported by this SDK',
                rel,
            )
        )
    if findings:
        return IndexResult(index=stored, findings=findings, stale=True)

    regen = generate_index(root, manifest)
    assert regen.index is not None  # generate_index always produces an index
    want = _stable_stringify(
        {
            "rootPath": regen.index["rootPath"],
            "entries": [_comparable(e) for e in regen.index["entries"]],
        }
    )
    got = _stable_stringify(
        {
            "rootPath": stored.get("rootPath"),
            "entries": [
                _comparable(e)
                for e in sorted(stored.get("entries", []), key=lambda e: e.get("path", ""))
            ],
        }
    )
    if want != got:
        want_paths = {e["path"] for e in regen.index["entries"]}
        got_paths = {e.get("path") for e in stored.get("entries", [])}
        missing = len(want_paths - got_paths)
        extra = len(got_paths - want_paths)
        detail = (
            f" (missing: {missing}, removed: {extra})"
            if (missing or extra)
            else " (entry content drifted)"
        )
        findings.append(
            Finding(
                "index-stale",
                "error",
                f"index no longer matches the tree{detail}; run `leji index`",
                rel,
            )
        )
        return IndexResult(index=stored, findings=findings, stale=True)
    dup = duplicate_id_findings(
        [(e.get("id"), e.get("path", "")) for e in stored.get("entries", [])], "index"
    )
    return IndexResult(index=stored, findings=dup, stale=False)


def serialize_index(index: dict) -> str:
    """Stable key order, 2-space indent, trailing newline."""
    out = {
        "$schema": index.get("$schema"),
        "schemaVersion": index["schemaVersion"],
        "generatedAt": index["generatedAt"],
        "generator": index.get("generator"),
        "rootPath": index["rootPath"],
        "entries": [{key: e[key] for key in ENTRY_KEY_ORDER if key in e} for e in index["entries"]],
    }
    return json.dumps(out, indent=2, ensure_ascii=False) + "\n"


def write_index(root: str, manifest: Manifest) -> IndexResult:
    rel = declared_index_path(manifest)
    if not rel:
        return IndexResult(
            index=None,
            findings=[
                Finding(
                    "index-required",
                    "error",
                    "no machine.indexPath declared in leji.json",
                    "leji.json",
                )
            ],
        )
    result = generate_index(root, manifest)
    if result.index is not None:
        abs_path = Path(root) / rel
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        # Refuse to write the index through a path that escapes the repo root
        # (e.g. a pre-existing symlink at the index location pointing elsewhere).
        if not is_contained(root, abs_path):
            return IndexResult(
                index=result.index,
                findings=[
                    *result.findings,
                    Finding(
                        "index-required",
                        "error",
                        f"declared index {rel} resolves outside the repository root; refusing to write",
                        rel,
                    ),
                ],
            )
        abs_path.write_text(serialize_index(result.index), encoding="utf-8")
    return result
