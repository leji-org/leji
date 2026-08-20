"""The declaration offer: after the scaffold is written, tell the user how a clean
install of this repository will bring ``leji``, and offer to run their own package
manager's add command.

leji writes no manifest or lockfile byte itself: the manager owns both formats, so
the only thing that changes the repository here is a command the user explicitly
accepted. Transcribed from the TypeScript reference (offerDependency in
``packages/sdk/src/commands/init.ts``).
"""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from typing import Callable, Optional, TextIO

from .ecosystem import (
    CONSENT_DECLINED,
    CONSENT_PROMPT,
    EcosystemReport,
    consent_command,
    consent_declared,
    consent_disclosure,
    consent_exited,
    consent_missing,
    consent_running,
    consent_signaled,
    render_ecosystem_block,
)


@dataclass
class AddResult:
    """What running one manager add command did: the runner's own result type, where
    the start state lives. A spawn that never started reports ``started`` False; a
    started run reports its exit code, and ``signal`` when the runtime killed it."""

    started: bool
    exit_code: int = 0
    signal: str = ""


@dataclass
class DependencyIO:
    """Injectable I/O for the declaration offer, so the interactive flow is
    deterministically testable and no test can reach a real package manager."""

    read_line: Callable[[str, str], str]
    run: Callable[[str, list[str], str], AddResult]


def default_dependency_io() -> DependencyIO:
    """Real I/O: a stdin prompt and an argv spawn, never a shell."""

    def read_line(question: str, fallback: str) -> str:
        try:
            return input(f"{question} [{fallback}]: ").strip()
        except EOFError:
            return ""

    def run(bin_name: str, args: list[str], cwd: str) -> AddResult:
        try:
            proc = subprocess.run([bin_name, *args], cwd=cwd)  # noqa: S603 (no shell)
        except OSError:
            # Never started (ENOENT and friends): a missing binary, not a failed add.
            return AddResult(started=False)
        # POSIX reports a signalled child as a negative return code; the signal is
        # what the outcome reports, since such a child has no exit code of its own.
        if proc.returncode < 0:
            signal_number = -proc.returncode
            try:
                import signal as signal_mod

                name = signal_mod.Signals(signal_number).name
            except (ValueError, ImportError):
                name = str(signal_number)
            return AddResult(started=True, exit_code=-1, signal=name)
        return AddResult(started=True, exit_code=proc.returncode)

    return DependencyIO(read_line=read_line, run=run)


@dataclass
class DependencyOffer:
    """What the declaration step did, in the reference's shape: ``ran`` means the add
    was consented to and attempted, and ``exit_code``/``signal`` are nullable exactly
    as they are in the ``--json`` contract. A signalled manager has no exit code of
    its own (``exit_code`` None, ``signal`` set), and a spawn that never started has
    neither (both None with ``ran`` True) — which counts as a failure just like a
    non-zero exit. The runner's start state stays in :class:`AddResult`."""

    offered: bool = False
    ran: bool = False
    command: Optional[list[str]] = None
    exit_code: Optional[int] = None
    signal: Optional[str] = None


def dependency_add_failed(offer: DependencyOffer) -> bool:
    """A consented add that did not succeed, so the command must not exit 0: the
    layer is written but the durable setup the run promised was not reached."""
    return offer.ran and (
        offer.exit_code is None or offer.exit_code != 0 or offer.signal is not None
    )


def offer_dependency(
    root: str,
    report: EcosystemReport,
    interactive: bool,
    io: Optional[DependencyIO] = None,
    out: Optional[TextIO] = None,
) -> DependencyOffer:
    """The block is ALWAYS printed (this function is simply not called under
    ``--json``, which is a single-document mode). The prompt fires only when the run
    is interactive, an add command exists for the detected manager, and the CLI is
    not already declared."""
    stream = out if out is not None else sys.stdout
    print("\n" + render_ecosystem_block(report), file=stream)
    selected = report.selected
    command = selected.add if selected is not None and selected.add else None
    offered = command is not None and selected is not None and not selected.direct_declared
    skipped = DependencyOffer(offered=offered, command=command)
    if not offered or not interactive:
        return skipped

    handle = io if io is not None else default_dependency_io()
    # Consent is only consent if it is informed: the manager runs here, as this
    # user, with this environment, and does whatever it normally does.
    assert command is not None
    print(consent_disclosure(command[0]), file=stream)
    answer = handle.read_line(CONSENT_PROMPT, "Y/n").lower()
    if answer not in ("", "y", "yes"):
        print(CONSENT_DECLINED, file=stream)
        print(consent_command(command), file=stream)
        return skipped
    print(consent_running(command), file=stream)
    result = handle.run(command[0], command[1:], root)
    attempted = DependencyOffer(offered=offered, ran=True, command=command)
    # A spawn that never started surfaces as a start failure, never as an exit code,
    # so it is reported as a missing binary rather than as a failed add, and it
    # carries neither an exit code nor a signal.
    if not result.started:
        print(consent_missing(command[0]), file=stream)
        print(consent_command(command), file=stream)
        return attempted
    if result.signal:
        print(consent_signaled(command[0], result.signal), file=stream)
        print(consent_command(command), file=stream)
        attempted.signal = result.signal
        return attempted
    attempted.exit_code = result.exit_code
    if result.exit_code != 0:
        print(consent_exited(command[0], result.exit_code), file=stream)
        print(consent_command(command), file=stream)
        return attempted
    assert selected is not None
    print(consent_declared(selected.ecosystem), file=stream)
    return attempted
