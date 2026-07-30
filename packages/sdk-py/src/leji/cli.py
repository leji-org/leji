"""The leji CLI, behaviorally identical to the Node SDK's.

Exit codes: 0 clean (or warnings only), 1 findings, 2 usage/internal error.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import sys
from typing import cast

from .changelog import compact_changelog, seed_changelog_if_missing
from .conformance import conformance_report, render_explain
from .detect import detect_hosts, detect_layer, render_detect
from .viewer_cmd import (
    PROTECT_WARNING,
    build_viewer,
    generate_viewer,
    open_browser,
    resolve_viewer_port,
    serve_viewer,
)
from .findings import Finding, has_errors, sort_findings, summarize
from .freshness import freshness_report
from .fsx import strip_slash
from .indexgen import check_index, write_index
from .gitutil import git_origin_url
from .init_cmd import (
    StartOptions,
    add_agent,
    adopt_layer,
    ci_provider_from_remote,
    ensure_ci_workflow,
    ensure_local_hook,
    enter_layer,
    entering_adopted,
    entering_the_layer,
    entering_via_boot,
    handoff_offer,
    init_layer,
    GuardOfferOptions,
    McpOfferOptions,
    offer_approval_guard,
    offer_mcp_install,
)
from .manifest import CATEGORY_IDS, effective_changelog_path, effective_index_path, load_manifest
from .mounts import (
    SelfProjection,
    federation_enforcement,
    hydrate_mounts,
    locate_mount,
    mount_status,
)
from .route import RouteInput, route
from .status import status_report
from .schemas import SDK_VERSION, SUPPORTED_LINES, load_cli_spec
from .validate import check_changelog_append_only, validate_layer
from .writeplan import render_write_plan


_SURROGATE_RE = re.compile("[\ud800-\udfff]")


def _json_quote(s: str) -> str:
    """One string as JSON.stringify writes it: non-ASCII stays literal, and a lone
    surrogate escapes as ``\\udXXX`` (well-formed JSON.stringify), which is also
    what keeps the message encodable as UTF-8 on the way to stderr."""
    return _SURROGATE_RE.sub(
        lambda m: "\\u%04x" % ord(m.group(0)), json.dumps(s, ensure_ascii=False)
    )


def _projection_json(proj: SelfProjection) -> dict[str, object]:
    """The self-projection as the discriminated union the Node report emits: the
    state plus only the fields that state carries."""
    if proj.state == "no-commit":
        return {"state": "no-commit"}
    if proj.state == "ok":
        return {"state": "ok", "commit": proj.commit, "files": proj.files}
    return {"state": "fail", "commit": proj.commit, "detail": proj.detail}


def _build_usage() -> str:
    """Top-level help, generated from cli.json so it can't drift from the docs.
    Commands + global options only; per-command options live in
    `leji <command> --help`. Byte-for-byte parity with renderUsage() in index.ts."""
    spec = load_cli_spec()
    commands = cast("list[dict[str, object]]", spec["commands"])
    global_options = cast("list[dict[str, str]]", spec["globalOptions"])
    out: list[str] = [
        f"leji {SDK_VERSION}: reference CLI for the Leji specification "
        f"(spec line {', '.join(SUPPORTED_LINES)})",
        "",
        f"Usage: {spec['usage']}",
        "",
        "Commands:",
    ]
    cmd_width = max(len(str(c["name"])) for c in commands) + 3
    for c in commands:
        out.append(f"   {str(c['name']).ljust(cmd_width)}{c['summary']}")

    opt_width = max(len(o["flags"]) for o in global_options) + 3
    out.extend(["", "Options:"])
    for o in global_options:
        out.append(f"   {o['flags'].ljust(opt_width)}{o['summary']}")

    out.extend(
        [
            "",
            "Run `leji <command> --help` for a command and its options.",
            "Full reference: https://leji.org/cli/",
        ]
    )
    return "\n".join(out)


def _build_command_help(name: str) -> str | None:
    """Per-command help from cli.json. Returns None for an undocumented command
    (caller falls back to top-level usage). Parity with renderCommandHelp() in index.ts."""
    spec = load_cli_spec()
    commands = cast("list[dict[str, object]]", spec["commands"])
    global_options = cast("list[dict[str, str]]", spec["globalOptions"])
    cmd = next((c for c in commands if c["name"] == name), None)
    if cmd is None:
        return None
    out: list[str] = [
        f"leji {cmd['name']}: {cmd['summary']}",
        "",
        f"Usage: {cmd['usage']}",
        "",
        str(cmd["description"]),
    ]
    details = cast("list[str]", cmd.get("details") or [])
    if details:
        out.extend(["", "Details:"])
        for d in details:
            out.append(f"   - {d}")
    cmd_opts = cast("list[dict[str, str]]", cmd["options"])
    opts = [*global_options, *cmd_opts]
    opt_width = max(len(o["flags"]) for o in opts) + 3
    out.extend(["", "Options:"])
    for o in opts:
        # Byte parity with Node: an option missing "summary" in cli.json renders
        # the literal "undefined" there (template-string of an absent field).
        out.append(f"   {o['flags'].ljust(opt_width)}{o.get('summary', 'undefined')}")
    examples = cast("list[str]", cmd.get("examples") or [])
    if examples:
        out.extend(["", "Examples:"])
        for e in examples:
            out.append(f"   {e}")
    out.extend(["", "Full reference: https://leji.org/cli/"])
    return "\n".join(out)


USAGE = _build_usage()


def _is_calendar_date(v: str) -> bool:
    """A real calendar date in YYYY-MM-DD. The pattern alone accepts 2026-02-30, so the
    value is parsed: only a date that survives parsing is real."""
    try:
        return _dt.date.fromisoformat(v).isoformat() == v
    except ValueError:
        return False


def _report_scaffold_index(findings: list[Finding]) -> int:
    """Report index-generation findings from ``init`` / ``adopt``. The scaffold is
    already on disk, so this never unwinds it; it says what could not be indexed and
    returns the exit status, because a scaffold whose index is missing will fail the CI
    that ``leji ci`` generates and reporting success would hide that until then."""
    if not has_errors(findings):
        return 0
    print("")
    _print_findings(findings)
    print(
        "leji: the context index could not be generated, so it was not written.\n"
        "      The scaffold is in place; fix the findings above and run `leji index`.",
        file=sys.stderr,
    )
    return 1


def _print_findings(findings: list[Finding]) -> None:
    for f in sort_findings(findings):
        where = f" {f.path}" if f.path else ""
        label = "error  " if f.severity == "error" else "warning"
        print(f"{label} {f.rule}{where}: {f.message}")


def _mount_findings(rows: list[dict[str, object]]) -> list[Finding]:
    """The mount findings ``mounts hydrate`` and ``mounts status`` emit: what this
    run observed and nothing beyond it. The row-level warnings describe the run
    that is happening, never a remembered one, and all are visibility rather than
    failure — ``hydrate`` stays best-effort, so none moves the exit code. Emitted in
    declaration order, as Node emits them; the human renderer sorts, the JSON
    surface does not."""
    out: list[Finding] = []
    for row in rows:
        # An unavailable mount whose pinned layer would not project: the outcome
        # alone is not the diagnostic interface JSON consumers read, so the failure
        # reaches findings[] too, carrying the projection's own stable detail
        # unaltered.
        if row.get("status") == "unavailable" and row.get("projectionFailed"):
            out.append(
                Finding(
                    rule="mount-projection-failed",
                    severity="warning",
                    message=f'mount "{row["name"]}" did not project at its pin: '
                    f"{row.get('detail')}",
                    path=cast("str", row["name"]),
                )
            )
        if row.get("storeFetched") is False:
            out.append(
                Finding(
                    rule="mount-store-fetch-failed",
                    severity="warning",
                    message="the managed store could not be established by the requested fetch",
                    path=cast("str", row["name"]),
                )
            )
        if row.get("witnessRefreshFailed"):
            out.append(
                Finding(
                    rule="mount-witness-refresh-failed",
                    severity="warning",
                    message="the managed witness ref could not be refreshed by the requested fetch",
                    path=cast("str", row["name"]),
                )
            )
    return out


# Prose for the stable `mounts status` reason codes: --json emits the code, a
# person reads the sentence.
_MOUNT_REASONS = {
    "mount-source-unnormalizable": "source is not a normalizable locator",
    "mount-no-tracking-ref": (
        "no trackingRef declared; the source's advertised default branch needs network access"
    ),
    "mount-tracking-ref-invalid": "trackingRef is not a fully qualified branch or tag",
    "mount-pin-unavailable": (
        "no reachable object store holds the pin (declare a hint, or pass --fetch)"
    ),
    "mount-witness-unavailable": (
        "no object store holding the pin resolves the witness ref; "
        "run `leji mounts hydrate --fetch`"
    ),
    "mount-source-ambiguous": (
        "more than one submodule matches the source; "
        "declare an explicit hint in .leji/mounts.local.json"
    ),
    "mount-ancestry-incomplete": (
        "incomplete ancestry; the comparison repository cannot answer the range"
    ),
}


def _emit(command: str, findings: list[Finding], as_json: bool, **extra: object) -> int:
    ordered = sort_findings(findings)
    summary = summarize(ordered)
    ok = summary["errors"] == 0
    if as_json:
        payload = {
            "command": command,
            "ok": ok,
            "findings": [f.to_dict() for f in ordered],
            "summary": summary,
            **extra,
        }
        print(json.dumps(payload, indent=2, ensure_ascii=False))
    else:
        _print_findings(ordered)
        extras = ", ".join(
            f"{k}: {v}"
            for k, v in extra.items()
            if isinstance(v, (str, int)) and not isinstance(v, bool)
        )
        plural_e = "" if summary["errors"] == 1 else "s"
        plural_w = "" if summary["warnings"] == 1 else "s"
        tail = f"; {extras}" if extras else ""
        print(
            f"{'ok' if ok else 'failed'} ({summary['errors']} error{plural_e}, {summary['warnings']} warning{plural_w}{tail})"
        )
    return 0 if ok else 1


_KNOWN_COMMANDS = frozenset(
    {
        "validate",
        "index",
        "changelog",
        "freshness",
        "status",
        "route",
        "conformance",
        "mounts",
        "detect",
        "init",
        "adopt",
        "viewer",
        "view",
        "start",
        "ci",
        "agent",
    }
)


# Flags that consume a following value (so it is not mistaken for the command).
# Mirrors VALUE_FLAGS in packages/sdk/src/index.ts.
_VALUE_FLAGS = frozenset(
    {
        "--root",
        "--dir",
        "--level",
        "--mode",
        "--name",
        "--port",
        "--agent",
        "--host",
        "--role",
        "--out",
        "--keep",
        "--before",
        "--provider",
        "--paths",
        "--categories",
        "--topics",
        "--as-of",
        "--federation",
    }
)


# The largest `--keep`, chosen so all three SDKs carry the value identically:
# above it Go's strconv.Atoi overflows while Number() and int() keep going, and no
# changelog has 2^31 entries. Mirrors KEEP_MAX in packages/sdk/src/index.ts.
_KEEP_MAX = 2147483647

# A plain decimal integer, optionally `+`-signed. `[0-9]` rather than `\d`, which
# in Python also matches non-ASCII decimal digits; Node's `\d` is ASCII-only.
_INT_FLAG_RE = re.compile(r"^\+?[0-9]+$")


def _int_flag(raw: str, low: int, high: int) -> int | None:
    """A numeric flag's value: a plain decimal integer inside [low, high], else
    None. Deliberately not a bare int(), which also accepts ` 8 `, `1_0`, and
    non-ASCII digits — spellings Node's parseIntFlag and Go's strconv.Atoi both
    reject, so `--port ' 8 '` served port 8 here and was a usage error there."""
    if not _INT_FLAG_RE.match(raw):
        return None
    v = int(raw)
    return v if low <= v <= high else None


# Numeric flags and the range each accepts, with the message a value outside it
# produces. Checked in _parse_error, where Node and Go check them (inside the argv
# scan, ahead of the per-command flag check), not after argparse.
_NUMERIC_FLAGS = {
    "--port": (0, 65535, "--port must be 0-65535"),
    "--keep": (1, _KEEP_MAX, "--keep must be a positive integer"),
}

# Flags taking one of a fixed set of words, checked in the same place and for the
# same reason as the numeric ones.
_ENUM_FLAGS = {
    "--level": (("core", "indexed"), "--level must be core or indexed"),
    "--mode": (("solo", "team"), "--mode must be solo or team"),
}


def _expand_equals_flags(argv: list[str]) -> list[str]:
    """Expand `--flag=value` into `--flag value` for declared value flags, so both
    spellings work (`--federation=available` and `--federation available`). Tokens
    after a literal `--` are host pass-through and stay untouched."""
    out: list[str] = []
    passthrough = False
    for a in argv:
        if a == "--":
            passthrough = True
        eq = a.find("=") if not passthrough and a.startswith("--") else -1
        if eq > 2 and a[:eq] in _VALUE_FLAGS:
            out.extend([a[:eq], a[eq + 1 :]])
        else:
            out.append(a)
    return out


def _first_command(argv: list[str]) -> str | None:
    """First positional token (the command), skipping flags and their values.
    Meta-flags (-h/--help/-v/--version) count as the command. None if absent."""
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in ("-h", "--help", "-v", "--version"):
            return arg
        if arg.startswith("-"):
            if arg in _VALUE_FLAGS:
                i += 1  # skip the flag's value
            i += 1
            continue
        return arg
    return None


def _positionals(argv: list[str]) -> list[str]:
    """Positional tokens (command + subcommand), skipping flags and their values."""
    out: list[str] = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg.startswith("-"):
            if arg in _VALUE_FLAGS:
                i += 1  # skip the flag's value
            i += 1
            continue
        out.append(arg)
        i += 1
    return out


def _reorder_for_argparse(argv: list[str]) -> list[str]:
    """argv with the positionals moved ahead of the flags, order preserved inside
    each group. argparse binds an option to the parser that declares it, so a
    global written before the command (`leji --json validate`) was an
    `unrecognized arguments` exit 2 here while Node and Go, which scan a flat argv,
    accepted it anywhere and exited 0. Every token has already been checked by
    _parse_error and _allowed_flags_for, so a `-`-prefixed token here is a declared
    flag and the token after a value flag is its value."""
    positionals: list[str] = []
    flags: list[str] = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg.startswith("-"):
            flags.append(arg)
            if arg in _VALUE_FLAGS and i + 1 < len(argv):
                flags.append(argv[i + 1])
                i += 1
        else:
            positionals.append(arg)
        i += 1
    return positionals + flags


def _is_flag_token(v: str | None) -> bool:
    """A token that is itself a flag (not bare "-") can't be a flag's value:
    `--root --json` is a missing value, not root="--json"."""
    return v is not None and v != "-" and v.startswith("-")


def _known_flags() -> set[str]:
    """Every flag token the CLI declares anywhere: the globals plus every
    command's options, read from cli.json. This is the Python equivalent of the
    fixed switch in Node's parseFlags (the two sets are identical by
    construction): a `-`-prefixed token outside it is an unknown option wherever
    it appears, decided before any command is chosen."""
    spec = load_cli_spec()
    known: set[str] = set()
    global_options = cast("list[dict[str, str]]", spec["globalOptions"])
    commands = cast("list[dict[str, object]]", spec["commands"])
    option_lists = [global_options]
    option_lists.extend(cast("list[dict[str, str]]", c["options"]) for c in commands)
    for options in option_lists:
        for o in options:
            for t in _flag_tokens(str(o["flags"])):
                # `--paths <a,b,...>` tokenizes to junk fragments too; only
                # `-`-prefixed tokens can ever match a flag seen in argv.
                if t.startswith("-"):
                    known.add(t)
    return known


def _parse_error(argv: list[str]) -> str | None:
    """The first usage error in argv, scanned left to right exactly as Node's
    parseFlags scans: an undeclared flag is `unknown option <tok>`, and a
    declared value flag whose value is absent, empty (`--flag=` expands to an
    empty token; Node's `!v` rejects it), or itself a flag token is
    `<tok> requires a value`. A numeric flag whose value is not a decimal integer
    in range, or an enum flag whose value is not one of its words, gets that flag's
    own message, here rather than after argparse, so the three agree on which error
    a command that does not even accept `--port` reports. Whichever comes first in
    argv wins, so all three SDKs report the same token with the same text. None
    when argv is clean."""
    known = _known_flags()
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in _VALUE_FLAGS:
            nxt = argv[i + 1] if i + 1 < len(argv) else None
            # `--topics` keeps an empty occurrence: the route command rejects it
            # with the topic-shaped message rather than a bare usage dump, which
            # is what Node's parser does (`v === undefined`, never `!v`).
            missing = nxt is None if arg == "--topics" else not nxt
            if missing or _is_flag_token(nxt):
                return f"{arg} requires a value"
            numeric = _NUMERIC_FLAGS.get(arg)
            if numeric is not None:
                low, high, message = numeric
                if _int_flag(cast("str", nxt), low, high) is None:
                    return message
            enum = _ENUM_FLAGS.get(arg)
            if enum is not None:
                words, message = enum
                if nxt not in words:
                    return message
            i += 2
            continue
        if arg.startswith("-") and arg not in known:
            return f"unknown option {arg}"
        i += 1
    return None


def _meta_flag(argv: list[str]) -> str:
    """'help' or 'version' if that meta-flag appears anywhere in argv (skipping
    value-flag values), else ''. Short-circuits dispatch so `leji <command> --help`
    shows usage instead of running: help/version must have no side effects."""
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in ("-h", "--help"):
            return "help"
        # -v is version, not verbose: no --verbose flag exists to collide with.
        if arg in ("-v", "--version"):
            return "version"
        if arg in _VALUE_FLAGS:
            i += 2  # skip the flag and the value it consumes
            continue
        i += 1
    return ""


# Commands that take a subcommand (second positional), e.g. `changelog check`,
# `viewer serve`. The bare form is valid only when cli.json documents it.
_TWO_WORD_COMMANDS = frozenset({"changelog", "viewer", "mounts"})


def _flag_tokens(flags_str: str) -> list[str]:
    """ "--yes, -y" -> ["--yes","-y"]; "--port <n>" -> ["--port"]. Mirrors Node."""
    out: list[str] = []
    for part in flags_str.split(","):
        token = part.strip().split()
        if token and token[0]:
            out.append(token[0])
    return out


def _seen_flags(argv: list[str]) -> list[str]:
    """The flags present in argv, skipping the value each value flag consumes."""
    out: list[str] = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("-"):
            eq = a.find("=") if a.startswith("--") else -1
            name = a[:eq] if eq > 2 else a
            out.append(name)
            if name in _VALUE_FLAGS and eq < 0:
                i += 1  # skip the flag's value, not a flag itself
        i += 1
    return out


def _allowed_flags_for(command: str, sub: str | None) -> set[str] | None:
    """Flags valid for a command (globals + its declared options) from cli.json.
    None for an unknown command. Mirrors allowedFlagsFor in index.ts."""
    spec = load_cli_spec()
    commands = cast("list[dict[str, object]]", spec["commands"])
    name = f"{command} {sub}" if command in _TWO_WORD_COMMANDS and sub else command
    cmd = next((c for c in commands if c["name"] == name), None)
    if cmd is None:
        return None
    allowed: set[str] = set()
    global_options = cast("list[dict[str, str]]", spec["globalOptions"])
    cmd_options = cast("list[dict[str, str]]", cmd["options"])
    for o in [*global_options, *cmd_options]:
        for t in _flag_tokens(str(o["flags"])):
            allowed.add(t)
    return allowed


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="leji",
        description=f"Reference SDK for the Leji specification (spec line {', '.join(SUPPORTED_LINES)}).",
        add_help=False,
    )
    sub = parser.add_subparsers(dest="command")

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--root", default=".", help="repository root to operate on")
        p.add_argument("--json", action="store_true", help="machine-readable output")

    validate = sub.add_parser(
        "validate", help="validate the layer: manifest, artifacts, frontmatter, lint rules"
    )
    common(validate)
    validate.add_argument(
        "--content", action="store_true", help="add the warning-only content lint"
    )
    validate.add_argument(
        "--federation",
        default=None,
        help="opt-in federation enforcement: available (every mount) or required (task scope)",
    )
    validate.add_argument(
        "--paths",
        default=None,
        help="task scope for --federation=required: comma-separated repository paths",
    )

    index = sub.add_parser("index", help="generate the context index (or --check it)")
    common(index)
    index.add_argument(
        "--check", action="store_true", help="verify the stored index is current (no write)"
    )

    changelog = sub.add_parser("changelog", help="changelog checks")
    changelog_sub = changelog.add_subparsers(dest="subcommand")
    changelog_check = changelog_sub.add_parser("check", help="schema + append-only discipline")
    common(changelog_check)
    changelog_check.add_argument(
        "--strict", action="store_true", help="unverifiable append-only becomes an error"
    )
    changelog_compact = changelog_sub.add_parser(
        "compact", help="fold the oldest entries into a single compaction entry"
    )
    common(changelog_compact)
    changelog_compact.add_argument(
        "--keep", type=int, default=None, help="fold every entry except the newest N"
    )
    changelog_compact.add_argument(
        "--before", default=None, help="fold every entry dated strictly before YYYY-MM-DD"
    )

    freshness = sub.add_parser("freshness", help="report freshness horizons")
    common(freshness)
    freshness.add_argument("--strict", action="store_true", help="expired horizons become errors")

    status = sub.add_parser(
        "status", help="report unindexed, dangling, and stale documents in the layer"
    )
    common(status)
    status.add_argument(
        "--strict", action="store_true", help="exit nonzero if anything is flagged, for CI"
    )

    route_cmd = sub.add_parser("route", help="show the governed context a task's scope routes to")
    common(route_cmd)
    route_cmd.add_argument("--paths", help="repository-relative paths the task reads or changes")
    route_cmd.add_argument("--categories", help="content categories the task explicitly names")
    route_cmd.add_argument(
        "--topics",
        action="append",
        default=None,
        help="a topic the task explicitly names; repeatable, one whole topic per occurrence",
    )
    route_cmd.add_argument("--as-of", dest="as_of", help="reference date for document expiry")

    conformance = sub.add_parser(
        "conformance", help="score the layer against its claimed conformance level"
    )
    common(conformance)
    conformance.add_argument(
        "--explain",
        action="store_true",
        help="explain what it would take to reach the next conformance level",
    )
    conformance.add_argument(
        "--federation",
        default=None,
        help="run the networked pin-reachability probe (takes only verify)",
    )

    # `leji mounts <hydrate|status|locate>`: the federation resolver commands.
    mounts = sub.add_parser("mounts", help="resolve and inspect declared federation mounts")
    mounts_sub = mounts.add_subparsers(dest="subcommand")
    mounts_hydrate = mounts_sub.add_parser(
        "hydrate", help="materialize declared federation mounts into the resolver cache"
    )
    common(mounts_hydrate)
    mounts_hydrate.add_argument(
        "--fetch",
        action="store_true",
        help="fetch the pin from the declared source into the resolver-managed store",
    )
    mounts_status = mounts_sub.add_parser(
        "status", help="report each mount's availability, integrity, and pin ancestry"
    )
    common(mounts_status)
    mounts_status.add_argument(
        "--check-integrity",
        action="store_true",
        dest="check_integrity",
        help="verify the cached projection byte-for-byte against a reachable object store",
    )
    mounts_locate = mounts_sub.add_parser(
        "locate", help="print resolver state for one mount: projection path, pin, verification"
    )
    common(mounts_locate)
    # Optional at parse time: the missing-name usage error is issued in dispatch
    # (after the manifest load), mirroring the Node ordering exactly.
    mounts_locate.add_argument("name", nargs="?", default=None)

    common(sub.add_parser("detect", help="detect the coding-agent hosts available on this machine"))

    init = sub.add_parser("init", help="bootstrap a new context layer from the templates")
    init.add_argument("--dir", default=".", help="target directory")
    init.add_argument("--root", default=".", help="alias for --dir (parity with other commands)")
    # Accepted for cross-SDK parity (every command takes --json); a no-op here.
    init.add_argument(
        "--json", action="store_true", help="machine-readable output (accepted, no-op)"
    )
    init.add_argument("--yes", "-y", action="store_true", help="accept all defaults, no prompts")
    # No `choices=`: the mode value is range-checked pre-dispatch so a bogus value
    # prints leji's own error to stderr and exits 2 (not argparse's usage).
    init.add_argument(
        "--mode",
        default=None,
        help="working mode: solo (team of one; seeds identity + writing-style starters) or team (default)",
    )
    # No `choices=`: the level value is range-checked pre-dispatch so a bogus value
    # prints leji's own error to stderr and exits 2 (not argparse's usage).
    init.add_argument("--level", help="conformance level to claim")
    init.add_argument("--name", help="layer name")
    init.add_argument(
        "--agent",
        help="Host to open in the layer after the command (claude-code or codex); interactive launch only, no files written.",
    )
    init.add_argument(
        "--no-agents",
        action="store_true",
        help="skip generating the portable AGENTS.md pointer (default: written when absent)",
    )
    init.add_argument(
        "--dry-run", action="store_true", help="compute the write plan without writing"
    )

    adopt = sub.add_parser("adopt", help="adopt Leji into an existing repository")
    adopt.add_argument("--dir", default=".", help="target directory")
    adopt.add_argument("--root", default=".", help="alias for --dir (parity with other commands)")
    # Accepted for cross-SDK parity (every command takes --json); a no-op here.
    adopt.add_argument(
        "--json", action="store_true", help="machine-readable output (accepted, no-op)"
    )
    adopt.add_argument("--yes", "-y", action="store_true", help="accept all defaults, no prompts")
    # No `choices=`: the mode value is range-checked pre-dispatch so a bogus value
    # prints leji's own error to stderr and exits 2 (not argparse's usage).
    adopt.add_argument(
        "--mode",
        default=None,
        help="working mode: solo (team of one; seeds identity + writing-style starters) or team (default)",
    )
    adopt.add_argument(
        "--agent",
        help="host to open in the layer after the command (claude-code or codex); interactive launch only, no files written",
    )
    adopt.add_argument(
        "--wire-adapters",
        action="store_true",
        help="convert present vendor entrypoints to redirects (content migrated first)",
    )
    adopt.add_argument(
        "--no-agents",
        action="store_true",
        help="skip generating the portable AGENTS.md pointer (default: written when absent)",
    )
    adopt.add_argument(
        "--dry-run", action="store_true", help="compute the write plan without writing"
    )

    # `leji viewer` generates only; `leji viewer serve` generates then serves.
    viewer = sub.add_parser(
        "viewer", help="generate the static viewer (Docsify index.html + _sidebar.md)"
    )
    common(viewer)
    viewer_sub = viewer.add_subparsers(dest="subcommand")
    viewer_serve = viewer_sub.add_parser(
        "serve", help="generate the viewer, then serve it on 127.0.0.1"
    )
    common(viewer_serve)
    viewer_serve.add_argument(
        "--open", action="store_true", help="open the served URL in the default browser"
    )
    viewer_serve.add_argument(
        "--port",
        type=int,
        default=None,
        help="port to serve on (overrides manifest viewer.port; default 5354; 0 picks a free port)",
    )
    # `leji viewer build` exports a self-contained static copy.
    viewer_build = viewer_sub.add_parser(
        "build", help="export a self-contained static viewer into an output directory"
    )
    common(viewer_build)
    viewer_build.add_argument(
        "--out",
        default=None,
        help="output directory for the export (default: .leji/viewer-dist inside the context root)",
    )

    # `leji view` is an alias for `leji viewer serve` that also opens the browser.
    view = sub.add_parser(
        "view", help="generate the viewer, serve it on 127.0.0.1, and open a browser"
    )
    common(view)
    view.add_argument(
        "--port",
        type=int,
        default=None,
        help="port to serve on (overrides manifest viewer.port; default 5354; 0 picks a free port)",
    )

    # `leji start`: boot a coding agent into an existing layer (the agent-facing
    # counterpart to `leji view`).
    start = sub.add_parser(
        "start", help="boot a coding agent into this layer, pointed at the boot profile"
    )
    common(start)
    start.add_argument(
        "--agent",
        default=None,
        help="force a launchable host (claude-code, codex); otherwise detect",
    )

    # `leji ci`: add the CI workflow to an existing layer (init refuses to re-run,
    # so `init --ci` after the fact does not work; this fills that gap).
    ci = sub.add_parser("ci", help="add the leji validate CI workflow to an existing layer")
    common(ci)
    # No `choices=`: the provider value is validated in the ci handler so a bogus
    # value prints leji's own error to stderr and exits 2 (not argparse's usage).
    # No default: an absent --provider is inferred from the origin remote.
    ci.add_argument(
        "--provider",
        default=None,
        help="CI provider to target: github (default when no remote is recognizable), gitlab, circleci, or azure.",
    )
    ci.add_argument(
        "--hooks",
        action="store_true",
        help=(
            "write a managed local pre-commit mirroring the CI gate; core.hooksPath is "
            "detected, so a husky repo gets a managed block in .husky/pre-commit"
        ),
    )

    # `leji agent`: bind a named agent into an existing layer.
    agent = sub.add_parser(
        "agent",
        help="bind a named agent into this layer (profile + manifest binding; no vendor file)",
    )
    common(agent)
    agent.add_argument("--host", default=None, help="the host the agent runs on")
    agent.add_argument("--name", default=None, help="the agent name (kebab id)")
    agent.add_argument("--role", default=None, help="the agent role (defaults to reviewer)")
    return parser


def _stdin_is_tty() -> bool:
    """Whether stdin is an interactive terminal (gates the handoff offer).
    False under piped/redirected stdin."""
    try:
        return sys.stdin.isatty()
    except (ValueError, OSError):
        return False


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]

    # Expand `--flag=value` for declared value flags first (tokens after a
    # literal -- stay untouched), mirroring the Node parseFlags entry.
    argv = _expand_equals_flags(argv)

    # Everything after a literal -- passes verbatim to the launched host. Split
    # before any flag scanning so pass-through tokens are never treated as our
    # flags. Only `start` declares `--` in cli.json, and the per-command flag check
    # below rejects it anywhere else: a swallowed `leji validate -- --bogus` exited
    # 0, so a typo'd flag reported success on a validation command.
    host_args: list[str] | None = None
    saw_separator = False
    if "--" in argv:
        sep = argv.index("--")
        host_args = argv[sep + 1 :]
        argv = argv[:sep]
        saw_separator = True

    # Meta-command handling from cli.json (byte-for-byte parity with Node/Go),
    # bypassing argparse's auto-usage. Order matters: a flag-level usage error
    # (an unknown option, or a value flag with no value) short-circuits before
    # help/version dispatch, which in turn short-circuits before running any
    # command (help/version must not write). This mirrors Node/Go, where the
    # same errors come out of the argv parser ahead of every other check, so
    # `leji route --zzz --help` is an error in all three rather than help.
    parse_error = _parse_error(argv)
    if parse_error is not None:
        print(f"leji: {parse_error}\n", file=sys.stderr)
        print(USAGE, file=sys.stderr)
        return 2

    meta = _meta_flag(argv)
    if meta == "help":
        positionals = _positionals(argv)
        hcmd = positionals[0] if positionals else None
        hsub = positionals[1] if len(positionals) > 1 else None
        hname = f"{hcmd} {hsub}" if hcmd in _TWO_WORD_COMMANDS and hsub else hcmd
        cmd_help = _build_command_help(hname) if hname else None
        print(cmd_help if cmd_help is not None else USAGE)
        return 0
    if meta == "version":
        print(SDK_VERSION)
        return 0
    command = _first_command(argv)
    if command is None or command == "help":
        # No command or explicit help word: usage to stdout. Exit 0 for the help
        # word, 2 for the no-arg case.
        print(USAGE)
        return 0 if command is not None else 2
    if command == "version":
        print(SDK_VERSION)
        return 0
    if command not in _KNOWN_COMMANDS:
        print(f'leji: unknown command "{command}"\n', file=sys.stderr)
        print(USAGE, file=sys.stderr)
        return 2

    # `leji viewer` generates; `viewer serve` serves; `view` aliases `viewer serve`.
    # Reject any other subcommand with a usage error (exit 2).
    positionals = _positionals(argv)
    sub = positionals[1] if len(positionals) > 1 else None
    if command == "viewer" and sub is not None and sub not in ("serve", "build"):
        print("leji: usage: leji viewer [serve|build]\n", file=sys.stderr)
        print(USAGE, file=sys.stderr)
        return 2
    if command == "view" and sub is not None:
        print("leji: usage: leji view\n", file=sys.stderr)
        print(USAGE, file=sys.stderr)
        return 2

    # Reject any flag not declared for this command in cli.json (globals allowed
    # everywhere). After the help/version short-circuit; unknown commands fall
    # through to argparse.
    allowed = _allowed_flags_for(command, sub)
    if allowed is not None:
        # `--` is split off above but is still a flag the command either declares
        # or does not; Node's and Go's scans record it last and stop there, so it
        # goes last here too.
        seen = _seen_flags(argv) + (["--"] if saw_separator else [])
        bad = next((t for t in seen if t not in allowed), None)
        if bad is not None:
            where = f"{command} {sub}" if command in _TWO_WORD_COMMANDS and sub else command
            print(f'leji: {bad} is not valid for "{where}"\n', file=sys.stderr)
            print(USAGE, file=sys.stderr)
            return 2

    # `leji mounts` requires one of the three subcommands; anything else is a
    # usage error before argparse (byte parity with the Node dispatch).
    if command == "mounts" and sub not in ("hydrate", "status", "locate"):
        print("leji: usage: leji mounts <hydrate|status|locate>\n", file=sys.stderr)
        print(USAGE, file=sys.stderr)
        return 2

    # Reject surplus positional arguments with the same message the other two
    # implementations use. argparse would reject them too, but in its own wording and
    # format, so the three CLIs disagreed on an error a typo produces every day.
    expected = 2 if command in _TWO_WORD_COMMANDS and sub else 1
    if command == "mounts" and sub == "locate":
        expected += 1
    # `view` has its own usage message for a stray subcommand, and it is the more
    # useful one; let that case fall through to it.
    if command != "view" and len(positionals) > expected:
        where = f"{command} {sub}" if command in _TWO_WORD_COMMANDS and sub else command
        print(
            f'leji: unexpected argument "{positionals[expected]}" for "{where}"\n',
            file=sys.stderr,
        )
        print(USAGE, file=sys.stderr)
        return 2

    parser = _build_parser()
    # --port, --keep, --mode, and --level are already checked in _parse_error,
    # mirroring where Node and Go check them.
    args = parser.parse_args(_reorder_for_argparse(argv))
    if not args.command:
        print(USAGE)
        return 2

    try:
        if args.command == "validate":
            validate_result = validate_layer(args.root, content=args.content)
            if not args.federation:
                return _emit("validate", validate_result.findings, args.json)
            if args.federation not in ("available", "required"):
                print("leji: --federation must be available or required\n", file=sys.stderr)
                print(USAGE, file=sys.stderr)
                return 2
            load = load_manifest(args.root)
            if load.manifest is None:
                return _emit("validate", validate_result.findings, args.json)
            task_mounts: set[str] | None = None
            if args.federation == "required":
                if not args.paths:
                    print(
                        "leji: --federation=required needs --paths <a,b,...> (the task scope)\n",
                        file=sys.stderr,
                    )
                    print(USAGE, file=sys.stderr)
                    return 2
                routed = route(
                    args.root,
                    load.manifest,
                    RouteInput(paths=[p.strip() for p in args.paths.split(",") if p.strip()]),
                )
                task_mounts = {m.name for m in routed.mounts}
            enforcement = [
                Finding(f.rule, f.severity, f.message, f.path)
                for f in federation_enforcement(
                    args.root, load.manifest, args.federation, task_mounts
                )
            ]
            return _emit(
                f"validate --federation={args.federation}",
                [*validate_result.findings, *enforcement],
                args.json,
            )

        if args.command == "index":
            load = load_manifest(args.root)
            if load.manifest is None:
                return _emit("index", load.findings, args.json)
            if args.check:
                check = check_index(args.root, load.manifest)
                return _emit(
                    "index --check",
                    [*load.findings, *check.findings],
                    args.json,
                    stale=check.stale if check.stale is not None else True,
                )
            index_result = write_index(args.root, load.manifest)
            # write_index refuses to write when generation hit a hard error; in that
            # case report nothing written and don't seed a changelog off a bad tree.
            wrote = not has_errors(index_result.findings)
            # Seed the changelog if the layer claims indexed+ and has none yet
            # (else only init --level indexed writes it). No-op at core/if present.
            seeded_changelog = (
                seed_changelog_if_missing(args.root, load.manifest) if wrote else None
            )
            # Key order matches Node's extras: written, then entries, then changelog.
            index_extra: dict[str, object] = {}
            if wrote:
                index_extra["written"] = effective_index_path(load.manifest)
            index_extra["entries"] = (
                len(index_result.index["entries"]) if wrote and index_result.index else 0
            )
            if seeded_changelog is not None:
                index_extra["changelog"] = seeded_changelog
            return _emit(
                "index",
                [*load.findings, *index_result.findings],
                args.json,
                **index_extra,
            )

        if args.command == "changelog":
            subcommand = getattr(args, "subcommand", None)
            if subcommand == "check":
                load = load_manifest(args.root)
                if load.manifest is None:
                    return _emit("changelog check", load.findings, args.json)
                rel = effective_changelog_path(load.manifest)
                changelog = check_changelog_append_only(args.root, rel, args.strict)
                return _emit(
                    "changelog check",
                    [*load.findings, *changelog.findings],
                    args.json,
                    verified=changelog.verified,
                )
            if subcommand == "compact":
                if args.keep is None and args.before is None:
                    print("leji: changelog compact requires --keep or --before\n", file=sys.stderr)
                    print(USAGE, file=sys.stderr)
                    return 2
                # Compaction removes entries. A merely digit-shaped date would select a
                # run for a destructive rewrite on a day that does not exist.
                if args.before is not None and not _is_calendar_date(args.before):
                    print(
                        f'leji: --before must be a calendar date (YYYY-MM-DD), got "{args.before}"',
                        file=sys.stderr,
                    )
                    return 2
                load = load_manifest(args.root)
                if load.manifest is None:
                    return _emit("changelog compact", load.findings, args.json)
                compact = compact_changelog(
                    args.root, load.manifest, keep=args.keep, before=args.before
                )
                note = (
                    "nothing to compact" if compact.folded == 0 and not compact.findings else None
                )
                extras: dict[str, object] = {
                    "changelog": compact.path,
                    "folded": compact.folded,
                    "kept": compact.kept,
                }
                if note is not None:
                    extras["note"] = note
                return _emit(
                    "changelog compact",
                    [*load.findings, *compact.findings],
                    args.json,
                    **extras,
                )
            print("leji: usage: leji changelog <check|compact>", file=sys.stderr)
            return 2

        if args.command == "freshness":
            load = load_manifest(args.root)
            if load.manifest is None:
                return _emit("freshness", load.findings, args.json)
            report = freshness_report(args.root, load.manifest, args.strict)
            if not args.json:
                for item in report.upcoming:
                    print(f"upcoming {item['path']}: review after {item['reviewAfter']}")
            return _emit(
                "freshness",
                [*load.findings, *report.findings],
                args.json,
                declared=report.declared,
                expired=report.expired if args.json else len(report.expired),
                upcoming=report.upcoming if args.json else len(report.upcoming),
            )

        if args.command == "status":
            load = load_manifest(args.root)
            if load.manifest is None:
                return _emit("status", load.findings, args.json)
            status_rep = status_report(args.root, load.manifest)
            flagged = (
                len(status_rep.unindexed)
                + len(status_rep.dangling)
                + len(status_rep.stale)
                + len(status_rep.pending)
            )
            exit_code = 1 if args.strict and flagged > 0 else 0
            if args.json:
                print(
                    json.dumps(
                        {
                            "command": "status",
                            "ok": exit_code == 0,
                            "strict": args.strict,
                            "unindexed": status_rep.unindexed,
                            "dangling": [
                                {"indexFile": d.index_file, "detail": d.detail}
                                for d in status_rep.dangling
                            ],
                            "stale": status_rep.stale,
                            "pending": status_rep.pending,
                            "shadowed": [
                                {"indexFile": s.index_file, "path": s.path}
                                for s in status_rep.shadowed
                            ],
                            "skippedReadmes": [
                                {"indexFile": s.index_file, "path": s.path}
                                for s in status_rep.skipped_readmes
                            ],
                            "projection": _projection_json(status_rep.projection),
                        },
                        indent=2,
                        ensure_ascii=False,
                    )
                )
                return exit_code
            print(
                f"Unindexed (present, in no category index; reference): {len(status_rep.unindexed)}"
            )
            for p in status_rep.unindexed:
                print(f"  {p}")
            print(f"Dangling index entries (listed but unresolved): {len(status_rep.dangling)}")
            for d in status_rep.dangling:
                print(f"  {d.index_file}: {d.detail}")
            print(
                "Stale index entries (in stored index, no longer resolved): "
                f"{len(status_rep.stale)}"
            )
            for p in status_rep.stale:
                print(f"  {p}")
            print(
                "Pending index entries (governed, not yet in the stored index; "
                f"run `leji index`): {len(status_rep.pending)}"
            )
            for p in status_rep.pending:
                print(f"  {p}")
            # Informational only: shadowed selectors never count toward strict.
            print(
                "Shadowed selectors (fully displaced by more-specific ones): "
                f"{len(status_rep.shadowed)}"
            )
            for s in status_rep.shadowed:
                print(f"  {s.index_file}: {s.path}")
            # Informational only: directory expansion skips READMEs by rule; this
            # surfaces each skip so governing one is a decision, not an accident.
            print(
                "READMEs skipped by directory expansion (govern with an explicit "
                f"entry, or leave as reference): {len(status_rep.skipped_readmes)}"
            )
            for s in status_rep.skipped_readmes:
                print(f"  {s.index_file}: {s.path}")
            # Report-only: judged against HEAD's object store, so it sees what a
            # host's hydrate would see, including untracked-but-bound files.
            proj = status_rep.projection
            if proj.state == "no-commit":
                print("Projection (as a mounted sibling, at HEAD): no commit to judge")
            elif proj.state == "ok":
                files_plural = "" if proj.files == 1 else "s"
                print(
                    f"Projection (as a mounted sibling, at {proj.commit[:12]}): closure "
                    f"enumerates completely ({proj.files} file{files_plural})"
                )
            else:
                print(
                    f"Projection (as a mounted sibling, at {proj.commit[:12]}): "
                    f"FAILS: {proj.detail}"
                )
            plural = "" if flagged == 1 else "s"
            strict_tail = ", strict" if args.strict else ""
            print(f"{'ok' if exit_code == 0 else 'flagged'} ({flagged} item{plural}{strict_tail})")
            return exit_code

        if args.command == "route":
            load = load_manifest(args.root)
            if load.manifest is None:
                return _emit("route", load.findings, args.json)
            # UTC date, matching the Node/Go default so expiry never diverges by zone.
            as_of = args.as_of or _dt.datetime.now(_dt.timezone.utc).date().isoformat()
            # Validate before routing. An unknown category or a non-date silently
            # produced a plausible, empty result: the caller cannot tell "nothing routes
            # here" from "you typed it wrong".
            if not _is_calendar_date(as_of):
                print(
                    f'leji: --as-of must be a calendar date (YYYY-MM-DD), got "{as_of}"',
                    file=sys.stderr,
                )
                return 2

            def split_list(s: object) -> list[str]:
                return [x.strip() for x in str(s).split(",") if x.strip()] if s else []

            requested_categories = split_list(args.categories)
            unknown = next((c for c in requested_categories if c not in CATEGORY_IDS), None)
            if unknown is not None:
                print(
                    f'leji: unknown category "{unknown}"; expected one of '
                    + ", ".join(CATEGORY_IDS),
                    file=sys.stderr,
                )
                return 2

            # Each --topics occurrence is one whole topic: never split, never
            # trimmed. A topic is a non-empty string of Unicode scalar values, so
            # an unpaired surrogate (which has no UTF-8 encoding) is rejected here
            # rather than routed as a value no manifest can match.
            requested_topics: list[str] = args.topics or []
            if any(len(t) == 0 for t in requested_topics):
                print(
                    "leji: --topics takes a non-empty topic; each occurrence is one whole topic",
                    file=sys.stderr,
                )
                return 2
            invalid_topic = next(
                (t for t in requested_topics if any(0xD800 <= ord(c) <= 0xDFFF for c in t)),
                None,
            )
            if invalid_topic is not None:
                print(
                    f"leji: invalid topic {_json_quote(invalid_topic)}; a topic is "
                    "Unicode scalar values (no unpaired surrogates)",
                    file=sys.stderr,
                )
                return 2
            result = route(
                args.root,
                load.manifest,
                RouteInput(
                    paths=split_list(args.paths),
                    categories=requested_categories,
                    topics=requested_topics,
                    as_of=as_of,
                ),
            )
            if args.json:
                print(
                    json.dumps(
                        {
                            "command": "route",
                            "ok": True,
                            "asOf": as_of,
                            "pathScoped": result.path_scoped,
                            "categories": result.categories,
                            "categorySignals": result.category_signals,
                            "documents": [
                                {
                                    "path": d.path,
                                    "category": d.category,
                                    "reviewAfter": d.review_after,
                                    "expired": d.expired,
                                }
                                for d in result.documents
                            ],
                            "records": [
                                {
                                    "path": r.path,
                                    "category": r.category,
                                    "date": r.date,
                                    "required": r.required,
                                }
                                for r in result.records
                            ],
                            "decisions": [
                                {
                                    "id": dec.id,
                                    "path": dec.path,
                                    "status": dec.status,
                                    "matchedBy": dec.matched_by,
                                    "reviewAfter": dec.review_after,
                                    "expired": dec.expired,
                                }
                                for dec in result.decisions
                            ],
                            "mounts": [{"name": m.name, "pin": m.pin} for m in result.mounts],
                        },
                        indent=2,
                        ensure_ascii=False,
                    )
                )
                return 0
            print(f"Task routing as of {as_of}")
            print(f"Categories: {', '.join(result.categories) if result.categories else '(none)'}")
            print(f"Documents ({len(result.documents)}):")
            for doc in result.documents:
                fr = ""
                if doc.review_after:
                    exp = ", EXPIRED" if doc.expired else ""
                    fr = f" (review after {doc.review_after}{exp})"
                print(f"   {doc.path} [{doc.category}]{fr}")
            print(f"Records ({len(result.records)}; dated candidates, never current intent):")
            for rec in result.records:
                dated = f"dated {rec.date}" if rec.date else "undated"
                required = ", required by task path" if rec.required else ""
                print(f"   {rec.path} [{rec.category}] ({dated}{required})")
            print(f"Decisions ({len(result.decisions)}):")
            for dec in result.decisions:
                print(f"   {dec.id} [{dec.status}] ({dec.matched_by})")
            print(f"Mounts ({len(result.mounts)}):")
            for m in result.mounts:
                print(f"   {m.name} @ {m.pin}")
            if not result.path_scoped:
                print("Note: no task paths given; path-scoped routing was not evaluated.")
            return 0

        if args.command == "conformance":
            if args.federation and args.federation != "verify":
                print("leji: --federation on conformance takes only verify\n", file=sys.stderr)
                print(USAGE, file=sys.stderr)
                return 2
            conformance = conformance_report(args.root, federation=args.federation == "verify")
            if not args.json:
                for check_item in conformance.items:
                    mark = {
                        "pass": "pass   ",
                        "fail": "FAIL   ",
                        "unknown": "unknown",
                        "not-applicable": "n/a    ",
                    }.get(check_item.status, "manual ")
                    detail = f" — {check_item.detail}" if check_item.detail else ""
                    print(f"{mark} [{check_item.level}] {check_item.description}{detail}")
                print()
                if args.explain:
                    print(render_explain(conformance) + "\n")
            extra: dict[str, object] = {
                "claimedLevel": conformance.claimed_level or "none",
                "verifiedLevel": conformance.verified_level or "none",
                "processAttested": conformance.process_attested,
            }
            if args.json:
                extra["items"] = [i.to_dict() for i in conformance.items]
            return _emit("conformance", conformance.findings, args.json, **extra)

        if args.command == "mounts":
            subcommand = getattr(args, "subcommand", None)
            load = load_manifest(args.root)
            if load.manifest is None:
                return _emit(f"mounts {subcommand}", load.findings, args.json)
            if subcommand == "hydrate":
                hydrate = hydrate_mounts(args.root, load.manifest, fetch=args.fetch)
                if hydrate.fatal is not None:
                    print(f"leji: {hydrate.fatal}", file=sys.stderr)
                    return 1
                issues = _mount_findings(hydrate.outcomes)
                had_error = any(o["status"] == "error" for o in hydrate.outcomes)
                if args.json:
                    print(
                        json.dumps(
                            {
                                "command": "mounts hydrate",
                                "ok": not had_error,
                                "outcomes": hydrate.outcomes,
                                "findings": [f.to_dict() for f in issues],
                            },
                            indent=2,
                            ensure_ascii=False,
                        )
                    )
                else:
                    for o in hydrate.outcomes:
                        detail = f": {o['detail']}" if o.get("detail") else ""
                        print(f"{str(o['status']).ljust(11)} {o['name']}{detail}")
                    _print_findings(issues)
                    n = sum(1 for o in hydrate.outcomes if o["status"] in ("hydrated", "cached"))
                    total = len(hydrate.outcomes)
                    plural = "" if total == 1 else "s"
                    print(
                        f"{'failed' if had_error else 'ok'} ({n}/{total} mount{plural} available)"
                    )
                # Best-effort: unavailability is availability, never failure,
                # whether no object store held the pin or the pinned layer would not
                # project. Errors (declaration, and the projection's safety guards)
                # are.
                return 1 if had_error else 0
            if subcommand == "locate":
                if not getattr(args, "name", None):
                    print("leji: usage: leji mounts locate <name>\n", file=sys.stderr)
                    return 2
                loc = locate_mount(args.root, load.manifest, args.name)
                if args.json:
                    print(
                        json.dumps(
                            {"command": "mounts locate", **loc}, indent=2, ensure_ascii=False
                        )
                    )
                else:
                    jbool = {True: "true", False: "false"}
                    print(f"name: {loc['name']}")
                    print(f"pin: {loc['pin'] if loc['pin'] is not None else '(undeclared)'}")
                    print(
                        f"present: {jbool[bool(loc['present'])]} · "
                        f"verified: {jbool[bool(loc['verified'])]}"
                    )
                    print(f"path: {loc['path'] if loc['path'] is not None else '(not hydrated)'}")
                    if loc.get("detail"):
                        print(f"note: {loc['detail']}")
                return 0 if loc["present"] else 1
            status_rows = mount_status(
                args.root, load.manifest, check_integrity=args.check_integrity
            )
            # No per-row findings here: `status` never fetches, so it has nothing of
            # its own to report.
            issues = _mount_findings([])
            if args.json:
                print(
                    json.dumps(
                        {
                            "command": "mounts status",
                            "mounts": status_rows,
                            "findings": [f.to_dict() for f in issues],
                        },
                        indent=2,
                        ensure_ascii=False,
                    )
                )
            else:
                for row in status_rows:
                    rep = cast("dict[str, object]", row["pinReport"])
                    if rep["state"] == "behind":
                        pin_line = f"behind {rep['behind']} (vs {rep['comparedRef']})"
                    elif rep["state"] == "diverged":
                        pin_line = (
                            f"diverged +{rep['ahead']}/-{rep['behind']} (vs {rep['comparedRef']})"
                        )
                    elif rep["state"] == "ahead":
                        pin_line = f"ahead {rep['ahead']} (vs {rep['comparedRef']})"
                    else:
                        pin_line = str(rep["state"])
                    ver = (
                        ""
                        if row["verified"] is None
                        else f" · verified: {'true' if row['verified'] else 'false'}"
                    )
                    present = "true" if row["present"] else "false"
                    print(
                        f"{row['name']} @ {str(row['pin'])[:12]} · present: {present}{ver}"
                        f" · pin: {pin_line}"
                    )
                    if rep.get("reason"):
                        reason = cast("str", rep["reason"])
                        print(f"   {_MOUNT_REASONS.get(reason, reason)}")
                if not status_rows:
                    print("no federation.mounts declared")
                _print_findings(issues)
            return 0

        if args.command == "viewer" and getattr(args, "subcommand", None) == "build":
            load = load_manifest(args.root)
            if load.manifest is None:
                return _emit("viewer build", load.findings, args.json)
            r = build_viewer(args.root, load.manifest, args.out)
            if any(f.severity == "error" for f in r.findings):
                return _emit("viewer build", r.findings, args.json)
            if args.json:
                print(
                    json.dumps(
                        {
                            "command": "viewer build",
                            "ok": True,
                            "out": r.out,
                            "warning": PROTECT_WARNING,
                        },
                        indent=2,
                        ensure_ascii=False,
                    )
                )
            else:
                print(f"Exported the static viewer to {r.out}/")
                print(f"\n{PROTECT_WARNING}")
            return 0

        if args.command in ("viewer", "view"):
            # `view` aliases `viewer serve` and also opens the browser.
            is_alias = args.command == "view"
            want_serve = is_alias or getattr(args, "subcommand", None) == "serve"
            want_open = getattr(args, "open", False) or is_alias
            load = load_manifest(args.root)
            if load.manifest is None:
                return _emit("viewer", load.findings, args.json)
            viewer_result = generate_viewer(args.root, load.manifest)
            # Terse by design: findings when something needs attention, one status
            # line otherwise. The full write list lives in --json.
            all_findings = [*load.findings, *viewer_result.findings]
            if args.json:
                code = _emit(
                    "viewer",
                    all_findings,
                    True,
                    written=", ".join(viewer_result.written),
                    entries=viewer_result.entries,
                )
            elif all_findings:
                code = _emit("viewer", all_findings, False)
            else:
                code = 0
            if not want_serve or code != 0:
                if not args.json and code == 0:
                    viewer_dir = f"{strip_slash(load.manifest['rootPath']) or '.'}/.leji/viewer/"
                    print(
                        f"viewer ready ({viewer_result.entries} entries) → {viewer_dir}"
                        "   serve: leji view"
                    )
                return code
            server = serve_viewer(
                args.root,
                resolve_viewer_port(load.manifest, args.port),
                load.manifest["rootPath"],
                log=None if args.json else lambda line: print(line, flush=True),
            )
            port = server.server_address[1]
            # Display localhost (nicer, still a secure context); server stays bound
            # to 127.0.0.1. Viewer is served at web root, so the URL is just `/`.
            url = f"http://localhost:{port}/"
            title = (load.manifest.get("viewer") or {}).get("title") or load.manifest["name"]
            print(f"{title} viewer → {url}   (Ctrl+C to stop)", flush=True)
            if want_open:
                open_browser(url)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                server.shutdown()
            return 0

        if args.command == "detect":
            detect_result = detect_layer(args.root)
            if args.json:
                print(
                    json.dumps(
                        {
                            "command": "detect",
                            "ok": True,
                            "hosts": [h.to_dict() for h in detect_result.hosts],
                        },
                        indent=2,
                        ensure_ascii=False,
                    )
                )
            else:
                print(render_detect(detect_result.hosts))
            return 0

        if args.command == "adopt":
            target = args.dir if args.dir != "." else args.root
            adopt_result = adopt_layer(
                target,
                yes=args.yes,
                dry_run=args.dry_run,
                wire_adapters=args.wire_adapters,
                no_agents=args.no_agents,
                agent=args.agent,
                mode=args.mode,
            )
            if adopt_result.dry_run:
                # A wire-only run scaffolds nothing, so "Adopting the existing
                # repository" misnames it: the layer is already there and the plan
                # beneath is entrypoint conversions.
                if adopt_result.wired_only:
                    print(
                        "\nWiring vendor entrypoints into the existing layer "
                        f"(context root: {adopt_result.detected_root})."
                    )
                else:
                    print(
                        f"\nAdopting the existing repository (context root: {adopt_result.detected_root})."
                    )
                print("\n" + render_write_plan(adopt_result.plan))
                print("\nNo files written (--dry-run). Re-run without --dry-run to apply.")
                return 0
            print(
                f"\nWrote {len(adopt_result.written)} files (context root: {adopt_result.detected_root}):"
            )
            for rel in adopt_result.written:
                print(f"   {rel}")
            index_failed = _report_scaffold_index(adopt_result.findings)
            interactive = not args.yes and _stdin_is_tty()
            # Register the MCP server before the handoff, so the launched agent picks it
            # up at startup; the launch is anchored at the layer root (cwd) too.
            mcp = offer_mcp_install(
                McpOfferOptions(
                    root=adopt_result.root,
                    detected=adopt_result.detected,
                    interactive=interactive,
                    agent=args.agent,
                )
            )
            offer_approval_guard(
                GuardOfferOptions(
                    root=adopt_result.root,
                    root_path=adopt_result.manifest["rootPath"],
                    detected=adopt_result.detected,
                    interactive=interactive,
                    agent=args.agent,
                )
            )
            if not handoff_offer(
                adopt_result.manifest,
                adopt_result.detected,
                interactive,
                agent=args.agent,
                cwd=adopt_result.root,
                mcp=mcp,
            ):
                print(entering_adopted(adopt_result))
            return index_failed

        if args.command == "init":
            target = args.dir if args.dir != "." else args.root
            init_result = init_layer(
                target,
                yes=args.yes,
                name=args.name,
                level=args.level,
                dry_run=args.dry_run,
                no_agents=args.no_agents,
                agent=args.agent,
                mode=args.mode,
            )
            if init_result.dry_run:
                print("\n" + render_write_plan(init_result.plan))
                print("\nNo files written (--dry-run). Re-run without --dry-run to create them.")
                return 0
            print(f"\nWrote {len(init_result.written)} files:")
            for rel in init_result.written:
                print(f"   {rel}")
            index_failed = _report_scaffold_index(init_result.findings)
            interactive = not args.yes and _stdin_is_tty()
            # Register the MCP server before the handoff, so the launched agent picks it
            # up at startup; the launch is anchored at the layer root (cwd) too.
            mcp = offer_mcp_install(
                McpOfferOptions(
                    root=init_result.root,
                    detected=init_result.detected,
                    interactive=interactive,
                    agent=args.agent,
                )
            )
            offer_approval_guard(
                GuardOfferOptions(
                    root=init_result.root,
                    root_path=init_result.manifest["rootPath"],
                    detected=init_result.detected,
                    interactive=interactive,
                    agent=args.agent,
                )
            )
            if not handoff_offer(
                init_result.manifest,
                init_result.detected,
                interactive,
                agent=args.agent,
                cwd=init_result.root,
                mcp=mcp,
            ):
                print(entering_the_layer(init_result.manifest, init_result.mode))
            return index_failed

        if args.command == "start":
            load = load_manifest(args.root)
            if load.manifest is None:
                return _emit("start", load.findings, args.json)
            detected = detect_hosts(args.root)
            # `start` doesn't document --yes, so it's never set; getattr keeps
            # parity with the Node `!flags.yes` default.
            interactive = not getattr(args, "yes", False) and _stdin_is_tty()
            outcome = enter_layer(
                StartOptions(
                    root=args.root,
                    manifest=load.manifest,
                    detected=detected,
                    agent=args.agent,
                    interactive=interactive,
                    host_args=host_args,
                )
            )
            if outcome == "boot-missing":
                print(
                    f"leji: boot profile {load.manifest['bootProfilePath']} "
                    "is missing or invalid; run leji validate",
                    file=sys.stderr,
                )
                return 1
            if outcome == "fallback":
                print(entering_via_boot(load.manifest, host_args))
            return 0

        if args.command == "ci":
            if args.hooks:
                load = load_manifest(args.root)
                if load.manifest is None:
                    return _emit("ci", load.findings, args.json)
                hook = ensure_local_hook(args.root)
                if args.json:
                    hook_out: dict[str, object] = {
                        "command": "ci",
                        "ok": True,
                        "hook": hook.path,
                        "action": hook.action,
                    }
                    if hook.action == "manual":
                        hook_out["reason"] = hook.reason
                        hook_out["snippet"] = hook.snippet
                    print(json.dumps(hook_out, indent=2, ensure_ascii=False))
                elif hook.action == "manual":
                    if hook.reason == "outside-root":
                        lead = (
                            f"{hook.path} resolves outside the repository "
                            "(core.hooksPath); add this yourself where your hooks run:"
                        )
                    else:
                        lead = (
                            f"{hook.path} was not modified (not leji-managed); add this yourself:"
                        )
                    print(f"{lead}\n\n{hook.snippet}")
                elif hook.managed == "block":
                    if hook.action == "unchanged":
                        lead = f"Hook block already current in {hook.path}"
                    elif hook.action == "created":
                        lead = f"Wrote leji hook block to {hook.path}"
                    else:
                        lead = f"Merged leji hook block into {hook.path}"
                    print(
                        f"{lead} (validate + index --check before every "
                        "commit; remove the leji block to opt out)."
                    )
                else:
                    verb = "Hook already current" if hook.action == "unchanged" else "Wrote"
                    print(
                        f"{verb} {hook.path} (validate + index --check before every "
                        "commit; per-clone, delete to opt out)."
                    )
                return 0
            # No --provider: infer from the origin remote (a GitLab repo must
            # never silently receive a GitHub workflow); say which and why.
            provider = args.provider
            if not provider:
                origin = git_origin_url(args.root)
                inferred = ci_provider_from_remote(origin)
                provider = inferred or "github"
                if not args.json:
                    print(
                        f"No --provider given; origin remote ({origin}) → {inferred}."
                        if inferred
                        else "No --provider given and no recognizable origin remote; "
                        "defaulting to github."
                    )
            if provider not in ("github", "gitlab", "circleci", "azure"):
                print(
                    f'leji: unknown provider "{provider}"; expected github, gitlab, circleci, or azure\n',
                    file=sys.stderr,
                )
                return 2
            load = load_manifest(args.root)
            if load.manifest is None:
                return _emit("ci", load.findings, args.json)
            ci_result = ensure_ci_workflow(args.root, provider)
            if args.json:
                out: dict[str, object] = {
                    "command": "ci",
                    "ok": True,
                    "provider": ci_result.provider,
                    "workflow": ci_result.path,
                    "action": ci_result.action,
                    "created": ci_result.action == "created",
                }
                if ci_result.action == "manual":
                    out["snippet"] = ci_result.snippet
                if ci_result.note:
                    out["note"] = ci_result.note
                print(json.dumps(out, indent=2, ensure_ascii=False))
            else:
                if ci_result.action == "created":
                    print(f"Wrote {ci_result.path}")
                elif ci_result.action == "updated":
                    print(f"Updated {ci_result.path}")
                elif ci_result.action == "unchanged":
                    print(f"{ci_result.path} already present; nothing to do.")
                else:  # manual
                    print(
                        f"{ci_result.path} already exists; not modifying it. "
                        f"Add this to your CircleCI config:\n\n{ci_result.snippet}"
                    )
                if ci_result.note:
                    print(ci_result.note)
            return 0

        if args.command == "agent":
            if not args.name:
                print("leji: agent requires --name\n", file=sys.stderr)
                print(USAGE, file=sys.stderr)
                return 2
            load = load_manifest(args.root)
            if load.manifest is None:
                return _emit("agent", load.findings, args.json)
            agent_result = add_agent(
                args.root, load.manifest, host=args.host, name=args.name, role=args.role
            )
            if args.json:
                print(
                    json.dumps(
                        {
                            "command": "agent",
                            "ok": True,
                            "name": agent_result.name,
                            "role": agent_result.role,
                            "host": agent_result.host_id,
                            "profile": agent_result.profile_path,
                            "created": {
                                "profile": agent_result.profile_created,
                                "manifest": agent_result.manifest_changed,
                            },
                        },
                        indent=2,
                        ensure_ascii=False,
                    )
                )
            else:
                lines = [
                    f"Wrote {agent_result.profile_path}"
                    if agent_result.profile_created
                    else f"{agent_result.profile_path} already present"
                ]
                role_host = (
                    f"role {agent_result.role}, host {agent_result.host_id}"
                    if agent_result.host_id
                    else f"role {agent_result.role}"
                )
                lines.append(
                    f'Bound agent "{agent_result.name}" ({role_host}) in leji.json'
                    if agent_result.manifest_changed
                    else f'agent "{agent_result.name}" already bound in leji.json; nothing to do.'
                )
                print("\n".join(lines))
            return 0

        print(f'leji: unknown command "{args.command}"\n', file=sys.stderr)
        print(USAGE, file=sys.stderr)
        return 2
    except Exception as e:
        # Catch-all mirrors the Node CLI: any command error exits 2 with a clean
        # `leji: <message>` rather than leaking a traceback.
        print(f"leji: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
