"""The one tree-snapshot contract the badge and canary suites share.

Both ask the same question of a tree (is it byte-identical to what it was?) and both
used to answer it with their own private walker, so a fix to one reached the other only
by hand. The contract lives here, is pinned by `fixtures/snapshot-contract/` (asserted
in tests/test_snapshot_contract.py), and is the same contract the Node and Go suites
hold: packages/sdk/test/helpers/snapshot.ts is the reference, and the goldens are frozen
bytes all three walk to.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path


def snapshot_tree(directory: Path, repo_root: Path | None = None) -> list[str]:
    """Every entry under `directory` as one line, so a comparison covers appearance,
    disappearance, content and entry kind:

    - regular file: ``path<TAB>sha256:<hex>``
    - directory: ``path/<TAB>dir``, an entry of its own, so a created empty directory shows
    - symlink or any other non-regular entry: ``path<TAB>non-regular``, never followed

    Paths are POSIX and relative to `directory` itself, and the lines are sorted over
    their UTF-8 BYTES, not over decoded code points, which is what Python's default
    string order is, and not over UTF-16 code units, which is what the Node reference had
    to sort away from. The three orderings have to be the one ordering the goldens carry.

    Exactly one entry is excluded: ``<repo_root>/.git``, when it lies inside `directory`.
    That one is the harness's own scaffolding, and git's background maintenance rewrites
    it under a running test. Every other `.git` (a nested package, a mount, a work
    directory) is content and is walked like anything else.

    `repo_root` means the repository, not the call. `None` defaults to `directory`, the
    whole-repository call; a subtree call passes the repository root explicitly, so
    ``snapshot_tree(pkg, repo_root=repo)`` records ``pkg/.git`` as the content it is.
    """
    # Lexical, like the Node reference's `path.resolve`: a symlinked ancestor is left
    # alone, so the walked paths and the excluded path are absolute the same way.
    root = Path(os.path.abspath(directory))
    excluded = Path(os.path.abspath(directory if repo_root is None else repo_root)) / ".git"
    lines: list[str] = []

    def walk(rel: str) -> None:
        base = root if rel == "" else root / rel
        for entry in base.iterdir():
            if entry == excluded:
                continue
            child = entry.name if rel == "" else f"{rel}/{entry.name}"
            if entry.is_symlink():
                lines.append(f"{child}\tnon-regular")
            elif entry.is_dir():
                lines.append(f"{child}/\tdir")
                walk(child)
            elif entry.is_file():
                lines.append(f"{child}\tsha256:{hashlib.sha256(entry.read_bytes()).hexdigest()}")
            else:
                lines.append(f"{child}\tnon-regular")

    walk("")
    return sorted(lines, key=lambda line: line.encode("utf-8"))
