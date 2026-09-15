"""The in-layer link scan, over the same committed fixture bytes the Node SDK's
``test/links.test.ts`` asserts against, case for case.

The fixture runner compares findings on (rule, severity, path) alone, so the two
halves of this rule it cannot see are pinned here: which destination the grammar
reads out of each spelling, the line it reports, and the path that destination
resolves to."""

import os
from pathlib import Path

from leji.links import (
    link_findings,
    link_unresolved_message,
    resolve_link_target,
    scan_links,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "fixtures"


def _read(path: Path) -> str:
    """The document's characters, its line terminators left exactly as committed.
    Python's text mode would translate CRLF to LF (the SDK's own reader lets it, and
    the scan's outcome is the same either way), which would take the CRLF fixture's
    point away: here the scanner is handed the bytes the Node SDK is handed."""
    with open(path, encoding="utf-8", newline="") as handle:
        return handle.read()


def _triples(root: Path, rel_path: str) -> list[tuple[str, str | None, int]]:
    """Every link in a governed document as the ``(target as written, resolved path,
    line)`` triple, the resolved path repository-root-relative POSIX and None for a
    destination this rule never judges."""
    root_abs = str(root.resolve())
    layer_root_abs = os.path.join(root_abs, "docs")
    text = _read(Path(root_abs) / rel_path)
    out: list[tuple[str, str | None, int]] = []
    for link in scan_links(text):
        abs_target = resolve_link_target(root_abs, layer_root_abs, rel_path, link.target)
        resolved = None if abs_target is None else os.path.relpath(abs_target, root_abs)
        out.append((link.target, resolved, link.line))
    return out


def test_valid_links_every_spelling_its_resolved_path_and_its_line() -> None:
    assert _triples(FIXTURES / "valid-links", "docs/domain/overview.md") == [
        ("dir/README.md", "docs/domain/dir/README.md", 5),
        ("../boot-profile.md", "docs/boot-profile.md", 6),
        ("/decisions/0001-adopt-leji.md", "docs/decisions/0001-adopt-leji.md", 7),
        # A directory resolves to the directory; the README inside it is what makes
        # the target answerable, and the existence rule reads it.
        ("dir/", "docs/domain/dir", 8),
        # Never judged: a bare fragment, and anything carrying a URI scheme.
        ("#overview", None, 9),
        ("https://leji.org/spec/", None, 10),
        ("mailto:owner@example.invalid", None, 11),
        ("dir/with%20space.md", "docs/domain/dir/with space.md", 12),
        # The three spellings of a path a bare run cannot carry plainly: balanced
        # parentheses, the angle-bracketed form, and the backslash-escaped form the
        # viewer emits for a generated link. All three resolve to the same file.
        ("dir/(x).md", "docs/domain/dir/(x).md", 13),
        ("dir/with space.md", "docs/domain/dir/with space.md", 14),
        ("dir/\\(x\\).md", "docs/domain/dir/(x).md", 15),
        ("diagram.svg", "docs/domain/diagram.svg", 16),
        # The reference definition on the last line, its title read only far enough to
        # establish that the line is a definition, then discarded.
        ("crlf.md", "docs/domain/crlf.md", 27),
    ]


def test_valid_links_a_code_span_and_a_fenced_block_are_code_crlf_included() -> None:
    root = FIXTURES / "valid-links"
    crlf = _read(root / "docs/domain/crlf.md")
    assert "\r\n" in crlf, "the fixture is stored with CRLF line endings"
    assert _triples(root, "docs/domain/crlf.md") == [("overview.md", "docs/domain/overview.md", 6)]


def test_invalid_link_split_line_a_split_bracket_paren_is_not_a_link() -> None:
    assert _triples(FIXTURES / "invalid-link-split-line", "docs/domain/overview.md") == [
        ("missing-split.md", "docs/domain/missing-split.md", 10)
    ]


def test_invalid_link_escapes_root_dotdot_and_a_symlink_are_both_unresolved() -> None:
    root = (FIXTURES / "invalid-link-escapes-root").resolve()
    root_abs = str(root)
    layer_root_abs = os.path.join(root_abs, "docs")

    # The symlink resolves to a file that exists — outside the layer — so existence
    # alone would pass it. Containment is what refuses it.
    symlink = root / "docs/domain/outside-link.md"
    assert symlink.is_symlink(), "the fixture plants a symlink"
    assert symlink.exists(), "whose target exists"

    for rel_path, target, line in (
        ("docs/boot-profile.md", "../../outside.md", 9),
        ("docs/domain/overview.md", "outside-link.md", 4),
    ):
        text = _read(root / rel_path)
        assert [(link.target, link.line) for link in scan_links(text)] == [(target, line)]
        findings = link_findings(root_abs, layer_root_abs, rel_path, text)
        assert len(findings) == 1
        assert (findings[0].rule, findings[0].severity, findings[0].path) == (
            "link-unresolved",
            "error",
            rel_path,
        )
        assert findings[0].line == line
        assert findings[0].construct == target


def test_invalid_link_readme_escapes_root_a_directory_whose_readme_leaves_the_layer() -> None:
    root = (FIXTURES / "invalid-link-readme-escapes-root").resolve()
    root_abs = str(root)
    layer_root_abs = os.path.join(root_abs, "docs")
    rel_path = "docs/domain/overview.md"

    # The directory is inside the layer and its README exists, so the directory's own
    # containment check and a bare existence test both pass it. Only containment of
    # the README ITSELF refuses this target.
    readme = root / "docs/domain/section/README.md"
    assert readme.is_symlink(), "the fixture plants the README as a symlink"
    assert readme.exists(), "whose target exists"

    assert _triples(root, rel_path) == [("section/", "docs/domain/section", 4)]

    findings = link_findings(root_abs, layer_root_abs, rel_path, _read(root / rel_path))
    assert len(findings) == 1
    assert (findings[0].rule, findings[0].severity, findings[0].path) == (
        "link-unresolved",
        "error",
        rel_path,
    )
    assert findings[0].line == 4
    assert findings[0].construct == "section/"


def test_the_message_interpolates_the_destination_verbatim() -> None:
    """The message carries the destination as written, byte for byte, in all three
    SDKs: a runtime that quotes it (Go's %q) would escape exactly these three and
    print a different line than the other two for the same layer."""
    assert (
        link_unresolved_message("missing\\name.md")
        == 'link target "missing\\name.md" does not resolve'
    )
    assert link_unresolved_message('a"b.md') == 'link target "a"b.md" does not resolve'
    assert link_unresolved_message("a\tb.md") == 'link target "a\tb.md" does not resolve'
