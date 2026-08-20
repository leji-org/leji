"""Help rendering, the shared goldens, and the em-dash house rule.

Mirrors packages/sdk/test/help.test.ts.
"""

import json
from pathlib import Path

from leji.cli import (
    SDK_VERSION,
    _build_command_help,
    _build_usage,
    _exit_code_column,
    _help_row,
    _name_column,
    _option_column,
    _wrap,
    main,
)
from leji.conformance import ChecklistItem, ConformanceResult, render_explain
from leji.detect import DetectedHost, render_detect
from leji.ecosystem import EcosystemReport
from leji.schemas import load_cli_spec
from leji.writeplan import build_write_plan

REPO_ROOT = Path(__file__).resolve().parents[3]
GOLDENS = REPO_ROOT / "fixtures" / "help-goldens"
EXAMPLE = REPO_ROOT / "examples" / "monorepo"

#: U+2013 and U+2014: the house rule is that no line the CLI prints carries either.
DASHES = ("–", "—")


def golden(name: str) -> str:
    return (GOLDENS / name).read_text(encoding="utf-8")


def golden_name(command: str) -> str:
    return command.replace(" ", "-") + ".txt"


def has_dash(text: str) -> bool:
    return any(d in text for d in DASHES)


# --- cli.json integrity: the grouping four consumers read ---------------------


def test_cli_json_groups_are_well_formed() -> None:
    spec = load_cli_spec()
    ids = [g["id"] for g in spec["groups"]]
    assert len(set(ids)) == len(ids), "group ids are unique"
    for g in spec["groups"]:
        assert g["title"], f"{g['id']} has a title"
    names = {c["name"]: c for c in spec["commands"]}
    for c in spec["commands"]:
        assert c["group"] in ids, f"{c['name']} names a declared group"
        alias_of = c.get("aliasOf")
        if alias_of is None:
            continue
        assert alias_of in names, f"{c['name']} aliases an existing command"
        assert not names[alias_of].get("aliasOf"), f"{c['name']} aliases a primary"


# --- the wrapper --------------------------------------------------------------


def test_wrap_collapses_hangs_and_keeps_long_tokens_whole() -> None:
    assert _wrap("  one   two  ", 20, 0, 0) == ["one two"]
    assert _wrap("", 20, 0, 0) == []
    assert _wrap("alpha beta gamma delta", 16, 0, 3) == ["alpha beta gamma", "   delta"]
    # The continuation indent counts against the width, not only the first line.
    assert _wrap("alpha beta gamma delta", 16, 0, 8) == ["alpha beta gamma", "        delta"]
    # A token wider than the line takes a line of its own rather than being split: a
    # URL or a flag spelling stays copyable.
    assert _wrap("see https://leji.org/cli/#mounts-update-pin now", 20, 0, 3) == [
        "see",
        "   https://leji.org/cli/#mounts-update-pin",
        "   now",
    ]


def test_top_level_usage_goes_through_the_wrapper() -> None:
    # No current command is long enough to wrap this line, so the contract is pinned on a
    # vector instead: every emitted field passes the wrapper, never just the ones the data
    # happens to overflow today.
    usage = (
        "Usage: leji mounts update-pin <name> [--to <oid>] [--allow-non-fast-forward] "
        "[--fetch] [--dry-run] [--root <dir>] [--json]"
    )
    assert "\n".join(_wrap(usage, 80, 0, 7)) + "\n" == golden("wrap-long-usage.txt")
    assert "\nUsage: leji <command> [options]\n" in _build_usage()


def test_overlong_label_takes_its_own_line() -> None:
    label = "--allow-non-fast-forward-with-a-very-long-spelling <oid>"
    summary = (
        "Permit a target that is not a descendant of the current pin, in the one spelling "
        "long enough to outgrow its column."
    )
    assert "\n".join(_help_row(label, 23, summary)) + "\n" == golden("row-overlong-label.txt")
    # The clamp is what makes an overlong label reachable: past 27 characters the flag
    # outgrows its own column.
    assert _option_column([{"flags": label, "summary": ""}]) == 33
    # A label that exactly fills the column would leave no gap, so it takes the line too.
    assert _help_row("--exactly-here", 17, "summary") == [
        "   --exactly-here",
        "                 summary",
    ]


def test_row_pads_by_code_points() -> None:
    # Two U+1F600 in the label: padding by UTF-16 units leaves the row two columns short
    # and misaligns every summary in the block.
    label = "--emoji-\U0001f600\U0001f600 <value>"
    summary = (
        "A flag carrying astral characters, so a column padded in UTF-16 units misaligns "
        "this row by two."
    )
    assert "\n".join(_help_row(label, 23, summary)) + "\n" == golden("row-non-bmp.txt")


def test_every_label_class_resolves_a_bounded_column() -> None:
    opt = lambda *flags: _option_column([{"flags": f, "summary": ""} for f in flags])  # noqa: E731
    name = lambda *names: _name_column([{"name": n} for n in names])  # noqa: E731
    code = lambda *codes: _exit_code_column([{"code": c} for c in codes])  # noqa: E731
    assert opt("--json") == 23  # below the floor: [20, 30]
    assert opt("--a-flag-of-thirty-plus-characters <value>") == 33  # above the ceiling
    assert name("leji") == 15  # below the floor: [12, 30]
    assert name("a-command-name-long-enough-to-outgrow-its-bounded-column") == 33
    assert code("0") == 6  # below the floor: [3, 8]
    assert code("0", "127") == 8
    # Code points, not UTF-16 units: an astral label sizes its column by what it prints.
    assert opt("--emoji-\U0001f600\U0001f600 <value>") == 24


def test_bounds_hold_through_the_renderers() -> None:
    # Rendered, not just computed: a bound the column helper honors and the renderer
    # bypasses is exactly the defect this pins. The spec pushes every class past its
    # bound at once.
    spec = json.loads((GOLDENS / "bounds-spec.json").read_text(encoding="utf-8"))
    assert _build_usage(spec) + "\n" == golden("bounds-usage.txt").replace(
        "{{version}}", SDK_VERSION, 1
    )
    long_name = "a-command-name-long-enough-to-outgrow-its-bounded-column"
    assert _build_command_help(long_name, spec) + "\n" == golden("bounds-command.txt")


def test_wrap_measures_code_points() -> None:
    # Documented in fixtures/README.md: four U+1F600, two spaces, three ASCII words,
    # width 20, first line indented 0 and continuations 3.
    text = "\U0001f600\U0001f600\U0001f600\U0001f600  alphabet six666 tail"
    assert "\n".join(_wrap(text, 20, 0, 3)) + "\n" == golden("wrap-non-bmp.txt")


def test_help_row_hangs_under_its_column() -> None:
    assert _help_row("--x", 20, "one two") == ["   " + "--x".ljust(17) + "one two"]


# --- the goldens --------------------------------------------------------------


def test_help_goldens_match_the_committed_bytes() -> None:
    spec = load_cli_spec()
    assert _build_usage() + "\n" == golden("usage.txt").replace("{{version}}", SDK_VERSION, 1)
    expected = {
        "usage.txt",
        "wrap-non-bmp.txt",
        "wrap-long-usage.txt",
        "row-overlong-label.txt",
        "row-non-bmp.txt",
        "bounds-spec.json",
        "bounds-usage.txt",
        "bounds-command.txt",
    }
    for c in spec["commands"]:
        name = str(c["name"])
        assert _build_command_help(name) + "\n" == golden(golden_name(name)), name
        expected.add(golden_name(name))
    # And nothing committed is orphaned: every golden is one of the surfaces above.
    assert {p.name for p in GOLDENS.iterdir()} == expected


def test_command_help_lists_own_options_and_points_at_the_globals() -> None:
    spec = load_cli_spec()
    globals_ = [o["flags"] for o in spec["globalOptions"]]
    for c in spec["commands"]:
        name = str(c["name"])
        help_text = _build_command_help(name) or ""
        assert "\nGlobal options: see leji --help.\n" in help_text, name
        for g in globals_:
            assert f"   {g}" not in help_text, f"{name} does not repeat {g}"
        for o in c["options"]:
            assert f"   {o['flags']}" in help_text, f"{name} lists {o['flags']}"
        # Examples are commands to copy, never prose: they are printed as authored, so
        # the width contract covers everything above them.
        prose = help_text.split("\nExamples:\n")[0]
        assert all(len(line) <= 80 for line in prose.split("\n")), name
    assert all(len(line) <= 80 for line in _build_usage().split("\n"))


# --- the em-dash house rule, checked on the bytes the CLI prints --------------


def test_help_output_carries_no_dash() -> None:
    for path in GOLDENS.iterdir():
        assert not has_dash(path.read_text(encoding="utf-8")), path.name


def test_cli_json_carries_no_dash() -> None:
    raw = (Path(__file__).resolve().parents[1] / "src" / "leji" / "_assets" / "cli.json").read_text(
        encoding="utf-8"
    )
    assert not has_dash(raw)


def test_prose_branches_carry_no_dash(capsys) -> None:
    # detect's host lines: synthetic hosts, so the branch runs wherever the suite does.
    detect_text = render_detect(
        [
            DetectedHost(
                id="codex",
                name="Codex CLI",
                strength="confirmed",
                on_path=True,
                in_repo=True,
                user_config=False,
                adapter="AGENTS.md",
            )
        ],
        EcosystemReport(selected=None, all=[], reason="none"),
    )
    assert "Codex CLI: binary on PATH" in detect_text
    assert not has_dash(detect_text)

    # conformance --explain's blocker details, likewise: the detail branch needs a
    # blocker that carries one, which a passing layer does not produce.
    explain = render_explain(
        ConformanceResult(
            claimed_level="core",
            verified_level="core",
            items=[
                ChecklistItem(
                    id="index-current",
                    level="indexed",
                    description="a generated context index, current with the tree",
                    status="fail",
                    detail="the stored index is stale",
                )
            ],
        )
    )
    assert (
        "- a generated context index, current with the tree: the stored index is stale" in explain
    )
    assert not has_dash(explain)

    # The conformance checklist's own detail column, from a real run.
    main(["conformance", "--root", str(EXAMPLE)])
    checklist = capsys.readouterr().out
    assert "freshness horizons are declared and checked (report-only is acceptable): " in checklist
    assert not has_dash(checklist)

    # The write plan's read-only note is library data rather than a printed line, so it
    # is asserted where it is produced.
    plan = build_write_plan(str(EXAMPLE), [], ["README.md"])
    assert plan[0].note == "existing file, read-only input; Leji will not modify it"


def test_unknown_command_exits_2_with_usage_on_stderr(capsys) -> None:
    assert main(["frobnicate"]) == 2
    captured = capsys.readouterr()
    assert 'unknown command "frobnicate"' in captured.err
    assert "Usage: leji" in captured.err
