"""The rendering-subset scan, family by family over the edges the fixtures state in
prose: what it reports, and — the half a lint lives or dies on — what it stays quiet
about. Ported from the reference suite's families, case for case; the shared render
fixtures drive the same detector through the real command (test_render_fixtures.py).
"""

from __future__ import annotations

from leji.renderlint import (
    RAW_HTML,
    RENDER_UNSUPPORTED_RULE,
    render_lint_findings,
    scan_render_constructs,
)


def hits(text: str) -> list[str]:
    """The scan as `line:construct` strings, which is what a family assertion reads."""
    return [f"{h.line}:{h.construct}" for h in scan_render_constructs(text)]


def lines(*parts: str) -> str:
    return "\n".join(parts)


# --- family: multi-line HTML blocks -------------------------------------------


def test_family_html_blocks_report_once_at_the_opening_line() -> None:
    # A block runs to the next blank line, so the tags inside it — the closing one
    # included — are block content and not a second construct.
    assert hits(
        lines("# Doc", "", '<div class="callout">', "   inner text", "</div>", "", "after")
    ) == ["3:raw-html"]
    # Two blocks separated by a blank line are two constructs.
    assert hits(lines("<table>", "<tr><td>a</td></tr>", "</table>", "", "<div>", "</div>")) == [
        "1:raw-html",
        "5:raw-html",
    ]
    # A raw-text block (type 1) ends at its closing tag rather than at a blank line,
    # so the blank line inside it does not split it into two.
    assert hits(lines("<script>", "", "let x = 1;", "", "</script>", "", "prose")) == ["1:raw-html"]
    # Inline raw HTML mid-paragraph is the other form, reported on its own line, and a
    # line carrying two tags is still one finding: the line is the unit.
    assert hits("A paragraph with <b>bold</b> and <i>italic</i> in it.\n") == ["1:raw-html"]
    # Negative: a document with no HTML at all reports nothing.
    assert hits("# Title\n\nProse with a < less-than and an a > b comparison.\n") == []


# --- family: excluded regions -------------------------------------------------


def test_family_excluded_regions() -> None:
    # Code spans, including the multiple-backtick form.
    assert hits("The tag `<div>` and `[^ref]` and `$$x$$` are text.\n") == []
    assert hits("A span with a backtick in it: ``a `<b>` span``.\n") == []
    # Fenced blocks, whatever the info string, and a longer fence carrying a shorter
    # one: everything between the delimiters is code.
    assert hits(lines("```html", "<div>", "</div>", "```")) == []
    assert hits(lines("````markdown", "```html", "<span>x</span>", "```", "````")) == []
    assert hits(lines("~~~", "[^one]: definition", "$$", "x", "$$", "~~~")) == []
    # Comments are the excepted HTML form: nothing inside one is reported, on one line
    # or many, at the start of a line or inside prose.
    assert hits(lines("<!--", "   <div> and [^ref] and $$x$$", "-->", "", "prose")) == []
    assert hits("Prose with <!-- a <div> inside a comment --> and more prose.\n") == []
    # Positive controls: the same constructs outside a region are reported, so the
    # assertions above are the exclusion working rather than a scan that sees nothing.
    assert hits("The tag <div> and [^ref] and $$x$$ are markup.\n") == [
        "1:footnote",
        "1:math-block",
        "1:raw-html",
    ]
    # An unclosed fence excludes the rest of the document, as a renderer reads it.
    assert hits(lines("```", "<div>", "[^one]")) == []


# --- family: malformed and unpaired forms -------------------------------------


def test_family_unpaired_or_malformed_is_prose() -> None:
    # `$$` needs an open and a close; a lone delimiter is prose.
    assert hits("A lone delimiter:\n\n$$\n") == []
    assert hits("$$\na^2 + b^2 = c^2\n$$\n") == ["1:math-block"]
    assert hits("An inline pair: $$e = mc^2$$ mid-sentence.\n") == ["1:math-block"]
    # A single `$` is deliberately outside the closed token set.
    assert hits("An amount of $5 and a variable named $path.\n") == []
    # A footnote needs its closing bracket.
    assert hits("An open bracket [^ and nothing closing it.\n") == []
    assert hits("An empty label [^] is not a footnote either.\n") == []
    assert hits("A reference[^one] and its definition.\n\n[^one]: The text.\n") == [
        "1:footnote",
        "3:footnote",
    ]
    # A `<` that opens no valid tag is prose, and a bare tag name is not markup.
    assert hits("Compare a < b, and 3<4, and <-- an arrow.\n") == []


# --- family: the YAML frontmatter boundary ------------------------------------


def test_family_frontmatter_boundary() -> None:
    assert (
        hits(lines("---", "title: A value with <div> and [^ref] and $$x$$", "---", "", "# Doc", ""))
        == []
    )
    # A `---` later in a document is a thematic break, so the text after it is scanned
    # like any other prose.
    assert hits(lines("# Doc", "", "---", "", "Prose with <div> in it.", "")) == ["5:raw-html"]
    # A block that never closes is not frontmatter, so its content is prose — and
    # reported, which is the honest read of a document nothing will strip.
    assert hits(lines("---", "title: <div>", "", "# Doc", "")) == ["2:raw-html"]
    # Frontmatter opens the FILE or it is not frontmatter: a block one line down is a
    # thematic break followed by prose.
    assert hits(lines("", "---", "title: <div>", "---", "")) == ["3:raw-html"]


# --- family: overlaps and same-line ordering ----------------------------------


def test_family_overlaps_and_same_line_ordering() -> None:
    # Three constructs on one line, reported in the closed set's alphabetical order —
    # the tie-breaker that keeps a same-line group deterministic across the SDKs.
    assert hits("All three: [^b], <i>italic</i>, and $$x + y$$ in one sentence.\n") == [
        "1:footnote",
        "1:math-block",
        "1:raw-html",
    ]
    # A footnote-looking label inside a tag's attribute belongs to the tag: the
    # earliest-starting match consumes it, so the line reports raw HTML only.
    assert hits('<span title="[^ref]">text</span>\n') == ["1:raw-html"]
    # And the other way round: a tag inside a math pair belongs to the pair.
    assert hits("$$ a <b> c $$\n") == ["1:math-block"]
    # A math pair spanning lines is attributed to its opening line, and the constructs
    # between the delimiters are inside it.
    assert hits(lines("$$", "a <b> c [^ref]", "$$", "", "<span>x</span>")) == [
        "1:math-block",
        "5:raw-html",
    ]
    # Block structure outranks the inline pair, as a renderer reads it: a line OPENING
    # with a block tag is an HTML block running to the blank line, so the second
    # delimiter is inside it and the first never pairs.
    assert hits(lines("$$", "<div> [^ref]", "$$", "", "<span>x</span>")) == [
        "2:raw-html",
        "5:raw-html",
    ]
    # Repeats on one line collapse; the same construct on the next line does not.
    assert hits("[^a] and [^b] together.\n[^c] alone.\n") == ["1:footnote", "2:footnote"]


# --- family: backslash escapes ------------------------------------------------


def test_family_backslash_escapes() -> None:
    assert hits("Escaped: \\<div> and \\<b>bold\\</b> are prose.\n") == []
    assert hits("Escaped: \\[^one] in a sentence.\n\n\\[^one]: not a definition.\n") == []
    assert hits("Escaped math: \\$\\$ a^2 \\$\\$ is prose about the notation.\n") == []
    # An HTML entity spells a character, not an element.
    assert hits("Entities: &lt;div&gt; and &amp;lt; are text.\n") == []
    # Positive controls for each escape above.
    assert hits("Unescaped: <div> here.\n") == ["1:raw-html"]
    assert hits("Unescaped: [^one] here.\n") == ["1:footnote"]
    assert hits("Unescaped: $$ a^2 $$ here.\n") == ["1:math-block"]
    # A backslash before a non-punctuation character is a literal backslash, so the
    # construct after it still reports.
    assert hits("A backslash \\n then <div>.\n") == ["1:raw-html"]


# --- family: the HTML block forms that end mid-line ---------------------------


def test_family_block_forms_ending_mid_line() -> None:
    # CommonMark type 3: the block ends on the line carrying `?>`, and the WHOLE of
    # that line belongs to it — so what follows the terminator there is block content
    # rather than a second construct, and the block reports once, at its opening line.
    assert hits(lines("<?php", "[^inside]", "?> [^after]")) == ["1:raw-html"]
    # Type 4 (a declaration) ends at the first `>`, type 5 (CDATA) at `]]>`; what
    # follows the block, on a later line, is scanned normally.
    assert hits(lines("<!DOCTYPE html>", "", "[^after]")) == ["1:raw-html", "3:footnote"]
    assert hits(lines("<![CDATA[", "[^x]", "]]> [^after]", "", "prose [^real]")) == [
        "1:raw-html",
        "5:footnote",
    ]
    # A block whose terminator never arrives runs to the end of the document, exactly
    # as the comment form does.
    assert hits(lines("<?php", "[^inside]")) == ["1:raw-html"]
    # Negatives. The same forms mid-line are INLINE raw HTML, so the line's remainder
    # is still scanned; an escaped opener is prose; one inside a fence is code.
    assert hits("Prose <?php echo 1; ?> and [^ref].\n") == ["1:footnote", "1:raw-html"]
    assert hits("Escaped \\<?php ?> here.\n") == []
    assert hits(lines("```", "<?php ?>", "```", "[^after]")) == ["4:footnote"]


# --- family: inline state never crosses a block boundary ----------------------


def test_family_inline_state_never_bridges_a_block_region() -> None:
    # The candidate closer lies beyond a block region, which ended the paragraph the
    # run opened in: the backticks are literal at that boundary, so the footnote after
    # the region is reported rather than swallowed.
    assert hits(lines("Text `open", "<!-- comment -->", "[^after] and a closer `here")) == [
        "3:footnote"
    ]
    # The same for a `$$` whose apparent mate sits on the far side of the region: an
    # unpaired delimiter is prose, and what follows it still reports.
    assert hits(lines("$$ open", "<!-- comment -->", "$$ and [^after]")) == ["3:footnote"]
    # Positive controls: inside ONE block, both forms still span lines.
    assert hits(lines("A span `over", "two lines` and [^after]")) == ["2:footnote"]
    assert hits(lines("$$", "a^2 + b^2", "$$")) == ["1:math-block"]


# --- family: a mate inside an excluded span, and straddling delimiters ---------


def test_family_mate_inside_an_excluded_span() -> None:
    # The apparent closer is inside an excluded region, so the open never pairs and the
    # line is prose about the notation.
    assert hits("$$ open `$$` tail\n") == []
    assert hits("$$ open <!-- $$ --> tail\n") == []
    # Positive controls: a readable mate pairs, and a real pair after an excluded one
    # is still found.
    assert hits("$$ open $$ tail\n") == ["1:math-block"]
    assert hits("`$$` and then a real pair $$x$$\n") == ["1:math-block"]
    # Straddling a span's edge, both ways: a footnote whose closing bracket is inside a
    # code span still reports — the earliest start wins the overlap — while one that
    # OPENS inside the span is span content.
    assert hits("[^one `] and text`\n") == ["1:footnote"]
    assert hits("`[^one` ] tail\n") == []


# --- family: declaration case, split terminators, and indented openers --------


def test_family_declaration_case_and_terminators() -> None:
    # `<!` plus an ASCII letter of EITHER case is a declaration, at block and inline
    # positions alike — the rendering the vendored renderer actually produces, and
    # CommonMark's own character class. A block one runs to the next `>`, so what sits
    # inside the consumed span and what trails the terminator on its line are block
    # content rather than constructs of their own.
    assert hits(lines("<!foo", "[^inside]", "<!DOCTYPE html> [^tail]", "", "[^after]")) == [
        "1:raw-html",
        "5:footnote",
    ]
    # Unterminated, the block runs to the end of the document, as the comment form does.
    assert hits(lines("<!foo", "[^after]")) == ["1:raw-html"]
    assert hits("Prose <!foo bar> and [^ref].\n") == ["1:footnote", "1:raw-html"]
    # The uppercase spellings, block form and inline form: identical treatment, so the
    # assertions above are the grammar and not a case accident.
    assert hits(lines("<!DOCTYPE html>", "", "[^after]")) == ["1:raw-html", "3:footnote"]
    assert hits('Prose <!ENTITY x "y"> and [^ref].\n') == ["1:footnote", "1:raw-html"]
    # A terminator split across two lines is not a terminator: the CDATA block runs on
    # to the contiguous `]]>`, and that whole line is block content.
    assert hits(
        lines("<![CDATA[", "data ]]", "> still inside [^no]", "]]> [^after]", "", "[^real]")
    ) == ["1:raw-html", "6:footnote"]
    # Indentation decides whether a line opens a block at all: a tab is one indent
    # character, so a tab-indented opener still opens one, terminator line included.
    assert hits(lines("\t<?php", "[^inside]", "\t?> [^after]", "", "[^real]")) == [
        "1:raw-html",
        "5:footnote",
    ]
    # Four leading spaces are indented code, which opens no block: an unterminated
    # opener there swallows nothing, and the line after it still reports.
    assert hits(lines("    <?php", "[^after]")) == ["2:footnote"]


# --- the finding shape --------------------------------------------------------


def test_findings_carry_the_closed_token_and_the_opening_line() -> None:
    findings = render_lint_findings("docs/render/raw-html.md", "# Doc\n\nProse with <div> in it.\n")
    assert len(findings) == 1
    f = findings[0]
    assert f.rule == RENDER_UNSUPPORTED_RULE
    assert f.severity == "warning"
    assert f.path == "docs/render/raw-html.md"
    assert f.line == 3
    assert f.construct == RAW_HTML
    assert f.message == (
        "`raw-html` is outside the supported rendering subset; see adoption/rendering.md"
    )
    # The finding's JSON shape carries the two located keys between path and message,
    # exactly where the Node and Go documents carry them.
    assert list(f.to_dict()) == ["rule", "severity", "path", "line", "construct", "message"]
