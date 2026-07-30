"""The ``leji-mounts`` block: the machine-checkable half of boot-profile.md req 9.

Mirrors packages/sdk/test/mountblock.test.ts. Grammar cases run against the parser
directly; the cross-check against the manifest (enumeration, identity, presence)
runs against the federated host example, which ships a conforming block. The
finding order these tests pin is part of the contract.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

from leji.conformance import conformance_report
from leji.manifest import load_manifest
from leji.mountblock import parse_mount_blocks
from leji.validate import mount_surfacing_findings, validate_layer

REPO_ROOT = Path(__file__).resolve().parents[3]
HOST_EXAMPLE = REPO_ROOT / "examples" / "multi-repo" / "core-context"
_BLOCK_RE = re.compile(r"```leji-mounts\n(?:[\s\S]*?\n)?```\n")

DECLARED = {
    "name": "acme-product-context",
    "source": "https://github.com/acme/product-context",
    "pin": "7d3f2a19c4e8b6a0d5f1c2e9b8a7f6d5c4b3a2e1",
    "owner": {"name": "Product team"},
    "categories": ["domain"],
    "topics": ["billing"],
}


def block(*lines: str) -> str:
    return "\n".join(["```leji-mounts", *lines, "```"])


def host_layer(tmp_path: Path) -> Path:
    """A copy of the federated host example (one declared mount, one entry)."""
    dest = tmp_path / "host"
    shutil.copytree(HOST_EXAMPLE, dest)
    return dest


def set_block(directory: Path, replacement: str) -> None:
    """Replace the example's shipped block (an empty string removes it)."""
    p = directory / "docs" / "boot-profile.md"
    text = p.read_text(encoding="utf-8")
    assert _BLOCK_RE.search(text), "the shipped example carries a leji-mounts block"
    p.write_text(
        _BLOCK_RE.sub("" if replacement == "" else f"{replacement}\n", text, count=1),
        encoding="utf-8",
    )


def set_mounts(directory: Path, mounts: list | None) -> None:
    p = directory / "leji.json"
    m = json.loads(p.read_text(encoding="utf-8"))
    if mounts is None:
        m.pop("federation", None)
    else:
        m["federation"] = {"mounts": mounts}
    p.write_text(json.dumps(m, indent=2) + "\n", encoding="utf-8")


def surfacing(directory: Path) -> list[tuple[str, str]]:
    """Surfacing findings in the check's own order (validate_layer sorts them)."""
    manifest = load_manifest(str(directory)).manifest
    assert manifest is not None
    return [(f.rule, f.message) for f in mount_surfacing_findings(str(directory), manifest)]


# --- grammar ---


def test_one_record_parses_fields_in_any_order() -> None:
    text = "\n".join(
        [
            "# Boot Profile",
            "",
            block(
                "- mount: acme-product-context",
                "  read-when: a task touches billing, pricing (including trials), "
                "or the `checkout` surface",
                "  carries: produktbeschreibung, Preise und Entscheidungen: 決済まわり",
                "  owner: Ada Okafor",
            ),
            "",
        ]
    )
    parsed = parse_mount_blocks(text)
    assert parsed.errors == []
    assert parsed.saw_block is True
    assert len(parsed.entries) == 1
    assert parsed.entries[0].mount == "acme-product-context"
    assert parsed.entries[0].owner == "Ada Okafor"
    assert parsed.entries[0].carries == "produktbeschreibung, Preise und Entscheidungen: 決済まわり"
    assert parsed.entries[0].read_when.endswith("`checkout` surface")


def test_several_records_across_two_blocks_concatenate_in_document_order() -> None:
    def entry(name: str) -> list[str]:
        return [
            f"- mount: {name}",
            f"  owner: {name} team",
            "  carries: its own slice",
            "  read-when: a task touches it",
        ]

    text = "\n".join(
        [
            block(*entry("alpha"), *entry("beta")),
            "",
            "Prose between the blocks, which the scan walks past.",
            "",
            block(*entry("gamma")),
        ]
    )
    parsed = parse_mount_blocks(text)
    assert parsed.errors == []
    assert [e.mount for e in parsed.entries] == ["alpha", "beta", "gamma"]


def test_blank_lines_and_comments_are_ignored_but_a_hash_in_a_value_is_kept() -> None:
    text = block(
        "# the siblings this layer reads",
        "",
        "- mount: alpha",
        "  owner: Alpha team",
        "  carries: the # channel conventions",
        "  read-when: a task touches them",
        "",
    )
    parsed = parse_mount_blocks(text)
    assert parsed.errors == []
    assert parsed.entries[0].carries == "the # channel conventions"


def test_misindented_unknown_duplicate_and_missing_fields_are_all_reported() -> None:
    text = block(
        "- mount: alpha",
        "   owner: Alpha team",
        "  role: extra",
        "  carries: a slice",
        "  carries: a second slice",
        "  read-when: a task touches it",
    )
    parsed = parse_mount_blocks(text)
    assert parsed.entries == []
    # Source-line order, not detection order: the missing-field error belongs to the
    # record's own line even though it is raised when the record closes.
    assert [e.message for e in parsed.errors] == [
        'mount "alpha" is missing the "owner" field',
        'a field line must be indented exactly two spaces, as "  <key>: <value>"',
        'mount "alpha" carries the unknown field "role"',
        'mount "alpha" declares the "carries" field twice',
    ]
    assert [e.line for e in parsed.errors] == [2, 3, 4, 6]


def test_empty_padded_and_control_carrying_values_are_rejected() -> None:
    text = block(
        "- mount: alpha",
        "  owner: ",
        "  carries:  padded on the left",
        "  read-when: split\rby a carriage return",
    )
    parsed = parse_mount_blocks(text)
    assert parsed.entries == []
    assert [e.message for e in parsed.errors] == [
        'mount "alpha" is missing the "owner" field',
        'mount "alpha" is missing the "carries" field',
        'mount "alpha" is missing the "read-when" field',
        'mount "alpha" field "owner" is unusable: the value is empty',
        'mount "alpha" field "carries" is unusable: the value has leading or trailing whitespace',
        'mount "alpha" field "read-when" is unusable: '
        "the value carries a control or line-separator character",
    ]
    assert [e.line for e in parsed.errors] == [2, 2, 2, 3, 4, 5]


def test_anything_after_the_tag_is_an_error_and_the_block_is_still_consumed() -> None:
    record = [
        "- mount: alpha",
        "  owner: Alpha team",
        "  carries: a slice",
        "  read-when: a task touches it",
    ]
    # Several trailing tokens are one finding naming the whole remainder: a fence the
    # pattern half-recognized would leave the body to degrade into prose.
    for info, named in ((" bogus", "bogus"), (" bogus extra", "bogus extra"), ("\tb\tx ", "b\tx")):
        parsed = parse_mount_blocks("\n".join(["```leji-mounts" + info, *record, "```"]))
        assert parsed.saw_block is True
        assert [e.message for e in parsed.errors] == [
            "the leji-mounts info string carries nothing after the tag, "
            f'but this fence declares "{named}"'
        ]
        assert parsed.errors[0].line == 1
        assert [e.mount for e in parsed.entries] == ["alpha"]
    # The tag boundary holds: a longer tag is a different grammar, not this one.
    other = parse_mount_blocks("\n".join(["```leji-mountsx", *record, "```"]))
    assert other.saw_block is False
    assert other.entries == []
    assert other.errors == []


def test_fence_whitespace_is_ascii_space_and_tab_only() -> None:
    record = [
        "- mount: alpha",
        "  owner: Alpha team",
        "  carries: a slice",
        "  read-when: a task touches it",
    ]
    # Tab-padded and indented fences are fences.
    parsed_tabs = parse_mount_blocks("\n".join(["\t```leji-mounts\t", *record, "  ```  "]))
    assert parsed_tabs.errors == []
    assert [e.mount for e in parsed_tabs.entries] == ["alpha"]
    # U+00A0 padding is not fence whitespace, so no block is seen at all. Python's
    # `strip` and `\s` would have called this a block; the port must not.
    parsed_nbsp = parse_mount_blocks("\n".join([" ```leji-mounts", *record, "```"]))
    assert parsed_nbsp.saw_block is False
    assert parsed_nbsp.entries == []


def test_unterminated_block_and_a_record_off_column_one() -> None:
    unterminated = "\n".join(["```leji-mounts", "- mount: alpha", "  owner: Alpha team"])
    assert any(
        "unterminated leji-mounts block" in e.message
        for e in parse_mount_blocks(unterminated).errors
    )
    indented = block("  - mount: alpha")
    assert [e.message for e in parse_mount_blocks(indented).errors] == [
        'a "- mount:" record must start at column 1, followed by one space'
    ]


# --- validate: the cross-check against the declaration ---


def test_the_shipped_federated_example_surfaces_its_mount_cleanly() -> None:
    assert surfacing(HOST_EXAMPLE) == []


def test_mounts_declared_with_no_block_is_one_finding(tmp_path: Path) -> None:
    directory = host_layer(tmp_path)
    set_block(directory, "")
    found = surfacing(directory)
    assert len(found) == 1
    assert found[0][0] == "mount-surfacing-block"
    assert "carries no leji-mounts block" in found[0][1]


def test_a_block_with_no_mounts_declared_is_one_finding(tmp_path: Path) -> None:
    directory = host_layer(tmp_path)
    set_mounts(directory, None)
    set_block(directory, block())
    assert surfacing(directory) == [
        (
            "mount-surfacing-block",
            "this layer declares no federation.mounts; remove the leji-mounts block",
        )
    ]
    # No mounts and no block is the clean case.
    set_block(directory, "")
    assert surfacing(directory) == []


def test_syntax_unknown_duplicate_missing_and_owner_findings_accumulate_in_order(
    tmp_path: Path,
) -> None:
    directory = host_layer(tmp_path)
    second = {**DECLARED, "name": "acme-billing-context", "owner": {"name": "Billing team"}}
    set_mounts(directory, [DECLARED, second])
    set_block(
        directory,
        block(
            "- mount: acme-product-context",
            "  owner: Someone Else",
            "  carries: product-side context",
            "  read-when: a task touches the product surface",
            "- mount: acme-product-context",
            "  owner: Product team",
            "  carries: the same sibling again",
            "  read-when: never",
            "- mount: acme-unknown-context",
            "  owner: Nobody",
            "  carries: a sibling this layer does not declare",
            "  read-when: never",
            "  role: an unknown field",
        ),
    )
    found = surfacing(directory)
    assert [rule for rule, _ in found] == [
        "mount-surfacing-syntax",
        "mount-surfacing-duplicate",
        "mount-surfacing-owner",
        "mount-surfacing-missing",
    ]
    # The unknown-mount entry carried the unknown field, so it never became an entry:
    # its syntax finding is the one reported, in document order, first.
    assert 'unknown field "role"' in found[0][1]
    assert "surfaced more than once" in found[1][1]
    assert (
        'surfaced with owner "Someone Else" but is declared with owner "Product team"'
        in (found[2][1])
    )
    assert 'declared mount "acme-billing-context" has no entry' in found[3][1]


def test_an_entry_for_an_undeclared_mount_is_surfacing_unknown(tmp_path: Path) -> None:
    directory = host_layer(tmp_path)
    set_block(
        directory,
        "\n".join(
            [
                block(
                    "- mount: acme-product-context",
                    "  owner: Product team",
                    "  carries: product-side context",
                    "  read-when: a task touches the product surface",
                ),
                "",
                block(
                    "- mount: acme-retired-context",
                    "  owner: Product team",
                    "  carries: a sibling that was unmounted",
                    "  read-when: never",
                ),
            ]
        ),
    )
    found = surfacing(directory)
    assert len(found) == 1
    assert found[0][0] == "mount-surfacing-unknown"
    assert 'entry names "acme-retired-context"' in found[0][1]


def test_an_unrepresentable_owner_name_is_reported_against_the_manifest(tmp_path: Path) -> None:
    directory = host_layer(tmp_path)
    set_mounts(directory, [{**DECLARED, "owner": {"name": "Product team\nsecond line"}}])
    manifest = load_manifest(str(directory)).manifest
    assert manifest is not None
    found = mount_surfacing_findings(str(directory), manifest)
    unrepresentable = [f for f in found if f.rule == "mount-owner-name-line"]
    assert len(unrepresentable) == 1
    assert unrepresentable[0].path == "leji.json"
    assert "owner name no leji-mounts entry could carry" in unrepresentable[0].message


def test_an_unrepresentable_mount_name_is_reported_against_the_manifest(tmp_path: Path) -> None:
    directory = host_layer(tmp_path)
    set_mounts(directory, [{**DECLARED, "name": " padded "}])
    manifest = load_manifest(str(directory)).manifest
    assert manifest is not None
    found = mount_surfacing_findings(str(directory), manifest)
    unrepresentable = [f for f in found if f.rule == "mount-name-line"]
    assert len(unrepresentable) == 1
    assert unrepresentable[0].path == "leji.json"
    assert "leading or trailing whitespace" in unrepresentable[0].message
    # The block still carries the old name, so the surfacing checks are unaffected:
    # that entry names an undeclared mount, and the declared one has no entry.
    assert [f.rule for f in found] == [
        "mount-surfacing-unknown",
        "mount-surfacing-missing",
        "mount-name-line",
    ]


def test_name_and_owner_both_unrepresentable_reports_name_first(tmp_path: Path) -> None:
    directory = host_layer(tmp_path)
    set_mounts(
        directory,
        [{**DECLARED, "name": " padded ", "owner": {"name": "Product team\nsecond line"}}],
    )
    manifest = load_manifest(str(directory)).manifest
    assert manifest is not None
    identity = [
        f for f in mount_surfacing_findings(str(directory), manifest) if f.rule.endswith("-line")
    ]
    assert [f.rule for f in identity] == ["mount-name-line", "mount-owner-name-line"]
    for f in identity:
        assert f.path == "leji.json"


def test_surfacing_findings_reach_validate_as_errors_on_the_boot_profile(tmp_path: Path) -> None:
    directory = host_layer(tmp_path)
    set_block(directory, "")
    errors = [
        f for f in validate_layer(str(directory)).findings if f.rule.startswith("mount-surfacing")
    ]
    assert len(errors) == 1
    assert errors[0].severity == "error"
    assert errors[0].path == "docs/boot-profile.md"


# --- conformance ---


def test_mount_discovery_passes_fails_and_is_not_applicable(tmp_path: Path) -> None:
    directory = host_layer(tmp_path)

    def item(d: Path):
        return next(i for i in conformance_report(str(d)).items if i.id == "mount-discovery")

    assert item(directory).status == "pass"

    set_block(directory, "")
    failed = item(directory)
    assert failed.status == "fail"
    assert failed.detail is not None and "carries no leji-mounts block" in failed.detail

    set_mounts(directory, None)
    na = item(directory)
    assert na.status == "not-applicable"
    assert na.detail == "no federation.mounts declared"
