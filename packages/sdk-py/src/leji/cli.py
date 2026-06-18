"""The leji CLI, behaviorally identical to the Node SDK's.

Exit codes: 0 clean (or warnings only), 1 findings, 2 usage/internal error.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import cast

from .changelog import compact_changelog
from .conformance import conformance_report, render_explain
from .detect import detect_layer, render_detect
from .docs_cmd import generate_docs, resolve_docs_port, serve_docs
from .findings import Finding, sort_findings, summarize
from .freshness import freshness_report
from .indexgen import check_index, write_index
from .init_cmd import adopt_layer, entering_adopted, entering_the_layer, init_layer
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
        "docs",
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
        "--reviewer",
        "--keep",
        "--before",
    }
)


def _first_command(argv: list[str]) -> str | None:
    """The first positional token (the command), skipping flags and the values
    they consume. Meta-flags (-h/--help/-V/--version) count as the command, as
    in the Node CLI. Returns None when no command is present."""
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in ("-h", "--help", "-V", "--version"):
            return arg
        if arg.startswith("-"):
            if arg in _VALUE_FLAGS:
                i += 1  # skip the flag's value
            i += 1
            continue
        return arg
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
        if arg in ("-V", "--version"):
            return "version"
        if arg in _VALUE_FLAGS:
            i += 2  # skip the flag and the value it consumes
            continue
        i += 1
    return ""


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
        help="Wire a vendor adapter redirect for a host (claude-code, codex, copilot, gemini, cursor, windsurf), or 'auto'/'none'.",
    )
    init.add_argument(
        "--reviewer",
        help="Designate a second host as the reviewer role (multi-agent workflow).",
    )
    init.add_argument(
        "--ci",
        action="store_true",
        help="write a GitHub Actions workflow that runs leji validate in CI",
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
        help="also wire a vendor adapter for a host that has no entrypoint yet (claude-code, codex, copilot, gemini, cursor, windsurf)",
    )
    adopt.add_argument(
        "--wire-adapters",
        action="store_true",
        help="convert present vendor entrypoints to redirects (content migrated first)",
    )
    adopt.add_argument(
        "--dry-run", action="store_true", help="compute the write plan without writing"
    )

    docs = sub.add_parser(
        "docs", help="generate the static docs viewer (Docsify index.html + _sidebar.md)"
    )
    common(docs)
    docs.add_argument(
        "--serve", action="store_true", help="serve the repository on 127.0.0.1 after generating"
    )
    docs.add_argument(
        "--port",
        type=int,
        default=None,
        help="port for --serve (overrides manifest docs.port; default 5354; 0 picks a free port)",
    )
    return parser


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

    parser = _build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        print(USAGE)
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
            return _emit(
                "index",
                [*load.findings, *index_result.findings],
                args.json,
                written=effective_index_path(load.manifest),
                entries=len(index_result.index["entries"]) if index_result.index else 0,
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

        if args.command == "docs":
            load = load_manifest(args.root)
            if load.manifest is None:
                return _emit("docs", load.findings, args.json)
            docs_result = generate_docs(args.root, load.manifest)
            code = _emit(
                "docs",
                [*load.findings, *docs_result.findings],
                args.json,
                written=", ".join(docs_result.written),
                entries=docs_result.entries,
            )
            if not args.serve or code != 0:
                if not args.json and code == 0:
                    print(
                        "serve locally: leji docs --serve   (or any static server at the repository root)"
                    )
                return code
            server = serve_docs(args.root, resolve_docs_port(load.manifest, args.port))
            port = server.server_address[1]
            print(
                f"serving http://127.0.0.1:{port}/{load.manifest['rootPath']}; Ctrl+C to stop",
                flush=True,
            )
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
                reviewer=args.reviewer,
                ci=args.ci,
            )
            if init_result.dry_run:
                print("\n" + render_write_plan(init_result.plan))
                print("\nNo files written (--dry-run). Re-run without --dry-run to create them.")
                return 0
            print(f"\nWrote {len(init_result.written)} files:")
            for rel in init_result.written:
                print(f"   {rel}")
            print(entering_the_layer(init_result.manifest))
            return 0

        print(f'leji: unknown command "{args.command}"\n', file=sys.stderr)
        print(USAGE, file=sys.stderr)
        return 2
    except (RuntimeError, OSError) as e:
        print(f"leji: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
