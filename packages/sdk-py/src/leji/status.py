"""Informational health report: unindexed, dangling, and stale documents."""

from __future__ import annotations

import posixpath
from dataclasses import dataclass, field

from .fsx import join_under_root, strip_slash, under_path, walk_tree
from .indexgen import load_stored_index
from .layer import resolve_category_assignments_with_skips
from .mounts import SelfProjection, self_projection
from .manifest import (
    CATEGORY_IDS,
    Manifest,
    effective_agent_profiles_path,
    effective_changelog_path,
    effective_index_path,
)


@dataclass
class DanglingEntry:
    index_file: str
    detail: str


@dataclass
class ShadowedSelector:
    """A broad index selector whose every covered document was won by more-specific
    selectors: dead weight in the curated index, surfaced but never an error."""

    index_file: str
    path: str


@dataclass
class StatusReport:
    """Informational health report for a context layer. Non-failing: it surfaces
    what a maintainer should look at, it does not gate."""

    unindexed: list[str] = field(default_factory=list)
    dangling: list[DanglingEntry] = field(default_factory=list)
    stale: list[str] = field(default_factory=list)
    # Governed paths not yet in the stored index (or all of them when no stored
    # index exists): the machine contract is behind the tree; run `leji index`.
    pending: list[str] = field(default_factory=list)
    # Selectors fully displaced by more-specific selectors.
    shadowed: list[ShadowedSelector] = field(default_factory=list)
    # READMEs inside listed directories that expansion skipped and no explicit
    # selector governs: the carve-out surfaced, never silent.
    skipped_readmes: list[ShadowedSelector] = field(default_factory=list)
    # Would this layer, at HEAD, project completely if a host mounted it? Judged
    # against the object store, so it sees what a host's hydrate would see --
    # including a bound profile that exists on disk but is untracked. Report-only.
    projection: SelfProjection = field(default_factory=lambda: SelfProjection(state="no-commit"))


def _is_chrome(manifest: Manifest, rel: str) -> bool:
    """Chrome files that are never category content, so never "unindexed"."""
    profiles_dir = effective_agent_profiles_path(manifest)
    index_files: set[str] = set()
    for c in CATEGORY_IDS:
        for f in (manifest["categories"].get(c) or {}).get("indexes", []):
            index_files.add(f)
    overview_rel = join_under_root(manifest["rootPath"], "overview.md")
    sidebar_rel = join_under_root(manifest["rootPath"], "_sidebar.md")
    return (
        rel == manifest["bootProfilePath"]
        or under_path(rel, profiles_dir)
        or rel in index_files
        or rel == overview_rel
        or rel == sidebar_rel
        or rel == effective_index_path(manifest)
        or rel == effective_changelog_path(manifest)
        or posixpath.basename(rel).lower() == "readme.md"
    )


def status_report(root: str, manifest: Manifest) -> StatusReport:
    """Build the status report: unindexed reference docs, dangling index entries,
    stale stored-index paths, and shadowed selectors. Pure computation; the CLI
    renders and decides exit."""
    assignments, findings, shadowed_pairs, skipped_pairs = resolve_category_assignments_with_skips(
        root, manifest
    )
    governed = set(assignments.keys())

    root_dir = strip_slash(manifest["rootPath"]) or "."
    unindexed = sorted(
        rel
        for rel in walk_tree(root, root_dir)
        if rel not in governed and not _is_chrome(manifest, rel)
    )

    dangling = [
        DanglingEntry(index_file=f.path or "", detail=f.message)
        for f in findings
        if f.rule
        in (
            "index-file-missing",
            "index-entry-missing",
            "index-entry-not-markdown",
            # Parse-level problems include invalid or escaping entry paths
            # (`../x.md`, absolute, backslash); surface them so `status --strict`
            # fails on an entry that would otherwise be flagged nowhere else.
            "index-file-parse",
        )
    ]

    stored = load_stored_index(root, manifest)
    stale = sorted(
        e.get("path") for e in (stored or {}).get("entries", []) if e.get("path") not in governed
    )

    # The symmetric drift direction: governed on disk, absent from the stored
    # index (all governed paths when the index has never been generated).
    stored_paths = {e.get("path") for e in (stored or {}).get("entries", [])}
    pending = sorted(p for p in governed if p not in stored_paths)

    shadowed = sorted(
        (ShadowedSelector(index_file=index_rel, path=path) for index_rel, path in shadowed_pairs),
        key=lambda s: (s.index_file, s.path),
    )

    skipped_readmes = sorted(
        (ShadowedSelector(index_file=index_rel, path=path) for index_rel, path in skipped_pairs),
        key=lambda s: (s.index_file, s.path),
    )

    return StatusReport(
        unindexed=unindexed,
        dangling=dangling,
        stale=stale,
        pending=pending,
        shadowed=shadowed,
        skipped_readmes=skipped_readmes,
        projection=self_projection(root),
    )
