"""`leji start`'s preflight: what a person who just cloned an adopted repository has
to fix before the layer's tooling actually works here, computed READ-ONLY and reported
as a fixed list of rows. Transcribes packages/sdk/src/commands/preflight.ts.

The distinction the whole report turns on is who owns each gap. A gap in state that
lives in this clone or in this user's own configuration is PERSONAL: it is offered, on
a real terminal, and otherwise printed as an exact command. A gap in state the
repository commits is SHARED: it is reported with the maintainer's command and never
repaired here, because that write would land in files the whole team owns. Nothing here
blocks entry either way: the agent still boots, and ``--json``'s ``ready`` is the
scriptable signal.
"""

from __future__ import annotations

import os
import re
import shutil
import sys
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .detect import DetectedHost, mcp_command, mcp_json_config, spec_by_id
from .ecosystem import EcosystemReport, manager_install_argv, runner_argv
from .fsx import resolved_within_root
from .init_cmd import (
    HandoffIO,
    HookReport,
    RunOptions,
    StartHost,
    ensure_local_hook,
    hook_status,
    start_hosts,
)
from .manifest import Manifest

# Check ids, in the fixed order every report and every SDK prints them.
CHECK_CLI = "cli"
CHECK_MCP = "mcp"
CHECK_MCP_SHARED = "mcp-shared"
CHECK_HOOK = "hook"


@dataclass(frozen=True)
class Check:
    """What one check found. "ok" needs nothing; "missing" is personal (offered here,
    or printed); "shared-gap" is the repository's own state, for a maintainer;
    "skipped" means the check does not apply to this machine; "n/a" means it does not
    apply to this host; "unresolved" means the run could not tell which host to answer
    for."""

    id: str
    status: str
    detail: str
    # The exact commands that close this gap, or None when there is nothing to run.
    fix: Optional[list[str]]
    # How the fix prints: a "command" line takes the "$ " prompt, a "snippet" is pasted
    # as it stands (a config block, a hook body). Render-only, and never a key of the
    # --json projection below.
    fix_kind: str = "command"


@dataclass(frozen=True)
class PreflightResult:
    """The whole read-only answer."""

    # Every check whose id is cli, mcp or hook is ok, skipped, or not applicable. The
    # shared MCP row is project hygiene and never counts against it.
    ready: bool
    checks: list[Check]
    # The resolved hook target, so the consent step acts on what the report saw.
    hook: HookReport


# --- the text table -------------------------------------------------------
# Every string the Setup block prints lives here once, so the three SDKs transcribe
# one table rather than re-deriving prose.

# The block's fixed geometry: <margin><status><gutter><subject><gutter><detail>, so
# every detail starts at the same column and the status word is the first thing read. A
# fix line is indented under the SUBJECT column, a half indent that reads as "belongs to
# the row above" and keeps long commands inside 80 columns.
_MARGIN = "  "
_GUTTER = "  "
_STATUS_WIDTH = 4
_SUBJECT_WIDTH = 10
_FIX_INDENT = " " * 8

# The lowest SDK version that shipped support for a spec line. A layer declares exactly
# one version expectation, its spec line; this is what that expectation means for the
# CLI resolved here. The comparison is on the major, which is where a line's support is
# added or dropped.
MIN_SDK_FOR_SPEC_LINE: dict[str, str] = {"1.0": "1.0.0"}

# The word that names WHO owns the row. The status values stay the contract; these
# labels are what a person reads, and several statuses share one.
_STATUS_LABEL = {
    "ok": "ok",
    "missing": "you",
    "shared-gap": "team",
    "skipped": "n/a",
    "n/a": "n/a",
    "unresolved": "you",
}

_SUBJECT = {
    CHECK_CLI: "Leji CLI",
    CHECK_MCP: "MCP server",
    CHECK_MCP_SHARED: "Team MCP",
    CHECK_HOOK: "Git hook",
}

# Every detail is one short clause. Where a template carries a path, the path is its
# LAST token: a row that overflows overflows into the path, never through the prose, and
# nothing here is ever clipped (a truncated path misleads).
_HEADING = "Setup for this clone"
_TEXT_CLI_UNDECLARED = "not declared in this repository"
_TEXT_MCP_NONE = "no coding agent detected"
_TEXT_MCP_SHARED_OTHER = "none for this host"
_TEXT_MCP_SHARED_NO_HOST = "no host selected"
_TEXT_HOOK_NO_GIT = "not a git repository"
_TEXT_HOOK_ABSENT_PERSONAL = "none yet (per clone)"
_TEXT_SUMMARY_COMPLETE = "Setup complete."
_TEXT_OFFER_HOOK = "Install the pre-commit hook for this clone (validate + index --check)?"
_TEXT_OFFER_HOOK_FAILED = "The hook could not be written here; add it yourself:"
_OFFER_PROMPT = "Y/n"
_AGENT_FIX_LINE = "leji start --agent <name>"


def _text_cli_ok(version: str, runner: str) -> str:
    return f"{version} ({runner})"


def _text_cli_below_minimum(version: str, runner: str, minimum: str, line: str) -> str:
    return f"{version} ({runner}) is below {minimum} for spec {line}"


def _text_cli_unresolvable(runner: str) -> str:
    return f"{runner} reported no version here"


def _text_cli_unresolvable_no_install(runner: str) -> str:
    return f"{runner} reported no version; run this repo's install"


def _text_cli_not_installed(bin_rel: str) -> str:
    return f"not installed yet ({bin_rel})"


def _text_cli_verify(runner: str) -> str:
    return f"{runner} --version"


def _text_cli_undeclared_ambient(version: str) -> str:
    return f"not declared here (PATH has your own {version})"


def _text_mcp_manual(host: str) -> str:
    return f"not registered for {host}; add it yourself:"


def _text_mcp_manual_path(config: str, scope: str) -> str:
    """The first line of that snippet: where the block goes, and at which scope."""
    return f"{config} ({scope} scope)"


def _text_mcp_unresolved(hosts: list[str]) -> str:
    return f"pick one: {', '.join(hosts)}"


def _text_hook_outside_root(target: str) -> str:
    return f"hooks dir is outside this worktree: {target}"


def _text_hook_external(target: str) -> str:
    return f"add it yourself; hooks run from {target}"


# The closing line: who owes how many fixes, and that neither answer blocks entry.
def _text_summary_fixes(n: int) -> str:
    return f"{n} fix" if n == 1 else f"{n} fixes"


def _text_summary_you(fixes: str) -> str:
    return f"{fixes} for you. The agent starts either way."


def _text_summary_team(fixes: str) -> str:
    return f"{fixes} for a maintainer. The agent starts either way."


def _text_summary_both(fixes: str, team: int) -> str:
    return f"{fixes} for you, {team} for a maintainer. The agent starts either way."


# --- the version probe ----------------------------------------------------

# How long a probe may take, and how much of its output is read. A probe that exceeds
# either bound fails closed, exactly like one that never started.
PROBE_TIMEOUT_MS = 10000
PROBE_MAX_BYTES = 4096

# The one path a probe may execute directly: the bin shim a Node package manager
# installs for the declared dependency. It is a file this repository's own install put
# there, not a script the repository authors, which is the whole reason it is safe to
# run when npm/pnpm/yarn/bun are not.
NODE_BIN_REL = "node_modules/.bin/leji"

# The Node managers whose declared CLI arrives as that shim.
_NODE_MANAGERS = frozenset({"npm", "pnpm", "yarn", "bun"})

# What the probe runs for a manager whose CLI is a console-script entry of the declared
# dependency rather than a file in the repository. Each carries the flag that keeps the
# manager from installing, syncing, or fetching anything, and none of them runs a script
# the repository declares.
_MANAGER_PROBE_ARGV: dict[str, list[str]] = {
    "uv": ["uv", "run", "--no-sync", "leji"],
    "poetry": ["poetry", "run", "leji"],
    "pdm": ["pdm", "run", "leji"],
    "pipenv": ["pipenv", "run", "leji"],
    "go": ["go", "tool", "leji"],
}

# The environment the Go probe forces: a read-only module graph, no toolchain download,
# no module proxy, and no workspace file redirecting the build.
_GO_PROBE_ENV = {
    "GOFLAGS": "-mod=readonly",
    "GOTOOLCHAIN": "local",
    "GOPROXY": "off",
    "GOWORK": "off",
}

# The variables the probe passes through whatever it runs. Everything else in the
# caller's environment is dropped: a probe is not the user's shell, and an inherited
# NODE_OPTIONS, npm_config_*, or LD_PRELOAD is exactly the kind of thing that turns
# "ask for a version" into "run something else".
_PROBE_PLATFORM_ENV = ["SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP", "WINDIR"]

# Per-manager configuration the probe keeps, because without it the manager cannot find
# the environment it is being asked about. Nothing beyond this is inherited.
_PROBE_MANAGER_ENV: dict[str, list[str]] = {
    "uv": ["UV_CACHE_DIR", "UV_PROJECT_ENVIRONMENT", "VIRTUAL_ENV"],
    "poetry": ["POETRY_HOME", "POETRY_VIRTUALENVS_PATH", "POETRY_CACHE_DIR", "VIRTUAL_ENV"],
    "pdm": ["PDM_HOME", "PDM_CACHE_DIR", "VIRTUAL_ENV"],
    "pipenv": ["PIPENV_VENV_IN_PROJECT", "WORKON_HOME", "VIRTUAL_ENV"],
    "go": ["GOPATH", "GOMODCACHE", "GOCACHE", "GOBIN"],
}


def _pass_through(names: list[str], into: dict[str, str]) -> None:
    for name in names:
        value = os.environ.get(name)
        if value is not None:
            into[name] = value


def _spawned_probe_env(manager: Optional[str]) -> dict[str, str]:
    """The environment for a probe that has to find a program on the caller's PATH (a
    package manager, or the ambient ``leji``): PATH and HOME survive because the manager
    cannot answer without them, plus the manager's own named configuration. Nothing else
    does."""
    env: dict[str, str] = {}
    _pass_through(["PATH", "Path", "HOME"], env)
    _pass_through(_PROBE_PLATFORM_ENV, env)
    if manager:
        _pass_through(_PROBE_MANAGER_ENV.get(manager, []), env)
    if manager == "go":
        env.update(_GO_PROBE_ENV)
    return env


def _node_bin_dir() -> str:
    """Where a ``node`` the shim can use lives, resolved on the caller's PATH. Empty when
    there is none: the shim then fails to start, the probe fails closed, and the row says
    the CLI could not be run here."""
    found = shutil.which("node")
    return str(Path(found).parent) if found else ""


def _direct_probe_env() -> dict[str, str]:
    """The environment for the direct execution of the repository's own bin shim: nothing
    of the caller's is inherited at all. PATH holds only the directory of the node binary
    the shim's interpreter line resolves, and HOME points at a temporary directory so no
    user configuration is read."""
    env = {"PATH": _node_bin_dir(), "HOME": tempfile.gettempdir()}
    _pass_through(_PROBE_PLATFORM_ENV, env)
    return env


@dataclass(frozen=True)
class _ProbePlan:
    """How this repository's declared CLI would be asked for its version. ``direct`` is
    the installed Node shim, executed as a file; ``spawned`` is a manager or the ambient
    binary, found on the caller's PATH; ``absent`` is a Node repository whose install has
    not produced the shim (not installed, or a Yarn PnP tree that has no bin directory) —
    reported, never worked around by asking a package manager to run a script."""

    kind: str  # "direct" | "spawned" | "absent"
    bin: str = ""
    args: tuple[str, ...] = ()
    env: Optional[dict[str, str]] = None


def _bin_candidates() -> list[str]:
    """The names a Node bin shim can take, strongest first. Windows installs a ``.cmd``
    wrapper beside (or instead of) the extensionless shim."""
    return ["leji.cmd", "leji.exe", "leji"] if sys.platform == "win32" else ["leji"]


def _installed_node_bin(root: str) -> Optional[str]:
    """The installed shim's absolute path, or None. Every condition is checked before the
    path is ever executed: a regular file after symlinks are followed (npm installs the
    shim AS a symlink, so links are expected), resolving inside the real repository root,
    and executable where the platform records that."""
    for name in _bin_candidates():
        abs_path = Path(root) / "node_modules" / ".bin" / name
        if not resolved_within_root(root, abs_path):
            continue
        try:
            if not abs_path.is_file():
                continue
            mode = abs_path.stat().st_mode
        except OSError:
            continue
        if sys.platform != "win32" and not mode & 0o111:
            continue
        return str(abs_path)
    return None


def _plan_probe(root: str, report: EcosystemReport) -> _ProbePlan:
    selected = report.selected
    manager = selected.manager if selected is not None and selected.direct_declared else None
    if manager in _NODE_MANAGERS:
        found = _installed_node_bin(root)
        if found is None:
            return _ProbePlan(kind="absent")
        return _ProbePlan(kind="direct", bin=found, env=_direct_probe_env())
    argv = _MANAGER_PROBE_ARGV.get(manager or "")
    if argv is not None:
        return _ProbePlan(
            kind="spawned", bin=argv[0], args=tuple(argv[1:]), env=_spawned_probe_env(manager)
        )
    # Undeclared, pip, and pre-1.24 Go all reach the CLI the same way a person does:
    # whatever `leji` the PATH resolves, run with the same sanitized environment.
    return _ProbePlan(kind="spawned", bin="leji", env=_spawned_probe_env(None))


# A bare <major>.<minor>.<patch> with an optional prerelease or build tail, which is what
# every `leji --version` prints. Anything else is not a version this probe will believe.
VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$")


def _parse_version(stdout: str) -> Optional[tuple[str, int]]:
    for raw in stdout.split("\n"):
        line = raw.strip()
        if line == "":
            continue
        m = VERSION_RE.match(line)
        return (line, int(m.group(1))) if m else None
    return None


def _probe_version(root: str, plan: _ProbePlan, io: HandoffIO) -> Optional[tuple[str, int]]:
    """Ask the CLI this repository would run for its version. Argv, never a shell; cwd
    pinned to the root; stdin closed; output and time bounded; a sanitized environment;
    and never a package manager's script runner. Every failure mode — a missing
    executable, a non-zero exit, a timeout, output that is not a version — comes back as
    None, because a probe that cannot answer is not evidence that the CLI is there."""
    if plan.kind == "absent" or io.run is None:
        return None
    res = io.run(
        plan.bin,
        [*plan.args, "--version"],
        root,
        RunOptions(
            quiet=True,
            capture=True,
            timeout_ms=PROBE_TIMEOUT_MS,
            max_bytes=PROBE_MAX_BYTES,
            env=plan.env,
        ),
    )
    if not res.started or res.error is not None:
        return None
    return _parse_version(res.stdout)


# --- the checks -----------------------------------------------------------


def _argv_line(argv: list[str]) -> str:
    return " ".join(argv)


def _cli_check(root: str, manifest: Manifest, report: EcosystemReport, io: HandoffIO) -> Check:
    selected = report.selected
    runner = runner_argv(report)
    spec_line = manifest["leji"]
    minimum = MIN_SDK_FOR_SPEC_LINE.get(spec_line)
    plan = _plan_probe(root, report)

    if selected is None or not selected.direct_declared:
        # The gap is the repository's declaration, which is a committed file: report it
        # with the maintainer's command whatever this machine happens to have. The plain
        # `leji` is still probed, so an ambient install is named as what it is.
        found = _probe_version(root, plan, io)
        add = selected.add if selected is not None else None
        detail = _TEXT_CLI_UNDECLARED if found is None else _text_cli_undeclared_ambient(found[0])
        return Check(CHECK_CLI, "shared-gap", detail, [_argv_line(add)] if add else None)

    found = _probe_version(root, plan, io)
    # The row names what actually answered: the installed shim for a Node repository,
    # and the manager's own runner everywhere else.
    node_shim = plan.kind in ("direct", "absent")
    shown = NODE_BIN_REL if node_shim else _argv_line(runner)
    install_argv = manager_install_argv(selected.manager) if selected.manager else None
    fix: Optional[list[str]] = None
    if install_argv:
        fix = [_argv_line(install_argv)]
        # A Node repository whose shim is absent gets the install command AND the way to
        # confirm it worked, because leji will not run a package manager to find out.
        if node_shim:
            fix.append(_text_cli_verify(_argv_line(runner)))
    if plan.kind == "absent":
        return Check(CHECK_CLI, "missing", _text_cli_not_installed(NODE_BIN_REL), fix)
    if found is None:
        # A manager with no single install command (pip, pre-1.24 Go) has no argv to
        # print, so the row itself has to carry the instruction.
        detail = _text_cli_unresolvable(shown) if fix else _text_cli_unresolvable_no_install(shown)
        return Check(CHECK_CLI, "missing", detail, fix)
    if minimum is not None and found[1] < int(minimum.split(".")[0]):
        return Check(
            CHECK_CLI,
            "missing",
            _text_cli_below_minimum(found[0], shown, minimum, spec_line),
            fix,
        )
    return Check(CHECK_CLI, "ok", _text_cli_ok(found[0], shown), None)


def _personal_mcp_add(host_id: str) -> Optional[tuple[str, list[str]]]:
    """The argv that registers the server for THIS USER on a host, or None when the host
    has no registration command at all."""
    spec = spec_by_id(host_id)
    if spec is None:
        return None
    argv = spec.mcp_add_user or spec.mcp_add
    return (spec.bins[0], argv) if argv else None


def _mcp_check(
    root: str, host: Optional[StartHost], detected: list[DetectedHost], io: HandoffIO
) -> Check:
    if host is None:
        launchable = start_hosts(detected)
        if len(launchable) > 1:
            return Check(
                CHECK_MCP,
                "unresolved",
                _text_mcp_unresolved([h.name for h in launchable]),
                [_AGENT_FIX_LINE],
            )
        # A host Leji cannot register for is still worth a row: the person can add the
        # standard configuration by hand, which is the only fix that exists for it.
        for h in detected:
            spec = spec_by_id(h.id)
            if spec is None or spec.mcp_config is None:
                continue
            return Check(
                CHECK_MCP,
                "missing",
                _text_mcp_manual(h.name),
                [
                    _text_mcp_manual_path(spec.mcp_config.path, spec.mcp_config.scope),
                    *mcp_json_config(spec.mcp_config.shape).split("\n"),
                ],
                "snippet",
            )
        return Check(CHECK_MCP, "skipped", _TEXT_MCP_NONE, None)

    spec = spec_by_id(host.id)
    if spec is not None and spec.mcp_check and io.run is not None:
        res = io.run(host.bin, spec.mcp_check, root, RunOptions(quiet=True))
        if res.started and res.error is None:
            return Check(CHECK_MCP, "ok", f"registered for {host.name}", None)
    personal = _personal_mcp_add(host.id)
    fix = [f"{personal[0]} {_argv_line(personal[1])}"] if personal else None
    return Check(CHECK_MCP, "missing", f"not registered for {host.name}", fix)


def _committed_file(root: str, rel: str) -> bool:
    """True when a regular file stands at ``rel`` directly inside the repository root."""
    abs_path = Path(root) / rel
    try:
        if not abs_path.is_file():
            return False
    except OSError:
        return False
    return resolved_within_root(root, abs_path)


def _mcp_shared_check(root: str, host: Optional[StartHost]) -> Check:
    if host is None:
        return Check(CHECK_MCP_SHARED, "n/a", _TEXT_MCP_SHARED_NO_HOST, None)
    spec = spec_by_id(host.id)
    if spec is None or not spec.mcp_shared_file or not spec.mcp_add:
        return Check(CHECK_MCP_SHARED, "n/a", _TEXT_MCP_SHARED_OTHER, None)
    file = spec.mcp_shared_file
    if _committed_file(root, file):
        return Check(CHECK_MCP_SHARED, "ok", f"{file} committed", None)
    return Check(
        CHECK_MCP_SHARED,
        "shared-gap",
        f"no {file} committed",
        [mcp_command(spec, spec.mcp_add)],
    )


_HOOK_FIX = ["leji ci --hooks"]


def _hook_check(status: HookReport) -> Check:
    if status.ownership == "no-git":
        return Check(CHECK_HOOK, "missing", _TEXT_HOOK_NO_GIT, None)
    if status.state == "current":
        return Check(
            CHECK_HOOK,
            "ok",
            f"runs leji checks before each commit: {status.path}",
            None,
        )
    if status.ownership == "personal":
        if status.state == "absent":
            return Check(CHECK_HOOK, "missing", _TEXT_HOOK_ABSENT_PERSONAL, list(_HOOK_FIX))
        return Check(
            CHECK_HOOK,
            "missing",
            f"not leji-managed; add the block to {status.path}",
            status.snippet.split("\n"),
            "snippet",
        )
    if status.ownership == "shared":
        return Check(
            CHECK_HOOK,
            "shared-gap",
            f"no leji block in {status.path}",
            list(_HOOK_FIX),
        )
    if status.ownership == "outside-root":
        # A linked worktree's hooks live in the common git directory, outside this
        # working tree. It is still per-clone state, but the writer refuses anything
        # outside the repository root, so the only honest answer is the snippet.
        return Check(
            CHECK_HOOK,
            "missing",
            _text_hook_outside_root(status.path),
            status.snippet.split("\n"),
            "snippet",
        )
    # Outside the repository entirely: reported with the snippet, never written.
    return Check(
        CHECK_HOOK,
        "missing",
        _text_hook_external(status.path),
        status.snippet.split("\n"),
        "snippet",
    )


# --- the report -----------------------------------------------------------

_READY_IDS = (CHECK_CLI, CHECK_MCP, CHECK_HOOK)
_READY_STATUSES = ("ok", "skipped", "n/a")


def run_preflight(
    root: str,
    manifest: Manifest,
    host: Optional[StartHost],
    detected: list[DetectedHost],
    report: EcosystemReport,
    io: HandoffIO,
) -> PreflightResult:
    """Run every check, in the fixed order, writing nothing. The only child processes
    are the bounded version probe and the host's own registration query, both through
    the injectable IO."""
    root_abs = os.path.abspath(root)
    hook = hook_status(root_abs, runner_argv(report))
    checks = [
        _cli_check(root_abs, manifest, report, io),
        _mcp_check(root_abs, host, detected, io),
        _mcp_shared_check(root_abs, host),
        _hook_check(hook),
    ]
    ready = all(c.status in _READY_STATUSES for c in checks if c.id in _READY_IDS)
    return PreflightResult(ready=ready, checks=checks, hook=hook)


def check_document(check: Check) -> dict[str, object]:
    """What ``--json`` publishes for one check: exactly the four keys the document
    promises, so a render-only field can never reach the scriptable contract."""
    return {"id": check.id, "status": check.status, "detail": check.detail, "fix": check.fix}


# The escape each label wears when color is on. The word is styled; its padding is not,
# so the columns line up whether or not the escapes are there.
_STATUS_COLOR = {"ok": "\x1b[32m", "you": "\x1b[33m", "team": "\x1b[36m", "n/a": "\x1b[2m"}
_COLOR_RESET = "\x1b[0m"


def color_decision(is_tty: bool, env: Mapping[str, str]) -> bool:
    """Whether the Setup block may color its status words: a real terminal that has not
    asked for plain text. ``NO_COLOR`` disables at any value, empty included, because the
    convention is presence. A pure function of the two things it reads, decided once at
    the CLI boundary and injected, so nothing downstream consults the process and every
    piped byte is escape-free by construction."""
    return bool(is_tty) and "NO_COLOR" not in env and env.get("TERM") != "dumb"


def _summary_line(you: int, team: int) -> str:
    if you and team:
        return _text_summary_both(_text_summary_fixes(you), team)
    if you:
        return _text_summary_you(_text_summary_fixes(you))
    if team:
        return _text_summary_team(_text_summary_fixes(team))
    return _TEXT_SUMMARY_COMPLETE


def render_preflight(checks: list[Check], color: bool = False) -> str:
    """The Setup block: a heading, one fixed-column row per check with its fixes under
    it, and one closing line counting what is owed. The counts come from the labels the
    rows already printed, so the block can never say something its own rows do not."""
    lines = [_HEADING, ""]
    you = 0
    team = 0
    for c in checks:
        label = _STATUS_LABEL[c.status]
        if label == "you":
            you += 1
        elif label == "team":
            team += 1
        word = f"{_STATUS_COLOR[label]}{label}{_COLOR_RESET}" if color else label
        status = word + " " * (_STATUS_WIDTH - len(label))
        subject = _SUBJECT[c.id].ljust(_SUBJECT_WIDTH)
        lines.append(f"{_MARGIN}{status}{_GUTTER}{subject}{_GUTTER}{c.detail}")
        prompt = "" if c.fix_kind == "snippet" else "$ "
        for fix in c.fix or []:
            lines.append(f"{_FIX_INDENT}{prompt}{fix}")
    lines.append("")
    lines.append(f"{_MARGIN}{_summary_line(you, team)}")
    return "\n".join(lines)


# --- the consented repairs ------------------------------------------------


def offer_preflight_fixes(
    root: str,
    host: Optional[StartHost],
    result: PreflightResult,
    runner: list[str],
    interactive: bool,
    io: HandoffIO,
) -> None:
    """Offer the personal repairs the report found, in the order it printed them. Only
    state this user or this clone owns is ever offered: the host registration for this
    user, and the per-clone hook. A shared gap is never offered, because accepting it
    would write a file the repository commits."""
    if not interactive:
        return

    def yes(question: str) -> bool:
        return io.read_line(question, _OFFER_PROMPT).lower() in ("", "y", "yes")

    mcp = next((c for c in result.checks if c.id == CHECK_MCP), None)
    personal = _personal_mcp_add(host.id) if host is not None else None
    if mcp is not None and mcp.status == "missing" and personal is not None and io.run is not None:
        assert host is not None
        if yes(f"Register the Leji MCP server for {host.name} for your user?"):
            res = io.run(personal[0], personal[1], root, RunOptions())
            if res.started and res.error is None:
                print(f"Registered the Leji MCP server for {host.name}.")
            else:
                print(f"{personal[0]} did not register cleanly; run it yourself:")
                print(f"{_FIX_INDENT}$ {personal[0]} {_argv_line(personal[1])}")

    hook = result.hook
    if hook.ownership == "personal" and hook.state == "absent" and yes(_TEXT_OFFER_HOOK):
        written = ensure_local_hook(root, runner)
        if written.action == "manual":
            print(_TEXT_OFFER_HOOK_FAILED)
            print(f"\n{written.snippet or ''}")
        else:
            print(f"Wrote {written.path}; it runs before every commit in this clone.")
