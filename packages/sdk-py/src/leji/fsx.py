"""Filesystem helpers; all returned paths are repository-root-relative POSIX."""

from __future__ import annotations

import os
from pathlib import Path


def to_posix(p: str) -> str:
    return p.replace(os.sep, "/")


def is_contained(root: str, candidate: Path) -> bool:
    """True when ``candidate``'s real path stays under ``root``'s real path.

    Resolves symlinks on both sides so a symlinked entry pointing outside the
    repository (or at /etc, the git store, etc.) is treated as escaping."""
    try:
        real_root = Path(os.path.realpath(root))
        real = Path(os.path.realpath(candidate))
    except OSError:
        return False
    return real == real_root or real.is_relative_to(real_root)


def walk_md(root: str, rel_path: str) -> list[str]:
    """Markdown files under a declared path (file or directory), sorted.

    Symlinked entries whose real path escapes the repository root are excluded;
    a local preview/index never reaches outside the repo via a symlink."""
    abs_path = Path(root) / rel_path
    if abs_path.is_file():
        if not rel_path.endswith(".md") or not is_contained(root, abs_path):
            return []
        return [to_posix(rel_path)]
    if not abs_path.is_dir():
        return []
    out: list[str] = []
    for dirpath, dirnames, filenames in os.walk(abs_path):
        dirnames[:] = [
            d
            for d in dirnames
            if not d.startswith(".")
            and d != "node_modules"
            and is_contained(root, Path(dirpath) / d)
        ]
        for name in filenames:
            if name.startswith(".") or not name.endswith(".md"):
                continue
            full = Path(dirpath) / name
            if not is_contained(root, full):
                continue
            out.append(to_posix(str(full.relative_to(root))))
    return sorted(out)


def strip_slash(p: str) -> str:
    return p[:-1] if p.endswith("/") else p


def under_path(rel_path: str, declared: str) -> bool:
    """True when rel_path is the declared path itself or falls under it."""
    base = strip_slash(declared)
    # An empty or "." root means the repository root: everything is under it.
    if base in ("", "."):
        return True
    return rel_path == base or rel_path.startswith(base + "/")
