"""Handoff-offer tests, mirroring packages/sdk/test/onboarding.test.ts."""

from __future__ import annotations

from leji.detect import DetectedHost
from leji.init_cmd import HandoffIO, LaunchResult, handoff_offer

BRIEF = "Read ./docs/.leji/onboarding-brief.md and follow it."


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
    """A scripted HandoffIO: every prompt returns `answer`, launches are recorded.
    `result` overrides the launch outcome (default: clean exit)."""
    launches: list[tuple[str, str]] = []

    def launch(bin_name: str, prompt_arg: str, cwd: str | None = None) -> LaunchResult:
        launches.append((bin_name, prompt_arg))
        return result if result is not None else LaunchResult(started=True)

    return HandoffIO(read_line=lambda _q, _fb: answer, launch=launch), launches


M = {"rootPath": "docs/"}


def test_never_fires_non_interactively() -> None:
    io, launches = fake_io("y")
    assert handoff_offer(M, [CLAUDE], False, io) is False
    assert launches == []


def test_no_offer_for_directory_style_only() -> None:
    io, launches = fake_io("y")
    assert handoff_offer(M, [CURSOR], True, io) is False
    assert launches == []


def test_ignores_hosts_not_on_path() -> None:
    io, launches = fake_io("y")
    assert handoff_offer(M, [host("codex", "Codex", on_path=False)], True, io) is False
    assert launches == []


def test_single_host_accepts_default_and_yes() -> None:
    for ans in ("", "y", "yes", "Y"):
        io, launches = fake_io(ans)
        assert handoff_offer(M, [CLAUDE], True, io) is True, ans
        assert launches == [("claude", BRIEF)], ans


def test_single_host_declines_on_n() -> None:
    io, launches = fake_io("n")
    assert handoff_offer(M, [CLAUDE], True, io) is False
    assert launches == []


def test_multiple_hosts_select_by_number() -> None:
    io, launches = fake_io("2")
    assert handoff_offer(M, [CLAUDE, CODEX], True, io) is True
    assert launches == [("codex", BRIEF)]


def test_multiple_hosts_skip_on_empty() -> None:
    io, launches = fake_io("")
    assert handoff_offer(M, [CLAUDE, CODEX], True, io) is False
    assert launches == []


def test_multiple_hosts_skip_on_n() -> None:
    io, launches = fake_io("n")
    assert handoff_offer(M, [CLAUDE, CODEX], True, io) is False
    assert launches == []


def test_multiple_hosts_junk_or_out_of_range_never_launches() -> None:
    for ans in ("9", "0", "banana", "-1"):
        io, launches = fake_io(ans)
        assert handoff_offer(M, [CLAUDE, CODEX], True, io) is False, ans
        assert launches == [], ans


def test_returns_false_when_agent_cannot_start() -> None:
    io, launches = fake_io("y", LaunchResult(started=False, error="not found"))
    assert handoff_offer(M, [CLAUDE], True, io) is False
    assert len(launches) == 1  # a launch was attempted


def test_returns_false_on_non_clean_exit() -> None:
    io, _ = fake_io("y", LaunchResult(started=True, error="exit 1"))
    assert handoff_offer(M, [CLAUDE], True, io) is False


def test_threads_layer_root_into_prompt() -> None:
    io, launches = fake_io("y")
    assert handoff_offer({"rootPath": "context/"}, [CLAUDE], True, io) is True
    assert launches == [("claude", "Read ./context/.leji/onboarding-brief.md and follow it.")]
