package renderlint

import (
	"strconv"
	"strings"
	"testing"
)

// The scan itself, family by family over the edges the fixtures state in prose:
// what it reports, and — the half a lint lives or dies on — what it stays quiet
// about. Ported from the reference suite's families, case for case; the shared
// render fixtures drive the same detector through the real command.

// hits is the scan as `line:construct` strings, which is what a family assertion reads.
func hits(text string) []string {
	var out []string
	for _, h := range ScanRenderConstructs(text) {
		out = append(out, strconv.Itoa(h.Line)+":"+h.Construct)
	}
	return out
}

func eq(t *testing.T, text string, want ...string) {
	t.Helper()
	got := hits(text)
	if len(got) != len(want) {
		t.Fatalf("hits(%q) = %v, want %v", text, got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("hits(%q) = %v, want %v", text, got, want)
		}
	}
}

func lines(l ...string) string { return strings.Join(l, "\n") }

// --- family: multi-line HTML blocks -------------------------------------------

func TestFamilyHTMLBlocksReportOnceAtTheOpeningLine(t *testing.T) {
	// A block runs to the next blank line, so the tags inside it — the closing one
	// included — are block content and not a second construct.
	eq(t, lines("# Doc", "", `<div class="callout">`, "   inner text", "</div>", "", "after"), "3:raw-html")
	// Two blocks separated by a blank line are two constructs.
	eq(t, lines("<table>", "<tr><td>a</td></tr>", "</table>", "", "<div>", "</div>"), "1:raw-html", "5:raw-html")
	// A raw-text block (type 1) ends at its closing tag rather than at a blank line,
	// so the blank line inside it does not split it into two.
	eq(t, lines("<script>", "", "let x = 1;", "", "</script>", "", "prose"), "1:raw-html")
	// Inline raw HTML mid-paragraph is the other form, reported on its own line, and
	// a line carrying two tags is still one finding: the line is the unit.
	eq(t, "A paragraph with <b>bold</b> and <i>italic</i> in it.\n", "1:raw-html")
	// Negative: a document with no HTML at all reports nothing.
	eq(t, "# Title\n\nProse with a < less-than and an a > b comparison.\n")
}

// --- family: excluded regions -------------------------------------------------

func TestFamilyExcludedRegions(t *testing.T) {
	// Code spans, including the multiple-backtick form.
	eq(t, "The tag `<div>` and `[^ref]` and `$$x$$` are text.\n")
	eq(t, "A span with a backtick in it: ``a `<b>` span``.\n")
	// Fenced blocks, whatever the info string, and a longer fence carrying a shorter
	// one: everything between the delimiters is code.
	eq(t, lines("```html", "<div>", "</div>", "```"))
	eq(t, lines("````markdown", "```html", "<span>x</span>", "```", "````"))
	eq(t, lines("~~~", "[^one]: definition", "$$", "x", "$$", "~~~"))
	// Comments are the excepted HTML form: nothing inside one is reported, on one
	// line or many, at the start of a line or inside prose.
	eq(t, lines("<!--", "   <div> and [^ref] and $$x$$", "-->", "", "prose"))
	eq(t, "Prose with <!-- a <div> inside a comment --> and more prose.\n")
	// Positive controls: the same constructs outside a region are reported, so the
	// assertions above are the exclusion working rather than a scan that sees nothing.
	eq(t, "The tag <div> and [^ref] and $$x$$ are markup.\n", "1:footnote", "1:math-block", "1:raw-html")
	// An unclosed fence excludes the rest of the document, as a renderer reads it.
	eq(t, lines("```", "<div>", "[^one]"))
}

// --- family: malformed and unpaired forms -------------------------------------

func TestFamilyUnpairedOrMalformedIsProse(t *testing.T) {
	// `$$` needs an open and a close; a lone delimiter is prose.
	eq(t, "A lone delimiter:\n\n$$\n")
	eq(t, "$$\na^2 + b^2 = c^2\n$$\n", "1:math-block")
	eq(t, "An inline pair: $$e = mc^2$$ mid-sentence.\n", "1:math-block")
	// A single `$` is deliberately outside the closed token set.
	eq(t, "An amount of $5 and a variable named $path.\n")
	// A footnote needs its closing bracket.
	eq(t, "An open bracket [^ and nothing closing it.\n")
	eq(t, "An empty label [^] is not a footnote either.\n")
	eq(t, "A reference[^one] and its definition.\n\n[^one]: The text.\n", "1:footnote", "3:footnote")
	// A `<` that opens no valid tag is prose, and a bare tag name is not markup.
	eq(t, "Compare a < b, and 3<4, and <-- an arrow.\n")
}

// --- family: the YAML frontmatter boundary ------------------------------------

func TestFamilyFrontmatterBoundary(t *testing.T) {
	eq(t, lines("---", "title: A value with <div> and [^ref] and $$x$$", "---", "", "# Doc", ""))
	// A `---` later in a document is a thematic break, so the text after it is
	// scanned like any other prose.
	eq(t, lines("# Doc", "", "---", "", "Prose with <div> in it.", ""), "5:raw-html")
	// A block that never closes is not frontmatter, so its content is prose — and
	// reported, which is the honest read of a document nothing will strip.
	eq(t, lines("---", "title: <div>", "", "# Doc", ""), "2:raw-html")
	// Frontmatter opens the FILE or it is not frontmatter: a block one line down is a
	// thematic break followed by prose.
	eq(t, lines("", "---", "title: <div>", "---", ""), "3:raw-html")
}

// --- family: overlaps and same-line ordering ----------------------------------

func TestFamilyOverlapsAndSameLineOrdering(t *testing.T) {
	// Three constructs on one line, reported in the closed set's alphabetical order —
	// the tie-breaker that keeps a same-line group deterministic across the SDKs.
	eq(t, "All three: [^b], <i>italic</i>, and $$x + y$$ in one sentence.\n",
		"1:footnote", "1:math-block", "1:raw-html")
	// A footnote-looking label inside a tag's attribute belongs to the tag: the
	// earliest-starting match consumes it, so the line reports raw HTML only.
	eq(t, "<span title=\"[^ref]\">text</span>\n", "1:raw-html")
	// And the other way round: a tag inside a math pair belongs to the pair.
	eq(t, "$$ a <b> c $$\n", "1:math-block")
	// A math pair spanning lines is attributed to its opening line, and the constructs
	// between the delimiters are inside it.
	eq(t, lines("$$", "a <b> c [^ref]", "$$", "", "<span>x</span>"), "1:math-block", "5:raw-html")
	// Block structure outranks the inline pair, as a renderer reads it: a line OPENING
	// with a block tag is an HTML block running to the blank line, so the second
	// delimiter is inside it and the first never pairs.
	eq(t, lines("$$", "<div> [^ref]", "$$", "", "<span>x</span>"), "2:raw-html", "5:raw-html")
	// Repeats on one line collapse; the same construct on the next line does not.
	eq(t, "[^a] and [^b] together.\n[^c] alone.\n", "1:footnote", "2:footnote")
}

// --- family: backslash escapes ------------------------------------------------

func TestFamilyBackslashEscapes(t *testing.T) {
	eq(t, "Escaped: \\<div> and \\<b>bold\\</b> are prose.\n")
	eq(t, "Escaped: \\[^one] in a sentence.\n\n\\[^one]: not a definition.\n")
	eq(t, "Escaped math: \\$\\$ a^2 \\$\\$ is prose about the notation.\n")
	// An HTML entity spells a character, not an element.
	eq(t, "Entities: &lt;div&gt; and &amp;lt; are text.\n")
	// Positive controls for each escape above.
	eq(t, "Unescaped: <div> here.\n", "1:raw-html")
	eq(t, "Unescaped: [^one] here.\n", "1:footnote")
	eq(t, "Unescaped: $$ a^2 $$ here.\n", "1:math-block")
	// A backslash before a non-punctuation character is a literal backslash, so the
	// construct after it still reports.
	eq(t, "A backslash \\n then <div>.\n", "1:raw-html")
}

// --- family: the HTML block forms that end mid-line ---------------------------

func TestFamilyBlockFormsEndingMidLine(t *testing.T) {
	// CommonMark type 3: the block ends on the line carrying `?>`, and the WHOLE of
	// that line belongs to it — so what follows the terminator there is block content
	// rather than a second construct, and the block reports once, at its opening line.
	eq(t, lines("<?php", "[^inside]", "?> [^after]"), "1:raw-html")
	// Type 4 (a declaration) ends at the first `>`, type 5 (CDATA) at `]]>`; what
	// follows the block, on a later line, is scanned normally.
	eq(t, lines("<!DOCTYPE html>", "", "[^after]"), "1:raw-html", "3:footnote")
	eq(t, lines("<![CDATA[", "[^x]", "]]> [^after]", "", "prose [^real]"), "1:raw-html", "5:footnote")
	// A block whose terminator never arrives runs to the end of the document, exactly
	// as the comment form does.
	eq(t, lines("<?php", "[^inside]"), "1:raw-html")
	// Negatives. The same forms mid-line are INLINE raw HTML, so the line's remainder
	// is still scanned; an escaped opener is prose; one inside a fence is code.
	eq(t, "Prose <?php echo 1; ?> and [^ref].\n", "1:footnote", "1:raw-html")
	eq(t, "Escaped \\<?php ?> here.\n")
	eq(t, lines("```", "<?php ?>", "```", "[^after]"), "4:footnote")
}

// --- family: inline state never crosses a block boundary ----------------------

func TestFamilyInlineStateNeverBridgesABlockRegion(t *testing.T) {
	// The candidate closer lies beyond a block region, which ended the paragraph the
	// run opened in: the backticks are literal at that boundary, so the footnote after
	// the region is reported rather than swallowed.
	eq(t, lines("Text `open", "<!-- comment -->", "[^after] and a closer `here"), "3:footnote")
	// The same for a `$$` whose apparent mate sits on the far side of the region: an
	// unpaired delimiter is prose, and what follows it still reports.
	eq(t, lines("$$ open", "<!-- comment -->", "$$ and [^after]"), "3:footnote")
	// Positive controls: inside ONE block, both forms still span lines.
	eq(t, lines("A span `over", "two lines` and [^after]"), "2:footnote")
	eq(t, lines("$$", "a^2 + b^2", "$$"), "1:math-block")
}

// --- family: a mate inside an excluded span, and straddling delimiters ---------

func TestFamilyMateInsideAnExcludedSpan(t *testing.T) {
	// The apparent closer is inside an excluded region, so the open never pairs and
	// the line is prose about the notation.
	eq(t, "$$ open `$$` tail\n")
	eq(t, "$$ open <!-- $$ --> tail\n")
	// Positive controls: a readable mate pairs, and a real pair after an excluded one
	// is still found.
	eq(t, "$$ open $$ tail\n", "1:math-block")
	eq(t, "`$$` and then a real pair $$x$$\n", "1:math-block")
	// Straddling a span's edge, both ways: a footnote whose closing bracket is inside
	// a code span still reports — the earliest start wins the overlap — while one that
	// OPENS inside the span is span content.
	eq(t, "[^one `] and text`\n", "1:footnote")
	eq(t, "`[^one` ] tail\n")
}

// --- family: declaration case, split terminators, and indented openers --------

func TestFamilyDeclarationCaseAndTerminators(t *testing.T) {
	// `<!` plus an ASCII letter of EITHER case is a declaration, at block and inline
	// positions alike — the rendering the vendored renderer actually produces, and
	// CommonMark's own character class. A block one runs to the next `>`, so what sits
	// inside the consumed span and what trails the terminator on its line are block
	// content rather than constructs of their own.
	eq(t, lines("<!foo", "[^inside]", "<!DOCTYPE html> [^tail]", "", "[^after]"), "1:raw-html", "5:footnote")
	// Unterminated, the block runs to the end of the document, as the comment form does.
	eq(t, lines("<!foo", "[^after]"), "1:raw-html")
	eq(t, "Prose <!foo bar> and [^ref].\n", "1:footnote", "1:raw-html")
	// The uppercase spellings, block form and inline form: identical treatment, so the
	// assertions above are the grammar and not a case accident.
	eq(t, lines("<!DOCTYPE html>", "", "[^after]"), "1:raw-html", "3:footnote")
	eq(t, "Prose <!ENTITY x \"y\"> and [^ref].\n", "1:footnote", "1:raw-html")
	// A terminator split across two lines is not a terminator: the CDATA block runs on
	// to the contiguous `]]>`, and that whole line is block content.
	eq(t, lines("<![CDATA[", "data ]]", "> still inside [^no]", "]]> [^after]", "", "[^real]"),
		"1:raw-html", "6:footnote")
	// Indentation decides whether a line opens a block at all: a tab is one indent
	// character, so a tab-indented opener still opens one, terminator line included.
	eq(t, lines("\t<?php", "[^inside]", "\t?> [^after]", "", "[^real]"), "1:raw-html", "5:footnote")
	// Four leading spaces are indented code, which opens no block: an unterminated
	// opener there swallows nothing, and the line after it still reports.
	eq(t, lines("    <?php", "[^after]"), "2:footnote")
}

// --- the finding shape --------------------------------------------------------

func TestFindingsCarryTheClosedTokenAndTheOpeningLine(t *testing.T) {
	fs := Findings("docs/render/raw-html.md", "# Doc\n\nProse with <div> in it.\n")
	if len(fs) != 1 {
		t.Fatalf("findings = %v", fs)
	}
	f := fs[0]
	if f.Rule != RenderUnsupportedRule || f.Severity != "warning" || f.Path != "docs/render/raw-html.md" ||
		f.Line != 3 || f.Construct != RawHTML {
		t.Fatalf("finding = %+v", f)
	}
	if f.Message != "`raw-html` is outside the supported rendering subset; see adoption/rendering.md" {
		t.Fatalf("message = %q", f.Message)
	}
}
