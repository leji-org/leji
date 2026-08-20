// Package renderlint is the rendering-subset scan: given one markdown document,
// the constructs in it that render differently across renderers. The Node SDK's
// lib/renderlint.ts is the executable contract this port follows rule for rule —
// the rules are stated there and here in the order they are applied, because a
// second statement of them (a grammar, a spec paragraph) would be a source that
// drifts.
//
// The rules, in application order:
//
//  1. Excluded regions are found first. YAML frontmatter (a leading block only, by
//     the SDK's own boundary), fenced code blocks, and HTML comments are scanned
//     before anything else, and nothing inside one is ever reported — text that
//     merely names a construct is not that construct. Code spans are excluded the
//     same way, inline, as the scan reaches them.
//  2. Three constructs are reported, and only these three: `raw-html` (CommonMark
//     HTML blocks and inline raw HTML; comments excepted, since Leji's own
//     generated-block markers are comments), `footnote` (the definition and
//     reference forms alike), and `math-block` (a PAIRED `$$` delimiter — a lone
//     one is prose).
//  3. Backslash escapes are honored for all three, per CommonMark: an escaped ASCII
//     punctuation character is a literal, so `\<div>` is prose.
//  4. Overlapping constructs resolve to the earliest-starting match, which the
//     single left-to-right scan below produces by construction, and each match is
//     attributed to the line it OPENS on — a multi-line HTML block or `$$` block
//     reports once, at its opening line.
//  5. One hit per (line, construct): the line is the unit, so a line carrying two
//     inline tags reports `raw-html` once.
//
// What is deliberately NOT reported: inline `$` (a currency amount spells it),
// unknown fence info strings (the unhighlighted fallback is conforming), and loose
// prose shapes. `adoption/rendering.md` is the profile these rules serve.
package renderlint

import (
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/frontmatter"
)

// The closed token set. Findings compare on it across the three SDKs; the message
// text does not.
const (
	RawHTML   = "raw-html"
	Footnote  = "footnote"
	MathBlock = "math-block"
)

// RenderUnsupportedRule is the one rule this scan produces. `--strict` promotes it
// (see the export command).
const RenderUnsupportedRule = "render-unsupported"

// Message is the shared message template. Identical bytes in all three SDKs by
// convention, outside the fixture contract by design.
func Message(construct string) string {
	return "`" + construct + "` is outside the supported rendering subset; see adoption/rendering.md"
}

// Hit is one reported construct: the token, and the 1-based line it opens on.
type Hit struct {
	Line      int
	Construct string
}

// blockTags is CommonMark HTML block type 6: a line opening with one of these tags
// starts a block that runs to the next blank line, whatever else the line carries.
// The list is CommonMark's, verbatim, so a `</div>` closing a block on a later line
// is block content rather than a second construct.
var blockTags = func() map[string]bool {
	names := "address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl " +
		"dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend " +
		"li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td " +
		"tfoot th thead title tr track ul"
	set := map[string]bool{}
	for _, n := range strings.Split(names, " ") {
		set[n] = true
	}
	return set
}()

var (
	// CommonMark HTML block type 1: these run to a line carrying a closing tag
	// rather than to a blank line, because their content is raw text.
	rawTextOpen  = regexp.MustCompile(`(?i)^<(script|pre|style|textarea)([ \t>]|$)`)
	rawTextClose = regexp.MustCompile(`(?i)</(script|pre|style|textarea)>`)

	// Inline raw HTML, as CommonMark defines it: an open tag, a closing tag, a
	// processing instruction, a declaration, or a CDATA section. (A comment is the
	// sixth form and the excepted one, handled as an excluded region.) Each is
	// anchored, so it is tried at exactly the scan position. A declaration takes an
	// ASCII letter of either case after `<!`: `<!DOCTYPE html>` and `<!foo bar>`
	// alike disappear into the renderer, which is precisely what the lint exists to
	// warn about.
	openTag     = regexp.MustCompile("^<[A-Za-z][A-Za-z0-9-]*(?:[ \t\r\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t\r\n]*=[ \t\r\n]*(?:[^ \t\r\n\"'=<>`]+|'[^']*'|\"[^\"]*\"))?)*[ \t\r\n]*/?>")
	closeTag    = regexp.MustCompile("^</[A-Za-z][A-Za-z0-9-]*[ \t\r\n]*>")
	cdata       = regexp.MustCompile(`(?s)^<!\[CDATA\[.*?\]\]>`)
	declaration = regexp.MustCompile(`(?s)^<![A-Za-z].*?>`)
	processing  = regexp.MustCompile(`(?s)^<\?.*?\?>`)
	// Both footnote forms: the reference `[^id]`, and the definition `[^id]:`, whose
	// opening bracket the same match covers. An unclosed `[^` is prose.
	footnote = regexp.MustCompile(`^\[\^[^\][\n]+\]`)

	// A fence opener: three or more backticks or tildes. A backtick fence's info
	// string may carry no backtick, which is what keeps a code span off this path.
	fenceOpen = regexp.MustCompile("^(`{3,}|~{3,})(.*)$")
	// A fence closer: the same character, at least as long, alone on its line.
	fenceClose = regexp.MustCompile("^(`{3,}|~{3,})[ \t]*$")
	// A line opening with a tag name, for the type-6/type-7 block test.
	lineTag = regexp.MustCompile(`^</?([A-Za-z][A-Za-z0-9-]*)([ \t]|/?>|$)`)
)

// escapable is CommonMark's escapable set: ASCII punctuation, and nothing else.
func escapable(b byte) bool {
	return (b >= '!' && b <= '/') || (b >= ':' && b <= '@') || (b >= '[' && b <= '`') || (b >= '{' && b <= '~')
}

func asciiLetter(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

// region is a span the scan treats as one unit: an excluded region (empty
// construct), or a block-level construct reported at its opening line. Regions are
// produced in document order and never overlap.
type region struct {
	start     int
	end       int
	construct string
}

// lineStartsOf is the offsets at which each line begins, so an offset resolves to a
// line number.
func lineStartsOf(text string) []int {
	starts := []int{0}
	for i := 0; i < len(text); i++ {
		if text[i] == '\n' {
			starts = append(starts, i+1)
		}
	}
	return starts
}

// lineOf is the 0-based line an offset falls on.
func lineOf(starts []int, offset int) int {
	lo, hi := 0, len(starts)-1
	for lo < hi {
		mid := (lo + hi + 1) / 2
		if starts[mid] <= offset {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	return lo
}

// lineTextAt is one line's text, without its line terminator (CRLF included).
func lineTextAt(text string, starts []int, li int) string {
	end := len(text)
	if li+1 < len(starts) {
		end = starts[li+1]
	}
	line := text[starts[li]:end]
	line = strings.TrimSuffix(line, "\n")
	return strings.TrimSuffix(line, "\r")
}

// lineEndOf is the offset just past a line's terminator.
func lineEndOf(text string, starts []int, li int) int {
	if li+1 < len(starts) {
		return starts[li+1]
	}
	return len(text)
}

// indentOf is the leading spaces, capped at the four that would make the line
// indented code.
func indentOf(line string) int {
	n := 0
	for n < 4 && n < len(line) && (line[n] == ' ' || line[n] == '\t') {
		n++
	}
	return n
}

// indexFrom is strings.Index over text[from:], as an absolute offset or -1.
func indexFrom(text, sub string, from int) int {
	if from > len(text) {
		return -1
	}
	i := strings.Index(text[from:], sub)
	if i < 0 {
		return -1
	}
	return from + i
}

// blockRegions is the block pass: frontmatter, fenced code, HTML comments (all
// excluded), and the HTML blocks that report as `raw-html` at their opening line.
// Line-based and in document order, so a fence inside a comment is comment text and
// a comment inside a fence is code — whichever opens first wins.
func blockRegions(text string, starts []int) []region {
	var regions []region
	n := len(text)
	li := 0

	// Frontmatter, by the SDK's own boundary (a LEADING block only; a `---` later in
	// the document is a thematic break, and an unterminated block is prose).
	fm := frontmatter.Parse(text)
	if len(fm.Body) != n {
		end := n - len(fm.Body)
		regions = append(regions, region{start: 0, end: end})
		if end >= n {
			li = len(starts)
		} else {
			li = lineOf(starts, end)
		}
	}

	for li < len(starts) {
		line := lineTextAt(text, starts, li)
		indent := indentOf(line)
		if indent >= 4 {
			li++
			continue
		}
		rest := line[indent:]
		at := starts[li] + indent

		if fence := fenceOpen.FindStringSubmatch(rest); fence != nil && (fence[1][0] == '~' || !strings.Contains(fence[2], "`")) {
			closeLi := li + 1
			for ; closeLi < len(starts); closeLi++ {
				candidate := lineTextAt(text, starts, closeLi)
				m := fenceClose.FindStringSubmatch(candidate[indentOf(candidate):])
				if m != nil && m[1][0] == fence[1][0] && len(m[1]) >= len(fence[1]) {
					break
				}
			}
			last := closeLi
			if last > len(starts)-1 {
				last = len(starts) - 1
			}
			regions = append(regions, region{start: starts[li], end: lineEndOf(text, starts, last)})
			li = last + 1
			continue
		}

		// A comment opening a line is CommonMark HTML block type 2: it runs to the
		// line carrying `-->`, and the whole of that line belongs to it. Comments are
		// the one HTML form the profile excepts, so the region reports nothing.
		if strings.HasPrefix(rest, "<!--") {
			closeAt := indexFrom(text, "-->", at+4)
			last := len(starts) - 1
			if closeAt >= 0 {
				last = lineOf(starts, closeAt+3)
			}
			regions = append(regions, region{start: starts[li], end: lineEndOf(text, starts, last)})
			li = last + 1
			continue
		}

		// CommonMark HTML blocks 3, 4 and 5: a processing instruction, a declaration,
		// or a CDATA section opening a line is a BLOCK, running to the line carrying
		// its terminator (`?>`, `>`, `]]>`) and ending with that whole line — so what
		// follows the terminator on it is block content, never a second construct. An
		// unterminated one runs to the end of the document, as the comment form does.
		// Type 4 takes an ASCII letter of either case, so `<!foo` opens a block exactly
		// as `<!DOCTYPE` does — everything through the next `>` disappears from the page.
		terminator := ""
		switch {
		case strings.HasPrefix(rest, "<?"):
			terminator = "?>"
		case strings.HasPrefix(rest, "<![CDATA["):
			terminator = "]]>"
		case len(rest) > 2 && rest[0] == '<' && rest[1] == '!' && asciiLetter(rest[2]):
			terminator = ">"
		}
		if terminator != "" {
			closeAt := indexFrom(text, terminator, at)
			last := len(starts) - 1
			if closeAt >= 0 {
				last = lineOf(starts, closeAt)
			}
			regions = append(regions, region{start: starts[li], end: lineEndOf(text, starts, last), construct: RawHTML})
			li = last + 1
			continue
		}

		if rawTextOpen.MatchString(rest) {
			last := len(starts) - 1
			if loc := rawTextClose.FindStringIndex(text[at:]); loc != nil {
				last = lineOf(starts, at+loc[0])
			}
			regions = append(regions, region{start: starts[li], end: lineEndOf(text, starts, last), construct: RawHTML})
			li = last + 1
			continue
		}

		// Type 6 (a known block tag opens the line) and type 7 (any complete tag alone
		// on a line, which cannot interrupt a paragraph). Both run to the next blank
		// line, so the tags closing them are block content.
		tag := lineTag.FindStringSubmatch(rest)
		previousBlank := li == 0 || strings.TrimSpace(lineTextAt(text, starts, li-1)) == ""
		isBlock := (tag != nil && blockTags[strings.ToLower(tag[1])]) || (previousBlank && wholeLineIsTag(rest))
		if isBlock {
			closeLi := li + 1
			for closeLi < len(starts) && strings.TrimSpace(lineTextAt(text, starts, closeLi)) != "" {
				closeLi++
			}
			regions = append(regions, region{start: starts[li], end: lineEndOf(text, starts, closeLi-1), construct: RawHTML})
			li = closeLi
			continue
		}
		li++
	}
	return regions
}

// wholeLineIsTag reports whether the line is one complete open or closing tag and
// nothing else.
func wholeLineIsTag(rest string) bool {
	for _, re := range []*regexp.Regexp{openTag, closeTag} {
		if m := re.FindString(rest); m != "" && strings.TrimSpace(rest[len(m):]) == "" {
			return true
		}
	}
	return false
}

// skipRegion is the end of the region containing i, or i when it is outside every one.
func skipRegion(regions []region, i int) int {
	for _, r := range regions {
		if i >= r.start && i < r.end {
			return r.end
		}
	}
	return i
}

// runLength is the length of the run of ch starting at i.
func runLength(text string, i int, ch byte) int {
	n := 0
	for i+n < len(text) && text[i+n] == ch {
		n++
	}
	return n
}

// afterCodeSpan skips a code span: a backtick run closed by a run of exactly the
// same length. An unclosed run is literal text, so the scan resumes just past it.
// Inline state never crosses a block boundary: a candidate whose closer would lie
// beyond an excluded or block region is unclosed AT that boundary, because the
// region ends the paragraph the run opened in — so constructs after the region still
// report.
func afterCodeSpan(text string, regions []region, i int) int {
	open := runLength(text, i, '`')
	j := i + open
	for j < len(text) {
		if skipRegion(regions, j) != j {
			break
		}
		if text[j] == '`' {
			run := runLength(text, j, '`')
			if run == open {
				return j + run
			}
			j += run
			continue
		}
		j++
	}
	return i + open
}

// nextMathDelimiter is the next unescaped `$$` at or after from, or -1. A delimiter
// is a closer only where a delimiter can be read: not inside a code span, not inside
// a comment, and not on the far side of a block boundary — a pair no more bridges a
// region than a code span does, so an open whose apparent mate sits in one of them is
// unpaired, which is prose.
func nextMathDelimiter(text string, regions []region, from int) int {
	j := from
	for j < len(text)-1 {
		if skipRegion(regions, j) != j {
			return -1
		}
		if text[j] == '\\' && j+1 < len(text) && escapable(text[j+1]) {
			j += 2
			continue
		}
		if text[j] == '`' {
			j = afterCodeSpan(text, regions, j)
			continue
		}
		if strings.HasPrefix(text[j:], "<!--") {
			closeAt := indexFrom(text, "-->", j+4)
			if closeAt < 0 {
				j = len(text)
			} else {
				j = closeAt + 3
			}
			continue
		}
		if text[j] == '$' && text[j+1] == '$' {
			return j
		}
		j++
	}
	return -1
}

// inlineHTMLEnd is an inline raw-HTML form at i, as its end offset, or -1.
func inlineHTMLEnd(text string, i int) int {
	for _, re := range []*regexp.Regexp{cdata, processing, declaration, closeTag, openTag} {
		if m := re.FindString(text[i:]); m != "" {
			return i + len(m)
		}
	}
	return -1
}

// ScanRenderConstructs is every reported construct in one markdown document, ordered
// by (line, construct) — the order the export's findings carry, and the tie-breaker
// that keeps two constructs on one line deterministic across the three SDKs.
func ScanRenderConstructs(text string) []Hit {
	starts := lineStartsOf(text)
	regions := blockRegions(text, starts)
	seen := map[string]bool{}
	var hits []Hit
	record := func(offset int, construct string) {
		line := lineOf(starts, offset) + 1
		key := strconv.Itoa(line) + " " + construct
		if seen[key] {
			return
		}
		seen[key] = true
		hits = append(hits, Hit{Line: line, Construct: construct})
	}

	for _, r := range regions {
		if r.construct != "" {
			record(r.start, r.construct)
		}
	}

	// The inline pass: one left-to-right walk, so the earliest-starting match wins
	// every overlap and each match is consumed whole.
	i := 0
	for i < len(text) {
		if skip := skipRegion(regions, i); skip != i {
			i = skip
			continue
		}
		c := text[i]
		if c == '\\' && i+1 < len(text) && escapable(text[i+1]) {
			i += 2
			continue
		}
		if c == '`' {
			i = afterCodeSpan(text, regions, i)
			continue
		}
		if c == '<' {
			if strings.HasPrefix(text[i:], "<!--") {
				closeAt := indexFrom(text, "-->", i+4)
				if closeAt < 0 {
					i = len(text)
				} else {
					i = closeAt + 3
				}
				continue
			}
			if end := inlineHTMLEnd(text, i); end != -1 {
				record(i, RawHTML)
				i = end
				continue
			}
			i++
			continue
		}
		if c == '[' && i+1 < len(text) && text[i+1] == '^' {
			if m := footnote.FindString(text[i:]); m != "" {
				record(i, Footnote)
				i += len(m)
				continue
			}
			i++
			continue
		}
		if c == '$' && i+1 < len(text) && text[i+1] == '$' {
			if closeAt := nextMathDelimiter(text, regions, i+2); closeAt != -1 {
				record(i, MathBlock)
				i = closeAt + 2
				continue
			}
			// Unpaired: prose, and the scan carries on past it.
			i += 2
			continue
		}
		i++
	}

	sort.SliceStable(hits, func(a, b int) bool {
		if hits[a].Line != hits[b].Line {
			return hits[a].Line < hits[b].Line
		}
		return hits[a].Construct < hits[b].Construct
	})
	return hits
}

// Findings is the scan as findings for one document: `warning` severity, the
// repository-relative path the export carries it at, the opening line, and the token.
func Findings(relPath, text string) []findings.Finding {
	var out []findings.Finding
	for _, hit := range ScanRenderConstructs(text) {
		out = append(out, findings.Finding{
			Rule:      RenderUnsupportedRule,
			Severity:  findings.Warning,
			Path:      relPath,
			HasPath:   true,
			Line:      hit.Line,
			Construct: hit.Construct,
			Message:   Message(hit.Construct),
		})
	}
	return out
}
