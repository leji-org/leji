"""The leji CLI, behaviorally identical to the Node SDK's.

Exit codes: 0 clean (or warnings only), 1 findings, 2 usage/internal error.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import sys
from typing import cast

from .badge import DEFAULT_BADGE_OUT, BadgeResult, badge_label, badge_run
from .changelog import compact_changelog, seed_changelog_if_missing
from .conformance import conformance_report, render_explain
from .detect import detect_hosts, detect_layer, render_detect
from .export_cmd import PROTECT_WARNING, BuildResult, build_viewer
from .serve_cmd import open_browser, serve_viewer
from .viewer_cmd import generate_viewer, resolve_viewer_port
from .findings import Finding, has_errors, sort_findings, summarize
from .freshness import freshness_report
from .indexgen import check_index, write_index
from .layout import DIST_REL, VIEWER_REL
from .gitutil import git_origin_url
from .dependency import dependency_add_failed, offer_dependency
from .ecosystem import (
    EcosystemReport,
    detect_ecosystem,
    render_ecosystem_block,
    render_ecosystem_line,
    runner_argv,
)
from .init_cmd import (
    StartOptions,
    _default_handoff_io,
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
    boot_profile_ready,
    resolve_start_host,
)
from .preflight import (
    check_document,
    color_decision,
    offer_preflight_fixes,
    render_preflight,
    run_preflight,
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
from .status import status_report, unindexed_paths
from .schemas import SDK_VERSION, SUPPORTED_LINES, load_cli_spec
from .update_pin import (
    MOUNT_UPDATE_PIN_REASONS,
    UpdatePinResult,
    short_oid,
    update_pin_run,
)
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


#: Terminal help wraps at a fixed width, never the actual terminal's: help bytes are a
#: shared contract across the three SDKs, so they may not depend on the environment.
HELP_WIDTH = 80

_PARAGRAPH_BREAK = re.compile(r"\n[ \t]*\n")


def _wrap(text: str, width: int, indent_first: int, indent_rest: int) -> list[str]:
    """The one line-wrapper behind every terminal help surface, so the three SDKs emit
    the same bytes: whitespace runs collapse to one space, the first line is indented by
    ``indent_first`` and every continuation by ``indent_rest``, and width is counted in
    code points. A token that cannot fit the remaining width takes a line of its own,
    unbroken (URLs and flag spellings stay copyable). Empty text yields no lines.
    Mirrors wrap() in lib/text.ts."""
    words = text.split()
    if not words:
        return []
    lines: list[str] = []
    indent = indent_first
    current = ""
    for word in words:
        room = width - indent - len(current)
        if current == "":
            current = word
        elif len(word) + 1 <= room:
            current += " " + word
        else:
            lines.append(" " * indent + current)
            indent = indent_rest
            current = word
    lines.append(" " * indent + current)
    return lines


def _help_row(label: str, col: int, text: str) -> list[str]:
    """One row of a two-column help block: a label on the left, its prose on the right,
    the prose hanging under itself at ``col``. A label that would leave no gap before its
    summary -- one at least as wide as the column, which the option column's clamp makes
    reachable -- takes the line alone and its summary starts on the next line at the same
    column, so a long flag never concatenates into the text describing it. Mirrors
    helpRow() in lib/text.ts."""
    lines = _wrap(text, HELP_WIDTH, col, col)
    if len(label) >= col - 3:
        head = f"   {label}"
        return [head] if not lines else [head, *lines]
    head = f"   {label.ljust(col - 3)}"
    if not lines:
        return [head.rstrip()]
    return [head + lines[0][col:], *lines[1:]]


def _bounded_column(labels: list[str], gap: int, low: int, high: int) -> int:
    """Where a two-column block's right column starts: the longest label plus a gap, kept
    inside a band so one long label cannot push every summary to the right edge, and
    measured in code points. Past the band's top the label outgrows the column and
    ``_help_row`` gives it its own line. Every dynamic label class in terminal help
    resolves its column here. Mirrors boundedColumn() in lib/text.ts."""
    longest = max((len(label) for label in labels), default=0)
    return 3 + min(high, max(low, longest + gap))


def _option_column(options: list[dict[str, str]]) -> int:
    """Option rows, top-level and per-command: flags plus 3, bounded to [20, 30]."""
    return _bounded_column([o["flags"] for o in options], 3, 20, 30)


def _name_column(commands: list[dict[str, object]]) -> int:
    """Command and alias rows: the name plus 3, bounded to [12, 30]."""
    return _bounded_column([str(c["name"]) for c in commands], 3, 12, 30)


def _exit_code_column(exit_codes: list[dict[str, object]]) -> int:
    """Exit-code rows: the code plus 2 (digits, not words), bounded to [3, 8]."""
    return _bounded_column([str(e["code"]) for e in exit_codes], 2, 3, 8)


def _build_usage(spec: dict[str, object] | None = None) -> str:
    """Top-level help, generated from cli.json so it can't drift from the docs: the
    commands by group, the global options, and the exit codes. Per-command options live
    in `leji <command> --help`. Byte-for-byte parity with renderUsage() in index.ts. A
    caller may pass a spec, so the bounds can be exercised against a synthetic one."""
    spec = load_cli_spec() if spec is None else spec
    commands = cast("list[dict[str, object]]", spec["commands"])
    groups = cast("list[dict[str, str]]", spec["groups"])
    global_options = cast("list[dict[str, str]]", spec["globalOptions"])
    exit_codes = cast("list[dict[str, object]]", spec["exitCodes"])
    # Every emitted field goes through the wrapper, including the ones no current value
    # is long enough to overflow: a longer version string or group title must not be what
    # discovers that a line was never wrapped.
    out: list[str] = [
        *_wrap(
            f"leji {SDK_VERSION}: reference CLI for the Leji specification "
            f"(spec line {', '.join(SUPPORTED_LINES)})",
            HELP_WIDTH,
            0,
            3,
        ),
        "",
        *_wrap(f"Usage: {spec['usage']}", HELP_WIDTH, 0, 7),
    ]

    # One name column across every group, so the summaries line up down the whole list
    # rather than jumping per section.
    cmd_col = _name_column(commands)
    for g in groups:
        out.extend(["", *_wrap(f"{g['title']}:", HELP_WIDTH, 0, 0)])
        for c in commands:
            if c["group"] != g["id"] or c.get("aliasOf"):
                continue
            out.extend(_help_row(str(c["name"]), cmd_col, str(c["summary"])))
            # An alias earns a line under its primary, not a row of its own: it is the
            # same command, and repeating the summary reads as a second one. It keeps
            # the name column, so the right-hand column stays straight down the list.
            for a in commands:
                if a.get("aliasOf") == c["name"]:
                    out.extend(_help_row(str(a["name"]), cmd_col, f"(alias of {c['name']})"))

    opt_col = _option_column(global_options)
    out.extend(["", "Options:"])
    for o in global_options:
        out.extend(_help_row(o["flags"], opt_col, o["summary"]))

    # The meaning hangs under itself, like every other two-column block here, so a
    # continuation line is never mistaken for another code.
    code_col = _exit_code_column(exit_codes)
    out.extend(["", "Exit codes:"])
    for e in exit_codes:
        out.extend(_help_row(str(e["code"]), code_col, str(e["meaning"])))

    out.extend(
        [
            "",
            "Run `leji <command> --help` for a command and its options.",
            "Full reference: https://leji.org/cli/",
        ]
    )
    return "\n".join(out)


def _build_command_help(name: str, spec: dict[str, object] | None = None) -> str | None:
    """Per-command help from cli.json: this command's own options only, with the globals
    one pointer away. Returns None for an undocumented command (caller falls back to
    top-level usage). Parity with renderCommandHelp() in index.ts. A caller may pass a
    spec, so the bounds can be exercised against a synthetic one."""
    spec = load_cli_spec() if spec is None else spec
    commands = cast("list[dict[str, object]]", spec["commands"])
    cmd = next((c for c in commands if c["name"] == name), None)
    if cmd is None:
        return None
    out: list[str] = [
        *_wrap(f"leji {cmd['name']}: {cmd['summary']}", HELP_WIDTH, 0, 3),
        "",
        *_wrap(f"Usage: {cmd['usage']}", HELP_WIDTH, 0, 7),
    ]
    for para in _PARAGRAPH_BREAK.split(str(cmd["description"])):
        out.extend(["", *_wrap(para, HELP_WIDTH, 0, 0)])
    details = cast("list[str]", cmd.get("details") or [])
    if details:
        out.extend(["", "Details:"])
        for d in details:
            out.extend(_wrap(f"- {d}", HELP_WIDTH, 3, 5))
    cmd_opts = cast("list[dict[str, str]]", cmd["options"])
    if cmd_opts:
        opt_col = _option_column(cmd_opts)
        out.extend(["", "Options:"])
        for o in cmd_opts:
            out.extend(_help_row(o["flags"], opt_col, o["summary"]))
    out.extend(["", "Global options: see leji --help."])
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


def _emit_scaffold(
    command: str,
    findings: list[Finding],
    written: list[str],
    ecosystem: "EcosystemReport",
    dry_run: bool,
) -> int:
    """The one ``--json`` document ``init`` and ``adopt`` emit: a single object, like
    every other command's, carrying what the run wrote and the repository's dependency
    ecosystem. ``--json`` is non-interactive by construction, so nothing here can have
    prompted or run a package manager; the report is what a consumer acts on."""
    ordered = sort_findings(findings)
    summary = summarize(ordered)
    ok = summary["errors"] == 0
    document: dict[str, object] = {
        "command": command,
        "ok": ok,
        "findings": [f.to_dict() for f in ordered],
        "summary": summary,
    }
    if dry_run:
        document["dryRun"] = True
    document["written"] = written
    document["ecosystem"] = ecosystem.to_json()
    print(json.dumps(document, indent=2, ensure_ascii=False))
    return 0 if ok else 1


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
        # A rule that locates a line says so, so a reader can go to it.
        where = f" {f.path}{'' if f.line is None else f':{f.line}'}" if f.path else ""
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


def _print_unindexed_nudge(count: int) -> None:
    """The `index` generate run's closing nudge. Byte-identical in all three SDKs
    and quiet at zero: a layer with nothing unindexed says nothing."""
    if count <= 0:
        return
    print(f"{count} file(s) unindexed: add to a category index or leave as reference deliberately")


def _run_export(args: argparse.Namespace) -> int:
    """The one export run, reached by both of its names: `leji export` (the front
    door) and `leji viewer build` (the viewer subsystem's name for the same
    operation, beside `viewer serve`). One code path, so the two are byte-identical
    by construction — same default output, same JSON document, same exits.

    Exits: 0 written (warnings allowed), 1 an error finding — or, under `--strict`, a
    lint finding — with the target left byte-untouched, 2 a usage error or a refusal
    (raised, and rendered by the caller's catch)."""
    load = load_manifest(args.root)
    out = getattr(args, "out", None)
    # A failure before the pipeline can run (an unreadable manifest) reports in the
    # command's OWN document, never the generic one: a `--json` consumer parses one
    # shape under every outcome and either name.
    if load.manifest is None:
        return _report_export(
            args, BuildResult(out=out if out is not None else DIST_REL, findings=load.findings)
        )
    return _report_export(args, build_viewer(args.root, load.manifest, out, strict=args.strict))


def _report_export(args: argparse.Namespace, r: BuildResult) -> int:
    """The one export report, for every outcome the pipeline can reach."""
    ordered = sort_findings(r.findings)
    if args.json:
        # The canonical JSON document for this command, under either name.
        print(
            json.dumps(
                {
                    "command": "export",
                    "ok": r.wrote,
                    "out": r.out,
                    "findings": [f.to_dict() for f in ordered],
                    "warning": PROTECT_WARNING,
                },
                indent=2,
                ensure_ascii=False,
            )
        )
        return 0 if r.wrote else 1
    if not r.wrote:
        summary = summarize(ordered)
        _print_findings(ordered)
        plural_e = "" if summary["errors"] == 1 else "s"
        plural_w = "" if summary["warnings"] == 1 else "s"
        strict_note = "; strict, nothing written" if args.strict else ""
        print(
            f"failed ({summary['errors']} error{plural_e}, "
            f"{summary['warnings']} warning{plural_w}{strict_note})"
        )
        return 1
    # Human mode says where the export went and repeats the protect-your-context
    # warning, which is the part a person must act on before hosting it.
    print(f"Exported the static viewer to {r.out}/")
    print(f"\n{PROTECT_WARNING}")
    return 0


def _report_update_pin(args: argparse.Namespace, r: UpdatePinResult) -> int:
    """Render one `mounts update-pin` run. The comparison is shown first, then what
    the run did with it, then the follow-up act this command deliberately does not
    perform. Every string is Leji-authored: git's stderr never reaches output."""
    # An internal refusal after validation carries no document at all: there is no
    # outcome to report, only the act this run would not perform.
    if r.write_error is not None:
        print(f"leji: {r.write_error}", file=sys.stderr)
        return 2
    findings = sort_findings(r.findings)
    summary = summarize(findings)
    ok = summary["errors"] == 0
    if args.json:
        payload: dict[str, object] = {
            "command": "mounts update-pin",
            "ok": ok,
            "findings": [f.to_dict() for f in findings],
            "summary": summary,
            "mount": r.mount,
            "pinReport": r.pin_report,
            "action": r.action,
            "override": r.override,
        }
        if r.reason is not None:
            payload["reason"] = r.reason
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0 if ok else 1
    rep = r.pin_report
    to_oid = r.mount["to"]
    from_oid = r.mount["from"]
    if (
        rep is not None
        and rep["state"] != "unknown"
        and to_oid is not None
        and from_oid is not None
    ):
        # Offline, the witness is the last one successfully observed — never a claim
        # that the source was looked at during this run.
        observed = (
            "" if args.fetch else " (last observed witness; run with --fetch to observe the source)"
        )
        print(
            f"{r.mount['name']} @ {short_oid(cast('str', from_oid))} → "
            f"{short_oid(cast('str', to_oid))} · pin: {rep['state']} "
            f"(behind {rep['behind']}, ahead {rep['ahead']}) · "
            f"via {rep['comparisonRepository']}{observed}"
        )
    overridden = " (non-fast-forward, overridden)" if r.override else ""
    from12 = "" if from_oid is None else short_oid(cast("str", from_oid))
    to12 = "" if to_oid is None else short_oid(cast("str", to_oid))
    if r.action == "updated":
        print(f"Updated leji.json: {r.mount['name']} pin {from12} → {to12}{overridden}")
        # Moving the pin is one act; materializing the new projection is another.
        print(f"Run leji mounts hydrate{'' if args.fetch else ' --fetch'} to hydrate the new pin.")
    elif r.action == "unchanged":
        print(f"Unchanged: {r.mount['name']} pin {from12} is already the target")
    elif r.action == "dry-run":
        print(
            f"Would update leji.json: {r.mount['name']} pin {from12} → {to12} (dry run){overridden}"
        )
    elif r.action == "refused":
        reason = r.reason or ""
        print(f"Refused: {MOUNT_UPDATE_PIN_REASONS.get(reason, reason)}")
    return 0 if ok else 1


def _report_badge(args: argparse.Namespace, r: BadgeResult) -> int:
    """The one `leji badge` report, for every outcome the command can reach. The JSON
    document is the shared `_emit()` shape plus the badge's own fields, emitted under
    success and refusal alike so a consumer parses one document; the human channel says
    what was written and hands over the markdown line to paste.

    Exits: `0` the badge is written or already current, `1` a conformance error finding or
    nothing machine-verified in this run, `2` a `--out` usage error (rendered by the
    caller, with no level reported) or a refusal to overwrite a file that is not a badge
    of this contract."""
    findings = sort_findings(r.findings)
    summary = summarize(findings)
    ok = summary["errors"] == 0
    code = 2 if r.refusal is not None else 0 if ok else 1
    if args.json:
        print(
            json.dumps(
                {
                    "command": "badge",
                    "ok": ok,
                    "findings": [f.to_dict() for f in findings],
                    "summary": summary,
                    "out": r.out,
                    "level": r.level,
                    "claimedLevel": r.claimed_level,
                    "verifiedLevel": r.verified_level,
                    "markdown": r.markdown,
                    "action": r.action,
                },
                indent=2,
                ensure_ascii=False,
            )
        )
        if r.refusal is not None:
            print(f"leji: {r.refusal}", file=sys.stderr)
        return code
    if r.refusal is not None:
        print(f"leji: {r.refusal}", file=sys.stderr)
        return 2
    if not ok:
        _print_findings(findings)
        print("Run leji conformance --explain.")
        return 1
    verb = (
        "Wrote" if r.action == "wrote" else "Overwrote" if r.action == "overwrote" else "Unchanged"
    )
    assert r.level is not None and r.markdown is not None  # every ok run carries both
    print(f"{verb} {r.out}: {badge_label(r.level)}")
    # The badge states what this run verified, so a claim it did not reach is said out
    # loud rather than quietly dropped.
    if r.claimed_level is not None and r.claimed_level != r.verified_level:
        print(
            f"Claimed {r.claimed_level}; this offline run verified {r.verified_level} "
            "(leji conformance --federation=verify checks the claim)."
        )
    print("\nAdd it to your README (paths are relative to the repository root):\n")
    print(r.markdown.rstrip())
    return 0


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
        "badge",
        "mounts",
        "detect",
        "init",
        "adopt",
        "export",
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
        "--to",
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

# Flags whose value must match a shape, checked in the same place and for the same
# reason. `--to` takes the schema's own pin shape: a full commit id, never an
# abbreviation and never a revision expression, so all three SDKs accept one
# spelling.
_PATTERN_FLAGS = {
    "--to": (
        re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$"),
        "--to must be a full 40- or 64-character lowercase hex commit id",
    ),
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


def effective_root(argv: list[str]) -> str | None:
    """The repository root this argv lands on, decided ONCE and used by everything that
    has to agree about it: the parse below, and the installed console script's hand-off
    to a repository's own pinned CLI, which must select the same repository the command
    would then operate on. Same scan as the parse (`--flag=value` expanded, every
    declared value flag consuming its own value, the literal `--` ending our flags), so
    `--root` is read from the same token stream rather than from a second reading of it.
    Last `--root` wins; the default is the current directory.

    None when the scan cannot tell: a value flag with no value, or one whose value is
    itself a flag, is the usage error the parse reports, and a root guessed out of a
    malformed command line is exactly the wrong thing to hand an invocation to.
    Mirrors effectiveRoot in packages/sdk/src/index.ts."""
    expanded = _expand_equals_flags(argv)
    root = "."
    i = 0
    while i < len(expanded):
        arg = expanded[i]
        if arg == "--":  # host pass-through: never our flags
            break
        if arg not in _VALUE_FLAGS:
            i += 1
            continue
        i += 1
        value = expanded[i] if i < len(expanded) else None
        if value is None or _is_flag_token(value):
            return None
        if arg == "--root":
            if value == "":  # `--root ""` is the usage error, not a root
                return None
            root = value
        i += 1
    return root


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
    in range, an enum flag whose value is not one of its words, or a shaped flag
    (`--to`) whose value does not match, gets that flag's
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
            pattern = _PATTERN_FLAGS.get(arg)
            if pattern is not None:
                shape, message = pattern
                if shape.match(cast("str", nxt)) is None:
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

    badge = sub.add_parser("badge", help="write the self-attested conformance badge")
    common(badge)
    badge.add_argument(
        "--out",
        default=None,
        help="where to write the badge (default: leji-badge.svg at the repository root)",
    )

    # `leji mounts <hydrate|status|locate|update-pin>`: the federation resolver commands.
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
    mounts_update_pin = mounts_sub.add_parser(
        "update-pin", help="move a declared mount's pin forward to a witnessed commit"
    )
    common(mounts_update_pin)
    # Optional at parse time; the missing-name usage error is issued in dispatch,
    # ahead of the manifest load, exactly where Node issues it.
    mounts_update_pin.add_argument("name", nargs="?", default=None)
    mounts_update_pin.add_argument(
        "--to",
        default=None,
        help="move to this exact commit instead of the witness tip",
    )
    mounts_update_pin.add_argument(
        "--allow-non-fast-forward",
        action="store_true",
        dest="allow_non_fast_forward",
        help="permit a target that is not a descendant of the current pin (needs --to)",
    )
    mounts_update_pin.add_argument(
        "--fetch",
        action="store_true",
        help="observe the declared source: retain the pin, refresh the witness, retain the target",
    )
    mounts_update_pin.add_argument(
        "--dry-run",
        action="store_true",
        help="show the comparison and what would change; write no manifest byte",
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

    # `leji export`: the front-door name for the static export. `leji viewer build`
    # below is the viewer subsystem's name for the same operation, so both parsers
    # declare the same options and both dispatch to _run_export.
    export = sub.add_parser(
        "export", help="export the context layer as a self-contained static site"
    )
    common(export)
    export.add_argument(
        "--out",
        default=None,
        help="output directory for the export (default: .leji/dist)",
    )
    export.add_argument(
        "--strict",
        action="store_true",
        help="fail the export on any lint finding and write nothing",
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
        help="output directory for the export (default: .leji/dist)",
    )
    viewer_build.add_argument(
        "--strict",
        action="store_true",
        help="fail the export on any lint finding and write nothing",
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

    # Reject surplus positional arguments with the same message the other two
    # implementations use. argparse would reject them too, but in its own wording and
    # format, so the three CLIs disagreed on an error a typo produces every day.
    # Ahead of the `mounts` sub-guard below, where Node and Go check it: a misspelled
    # subcommand carrying a stray positional reports the positional in all three.
    expected = 2 if command in _TWO_WORD_COMMANDS and sub else 1
    if command == "mounts" and sub in ("locate", "update-pin"):
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

    # `leji mounts` requires one of the four subcommands; anything else is a
    # usage error before argparse (byte parity with the Node dispatch).
    if command == "mounts" and sub not in ("hydrate", "status", "locate", "update-pin"):
        print("leji: usage: leji mounts <hydrate|status|locate|update-pin>\n", file=sys.stderr)
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
            code = _emit(
                "index",
                [*load.findings, *index_result.findings],
                args.json,
                **index_extra,
            )
            # A generate run ends by naming what the layer governs but does not
            # index. A nudge, never a gate: the exit code is _emit's alone, and
            # nothing is printed when the count is zero. Text output only; --json
            # carries one document and nothing after it.
            if not args.json:
                _print_unindexed_nudge(len(unindexed_paths(args.root, load.manifest)))
            return code

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
                    detail = f": {check_item.detail}" if check_item.detail else ""
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

        if args.command == "badge":
            badge_result = badge_run(
                args.root, args.out if args.out is not None else DEFAULT_BADGE_OUT
            )
            # A rejected `--out` is a usage error, in the CLI's usage-error form and
            # ahead of every level the command could have reported.
            if badge_result.usage_error is not None:
                print(f"leji: {badge_result.usage_error}\n", file=sys.stderr)
                print(USAGE, file=sys.stderr)
                return 2
            return _report_badge(args, badge_result)

        if args.command == "mounts":
            subcommand = getattr(args, "subcommand", None)
            # Argument shape is settled before anything on disk is read: a usage
            # error is never contingent on a manifest loading.
            if subcommand == "update-pin":
                if not getattr(args, "name", None):
                    print(
                        "leji: usage: leji mounts update-pin <name> [--to <oid>]\n",
                        file=sys.stderr,
                    )
                    print(USAGE, file=sys.stderr)
                    return 2
                if args.allow_non_fast_forward and args.to is None:
                    print(
                        "leji: --allow-non-fast-forward is valid only with an explicit "
                        "--to <oid>\n",
                        file=sys.stderr,
                    )
                    print(USAGE, file=sys.stderr)
                    return 2
            load = load_manifest(args.root)
            if load.manifest is None:
                return _emit(f"mounts {subcommand}", load.findings, args.json)
            if subcommand == "update-pin":
                return _report_update_pin(
                    args,
                    update_pin_run(
                        args.root,
                        load.manifest,
                        args.name,
                        to=args.to,
                        allow_non_fast_forward=args.allow_non_fast_forward,
                        fetch=args.fetch,
                        dry_run=args.dry_run,
                    ),
                )
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

        if args.command == "export" or (
            args.command == "viewer" and getattr(args, "subcommand", None) == "build"
        ):
            return _run_export(args)

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
                    viewer_dir = f"{VIEWER_REL}/"
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
                            "ecosystem": detect_result.ecosystem.to_json(),
                        },
                        indent=2,
                        ensure_ascii=False,
                    )
                )
            else:
                print(render_detect(detect_result.hosts, detect_result.ecosystem))
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
            # The repository's own dependency ecosystem, read once and reported by
            # every output mode: the human block, the JSON document, and the offer.
            adopt_eco = detect_ecosystem(adopt_result.root)
            if adopt_result.dry_run:
                if args.json:
                    return _emit_scaffold("adopt", adopt_result.findings, [], adopt_eco, True)
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
                print("\n" + render_ecosystem_block(adopt_eco))
                return 0
            if args.json:
                return _emit_scaffold(
                    "adopt", adopt_result.findings, adopt_result.written, adopt_eco, False
                )
            print(
                f"\nWrote {len(adopt_result.written)} files (context root: {adopt_result.detected_root}):"
            )
            for rel in adopt_result.written:
                print(f"   {rel}")
            index_failed = _report_scaffold_index(adopt_result.findings)
            # --json is a single-document mode, so it is never interactive: nothing
            # prompts, and no package manager can run under it.
            interactive = not args.yes and not args.json and _stdin_is_tty()
            # A wire-only run scaffolds no layer, so it makes no declaration offer.
            dependency_failed = False
            if not adopt_result.wired_only:
                offer = offer_dependency(adopt_result.root, adopt_eco, interactive)
                dependency_failed = dependency_add_failed(offer)
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
            # The layer is written either way; a consented add that failed means the
            # durable setup this run promised was not reached, and the exit says so.
            return 1 if (index_failed or dependency_failed) else 0

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
            init_eco = detect_ecosystem(init_result.root)
            if init_result.dry_run:
                if args.json:
                    return _emit_scaffold("init", init_result.findings, [], init_eco, True)
                print("\n" + render_write_plan(init_result.plan))
                print("\nNo files written (--dry-run). Re-run without --dry-run to create them.")
                print("\n" + render_ecosystem_block(init_eco))
                return 0
            if args.json:
                return _emit_scaffold(
                    "init", init_result.findings, init_result.written, init_eco, False
                )
            print(f"\nWrote {len(init_result.written)} files:")
            for rel in init_result.written:
                print(f"   {rel}")
            index_failed = _report_scaffold_index(init_result.findings)
            interactive = not args.yes and not args.json and _stdin_is_tty()
            offer = offer_dependency(init_result.root, init_eco, interactive)
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
            return 1 if (index_failed or dependency_add_failed(offer)) else 0

        if args.command == "start":
            load = load_manifest(args.root)
            if load.manifest is None:
                return _emit("start", load.findings, args.json)
            detected = detect_hosts(args.root)
            # The repository's own ecosystem, read once: the preflight probes the
            # runner it names, and the JSON document reports it.
            start_eco = detect_ecosystem(args.root)
            # --json is a single-document mode, so it is never interactive: nothing
            # prompts, nothing launches, and no repair can run under it. `start`
            # doesn't document --yes, so it's never set; getattr keeps parity with
            # the Node `!flags.yes` default.
            interactive = not getattr(args, "yes", False) and not args.json and _stdin_is_tty()
            # The boot profile is checked first, before any report or prompt: a layer
            # whose entrypoint is missing has nothing to enter.
            if not boot_profile_ready(args.root, load.manifest):
                if args.json:
                    print(
                        json.dumps(
                            {
                                "command": "start",
                                "ok": False,
                                "ready": False,
                                "error": "boot-missing",
                                "checks": [],
                                "ecosystem": start_eco.to_json(),
                            },
                            indent=2,
                        )
                    )
                else:
                    print(
                        f"leji: boot profile {load.manifest['bootProfilePath']} "
                        "is missing or invalid; run leji validate",
                        file=sys.stderr,
                    )
                return 1
            start_io = _default_handoff_io()
            # The host is resolved BEFORE the report, so the MCP rows answer for the
            # host this run actually targets. An --agent naming no launchable host
            # raises here, exactly as it did inside enter_layer: a usage error.
            start_host = resolve_start_host(detected, args.agent, interactive, start_io)
            preflight = run_preflight(
                args.root, load.manifest, start_host, detected, start_eco, start_io
            )
            if args.json:
                # Report only: the launch-selection arguments are accepted and have no
                # effect, and a gap is reported rather than blocking (`ready` is the
                # scriptable signal).
                print(
                    json.dumps(
                        {
                            "command": "start",
                            "ok": True,
                            "ready": preflight.ready,
                            # Projected, never the raw checks: the document publishes
                            # four keys, and a field the renderer needs is not one.
                            "checks": [check_document(c) for c in preflight.checks],
                            "ecosystem": start_eco.to_json(),
                        },
                        indent=2,
                    )
                )
                return 0
            # The one place color is decided: a terminal question, asked at the
            # boundary and injected, so the block itself never consults the process.
            color = color_decision(sys.stdout.isatty(), os.environ)
            print("\n" + render_preflight(preflight.checks, color))
            offer_preflight_fixes(
                args.root,
                start_host,
                preflight,
                runner_argv(start_eco),
                interactive,
                start_io,
            )
            outcome = enter_layer(
                StartOptions(
                    root=args.root,
                    manifest=load.manifest,
                    detected=detected,
                    agent=args.agent,
                    interactive=interactive,
                    host_args=host_args,
                    io=start_io,
                    host=start_host,
                    host_resolved=True,
                )
            )
            if outcome == "fallback":
                print(entering_via_boot(load.manifest, host_args))
            return 0

        if args.command == "ci":
            # One detection for the whole command: the hook and the CI job both run
            # what a clean install of this repository provides.
            ci_eco = detect_ecosystem(args.root)
            if args.hooks:
                load = load_manifest(args.root)
                if load.manifest is None:
                    return _emit("ci", load.findings, args.json)
                hook = ensure_local_hook(args.root, runner_argv(ci_eco))
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
                    hook_out["ecosystem"] = ci_eco.to_json()
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
                if not args.json:
                    print(render_ecosystem_line(ci_eco))
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
            ci_result = ensure_ci_workflow(args.root, provider, ci_eco)
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
                out["ecosystem"] = ci_eco.to_json()
                print(json.dumps(out, indent=2, ensure_ascii=False))
            else:
                if ci_result.action == "created":
                    print(f"Wrote {ci_result.path}")
                elif ci_result.action == "updated":
                    print(f"Updated {ci_result.path}")
                elif ci_result.action == "unchanged":
                    print(f"{ci_result.path} already present; nothing to do.")
                else:  # manual
                    # Not leji's file: it was written by hand, or a generated one was
                    # edited. Either way the edit is the opt-out, and it is honored.
                    print(
                        f"{ci_result.path} already exists and was not generated by leji; "
                        f"not modifying it. Add this yourself:\n\n{ci_result.snippet}"
                    )
                if ci_result.note:
                    print(ci_result.note)
                print(render_ecosystem_line(ci_eco))
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
                agent_out: dict[str, object] = {
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
                }
                if agent_result.note:
                    agent_out["note"] = agent_result.note
                print(json.dumps(agent_out, indent=2, ensure_ascii=False))
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
                if agent_result.note:
                    lines.append(agent_result.note)
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


def _self_entry() -> str | None:
    """This console script, with every symlink resolved: the one path the hand-off must
    never select, or a repository whose install points back here would run us forever.
    An entry that cannot be resolved refuses the hand-off rather than risking that."""
    script = sys.argv[0] if sys.argv else ""
    if script == "":
        return None
    try:
        return os.path.realpath(script)
    except OSError:
        return None


def entry() -> int:
    """The INSTALLED console script (`leji`), which is the only place the hand-off
    lives. Before anything is parsed: inside a repository that declares the Leji CLI and
    has it installed, this invocation belongs to that pinned copy rather than to
    whichever global the PATH found. `main()` is a library call and never hands work to
    another program. Mirrors packages/sdk/src/cli.ts."""
    # Imported here, not at module scope: the wrapper imports this module for the
    # shared root scan, and a library user of `main` never loads the launcher at all.
    from .localcli import launch_local_cli, resolve_local_cli

    argv = sys.argv[1:]
    local = resolve_local_cli(argv, os.environ, sys.platform, _self_entry())
    if local is not None:
        launch_local_cli(local)
    return main(argv)


if __name__ == "__main__":
    sys.exit(entry())
