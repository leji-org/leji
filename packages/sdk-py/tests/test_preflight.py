"""`leji start` preflight tests, mirroring packages/sdk/test/preflight.test.ts: the
report is read-only, every probe failure fails closed, and only per-clone or per-user
state is ever offered."""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path
from typing import Optional

import pytest

from leji.detect import DetectedHost
from leji.ecosystem import detect_ecosystem
from leji.init_cmd import (
    HandoffIO,
    _capture_run,
    LaunchResult,
    RunOptions,
    StartHost,
    ensure_local_hook,
    hook_status,
)
from leji.preflight import (
    Check,
    _node_bin_dir,
    PreflightResult,
    check_document,
    color_decision,
    offer_preflight_fixes,
    render_preflight,
    run_preflight,
)

MANIFEST = {"leji": "1.0", "rootPath": "docs/", "bootProfilePath": "docs/boot-profile.md"}

CLAUDE_HOST = StartHost(id="claude-code", bin="claude", name="Claude Code")
CODEX_HOST = StartHost(id="codex", bin="codex", name="Codex")


def host(host_id: str, name: str) -> DetectedHost:
    return DetectedHost(
        id=host_id,
        name=name,
        strength="confirmed",
        on_path=True,
        in_repo=False,
        user_config=False,
        adapter=None,
    )


DETECTED_CLAUDE = host("claude-code", "Claude Code")
DETECTED_CODEX = host("codex", "Codex")
DETECTED_CURSOR = host("cursor", "Cursor")
DETECTED_COPILOT = host("copilot", "GitHub Copilot")


def install_node_bin(root: str) -> str:
    """The bin shim a Node package manager's install puts in the tree. The probe executes
    this file directly, so every Node case that expects a version has to have it."""
    bin_dir = Path(root) / "node_modules" / ".bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    shim = bin_dir / "leji"
    shim.write_text("#!/bin/sh\necho 1.4.0\n")
    shim.chmod(0o755)
    return str(shim)


def git_layer(tmp_path: Path, name: str = "repo") -> str:
    """A committed example layer in its own git repository: the shape every hook class
    is derived from."""
    dir_path = tmp_path / name
    (dir_path / "docs").mkdir(parents=True)
    (dir_path / "docs" / "boot-profile.md").write_text("# boot\n")
    run = lambda *a: subprocess.run(  # noqa: E731
        ["git", *a], cwd=str(dir_path), check=True, capture_output=True
    )
    run("init", "-q")
    run("add", "-A")
    run("-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-qm", "seed")
    return str(dir_path)


def probe_io(
    results: Optional[list[LaunchResult]] = None, answers: Optional[list[str]] = None
) -> tuple[HandoffIO, list[tuple[str, list[str], Optional[str], RunOptions]], list[str]]:
    """A scripted IO: ``results`` answers each run in order (the last one repeats), and
    every call is recorded so a probe's argv, cwd and bounds can be asserted."""
    runs: list[tuple[str, list[str], Optional[str], RunOptions]] = []
    questions: list[str] = []
    scripted = results if results else [LaunchResult(started=True, stdout="1.4.0\n")]
    replies = list(answers or ["y"])

    def read_line(question: str, _fallback: str) -> str:
        questions.append(question)
        return replies.pop(0) if len(replies) > 1 else replies[0]

    def launch(*_args: object, **_kwargs: object) -> LaunchResult:
        raise AssertionError("the preflight never launches")

    def run(bin_name: str, args: list[str], cwd: Optional[str], opts: RunOptions) -> LaunchResult:
        runs.append((bin_name, args, cwd, opts))
        idx = len(runs) - 1
        return scripted[idx] if idx < len(scripted) else scripted[-1]

    return HandoffIO(read_line=read_line, launch=launch, run=run), runs, questions


def preflight(
    root: str,
    io: HandoffIO,
    host_sel: Optional[StartHost] = None,
    detected: Optional[list[DetectedHost]] = None,
) -> PreflightResult:
    return run_preflight(root, MANIFEST, host_sel, detected or [], detect_ecosystem(root), io)


def row(result: PreflightResult, check_id: str) -> Check:
    found = next((c for c in result.checks if c.id == check_id), None)
    assert found is not None, f"no {check_id} check"
    return found


def git_config(root: str, key: str, value: str) -> None:
    subprocess.run(["git", "config", key, value], cwd=root, check=True, capture_output=True)


# --- hook_status: one class per ownership -------------------------------------


def test_hook_status_ordinary_clone_is_personal_and_absent(tmp_path: Path) -> None:
    s = hook_status(git_layer(tmp_path), ["leji"])
    assert (s.ownership, s.state, s.path, s.managed) == (
        "personal",
        "absent",
        ".git/hooks/pre-commit",
        "file",
    )


def test_hook_status_managed_is_current_and_foreign_is_foreign(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    ensure_local_hook(root, ["leji"])
    assert hook_status(root, ["leji"]).state == "current"
    (Path(root) / ".git" / "hooks" / "pre-commit").write_text("#!/bin/sh\necho mine\n")
    s = hook_status(root, ["leji"])
    assert (s.state, s.ownership) == ("foreign", "personal")


def test_hook_status_husky_is_shared(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    git_config(root, "core.hooksPath", ".husky/_")
    s = hook_status(root, ["leji"])
    assert (s.ownership, s.state, s.path, s.managed) == (
        "shared",
        "absent",
        ".husky/pre-commit",
        "block",
    )


def test_hook_status_worktree_hooks_path_is_shared(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    git_config(root, "core.hooksPath", "githooks")
    s = hook_status(root, ["leji"])
    assert (s.ownership, s.path) == ("shared", "githooks/pre-commit")


def test_hook_status_global_hooks_path_is_external_and_report_only(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    git_config(root, "core.hooksPath", str(outside))
    assert hook_status(root, ["leji"]).ownership == "external"
    io, _runs, _q = probe_io()
    hook = row(preflight(root, io), "hook")
    assert hook.status == "missing"
    assert "leji pre-commit (managed)" in "\n".join(hook.fix or [])
    assert not (outside / "pre-commit").exists(), "nothing was written there"


def test_hook_status_linked_worktree_resolves_shared_hooks_dir_as_personal(
    tmp_path: Path,
) -> None:
    main = git_layer(tmp_path, "main")
    wt = str(tmp_path / "wt")
    subprocess.run(["git", "worktree", "add", "-q", wt], cwd=main, check=True, capture_output=True)
    s = hook_status(wt, ["leji"])
    # The hooks git runs live in the COMMON dir, outside this worktree. It is still
    # per-clone state, but the writer refuses everything outside the repository root,
    # so it is reported rather than offered.
    assert (s.ownership, s.state) == ("outside-root", "absent")
    io, _runs, questions = probe_io(answers=["y"])
    result = preflight(wt, io)
    hook = row(result, "hook")
    assert hook.status == "missing"
    assert "hooks dir is outside this worktree" in hook.detail
    assert hook.fix is not None and "# leji pre-commit (managed)" in "\n".join(hook.fix)
    offer_preflight_fixes(wt, None, result, ["leji"], True, io)
    assert questions == [], "a target outside the worktree is never offered"
    assert not (Path(main) / ".git" / "hooks" / "pre-commit").exists()


def test_hook_status_non_repository_is_no_git(tmp_path: Path) -> None:
    s = hook_status(str(tmp_path), ["leji"])
    assert (s.ownership, s.path) == ("no-git", "")


# --- the version probe --------------------------------------------------------


def test_cli_undeclared_is_a_shared_gap_carrying_the_declare_command(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    (Path(root) / "package.json").write_text('{"name":"app","packageManager":"pnpm@9.0.0"}\n')
    io, _r, _q = probe_io([LaunchResult(started=False, error="spawn leji ENOENT")])
    result = preflight(root, io)
    cli = row(result, "cli")
    assert cli.status == "shared-gap"
    assert cli.fix == ["pnpm add -D @leji-org/leji"]
    assert result.ready is False, "a shared cli gap still leaves the clone unready"


def test_cli_undeclared_names_an_ambient_leji_as_your_own_install(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    (Path(root) / "package.json").write_text('{"name":"app"}\n')
    io, _r, _q = probe_io()
    cli = row(preflight(root, io), "cli")
    assert cli.detail == "not declared here (PATH has your own 1.4.0)"


def test_cli_declared_node_is_probed_by_executing_the_installed_shim(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    (Path(root) / "package.json").write_text(
        '{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}\n'
    )
    (Path(root) / "pnpm-lock.yaml").write_text("lockfileVersion: 9\n")
    shim = install_node_bin(root)
    io, runs, _q = probe_io()
    result = preflight(root, io)
    cli = row(result, "cli")
    assert cli.status == "ok"
    assert cli.detail == "1.4.0 (node_modules/.bin/leji)"
    assert cli.fix is None
    bin_name, args, cwd, opts = runs[0]
    # The shim itself, by absolute path: no `pnpm exec`, no `npx`, no shell.
    assert (bin_name, args) == (shim, ["--version"])
    assert cwd == os.path.abspath(root), "the probe runs in the repository root"
    assert (opts.capture, opts.quiet, opts.timeout_ms, opts.max_bytes) == (True, True, 10000, 4096)
    # The environment REPLACES this process's: no inherited PATH, no HOME of the user's.
    assert opts.env is not None
    assert opts.env["PATH"] == _node_bin_dir()
    assert opts.env["HOME"] != os.environ.get("HOME")
    for leaked in ("NODE_OPTIONS", "LD_PRELOAD", "GOPATH"):
        assert leaked not in opts.env, f"{leaked} must not reach the probe"
    # The clone still has no hook, so one ok row is not readiness.
    assert result.ready is False
    assert row(result, "hook").status == "missing"


def test_cli_node_without_the_installed_shim_is_missing_and_runs_no_manager(
    tmp_path: Path,
) -> None:
    root = git_layer(tmp_path)
    (Path(root) / "package.json").write_text(
        '{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}\n'
    )
    (Path(root) / "package-lock.json").write_text('{"lockfileVersion":3}\n')
    io, runs, _q = probe_io()
    cli = row(preflight(root, io), "cli")
    assert cli.status == "missing"
    assert cli.detail == "not installed yet (node_modules/.bin/leji)"
    assert cli.fix == [
        "npm install",
        "npx --no-install @leji-org/leji --version",
    ]
    # Nothing was executed at all: a missing shim is answered from the filesystem.
    assert runs == []


def test_cli_shim_resolving_outside_the_repository_is_refused(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    (Path(root) / "package.json").write_text(
        '{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}\n'
    )
    (Path(root) / "package-lock.json").write_text('{"lockfileVersion":3}\n')
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    target = outside / "leji"
    target.write_text("#!/bin/sh\necho 9.9.9\n")
    target.chmod(0o755)
    bin_dir = Path(root) / "node_modules" / ".bin"
    bin_dir.mkdir(parents=True)
    (bin_dir / "leji").symlink_to(target)
    io, runs, _q = probe_io()
    cli = row(preflight(root, io), "cli")
    assert cli.status == "missing", "a shim pointing out of the repository is not the declared CLI"
    assert runs == []


def test_cli_probe_overrides_for_uv_and_go(tmp_path: Path) -> None:
    uv_root = git_layer(tmp_path, "uv")
    (Path(uv_root) / "pyproject.toml").write_text(
        '[project]\nname = "app"\ndependencies = ["leji"]\n'
    )
    (Path(uv_root) / "uv.lock").write_text("version = 1\n")
    io, runs, _q = probe_io()
    preflight(uv_root, io)
    assert runs[0][1] == ["run", "--no-sync", "leji", "--version"], "uv never syncs for a probe"

    go_root = git_layer(tmp_path, "go")
    (Path(go_root) / "go.mod").write_text(
        "module example.com/app\n\ngo 1.24\n\n"
        "tool github.com/leji-org/leji/packages/sdk-go/cmd/leji\n"
    )
    gio, gruns, _gq = probe_io()
    preflight(go_root, gio)
    assert gruns[0][1] == ["tool", "leji", "--version"]
    go_env = gruns[0][3].env or {}
    assert go_env["GOFLAGS"] == "-mod=readonly"
    assert go_env["GOTOOLCHAIN"] == "local"
    assert go_env["GOPROXY"] == "off"
    assert go_env["GOWORK"] == "off", "a workspace file must not redirect the probe"
    # A manager has to be found on PATH, so PATH survives; nothing unrelated does.
    assert go_env["PATH"] == os.environ.get("PATH")
    for leaked in ("NODE_OPTIONS", "LD_PRELOAD", "GOPRIVATE"):
        assert leaked not in go_env, f"{leaked} must not reach the probe"


def test_cli_every_probe_failure_fails_closed(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    (Path(root) / "package.json").write_text(
        '{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}\n'
    )
    (Path(root) / "package-lock.json").write_text('{"lockfileVersion":3}\n')
    install_node_bin(root)
    failures = [
        LaunchResult(started=False, error="spawn npx ENOENT"),  # never started
        LaunchResult(started=True, error="timed out"),  # timed out
        LaunchResult(started=True, error="exit 1"),  # ran, failed
        LaunchResult(started=True, stdout="leji version one\n"),  # malformed
        LaunchResult(started=True, stdout="\n"),  # empty
        LaunchResult(started=True, error="probe output exceeded the cap"),  # over the cap
    ]
    for outcome in failures:
        io, _r, _q = probe_io([outcome])
        cli = row(preflight(root, io), "cli")
        assert cli.status == "missing", outcome
        assert cli.fix == [
            "npm install",
            "npx --no-install @leji-org/leji --version",
        ], outcome


def test_cli_below_the_spec_line_minimum_is_missing(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    (Path(root) / "package.json").write_text(
        '{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}\n'
    )
    install_node_bin(root)
    io, _r, _q = probe_io([LaunchResult(started=True, stdout="0.9.3\n")])
    cli = row(preflight(root, io), "cli")
    assert cli.status == "missing"
    assert "is below 1.0.0 for spec 1.0" in cli.detail


# --- MCP rows -----------------------------------------------------------------


def test_mcp_registered_is_ok_and_unregistered_offers_the_user_scope(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    ok_io, _r, _q = probe_io(
        [LaunchResult(started=True, stdout="1.4.0\n"), LaunchResult(started=True)]
    )
    assert row(preflight(root, ok_io, CLAUDE_HOST, [DETECTED_CLAUDE]), "mcp").status == "ok"

    miss_io, _r2, _q2 = probe_io(
        [LaunchResult(started=True, stdout="1.4.0\n"), LaunchResult(started=True, error="exit 1")]
    )
    mcp = row(preflight(root, miss_io, CLAUDE_HOST, [DETECTED_CLAUDE]), "mcp")
    assert mcp.status == "missing"
    assert mcp.fix == ["claude mcp add leji --scope user -- npx -y @leji-org/mcp"]


def test_mcp_codex_registers_at_user_level_and_has_no_shared_form(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    io, _r, _q = probe_io(
        [LaunchResult(started=True, stdout="1.4.0\n"), LaunchResult(started=True, error="exit 1")]
    )
    result = preflight(root, io, CODEX_HOST, [DETECTED_CODEX])
    assert row(result, "mcp").fix == ["codex mcp add leji -- npx -y @leji-org/mcp"]
    assert row(result, "mcp-shared").status == "n/a"


def test_mcp_several_hosts_and_no_pick_is_unresolved(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    io, _r, _q = probe_io()
    mcp = row(preflight(root, io, None, [DETECTED_CLAUDE, DETECTED_CODEX]), "mcp")
    assert mcp.status == "unresolved"
    assert "Claude Code, Codex" in mcp.detail
    assert mcp.fix == ["leji start --agent <name>"]


def test_mcp_unregisterable_host_gets_the_standard_config_and_its_path(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    io, _r, _q = probe_io()
    mcp = row(preflight(root, io, None, [DETECTED_CURSOR]), "mcp")
    assert mcp.status == "missing"
    assert mcp.fix is not None and mcp.fix[0] == ".cursor/mcp.json (project scope)"
    assert '"@leji-org/mcp"' in "\n".join(mcp.fix)


def test_mcp_printed_block_takes_the_shape_the_host_config_file_uses(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    # VS Code, which is how GitHub Copilot reads MCP servers, spells the map
    # `servers`; pasting the common `mcpServers` block into .vscode/mcp.json leaves
    # the editor with a file it ignores.
    io, _r, _q = probe_io()
    copilot = row(preflight(root, io, None, [DETECTED_COPILOT]), "mcp")
    assert copilot.status == "missing"
    assert copilot.fix == [
        ".vscode/mcp.json (project scope)",
        "{",
        '  "servers": {',
        '    "leji": { "command": "npx", "args": ["-y", "@leji-org/mcp"] }',
        "  }",
        "}",
    ]
    # Every other host Leji cannot register for takes the common shape.
    cio, _r2, _q2 = probe_io()
    cursor = row(preflight(root, cio, None, [DETECTED_CURSOR]), "mcp")
    assert cursor.fix is not None and '  "mcpServers": {' in cursor.fix


def test_mcp_no_detected_host_is_skipped_and_never_counts_against_ready(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    (Path(root) / "package.json").write_text(
        '{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}\n'
    )
    install_node_bin(root)
    ensure_local_hook(root, ["leji"])
    io, _r, _q = probe_io()
    result = preflight(root, io)
    assert row(result, "mcp").status == "skipped"
    assert result.ready is True


def test_mcp_shared_presence_and_absence(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    absent_io, _r, _q = probe_io(
        [LaunchResult(started=True, stdout="1.4.0\n"), LaunchResult(started=True)]
    )
    absent = preflight(root, absent_io, CLAUDE_HOST, [DETECTED_CLAUDE])
    gap = row(absent, "mcp-shared")
    assert gap.status == "shared-gap"
    assert gap.fix == ["claude mcp add leji --scope project -- npx -y @leji-org/mcp"]
    assert absent.ready is False, "ready is decided by cli, mcp and hook"

    (Path(root) / ".mcp.json").write_text('{"mcpServers":{}}\n')
    present_io, _r2, _q2 = probe_io(
        [LaunchResult(started=True, stdout="1.4.0\n"), LaunchResult(started=True)]
    )
    present = preflight(root, present_io, CLAUDE_HOST, [DETECTED_CLAUDE])
    assert row(present, "mcp-shared").status == "ok"


def test_mcp_shared_never_decides_ready_on_its_own(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    (Path(root) / "package.json").write_text(
        '{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}\n'
    )
    install_node_bin(root)
    ensure_local_hook(root, ["npx", "--no-install", "@leji-org/leji"])
    io, _r, _q = probe_io(
        [LaunchResult(started=True, stdout="1.4.0\n"), LaunchResult(started=True)]
    )
    result = preflight(root, io, CLAUDE_HOST, [DETECTED_CLAUDE])
    assert row(result, "mcp-shared").status == "shared-gap"
    assert result.ready is True, "cli, mcp and hook are all ok"


# --- the report ---------------------------------------------------------------


def test_the_checks_are_always_the_same_four_ids_in_order(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    io, _r, _q = probe_io()
    result = preflight(root, io, CLAUDE_HOST, [DETECTED_CLAUDE])
    assert [c.id for c in result.checks] == ["cli", "mcp", "mcp-shared", "hook"]


def test_the_document_projection_publishes_exactly_the_four_keys(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    io, _r, _q = probe_io()
    for c in preflight(root, io, CLAUDE_HOST, [DETECTED_CLAUDE]).checks:
        doc = check_document(c)
        assert list(doc.keys()) == ["id", "status", "detail", "fix"]
        assert doc == {"id": c.id, "status": c.status, "detail": c.detail, "fix": c.fix}
        assert "fix_kind" not in json.dumps(doc)


# --- the Setup block ------------------------------------------------------------
# The three scenarios the layout was cut against, as exact bytes: the other two SDKs
# print these same strings, so the render is pinned here rather than described.

MCP_USER_FIX = "claude mcp add leji --scope user -- npx -y @leji-org/mcp"
MCP_PROJECT_FIX = "claude mcp add leji --scope project -- npx -y @leji-org/mcp"

# Nothing is this clone's to fix: the CLI, the shared server and the hook are all the
# repository's own state.
ALL_TEAM = [
    Check("cli", "shared-gap", "not declared in this repository", ["npm i -D @leji-org/leji"]),
    Check("mcp", "ok", "registered for Claude Code", None),
    Check("mcp-shared", "shared-gap", "no .mcp.json committed", [MCP_PROJECT_FIX]),
    Check("hook", "shared-gap", "no leji block in .husky/pre-commit", ["leji ci --hooks"]),
]

# The CLI and the hook are the maintainer's; both MCP registrations are already there.
TEAM_CLI_AND_HOOK = [
    Check(
        "cli",
        "shared-gap",
        "not declared here (PATH has your own 1.4.0)",
        ["npm i -D @leji-org/leji"],
    ),
    Check("mcp", "ok", "registered for Claude Code", None),
    Check("mcp-shared", "ok", ".mcp.json committed", None),
    Check("hook", "shared-gap", "no leji block in .husky/pre-commit", ["leji ci --hooks"]),
]

# One fix each: this user's own registration, and the one a maintainer commits.
PERSONAL_AND_TEAM_MCP = [
    Check("cli", "ok", "1.4.0 (node_modules/.bin/leji)", None),
    Check("mcp", "missing", "not registered for Claude Code", [MCP_USER_FIX]),
    Check("mcp-shared", "shared-gap", "no .mcp.json committed", [MCP_PROJECT_FIX]),
    Check("hook", "ok", "runs leji checks before each commit: .git/hooks/pre-commit", None),
]

SCENARIOS = [
    (
        "every gap belongs to a maintainer",
        ALL_TEAM,
        "\n".join(
            [
                "Setup for this clone",
                "",
                "  team  Leji CLI    not declared in this repository",
                "        $ npm i -D @leji-org/leji",
                "  ok    MCP server  registered for Claude Code",
                "  team  Team MCP    no .mcp.json committed",
                f"        $ {MCP_PROJECT_FIX}",
                "  team  Git hook    no leji block in .husky/pre-commit",
                "        $ leji ci --hooks",
                "",
                "  3 fixes for a maintainer. The agent starts either way.",
            ]
        ),
    ),
    (
        "the CLI and the hook are a maintainer's, both MCP rows ok",
        TEAM_CLI_AND_HOOK,
        "\n".join(
            [
                "Setup for this clone",
                "",
                "  team  Leji CLI    not declared here (PATH has your own 1.4.0)",
                "        $ npm i -D @leji-org/leji",
                "  ok    MCP server  registered for Claude Code",
                "  ok    Team MCP    .mcp.json committed",
                "  team  Git hook    no leji block in .husky/pre-commit",
                "        $ leji ci --hooks",
                "",
                "  2 fixes for a maintainer. The agent starts either way.",
            ]
        ),
    ),
    (
        "one fix for this user and one for a maintainer",
        PERSONAL_AND_TEAM_MCP,
        "\n".join(
            [
                "Setup for this clone",
                "",
                "  ok    Leji CLI    1.4.0 (node_modules/.bin/leji)",
                "  you   MCP server  not registered for Claude Code",
                f"        $ {MCP_USER_FIX}",
                "  team  Team MCP    no .mcp.json committed",
                f"        $ {MCP_PROJECT_FIX}",
                "  ok    Git hook    runs leji checks before each commit: .git/hooks/pre-commit",
                "",
                "  1 fix for you, 1 for a maintainer. The agent starts either way.",
            ]
        ),
    ),
]


@pytest.mark.parametrize("name,checks,expected", SCENARIOS)
def test_render_preflight_scenarios(name: str, checks: list[Check], expected: str) -> None:
    block = render_preflight(checks)
    assert block == expected, name
    assert "–" not in block and "—" not in block, "no en or em dash reaches the terminal"


def test_no_row_of_any_scenario_wraps_at_80_columns() -> None:
    for name, checks, _expected in SCENARIOS:
        for line in render_preflight(checks).split("\n"):
            # Commands and snippets are exact and exempt: they are what a person pastes.
            if line.startswith(" " * 8):
                continue
            assert len(line) <= 80, f"{name}: {len(line)} columns: {line}"


def test_render_preflight_snippet_is_pasted_and_a_command_carries_the_prompt() -> None:
    snippet = render_preflight(
        [
            Check(
                "hook",
                "missing",
                "add it yourself; hooks run from /etc/hooks",
                ["#!/bin/sh", "leji ci"],
                "snippet",
            )
        ]
    )
    assert "\n        #!/bin/sh\n        leji ci\n" in snippet, snippet
    # A check built without a fix kind, the shape an older caller passes, is a command.
    legacy = render_preflight(
        [Check("hook", "missing", "none yet (per clone)", ["leji ci --hooks"])]
    )
    assert "\n        $ leji ci --hooks\n" in legacy, legacy


def test_render_preflight_nothing_owed_is_one_closing_line() -> None:
    block = render_preflight(
        [
            Check("cli", "ok", "1.4.0 (node_modules/.bin/leji)", None),
            Check("mcp", "skipped", "no coding agent detected", None),
        ]
    )
    assert block.split("\n")[-1] == "  Setup complete."


# --- the color convention -------------------------------------------------------


def test_color_off_is_the_default_and_leaves_not_one_escape_byte() -> None:
    for _name, checks, _expected in SCENARIOS:
        assert "\x1b" not in render_preflight(checks)
        assert "\x1b" not in render_preflight(checks, False)


def test_color_on_wraps_the_status_word_only_and_the_columns_do_not_move() -> None:
    block = render_preflight(
        [
            Check("cli", "ok", "1.4.0 (node_modules/.bin/leji)", None),
            Check("mcp", "missing", "not registered for Claude Code", None),
            Check("mcp-shared", "shared-gap", "no .mcp.json committed", None),
            Check("hook", "n/a", "not a git repository", None),
        ],
        True,
    )
    assert block == "\n".join(
        [
            "Setup for this clone",
            "",
            "  \x1b[32mok\x1b[0m    Leji CLI    1.4.0 (node_modules/.bin/leji)",
            "  \x1b[33myou\x1b[0m   MCP server  not registered for Claude Code",
            "  \x1b[36mteam\x1b[0m  Team MCP    no .mcp.json committed",
            "  \x1b[2mn/a\x1b[0m   Git hook    not a git repository",
            "",
            "  1 fix for you, 1 for a maintainer. The agent starts either way.",
        ]
    )


@pytest.mark.parametrize(
    "is_tty,env,expected",
    [
        (True, {}, True),
        (False, {}, False),
        (True, {"NO_COLOR": "1"}, False),
        (True, {"NO_COLOR": ""}, False),
        (False, {"NO_COLOR": ""}, False),
        (True, {"TERM": "dumb"}, False),
        (True, {"TERM": "xterm-256color"}, True),
        (False, {"TERM": "xterm-256color"}, False),
    ],
)
def test_color_decision(is_tty: bool, env: dict[str, str], expected: bool) -> None:
    assert color_decision(is_tty, env) is expected


# --- the consented repairs ----------------------------------------------------


def test_offer_writes_nothing_non_interactively(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    io, runs, questions = probe_io(
        [LaunchResult(started=True, stdout="1.4.0\n"), LaunchResult(started=True, error="exit 1")]
    )
    result = preflight(root, io, CLAUDE_HOST, [DETECTED_CLAUDE])
    before = len(runs)
    offer_preflight_fixes(root, CLAUDE_HOST, result, ["leji"], False, io)
    assert questions == []
    assert len(runs) == before
    assert not (Path(root) / ".git" / "hooks" / "pre-commit").exists()


def test_offer_registers_then_installs_in_that_order(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    io, runs, questions = probe_io(
        [
            LaunchResult(started=True, stdout="1.4.0\n"),
            LaunchResult(started=True, error="exit 1"),
            LaunchResult(started=True),
        ],
        ["y"],
    )
    result = preflight(root, io, CLAUDE_HOST, [DETECTED_CLAUDE])
    offer_preflight_fixes(root, CLAUDE_HOST, result, ["leji"], True, io)
    assert len(questions) == 2, questions
    assert "Register the Leji MCP server for Claude Code" in questions[0]
    assert "Install the pre-commit hook" in questions[1]
    assert runs[-1][1] == [
        "mcp",
        "add",
        "leji",
        "--scope",
        "user",
        "--",
        "npx",
        "-y",
        "@leji-org/mcp",
    ]
    assert (Path(root) / ".git" / "hooks" / "pre-commit").exists()


def test_offer_never_offers_a_shared_gap(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    git_config(root, "core.hooksPath", ".husky/_")
    io, _runs, questions = probe_io(answers=["y"])
    result = preflight(root, io)
    assert row(result, "hook").status == "shared-gap"
    offer_preflight_fixes(root, None, result, ["leji"], True, io)
    assert questions == [], "a committed hook is a maintainer decision"
    assert not (Path(root) / ".husky" / "pre-commit").exists()


def test_offer_declines_cleanly(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    io, _runs, questions = probe_io(
        [LaunchResult(started=True, stdout="1.4.0\n"), LaunchResult(started=True, error="exit 1")],
        ["n"],
    )
    result = preflight(root, io, CLAUDE_HOST, [DETECTED_CLAUDE])
    offer_preflight_fixes(root, CLAUDE_HOST, result, ["leji"], True, io)
    assert len(questions) == 2
    assert not (Path(root) / ".git" / "hooks" / "pre-commit").exists()


def test_second_run_of_an_all_ok_clone_offers_nothing(tmp_path: Path) -> None:
    root = git_layer(tmp_path)
    (Path(root) / "package.json").write_text(
        '{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}\n'
    )
    (Path(root) / ".mcp.json").write_text('{"mcpServers":{}}\n')
    install_node_bin(root)
    ensure_local_hook(root, ["npx", "--no-install", "@leji-org/leji"])
    io, _runs, questions = probe_io(
        [LaunchResult(started=True, stdout="1.4.0\n"), LaunchResult(started=True)], ["y"]
    )
    result = preflight(root, io, CLAUDE_HOST, [DETECTED_CLAUDE])
    assert [c.status for c in result.checks] == ["ok", "ok", "ok", "ok"]
    assert result.ready is True
    offer_preflight_fixes(root, CLAUDE_HOST, result, ["leji"], True, io)
    assert questions == []


# --- the capture bounds, against a real child ---------------------------------


# The deadline a run that must NOT reach it is given: generous enough that a loaded
# runner cannot trip it, so finishing early can only mean the cap cut the child off.
OVERFLOW_TIMEOUT_MS = 30000

# The bound a terminated run has to finish inside: far below the deadline above, and far
# above anything scheduling delay on a busy machine can add. What it proves is which
# mechanism ended the run, not how fast the machine is.
PROMPT_WITHIN_S = 15

# How long a stub holds stdout open after it has said its piece: longer than every
# deadline in this file, so a run that ended early ended because leji ended it and not
# because the child happened to exit.
STUB_HOLD = "sleep 60"


def test_capture_kills_a_child_that_streams_past_the_cap(tmp_path: Path) -> None:
    """The cap is a bound on THIS process's memory, so it has to hold whatever the child
    does: a program that never stops printing is cut off and killed, well inside the
    timeout, rather than being read to completion and measured afterwards."""
    stub = tmp_path / "flood"
    # 1 MiB in 1 KiB lines, far past the 4 KiB cap, then a slow tail so a run that did
    # not kill the child would still be waiting.
    stub.write_text(
        "#!/bin/sh\ni=0\nwhile [ $i -lt 1024 ]; do printf '%1024s' ''; i=$((i+1)); done\n"
        f"{STUB_HOLD}\n"
    )
    stub.chmod(0o755)
    started = time.monotonic()
    res = _capture_run(
        str(stub),
        [],
        str(tmp_path),
        RunOptions(capture=True, timeout_ms=OVERFLOW_TIMEOUT_MS, max_bytes=4096),
    )
    elapsed = time.monotonic() - started
    assert res.started is True
    assert res.error == "probe output exceeded the cap"
    assert len(res.stdout.encode("utf-8")) <= 4096, "no more than the cap is ever held"
    assert elapsed < PROMPT_WITHIN_S, (
        f"the cap did not cut the child off: {elapsed:.1f}s, "
        f"against a {OVERFLOW_TIMEOUT_MS}ms deadline"
    )


CAPTURE_CANARY = "LEJI_PROBE_CANARY"


def test_capture_replaces_the_environment_rather_than_extending_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The probe's environment is built from empty: what the caller names is present,
    and nothing else of this process's is, however it was set."""
    stub = tmp_path / "echo-canary"
    stub.write_text(f"#!/bin/sh\nprintf '%s' \"${{{CAPTURE_CANARY}:-}}\"\n")
    stub.chmod(0o755)
    monkeypatch.setenv(CAPTURE_CANARY, "leaked")
    opts = RunOptions(capture=True, timeout_ms=10000, max_bytes=4096, env={"PATH": "/usr/bin:/bin"})
    res = _capture_run(str(stub), [], str(tmp_path), opts)
    assert (res.started, res.error) == (True, None)
    assert res.stdout == "", f"the parent's {CAPTURE_CANARY} reached the probe: {res.stdout!r}"
    # The positive control: what the caller names IS present, so the empty result above
    # is replacement rather than a stub that cannot see any environment.
    kept = _capture_run(
        str(stub),
        [],
        str(tmp_path),
        RunOptions(
            capture=True,
            timeout_ms=10000,
            max_bytes=4096,
            env={"PATH": "/usr/bin:/bin", CAPTURE_CANARY: "named"},
        ),
    )
    assert kept.stdout == "named"


def test_capture_cap_boundary(tmp_path: Path) -> None:
    """Exactly the cap is not overflow; one byte past it is."""
    cap = 64
    for size, capped in ((cap - 1, False), (cap, False), (cap + 1, True)):
        stub = tmp_path / f"size-{size}"
        stub.write_text(f"#!/bin/sh\nprintf '%{size}s' ''\n")
        stub.chmod(0o755)
        res = _capture_run(
            str(stub), [], str(tmp_path), RunOptions(capture=True, timeout_ms=10000, max_bytes=cap)
        )
        got = res.error == "probe output exceeded the cap"
        assert got is capped, f"{size} bytes: capped={got}, want {capped} ({res})"
        if not capped:
            assert len(res.stdout.encode("utf-8")) == size


def test_capture_ends_a_sparse_overflow_promptly(tmp_path: Path) -> None:
    """One byte past the cap, then a child that holds stdout open and does nothing.

    This is the case a buffered read cannot see: it would wait for a full chunk that
    never arrives and only give up at the deadline. The reader asks for exactly the
    remaining allowance plus one, so the byte past the cap arrives on its own and ends
    the run at once."""
    cap = 64
    stub = tmp_path / "trickle"
    stub.write_text(f"#!/bin/sh\nprintf '%{cap + 1}s' ''\n{STUB_HOLD}\n")
    stub.chmod(0o755)
    started = time.monotonic()
    res = _capture_run(
        str(stub),
        [],
        str(tmp_path),
        RunOptions(capture=True, timeout_ms=OVERFLOW_TIMEOUT_MS, max_bytes=cap),
    )
    elapsed = time.monotonic() - started
    assert (res.started, res.error) == (True, "probe output exceeded the cap")
    assert elapsed < PROMPT_WITHIN_S, (
        f"a sparse overflow waited for the deadline: {elapsed:.1f}s, "
        f"against a {OVERFLOW_TIMEOUT_MS}ms deadline"
    )


def test_capture_returns_bounded_output_for_a_well_behaved_child(tmp_path: Path) -> None:
    stub = tmp_path / "ok"
    stub.write_text("#!/bin/sh\necho 1.4.0\n")
    stub.chmod(0o755)
    res = _capture_run(
        str(stub), [], str(tmp_path), RunOptions(capture=True, timeout_ms=10000, max_bytes=4096)
    )
    assert (res.started, res.error, res.stdout.strip()) == (True, None, "1.4.0")


def test_capture_times_out_a_child_that_never_finishes(tmp_path: Path) -> None:
    stub = tmp_path / "hang"
    stub.write_text(f"#!/bin/sh\n{STUB_HOLD}\n")
    stub.chmod(0o755)
    started = time.monotonic()
    res = _capture_run(
        str(stub), [], str(tmp_path), RunOptions(capture=True, timeout_ms=500, max_bytes=4096)
    )
    elapsed = time.monotonic() - started
    assert (res.started, res.error) == (True, "timed out")
    # Here the deadline IS the mechanism under test; the bound only has to separate it
    # from the child's own 60s, with room for a loaded runner.
    assert elapsed < PROMPT_WITHIN_S, f"the timeout did not end the run ({elapsed:.1f}s)"
