"""Changelog compaction, mirroring the Node SDK's changelog command."""

from __future__ import annotations

import datetime as dt
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .findings import Finding
from .fsx import resolved_within_root
from .layer import read_json_artifact
from .manifest import Manifest, claimed_level, effective_changelog_path, level_at_least


@dataclass
class CompactResult:
    findings: list[Finding]
    folded: int  # entries folded into the compaction entry (0 = no-op)
    kept: int  # surviving non-compaction entries plus the new compaction entry
    path: str  # effective changelog path operated on


# Schema field order for a serialized changelog entry, mirrored by the Node SDK.
ENTRY_KEY_ORDER = [
    "id",
    "date",
    "type",
    "summary",
    "paths",
    "categories",
    "decisionRefs",
    "proposedBy",
    "approvedBy",
    "breaking",
    "compacted",
]


def _date_id_key(entry: dict) -> tuple[str, str]:
    """Canonical changelog order (machine-readable-surface.md req 3): ascending
    by ``date``, then ``id`` as the tiebreak. ``date`` is UTC, so a lexical
    compare is chronological; ``id`` is unique, so the pair is a total order."""
    return (str(entry.get("date") or ""), str(entry.get("id") or ""))


def _ordered_entry(entry: dict) -> dict:
    out: dict = {}
    for key in ENTRY_KEY_ORDER:
        if entry.get(key) is not None:
            out[key] = entry[key]
    # Preserve any extra keys (deterministic order) rather than dropping data.
    for key in sorted(entry):
        if key not in out and entry.get(key) is not None:
            out[key] = entry[key]
    return out


def serialize_changelog(log: dict) -> str:
    """Stable key order, 2-space indent, trailing newline."""
    out: dict = {}
    if log.get("$schema") is not None:
        out["$schema"] = log["$schema"]
    out["schemaVersion"] = log.get("schemaVersion") or "1.0"
    for key in sorted(log):
        if key in ("$schema", "schemaVersion", "entries"):
            continue
        out[key] = log[key]
    out["entries"] = [_ordered_entry(e) for e in log["entries"]]
    return json.dumps(out, indent=2, ensure_ascii=False) + "\n"


def _today() -> str:
    return dt.datetime.now(dt.timezone.utc).date().isoformat()


def seed_changelog_if_missing(root: str, manifest: Manifest) -> Optional[str]:
    """Seed the machine changelog if the layer claims ``indexed`` (or higher) and
    the file is missing. The changelog is an indexed-level surface, so ``leji init``
    only writes it at that level; this lets ``leji index`` complete the indexed
    surface for a layer that claimed indexed after the fact (e.g. an upgrade from
    core). Returns the seeded path, or ``None`` when nothing was written (not
    indexed, already present, or a symlink would escape the root). Never
    overwrites an existing changelog."""
    if not level_at_least(claimed_level(manifest), "indexed"):
        return None
    rel = effective_changelog_path(manifest)
    abs_path = Path(root) / rel
    if abs_path.is_file() or not resolved_within_root(root, abs_path):
        return None
    log = {
        "$schema": "https://leji.org/schemas/v1.0/context-changelog.schema.json",
        "schemaVersion": "1.0",
        "entries": [
            {
                "id": "seed-changelog",
                "date": _today(),
                "type": "added",
                "summary": "Started the machine changelog for the indexed level.",
                "paths": [rel],
                "proposedBy": "leji index",
                "approvedBy": manifest["owners"]["primary"]["name"],
            }
        ],
    }
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    abs_path.write_text(serialize_changelog(log), encoding="utf-8")
    return rel


def compact_changelog(
    root: str,
    manifest: Manifest,
    keep: Optional[int] = None,
    before: Optional[str] = None,
) -> CompactResult:
    """Compact the oldest entries of the changelog.

    An entry folds iff every ACTIVE flag marks it foldable: ``keep`` ⇒ its
    canonical index is older than the newest ``keep`` entries; ``before`` ⇒ its
    date is strictly before ``before``. Inactive flags are neutral. Because both
    predicates select a prefix of the canonical (date, id) order, the folded set
    is always a contiguous run from the oldest end, exactly what the append-only
    rule requires. The folded entries are dropped and a single ``compaction``
    entry is appended, recording the count and the id range it removed. Surviving
    entries keep their original array order.
    """
    rel = effective_changelog_path(manifest)
    # Validate options at the API level too (the CLI also checks --keep): SDK
    # callers must not be able to fold with keep < 1 or a malformed `before` date.
    if keep is not None and (not isinstance(keep, int) or isinstance(keep, bool) or keep < 1):
        return CompactResult(
            findings=[Finding("invalid-argument", "error", "keep must be a positive integer", rel)],
            folded=0,
            kept=0,
            path=rel,
        )
    if before is not None and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", before):
        return CompactResult(
            findings=[
                Finding("invalid-argument", "error", "before must be a YYYY-MM-DD date", rel)
            ],
            folded=0,
            kept=0,
            path=rel,
        )
    data, parse_finding = read_json_artifact(root, rel)
    if parse_finding:
        return CompactResult(findings=[parse_finding], folded=0, kept=0, path=rel)
    if data is None:
        return CompactResult(
            findings=[
                Finding("changelog-required", "error", f"changelog {rel} does not exist", rel)
            ],
            folded=0,
            kept=0,
            path=rel,
        )
    log = data if isinstance(data, dict) else {}
    raw_entries = log.get("entries")
    original: list[dict] = (
        [e for e in raw_entries if isinstance(e, dict)] if isinstance(raw_entries, list) else []
    )

    # Canonical order decides which entries are "oldest"; the index of each entry
    # in that order drives the `keep` predicate.
    canonical = sorted(original, key=_date_id_key)
    canonical_index = {id(e): i for i, e in enumerate(canonical)}

    def fold_by_keep(e: dict) -> bool:
        return keep is None or canonical_index[id(e)] < len(canonical) - keep

    def fold_by_before(e: dict) -> bool:
        return before is None or str(e.get("date") or "") < before

    folded = [e for e in canonical if fold_by_keep(e) and fold_by_before(e)]

    if not folded:
        return CompactResult(findings=[], folded=0, kept=len(original), path=rel)

    folded_ids = {id(e) for e in folded}
    survivors = [e for e in original if id(e) not in folded_ids]

    oldest, newest = folded[0], folded[-1]
    paths_union = sorted(
        {p for e in folded for p in (e.get("paths") or []) if isinstance(e.get("paths"), list)}
    )

    # De-dupe the compaction id against existing ids (-2, -3, …).
    existing_ids = {e.get("id") for e in original}
    entry_id = f"compaction-{_today()}"
    if entry_id in existing_ids:
        n = 2
        while f"{entry_id}-{n}" in existing_ids:
            n += 1
        entry_id = f"{entry_id}-{n}"

    n_folded = len(folded)
    compaction = {
        "id": entry_id,
        "date": _today(),
        "type": "compaction",
        "summary": f"Compacted {n_folded} {'entry' if n_folded == 1 else 'entries'} "
        f"({oldest.get('date')} through {newest.get('date')}).",
        "paths": paths_union if paths_union else [rel],
        "compacted": {
            "entries": n_folded,
            "firstId": str(oldest.get("id") or ""),
            "lastId": str(newest.get("id") or ""),
        },
    }

    nxt = {**log, "entries": [*survivors, compaction]}

    abs_path = Path(root) / rel
    if not resolved_within_root(root, abs_path):
        return CompactResult(
            findings=[
                Finding(
                    "artifact-parse",
                    "error",
                    f"changelog path {rel} resolves outside the layer root",
                    rel,
                )
            ],
            folded=0,
            kept=len(original),
            path=rel,
        )
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    abs_path.write_text(serialize_changelog(nxt), encoding="utf-8")

    return CompactResult(findings=[], folded=n_folded, kept=len(nxt["entries"]), path=rel)
