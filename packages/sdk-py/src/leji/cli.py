"""The leji CLI, behaviorally identical to the Node SDK's.

Exit codes: 0 clean (or warnings only), 1 findings, 2 usage/internal error.
"""

from __future__ import annotations

import argparse
import json
import sys

from .conformance import conformance_report
from .docs_cmd import generate_docs, resolve_docs_port, serve_docs
from .findings import Finding, sort_findings, summarize
from .freshness import freshness_report
from .indexgen import check_index, write_index
from .init_cmd import entering_the_layer, init_layer
from .manifest import load_manifest
from .schemas import SDK_VERSION, SUPPORTED_LINES
from .validate import check_changelog_append_only, validate_layer


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


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="leji",
        description=f"Reference SDK for the Leji specification (spec line {', '.join(SUPPORTED_LINES)}).",
    )
    parser.add_argument("-V", "--version", action="version", version=SDK_VERSION)
    sub = parser.add_subparsers(dest="command")

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--root", default=".", help="repository root to operate on")
        p.add_argument("--json", action="store_true", help="machine-readable output")

    common(
        sub.add_parser(
            "validate", help="validate the layer: manifest, artifacts, frontmatter, lint rules"
        )
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

    freshness = sub.add_parser("freshness", help="report freshness horizons")
    common(freshness)
    freshness.add_argument("--strict", action="store_true", help="expired horizons become errors")

    common(
        sub.add_parser("conformance", help="score the layer against its claimed conformance level")
    )

    init = sub.add_parser("init", help="bootstrap a new context layer from the templates")
    init.add_argument("--dir", default=".", help="target directory")
    init.add_argument("--root", default=".", help="alias for --dir (parity with other commands)")
    init.add_argument("--yes", "-y", action="store_true", help="accept all defaults, no prompts")
    init.add_argument("--level", choices=["core", "indexed"], help="conformance level to claim")
    init.add_argument("--name", help="layer name")

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
    # Pseudo-commands, mirroring the Node CLI.
    if argv[:1] == ["help"]:
        _build_parser().print_help()
        return 0
    if argv[:1] == ["version"]:
        print(SDK_VERSION)
        return 0
    parser = _build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 2

    try:
        if args.command == "validate":
            validate_result = validate_layer(args.root)
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
            machine = load.manifest.get("machine") or {}
            return _emit(
                "index",
                [*load.findings, *index_result.findings],
                args.json,
                written=machine.get("indexPath", ""),
                entries=len(index_result.index["entries"]) if index_result.index else 0,
            )

        if args.command == "changelog":
            if getattr(args, "subcommand", None) != "check":
                print("leji: usage: leji changelog check", file=sys.stderr)
                return 2
            load = load_manifest(args.root)
            if load.manifest is None:
                return _emit("changelog check", load.findings, args.json)
            rel = (load.manifest.get("machine") or {}).get("changelogPath")
            if not rel:
                load.findings.append(
                    Finding(
                        "changelog-required",
                        "error",
                        "no machine.changelogPath declared in leji.json",
                        "leji.json",
                    )
                )
                return _emit("changelog check", load.findings, args.json)
            changelog = check_changelog_append_only(args.root, rel, args.strict)
            return _emit(
                "changelog check",
                [*load.findings, *changelog.findings],
                args.json,
                verified=changelog.verified,
            )

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

        if args.command == "init":
            target = args.dir if args.dir != "." else args.root
            init_result = init_layer(target, yes=args.yes, name=args.name, level=args.level)
            print(f"\nWrote {len(init_result.written)} files:")
            for rel in init_result.written:
                print(f"   {rel}")
            print(entering_the_layer(init_result.manifest))
            return 0

        parser.print_help()
        return 2
    except (RuntimeError, OSError) as e:
        print(f"leji: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
