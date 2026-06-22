"""The leji CLI, behaviorally identical to the Node SDK's.

Exit codes: 0 clean (or warnings only), 1 findings, 2 usage/internal error.
"""

from __future__ import annotations

import argparse
import json
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
from .findings import Finding, sort_findings, summarize
from .freshness import freshness_report
from .indexgen import check_index, write_index
from .init_cmd import (
    StartOptions,
    add_agent,
    adopt_layer,
    ensure_ci_workflow,
    enter_layer,
    entering_adopted,
    entering_the_layer,
    entering_via_boot,
    handoff_offer,
    init_layer,
)
from .manifest import effective_changelog_path, effective_index_path, load_manifest
from .schemas import SDK_VERSION, SUPPORTED_LINES, load_cli_spec
from .validate import check_changelog_append_only, validate_layer
from .writeplan import render_write_plan


def _build_usage() -> str:
    """Terminal help, generated from cli.json so it cannot drift from the docs
    site. Mirrors buildUsage() in packages/sdk/src/index.ts byte-for-byte."""
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

    cmd_options: list[tuple[str, str, str]] = [
        (str(o["flags"]), str(o["summary"]), str(c["name"]))
        for c in commands
        for o in cast("list[dict[str, str]]", c["options"])
    ]
    opt_width = (
        max(
            *(len(o["flags"]) for o in global_options),
            *(len(flags) for flags, _, _ in cmd_options),
        )
        + 3
    )
    out.extend(["", "Options:"])
    for o in global_options:
        out.append(f"   {o['flags'].ljust(opt_width)}{o['summary']}")
    for flags, summary, scope in cmd_options:
        out.append(f"   {flags.ljust(opt_width)}{scope}: {summary}")

    out.extend(["", "Full reference: https://leji.org/cli/"])
    return "\n".join(out)


USAGE = _build_usage()


def _print_findings(findings: list[Finding]) -> None:
    for f in sort_findings(findings):
        where = f" {f.path}" if f.path else ""
        label = "error  " if f.severity == "error" else "warning"
        print(f"{label} {f.rule}{where}: {f.message}")


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
        "conformance",
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
        "--name",
        "--port",
        "--agent",
        "--host",
        "--role",
        "--out",
        "--keep",
        "--before",
        "--provider",
    }
)


def _first_command(argv: list[str]) -> str | None:
    """The first positional token (the command), skipping flags and the values
    they consume. Meta-flags (-h/--help/-v/--version) count as the command, as
    in the Node CLI. Returns None when no command is present."""
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
    """All positional tokens (command + subcommand), skipping flags and the
    values they consume. Mirrors how the Node CLI reads rest[0]/rest[1]."""
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


def _is_flag_token(v: str | None) -> bool:
    """A following token that is itself a flag (not a bare "-") cannot be a flag's
    value: `--root --json` is a missing value, not root="--json". Mirrors Node."""
    return v is not None and v != "-" and v.startswith("-")


def _missing_value_flag(argv: list[str]) -> str | None:
    """The first value flag whose value is absent (end of argv) or is itself a
    flag token, mirroring the Node parseFlags "<flag> requires a value" guard.
    Returns the flag, or None when every value flag has a value."""
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in _VALUE_FLAGS:
            nxt = argv[i + 1] if i + 1 < len(argv) else None
            if nxt is None or _is_flag_token(nxt):
                return arg
            i += 2
            continue
        i += 1
    return None


def _meta_flag(argv: list[str]) -> str:
    """Return 'help' or 'version' if a help/version meta-flag appears anywhere in
    argv (skipping the values consumed by value flags), else ''. Mirrors the
    Node/Go short-circuit so `leji <command> --help` shows usage instead of
    running the command: a help or version request must not have side effects."""
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in ("-h", "--help"):
            return "help"
        # Version: -v and --version. No -V, there is no --verbose flag to collide
        # with, so the GNU "-v means verbose" convention does not apply.
        if arg in ("-v", "--version"):
            return "version"
        if arg in _VALUE_FLAGS:
            i += 2  # skip the flag and the value it consumes
            continue
        i += 1
    return ""


# Commands that take a subcommand (a second positional word), e.g. `changelog
# check`, `viewer serve`. The bare form is valid only when cli.json documents it.
_TWO_WORD_COMMANDS = frozenset({"changelog", "viewer"})


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
            out.append(a)
            if a in _VALUE_FLAGS:
                i += 1  # skip the flag's value, not a flag itself
        i += 1
    return out


def _allowed_flags_for(command: str, sub: str | None) -> set[str] | None:
    """The flags valid for a command (globals plus its own declared options),
    driven by cli.json. Returns None for an unknown command (left to the
    dispatcher's default). Mirrors allowedFlagsFor in index.ts."""
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

    conformance = sub.add_parser(
        "conformance", help="score the layer against its claimed conformance level"
    )
    common(conformance)
    conformance.add_argument(
        "--explain",
        action="store_true",
        help="explain what it would take to reach the next conformance level",
    )

    common(sub.add_parser("detect", help="detect the coding-agent hosts available on this machine"))

    init = sub.add_parser("init", help="bootstrap a new context layer from the templates")
    init.add_argument("--dir", default=".", help="target directory")
    init.add_argument("--root", default=".", help="alias for --dir (parity with other commands)")
    # Accepted for cross-SDK parity (every command takes --json); a no-op here.
    init.add_argument(
        "--json", action="store_true", help="machine-readable output (accepted, no-op)"
    )
    init.add_argument("--yes", "-y", action="store_true", help="accept all defaults, no prompts")
    init.add_argument("--level", choices=["core", "indexed"], help="conformance level to claim")
    init.add_argument("--name", help="layer name")
    init.add_argument(
        "--agent",
        help="Host to open in the layer after the command (claude-code or codex); interactive launch only, no files written.",
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
    ci.add_argument(
        "--provider",
        default="github",
        help="CI provider to target: github (default), gitlab, circleci, or azure.",
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
    """Whether stdin is an interactive terminal, the gate for the post-scaffold
    handoff offer. Stays False under piped/redirected stdin (parity and CI)."""
    try:
        return sys.stdin.isatty()
    except (ValueError, OSError):
        return False


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]

    # Meta-command handling, rendered from cli.json so help/usage matches the
    # Node and Go SDKs byte-for-byte (parity), bypassing argparse's auto-usage.
    # The first non-value token is the command; --root/--dir/etc. consume a value.
    #
    # A help/version meta-flag anywhere in argv short-circuits before dispatch, so
    # `leji <command> --help` shows usage instead of running the command; a help
    # or version request must never write to the filesystem.
    # A value flag missing its value is a usage error, mirroring the Node
    # parseFlags guard; it short-circuits before help/version dispatch.
    missing = _missing_value_flag(argv)
    if missing is not None:
        print(f"leji: {missing} requires a value\n", file=sys.stderr)
        print(USAGE, file=sys.stderr)
        return 2

    meta = _meta_flag(argv)
    if meta == "help":
        print(USAGE)
        return 0
    if meta == "version":
        print(SDK_VERSION)
        return 0
    command = _first_command(argv)
    if command is None or command == "help":
        # no command, or an explicit help word: full usage to stdout. Exit 0 for
        # an explicit help word, else 2 (the no-arg case). Mirrors the Node CLI.
        print(USAGE)
        return 0 if command is not None else 2
    if command == "version":
        print(SDK_VERSION)
        return 0
    if command not in _KNOWN_COMMANDS:
        print(f'leji: unknown command "{command}"\n', file=sys.stderr)
        print(USAGE, file=sys.stderr)
        return 2

    # `leji viewer` generates only; `leji viewer serve` serves; `leji view` is an
    # alias for `leji viewer serve`. Reject any other subcommand with a usage
    # error (exit 2), mirroring the Node dispatcher before argparse runs.
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

    # Reject any flag not declared for this command in cli.json (globals are allowed
    # everywhere). Runs after the version/help short-circuit, so meta-commands still
    # ignore flags; unknown commands fall through to argparse. Mirrors index.ts.
    allowed = _allowed_flags_for(command, sub)
    if allowed is not None:
        bad = next((t for t in _seen_flags(argv) if t not in allowed), None)
        if bad is not None:
            where = f"{command} {sub}" if command in _TWO_WORD_COMMANDS and sub else command
            print(f'leji: {bad} is not valid for "{where}"\n', file=sys.stderr)
            print(USAGE, file=sys.stderr)
            return 2

    parser = _build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        print(USAGE)
        return 2

    # Range-check numeric flags pre-dispatch (argparse type=int accepts out-of-
    # range values), so an invalid --port/--keep exits 2 and writes nothing.
    if getattr(args, "port", None) is not None and not 0 <= args.port <= 65535:
        print("leji: --port must be 0-65535\n", file=sys.stderr)
        print(USAGE, file=sys.stderr)
        return 2
    if getattr(args, "keep", None) is not None and args.keep < 1:
        print("leji: --keep must be a positive integer\n", file=sys.stderr)
        print(USAGE, file=sys.stderr)
        return 2

    try:
        if args.command == "validate":
            validate_result = validate_layer(args.root, content=args.content)
            return _emit("validate", validate_result.findings, args.json)

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
            # Complete the indexed surface: if the layer claims indexed (or higher)
            # and has no changelog yet, seed it (otherwise only init --level indexed
            # writes it). No-op at core or when already present.
            seeded_changelog = seed_changelog_if_missing(args.root, load.manifest)
            index_extra: dict[str, object] = {
                "written": effective_index_path(load.manifest),
                "entries": len(index_result.index["entries"]) if index_result.index else 0,
            }
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

        if args.command == "conformance":
            conformance = conformance_report(args.root)
            if not args.json:
                for check_item in conformance.items:
                    mark = {"pass": "pass  ", "fail": "FAIL  "}.get(check_item.status, "manual")
                    detail = f" — {check_item.detail}" if check_item.detail else ""
                    print(f"{mark} [{check_item.level}] {check_item.description}{detail}")
                print()
                if args.explain:
                    print(render_explain(conformance) + "\n")
            extra: dict[str, object] = {
                "claimedLevel": conformance.claimed_level or "none",
                "verifiedLevel": conformance.verified_level or "none",
            }
            if args.json:
                extra["items"] = [i.to_dict() for i in conformance.items]
            return _emit("conformance", conformance.findings, args.json, **extra)

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
            # `leji view` is an alias for `leji viewer serve` that also opens the
            # browser. `leji viewer` generates only; `leji viewer serve` serves.
            is_alias = args.command == "view"
            want_serve = is_alias or getattr(args, "subcommand", None) == "serve"
            want_open = getattr(args, "open", False) or is_alias
            load = load_manifest(args.root)
            if load.manifest is None:
                return _emit("viewer", load.findings, args.json)
            viewer_result = generate_viewer(args.root, load.manifest)
            code = _emit(
                "viewer",
                [*load.findings, *viewer_result.findings],
                args.json,
                written=", ".join(viewer_result.written),
                entries=viewer_result.entries,
            )
            if not want_serve or code != 0:
                if not args.json and code == 0:
                    print(
                        "serve locally: leji view   (or any static server at the repository root)"
                    )
                return code
            server = serve_viewer(
                args.root, resolve_viewer_port(load.manifest, args.port), load.manifest["rootPath"]
            )
            port = server.server_address[1]
            # Display localhost (nicer, still a secure context); the server stays
            # bound to 127.0.0.1, which localhost resolves to on loopback. The viewer
            # is served at the web root, so the URL is just `/`.
            url = f"http://localhost:{port}/"
            print(f"serving {url}; Ctrl+C to stop", flush=True)
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
                agent=args.agent,
            )
            if adopt_result.dry_run:
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
            if not handoff_offer(
                adopt_result.manifest,
                adopt_result.detected,
                not args.yes and _stdin_is_tty(),
                agent=args.agent,
            ):
                print(entering_adopted(adopt_result))
            return 0

        if args.command == "init":
            target = args.dir if args.dir != "." else args.root
            init_result = init_layer(
                target,
                yes=args.yes,
                name=args.name,
                level=args.level,
                dry_run=args.dry_run,
                agent=args.agent,
            )
            if init_result.dry_run:
                print("\n" + render_write_plan(init_result.plan))
                print("\nNo files written (--dry-run). Re-run without --dry-run to create them.")
                return 0
            print(f"\nWrote {len(init_result.written)} files:")
            for rel in init_result.written:
                print(f"   {rel}")
            if not handoff_offer(
                init_result.manifest,
                init_result.detected,
                not args.yes and _stdin_is_tty(),
                agent=args.agent,
            ):
                print(entering_the_layer(init_result.manifest))
            return 0

        if args.command == "start":
            load = load_manifest(args.root)
            if load.manifest is None:
                return _emit("start", load.findings, args.json)
            detected = detect_hosts(args.root)
            # `start` does not document --yes (cli.json), so it is never set here;
            # getattr keeps parity with the Node `!flags.yes` default.
            interactive = not getattr(args, "yes", False) and _stdin_is_tty()
            outcome = enter_layer(
                StartOptions(
                    root=args.root,
                    manifest=load.manifest,
                    detected=detected,
                    agent=args.agent,
                    interactive=interactive,
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
                print(entering_via_boot(load.manifest))
            return 0

        if args.command == "ci":
            provider = args.provider or "github"
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
