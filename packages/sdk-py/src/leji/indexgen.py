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
from .fsx import is_contained, resolved_within_root
from .gitutil import git_last_modified, git_toplevel
from .layer import duplicate_id_findings, read_json_artifact, scan_categories
from .manifest import Manifest, effective_index_path
from .schemas import SDK_VERSION, SUPPORTED_LINES, schema_errors

ID_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")

ENTRY_KEY_ORDER = [
    "id",
    "path",
    "title",
    "category",
    "kind",
    "date",
    "summary",
    "tags",
    "owners",
    "lastModified",
    "contentHash",
    "freshness",
    "links",
]

MOUNT_KEY_ORDER = ["path", "name", "owner", "role", "categories", "topics", "requiredWhen"]

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


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


def load_stored_index(root: str, manifest: Manifest) -> Optional[dict]:
    rel = effective_index_path(manifest)
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
    scan = scan_categories(root, manifest)
    findings.extend(scan.findings)
    docs = scan.docs
    stored = load_stored_index(root, manifest)
    stored_by_path: dict[str, dict] = {}
    # Carry an id by content-hash only when that hash maps to exactly one stored
    # entry: two byte-identical documents share a hash, so a hash-carry there would
    # misattribute one document's id to the other on a move.
    hash_entries: dict[str, list[dict]] = {}
    for stored_entry in (stored or {}).get("entries", []):
        stored_by_path[stored_entry.get("path", "")] = stored_entry
        if stored_entry.get("contentHash"):
            hash_entries.setdefault(stored_entry["contentHash"], []).append(stored_entry)
    stored_by_hash: dict[str, dict] = {
        h: arr[0] for h, arr in hash_entries.items() if len(arr) == 1
    }

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
            "kind": doc.kind,
        }
        if doc.kind == "record":
            # A record's date comes only from explicit, valid frontmatter; nothing
            # is scraped from prose or filename conventions.
            date = _str(fm.get("date"))
            if date and _DATE.fullmatch(date):
                entry["date"] = date
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

    # Id churn: a stored id whose path is gone and that did not reappear at a new path
    # vanished (a document moved AND edited with no frontmatter id mints a fresh slug).
    # Inbound references to the old id now dangle; warn so it is caught, not silent.
    new_ids = {e["id"] for e in entries}
    current_paths = {d.rel_path for d in docs}
    for stored_entry in (stored or {}).get("entries", []):
        p = stored_entry.get("path", "")
        sid = stored_entry.get("id", "")
        if p not in current_paths and sid not in new_ids:
            findings.append(
                Finding(
                    "id-vanished",
                    "warning",
                    f'stored id "{sid}" (was {p}) did not reappear; references to it now dangle. '
                    "Declare a frontmatter id to keep ids stable across moves.",
                    p,
                )
            )

    mounts: list[dict] = []
    federation = manifest.get("federation") or {}
    for mt in federation.get("mounts") or []:
        rec: dict = {"name": mt["name"], "source": mt["source"], "pin": mt["pin"]}
        if mt.get("trackingRef"):
            rec["trackingRef"] = mt["trackingRef"]
        rec["owner"] = mt["owner"]
        if mt.get("role"):
            rec["role"] = mt["role"]
        if mt.get("categories"):
            rec["categories"] = mt["categories"]
        if mt.get("topics"):
            rec["topics"] = mt["topics"]
        if mt.get("requiredWhen"):
            rec["requiredWhen"] = mt["requiredWhen"]
        mounts.append(rec)

    index = {
        "$schema": "https://leji.org/schemas/v1.0/context-index.schema.json",
        "schemaVersion": "1.0",
        "generatedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
        "generator": {"name": "leji", "version": SDK_VERSION},
        "rootPath": manifest["rootPath"],
        "entries": entries,
    }
    if mounts:
        index["mounts"] = mounts
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
    rel = effective_index_path(manifest)
    findings: list[Finding] = []
    if not (Path(root) / rel).is_file():
        findings.append(
            Finding(
                "index-required",
                "error",
                f"index {rel} does not exist; run `leji index`",
                rel,
            )
        )
        return IndexResult(index=None, findings=findings, stale=True)
    if not is_contained(root, Path(root) / rel):
        findings.append(
            Finding(
                "artifact-parse", "error", f"artifact {rel} resolves outside the layer root", rel
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
    # A regeneration that itself errors (missing/malformed index file, a
    # category-conflict, a dangling entry) means the tree cannot be indexed
    # cleanly, so the stored index cannot be current: fail rather than compare a
    # partial regen against it and falsely pass.
    regen_errors = [f for f in regen.findings if f.severity == "error"]
    if regen_errors:
        findings.extend(regen_errors)
        return IndexResult(index=stored, findings=findings, stale=True)
    want = _stable_stringify(
        {
            "rootPath": regen.index["rootPath"],
            "entries": [_comparable(e) for e in regen.index["entries"]],
            "mounts": regen.index.get("mounts", []),
        }
    )
    got = _stable_stringify(
        {
            "rootPath": stored.get("rootPath"),
            "entries": [
                _comparable(e)
                for e in sorted(stored.get("entries", []), key=lambda e: e.get("path", ""))
            ],
            "mounts": stored.get("mounts", []),
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
    return IndexResult(index=stored, findings=[*regen.findings, *dup], stale=False)


def _ordered_mount(m: dict) -> dict:
    out: dict = {}
    for key in MOUNT_KEY_ORDER:
        if key not in m:
            continue
        if key == "owner":
            owner = m["owner"]
            owner_out = {"name": owner["name"]}
            if owner.get("contact") is not None:
                owner_out["contact"] = owner["contact"]
            out["owner"] = owner_out
        else:
            out[key] = m[key]
    return out


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
    if index.get("mounts"):
        out["mounts"] = [_ordered_mount(m) for m in index["mounts"]]
    return json.dumps(out, indent=2, ensure_ascii=False) + "\n"


def write_index(root: str, manifest: Manifest) -> IndexResult:
    rel = effective_index_path(manifest)
    result = generate_index(root, manifest)
    # Refuse to write a partial or incorrect index when generation hit a hard
    # error (e.g. category-conflict, index-file-parse, a dangling entry): writing
    # would persist a half-correct artifact that later reads trust.
    if any(f.severity == "error" for f in result.findings):
        return result
    if result.index is not None:
        abs_path = Path(root) / rel
        # Contain before creating any directory: resolved_within_root resolves the
        # nearest existing ancestor, so a symlinked ancestor of this not-yet-existing
        # target is caught before mkdir/write can escape the layer root.
        if not resolved_within_root(root, abs_path):
            return IndexResult(
                index=result.index,
                findings=[
                    *result.findings,
                    Finding(
                        "artifact-parse",
                        "error",
                        f"index path {rel} resolves outside the layer root",
                        rel,
                    ),
                ],
            )
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        abs_path.write_text(serialize_index(result.index), encoding="utf-8")
    return result
