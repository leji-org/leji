"""Frontmatter edge cases mirroring packages/sdk/test/frontmatter.test.ts."""

import pytest

from leji.frontmatter import _FENCE, parse_frontmatter
from leji.layer import ScannedProfile, resolve_agent_profile
from leji.schemas import schema_errors


def test_document_without_frontmatter_passes_through() -> None:
    fm = parse_frontmatter("# Title\n\nBody.\n")
    assert fm.data is None
    assert fm.error is None


def test_unterminated_block_is_error() -> None:
    fm = parse_frontmatter("---\nid: x\n# never closed\n")
    assert "unterminated" in (fm.error or "")


def test_non_mapping_frontmatter_is_error() -> None:
    fm = parse_frontmatter("---\n- just\n- a list\n---\n\nBody.\n")
    assert fm.data is None
    assert "not a YAML mapping" in (fm.error or "")


def test_invalid_yaml_is_error_body_recovered() -> None:
    fm = parse_frontmatter("---\nid: [unclosed\n---\n\nBody.\n")
    assert fm.data is None
    assert "invalid YAML" in (fm.error or "")
    assert "Body" in fm.body


# --- CRLF line endings ---
# A Windows contributor or core.autocrlf=true authors every line with \r\n, and the
# block's last line must keep its whole terminator. Python already read these files
# correctly; these tests pin that, so the three SDKs cannot drift apart again.


def crlf(*lines: str) -> str:
    """Join lines with CRLF terminators, the way a Windows editor writes a file."""
    return "".join(f"{line}\r\n" for line in lines)


def scanned(rel_path: str, text: str) -> ScannedProfile:
    """The scan result a profile's bytes produce, as _scan_frontmatter_artifact builds it."""
    fm = parse_frontmatter(text)
    return ScannedProfile(rel_path=rel_path, frontmatter=fm.data, body=fm.body, findings=[])


def test_crlf_last_field_keeps_no_trailing_carriage_return() -> None:
    fm = parse_frontmatter(crlf("---", "id: reviewer", "role: reviewer", "---", "", "Body."))
    assert fm.error is None
    assert fm.data is not None and fm.data["role"] == "reviewer"
    assert fm.body == "\r\nBody.\r\n"


def test_crlf_inherits_last_key_passes_schema_and_resolves() -> None:
    base = scanned(
        "docs/agents/core.md",
        crlf(
            "---",
            "id: core",
            "name: Core",
            "role: core",
            "requiredRead:",
            "  - docs/boot-profile.md",
            "mustAskWhen:",
            "  - always",
            "---",
            "",
            "# Core",
        ),
    )
    derived = scanned(
        "docs/agents/reviewer.md",
        crlf(
            "---",
            "id: reviewer",
            "name: Reviewer",
            "role: reviewer",
            "inherits: core",
            "---",
            "",
            "# Reviewer",
        ),
    )
    assert schema_errors("agent-profile", derived.frontmatter) == []
    resolved = resolve_agent_profile(derived, [base, derived])
    assert resolved.findings == []
    assert resolved.source_ids == ["core", "reviewer"]


def test_crlf_blank_line_before_closing_fence_parses() -> None:
    fm = parse_frontmatter(crlf("---", "id: reviewer", "role: reviewer", "", "---", "", "Body."))
    assert fm.error is None
    assert fm.data is not None and fm.data["role"] == "reviewer"


def test_crlf_decision_record_reports_schema_defect_not_yaml_error() -> None:
    fm = parse_frontmatter(
        crlf(
            "---",
            "id: crlf-record",
            "title: CRLF record",
            "date: 2026-07-28",
            "status: maybe",
            "",
            "---",
            "",
            "Body.",
        )
    )
    assert fm.error is None
    errors = schema_errors("decision-record", fm.data)
    assert len(errors) == 1
    assert errors[0].startswith("/status ")


@pytest.mark.parametrize(
    ("block", "want"),
    [("\r\nrole: reviewer\r\n---\r\n", "\r\n"), ("\nrole: reviewer\n---\n", "\n")],
)
def test_fence_group_spans_the_whole_line_terminator(block: str, want: str) -> None:
    """parse_frontmatter slices the raw YAML block to the end of the fence's group 1,
    so that group must open at the match start and span the whole line terminator
    ending the block's last line. Asserted on the regex rather than through
    parse_frontmatter because PyYAML normalizes a bare trailing ``\\r``: no
    parse-level assertion can fail when this regresses. The Node SDK's parser folds
    the orphan CR into the last scalar's value, which is what the shared slicing
    protects against here and in packages/sdk-go.
    """
    fence = _FENCE.search(block)
    assert fence is not None
    assert fence.start(1) == fence.start()
    assert block[fence.start(1) : fence.end(1)] == want


def test_lf_documents_parse_identically_with_lf_terminators() -> None:
    fm = parse_frontmatter("---\nid: reviewer\nrole: reviewer\n---\n\nBody.\n")
    assert fm.error is None
    assert fm.data is not None and fm.data["role"] == "reviewer"
    assert fm.body == "\nBody.\n"
