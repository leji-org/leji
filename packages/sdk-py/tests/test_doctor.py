"""`leji doctor` end to end, mirroring packages/sdk/test/proc/doctor.test.ts.

The report `leji start` prints before it launches, as a command of its own. The central
cases run both commands on the same inputs (the same seeded root from
fixtures/start-preflight/, the same stub PATH, a non-TTY so start launches nothing) and
compare what they print. Everything outside the repository is a stub, as in
test_start_preflight.py."""

from __future__ import annotations

import hashlib
import io
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from helpers.copytree import copy_tree
from leji.cli import main

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "fixtures" / "start-preflight"

VERSION_STUB = "echo 1.4.0"
LAUNCH_SENTENCE = " The agent starts either way."
# How every question the CLI asks ends: `<question> [<default>]: `.
PROMPT = re.compile(r"\[[^\]\n]*\]: ")


def _git_bin() -> str:
    """The real git binary, the one program these runs cannot stub: the hook check asks
    git where hooks live."""
    found = shutil.which("git")
    if found is None:
        pytest.skip("git not available")
    return found


def _stubs(tmp_path: Path, spec: dict[str, str]) -> str:
    """A directory of executable stubs plus a link to the real git: the WHOLE PATH of
    every run below, so detection finds exactly what a case declares."""
    stub_dir = tmp_path / "stubs"
    stub_dir.mkdir(exist_ok=True)
    for bin_name, body in spec.items():
        path = stub_dir / bin_name
        path.write_text(f"#!/bin/sh\n{body}\n")
        path.chmod(0o755)
    link = stub_dir / "git"
    if not link.exists():
        link.symlink_to(_git_bin())
    return str(stub_dir)


def _fixture(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    stubs: dict[str, str],
    shim: str = VERSION_STUB,
) -> str:
    """One seeded root from fixtures/start-preflight/, committed, with the environment
    the case declares. A root that declares the CLI gets the bin shim its install would
    have produced, which is what makes the `cli` row `ok`: the probe executes that shim
    directly and it answers 1.4.0. `shim` replaces its body (a case that records the
    probe)."""
    root = tmp_path / "repo"
    copy_tree(FIXTURES / name, root)
    pkg = root / "package.json"
    if pkg.exists() and "@leji-org/leji" in pkg.read_text():
        bin_dir = root / "node_modules" / ".bin"
        bin_dir.mkdir(parents=True)
        shim_path = bin_dir / "leji"
        shim_path.write_text(f"#!/bin/sh\n{shim}\n")
        shim_path.chmod(0o755)
    monkeypatch.setenv("PATH", _stubs(tmp_path, stubs))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    (tmp_path / "home").mkdir(exist_ok=True)
    run = lambda *a: subprocess.run(  # noqa: E731
        ["git", *a], cwd=str(root), check=True, capture_output=True
    )
    run("init", "-q")
    run("add", "-A")
    run("-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-qm", "seed")
    return str(root)


def _ready(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys) -> str:
    """The ready state test_start_preflight.py uses: the CLI declared and answering,
    the host reporting the server registered, `.mcp.json` committed, and the clone hook
    installed."""
    root = _fixture(
        tmp_path, monkeypatch, "node-mcp-json", {"leji": VERSION_STUB, "claude": "exit 0"}
    )
    assert _run(capsys, ["ci", "--hooks", "--root", root])[0] == 0
    return root


def _run(capsys, argv: list[str]) -> tuple[int, str, str]:
    code = main(argv)
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def _doc(out: str) -> dict:
    parsed = json.loads(out)
    assert isinstance(parsed, dict)
    return parsed


def _above_launch(stdout: str) -> str:
    """Start's output above its launch line: the Setup block, as start printed it."""
    cut = stdout.find("No coding agent was launched.")
    assert cut > 0, f"start printed its entry instructions: {stdout}"
    return stdout[:cut].rstrip() + "\n"


def _assert_same_block(doctor: str, start: str) -> None:
    """Doctor's block equals start's, line for line, except the closing line, which is
    start's with the agent sentence removed."""
    d = doctor.split("\n")
    s = _above_launch(start).split("\n")
    assert len(d) == len(s), f"same number of lines:\n{doctor}\n---\n{start}"
    closing = len(d) - 2  # the last element is the empty string after the final newline
    assert d[:closing] == s[:closing], "every line above the closing line is identical"
    assert s[closing].endswith(LAUNCH_SENTENCE), s[closing]
    assert d[closing] == s[closing][: -len(LAUNCH_SENTENCE)], "only the sentence is dropped"
    assert d[closing + 1] == ""


# --- doctor against start, on identical inputs ------------------------------------------


def test_doctor_prints_start_block_except_the_closing_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    # One host reporting the server unregistered, no `.mcp.json`, no hook: a fix for this
    # user and one for a maintainer, so the closing line has both counts.
    root = _fixture(
        tmp_path, monkeypatch, "node-declared", {"leji": VERSION_STUB, "claude": "exit 1"}
    )
    start_code, start_out, start_err = _run(capsys, ["start", "--root", root])
    doctor_code, doctor_out, _ = _run(capsys, ["doctor", "--root", root])
    assert start_code == 0, start_err
    assert doctor_code == 1, "the clone is not ready"
    _assert_same_block(doctor_out, start_out)
    assert "\n  2 fixes for you, 1 for a maintainer.\n" in doctor_out


def test_doctor_json_is_start_json_apart_from_command(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    root = _fixture(
        tmp_path, monkeypatch, "node-declared", {"leji": VERSION_STUB, "claude": "exit 1"}
    )
    start_code, start_out, start_err = _run(capsys, ["start", "--root", root, "--json"])
    doctor_code, doctor_out, _ = _run(capsys, ["doctor", "--root", root, "--json"])
    assert start_code == 0, start_err
    assert doctor_code == 1, "the exit status agrees with `ready`"
    assert doctor_out == start_out.replace('"command": "start"', '"command": "doctor"')
    doc = _doc(doctor_out)
    assert (doc["command"], doc["ok"], doc["ready"]) == ("doctor", True, False)


def test_several_hosts_both_comparisons_hold_and_the_unresolved_fix_is_starts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    root = _fixture(
        tmp_path,
        monkeypatch,
        "node-declared",
        {"leji": VERSION_STUB, "claude": "exit 1", "codex": "exit 1"},
    )
    _, start_out, _ = _run(capsys, ["start", "--root", root])
    doctor_code, doctor_out, _ = _run(capsys, ["doctor", "--root", root])
    assert doctor_code == 1
    _assert_same_block(doctor_out, start_out)
    assert "\n        $ leji start --agent <name>\n" in doctor_out

    _, start_json, _ = _run(capsys, ["start", "--root", root, "--json"])
    _, doctor_json, _ = _run(capsys, ["doctor", "--root", root, "--json"])
    assert doctor_json == start_json.replace('"command": "start"', '"command": "doctor"')
    mcp = next(c for c in _doc(doctor_json)["checks"] if c["id"] == "mcp")
    assert mcp["status"] == "unresolved"
    assert mcp["fix"] == ["leji start --agent <name>"]


# --- what doctor does on its own --------------------------------------------------------


def test_doctor_offers_nothing_and_launches_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    root = _fixture(
        tmp_path, monkeypatch, "node-declared", {"leji": VERSION_STUB, "claude": "exit 1"}
    )
    _, out, _ = _run(capsys, ["doctor", "--root", root])
    assert "Setup for this clone" in out
    assert "No coding agent was launched." not in out, "no entry instructions"
    assert "Starting " not in out, "no launch"
    assert "Register the Leji MCP server" not in out, "no MCP offer"
    assert "Install the pre-commit hook" not in out, "no hook offer"
    assert "either way" not in out, "no promise about an agent"


def test_doctor_exits_1_on_a_clone_with_no_hook_in_both_modes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    root = _fixture(tmp_path, monkeypatch, "node-declared", {"leji": VERSION_STUB})
    code, out, err = _run(capsys, ["doctor", "--root", root])
    assert code == 1, err
    assert "\n  you   Git hook    none yet (per clone)\n" in out
    assert "\n  1 fix for you.\n" in out
    code, out, _ = _run(capsys, ["doctor", "--root", root, "--json"])
    assert code == 1
    assert _doc(out)["ready"] is False


def test_doctor_exits_0_on_a_ready_clone_in_both_modes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    root = _ready(tmp_path, monkeypatch, capsys)
    code, out, err = _run(capsys, ["doctor", "--root", root, "--json"])
    assert code == 0, err
    doc = _doc(out)
    assert doc["ready"] is True
    assert [c["status"] for c in doc["checks"]] == ["ok", "ok", "ok", "ok"]
    # The `cli` row is `ok` because the declared CLI resolves in this context layer: the
    # probe runs the installed shim, not whatever `leji` the machine has.
    assert doc["checks"][0]["detail"] == "1.4.0 (node_modules/.bin/leji)"
    code, out, err = _run(capsys, ["doctor", "--root", root])
    assert code == 0, err
    assert "\n  Setup complete.\n" in out


def test_doctor_agent_bogus_is_a_usage_error_in_both_modes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    root = _fixture(tmp_path, monkeypatch, "node-declared", {"leji": VERSION_STUB})
    for extra in ([], ["--json"]):
        code, out, err = _run(capsys, ["doctor", "--root", root, "--agent", "bogus", *extra])
        assert code == 2, extra
        assert "--agent must be a launchable host" in err
        assert out.strip() == "", "nothing is reported for a rejected argument"


def test_doctor_boot_missing_exits_1_in_both_modes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    root = _fixture(tmp_path, monkeypatch, "node-declared", {"leji": VERSION_STUB})
    (Path(root) / "docs" / "boot-profile.md").unlink()
    code, out, _ = _run(capsys, ["doctor", "--root", root, "--json"])
    assert code == 1
    doc = _doc(out)
    assert list(doc.keys()) == ["command", "ok", "ready", "error", "checks", "ecosystem"]
    assert (doc["command"], doc["ok"], doc["ready"], doc["error"], doc["checks"]) == (
        "doctor",
        False,
        False,
        "boot-missing",
        [],
    )
    code, out, err = _run(capsys, ["doctor", "--root", root])
    assert code == 1
    assert "boot profile docs/boot-profile.md is missing or invalid; run leji validate" in err
    assert out == "", "no block for a context layer with nothing to enter"


def test_doctor_no_manifest_is_the_findings_envelope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    root = tmp_path / "bare"
    root.mkdir()
    monkeypatch.setenv("PATH", _stubs(tmp_path, {}))
    monkeypatch.setenv("HOME", str(tmp_path))
    code, out, _ = _run(capsys, ["doctor", "--root", str(root), "--json"])
    assert code == 1
    doc = _doc(out)
    assert doc["command"] == "doctor"
    assert doc["ok"] is False
    assert isinstance(doc["findings"], list)


def test_doctor_rejects_undeclared_flags_yes_included(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    root = _fixture(tmp_path, monkeypatch, "node-declared", {"leji": VERSION_STUB})
    for flag in ("--yes", "-y", "--dry-run", "--strict", "--", "--frobnicate"):
        code, out, err = _run(capsys, ["doctor", "--root", root, flag])
        assert code == 2, f"{flag}: {out}{err}"
        assert "Setup for this clone" not in out, f"{flag} runs nothing"


# --- a terminal: never a prompt, never a write ------------------------------------------


class _Terminal(io.StringIO):
    """Stdin reporting a terminal: the one input `start` reads to decide it may prompt,
    offer, and launch. Every line it gives is Enter (a question's default), so a
    regression that asks one fails on the assertions below instead of waiting on input."""

    def __init__(self) -> None:
        super().__init__("\n" * 16)

    def isatty(self) -> bool:
        return True


def _recording(log: Path, name: str, then: str) -> str:
    """A stub body that appends its own argv to `log` before answering."""
    return f"echo \"{name} $*\" >> '{log}'\n{then}"


def _snapshot(root: str) -> list[tuple[str, str]]:
    """Every file under root, `.git` included (the clone hook lives there): relpath and
    sha256."""
    base = Path(root)
    return sorted(
        (str(p.relative_to(base)), hashlib.sha256(p.read_bytes()).hexdigest())
        for p in base.rglob("*")
        if p.is_file()
    )


def test_on_a_terminal_with_two_hosts_and_no_agent_doctor_prompts_for_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    log = tmp_path / "calls"
    root = _fixture(
        tmp_path,
        monkeypatch,
        "node-declared",
        {
            "leji": VERSION_STUB,
            "claude": _recording(log, "claude", "exit 1"),
            "codex": _recording(log, "codex", "exit 1"),
        },
        shim=_recording(log, "shim", VERSION_STUB),
    )
    monkeypatch.setattr(sys, "stdin", _Terminal())
    code, out, err = _run(capsys, ["doctor", "--root", root])
    assert code == 1, err
    # A host prompt would print its question and then resolve a host; neither happened.
    assert not PROMPT.search(out), f"no prompt was printed: {out}"
    assert "\n  you   MCP server  pick one: Claude Code, Codex\n" in out
    # The only subprocess a stub saw is the version probe: no host was picked, so no
    # registration was queried, and nothing was registered or launched.
    assert log.read_text().split("\n")[:-1] == ["shim --version"]


def test_on_a_terminal_with_one_host_doctor_queries_and_offers_nothing_more(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    # The state where `start` on a terminal offers both personal fixes: the host
    # registration and the clone hook.
    log = tmp_path / "calls"
    root = _fixture(
        tmp_path,
        monkeypatch,
        "node-declared",
        {"leji": VERSION_STUB, "claude": _recording(log, "claude", "exit 1")},
        shim=_recording(log, "shim", VERSION_STUB),
    )
    before = _snapshot(root)
    monkeypatch.setattr(sys, "stdin", _Terminal())
    code, out, err = _run(capsys, ["doctor", "--root", root])
    assert code == 1, err
    assert not PROMPT.search(out), f"no offer was printed: {out}"
    assert "\n  you   MCP server  not registered for Claude Code\n" in out
    # The version probe and the host's registration query, and nothing else: no
    # `claude mcp add`, and no launch.
    assert log.read_text().split("\n")[:-1] == ["shim --version", "claude mcp get leji"]
    assert _snapshot(root) == before, "the tree, .git included, is byte-identical"
