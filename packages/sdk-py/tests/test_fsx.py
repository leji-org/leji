"""The write boundary at its own level: the strict within-root primitive, the rule
``guarded_write`` applies through every convenience, and the verified read that
decides what is standing at a target before anything acts on it. The canary suite
pins the same rule through the commands; these pin the mechanism, so a port has a
per-case oracle rather than an end-to-end one.

Mirrors packages/sdk/test/fsx.test.ts.
"""

from __future__ import annotations

import os
import socket
from pathlib import Path

import pytest

from leji.fsx import (
    guard_root,
    mkdirp_guarded,
    open_write_guarded,
    rename_guarded,
    resolved_within_root,
    rm_guarded,
    verified_target_read,
    write_file_atomic_guarded,
    write_file_guarded,
)
from leji.layout import DIST_REL, WORK_REL


def _repo(factory: pytest.TempPathFactory) -> Path:
    """A temp repository root, realpath-resolved (macOS hands out /var -> /private/var)."""
    return Path(os.path.realpath(factory.mktemp("leji-fsx")))


def _outside(factory: pytest.TempPathFactory) -> Path:
    """A destination outside any repository, for the escape cases."""
    return Path(os.path.realpath(factory.mktemp("leji-outside")))


# --- the strict within-root primitive ----------------------------------------


def test_resolved_within_root_existing_absent_dangling_escaping_case_variant(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    root = _repo(tmp_path_factory)
    (root / "file.md").write_text("x\n", encoding="utf-8")
    assert resolved_within_root(str(root), root / "file.md"), "an existing file inside root"
    assert resolved_within_root(str(root), root / "not-yet" / "file.md"), "a not-yet-created target"

    away = _outside(tmp_path_factory)
    (root / "dangling.md").symlink_to(away / "gone.md")
    assert not resolved_within_root(str(root), root / "dangling.md"), "a dangling link out of root"

    (away / "real.md").write_text("x\n", encoding="utf-8")
    (root / "escape.md").symlink_to(away / "real.md")
    assert not resolved_within_root(str(root), root / "escape.md"), "a link resolving out of root"

    (root / "dir").mkdir()
    (root / "dir" / "up").symlink_to(away)
    assert not resolved_within_root(str(root), root / "dir" / "up" / "new.md"), (
        "a symlinked ancestor"
    )

    # A `.LEJI/` spelling on a case-insensitive filesystem resolves to the directory
    # the filesystem actually holds, which is what the `.leji/` rule then judges.
    (root / ".leji" / "dist").mkdir(parents=True)
    if (root / ".LEJI").exists():
        verdict = write_file_guarded(str(root), str(root / ".LEJI" / "dist" / "x.html"), None, "x")
        assert not verdict.ok, "a .LEJI/ spelling is judged as the .leji/ role it opens"
        assert verdict.role == "dist"


def test_resolved_within_root_unreadable_directory_is_unresolvable(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    if hasattr(os, "getuid") and os.getuid() == 0:
        pytest.skip("running as root: a 0o000 directory is still traversable")
    root = _repo(tmp_path_factory)
    closed = root / "closed"
    closed.mkdir()
    (closed / "target.md").write_text("x\n", encoding="utf-8")
    closed.chmod(0o000)
    try:
        # os.path.exists, not Path.exists: this must answer False on EACCES rather
        # than raising, exactly as the reference SDK's existsSync does.
        if os.path.exists(closed / "target.md"):
            pytest.skip("this platform allows traversal of a 0o000 directory")
        assert not resolved_within_root(str(root), closed / "target.md"), (
            "unresolvable fails closed"
        )
        verdict = write_file_guarded(str(root), str(closed / "target.md"), None, "x")
        assert not verdict.ok
        assert verdict.unresolvable, "and the chokepoint refuses it as unresolvable"
    finally:
        closed.chmod(0o700)


# --- the rule, through the conveniences ---------------------------------------


def test_the_write_rule_refuses_outside_the_repository_whatever_the_role(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    root = _repo(tmp_path_factory)
    away = _outside(tmp_path_factory)
    (root / ".leji").mkdir(parents=True)
    (root / ".leji" / "dist").symlink_to(away)

    verdict = write_file_guarded(str(root), str(root / DIST_REL / "index.html"), DIST_REL, "x")
    assert not verdict.ok, "an own-role target relocated out of the repository is refused"
    assert verdict.outside_root
    assert list(away.iterdir()) == [], "and nothing was written outside"

    cleared = rm_guarded(str(root), str(root / DIST_REL), DIST_REL)
    assert cleared.outside_root, "the clear is refused the same way"
    assert away.exists(), "the out-of-tree directory still stands"


def test_the_write_rule_own_role_other_role_and_content(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    root = _repo(tmp_path_factory)
    (root / WORK_REL).mkdir(parents=True)

    crossed = write_file_guarded(str(root), str(root / WORK_REL / "stolen.md"), DIST_REL, "x")
    assert not crossed.ok, "the export role may not write into the work role"
    assert crossed.role == "work"
    assert not (root / WORK_REL / "stolen.md").exists(), "nothing was written"

    assert write_file_guarded(str(root), str(root / DIST_REL / "index.html"), DIST_REL, "x").ok, (
        "own role"
    )
    assert write_file_guarded(str(root), str(root / "overview.md"), None, "x").ok, "content"

    roleless = write_file_guarded(str(root), str(root / DIST_REL / "other.html"), None, "x")
    assert not roleless.ok, "content has no legitimate .leji/ landing"
    assert roleless.role == "dist"

    bare = write_file_guarded(str(root), str(root / ".leji" / "loose.md"), DIST_REL, "x")
    assert not bare.ok, "a file loose in .leji/ is not the export role"
    assert bare.role == "loose.md", "the role is the first segment under .leji/"
    leji_itself = rm_guarded(str(root), str(root / ".leji"), DIST_REL)
    assert not leji_itself.ok, ".leji/ itself is never the export role"
    assert leji_itself.role == ""
    assert (root / WORK_REL).exists(), "and the trust domain still stands"


def test_a_parent_symlinked_out_of_root_is_caught_before_the_file_is_created(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    root = _repo(tmp_path_factory)
    away = _outside(tmp_path_factory)
    (root / "redirect").symlink_to(away)
    verdict = write_file_guarded(str(root), str(root / "redirect" / "planted.md"), None, "x")
    assert not verdict.ok
    assert verdict.outside_root
    assert list(away.iterdir()) == [], "the parent was not written through"


def test_the_conveniences(tmp_path_factory: pytest.TempPathFactory) -> None:
    root = _repo(tmp_path_factory)
    away = _outside(tmp_path_factory)

    created = write_file_guarded(str(root), str(root / "leji.json"), None, "{}\n", exclusive=True)
    assert created.ok
    again = write_file_guarded(
        str(root), str(root / "leji.json"), None, '{"other":1}\n', exclusive=True
    )
    assert not again.ok
    assert again.exists, "an existing target is its own verdict, never an overwrite"
    assert (root / "leji.json").read_text(encoding="utf-8") == "{}\n", "the bytes are untouched"

    made = mkdirp_guarded(str(root), str(root / DIST_REL / "content"), DIST_REL)
    assert made.ok
    assert made.real == str(root / DIST_REL / "content"), "the checked resolved path comes back"

    (root / "out").symlink_to(away)
    assert not mkdirp_guarded(str(root), str(root / "out" / "deep"), None).ok, "mkdirp is guarded"
    assert list(away.iterdir()) == []

    assert not rename_guarded(
        str(root), str(root / "leji.json"), str(root / "out" / "leji.json"), None
    ).ok, "a rename with an escaping destination is refused"
    assert (root / "leji.json").exists(), "and the source is still there"
    assert rename_guarded(str(root), str(root / "leji.json"), str(root / "moved.json"), None).ok

    assert write_file_atomic_guarded(str(root), str(root / "ci.yml"), None, "jobs:\n").ok
    assert (root / "ci.yml").read_text(encoding="utf-8") == "jobs:\n"
    assert not (root / "ci.yml.leji-tmp").exists(), "the temp sibling is gone"
    assert not write_file_atomic_guarded(str(root), str(root / "out" / "ci.yml"), None, "x").ok, (
        "an escaping atomic destination is refused"
    )

    opened = open_write_guarded(
        str(root), str(root / DIST_REL / "assets" / "app.css"), DIST_REL, 0o644
    )
    assert opened.ok and opened.fd is not None and opened.real is not None
    with os.fdopen(opened.fd, "wb") as f:
        f.write(b"body{}\n")
    assert Path(opened.real).read_text(encoding="utf-8") == "body{}\n"
    refused_open = open_write_guarded(str(root), str(root / "out" / "app.css"), None)
    assert not refused_open.ok
    assert list(away.iterdir()) == [], "nothing landed outside the repository"


def test_an_exclusive_create_is_decided_on_the_standing_entry(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    # O_EXCL on the RESOLVED path is not enough: a dangling symlink resolves to its
    # missing destination, so resolving first would let `leji.json -> nowhere` create
    # the file the link points at. ANY standing entry is `exists`, and nothing anywhere
    # is created.
    root = _repo(tmp_path_factory)
    away = _outside(tmp_path_factory)
    (root / WORK_REL).mkdir(parents=True)
    (root / WORK_REL / "private.json").write_text("private\n", encoding="utf-8")
    target = root / "leji.json"
    content = '{"schemaVersion":"1.0"}\n'

    cases: list[tuple[str, object, Path]] = [
        (
            "a dangling link to a contained path",
            lambda: target.symlink_to(root / "missing.json"),
            root / "missing.json",
        ),
        (
            "a dangling link out of the repository",
            lambda: target.symlink_to(away / "missing.json"),
            away / "missing.json",
        ),
        (
            "a link into another role",
            lambda: target.symlink_to(root / WORK_REL / "planted.json"),
            root / WORK_REL / "planted.json",
        ),
        (
            # its destination stands already; the bytes are checked below
            "a link to a standing file in another role",
            lambda: target.symlink_to(root / WORK_REL / "private.json"),
            target,
        ),
        ("a directory", lambda: target.mkdir(), target),
    ]
    for name, plant, landing in cases:
        plant()  # type: ignore[operator]
        verdict = write_file_guarded(str(root), str(target), None, content, exclusive=True)
        assert not verdict.ok, f"{name}: refused"
        assert verdict.exists, f"{name}: reported as an existing target"
        if landing != target:
            assert not landing.exists(), f"{name}: the link's destination was not created"
        if target.is_dir() and not target.is_symlink():
            target.rmdir()
        else:
            target.unlink()
    assert (root / WORK_REL / "private.json").read_text(encoding="utf-8") == "private\n", (
        "the other role's file was never written through"
    )

    # A standing regular file is the ordinary case, and its bytes stay as they were.
    target.write_text("original\n", encoding="utf-8")
    over_existing = write_file_guarded(str(root), str(target), None, content, exclusive=True)
    assert over_existing.exists, "an existing regular file is never overwritten"
    assert target.read_text(encoding="utf-8") == "original\n"
    target.unlink()

    # Nothing standing: the resolved path is judged, its parents included, and created.
    assert write_file_guarded(str(root), str(target), None, content, exclusive=True).ok
    assert target.read_text(encoding="utf-8") == content
    assert list(away.iterdir()) == [], "nothing was created outside the repository at any point"
    assert [p.name for p in (root / WORK_REL).iterdir()] == ["private.json"], "nor in another role"


def test_a_refused_write_establishes_no_directory(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    root = _repo(tmp_path_factory)
    (root / WORK_REL).mkdir(parents=True)
    verdict = write_file_guarded(
        str(root), str(root / WORK_REL / "deep" / "nested" / "x.md"), DIST_REL, "x"
    )
    assert not verdict.ok
    assert not (root / WORK_REL / "deep").exists(), "no parent was created for a refused write"


# --- the verified read ---------------------------------------------------------


def test_verified_target_read_kinds(tmp_path_factory: pytest.TempPathFactory) -> None:
    root = _repo(tmp_path_factory)
    target = root / "leji-badge.svg"

    assert verified_target_read(str(root), str(target), None).status == "absent"

    target.write_text("svg\n", encoding="utf-8")
    regular = verified_target_read(str(root), str(target), None)
    assert regular.status == "regular"
    assert regular.text() == "svg\n"
    target.unlink()

    target.symlink_to(root / "missing.svg")
    dangling = verified_target_read(str(root), str(target), None)
    assert dangling.status == "refused", "a standing dangling link is never read as absent"
    assert dangling.reason == "unverifiable"
    target.unlink()

    sock_path = root / "sock"
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        server.bind(str(sock_path))
        direct = verified_target_read(str(root), str(sock_path), None)
        assert direct.status == "refused"
        assert direct.reason == "not-regular"
        target.symlink_to(sock_path)
        linked = verified_target_read(str(root), str(target), None)
        assert linked.status == "refused", "a link to a socket is settled on what it resolves to"
        assert linked.reason == "not-regular"
        target.unlink()
    finally:
        server.close()
        sock_path.unlink(missing_ok=True)

    target.mkdir()
    directory = verified_target_read(str(root), str(target), None)
    assert directory.status == "refused"
    assert directory.reason == "not-regular"
    target.rmdir()


def test_verified_target_read_outside_root_other_role_and_symlinked_parent(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    root = _repo(tmp_path_factory)
    away = _outside(tmp_path_factory)
    (away / "real.svg").write_text("svg\n", encoding="utf-8")

    escaping = root / "escape.svg"
    escaping.symlink_to(away / "real.svg")
    out = verified_target_read(str(root), str(escaping), None)
    assert out.status == "refused"
    assert out.reason == "outside-root"

    (root / WORK_REL).mkdir(parents=True)
    (root / WORK_REL / "private.svg").write_text("svg\n", encoding="utf-8")
    crossing = root / "crossing.svg"
    crossing.symlink_to(root / WORK_REL / "private.svg")
    role = verified_target_read(str(root), str(crossing), None)
    assert role.status == "refused"
    assert role.reason == "other-role"
    assert verified_target_read(str(root), str(crossing), WORK_REL).status == "regular", (
        "its own role reads through"
    )

    (root / "redirect").symlink_to(away)
    parent = verified_target_read(str(root), str(root / "redirect" / "real.svg"), None)
    assert parent.status == "refused"
    assert parent.reason == "outside-root"


def test_guard_root_resolves_a_root_reached_through_a_symlinked_ancestor(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    root = _repo(tmp_path_factory)
    parent = Path(os.path.realpath(tmp_path_factory.mktemp("leji-link")))
    link = parent / "repo"
    link.symlink_to(root)
    assert guard_root(str(link)) == str(root), "both sides of the rule come through one resolver"
    assert write_file_guarded(guard_root(str(link)), str(link / "x.md"), None, "x").ok
    assert (root / "x.md").read_text(encoding="utf-8") == "x"


def test_verified_target_read_a_symlink_through_a_regular_file(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    # `link -> somefile/child`, where `somefile` is a regular file: following the link
    # is ENOTDIR, not absence. The reference SDK's `statSync(..., {throwIfNoEntry:
    # false})` hands ENOTDIR back as `undefined` (unlike `lstatSync`, which throws it),
    # so the entry-kind pass falls through; its `resolvedPath` then refuses the path as
    # unresolvable and the whole read is `refused/unverifiable` with nothing raised.
    # Verified against the frozen reference by driving `verifiedTargetRead` from
    # packages/sdk/dist over this exact tree, and end to end (`leji ci --provider
    # gitlab` with a `.gitlab-ci.yml` shaped this way exits 2 in both SDKs with the
    # same byte). Mutation that reddens: propagate NotADirectoryError from the
    # symlink-follow stat — this port then raises where the reference refuses.
    root = _repo(tmp_path_factory)
    (root / "somefile").write_text("x\n", encoding="utf-8")
    (root / "link").symlink_to(root / "somefile" / "child")

    read = verified_target_read(str(root), str(root / "link"), None)

    assert read.status == "refused", "an ENOTDIR follow is a refusal, never a raise"
    assert read.reason == "unverifiable"
    assert read.real is None, "the path could not be resolved at all"
