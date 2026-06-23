"""Git helpers; every function degrades to None outside a git repository."""

from __future__ import annotations

import os
import subprocess
from typing import Optional


def _git(root: str, args: list[str]) -> Optional[str]:
    try:
        result = subprocess.run(
            ["git", "-C", root, *args],
            capture_output=True,
            text=True,
            check=True,
            timeout=10,  # bound each invocation; mirrors the Node/Go 10s cap
        )
        return result.stdout
    except (subprocess.CalledProcessError, OSError, subprocess.TimeoutExpired):
        return None


def git_toplevel(root: str) -> Optional[str]:
    out = _git(root, ["rev-parse", "--show-toplevel"])
    return out.strip() if out else None


def git_last_modified(root: str, rel_path: str) -> Optional[str]:
    """Last commit date (YYYY-MM-DD); None when untracked or dirty."""
    status = _git(root, ["status", "--porcelain", "--", rel_path])
    if status is None or status.strip() != "":
        return None
    out = _git(root, ["log", "-1", "--format=%cs", "--", rel_path])
    date = out.strip() if out else ""
    return date or None


def working_tree_clean(root: str) -> Optional[bool]:
    """Working-tree state for the init/adopt dirty-guard. Returns None when ``root``
    is not inside a git repository (no commit-backed undo exists, so the guard does
    not apply); True when the tree is clean; False when there are uncommitted
    changes (staged, unstaged, or untracked). The guard refuses to mutate a dirty
    tree so its writes stay cleanly reversible with ``git restore``/``git clean``."""
    top = git_toplevel(root)
    if not top:
        return None
    status = _git(top, ["status", "--porcelain", "--untracked-files=all"])
    if status is None:
        return None
    return status.strip() == ""


def git_show_head(root: str, rel_path: str) -> Optional[str]:
    """File content at HEAD; None for new files, no git, or no HEAD yet."""
    top = git_toplevel(root)
    if not top:
        return None
    # realpath both sides: on macOS /tmp is a symlink and git reports the
    # resolved toplevel, which would break the relative-path computation.
    resolved_top = os.path.realpath(top)
    resolved_file = os.path.realpath(os.path.join(root, rel_path))
    from_top = os.path.relpath(resolved_file, resolved_top).replace(os.sep, "/")
    return _git(root, ["show", f"HEAD:{from_top}"])
