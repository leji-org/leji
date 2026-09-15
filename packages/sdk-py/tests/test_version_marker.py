"""The build marker on source-checkout builds, mirroring
packages/sdk/test/version-marker.test.ts.

``--version``, ``-v`` and ``version`` print ``X.Y.Z+dev.<sha7>`` when the CLI runs
from a source checkout, ``X.Y.Z+dev`` when that checkout's revision cannot be read,
and the bare ``X.Y.Z`` otherwise. For Python a checkout is an editable install, which
is exactly what this repository's own venv is, so the success case runs against the
real installation; the other cases are the installer metadata this venv cannot have
at the same time, injected.
"""

import json
import re
import subprocess
from pathlib import Path

import pytest

from leji import gitutil, schemas
from leji.cli import main
from leji.schemas import SDK_VERSION, display_version

REPO_ROOT = Path(__file__).resolve().parents[3]


class _Distribution:
    """A stand-in for ``importlib.metadata.distribution("leji")`` whose only job is
    to answer ``read_text``: the classification reads nothing else."""

    def __init__(self, direct_url: object) -> None:
        self._direct_url = direct_url

    def read_text(self, filename: str) -> object:
        if filename != "direct_url.json":
            return None
        return self._direct_url


def _metadata(monkeypatch, direct_url: object) -> None:
    monkeypatch.setattr(schemas, "distribution", lambda name: _Distribution(direct_url))


def test_editable_install_prints_the_marker() -> None:
    head = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "rev-parse", "--short=7", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    printed = display_version()
    assert re.fullmatch(r"\d+\.\d+\.\d+\+dev\.[0-9a-f]{7}", printed), printed
    assert printed == f"{SDK_VERSION}+dev.{head}"


def test_cli_version_paths_print_the_marker(capsys) -> None:
    expected = display_version()
    for argv in (["--version"], ["-v"], ["version"]):
        assert main(argv) == 0
        assert capsys.readouterr().out == f"{expected}\n", argv


def test_editable_install_whose_revision_cannot_be_read_prints_dev(monkeypatch) -> None:
    # The layout says checkout, git cannot say which revision: the case the bare
    # `+dev` fallback exists for.
    monkeypatch.setattr(schemas, "git_short_revision", lambda root, timeout: None)
    assert display_version() == f"{SDK_VERSION}+dev"


def test_install_without_direct_url_prints_the_bare_version(monkeypatch) -> None:
    # A wheel from an index: the installer records no direct URL at all.
    _metadata(monkeypatch, None)
    assert display_version() == SDK_VERSION


def test_non_editable_direct_url_prints_the_bare_version(monkeypatch) -> None:
    # A wheel built from a local path DOES carry direct_url.json. The editable flag,
    # not the file's presence, is what classifies the install.
    _metadata(monkeypatch, json.dumps({"url": f"file://{REPO_ROOT}", "dir_info": {}}))
    assert display_version() == SDK_VERSION
    _metadata(
        monkeypatch,
        json.dumps({"url": f"file://{REPO_ROOT}", "dir_info": {"editable": False}}),
    )
    assert display_version() == SDK_VERSION


def test_unreadable_metadata_prints_the_bare_version(monkeypatch) -> None:
    # Nothing about a version line is worth an exception reaching the user.
    _metadata(monkeypatch, "{not json")
    assert display_version() == SDK_VERSION

    def raises(name: str) -> object:
        raise OSError("metadata unreadable")

    monkeypatch.setattr(schemas, "distribution", raises)
    assert display_version() == SDK_VERSION


def test_malformed_url_authority_prints_the_bare_version(monkeypatch) -> None:
    # `urlsplit` raises on a URL whose authority cannot be parsed. An installer would
    # not write one, but the metadata is a file on disk that anything may have edited,
    # and a version line is not the place to learn that.
    _metadata(monkeypatch, json.dumps({"url": "file://[", "dir_info": {"editable": True}}))
    assert display_version() == SDK_VERSION


def test_deeply_nested_metadata_prints_the_bare_version(monkeypatch) -> None:
    # The JSON decoder raises RecursionError on a document nested past its own limit,
    # and a RecursionError is a RuntimeError, not a ValueError. The detector answers
    # "not a checkout" for everything it cannot parse, whatever the parser raises.
    _metadata(monkeypatch, "[" * 100_000)
    assert display_version() == SDK_VERSION


def test_a_git_runner_that_raises_prints_dev(monkeypatch) -> None:
    # The other half of the contract: the subprocess call failing in a way nothing
    # anticipated is still just "the revision could not be read". RuntimeError is
    # neither SubprocessError nor OSError nor ValueError, so only the class-closing
    # clause catches it.
    def boom(*args, **kwargs):
        raise RuntimeError("subprocess exploded")

    monkeypatch.setattr(gitutil.subprocess, "run", boom)
    assert gitutil.git_short_revision(str(REPO_ROOT), 2) is None
    assert display_version() == f"{SDK_VERSION}+dev"


def test_file_url_paths_this_treats_as_local() -> None:
    # An empty authority and `localhost` are this machine; a host is not, and a host
    # silently dropped would turn `file://server/share` into the unrelated `/share`.
    assert schemas._file_url_path("file:///tmp/leji") == "/tmp/leji"
    assert schemas._file_url_path("file://localhost/tmp/leji") == "/tmp/leji"
    assert schemas._file_url_path("file:///tmp/a%20b") == "/tmp/a b"
    assert schemas._file_url_path("file:///C:/src/leji") == "C:/src/leji"
    assert schemas._file_url_path("file://server/share") is None


def test_url_path_that_cannot_be_an_argument_prints_dev(monkeypatch) -> None:
    # The metadata classifies as editable, so the install IS a checkout; the anchor it
    # names carries a NUL once decoded, which no argument can spell. The revision
    # cannot be read, which is the documented `+dev` case, not a traceback.
    _metadata(
        monkeypatch,
        json.dumps({"url": "file:///tmp/le%00ji", "dir_info": {"editable": True}}),
    )
    assert display_version() == f"{SDK_VERSION}+dev"


# Every metadata shape above, asserted through the command rather than the function:
# what must not happen is a traceback reaching the user, and only the CLI path proves
# the exit code that goes with it.
_MALFORMED = {
    "no-direct-url": None,
    "not-json": "{not json",
    "not-an-object": "[]",
    "no-dir-info": json.dumps({"url": "file:///tmp/x"}),
    "not-editable": json.dumps({"url": "file:///tmp/x", "dir_info": {"editable": False}}),
    "url-not-a-string": json.dumps({"url": 7, "dir_info": {"editable": True}}),
    "url-not-a-file-url": json.dumps({"url": "https://x/y", "dir_info": {"editable": True}}),
    "malformed-authority": json.dumps({"url": "file://[", "dir_info": {"editable": True}}),
    "nul-in-path": json.dumps({"url": "file:///tmp/le%00ji", "dir_info": {"editable": True}}),
    "remote-authority": json.dumps({"url": "file://server/share", "dir_info": {"editable": True}}),
    # Nesting deep enough that the JSON decoder gives up on its own recursion limit
    # rather than on the document: a RecursionError, which is not a ValueError.
    "recursion": "[" * 100_000,
}


@pytest.mark.parametrize("name", sorted(_MALFORMED))
def test_cli_version_exits_zero_on_every_malformed_metadata_shape(
    monkeypatch, capsys, name
) -> None:
    _metadata(monkeypatch, _MALFORMED[name])
    assert main(["--version"]) == 0, name
    printed = capsys.readouterr().out.strip()
    assert printed in (SDK_VERSION, f"{SDK_VERSION}+dev"), f"{name}: {printed}"


# --- the revision lookup answers for the directory it was given ---------------
# Git honors GIT_DIR over the `-C <root>` on the command line, so a shell that
# exports one (a hook, a wrapper, an editor's terminal) would otherwise hand this
# checkout's version line another repository's revision.


def _other_repo(tmp_path: Path) -> Path:
    """A second, unrelated git repository with one commit of its own."""
    root = tmp_path / "other"
    root.mkdir()
    (root / "README.md").write_text("other\n")

    def run(*a: str) -> None:
        subprocess.run(["git", "-C", str(root), *a], check=True, capture_output=True)

    run("init", "-q")
    run("add", "-A")
    run("-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-qm", "seed")
    return root


def test_git_dir_naming_another_repository_does_not_answer(monkeypatch, tmp_path) -> None:
    other = _other_repo(tmp_path)
    other_head = subprocess.run(
        ["git", "-C", str(other), "rev-parse", "--short=7", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    expected = display_version()
    assert expected != f"{SDK_VERSION}+dev.{other_head}", "the two repositories share a HEAD"
    monkeypatch.setenv("GIT_DIR", str(other / ".git"))
    assert display_version() == expected


def test_git_dir_naming_nothing_does_not_answer(monkeypatch) -> None:
    expected = display_version()
    monkeypatch.setenv("GIT_DIR", "/nonexistent/repository.git")
    assert display_version() == expected


def test_no_git_environment_variable_redirects_the_lookup(monkeypatch, tmp_path) -> None:
    # GIT_DIR is one name among many, and git keeps adding them: GIT_REFERENCE_BACKEND
    # redirects the ref store by URI and overrides configuration, so it answers with
    # another repository's HEAD from the same `-C` directory. The lookup keeps no GIT_*
    # variable that can do that, so neither name (nor the next one) reaches git.
    other = _other_repo(tmp_path)
    expected = display_version()
    monkeypatch.setenv("GIT_REFERENCE_BACKEND", f"files://{other}/.git")
    monkeypatch.setenv("GIT_DIR", str(other / ".git"))
    assert display_version() == expected


def test_git_ceiling_directories_above_the_checkout_still_answers(monkeypatch) -> None:
    # The two variables the lookup keeps cannot change WHICH repository answers.
    # A ceiling above the checkout does not stop a search that starts inside it.
    expected = display_version()
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(REPO_ROOT.parent))
    assert display_version() == expected
