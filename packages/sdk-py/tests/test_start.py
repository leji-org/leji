"""`leji start` (enter_layer) tests, mirroring packages/sdk/test/onboarding.test.ts."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from leji.detect import DetectedHost
from leji.init_cmd import (
    HandoffIO,
    LaunchResult,
    StartOptions,
    enter_layer,
)

BOOT_PROMPT = "Read ./docs/boot-profile.md, follow it, and tell me when you're ready."


def host(host_id: str, name: str, on_path: bool = True) -> DetectedHost:
    return DetectedHost(
        id=host_id,
        name=name,
        strength="confirmed" if on_path else "project-present",
        on_path=on_path,
        in_repo=not on_path,
        user_config=False,
        adapter=None,
    )


CLAUDE = host("claude-code", "Claude Code")
CODEX = host("codex", "Codex")
CURSOR = host("cursor", "Cursor")  # directory-style: no inline-prompt CLI


def fake_io(answer: str, result: LaunchResult | None = None):
    """A scripted HandoffIO: every prompt returns `answer`; launches (with cwd) are
    recorded. `result` overrides the launch outcome (default: clean exit)."""
    launches: list[tuple[str, str]] = []
    cwds: list[str | None] = []

    def launch(bin_name: str, prompt_arg: str, cwd: str | None = None) -> LaunchResult:
        launches.append((bin_name, prompt_arg))
        cwds.append(cwd)
        return result if result is not None else LaunchResult(started=True)

    return HandoffIO(read_line=lambda _q, _fb: answer, launch=launch), launches, cwds


def boot_layer(tmp_path: Path) -> tuple[str, dict]:
    """A minimal real layer dir with a boot profile, for enter_layer's existence check."""
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "boot-profile.md").write_text("# boot\n")
    return str(tmp_path), {"rootPath": "docs/", "bootProfilePath": "docs/boot-profile.md"}


def test_single_host_launches_directly_from_layer_root(tmp_path: Path) -> None:
    root, manifest = boot_layer(tmp_path)
    io, launches, cwds = fake_io("")
    outcome = enter_layer(
        StartOptions(root=root, manifest=manifest, detected=[CLAUDE], interactive=True, io=io)
    )
    assert outcome == "launched"
    assert launches == [("claude", BOOT_PROMPT)]
    assert cwds[0] == os.path.abspath(root), "agent is launched from the layer root"


def test_multiple_hosts_ask_then_launch(tmp_path: Path) -> None:
    root, manifest = boot_layer(tmp_path)
    io, launches, _ = fake_io("2")
    outcome = enter_layer(
        StartOptions(
            root=root, manifest=manifest, detected=[CLAUDE, CODEX], interactive=True, io=io
        )
    )
    assert outcome == "launched"
    assert launches == [("codex", BOOT_PROMPT)]


def test_falls_back_no_agent_or_non_interactive(tmp_path: Path) -> None:
    root, manifest = boot_layer(tmp_path)
    # directory-only host: nothing to launch.
    io, _, _ = fake_io("y")
    assert (
        enter_layer(
            StartOptions(root=root, manifest=manifest, detected=[CURSOR], interactive=True, io=io)
        )
        == "fallback"
    )
    # single host but non-interactive.
    io, _, _ = fake_io("y")
    assert (
        enter_layer(
            StartOptions(root=root, manifest=manifest, detected=[CLAUDE], interactive=False, io=io)
        )
        == "fallback"
    )
    # multiple hosts but non-interactive.
    io, _, _ = fake_io("2")
    assert (
        enter_layer(
            StartOptions(
                root=root, manifest=manifest, detected=[CLAUDE, CODEX], interactive=False, io=io
            )
        )
        == "fallback"
    )


def test_boot_missing_when_profile_absent(tmp_path: Path) -> None:
    manifest = {"rootPath": "docs/", "bootProfilePath": "docs/boot-profile.md"}
    io, _, _ = fake_io("y")
    outcome = enter_layer(
        StartOptions(
            root=str(tmp_path), manifest=manifest, detected=[CLAUDE], interactive=True, io=io
        )
    )
    assert outcome == "boot-missing"


def test_boot_missing_when_path_unsafe(tmp_path: Path) -> None:
    root, _ = boot_layer(tmp_path)
    manifest = {"rootPath": "docs/", "bootProfilePath": "../escape.md"}
    io, _, _ = fake_io("y")
    outcome = enter_layer(
        StartOptions(root=root, manifest=manifest, detected=[CLAUDE], interactive=True, io=io)
    )
    assert outcome == "boot-missing"


def test_agent_forces_launchable_host(tmp_path: Path) -> None:
    root, manifest = boot_layer(tmp_path)
    io, launches, _ = fake_io("y")
    outcome = enter_layer(
        StartOptions(
            root=root, manifest=manifest, detected=[], agent="codex", interactive=True, io=io
        )
    )
    assert outcome == "launched"
    assert launches == [("codex", BOOT_PROMPT)]


def test_agent_rejects_non_launchable_host(tmp_path: Path) -> None:
    root, manifest = boot_layer(tmp_path)
    io, _, _ = fake_io("y")
    with pytest.raises(RuntimeError, match="launchable host"):
        enter_layer(
            StartOptions(
                root=root, manifest=manifest, detected=[], agent="gemini", interactive=True, io=io
            )
        )
    with pytest.raises(RuntimeError):
        enter_layer(
            StartOptions(
                root=root, manifest=manifest, detected=[], agent="nope", interactive=True, io=io
            )
        )


def test_falls_back_when_launch_fails(tmp_path: Path) -> None:
    root, manifest = boot_layer(tmp_path)
    io, launches, _ = fake_io("", LaunchResult(started=True, error="exit 1"))
    outcome = enter_layer(
        StartOptions(root=root, manifest=manifest, detected=[CLAUDE], interactive=True, io=io)
    )
    assert outcome == "fallback"
    assert len(launches) == 1, "a launch was attempted"
