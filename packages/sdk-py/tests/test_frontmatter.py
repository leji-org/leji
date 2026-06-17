"""Frontmatter edge cases mirroring packages/sdk/test/frontmatter.test.ts."""

from leji.frontmatter import parse_frontmatter


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
