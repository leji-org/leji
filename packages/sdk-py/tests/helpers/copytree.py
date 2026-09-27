"""The test suites' tree copy, shared so every copy leaves out the same entries."""

import shutil
from pathlib import Path


def copy_tree(src: Path, dest: Path, dirs_exist_ok: bool = False) -> None:
    """Copy `src` to `dest`, leaving out every entry named `.leji`.

    A local `leji view` leaves its gitignored viewer build in the working tree, and a
    copy that carried it would change what the export, viewer, and conformance tests see.
    """
    shutil.copytree(src, dest, ignore=shutil.ignore_patterns(".leji"), dirs_exist_ok=dirs_exist_ok)
