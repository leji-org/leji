"""MCP install-offer tests (pre-handoff), mirroring packages/sdk/test/onboarding.test.ts."""

from __future__ import annotations

from typing import Optional

from leji.detect import DetectedHost
from leji.init_cmd import (
    HandoffIO,
    LaunchResult,
    McpOfferOptions,
    McpOfferOutcome,
    handoff_offer,
    offer_mcp_install,
)

MANIFEST = {"rootPath": "docs/"}


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

CLAUDE_MCP_ADD = ["mcp", "add", "leji", "--scope", "project", "--", "npx", "-y", "@leji-org/mcp"]
CODEX_MCP_ADD = ["mcp", "add", "leji", "--", "npx", "-y", "@leji-org/mcp"]
MCP_CHECK = ["mcp", "get", "leji"]


def absent_then_ok() -> list[LaunchResult]:
    """A presence check reporting "absent" (started, non-zero exit) so the offer fires,
    then a clean register. Mirrors the Node ABSENT_THEN_OK fixture."""
    return [LaunchResult(started=True, error="exit 1"), LaunchResult(started=True)]


def fake_io(answer: str | list[str], run_results: Optional[list[LaunchResult]] = None):
    """A scripted HandoffIO: prompts return `answer` (sequenced when a list, the last
    one repeating) and are recorded; each Run/Launch call is recorded, Run returning
    the scripted results in order (clean exit past the end). `events` records the
    interleaved run/launch order, for asserting "register before launch"."""
    answers = [answer] if isinstance(answer, str) else list(answer)
    questions: list[str] = []
    runs: list[tuple[str, list[str], Optional[str], bool]] = []
    events: list[str] = []
    results = run_results or []

    def read_line(question: str, _fallback: str) -> str:
        questions.append(question)
        return answers.pop(0) if len(answers) > 1 else answers[0]

    def launch(
        bin_name: str,
        _prompt_arg: str,
        _cwd: Optional[str] = None,
        _host_args: Optional[list[str]] = None,
    ) -> LaunchResult:
        events.append(f"launch:{bin_name}")
        return LaunchResult(started=True)

    def run(bin_name: str, args: list[str], cwd: Optional[str], quiet: bool) -> LaunchResult:
        runs.append((bin_name, args, cwd, quiet))
        events.append(f"run:{bin_name}")
        idx = len(runs) - 1
        return results[idx] if idx < len(results) else LaunchResult(started=True)

    return (
        HandoffIO(read_line=read_line, launch=launch, run=run),
        questions,
        runs,
        events,
    )


def test_never_fires_non_interactively() -> None:
    io, questions, runs, _events = fake_io("y", absent_then_ok())
    offer_mcp_install(McpOfferOptions(root="/repo", detected=[CLAUDE], interactive=False, io=io))
    assert questions == []
    assert runs == []


def test_no_offer_without_launchable_host() -> None:
    io, questions, runs, _events = fake_io("y", absent_then_ok())
    offer_mcp_install(McpOfferOptions(root="/repo", detected=[CURSOR], interactive=True, io=io))
    assert questions == []
    assert runs == []


def test_registers_on_accept_anchored_at_root() -> None:
    io, questions, runs, _events = fake_io("", absent_then_ok())  # empty answer = Y default
    offer_mcp_install(McpOfferOptions(root="/repo", detected=[CLAUDE], interactive=True, io=io))
    assert len(questions) == 1
    # First run is the quiet presence check; second is the register, both at the root.
    assert runs[0] == ("claude", MCP_CHECK, "/repo", True)
    assert runs[1] == ("claude", CLAUDE_MCP_ADD, "/repo", False)


def test_skips_when_already_registered() -> None:
    io, questions, runs, _events = fake_io(
        "y", [LaunchResult(started=True)]
    )  # check reports present
    offer_mcp_install(McpOfferOptions(root="/repo", detected=[CLAUDE], interactive=True, io=io))
    assert questions == []  # no nag when present
    assert len(runs) == 1  # only the presence check ran
    assert runs[0][3] is True  # and it was quiet


def test_decline_checks_prompts_but_does_not_register() -> None:
    io, questions, runs, _events = fake_io("n", absent_then_ok())
    offer_mcp_install(McpOfferOptions(root="/repo", detected=[CLAUDE], interactive=True, io=io))
    assert len(questions) == 1
    assert len(runs) == 1  # only the presence check ran; no register


def test_multi_host_asks_the_pick_once_then_registers_for_it() -> None:
    io, questions, runs, _events = fake_io(["2", "y"], absent_then_ok())
    outcome = offer_mcp_install(
        McpOfferOptions(root="/repo", detected=[CLAUDE, CODEX], interactive=True, io=io)
    )
    assert "Which agent?" in questions[0]  # the host pick comes before the MCP question
    assert runs[1][0] == "codex"  # registers for the picked host, not the top-ranked one
    assert runs[1][1] == CODEX_MCP_ADD
    assert outcome.next == "launch" and outcome.host is not None and outcome.host.bin == "codex"


def test_skip_when_the_pick_is_declined() -> None:
    io, questions, runs, _events = fake_io([""], absent_then_ok())
    outcome = offer_mcp_install(
        McpOfferOptions(root="/repo", detected=[CLAUDE, CODEX], interactive=True, io=io)
    )
    assert outcome.next == "skip"
    assert len(questions) == 1  # only the pick was asked
    assert runs == []  # no check or register for a declined pick


def test_single_host_returns_default() -> None:
    io, _questions, _runs, _events = fake_io("y", absent_then_ok())
    outcome = offer_mcp_install(
        McpOfferOptions(root="/repo", detected=[CLAUDE], interactive=True, io=io)
    )
    assert outcome.next == "default"


def test_handoff_launches_the_mcp_picked_host_without_re_asking() -> None:
    from leji.init_cmd import _PromptHost

    io, questions, _runs, events = fake_io("never-read")
    launched = handoff_offer(
        MANIFEST,
        [CLAUDE, CODEX],
        True,
        io=io,
        cwd="/repo",
        mcp=McpOfferOutcome(next="launch", host=_PromptHost("codex", "codex", "Codex")),
    )
    assert launched is True
    assert questions == []  # no second pick, no confirm
    assert events == ["launch:codex"]


def test_handoff_honors_a_skipped_pick() -> None:
    io, questions, _runs, events = fake_io("never-read")
    launched = handoff_offer(
        MANIFEST, [CLAUDE, CODEX], True, io=io, cwd="/repo", mcp=McpOfferOutcome(next="skip")
    )
    assert launched is False
    assert questions == []
    assert events == []


def test_offer_then_handoff_compose_register_before_launch_same_host() -> None:
    io, _questions, _runs, events = fake_io(["2", "y"], absent_then_ok())
    outcome = offer_mcp_install(
        McpOfferOptions(root="/repo", detected=[CLAUDE, CODEX], interactive=True, io=io)
    )
    launched = handoff_offer(MANIFEST, [CLAUDE, CODEX], True, io=io, cwd="/repo", mcp=outcome)
    assert launched is True
    # check, register, launch: all codex, the register strictly before the launch.
    assert events == ["run:codex", "run:codex", "launch:codex"]


def test_honors_agent_using_that_hosts_command() -> None:
    io, _questions, runs, _events = fake_io("y", absent_then_ok())
    # Codex not even detected; --agent forces it, and its argv omits --scope project.
    offer_mcp_install(
        McpOfferOptions(root="/repo", detected=[CLAUDE], interactive=True, io=io, agent="codex")
    )
    assert runs[1][0] == "codex"
    assert runs[1][1] == CODEX_MCP_ADD


def test_never_raises_when_register_fails() -> None:
    io, _questions, runs, _events = fake_io(
        "y",
        [
            LaunchResult(started=True, error="exit 1"),
            LaunchResult(started=False, error="not found"),
        ],
    )
    offer_mcp_install(McpOfferOptions(root="/repo", detected=[CLAUDE], interactive=True, io=io))
    assert len(runs) == 2  # check then attempted register
