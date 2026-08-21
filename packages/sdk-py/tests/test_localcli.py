"""The hand-off decision and the launch that follows it, mirroring
packages/sdk/test/localcli.test.ts and packages/sdk/test/proc/handoff.test.ts: the
resolver over the committed ``fixtures/handoff/`` family with the installed state
written here, the launcher over an injected world so every row of its result table is
provable without ending the test runner, and process-level runs through the installed
console script."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import NoReturn, Optional

import pytest

import leji.ecosystem
import leji.localcli
from leji.cli import effective_root, main
from leji.localcli import (
    LaunchIo,
    LocalCliHandoff,
    launch_local_cli,
    resolve_local_cli,
)
from leji.schemas import SDK_VERSION

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "fixtures" / "handoff"

#: The platform this suite runs on, for the cases whose target is the POSIX console
#: script. The Windows branch is exercised by passing ``win32`` explicitly, since it
#: resolves declared paths rather than asking the filesystem for an executable bit.
HOST = sys.platform

#: A self entry no fixture can ever be: the recursion guard is asserted with the real
#: one in its own case.
NOT_SELF = "/nonexistent/not-the-running-script"

#: The marker the hand-off must reach. It prints its own argv JSON-ENCODED, so argument
#: boundaries are provable rather than inferred from a joined string, and exits 3, a
#: status no leji command returns, so exit forwarding is observable. The JSON shape is
#: the reference SDK's (`JSON.stringify`: no spaces, non-ASCII kept as itself), so the
#: two families' markers are one rule.
MARKER = (
    f"#!{sys.executable}\n"
    "import json, sys\n"
    'sys.stdout.write("handoff:python:" + json.dumps(sys.argv[1:], separators=(",", ":"),'
    ' ensure_ascii=False) + "\\n")\n'
    "raise SystemExit(3)\n"
)

#: A target that passes every check and still cannot be executed: its interpreter does
#: not exist. This is what a target REMOVED or stripped of its executable bit between
#: the check and the exec leaves behind, deterministically, without a test having to win
#: the race itself.
UNRUNNABLE = "#!/nonexistent/interpreter\n"


def marker_line(argv: list[str]) -> str:
    return "handoff:python:" + json.dumps(argv, separators=(",", ":"), ensure_ascii=False) + "\n"


def add_dist_info(
    site: Path, dir_name: str, meta_name: str, version: str, padding: int = 0
) -> None:
    """One installed distribution's metadata. The DIRECTORY name and the ``Name`` field
    are set apart, because only the second decides identity: the first is the PEP 376
    spelling that narrows which files are opened at all."""
    dist = site / f"{dir_name}-{version}.dist-info"
    dist.mkdir(parents=True, exist_ok=True)
    metadata = f"Metadata-Version: 2.1\nName: {meta_name}\nVersion: {version}\n"
    if padding > 0:
        metadata += f"Description: {'x' * padding}\n"
    (dist / "METADATA").write_text(metadata + "\nThe body is not metadata.\n")


def install(
    env_dir: Path,
    *,
    version: str = "1.4.0",
    name: str = "leji",
    meta_name: Optional[str] = None,
    body: str = MARKER,
    dist_infos: int = 1,
    padding: int = 0,
    site_entries: int = 0,
    lib_dirs: int = 1,
) -> Path:
    """The state a committed fixture cannot carry: a virtual environment is never
    committed, so the console script and the installed distribution's metadata are
    written here, statically, exactly as an install would leave them."""
    script = env_dir / ("Scripts" if sys.platform == "win32" else "bin") / "leji"
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text(body)
    script.chmod(0o755)
    for lib in range(lib_dirs):
        site = env_dir / "lib" / f"python3.{13 + lib}" / "site-packages"
        site.mkdir(parents=True, exist_ok=True)
        for index in range(dist_infos):
            add_dist_info(
                site,
                name,
                meta_name if meta_name is not None else name,
                version if index == 0 else f"{version}.{index}",
                padding,
            )
        for extra in range(site_entries):
            (site / f"filler-{extra}").mkdir(exist_ok=True)
    return script


def seed(name: str, tmp_path: Path) -> Path:
    """One case of the family: the committed miniature repository copied out, plus the
    installed state its name declares. Every fixture is seeded by a file copy and a
    write here; nothing is produced by running a CLI."""
    root = tmp_path / "repo"
    shutil.copytree(FIXTURES / name, root)
    venv = root / ".venv"
    if name in {
        "python-eligible",
        "python-undeclared",
        "python-ambiguous-manager",
        "python-unknown-spec-line",
        "python-virtual-env-equal",
        "python-virtual-env-outside",
    }:
        install(venv)
    elif name in {"python-no-env", "python-refused-manifest"}:
        pass  # nothing is installed at all
    elif name == "python-below-minimum":
        install(venv, version="0.9.3")
    elif name == "python-malformed-version":
        install(venv, version="1.x")
    elif name == "python-wrong-name":
        # Spelled like this package, declaring another one: the Name field decides.
        install(venv, meta_name="leji-extras")
    elif name == "python-two-distinfo":
        install(venv, dist_infos=2)
    elif name == "python-bounds":
        install(venv, padding=65 * 1024)
    elif name == "python-uv-env-var":
        install(root / "envs" / "a")
    elif name == "python-virtual-env-elsewhere-inside-root":
        install(root / "nested" / ".venv")
    elif name == "python-escaped-env":
        outside = tmp_path / "outside"
        install(outside)
        venv.symlink_to(outside)
    elif name == "python-escaped-script":
        install(venv)
        outside = tmp_path / "outside"
        install(outside)
        script = venv / "bin" / "leji"
        script.unlink()
        script.symlink_to(outside / "bin" / "leji")
    elif name == "python-script-not-regular":
        install(venv)
        script = venv / "bin" / "leji"
        script.unlink()
        script.mkdir()
    else:
        raise AssertionError(f"unseeded fixture {name}")
    if name == "python-refused-manifest":
        # The manifest that gates the ecosystem resolves outside the repository, so the
        # evidence is refused and nothing about this root is decided from it.
        outside = tmp_path / "outside"
        outside.mkdir(exist_ok=True)
        (outside / "pyproject.toml").write_text('[dependency-groups]\ndev = ["leji"]\n')
        (root / "pyproject.toml").symlink_to(outside / "pyproject.toml")
        install(venv)
    return root


def resolve_in(
    root: Path,
    extra: Optional[list[str]] = None,
    env: Optional[dict[str, str]] = None,
    platform: str = HOST,
) -> Optional[LocalCliHandoff]:
    argv = ["--root", str(root), *(extra or [])]
    return resolve_local_cli(argv, env or {}, platform, NOT_SELF)


# --- the decision table ---------------------------------------------------------

#: Every fixture whose answer is the same on both platforms, with the reason the
#: hand-off is or is not made.
DECISIONS: list[tuple[str, bool, str]] = [
    ("python-eligible", True, "declared, installed inside the root, and at the minimum"),
    ("python-undeclared", False, "installed but not declared: the repository never asked"),
    ("python-no-env", False, "declared, but there is no project environment"),
    ("python-below-minimum", False, "the installed major is under the layer minimum"),
    ("python-malformed-version", False, "the version does not parse"),
    ("python-wrong-name", False, "no installed distribution normalizes to leji"),
    ("python-two-distinfo", False, "two matches: this environment cannot say which runs"),
    ("python-bounds", False, "the metadata is past the read bound"),
    ("python-escaped-env", False, "the environment resolves outside the repository"),
    ("python-escaped-script", False, "the console script resolves outside the repository"),
    ("python-script-not-regular", False, "the console script is not a regular file"),
    ("python-refused-manifest", False, "the ecosystem evidence itself was refused"),
    ("python-ambiguous-manager", False, "no manager selected, so no environment rule"),
    ("python-unknown-spec-line", False, "a spec line this SDK has no minimum for"),
]


@pytest.mark.parametrize(("name", "handoff", "why"), DECISIONS)
def test_decision_table(name: str, handoff: bool, why: str, tmp_path: Path) -> None:
    root = seed(name, tmp_path)
    resolved = resolve_in(root)
    assert (resolved is not None) == handoff, why
    if resolved is not None:
        assert resolved.display == ".venv/bin/leji"
        assert resolved.args == ["--root", str(root)]


def test_go_and_node_roots_are_not_this_runtimes(tmp_path: Path) -> None:
    """A Node or Go repository has no python record to decide on, so this CLI hands off
    nothing there: same-runtime only, never across ecosystems."""
    for name in ("node-eligible", "go-tool"):
        root = tmp_path / name
        shutil.copytree(FIXTURES / name, root)
        assert resolve_local_cli(["--root", str(root)], {}, HOST, NOT_SELF) is None


def test_polyglot_hands_off_on_its_own_record(tmp_path: Path) -> None:
    """A repository declaring both runtimes is decided on THIS runtime's record, never
    on the report's overall verdict, which is `multiple-ecosystems`."""
    root = tmp_path / "polyglot"
    shutil.copytree(FIXTURES / "polyglot", root)
    install(root / ".venv")
    resolved = resolve_local_cli(["--root", str(root)], {}, HOST, NOT_SELF)
    assert resolved is not None
    assert resolved.display == ".venv/bin/leji"


def test_recursion_guard(tmp_path: Path) -> None:
    """A repository whose installed copy IS the script now running: handing off would
    run it again, forever."""
    root = seed("python-eligible", tmp_path)
    target = os.path.realpath(root / ".venv" / "bin" / "leji")
    assert resolve_local_cli(["--root", str(root)], {}, HOST, target) is None
    # The same tree with a different self hands off, so the refusal above is the guard
    # and not the fixture being ineligible for another reason.
    assert resolve_in(root) is not None


def test_unresolvable_self_refuses(tmp_path: Path) -> None:
    root = seed("python-eligible", tmp_path)
    assert resolve_local_cli(["--root", str(root)], {}, HOST, None) is None


# --- one verified derivation ----------------------------------------------------
# The manager selects the environment and therefore which console script would run,
# so declaration AND manager come from one verified read of the declaring manifest
# rather than from a scan that read the same files by path a moment earlier.

DECLARATION = (
    '[project]\nname = "joiner-app"\nversion = "0.1.0"\n\n[dependency-groups]\ndev = ["leji"]\n'
)


def manifest_only(name: str, tables: str, tmp_path: Path) -> Path:
    """A root whose manager is named by the pyproject TEXT alone: no lockfile, so the
    `[tool.*]` table is what decides."""
    root = tmp_path / name
    root.mkdir(parents=True)
    shutil.copy(FIXTURES / "python-eligible" / "leji.json", root / "leji.json")
    (root / "pyproject.toml").write_text(DECLARATION + tables)
    return root


def test_the_manager_comes_from_the_verified_pyproject_text(tmp_path: Path) -> None:
    # uv, so the uv rule applies and UV_PROJECT_ENVIRONMENT names the environment.
    uv_root = manifest_only("uv", "\n[tool.uv]\npackage = false\n", tmp_path)
    install(uv_root / "envs" / "a")
    resolved = resolve_in(uv_root, env={"UV_PROJECT_ENVIRONMENT": "envs/a"})
    assert resolved is not None
    assert resolved.display == "envs/a/bin/leji"

    # poetry, so the same variable decides nothing and `.venv` is the environment.
    poetry_root = manifest_only("poetry", '\n[tool.poetry]\nname = "joiner-app"\n', tmp_path)
    install(poetry_root / "envs" / "a")
    assert resolve_in(poetry_root, env={"UV_PROJECT_ENVIRONMENT": "envs/a"}) is None
    install(poetry_root / ".venv")
    resolved = resolve_in(poetry_root, env={"UV_PROJECT_ENVIRONMENT": "envs/a"})
    assert resolved is not None
    assert resolved.display == ".venv/bin/leji"


def test_two_tool_tables_are_ambiguous_and_hand_off_nothing(tmp_path: Path) -> None:
    root = manifest_only("both", "\n[tool.uv]\n\n[tool.pdm]\n", tmp_path)
    install(root / ".venv")
    assert resolve_in(root) is None


def test_the_resolver_never_consults_the_ecosystem_report(monkeypatch, tmp_path: Path) -> None:
    """The structural half of the same property: no scan is performed at all, so there
    is no earlier read for a swap to sit between."""
    assert not hasattr(leji.localcli, "detect_ecosystem"), "the resolver imports no scan"

    def refuse(_root: str) -> None:
        raise AssertionError("the resolver must not call detect_ecosystem")

    monkeypatch.setattr(leji.ecosystem, "detect_ecosystem", refuse)
    root = seed("python-eligible", tmp_path)
    assert resolve_in(root) is not None


# A lockfile's evidence is its NAME, and the name counts only when a verified open of
# it succeeds at decision time. Each shape below is a name that no longer stands for a
# file of this repository, and each must select nothing: the table falls through as if
# the lockfile were absent, rather than the stale name steering the environment.


@pytest.mark.parametrize(
    "shape",
    ["dangling symlink", "symlink out of the root", "symlink inside the root", "directory"],
)
def test_an_unverifiable_lockfile_is_not_evidence(shape: str, tmp_path: Path) -> None:
    """With a real `uv.lock` the manager is uv, so UV_PROJECT_ENVIRONMENT names the
    environment. With a name that cannot be verified open, the table falls through to
    pip, whose environment is `.venv` and which this root does not have: no hand-off,
    and in particular no hand-off through the environment the stale name would have
    chosen."""
    root = seed("python-uv-env-var", tmp_path)  # declares, no `.venv`, envs/a installed
    install(root / "envs" / "a")
    env = {"UV_PROJECT_ENVIRONMENT": "envs/a"}
    resolved = resolve_in(root, env=env)
    assert resolved is not None and resolved.display == "envs/a/bin/leji", "the uv rule"

    lock = root / "uv.lock"
    lock.unlink()
    outside = tmp_path / "outside"
    outside.mkdir(exist_ok=True)
    (outside / "uv.lock").write_text("version = 1\n")
    if shape == "dangling symlink":
        lock.symlink_to(root / "never-existed.lock")
    elif shape == "symlink out of the root":
        lock.symlink_to(outside / "uv.lock")
    elif shape == "symlink inside the root":
        # A link to a perfectly ordinary file of this repository is still a LINK, and
        # evidence reached through one is not this repository's evidence: the entry
        # itself is judged, never what it resolves to.
        (root / "real.lock").write_text("version = 1\n")
        lock.symlink_to(root / "real.lock")
    else:
        lock.mkdir()

    assert resolve_in(root, env=env) is None, shape
    # The proof that the fall-through is the table and not a refusal of the root: give
    # pip its own environment and the same tree hands off there instead.
    install(root / ".venv")
    fell_through = resolve_in(root, env=env)
    assert fell_through is not None, shape
    assert fell_through.display == ".venv/bin/leji", shape


def test_a_lockfile_removed_after_the_listing_selects_nothing(monkeypatch, tmp_path: Path) -> None:
    """The window itself, exercised inside ONE resolution: the name is listed, and the
    file is gone by the time the decision is made.

    The seam is `python_declares`, the last thing the resolver does between listing the
    root and verifying the lock candidates; the wrapper deletes `uv.lock` on its way
    through and then delegates. A resolver that selected on the listed name would still
    answer `envs/a` here, which is exactly the shape this replaces; one that verifies at
    decision time falls through to pip and answers `.venv`. The listing is recorded so
    the test can assert the name really was there: this is the window, not an absent
    file."""
    root = seed("python-uv-env-var", tmp_path)
    install(root / "envs" / "a")
    install(root / ".venv")
    env = {"UV_PROJECT_ENVIRONMENT": "envs/a"}
    before = resolve_in(root, env=env)
    assert before is not None and before.display == "envs/a/bin/leji", "the uv rule, intact"

    listed: list[str] = []
    real_listdir = os.listdir

    def recording_listdir(path):  # type: ignore[no-untyped-def]
        names = real_listdir(path)
        if os.path.abspath(str(path)) == os.path.abspath(str(root)):
            listed.extend(names)
        return names

    real_declares = leji.localcli.python_declares

    def delete_then_declare(*args, **kwargs):  # type: ignore[no-untyped-def]
        (root / "uv.lock").unlink(missing_ok=True)
        return real_declares(*args, **kwargs)

    monkeypatch.setattr(os, "listdir", recording_listdir)
    monkeypatch.setattr(leji.localcli, "python_declares", delete_then_declare)
    resolved = resolve_in(root, env=env)

    assert "uv.lock" in listed, "the name was listed: the window is what is under test"
    assert resolved is not None
    assert resolved.display == ".venv/bin/leji", "the vanished name selected nothing"


def test_a_lockfile_swapped_to_a_link_during_verification_is_not_evidence(
    monkeypatch, tmp_path: Path
) -> None:
    """The window inside the verification itself: the entry is a regular file when it
    is judged and a link by the time it is opened.

    Nothing has to be swapped back for that to pass a check that only judges the
    entry once and then trusts the open, because the open resolves the link and
    verifies its target perfectly well. What refuses it is comparing the descriptor's
    own identity with the identity of the NAME afterwards: a symlink's inode is never
    the inode of the file it points at.

    The seam is `open_verified_source` as the resolver calls it, wrapped so that the
    swap happens on the way in, for the lock candidate only."""
    root = seed("python-uv-env-var", tmp_path)
    install(root / "envs" / "a")
    install(root / ".venv")
    env = {"UV_PROJECT_ENVIRONMENT": "envs/a"}
    before = resolve_in(root, env=env)
    assert before is not None and before.display == "envs/a/bin/leji", "the uv rule, intact"

    lock = root / "uv.lock"
    (root / "real.lock").write_text("version = 1\n")  # an ordinary file of this repository
    real_open = leji.localcli.open_verified_source
    swapped: list[str] = []

    def swap_then_open(abs_path, allow, *args, **kwargs):  # type: ignore[no-untyped-def]
        if os.path.abspath(str(abs_path)) == os.path.abspath(str(lock)):
            lock.unlink()
            lock.symlink_to(root / "real.lock")
            swapped.append(str(abs_path))
        return real_open(abs_path, allow, *args, **kwargs)

    monkeypatch.setattr(leji.localcli, "open_verified_source", swap_then_open)
    resolved = resolve_in(root, env=env)

    assert swapped, "the seam fired: a regular file at the lstat, a link at the open"
    assert lock.is_symlink(), "the entry really is a link now"
    assert resolved is not None
    assert resolved.display == ".venv/bin/leji", "the link selected nothing"


def test_an_unreadable_candidate_cannot_suppress_a_valid_family(tmp_path: Path) -> None:
    """One candidate failing operationally is absent, not fatal: the family that does
    verify still selects, rather than an unreadable name taking the root down with it."""
    root = seed("python-eligible", tmp_path)  # declares, uv.lock, `.venv` installed
    (root / "poetry.lock").write_text("# poetry lockfile\n")
    if not unreadable(root / "uv.lock"):
        pytest.skip("this user can read a 0o000 file (root)")
    resolved = resolve_in(root)
    assert resolved is not None, "the poetry family verified and selects"
    assert resolved.display == ".venv/bin/leji"


def test_an_oversized_pyproject_hands_off_nothing(tmp_path: Path) -> None:
    root = seed("python-eligible", tmp_path)
    (root / "pyproject.toml").write_text(DECLARATION + "\n# " + "x" * (65 * 1024) + "\n")
    assert resolve_in(root) is None


def test_a_pyproject_that_is_a_symlink_is_refused_evidence(tmp_path: Path) -> None:
    """The classification refuses a link where a manifest belongs, exactly as the
    ecosystem scan does, so no read follows it in or out of the repository."""
    root = seed("python-eligible", tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir(exist_ok=True)
    (outside / "pyproject.toml").write_text(DECLARATION)
    (root / "pyproject.toml").unlink()
    (root / "pyproject.toml").symlink_to(outside / "pyproject.toml")
    assert resolve_in(root) is None
    # A link that stays INSIDE the repository is refused on the same rule: what a
    # manifest is, not where it points, is what the classification answers.
    (root / "pyproject.toml").unlink()
    (root / "inner.toml").write_text(DECLARATION)
    (root / "pyproject.toml").symlink_to(root / "inner.toml")
    assert resolve_in(root) is None


def test_a_root_listing_past_the_bound_hands_off_nothing(tmp_path: Path) -> None:
    root = seed("python-eligible", tmp_path)
    for index in range(513):
        (root / f"filler-{index}").mkdir()
    assert resolve_in(root) is None


# --- unreadable eligibility state -----------------------------------------------
# Resolution runs BEFORE main() and outside its error handling, so anything that
# raises here would reach the user as a traceback where the global CLI was meant to
# run. Every read is total: refusal and unreadability are both no hand-off.


def unreadable(target: Path) -> bool:
    """Make one path unreadable, reporting whether this user can be kept out of it
    (running as root, nothing can)."""
    target.chmod(0o000)
    try:
        target.read_bytes()
        return False
    except OSError:
        return True


def test_an_unreadable_metadata_file_runs_the_global(tmp_path: Path) -> None:
    root = seed("python-eligible", tmp_path)
    site = root / ".venv" / "lib" / "python3.13" / "site-packages"
    if not unreadable(site / "leji-1.4.0.dist-info" / "METADATA"):
        pytest.skip("this user can read a 0o000 file (root)")
    assert resolve_in(root) is None


def test_an_unreadable_spec_line_runs_the_global(tmp_path: Path) -> None:
    root = seed("python-eligible", tmp_path)
    if not unreadable(root / "leji.json"):
        pytest.skip("this user can read a 0o000 file (root)")
    assert resolve_in(root) is None


def test_an_unreadable_pyproject_runs_the_global(tmp_path: Path) -> None:
    root = seed("python-eligible", tmp_path)
    if not unreadable(root / "pyproject.toml"):
        pytest.skip("this user can read a 0o000 file (root)")
    assert resolve_in(root) is None


def test_a_leji_json_that_is_a_directory_runs_the_global(tmp_path: Path) -> None:
    root = seed("python-eligible", tmp_path)
    (root / "leji.json").unlink()
    (root / "leji.json").mkdir()
    assert resolve_in(root) is None


def test_a_spec_line_linked_out_of_the_repository_is_refused(tmp_path: Path) -> None:
    root = seed("python-eligible", tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir(exist_ok=True)
    (outside / "leji.json").write_text('{"leji":"1.0"}\n')
    (root / "leji.json").unlink()
    (root / "leji.json").symlink_to(outside / "leji.json")
    assert resolve_in(root) is None


@pytest.mark.parametrize(
    "body",
    [
        json.dumps({"leji": "1.0", "pad": "x" * (65 * 1024)}),
        json.dumps({"leji": 1}),
        json.dumps(["1.0"]),
        "{ not json",
    ],
)
def test_a_spec_line_past_the_bound_or_not_a_string_is_refused(body: str, tmp_path: Path) -> None:
    root = seed("python-eligible", tmp_path)
    (root / "leji.json").write_text(body)
    assert resolve_in(root) is None


def test_the_spec_line_is_all_the_wrapper_asks_of_the_manifest(tmp_path: Path) -> None:
    """A manifest that would fail validation still names a spec line, and the hand-off
    is about which CLI answers, not about whether the layer is valid."""
    root = seed("python-eligible", tmp_path)
    (root / "leji.json").write_text(json.dumps({"leji": "1.0"}) + "\n")
    assert resolve_in(root) is not None


def test_opt_out_at_any_value(tmp_path: Path) -> None:
    root = seed("python-eligible", tmp_path)
    for value in ("", "0", "1", "no"):
        assert resolve_in(root, env={"LEJI_NO_LOCAL": value}) is None, value
    assert resolve_in(root, env={"LEJI_NO_LOCAL_OTHER": "1"}) is not None


def test_nested_cwd_is_not_the_root(tmp_path: Path) -> None:
    root = seed("python-eligible", tmp_path)
    nested = root / "docs" / "context"
    nested.mkdir(parents=True)
    assert resolve_local_cli(["--root", str(nested)], {}, HOST, NOT_SELF) is None


def test_argv_is_forwarded_verbatim(tmp_path: Path) -> None:
    root = seed("python-eligible", tmp_path)
    argv = ["start", "--root", str(root), "--json", "--", "--root", "ignored", "", " ", "ünïcødé"]
    resolved = resolve_local_cli(argv, {}, HOST, NOT_SELF)
    assert resolved is not None
    assert resolved.args == argv


def test_a_malformed_root_selects_nothing(tmp_path: Path) -> None:
    root = seed("python-eligible", tmp_path)
    for argv in (["--root"], ["--root", "--json"], ["--root", ""], ["--name", "--root", str(root)]):
        assert resolve_local_cli(argv, {}, HOST, NOT_SELF) is None, " ".join(argv)


# --- the environment rule -------------------------------------------------------
# The manager owns the environment, computed first and alone. VIRTUAL_ENV never
# selects one: an active environment is the shell's state, not this repository's.


def test_uv_project_environment_relative_to_the_root(tmp_path: Path) -> None:
    root = seed("python-uv-env-var", tmp_path)
    resolved = resolve_in(root, env={"UV_PROJECT_ENVIRONMENT": "envs/a"})
    assert resolved is not None
    assert resolved.display == "envs/a/bin/leji"
    # Without the variable the rule is `.venv`, which this fixture does not have.
    assert resolve_in(root) is None


def test_uv_project_environment_outside_the_root_is_refused(tmp_path: Path) -> None:
    root = seed("python-uv-env-var", tmp_path)
    outside = tmp_path / "outside"
    install(outside)
    assert resolve_in(root, env={"UV_PROJECT_ENVIRONMENT": str(outside)}) is None
    assert resolve_in(root, env={"UV_PROJECT_ENVIRONMENT": "../outside"}) is None


def test_virtual_env_equal_to_the_computed_env_changes_nothing(tmp_path: Path) -> None:
    root = seed("python-virtual-env-equal", tmp_path)
    resolved = resolve_in(root, env={"VIRTUAL_ENV": str(root / ".venv")})
    assert resolved is not None
    assert resolved.display == ".venv/bin/leji"


def test_virtual_env_elsewhere_inside_the_root_is_ignored(tmp_path: Path) -> None:
    """A nested environment in a monorepo is not this root's, even though it is inside
    the repository: the computed one decides, and here there is none."""
    root = seed("python-virtual-env-elsewhere-inside-root", tmp_path)
    assert resolve_in(root, env={"VIRTUAL_ENV": str(root / "nested" / ".venv")}) is None


def test_virtual_env_outside_the_root_is_ignored(tmp_path: Path) -> None:
    root = seed("python-virtual-env-outside", tmp_path)
    outside = tmp_path / "outside"
    install(outside)
    resolved = resolve_in(root, env={"VIRTUAL_ENV": str(outside)})
    assert resolved is not None
    assert resolved.display == ".venv/bin/leji", "the computed environment decides"


# --- the bounds -----------------------------------------------------------------


def add_lib_dirs(env_dir: Path, count: int, start: int = 20) -> None:
    """Extra interpreter directories, each holding one UNRELATED distribution, so the
    only thing that changes is how many directories the search would have to walk."""
    for index in range(count):
        site = env_dir / "lib" / f"python3.{start + index}" / "site-packages"
        dist = site / "other-1.0.dist-info"
        dist.mkdir(parents=True)
        (dist / "METADATA").write_text("Name: other\nVersion: 1.0\n")


def test_too_many_interpreter_directories(tmp_path: Path) -> None:
    root = seed("python-eligible", tmp_path)
    add_lib_dirs(root / ".venv", 3)  # four in total: still searched, still one match
    assert resolve_in(root) is not None
    add_lib_dirs(root / ".venv", 1, start=30)  # five: past the bound
    assert resolve_in(root) is None


def test_too_many_site_packages_entries(tmp_path: Path) -> None:
    root = seed("python-eligible", tmp_path)
    install(root / ".venv", site_entries=513)
    assert resolve_in(root) is None


def test_too_many_dist_info_candidates(tmp_path: Path) -> None:
    """Only the directories that could be this distribution are opened, so an ordinary
    environment full of other packages still answers; past the bound on THOSE, nothing
    is opened at all."""
    root = seed("python-eligible", tmp_path)
    site = root / ".venv" / "lib" / "python3.13" / "site-packages"
    for other in range(20):  # a real environment's other distributions
        add_dist_info(site, f"other{other}", f"other{other}", "1.0")
    assert resolve_in(root) is not None
    for extra in range(8):  # eight more spelled like this one, declaring something else
        add_dist_info(site, "leji", "leji-extras", f"9.{extra}")
    assert resolve_in(root) is None


def test_a_distribution_whose_dist_info_is_not_named_for_it_is_not_found(tmp_path: Path) -> None:
    """The narrowing is fail-closed: metadata declaring this distribution under some
    other directory spelling is never reached, so the global runs."""
    root = seed("python-no-env", tmp_path)
    install(root / ".venv", name="renamed", meta_name="leji")
    assert resolve_in(root) is None


def test_metadata_past_the_byte_bound(tmp_path: Path) -> None:
    root = seed("python-bounds", tmp_path)
    assert resolve_in(root) is None


# --- the Windows branch ---------------------------------------------------------


def test_windows_target_is_the_scripts_executable(tmp_path: Path) -> None:
    root = seed("python-eligible", tmp_path)
    scripts = root / ".venv" / "Scripts"
    scripts.mkdir(parents=True)
    exe = scripts / "leji.exe"
    exe.write_text(MARKER)
    exe.chmod(0o755)
    (root / ".venv" / "Lib" / "site-packages" / "leji-1.4.0.dist-info").mkdir(parents=True)
    (root / ".venv" / "Lib" / "site-packages" / "leji-1.4.0.dist-info" / "METADATA").write_text(
        "Name: leji\nVersion: 1.4.0\n"
    )
    resolved = resolve_local_cli(["--root", str(root)], {}, "win32", NOT_SELF)
    assert resolved is not None
    assert resolved.display == ".venv/Scripts/leji.exe"


def test_windows_without_the_scripts_executable_is_refused(tmp_path: Path) -> None:
    root = seed("python-eligible", tmp_path)
    assert resolve_local_cli(["--root", str(root)], {}, "win32", NOT_SELF) is None


# --- the effective root ---------------------------------------------------------


def test_effective_root_pinned_cases() -> None:
    assert effective_root([]) == "."
    assert effective_root(["validate"]) == "."
    assert effective_root(["--root", "x"]) == "x"
    assert effective_root(["--root=x"]) == "x"
    assert effective_root(["--root", "a", "--root", "b"]) == "b", "last --root wins"
    assert effective_root(["--root=a", "--root", "b"]) == "b"
    assert effective_root(["--json", "--root", "x", "validate"]) == "x"
    assert effective_root(["--topics", "a b", "--root", "x"]) == "x"
    assert effective_root(["--root", "-"]) == "-", "a bare dash is a value, not a flag"
    assert effective_root(["--", "--root", "x"]) == ".", "tokens after -- are not our flags"
    assert effective_root(["--root", "x", "--", "--root", "y"]) == "x"
    assert effective_root(["--root"]) is None, "a missing value decides nothing"
    assert effective_root(["--root", "--json"]) is None, "a flag-looking value decides nothing"
    assert effective_root(["--root", ""]) is None, "an empty value is the usage error"
    assert effective_root(["--name", "--root", "x"]) is None, "a malformed sequence decides nothing"
    assert effective_root(["--root="]) is None


def test_effective_root_agrees_with_the_parser(tmp_path: Path, capsys, monkeypatch) -> None:
    """The drift test. The parse computes its own root through argparse, so the two are
    compared where it is observable: WHICH repository the command answered about. One
    root carries a layer and the other does not, so a parse that landed on the other
    root cannot produce the same exit code. The cases that are usage errors assert the
    usage exit, which is what a None effective root means."""
    layer = tmp_path / "layer"
    shutil.copytree(REPO_ROOT / "fixtures" / "valid-minimal-core", layer)
    (layer / "expected.json").unlink(missing_ok=True)
    empty = tmp_path / "empty"
    empty.mkdir()
    cases: list[list[str]] = [
        ["validate", "--root", str(layer)],
        ["validate", f"--root={layer}"],
        ["validate", "--root", str(empty), "--root", str(layer)],
        ["validate", "--json", "--root", str(layer)],
        ["validate", "--root", str(empty)],
        ["validate", "--root"],
        ["validate", "--root", "--json"],
        ["validate", "--name", "--root", str(layer)],
    ]
    monkeypatch.chdir(empty)
    for argv in cases:
        root = effective_root(argv[1:])
        code = main(argv)
        capsys.readouterr()
        if root is None:
            expected = 2
        else:
            expected = 0 if os.path.abspath(root) == os.path.abspath(layer) else 1
        assert code == expected, f"{' '.join(argv)} (effective root {root})"


# --- the launcher's result table ------------------------------------------------


class Exited(Exception):
    """`exit` raises so the launcher's "never returns" contract is observable without
    ending the test runner."""


HANDOFF = LocalCliHandoff(
    bin="/repo/.venv/bin/leji", args=["validate", "--json"], display=".venv/bin/leji"
)


def recorder(
    platform: str = "linux",
    *,
    exec_error: Optional[OSError] = None,
    exec_returns: bool = False,
    code: int = 0,
    run_error: Optional[OSError] = None,
) -> tuple[LaunchIo, dict]:
    log: dict = {"stderr": [], "exits": [], "execs": [], "runs": []}

    def _exec(bin_path: str, args: list[str]) -> None:
        log["execs"].append((bin_path, args))
        if exec_error is not None:
            raise exec_error
        if not exec_returns:
            raise AssertionError("the default POSIX path must replace this process")

    def _run(bin_path: str, args: list[str]) -> int:
        log["runs"].append((bin_path, args))
        if run_error is not None:
            raise run_error
        return code

    def _exit(status: int) -> NoReturn:
        log["exits"].append(status)
        raise Exited(f"exit {status}")

    return (
        LaunchIo(
            platform=platform,
            exec_replace=_exec,
            run_child=_run,
            stderr=lambda line: log["stderr"].append(line),
            exit=_exit,
        ),
        log,
    )


def test_launch_posix_exec_that_returns_is_never_success() -> None:
    io, log = recorder(exec_error=None, exec_returns=True)
    with pytest.raises(Exited):
        launch_local_cli(HANDOFF, io)
    assert log["execs"] == [(HANDOFF.bin, HANDOFF.args)]
    # A replacement that returned is not success: there is no status to be.
    assert log["stderr"] == [
        "leji: cannot run the repository's Leji CLI at .venv/bin/leji: no exit status"
    ]
    assert log["exits"] == [2]


def test_launch_posix_exec_failure_fails_closed() -> None:
    io, log = recorder(exec_error=OSError(2, "No such file or directory"))
    with pytest.raises(Exited):
        launch_local_cli(HANDOFF, io)
    assert log["stderr"] == ["leji: cannot run the repository's Leji CLI at .venv/bin/leji: ENOENT"]
    assert log["exits"] == [2]


def test_launch_exec_failure_without_an_errno_still_names_it() -> None:
    io, log = recorder(exec_error=OSError("no code here"))
    with pytest.raises(Exited):
        launch_local_cli(HANDOFF, io)
    assert log["stderr"] == [
        "leji: cannot run the repository's Leji CLI at .venv/bin/leji: no code here"
    ]
    assert log["exits"] == [2]


@pytest.mark.parametrize("status", [0, 1, 2, 3, 127])
def test_launch_windows_exits_with_the_child_status(status: int) -> None:
    io, log = recorder("win32", code=status)
    with pytest.raises(Exited):
        launch_local_cli(HANDOFF, io)
    assert log["runs"] == [(HANDOFF.bin, HANDOFF.args)]
    assert log["exits"] == [status]
    assert log["stderr"] == []


def test_launch_windows_names_a_signal_and_exits_1() -> None:
    io, log = recorder("win32", code=-15)
    with pytest.raises(Exited):
        launch_local_cli(HANDOFF, io)
    assert log["stderr"] == ["leji: the repository's Leji CLI ended by SIGTERM"]
    assert log["exits"] == [1]


def test_launch_windows_run_failure_fails_closed() -> None:
    io, log = recorder("win32", run_error=OSError(13, "Permission denied"))
    with pytest.raises(Exited):
        launch_local_cli(HANDOFF, io)
    assert log["stderr"] == ["leji: cannot run the repository's Leji CLI at .venv/bin/leji: EACCES"]
    assert log["exits"] == [2]


# --- through the installed console script ---------------------------------------
# The decision table above is unit level; what is proved here is that the console
# script performs it, that a real argv survives the crossing byte for byte, and that
# the exec replacement makes the child's exit status and signal this process's own.

CONSOLE = REPO_ROOT / "packages" / "sdk-py" / ".venv" / "bin" / "leji"
console_only = pytest.mark.skipif(
    not CONSOLE.exists(), reason="the SDK's own console script is not installed"
)


def run_console(
    argv: list[str], cwd: Path, env: Optional[dict[str, str]] = None
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(CONSOLE), *argv],
        cwd=str(cwd),
        env={**os.environ, **(env or {})},
        capture_output=True,
        text=True,
        timeout=60,
    )


@console_only
def test_console_hands_off_with_the_argv_it_was_given(tmp_path: Path) -> None:
    root = seed("python-eligible", tmp_path)
    argv = ["--root", str(root), "--version"]
    result = run_console(argv, cwd=REPO_ROOT)
    assert result.stdout == marker_line(argv)
    assert result.returncode == 3, "the child status is the one that surfaces"
    assert result.stderr == ""


@console_only
def test_console_forwards_every_argument_shape(tmp_path: Path) -> None:
    root = seed("python-eligible", tmp_path)
    argv = ["start", "--root", str(root), "--json", "--", "--root", "x", "", "  ", "ünïcødé", "--"]
    assert run_console(argv, cwd=REPO_ROOT).stdout == marker_line(argv)


@console_only
def test_console_uses_the_cwd_and_never_walks_up(tmp_path: Path) -> None:
    root = seed("python-eligible", tmp_path)
    assert run_console(["--version"], cwd=root).stdout == marker_line(["--version"])
    nested = root / "docs" / "context"
    nested.mkdir(parents=True)
    assert run_console(["--version"], cwd=nested).stdout == f"{SDK_VERSION}\n"


@console_only
def test_console_opt_out_runs_the_global(tmp_path: Path) -> None:
    root = seed("python-eligible", tmp_path)
    for value in ("", "0", "1"):
        result = run_console(["--version"], cwd=root, env={"LEJI_NO_LOCAL": value})
        assert result.stdout == f"{SDK_VERSION}\n", value
        assert result.returncode == 0


@console_only
def test_console_runs_the_global_where_the_repository_does_not_qualify(tmp_path: Path) -> None:
    for name in ("python-undeclared", "python-no-env", "python-below-minimum", "go-tool"):
        root = tmp_path / name
        if name == "go-tool":
            shutil.copytree(FIXTURES / name, root)
        else:
            root = seed(name, tmp_path / name)
        result = run_console(["--version"], cwd=root)
        assert result.stdout == f"{SDK_VERSION}\n", name
        assert result.stderr == "", name
        assert result.returncode == 0, name


@console_only
def test_console_in_the_sdks_own_checkout_runs_itself(tmp_path: Path) -> None:
    """The SDK's own `.venv` is not a fixture: this package declares no Leji dependency
    of its own and carries no layer manifest, so running the tests from here hands off
    nothing. Were it ever eligible, the target would BE this script and the recursion
    guard would refuse it."""
    result = run_console(["--version"], cwd=REPO_ROOT / "packages" / "sdk-py")
    assert result.stdout == f"{SDK_VERSION}\n"
    assert result.returncode == 0


@console_only
def test_console_runs_the_global_on_unreadable_eligibility_state(tmp_path: Path) -> None:
    """Through the real script: an unreadable file on the resolution path prints the
    global's answer, not a traceback."""
    for index, relative in enumerate(
        (
            "leji.json",
            "pyproject.toml",
            ".venv/lib/python3.13/site-packages/leji-1.4.0.dist-info/METADATA",
        )
    ):
        root = seed("python-eligible", tmp_path / f"unreadable{index}")
        if not unreadable(root / relative):
            pytest.skip("this user can read a 0o000 file (root)")
        result = run_console(["--version"], cwd=root)
        assert result.stdout == f"{SDK_VERSION}\n", relative
        assert result.stderr == "", relative
        assert result.returncode == 0, relative


@console_only
def test_console_fails_closed_when_the_target_cannot_run(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    shutil.copytree(FIXTURES / "python-eligible", root)
    install(root / ".venv", body=UNRUNNABLE)
    result = run_console(["validate"], cwd=root)
    assert result.returncode == 2
    assert result.stdout == ""
    assert result.stderr.startswith(
        "leji: cannot run the repository's Leji CLI at .venv/bin/leji: "
    )


@console_only
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX signal semantics")
def test_console_ends_by_the_childs_signal(tmp_path: Path) -> None:
    """With `execv` the parent IS the child, so a child that dies by a signal ends this
    process by that signal with nothing to forward."""
    root = tmp_path / "repo"
    shutil.copytree(FIXTURES / "python-eligible", root)
    install(
        root / ".venv",
        body=f"#!{sys.executable}\nimport os, signal\nos.kill(os.getpid(), signal.SIGTERM)\n",
    )
    result = run_console(["validate"], cwd=root)
    assert result.returncode == -signal_number()


def signal_number() -> int:
    import signal as _signal

    return int(_signal.SIGTERM)
