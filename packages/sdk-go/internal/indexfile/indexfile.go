// Package indexfile parses a category index file's `leji-index` fenced blocks
// (one or more per file). The dependency-free mini-format lets all three SDKs
// parse it identically:
//
//	```leji-index
//	- path: docs/invariants.md          # a single file
//	- path: docs/Wood-Badge/            # a whole directory (recursed)
//	```
//
// The fence info string carries the block's kind. Exactly three forms are
// valid: `leji-index` (intent, the default), `leji-index intent`, and
// `leji-index record`. Any other token after `leji-index` is a targeted parse
// error, never silently ignored: the grammar is finite by design.
//
// An entry is exactly `- path: <repo-relative-posix-path>` with an optional
// trailing ` # comment` (the `#` must be whitespace-preceded, so a `#` inside a
// path is kept). Blank lines and full-line `#` comments are ignored; no quoting,
// nesting, or extra keys. Resolution (directory vs .md file) happens in the layer.
//
// Whitespace anywhere in this grammar is ASCII space or tab, and nothing else, and a
// leading UTF-8 byte order mark is stripped before parsing. The three runtimes' own
// whitespace classes disagree (U+0085, U+00A0, U+FEFF), so a grammar spelled in them
// is not one grammar; see ScanFencedBlocks.
package indexfile

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/leji-org/leji/packages/sdk-go/internal/jsonenc"
)

// A document's kind: maintained present truth ("intent"), or dated
// evidence ("record").
const (
	KindIntent = "intent"
	KindRecord = "record"
)

// Entry is one resolved `- path:` line.
type Entry struct {
	Path string
	// Kind is the block's declared kind ("intent" when the fence carries none).
	Kind string
}

// Parsed is the result of parsing an index file: entries plus any per-line errors.
type Parsed struct {
	Entries []Entry
	Errors  []string
}

var (
	// fenceClose is ASCII-only fence recognition: indent and padding are space and
	// tab, nothing else.
	fenceClose = regexp.MustCompile("^[ \t]*`{3,}[ \t]*$")
	// entryRe is an entry line on the same ASCII alphabet: `\s` is a different set
	// of characters in JavaScript, Go's regexp, and Python's re, and a grammar three
	// SDKs parse cannot be spelled in a class they disagree about.
	entryRe = regexp.MustCompile(`^-[ \t]+path:[ \t]+(.*)$`)
	// hashRe opens a trailing comment on a whitespace-preceded `#`, whitespace again
	// meaning space or tab and nothing else, so a `#` inside a path is kept.
	hashRe   = regexp.MustCompile(`[ \t]#`)
	dotDotRe = regexp.MustCompile(`(^|/)\.\.(/|$)`)
)

// bom is U+FEFF as a leading string: a UTF-8 byte order mark, decoded.
const bom = "\ufeff"

// StripASCIIPad strips leading and trailing ASCII space/tab, and nothing else.
// The one padding rule every grammar frozen on the ASCII alphabet uses, scanner
// and parser alike.
func StripASCIIPad(s string) string {
	return strings.Trim(s, " \t")
}

// BlockLine is one body line of a fenced block, verbatim, with its 1-based line number.
type BlockLine struct {
	Text string
	Line int
}

// FencedBlock is one fenced block a scan found: its info-string remainder and its
// body. HasToken distinguishes an absent remainder from an empty one, mirroring
// the TS `token?: string`.
type FencedBlock struct {
	// Token is the complete padding-stripped remainder of the info string, when it
	// carries anything. A fence opens on the tag alone and whatever follows it is
	// handed to the grammar to accept or reject, so a fence carrying junk is a
	// reportable block rather than a silently ignored one.
	Token    string
	HasToken bool
	// OpenLine is the 1-based line number of the opening fence.
	OpenLine int
	// Lines are the body lines verbatim (never trimmed).
	Lines []BlockLine
}

// FenceScan is every block a scan found, plus whether one ran to end of file with
// no closing fence.
type FenceScan struct {
	Blocks       []FencedBlock
	Unterminated bool
}

// ScanFencedBlocks scans every fenced block whose info string names `tag`, in
// document order.
//
// One scanner for every leji block grammar (`leji-index` here, `leji-mounts` in the
// boot profile), so backtick counts, an optional info remainder, closing fences,
// unclosed fences, and a block nested inside a longer markdown example all behave
// identically wherever a block grammar is added. The scan is line based and markdown
// structure blind by design: a `leji-index` fence inside a four-backtick example
// block is a real block, in this scanner and in the Node and Python ports.
//
// Lines split on LF with a trailing CR stripped (CRLF tolerated). `tag` is a fixed
// literal supplied by the caller, never user input.
//
// The whitespace alphabet is ASCII space and tab, scanned explicitly, and it is the
// porting contract. JavaScript's `\s` and `trim`, Python's `strip` and `re`, and Go's
// `unicode.IsSpace` and `regexp` disagree about characters like U+0085 and U+00A0, so
// a literal port of a `\s` scanner can disagree about whether a fence is even there:
// a U+00A0 before a closing fence, or a BOM before an opening one, used to decide the
// answer differently in each SDK. A fence opens on the tag followed by end of line or
// by whitespace, and the whole remainder goes to the grammar. The tag boundary is
// respected either way: `leji-mountsx` names a different tag and opens nothing.
//
// A leading UTF-8 byte order mark is stripped first, identically everywhere. It can
// only ever precede the first line, and letting it decide whether that line is a
// fence is the same portability hazard one character further left.
func ScanFencedBlocks(text, tag string) FenceScan {
	open := regexp.MustCompile("(?s)^[ \t]*`{3,}[ \t]*" + tag + "([ \t].*)?$")
	var blocks []FencedBlock
	lines := splitLines(strings.TrimPrefix(text, bom))
	current := -1
	for i, line := range lines {
		if current < 0 {
			m := open.FindStringSubmatch(line)
			if m == nil {
				continue
			}
			// The captured remainder is a token only once its padding is off.
			block := FencedBlock{OpenLine: i + 1}
			if rest := StripASCIIPad(m[1]); rest != "" {
				block.Token, block.HasToken = rest, true
			}
			blocks = append(blocks, block)
			current = len(blocks) - 1
			continue
		}
		if fenceClose.MatchString(line) {
			current = -1
			continue
		}
		blocks[current].Lines = append(blocks[current].Lines, BlockLine{Text: line, Line: i + 1})
	}
	return FenceScan{Blocks: blocks, Unterminated: current >= 0}
}

// quoteJSON renders s exactly as Node's JSON.stringify(s) would, so the
// unparseable-entry message is byte-identical across the SDKs.
func quoteJSON(s string) string {
	b, _ := jsonenc.Marshal(s)
	return string(b)
}

// Parse parses every `leji-index` block in an index file's markdown text.
// Multiple blocks are concatenated in document order (matching Node/Python), so a
// file may group entries under several prose headings, each entry carrying its
// block's kind.
func Parse(text string) Parsed {
	var entries []Entry
	var errs []string
	seen := map[string]bool{}
	scan := ScanFencedBlocks(text, "leji-index")

	for _, block := range scan.Blocks {
		// The kind token is validated here rather than in the scanner, so an unknown
		// token is a targeted error and the block is still consumed (its entries must
		// not fall back to parsing as prose).
		blockKind := KindIntent
		if block.HasToken && block.Token != KindIntent && block.Token != KindRecord {
			errs = append(errs, fmt.Sprintf("line %d: unknown leji-index block kind \"%s\" (expected intent or record)", block.OpenLine, block.Token))
		} else if block.Token == KindRecord {
			blockKind = KindRecord
		}
		for _, bl := range block.Lines {
			// Every padding rule inside a block is the scanner's ASCII alphabet too, so
			// one U+00A0 cannot make an entry parse in one SDK and not in another.
			trimmed := StripASCIIPad(bl.Text)
			if trimmed == "" || strings.HasPrefix(trimmed, "#") {
				continue
			}
			m := entryRe.FindStringSubmatch(trimmed)
			if m == nil {
				errs = append(errs, fmt.Sprintf("line %d: unparseable entry %s (expected \"- path: <path>\")", bl.Line, quoteJSON(bl.Text)))
				continue
			}
			// Strip a trailing comment only when the `#` is whitespace-preceded, so a
			// `#` that is part of the path itself is kept.
			p := m[1]
			if loc := hashRe.FindStringIndex(p); loc != nil {
				p = p[:loc[0]]
			}
			p = StripASCIIPad(p)
			if p == "" {
				errs = append(errs, fmt.Sprintf("line %d: empty path", bl.Line))
				continue
			}
			// The path is interpolated raw between literal quotes, not %q: Node and
			// Python interpolate it too, and %q would escape the backslash that is
			// itself one of the rejection triggers below.
			if strings.HasPrefix(p, "/") || dotDotRe.MatchString(p) || strings.Contains(p, "\\") {
				errs = append(errs, fmt.Sprintf("line %d: invalid path \"%s\" (must be a repository-relative POSIX path)", bl.Line, p))
				continue
			}
			if seen[p] {
				errs = append(errs, fmt.Sprintf("line %d: duplicate path \"%s\"", bl.Line, p))
				continue
			}
			seen[p] = true
			entries = append(entries, Entry{Path: p, Kind: blockKind})
		}
	}

	if scan.Unterminated {
		errs = append(errs, "unterminated leji-index block (no closing fence)")
	}
	if len(scan.Blocks) == 0 {
		errs = append(errs, "no leji-index block found in this index file")
	}
	return Parsed{Entries: entries, Errors: errs}
}

// splitLines splits on \r?\n, mirroring JS text.split(/\r?\n/).
func splitLines(text string) []string {
	normalized := strings.ReplaceAll(text, "\r\n", "\n")
	return strings.Split(normalized, "\n")
}
