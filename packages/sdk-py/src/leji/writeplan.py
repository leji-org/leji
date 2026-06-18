"""Write-plan model and renderer, mirroring the Node SDK's lib/writeplan.ts.

Leji writes only the files it owns and never overwrites; the plan makes that
contract visible before a single byte is written (the preview / ``--dry-run``
surface).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Optional

# The disposition of a single path in a planned operation.
PlanStatus = Literal["create", "skip-exists", "wont-modify", "overwrite"]


@dataclass
class PlannedWrite:
    """A file Leji intends to write, with its content."""

    rel: str
    content: str


@dataclass
class PlanEntry:
    """One classified path in a write plan."""

    rel: str
    status: PlanStatus
    note: Optional[str] = None


def build_write_plan(
    root_abs: str,
    writes: list[PlannedWrite],
    wont_modify: Optional[list[str]] = None,
    overwrite: Optional[list[str]] = None,
) -> list[PlanEntry]:
    """Classify each intended write against the filesystem (``create`` when
    absent, ``skip-exists`` when a path is already there and Leji refuses to
    overwrite), record foreign files Leji explicitly will not touch
    (``wont-modify``), and mark the few paths the user has explicitly consented
    to overwrite (``overwrite``, e.g. converting a vendor entrypoint to a
    redirect after migrating its content)."""
    allow_overwrite = set(overwrite or [])
    entries: list[PlanEntry] = []
    for w in writes:
        exists = (Path(root_abs) / w.rel).exists()
        if exists and w.rel in allow_overwrite:
            entries.append(
                PlanEntry(
                    rel=w.rel,
                    status="overwrite",
                    note="convert to a boot-profile redirect (content migrated first)",
                )
            )
        else:
            entries.append(PlanEntry(rel=w.rel, status="skip-exists" if exists else "create"))
    for rel in wont_modify or []:
        entries.append(
            PlanEntry(
                rel=rel,
                status="wont-modify",
                note="existing file, read-only input — Leji will not modify it",
            )
        )
    return entries


_LABEL: dict[str, str] = {
    "create": "create     ",
    "skip-exists": "skip       ",
    "wont-modify": "leave as-is",
    "overwrite": "overwrite  ",
}


def render_write_plan(entries: list[PlanEntry]) -> str:
    """Render a write plan as a human-readable preview block."""
    creates = sum(1 for e in entries if e.status == "create")
    skips = sum(1 for e in entries if e.status == "skip-exists")
    overwrites = sum(1 for e in entries if e.status == "overwrite")
    untouched = [e for e in entries if e.status == "wont-modify"]
    lines = ["Plan:"]
    for e in entries:
        if e.status == "wont-modify":
            continue
        lines.append(f"   {_LABEL[e.status]} {e.rel}")
    if untouched:
        lines.extend(["", "Will NOT modify (existing files Leji learns from, never rewrites):"])
        for e in untouched:
            lines.append(f"   {_LABEL[e.status]} {e.rel}")
    overwrite_part = f", {overwrites} to convert (with your consent)" if overwrites > 0 else ""
    lines.extend(
        [
            "",
            f"Summary: {creates} to create, {skips} already present (left untouched){overwrite_part}.",
        ]
    )
    return "\n".join(lines)
