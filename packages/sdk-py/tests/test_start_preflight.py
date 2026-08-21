"""`leji start` end to end, through the real command surface, mirroring
packages/sdk/test/proc/start.test.ts.

Everything the command could reach outside the repository is a stub on a synthetic
PATH: the CLI it probes, the agent host binaries, and the host commands it would run.
Nothing real is launched or installed here, and the runs are non-interactive (pytest's
stdin is not a TTY), so no prompt can fire either."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
import pytest

from leji.cli import main

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "fixtures" / "start-preflight"

VERSION_STUB = "echo 1.4.0"


def _git_bin() -> str:
    """The real git binary, the one program these runs cannot stub: the hook check asks
    git where hooks live."""
    found = shutil.which("git")
    if found is None:
        pytest.skip("git not available")
    return found


def _stubs(tmp_path: Path, spec: dict[str, str], name: str = "stubs") -> str:
    """A directory of executable stubs plus a link to the real git. It is the WHOLE
    PATH of every run below, so what host detection finds is exactly what a case
    declares and never whatever the machine running the suite has installed."""
    stub_dir = tmp_path / name
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
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str, stubs: dict[str, str]
) -> str:
    """One seeded joiner root from fixtures/start-preflight/, committed, with the
    environment the case declares."""
    root = tmp_path / "repo"
    shutil.copytree(FIXTURES / name, root)
    # What the manager's own install would have produced for a Node repository that
    # declares the CLI. The probe executes this file directly; no `npx`/`pnpm exec` stub
    # exists, and none is needed.
    pkg = root / "package.json"
    if pkg.exists() and "@leji-org/leji" in pkg.read_text():
        bin_dir = root / "node_modules" / ".bin"
        bin_dir.mkdir(parents=True)
        shim = bin_dir / "leji"
        shim.write_text(f"#!/bin/sh\n{VERSION_STUB}\n")
        shim.chmod(0o755)
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


def _run(capsys, argv: list[str]) -> tuple[int, str, str]:
    code = main(argv)
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def _doc(out: str) -> dict:
    parsed = json.loads(out)
    assert isinstance(parsed, dict)
    return parsed


def test_start_prints_the_setup_block_before_the_entry_instructions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    root = _fixture(tmp_path, monkeypatch, "node-declared", {"leji": VERSION_STUB})
    code, out, err = _run(capsys, ["start", "--root", root])
    assert code == 0, err
    setup = out.index("Setup for this clone")
    entry = out.index("No coding agent was launched.")
    assert entry > setup, out
    assert "Starting " not in out, "a non-interactive run never launches a host"
    assert "\n  ok    Leji CLI    1.4.0 (node_modules/.bin/leji)\n" in out
    assert "\n  n/a   MCP server  no coding agent detected\n" in out
    assert "\n  you   Git hook    none yet (per clone)\n" in out
    assert "\n        $ leji ci --hooks\n" in out
    assert "\n  1 fix for you. The agent starts either way.\n" in out
    assert "\x1b" not in out, "a piped run carries no escape"


def test_start_undeclared_repository_reports_a_shared_gap_at_exit_zero(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    root = _fixture(tmp_path, monkeypatch, "node-undeclared", {"leji": VERSION_STUB})
    code, out, err = _run(capsys, ["start", "--root", root])
    assert code == 0, err
    assert "\n  team  Leji CLI    not declared" in out
    assert "\n        $ npm i -D @leji-org/leji\n" in out


def test_start_json_is_one_report_only_document(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    root = _fixture(
        tmp_path,
        monkeypatch,
        "node-declared",
        {"leji": VERSION_STUB, "claude": "exit 1"},
    )
    code, out, err = _run(capsys, ["start", "--root", root, "--json"])
    assert code == 0, err
    doc = _doc(out)
    assert list(doc.keys()) == ["command", "ok", "ready", "checks", "ecosystem"]
    assert (doc["command"], doc["ok"], doc["ready"]) == ("start", True, False)
    assert [c["id"] for c in doc["checks"]] == ["cli", "mcp", "mcp-shared", "hook"]
    for check in doc["checks"]:
        assert list(check.keys()) == ["id", "status", "detail", "fix"]
    assert [c["status"] for c in doc["checks"]] == ["ok", "missing", "shared-gap", "missing"]
    assert doc["checks"][1]["fix"] == ["claude mcp add leji --scope user -- npx -y @leji-org/mcp"]
    assert doc["ecosystem"]["selected"]["manager"] == "npm"
    assert "Setup for this clone" not in out


def test_start_json_reports_ready_once_the_personal_gaps_are_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    root = _fixture(
        tmp_path,
        monkeypatch,
        "node-mcp-json",
        {"leji": VERSION_STUB, "claude": "exit 0"},
    )
    assert _run(capsys, ["ci", "--hooks", "--root", root])[0] == 0
    code, out, err = _run(capsys, ["start", "--root", root, "--json"])
    assert code == 0, err
    doc = _doc(out)
    assert doc["ready"] is True
    assert [c["status"] for c in doc["checks"]] == ["ok", "ok", "ok", "ok"]


def test_start_json_several_hosts_and_no_agent_is_unresolved(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    root = _fixture(
        tmp_path,
        monkeypatch,
        "node-declared",
        {"leji": VERSION_STUB, "claude": "exit 1", "codex": "exit 1"},
    )
    code, out, _err = _run(capsys, ["start", "--root", root, "--json"])
    assert code == 0
    doc = _doc(out)
    mcp = next(c for c in doc["checks"] if c["id"] == "mcp")
    assert mcp["status"] == "unresolved"
    assert mcp["fix"] == ["leji start --agent <name>"]
    assert next(c for c in doc["checks"] if c["id"] == "mcp-shared")["status"] == "n/a"


def test_start_json_agent_pins_the_host_the_mcp_rows_answer_for(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    root = _fixture(
        tmp_path,
        monkeypatch,
        "node-declared",
        {"leji": VERSION_STUB, "claude": "exit 1", "codex": "exit 1"},
    )
    code, out, _err = _run(capsys, ["start", "--root", root, "--agent", "claude-code", "--json"])
    assert code == 0
    doc = _doc(out)
    assert next(c for c in doc["checks"] if c["id"] == "mcp")["status"] == "missing"
    assert next(c for c in doc["checks"] if c["id"] == "mcp-shared")["status"] == "shared-gap"


def test_start_agent_bogus_json_is_a_usage_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    root = _fixture(tmp_path, monkeypatch, "node-declared", {"leji": VERSION_STUB})
    code, out, err = _run(capsys, ["start", "--root", root, "--agent", "bogus", "--json"])
    assert code == 2
    assert "--agent must be a launchable host" in err
    assert out.strip() == "", "no document is emitted for a rejected argument"


def test_start_json_boot_missing_is_the_error_document(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    root = _fixture(tmp_path, monkeypatch, "node-declared", {"leji": VERSION_STUB})
    (Path(root) / "docs" / "boot-profile.md").unlink()
    code, out, _err = _run(capsys, ["start", "--root", root, "--json"])
    assert code == 1
    doc = _doc(out)
    assert list(doc.keys()) == ["command", "ok", "ready", "error", "checks", "ecosystem"]
    assert (doc["ok"], doc["ready"], doc["error"], doc["checks"]) == (
        False,
        False,
        "boot-missing",
        [],
    )


def test_start_no_manifest_is_the_findings_envelope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    root = tmp_path / "bare"
    root.mkdir()
    monkeypatch.setenv("PATH", _stubs(tmp_path, {}))
    monkeypatch.setenv("HOME", str(tmp_path))
    code, out, _err = _run(capsys, ["start", "--root", str(root), "--json"])
    assert code == 1
    doc = _doc(out)
    assert doc["command"] == "start"
    assert doc["ok"] is False
    assert isinstance(doc["findings"], list)
