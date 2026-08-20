"""The hand-off the INSTALLED CONSOLE SCRIPT performs before it parses anything:
inside a repository that declares the Leji CLI and has it installed, an invocation of
the global ``leji`` belongs to the repository's own pinned copy, so a teammate, a hook,
CI, and a person typing ``leji`` all run one version of the tool. Transcribes
packages/sdk/src/lib/localcli.ts, with this runtime's own target (the project
environment's console script rather than a Node bin shim).

Nothing here is reachable from the library. ``main()`` is imported in-process by tests
and by other tools, and a library call must never turn into another program.

Every negative outcome is SILENT and launches nothing: the global runs exactly as it
did before, so a repository that does not qualify pays a few bounded reads and notices
no difference. The reads that decide the execution are the verified form
(:func:`open_verified_source`), because the bytes that decide what runs must come from
the file the containment check cleared. The residual is the recorded check-before-act limit, stated
in ``docs/practice/trust-boundary.md``: a target swapped between the check and the exec
cannot be closed portably, and it is named in the allowance rather than claimed away.
"""

from __future__ import annotations

import errno
import json
import os
import re
import signal
import stat
import subprocess
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import NoReturn, Optional

from .cli import effective_root
from .ecosystem import (
    ENTRY_ABSENT,
    ENTRY_ELIGIBLE,
    ENTRY_REFUSED,
    PIPFILE,
    PY_LOCKS,
    PYPROJECT,
    REQUIREMENTS_RE,
    classify_entry,
    python_declares,
    python_manager_choice,
)
from .fsx import (
    guard_root,
    open_verified_source,
    read_all,
    resolved_path,
    resolved_within_root,
    to_posix,
)
from .manifest import MANIFEST_FILENAME
from .preflight import MIN_SDK_FOR_SPEC_LINE, VERSION_RE

# The one variable that turns the hand-off off, set to ANY value including empty.
# Nothing of ours is ever ADDED to the environment: the agent host `leji start`
# launches inherits the user's environment untouched, so no sentinel of ours can leak
# into it and silently disable the hand-off for everything it runs.
OPT_OUT = "LEJI_NO_LOCAL"

# The installed distribution's own metadata, read whole and bounded. A METADATA file is
# a few kilobytes; anything past this is not one, and reading it is not this wrapper's
# job. The other three bounds keep `--help` and `--version` away from an unbounded
# number of repository-controlled candidates: exceeding ANY of them is no hand-off,
# never a longer search.
MAX_METADATA_BYTES = 64 * 1024
MAX_LIB_DIRS = 4
MAX_SITE_ENTRIES = 512
MAX_DIST_INFO = 8
#: The same bound on the repository root's own listing, which the evidence names come
#: from. A root with more entries than this is not searched for evidence at all.
MAX_ROOT_ENTRIES = 512

# The interpreter directories a POSIX virtual environment keeps its packages under.
_PY_LIB_PREFIX = "python3."

# PEP 503 name normalization: the one spelling two distributions are compared by.
_NAME_SEPARATORS = re.compile(r"[-_.]+")

# The distribution name this SDK is published under.
_DIST_NAME = "leji"


@dataclass(frozen=True)
class LocalCliHandoff:
    """The repository's own CLI, and exactly how to run it. ``args`` is the argv this
    process received, verbatim; ``display`` is the target as a failure would name it,
    repository-relative and POSIX-spelled."""

    bin: str
    args: list[str]
    display: str


def resolve_local_cli(
    argv: list[str],
    env: Mapping[str, str],
    platform: str,
    self_entry_realpath: Optional[str],
) -> Optional[LocalCliHandoff]:
    """Decide whether this invocation belongs to a repository's own pinned CLI, or
    None when the global one continues.

    ``self_entry_realpath`` is the resolved path of the running console script, or None
    when it could not be resolved; the target is refused when it IS that file, which is
    what keeps a repository whose install points back at this very script from handing
    off to itself forever. An unknown self is refused for the same reason.

    The identity of the copy is the console script itself here, which the reference
    SDK's structure reaches through the package entry instead. The two agree because
    of ``execv``: this process is REPLACED by the target, so the copy that runs next
    sees exactly this path as its own ``sys.argv[0]``, and the comparison closes the
    loop on the first re-entry. Node cannot rely on that, because a manager's shim may
    be a script whose realpath is itself rather than the entry it runs, so its guard
    resolves the package's declared entry; there is no shim layer between an
    environment's console script and this module.

    All of the following must hold, and each one is checked on the resolved path rather
    than on a spelling:

    ==========================================================  ==========================================
    condition                                                   why
    ==========================================================  ==========================================
    ``LEJI_NO_LOCAL`` absent from the environment                the single opt-out
    the argv names a root at all                                 a malformed command line selects no repo
    the declaring manifest declares the CLI, verified            the repository committed the intent
    that same read names one manager                            the manager names the environment rule
    the layer's spec line reads back and has a minimum           the bar to meet
    the manager-owned environment resolves inside the root       never an environment kept elsewhere
    exactly one installed distribution normalizes to ``leji``    a directory spelling is not an identity
    its version parses and its major meets the minimum           an older copy cannot serve this layer
    the console script resolves inside the real root             never a linked copy elsewhere
    the target is not this running script                        no recursion
    ==========================================================  ==========================================

    Every read here is TOTAL: an unreadable manifest, a permission error, a directory
    where a file was expected, or any other I/O failure is no hand-off, never an
    exception. This runs before ``main()`` and outside its error handling, so a raise
    would be a traceback where the global CLI was supposed to run.
    """
    try:
        return _resolve(argv, env, platform, self_entry_realpath)
    except Exception:
        return None


def _resolve(
    argv: list[str],
    env: Mapping[str, str],
    platform: str,
    self_entry_realpath: Optional[str],
) -> Optional[LocalCliHandoff]:
    if OPT_OUT in env:
        return None
    if self_entry_realpath is None:
        return None
    root_arg = effective_root(argv)
    if root_arg is None:
        return None
    root_abs = os.path.abspath(root_arg)
    root_real = guard_root(root_abs)

    manager = _declared_manager(root_abs, root_real)
    if manager is None:
        return None

    spec_line = _read_spec_line(root_real, os.path.join(root_abs, MANIFEST_FILENAME))
    if spec_line is None:
        return None
    minimum = MIN_SDK_FOR_SPEC_LINE.get(spec_line)
    if minimum is None:
        return None

    env_dir = _project_environment(root_abs, manager, env)
    if env_dir is None:
        return None
    version = _installed_version(root_real, _site_packages_dirs(env_dir, platform))
    if version is None:
        return None
    parsed = VERSION_RE.match(version)
    if parsed is None or int(parsed.group(1)) < int(minimum.split(".")[0]):
        return None

    target = _installed_console_script(root_abs, env_dir, platform)
    if target is None:
        return None
    if resolved_path(target) == self_entry_realpath:
        return None
    return LocalCliHandoff(
        bin=target,
        args=list(argv),
        display=to_posix(os.path.relpath(target, root_abs)),
    )


def _declared_manager(root_abs: str, root_real: str) -> Optional[str]:
    """The manager this root's committed evidence names, or None when this root does
    not ask for a hand-off at all.

    Both answers this needs, WHETHER the repository declares the CLI and WHICH manager
    owns its environment, come from one verified read of each declaring manifest. The
    ecosystem report is deliberately not consulted: it reads the same files by path,
    and this runtime's manager selects the environment and therefore which console
    script would run, so the bytes that decide it have to be bytes this resolver
    verified rather than bytes something else read a moment earlier.

    The names the listing yields decide only which files this resolver then VERIFIES
    OPEN. A lockfile's evidence is its name, so nothing of it is read, but the name
    counts only when a verified open of it succeeds at decision time: a lockfile that
    has vanished, become a link, or turned into a directory since it was listed
    selects nothing, because a name alone must never steer which environment, and so
    which executable, this hand-off reaches.

    The decision table is the ecosystem module's own, called on the text: a single
    lock family, else a single `[tool.*]` table, else pip; ambiguity, refused
    evidence, and an unreadable manifest are each no hand-off.
    """
    try:
        entries = sorted(os.listdir(root_abs))
    except OSError:
        return None
    if len(entries) > MAX_ROOT_ENTRIES:
        return None
    requirements = [name for name in entries if REQUIREMENTS_RE.match(name)]

    kinds = {name: classify_entry(root_abs, name) for name in {PYPROJECT, PIPFILE, *requirements}}
    if any(kind == ENTRY_REFUSED for kind in kinds.values()):
        return None  # refused evidence: the scan's own refusal, and never read through
    # The ecosystem is gated by the same three things the report gates it by; a root
    # that gates no Python ecosystem names no manager.
    if kinds[PYPROJECT] == ENTRY_ABSENT and kinds[PIPFILE] == ENTRY_ABSENT and not requirements:
        return None

    manifests: dict[str, Optional[str]] = {}
    for name in (PYPROJECT, PIPFILE):
        if kinds[name] != ENTRY_ELIGIBLE:
            manifests[name] = None
            continue
        text = _verified_text(root_real, os.path.join(root_abs, name))
        if text is None:
            return None  # standing but unreadable: the report's unreadable-manifest
        manifests[name] = text

    declared = python_declares(
        manifests[PYPROJECT],
        manifests[PIPFILE],
        (
            _verified_text(root_real, os.path.join(root_abs, name))
            for name in requirements
            if kinds[name] == ENTRY_ELIGIBLE
        ),
    )
    if not declared:
        return None
    present = set(entries)
    lock_evidence = [
        name
        for name, _, _ in PY_LOCKS
        if name in present and _verified_present(root_real, os.path.join(root_abs, name))
    ]
    choice = python_manager_choice(lock_evidence, manifests[PYPROJECT])
    return choice.manager


def _verified_present(root_real: str, abs_path: str) -> bool:
    """Whether a regular file provably stands at ``abs_path``, inside the real
    repository root, at the moment the decision is made.

    A lockfile's whole evidence is its NAME, so nothing of it is read; what has to be
    proved is that the thing bearing that name is a real file of this repository, and
    only a descriptor proves it. The descriptor is closed immediately: this asks a
    question, it does not open a source.

    The ENTRY itself is judged, with ``lstat``, and a symlink is refused rather than
    followed. That is the scan's own convention: evidence reached through a link is
    not this repository's evidence, whatever it resolves to. Judging only the opened
    descriptor would accept an in-root link, because the open follows it and proves
    the target instead of the name.

    The entry is judged TWICE for that, and the second time decides. An up-front
    ``lstat`` is the cheap refusal, but on its own it leaves the entry free to become
    a link before the open, which would then resolve and verify the link's target
    perfectly well: no swap-back needed, and the link would have selected a manager.
    So after the open, the descriptor's own ``fstat`` and a fresh ``lstat`` of the
    NAME must report the same ``(st_dev, st_ino)``. A symlink's inode is never the
    inode of the file it points at, so an entry that is a link at that instant cannot
    pass, and neither can one that has become a different file.

    Any failure at all, including an operational one such as a permission error, is
    False. A candidate that fails is simply not evidence, which is the same answer as
    never having been there, so the table falls through to the next rule rather than
    refusing the whole root on it, and one unreadable candidate cannot suppress a
    family that verified cleanly.

    What remains after this is the recorded check-before-act window between the check and the exec,
    which every other verified fact on this path shares."""
    try:
        entry = os.lstat(abs_path)
        if not stat.S_ISREG(entry.st_mode):
            return False
        source = open_verified_source(abs_path, lambda real: _within(root_real, real))
        if source.fd is None:
            return False
        try:
            opened = os.fstat(source.fd)
            standing = os.lstat(abs_path)
        finally:
            os.close(source.fd)
    except OSError:
        return False
    if (opened.st_dev, opened.st_ino) != (standing.st_dev, standing.st_ino):
        return False
    return True


def _project_environment(
    root_abs: str, manager: Optional[str], env: Mapping[str, str]
) -> Optional[str]:
    """The environment the repository's MANAGER owns, computed first and alone.

    uv reads ``UV_PROJECT_ENVIRONMENT`` (a relative value resolved against the root),
    and every other manager this ecosystem selects keeps the project environment at
    ``.venv`` under the root. ``VIRTUAL_ENV`` is deliberately not consulted: an active
    environment is a property of the shell, not of this repository, and a nested or
    unrelated one in a monorepo is not this root's. An environment the manager keeps
    OUTSIDE the repository (a Poetry cache venv, a pipenv ``WORKON_HOME``) is
    ineligible by design, which is what the public wording says.
    """
    declared = env.get("UV_PROJECT_ENVIRONMENT") if manager == "uv" else None
    if declared:
        candidate = declared if os.path.isabs(declared) else os.path.join(root_abs, declared)
    else:
        candidate = os.path.join(root_abs, ".venv")
    candidate = os.path.abspath(candidate)
    if not resolved_within_root(root_abs, Path(candidate)):
        return None
    return candidate if os.path.isdir(candidate) else None


def _site_packages_dirs(env_dir: str, platform: str) -> Optional[list[str]]:
    """Where an environment keeps installed distributions: one fixed directory on
    Windows, and the interpreter directories under ``lib/`` on POSIX, sorted so the
    search order is the same everywhere. More than the bound is not an environment
    this wrapper searches."""
    if platform == "win32":
        return [os.path.join(env_dir, "Lib", "site-packages")]
    lib = os.path.join(env_dir, "lib")
    try:
        names = sorted(n for n in os.listdir(lib) if n.startswith(_PY_LIB_PREFIX))
    except OSError:
        return []
    if len(names) > MAX_LIB_DIRS:
        return None
    return [os.path.join(lib, n, "site-packages") for n in names]


def _names_this_distribution(entry: str) -> bool:
    """Whether one ``.dist-info`` directory could belong to THIS distribution, by the
    name every installer writes into it (PEP 376: ``<name>-<version>.dist-info``).

    This only NARROWS which metadata is opened; it never decides identity. A real
    environment holds a dist-info per installed distribution, so opening all of them on
    every `--version` is both wasteful and the unbounded exposure the bound exists to
    close. What decides is the ``Name`` field inside the file this selects, so a
    directory spelled like this package but declaring another one is still refused."""
    stem = entry[: -len(".dist-info")]
    return _normalized(stem.rsplit("-", 1)[0]) == _DIST_NAME


def _installed_version(root_real: str, site_dirs: Optional[list[str]]) -> Optional[str]:
    """The installed Leji distribution's version, or None. Identity is the distribution
    NAME as PEP 503 normalizes it, never the spelling of a ``.dist-info`` directory, and
    EXACTLY ONE match must exist: zero says nothing is installed here, and more than one
    says this environment cannot answer which copy would run. Every bound refuses rather
    than searching further."""
    if site_dirs is None:
        return None
    candidates: list[str] = []
    for site in site_dirs:
        try:
            entries = sorted(os.listdir(site))
        except OSError:
            continue
        if len(entries) > MAX_SITE_ENTRIES:
            return None
        candidates.extend(
            os.path.join(site, name)
            for name in entries
            if name.endswith(".dist-info") and _names_this_distribution(name)
        )
    if len(candidates) > MAX_DIST_INFO:
        return None
    found: list[str] = []
    for candidate in candidates:
        metadata = _read_metadata(root_real, os.path.join(candidate, "METADATA"))
        if metadata is None:
            continue
        name, version = metadata
        if _normalized(name) == _DIST_NAME and version != "":
            found.append(version)
    return found[0] if len(found) == 1 else None


def _normalized(name: str) -> str:
    """PEP 503: the one spelling two distribution names are compared by."""
    return _NAME_SEPARATORS.sub("-", name).lower()


def _verified_text(root_real: str, abs_path: str) -> Optional[str]:
    """One file's text, read the way every byte that decides an execution has to be:
    the path is resolved, the resolved path is required to stay inside the real
    repository root, and the bytes come from the descriptor ``fstat`` proved a regular
    file, so what decides is what the containment check judged. Bounded and total: a
    size past the cap, undecodable bytes, or any I/O failure is None, which every
    caller turns into no hand-off.

    One reader for all four of them (the declaring manifests, the layer's spec line,
    and the installed distribution's metadata), so no decision on this path can reach
    a file by any other route."""
    source = open_verified_source(abs_path, lambda real: _within(root_real, real))
    if source.fd is None:
        return None
    try:
        if os.fstat(source.fd).st_size > MAX_METADATA_BYTES:
            return None
        try:
            return read_all(source.fd).decode("utf-8")
        except UnicodeDecodeError:
            return None
    finally:
        os.close(source.fd)


def _read_metadata(root_real: str, abs_path: str) -> Optional[tuple[str, str]]:
    """One distribution's ``Name`` and ``Version``, or None."""
    text = _verified_text(root_real, abs_path)
    if text is None:
        return None
    name = ""
    version = ""
    for line in text.split("\n"):
        # RFC 822 headers: the first blank line ends them, and the body is not metadata.
        if line.strip() == "":
            break
        if name == "" and line.startswith("Name:"):
            name = line[len("Name:") :].strip()
        elif version == "" and line.startswith("Version:"):
            version = line[len("Version:") :].strip()
    return None if name == "" else (name, version)


def _read_spec_line(root_real: str, abs_path: str) -> Optional[str]:
    """The layer's declared spec line, read the way the bytes that decide an execution
    have to be: through the verified helper, inside the real root, bounded, and total.
    Only this one field is the wrapper's business. Whether the rest of the manifest is
    a valid layer is ``main()``'s question, asked after the hand-off decision and by
    whichever CLI ends up answering it."""
    text = _verified_text(root_real, abs_path)
    if text is None:
        return None
    try:
        data = json.loads(text)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    line = data.get("leji")
    return line if isinstance(line, str) else None


def _installed_console_script(root_abs: str, env_dir: str, platform: str) -> Optional[str]:
    """The environment's own ``leji`` console script, or None. Every condition is
    checked before the path is ever executed: a regular file after symlinks are
    followed, resolving inside the real repository root, and executable where the
    platform records that."""
    parts = ("Scripts", "leji.exe") if platform == "win32" else ("bin", "leji")
    abs_path = Path(env_dir) / parts[0] / parts[1]
    if not resolved_within_root(root_abs, abs_path):
        return None
    try:
        if not abs_path.is_file():
            return None
        mode = abs_path.stat().st_mode
    except OSError:
        return None
    if platform != "win32" and not mode & 0o111:
        return None
    return str(abs_path)


def _within(root_real: str, real: str) -> bool:
    return real == root_real or real.startswith(root_real + os.sep)


@dataclass
class LaunchIo:
    """Everything the launcher does to the outside world, injectable so every row of
    the result table is provable without ending the test runner."""

    platform: str
    #: POSIX: REPLACE this process with the target, so signals, exit status and stdio
    #: are the child's by construction. Never returns, except by failing.
    exec_replace: Callable[[str, list[str]], None]
    #: Windows, where a process cannot replace itself: run the target and report its
    #: return code.
    run_child: Callable[[str, list[str]], int]
    stderr: Callable[[str], None]
    exit: Callable[[int], NoReturn]


def _exec_replace(bin_path: str, args: list[str]) -> None:
    os.execv(bin_path, [bin_path, *args])


def _run_child(bin_path: str, args: list[str]) -> int:
    return subprocess.run([bin_path, *args]).returncode


def _default_launch_io() -> LaunchIo:
    def _exit(code: int) -> NoReturn:
        sys.exit(code)

    return LaunchIo(
        platform=sys.platform,
        exec_replace=_exec_replace,
        run_child=_run_child,
        stderr=lambda line: print(line, file=sys.stderr),
        exit=_exit,
    )


def launch_local_cli(handoff: LocalCliHandoff, io: Optional[LaunchIo] = None) -> NoReturn:
    """Run the repository's CLI and become its result. Never returns.

    ==================================  ======================================================
    outcome                             what this process does
    ==================================  ======================================================
    POSIX                               replaces itself with the target, so the exit status,
                                        the signal that ends it, and its stdio are the
                                        child's by construction
    Windows, a return code              exits with it: the child's 0/1/2 contract surfaces
    Windows, a negative return code     names the signal on stderr and exits 1, the
                                        documented limitation
    the target could not be run         names it on stderr and exits 2
    ==================================  ======================================================

    Failure is CLOSED, never a quiet fall-through to the global CLI: an eligible pinned
    copy was already selected, so running a different version instead would recreate the
    exact drift this hand-off exists to remove, possibly under a command that writes.
    """
    launch = _default_launch_io() if io is None else io
    if launch.platform == "win32":
        try:
            code = launch.run_child(handoff.bin, handoff.args)
        except OSError as exc:
            _failed(launch, handoff, _error_code(exc))
        if code < 0:
            launch.stderr(f"leji: the repository's Leji CLI ended by {_signal_name(-code)}")
            launch.exit(1)
        launch.exit(code)
    try:
        launch.exec_replace(handoff.bin, handoff.args)
    except OSError as exc:
        _failed(launch, handoff, _error_code(exc))
    # A replacement that returns did not happen: this process is still here, and there
    # is no status to be. Never accidental success.
    _failed(launch, handoff, "no exit status")


def _failed(io: LaunchIo, handoff: LocalCliHandoff, code: str) -> NoReturn:
    io.stderr(f"leji: cannot run the repository's Leji CLI at {handoff.display}: {code}")
    io.exit(2)


def _error_code(exc: OSError) -> str:
    """The errno name the reference SDK prints (``ENOENT``, ``EACCES``), falling back to
    the message when the failure carries no errno."""
    name = errno.errorcode.get(exc.errno) if exc.errno is not None else None
    return name if name is not None else str(exc)


def _signal_name(number: int) -> str:
    try:
        return signal.Signals(number).name
    except ValueError:
        return str(number)
