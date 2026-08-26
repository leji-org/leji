"""The self-managed ``.leji/.gitignore``, driven from the shared fixtures: the tool
ignores its own tree from inside, so a layer whose root ``.gitignore`` never received the
``.leji/`` line is clean after its first role-creating command. The fixtures own the
scenario definitions (``lejiIgnore``), so all three SDKs answer the same six questions
against the same trees; the unit tests below them pin what a fixture cannot construct
without injecting a fault.

Mirrors packages/sdk/test/leji-ignore.test.ts.
"""

from __future__ import annotations

import json
import posixpath
import shutil
import subprocess
from pathlib import Path

import pytest

from leji import (
    LEJI_IGNORE_CONTENT,
    LEJI_IGNORE_NOTICE,
    LEJI_IGNORE_REL,
    build_viewer,
    ensure_leji_ignore_file,
    load_manifest,
    new_leji_ignore_context,
)
from leji.cli import main
from leji.fsx import guard_root, write_file_guarded
from leji.init_cmd import ensure_approval_guard
from leji.layout import LEJI_DIR, role_abs
from leji.mounts import MountDecl, retain_pin_in_store

IGNORE_FIXTURES = [
    "valid-leji-ignore-fresh",
    "valid-leji-ignore-existing",
    "valid-leji-ignore-legacy",
]

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "fixtures"


def _fixture_rel(value: str, what: str) -> str:
    """A fixture-declared path, as the README fixes it: repository-root-relative POSIX,
    normalized, no ``..`` segment, never absolute."""
    assert not posixpath.isabs(value), f"{what} must be relative: {value}"
    normalized = posixpath.normpath(value).rstrip("/")
    assert normalized == value.rstrip("/"), f"{what} must be normalized: {value}"
    assert ".." not in normalized.split("/"), f"{what} must not escape the fixture: {value}"
    return normalized


def _fixture_abs(directory: Path, rel: str) -> Path:
    return directory.joinpath(*rel.split("/"))


def _copy_seed(src: Path, dest: Path) -> None:
    """Copy a committed seed's CONTENTS into ``dest``, which the harness creates."""
    dest.mkdir(parents=True, exist_ok=True)
    for entry in sorted(src.iterdir(), key=lambda p: p.name):
        assert not entry.is_symlink(), f"seed carries a symlink: {entry}"
        target = dest / entry.name
        if entry.is_dir():
            _copy_seed(entry, target)
        else:
            shutil.copy2(entry, target)


def _git(directory: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(directory), *args],
        capture_output=True,
        text=True,
        check=True,
    ).stdout


def _git_fixture(directory: Path, name: str, seeds: list[dict]) -> Path:
    """A pristine working copy of the fixture with every declared seed materialized,
    committed to its own git repository: ``git status --porcelain`` is one half of what
    these scenarios assert, and it answers nothing useful over an uncommitted tree."""
    shutil.copytree(FIXTURES / name, directory, dirs_exist_ok=True)
    for seed in seeds:
        to = _fixture_rel(seed["to"], "seed.to")
        to_abs = _fixture_abs(directory, to)
        assert not to_abs.exists(), f"seed target already exists: {to}"
        _copy_seed(_fixture_abs(directory, _fixture_rel(seed["from"], "seed.from")), to_abs)
    _git(directory, "init", "-q", "-b", "main")
    _git(directory, "config", "user.email", "fixtures@leji.org")
    _git(directory, "config", "user.name", "Leji Fixtures")
    _git(directory, "config", "commit.gpgsign", "false")
    _git(directory, "add", "-A")
    _git(directory, "commit", "-qm", "fixture")
    return directory


def _plant(directory: Path, outside: Path, declaration: dict) -> None:
    """The declared symlink, and whatever it points at, planted before the run. A link
    out of the repository is spelled ``outside``: it resolves to a directory the harness
    makes beside the working copy, which is the only shape a fixture cannot commit and
    cannot express as a contained relative path."""
    at = _fixture_abs(directory, _fixture_rel(declaration["symlinkAt"], "plant.symlinkAt"))
    if declaration["symlinkTo"] == "outside":
        target = outside
    else:
        target = _fixture_abs(directory, _fixture_rel(declaration["symlinkTo"], "plant.symlinkTo"))
    if declaration["targetKind"] == "dir":
        target.mkdir(parents=True, exist_ok=True)
    else:
        target.write_text(declaration.get("targetBytes", ""), encoding="utf-8")
    at.parent.mkdir(parents=True, exist_ok=True)
    at.symlink_to(target)


def _untracked_under_leji(directory: Path) -> list[str]:
    """Every ``git status --porcelain`` entry whose path lies under the root ``.leji/``."""
    raw = _git(directory, "status", "--porcelain")
    entries = [line[3:].strip('"') for line in raw.split("\n") if line.strip()]
    return sorted(r for r in entries if r == LEJI_DIR or r.startswith(LEJI_DIR + "/"))


def _scenarios() -> list[tuple[str, list[dict], dict]]:
    out: list[tuple[str, list[dict], dict]] = []
    for name in IGNORE_FIXTURES:
        expected = json.loads((FIXTURES / name / "expected.json").read_text("utf-8"))
        block = expected.get("lejiIgnore")
        assert block is not None, f"{name} declares a lejiIgnore block"
        for scenario in block["scenarios"]:
            out.append((name, expected.get("seeds", []), scenario))
    return out


@pytest.mark.parametrize(
    "name,seeds,scenario",
    _scenarios(),
    ids=[f"{n}-{s['id']}" for n, _, s in _scenarios()],
)
def test_leji_ignore_fixture_scenario(
    name: str, seeds: list[dict], scenario: dict, capsys, tmp_path: Path
) -> None:
    directory = _git_fixture(tmp_path / "repo", name, seeds)
    if scenario.get("plant"):
        _plant(directory, tmp_path / "outside", scenario["plant"])
    before = {}
    for rel in scenario.get("preserved", []):
        abs_path = _fixture_abs(directory, _fixture_rel(rel, "preserved entry"))
        assert abs_path.exists(), f"preserved path exists before the run: {rel}"
        before[rel] = abs_path.read_bytes()

    code = main([*scenario["args"], "--root", str(directory)])
    captured = capsys.readouterr()
    assert code == scenario["exit"], f"exit code (stderr: {captured.err})"

    # The one file, judged on its ORIGINAL entry: a symlink standing there was refused,
    # never followed, so lstat is what decides its kind.
    ignore_abs = Path(role_abs(str(directory), LEJI_IGNORE_REL))
    if scenario["ignoreFile"] == "absent":
        assert not ignore_abs.is_symlink() and not ignore_abs.exists(), (
            f"{LEJI_IGNORE_REL} must not exist"
        )
    elif scenario["ignoreFile"] == "symlink":
        assert ignore_abs.is_symlink(), f"{LEJI_IGNORE_REL} is still the planted symlink"
    else:
        assert ignore_abs.is_file() and not ignore_abs.is_symlink(), (
            f"{LEJI_IGNORE_REL} is a regular file"
        )
        assert ignore_abs.read_text("utf-8") == scenario["bytes"], f"{LEJI_IGNORE_REL} bytes"

    assert captured.err.count(LEJI_IGNORE_NOTICE) == scenario["notices"], (
        f"notice count (stderr: {captured.err})"
    )

    if scenario.get("jsonParses"):
        document = json.loads(captured.out)
        assert isinstance(document, dict), "--json stdout parses as one document"
        assert "was left as is" not in captured.out, (
            "the notice is stderr only, never inside the JSON document"
        )

    if scenario.get("untrackedUnderLeji") is not None:
        assert _untracked_under_leji(directory) == scenario["untrackedUnderLeji"], (
            f"git status under {LEJI_DIR}/"
        )

    for rel, data in before.items():
        assert _fixture_abs(directory, rel).read_bytes() == data, f"preserved byte-identical: {rel}"


# --- unit level: what a fixture cannot prepare without injecting a fault -----------


def _fresh_copy(directory: Path) -> Path:
    """The smallest layer these unit tests drive, copied out of the fixture family."""
    shutil.copytree(FIXTURES / "valid-leji-ignore-fresh", directory, dirs_exist_ok=True)
    (directory / "expected.json").unlink(missing_ok=True)
    return directory


def _with_foreign_ignore(directory: Path) -> Path:
    """The same layer with somebody else's ignore file already standing where the tool
    would write its own: the state the notice is for."""
    Path(role_abs(str(directory), LEJI_DIR)).mkdir(parents=True, exist_ok=True)
    Path(role_abs(str(directory), LEJI_IGNORE_REL)).write_text("mine\n", encoding="utf-8")
    return directory


def test_the_notice_is_frozen_and_one_context_says_it_exactly_once(capsys, tmp_path) -> None:
    assert LEJI_IGNORE_NOTICE == (
        "leji: .leji/.gitignore exists and was left as is (expected content: *)"
    )
    assert LEJI_IGNORE_CONTENT == "*\n"

    directory = _with_foreign_ignore(_fresh_copy(tmp_path / "repo"))
    ctx = new_leji_ignore_context()
    for _ in range(3):
        assert ensure_leji_ignore_file(str(directory), ctx) == "left-as-is"
    captured = capsys.readouterr()
    assert captured.err == LEJI_IGNORE_NOTICE + "\n", "one notice per invocation context"
    assert Path(role_abs(str(directory), LEJI_IGNORE_REL)).read_text("utf-8") == "mine\n", (
        "bytes untouched"
    )


def test_a_context_is_per_invocation_never_per_process(capsys, tmp_path) -> None:
    first = _with_foreign_ignore(_fresh_copy(tmp_path / "first"))
    second = _with_foreign_ignore(_fresh_copy(tmp_path / "second"))
    for directory in (first, second):
        ensure_leji_ignore_file(str(directory), new_leji_ignore_context())
    captured = capsys.readouterr()
    assert captured.err.count(LEJI_IGNORE_NOTICE) == 2, "each invocation says it for itself"


def test_nothing_is_written_through_an_entry_standing_at_the_target(tmp_path) -> None:
    # The check/use gap at the one file this exception allows, from both sides. The READ
    # side first: a symlink into ordinary content standing at the target is refused, so
    # the helper writes nothing and `decoy.txt` is untouched. Then the WRITE side: the
    # very guarded create the helper makes is asked to run against that same standing
    # entry, and ``O_EXCL`` is what makes it report the entry rather than follow it.
    # Mutation that reddens the second half: drop ``exclusive`` from the guarded write in
    # ``ensure_leji_ignore_file``.
    directory = _fresh_copy(tmp_path / "repo")
    Path(role_abs(str(directory), LEJI_DIR)).mkdir(parents=True, exist_ok=True)
    decoy = directory / "decoy.txt"
    decoy.write_text("not the ignore file\n", encoding="utf-8")
    ignore_abs = Path(role_abs(str(directory), LEJI_IGNORE_REL))
    ignore_abs.symlink_to(decoy)

    assert ensure_leji_ignore_file(str(directory)) != "created"
    assert decoy.read_text("utf-8") == "not the ignore file\n", "the link target is untouched"
    assert ignore_abs.is_symlink(), "the planted link is still the planted link"

    verdict = write_file_guarded(
        guard_root(str(directory)), str(ignore_abs), None, LEJI_IGNORE_CONTENT, exclusive=True
    )
    assert verdict.exists, "the exclusive create must report the standing entry"
    assert decoy.read_text("utf-8") == "not the ignore file\n", (
        "the link target is untouched by the create"
    )


def test_generation_alone_establishes_a_role(capsys, tmp_path) -> None:
    # The fixture scenarios drive `viewer build` and `export`, which are one command;
    # this is the other role establisher on the viewer side, reached by its own name.
    directory = _fresh_copy(tmp_path / "repo")
    assert main(["viewer", "--root", str(directory)]) == 0, capsys.readouterr().err
    assert Path(role_abs(str(directory), LEJI_IGNORE_REL)).read_text("utf-8") == LEJI_IGNORE_CONTENT


def test_the_onboarding_guard_establishes_the_work_role(tmp_path) -> None:
    directory = _fresh_copy(tmp_path / "repo")
    assert ensure_approval_guard(str(directory), "docs/") == "installed"
    assert Path(role_abs(str(directory), LEJI_IGNORE_REL)).read_text("utf-8") == LEJI_IGNORE_CONTENT


def test_a_direct_sdk_call_with_no_context_notices_at_most_once(capsys, tmp_path) -> None:
    directory = _with_foreign_ignore(_fresh_copy(tmp_path / "repo"))
    manifest = load_manifest(str(directory)).manifest
    assert manifest is not None, "the fixture manifest loads"
    # build_viewer nests generate_viewer and establishes two roles of its own.
    build_viewer(str(directory), manifest)
    assert capsys.readouterr().err.count(LEJI_IGNORE_NOTICE) == 1, "one notice for the whole call"


def test_mounts_establishment_threads_one_context_across_several_retentions(
    capsys, monkeypatch, tmp_path
) -> None:
    # `conformance --federation verify` probes reachability PER DECLARED MOUNT and
    # `mounts update-pin --fetch` retains twice (the current pin, then the target); each
    # establishes the managed store through the same helper, so each would say the frozen
    # line again if the invocation's notice state were not threaded all the way down.
    #
    # The declared source is routed to a local empty repository the way the update-pin
    # suite routes its own (`insteadOf` is git's own redirection), so the retention
    # establishes the store and then fails locally: nothing here reaches the network.
    directory = _with_foreign_ignore(_fresh_copy(tmp_path / "repo"))
    routed = tmp_path / "routed.git"
    subprocess.run(["git", "init", "--bare", "-q", str(routed)], check=True)
    source = "https://github.com/acme/one"
    monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
    monkeypatch.setenv("GIT_CONFIG_KEY_0", f"url.{routed}.insteadOf")
    monkeypatch.setenv("GIT_CONFIG_VALUE_0", source)

    mount = MountDecl(name="one", source=source, pin="0" * 40, tracking_ref="refs/heads/main")
    ctx = new_leji_ignore_context()
    for oid in ("0" * 40, "1" * 40):
        retain_pin_in_store(str(directory), mount, "acme/one", oid, ctx)
    # The guard against a test that passes for the wrong reason: the managed store really
    # was established, so a notice was genuinely available to be said each time.
    store = Path(role_abs(str(directory), f"{LEJI_DIR}/mounts")) / "store"
    assert store.is_dir() and any(store.iterdir()), "the managed store was established"
    assert capsys.readouterr().err.count(LEJI_IGNORE_NOTICE) == 1, "one notice for the invocation"
    assert Path(role_abs(str(directory), LEJI_IGNORE_REL)).read_text("utf-8") == "mine\n", (
        "bytes untouched"
    )


def test_the_ignore_file_is_never_created_by_a_read_only_command(capsys, tmp_path) -> None:
    # Nothing read-only creates the file: the bootstrap requirement is that it appears at
    # the first ROLE creation, and `validate` creates none.
    directory = _fresh_copy(tmp_path / "repo")
    assert main(["validate", "--root", str(directory)]) == 0, capsys.readouterr().err
    assert not Path(role_abs(str(directory), LEJI_DIR)).exists()
