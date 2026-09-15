"""Git helpers; every function degrades to None outside a git repository."""

from __future__ import annotations

import os
import re
import subprocess
from typing import Optional


# The only GIT_* variables a lookup that must answer for the directory it NAMED can
# safely inherit. Everything else git reads from the environment can redirect it at
# another repository or another ref store (GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR,
# GIT_NAMESPACE, GIT_OBJECT_DIRECTORY, GIT_REFERENCE_BACKEND, ...), and the list only
# grows with git, so this is an allowlist rather than a list of the known offenders:
# GIT_CEILING_DIRECTORIES can only stop the upward search, which every caller here
# already handles as "not in git", and GIT_EXEC_PATH only locates git's own helpers.
_KEPT_GIT_ENV = ("GIT_CEILING_DIRECTORIES", "GIT_EXEC_PATH")


def _env_for_named_root() -> dict[str, str]:
    """A copy of this process's environment with every GIT_* variable dropped except
    the two that cannot change which repository answers. A copy: `os.environ` itself
    is never mutated."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    for name in _KEPT_GIT_ENV:
        if name in os.environ:
            env[name] = os.environ[name]
    return env


def _git(
    root: str,
    args: list[str],
    timeout: float = 10,
    env: Optional[dict[str, str]] = None,
) -> Optional[str]:
    try:
        result = subprocess.run(
            ["git", "-C", root, *args],
            capture_output=True,
            text=True,
            check=True,
            timeout=timeout,  # bound each invocation; mirrors the Node/Go 10s cap
            # `git status` refreshes and can rewrite `.git/index`, and a promisor clone
            # can reach the network from a command documented as offline and
            # non-mutating. The mounts resolver already sets both.
            env={
                **(os.environ if env is None else env),
                "GIT_OPTIONAL_LOCKS": "0",
                "GIT_NO_LAZY_FETCH": "1",
            },
        )
        return result.stdout
    # SubprocessError covers the non-zero exit and the timeout; OSError covers git
    # being absent or the root unusable; ValueError covers an argument this cannot be
    # spelled with at all (an embedded NUL). Every caller here reads None as "git has
    # no answer", so none of them wants an exception instead.
    except (subprocess.SubprocessError, OSError, ValueError):
        return None
    # The same contract for everything else this call could raise: git has no answer.
    except Exception:
        return None


def git_origin_url(root: str) -> Optional[str]:
    """The origin remote URL, or None when not in git or no origin is configured."""
    out = _git(root, ["remote", "get-url", "origin"])
    return out.strip() if out else None


def git_short_revision(root: str, timeout: float) -> Optional[str]:
    """The seven-hex short revision of HEAD at ``root``, or None on anything else: no
    git, no repository, no commit yet, a timeout, or output that is not seven hex
    digits (git widens a short revision when seven would be ambiguous). Callers read
    None as "the revision could not be read", never as "not a checkout".

    The answer is about ``root`` and nothing else, so the environment this call runs
    with keeps no GIT_* variable that could point git somewhere else."""
    out = _git(
        root,
        ["rev-parse", "--short=7", "HEAD"],
        timeout=timeout,
        env=_env_for_named_root(),
    )
    sha = out.strip() if out else ""
    return sha if re.fullmatch(r"[0-9a-f]{7}", sha) else None


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


def tracked_under(root: str, rel: str) -> Optional[list[str]]:
    """Tracked files under a repository-relative path, or None when ``root`` is not
    in git. Backs the onboarding-workspace preflight: ``.leji/`` must hold no tracked
    files before private artifacts may land there."""
    top = git_toplevel(root)
    if not top:
        return None
    out = _git(root, ["ls-files", "--", rel])
    if out is None:
        return None
    return [s.strip() for s in out.split("\n") if s.strip()]


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
