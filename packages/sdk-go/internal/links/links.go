// Package links is the in-layer link scan: given one markdown document, the link
// destinations in it and, for each, whether it resolves to something the layer
// actually carries. The Node SDK's lib/links.ts is the executable contract this port
// follows, so the grammar is stated there and here in the order it is applied.
//
// Only prose is scanned (renderlint.ProseRegions), so a destination inside a fenced
// block, a code span, or the frontmatter is text rather than a link. Within prose:
//
//	link   := "!"? "[" label "]" "(" dest title? ")"
//	refdef := line-start(<= 3 spaces) "[" label "]" ":" spaces dest (spaces title)? line-end
//	label  := any run up to the first unescaped "]"
//	dest   := "<" any run without "<", ">" or a newline ">"      (the brackets are stripped)
//	        | run
//	run    := ( "\" punctuation | "(" run ")" | not(space, tab, newline, "(", ")") )+
//	title  := '"' no-newline '"' | "'" no-newline "'" | "(" no-newline ")"
//
// `](` is one token: a link whose bracket and parenthesis are split across a line
// break is not a link, and neither is one whose destination carries a newline. The
// parentheses in a bare destination nest exactly one level (dir/(x).md), the title is
// read only to find the closing `)` and is then discarded, and autolinks and raw HTML
// are not links at all: <a href> is outside the rendering subset, and an autolink is
// a URL, which this rule never judges.
package links

import (
	"net/url"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/renderlint"
)

// UnresolvedRule is the one rule this scan produces.
const UnresolvedRule = "link-unresolved"

// Message is the shared message template. Identical bytes in all three SDKs by
// convention, outside the fixture contract by design.
//
// The target is interpolated VERBATIM, never Go-quoted: %q would escape a backslash,
// a quote or a control character the other two SDKs pass through, so a destination
// such as `missing\name.md` would read differently here than in the Node and Python
// CLIs, in both the text and the JSON surface.
func Message(target string) string {
	return `link target "` + target + `" does not resolve`
}

// ScannedLink is one link found in a document: the destination exactly as written
// (the angle brackets of the <...> form excepted, which are delimiters), and the
// 1-based line the link opens on.
type ScannedLink struct {
	Target string
	Line   int
}

var (
	// A URI scheme, which is what makes a destination somebody else's to resolve:
	// https:, mailto:, data: and every other.
	scheme = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*:`)
	// A reference definition's opening: a label carrying no bracket of its own, and
	// the colon. Its position on the line is checked by the scan, which knows where
	// the line began; the indent a definition may carry is up to three spaces.
	referenceOpen = regexp.MustCompile(`^\[[^\]\n]+\]:[ \t]*`)
)

// span is a destination as written, and the offset just past it.
type span struct {
	target string
	end    int
}

func isSpace(text string, i int) bool {
	return i < len(text) && (text[i] == ' ' || text[i] == '\t')
}

// skipSpaces is the offset just past the run of spaces and tabs at i.
func skipSpaces(text string, i int) int {
	j := i
	for isSpace(text, j) {
		j++
	}
	return j
}

func escaped(text string, i int) bool {
	return text[i] == '\\' && i+1 < len(text) && renderlint.Escapable(text[i+1])
}

// destinationAt is a destination at i, as written, and the offset just past it; not
// ok when none can be read there — an empty run, an unterminated angle form, a
// newline inside either, or parentheses nested past the one level a destination may
// carry.
func destinationAt(text string, i int) (span, bool) {
	if i < len(text) && text[i] == '<' {
		for j := i + 1; j < len(text); {
			if escaped(text, j) {
				j += 2
				continue
			}
			if text[j] == '\n' || text[j] == '<' {
				return span{}, false
			}
			if text[j] == '>' {
				return span{target: text[i+1 : j], end: j + 1}, true
			}
			j++
		}
		return span{}, false
	}
	j, depth := i, 0
	for j < len(text) {
		if escaped(text, j) {
			j += 2
			continue
		}
		c := text[j]
		if c == '\n' || c == ' ' || c == '\t' {
			break
		}
		if c == '(' {
			if depth == 1 {
				return span{}, false
			}
			depth++
		} else if c == ')' {
			if depth == 0 {
				break
			}
			depth--
		}
		j++
	}
	if depth != 0 || j == i {
		return span{}, false
	}
	return span{target: text[i:j], end: j}, true
}

// titleEnd is the offset just past a title at i, or -1 when none stands there.
func titleEnd(text string, i int) int {
	if i >= len(text) {
		return -1
	}
	opener := text[i]
	if opener != '"' && opener != '\'' && opener != '(' {
		return -1
	}
	closer := opener
	if opener == '(' {
		closer = ')'
	}
	for j := i + 1; j < len(text); {
		if escaped(text, j) {
			j += 2
			continue
		}
		if text[j] == '\n' {
			return -1
		}
		if text[j] == closer {
			return j + 1
		}
		j++
	}
	return -1
}

// inlineCloseAt is the offset just past the optional title and the `)` closing an
// inline link at i, or -1 when the link does not close there.
func inlineCloseAt(text string, i int) int {
	j := skipSpaces(text, i)
	if j > i {
		if t := titleEnd(text, j); t != -1 {
			j = skipSpaces(text, t)
		}
	}
	if j < len(text) && text[j] == ')' {
		return j + 1
	}
	return -1
}

// labelEnd is the offset just past the unescaped `]` closing a label opened at i, or
// -1.
func labelEnd(text string, i int) int {
	for j := i + 1; j < len(text); {
		if escaped(text, j) {
			j += 2
			continue
		}
		if text[j] == ']' {
			return j + 1
		}
		j++
	}
	return -1
}

// inlineLinkAt is an inline link (or image) opening at the `[` at i: its destination
// and the offset just past the whole construct, or not ok when nothing there is a
// link.
func inlineLinkAt(text string, i int) (span, bool) {
	label := labelEnd(text, i)
	if label == -1 || label >= len(text) || text[label] != '(' {
		return span{}, false
	}
	dest, ok := destinationAt(text, label+1)
	if !ok {
		return span{}, false
	}
	end := inlineCloseAt(text, dest.end)
	if end == -1 {
		return span{}, false
	}
	return span{target: dest.target, end: end}, true
}

// referenceDefinitionAt is a reference definition opening at i, which is known to be
// a line start: its destination and the offset just past the line, or not ok. The
// remainder of the line must be empty or one title — `[^1]: a footnote's prose` is
// neither, and is prose.
func referenceDefinitionAt(text string, i int) (span, bool) {
	line := text[i:]
	if newline := strings.IndexByte(line, '\n'); newline != -1 {
		line = line[:newline]
	}
	open := referenceOpen.FindString(line)
	if open == "" {
		return span{}, false
	}
	dest, ok := destinationAt(text, i+len(open))
	if !ok {
		return span{}, false
	}
	j := skipSpaces(text, dest.end)
	if j > dest.end {
		if t := titleEnd(text, j); t != -1 {
			j = skipSpaces(text, t)
		}
	}
	if j != i+len(line) {
		return span{}, false
	}
	return span{target: dest.target, end: j}, true
}

// atLineStart reports whether everything between the line's start and i is the up to
// three spaces a reference definition may be indented by.
func atLineStart(body string, lineStart, i int) bool {
	if lineStart == -1 || i-lineStart > 3 {
		return false
	}
	return strings.Trim(body[lineStart:i], " ") == ""
}

// ScanLinks is every link destination in one markdown document, in document order.
func ScanLinks(text string) []ScannedLink {
	var out []ScannedLink
	for _, region := range renderlint.ProseRegions(text) {
		body := region.Text
		line := region.Line
		// Where the current line began, or -1 while the region resumes one that
		// started outside it (after a code span), where no definition can open.
		lineStart := 0
		if region.Column != 0 {
			lineStart = -1
		}
		for i := 0; i < len(body); {
			if body[i] == '[' {
				found, ok := span{}, false
				if atLineStart(body, lineStart, i) {
					found, ok = referenceDefinitionAt(body, i)
				}
				// A label at a line start that no definition closes may still open an
				// inline link, so both forms are tried at the same bracket.
				if !ok {
					found, ok = inlineLinkAt(body, i)
				}
				if ok {
					out = append(out, ScannedLink{Target: found.target, Line: line})
					for k := i; k < found.end; k++ {
						if body[k] == '\n' {
							line++
							lineStart = k + 1
						}
					}
					i = found.end
					continue
				}
			}
			if body[i] == '\n' {
				line++
				lineStart = i + 1
			}
			i++
		}
	}
	return out
}

// unescapeMarkdown removes markdown backslash escapes: `\(` is a literal `(` on
// disk, and the generated links the viewer emits carry that spelling. Only ASCII
// punctuation is escapable, so every other backslash is itself a character of the
// path.
func unescapeMarkdown(target string) string {
	var b strings.Builder
	for i := 0; i < len(target); {
		if escaped(target, i) {
			b.WriteByte(target[i+1])
			i += 2
			continue
		}
		b.WriteByte(target[i])
		i++
	}
	return b.String()
}

// ResolveTarget is the absolute path a destination points at, or not ok when this
// rule does not judge it: a URI scheme (mailto: and data: included), a bare fragment,
// or an empty destination. A leading `/` resolves against the layer's rootPath, which
// is how the viewer resolves one; everything else resolves against the linking
// document's own directory. Escapes come off first, then #fragment and ?query, then
// percent-encoding — an undecodable target stays as written rather than being
// dropped, so a mistyped escape is reported rather than silently passed.
func ResolveTarget(rootAbs, layerRootAbs, fromRelPath, target string) (string, bool) {
	if target == "" || strings.HasPrefix(target, "#") || scheme.MatchString(target) {
		return "", false
	}
	cleaned := unescapeMarkdown(target)
	if cut := strings.IndexByte(cleaned, '#'); cut != -1 {
		cleaned = cleaned[:cut]
	}
	if cut := strings.IndexByte(cleaned, '?'); cut != -1 {
		cleaned = cleaned[:cut]
	}
	if cleaned == "" {
		return "", false
	}
	// Judge the target exactly as it was written when it is not valid
	// percent-encoding, which is what the other two runtimes' decoders do. The UTF-8
	// test is part of that: `%FF` decodes to a byte no text runtime accepts, so no
	// SDK may resolve it.
	if decoded, err := url.PathUnescape(cleaned); err == nil && utf8.ValidString(decoded) {
		cleaned = decoded
	}
	if strings.HasPrefix(cleaned, "/") {
		return filepath.Join(layerRootAbs, filepath.FromSlash(cleaned)), true
	}
	return filepath.Join(rootAbs, filepath.FromSlash(path.Dir(fromRelPath)), filepath.FromSlash(cleaned)), true
}

// targetResolves reports whether the path answers: a directory resolves only when it
// carries a README.md (nothing else tells a reader which document the directory
// stands for); a file of any kind resolves by existing, a dangling symlink therefore
// not at all.
//
// The README is a SECOND target, so it is contained before it is examined, by the
// same rule and the same realpath-aware primitive the directory itself passed: a
// directory inside the layer whose README.md links out of it stands for a document
// this layer does not carry, and no existence test may be the first thing to touch an
// outside-root path.
func targetResolves(rootAbs, abs string) bool {
	if !fsx.IsDir(abs) {
		return fsx.Exists(abs)
	}
	readme := filepath.Join(abs, "README.md")
	return fsx.ResolvedWithinRoot(rootAbs, readme) && fsx.IsFile(readme)
}

// Findings is the scan as findings for one governed document. Containment is checked
// before existence and with the same realpath-aware primitive the write guards use,
// so a target reaching outside the layer — by `..`, or through a symlink inside it —
// is unresolved whether or not something happens to sit there.
func Findings(rootAbs, layerRootAbs, relPath, text string) []findings.Finding {
	var out []findings.Finding
	for _, link := range ScanLinks(text) {
		abs, ok := ResolveTarget(rootAbs, layerRootAbs, relPath, link.Target)
		if !ok {
			continue
		}
		if fsx.ResolvedWithinRoot(rootAbs, abs) && targetResolves(rootAbs, abs) {
			continue
		}
		f := findings.New(UnresolvedRule, findings.Error, Message(link.Target), relPath)
		f.Line = link.Line
		f.Construct = link.Target
		out = append(out, f)
	}
	return out
}
