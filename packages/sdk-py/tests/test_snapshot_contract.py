"""The shared fixture is the byte contract for the snapshot helper, and these goldens
are the frozen bytes the Node reference (packages/sdk/test/snapshot-contract.test.ts)
and the Go port assert against too. The walked payload is `payload/`; the seeds and the
goldens live beside it, outside the walk, so a golden never has to contain its own
digest.

Mirrors packages/sdk/test/snapshot-contract.test.ts, including its own seed
materializer: the canary suite's is private to that module, and the reference keeps this
one local rather than reaching across suites for it.
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import pytest

from helpers.snapshot import snapshot_tree

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_DIR = REPO_ROOT / "fixtures" / "snapshot-contract"

DECLARATION = json.loads((FIXTURE_DIR / "leji-test.json").read_text(encoding="utf-8"))


def _copy_seed(src: Path, dest: Path) -> None:
    """Copy a committed seed's CONTENTS into `dest`, which this harness creates. Regular
    files and directories only, exactly as the seed convention fixes it
    (`fixtures/README.md`): a symlink anywhere inside a seed is a harness error."""
    dest.mkdir(parents=True, exist_ok=True)
    for entry in sorted(src.iterdir(), key=lambda p: p.name):
        assert not entry.is_symlink(), f"seed carries a symlink: {entry}"
        target = dest / entry.name
        if entry.is_dir():
            _copy_seed(entry, target)
        else:
            assert entry.is_file(), f"seed carries a non-regular file: {entry}"
            shutil.copy2(entry, target)


def _materialize(factory: pytest.TempPathFactory) -> Path:
    """A working copy of the fixture with everything the declaration says a walk must
    find: the declared seeds materialized as real `.git` directories, then the entries
    git cannot track (an empty directory, a symlink) created here.

    Windows: creating a symlink needs SeCreateSymbolicLinkPrivilege (Developer Mode or an
    elevated shell), which an ordinary account does not hold, and `payload/link` is one of
    the entries this contract is about, and a walk without it is not this contract. The
    Python suite runs on ubuntu-latest in CI, so nothing is lost there; a Windows
    developer gets a documented skip rather than a failure about a privilege. Line
    endings are not a second Windows hazard: `.gitattributes` disables conversion for
    every path, so the committed bytes are the checked-out bytes and the digests hold.
    """
    directory = factory.mktemp("leji-snapshot")
    shutil.copytree(FIXTURE_DIR, directory, dirs_exist_ok=True)
    for seed in DECLARATION["seeds"]:
        to_abs = directory.joinpath(*seed["to"].split("/"))
        assert not to_abs.exists(), f"seed target already exists: {seed['to']}"
        _copy_seed(directory.joinpath(*seed["from"].split("/")), to_abs)
    for rel in DECLARATION["runtime"]["directories"]:
        directory.joinpath(*rel.split("/")).mkdir(parents=True, exist_ok=True)
    for link in DECLARATION["runtime"]["symlinks"]:
        try:
            os.symlink(link["to"], directory.joinpath(*link["at"].split("/")))
        except OSError as error:  # pragma: no cover - platform-dependent
            pytest.skip(
                "this platform refuses symlink creation without privilege, and "
                f"{link['at']} is part of the contract: {error}"
            )
    return directory


def _golden(name: str) -> list[str]:
    """The frozen bytes of one golden, as the lines a walk must produce."""
    text = (FIXTURE_DIR / DECLARATION["goldens"][name]["file"]).read_text(encoding="utf-8")
    assert text.endswith("\n"), f"{name}: a golden ends with a newline"
    return text[:-1].split("\n")


def _walk(directory: Path, name: str) -> tuple[Path, Path]:
    """The walked directory and repository root one golden declares, inside a working
    copy."""
    declared = DECLARATION["goldens"][name]
    return (
        directory.joinpath(*declared["walk"].split("/")),
        directory.joinpath(*declared["repoRoot"].split("/")),
    )


def test_the_whole_repository_walk_excludes_the_repository_git_and_keeps_nested_ones(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    directory = _materialize(tmp_path_factory)
    payload, repo_root = _walk(directory, "repo")
    lines = snapshot_tree(payload, repo_root=repo_root)
    assert lines == _golden("repo"), "the walk is the frozen golden, line for line"

    # What the golden says, said again as claims, so a re-baked golden that lost one of
    # them fails here rather than passing quietly.
    assert not any(line == ".git/\tdir" or line.startswith(".git/") for line in lines), (
        "the repository .git is absent from the snapshot"
    )
    assert "pkg/.git/\tdir" in lines, "the nested .git is an entry of its own"
    assert any(line.startswith("pkg/.git/HEAD\tsha256:") for line in lines), (
        "and its contents are digested like any other file"
    )
    assert "empty/\tdir" in lines, "an empty directory is recorded, so its creation is detectable"
    assert "link\tnon-regular" in lines, "a symlink is marked, never followed"

    # The ordering is bytewise over UTF-8. Python's own string order is over code points,
    # which UTF-8 preserves, so this vector is not the trap here that it is in the Node
    # reference (where a default sort orders UTF-16 code units and puts these two the
    # other way). It is the proof that this port's order IS the goldens' order: `ｚ`
    # (EF BD 9A) before `😀` (F0 9F 98 80).
    wide = next(i for i, line in enumerate(lines) if line.startswith("ｚ.txt\t"))
    grin = next(i for i, line in enumerate(lines) if line.startswith("😀.txt\t"))
    assert wide < grin, "the wide latin z precedes the emoji, which is UTF-8 byte order"
    assert lines == sorted(lines, key=lambda line: line.encode("utf-8")), (
        "and every line is in that order"
    )


def test_repo_root_defaults_to_the_walked_directory(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    directory = _materialize(tmp_path_factory)
    payload, _ = _walk(directory, "repo")
    assert snapshot_tree(payload) == _golden("repo"), "the default is the same walk"


def test_a_subtree_walk_keeps_the_subtree_git_and_drops_it_only_when_it_is_the_repository(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    directory = _materialize(tmp_path_factory)
    pkg, repo_root = _walk(directory, "subtree")
    golden = _golden("subtree")

    # Root means the repository, not the call: `pkg/.git` is content, and the paths are
    # relative to the walked directory.
    assert snapshot_tree(pkg, repo_root=repo_root) == golden, "the frozen subtree golden"

    # The same walk claiming the subtree as the repository excludes exactly the .git
    # lines, and nothing else moves.
    own = [line for line in golden if line != ".git/\tdir" and not line.startswith(".git/")]
    assert len(own) < len(golden), "the subtree golden carries the .git lines this case removes"
    assert own, "and the walk still records the rest of the subtree"
    assert snapshot_tree(pkg, repo_root=pkg) == own, "its own .git is the one entry excluded"
