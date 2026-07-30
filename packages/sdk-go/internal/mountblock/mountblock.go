// Package mountblock parses a boot profile's `leji-mounts` blocks: the
// machine-checkable half of the federated-siblings requirement (spec
// `boot-profile.md`, requirement 9). Mirrors lib/mountblock.ts.
//
// A host that declares `federation.mounts` surfaces each sibling in its boot
// profile, in the author's task language, through a constrained block:
//
//	```leji-mounts
//	- mount: acme-product-context
//	  owner: Product team
//	  carries: product-side domain language and the decisions behind it
//	  read-when: a task touches product behavior, product terminology, or billing
//	```
//
// Grammar, frozen so the Go and Python ports parse it identically:
//
//   - Fence recognition is the shared `leji-index` scanner (indexfile.ScanFencedBlocks)
//     in its ASCII mode: three or more backticks, then the tag, then end of line or
//     whitespace and any remainder, and any closing fence of three or more backticks.
//     The info string is the tag ALONE, so a nonempty remainder (one token or
//     several) is an error naming it, never an ignored fence; a fence whose tag
//     merely prefixes another word (`leji-mountsx`) names a different grammar and
//     opens nothing. One or MORE blocks may appear anywhere in the document; their
//     entries concatenate in document order.
//   - Whitespace, everywhere in this grammar, is ASCII space (U+0020) and tab
//     (U+0009) and nothing else: fence indent, fence padding, the blank-line and
//     comment tests, and field indentation are all scanned with an explicit `[ \t]`
//     alphabet, never a runtime whitespace class. This is the porting contract:
//     JavaScript `trim`/`\s`, Python `strip`, and Go's `unicode.IsSpace` disagree on
//     characters such as U+0085 and U+00A0, so a `\s` port could disagree about
//     whether a fence or a field line is even there.
//   - A record begins at column 1 with `- mount: `; its fields are indented exactly
//     two ASCII spaces. Within a record `owner`, `carries`, and `read-when` each
//     appear exactly once, in any order. Unknown fields, duplicate fields, missing
//     fields, and misindented lines are errors.
//   - A value is the nonempty remainder of its physical line after the `key: `
//     prefix, with no leading or trailing space/tab and no control or line/paragraph
//     separator character (which is what makes a value single-line by construction).
//   - Blank lines and full lines starting `#` are ignored, matching `leji-index`.
//   - Errors are returned sorted by source line (stable within a line), so a reader
//     and every port see them in the order the file reads, not in the order the
//     parser happened to detect them (a record's missing-field errors are raised at
//     its closing boundary but belong to its `- mount:` line).
//   - Lines split on LF with a trailing CR stripped (CRLF tolerated); a CR anywhere
//     else lands inside a value and is rejected as a control character. File content
//     is UTF-8 (decoded by the reader before it reaches this parser).
//
// The parser reports grammar only. Whether an entry names a declared mount, and
// whether its owner matches the declaration, is the validator's cross-check
// against the manifest; the fidelity of `carries` and `read-when` to what the
// sibling actually holds is authored task language and is not machine-checked.
package mountblock

import (
	"regexp"
	"sort"
	"strings"

	"github.com/leji-org/leji/packages/sdk-go/internal/indexfile"
	"github.com/leji-org/leji/packages/sdk-go/internal/jsonenc"
)

// Entry is one surfaced sibling, as authored in the block.
type Entry struct {
	Mount    string
	Owner    string
	Carries  string
	ReadWhen string
	// Line is the 1-based line of the record's `- mount:` line, for diagnostics.
	Line int
}

// Error is one grammar error, pointing at a 1-based source line.
type Error struct {
	Line    int
	Message string
}

// Parsed is every block's entries concatenated in document order, the grammar
// errors sorted by source line (parsing never stops at the first), and whether the
// document carries at least one `leji-mounts` fence, empty or not.
type Parsed struct {
	Entries  []Entry
	Errors   []Error
	SawBlock bool
}

var (
	// `(?s)` so a stray CR (or any other line terminator a split on LF left behind)
	// is captured into the value and rejected there, rather than making the line
	// itself unparseable and reporting the wrong thing.
	recordRe = regexp.MustCompile(`(?s)^- mount: (.*)$`)
	fieldRe  = regexp.MustCompile(`(?s)^ {2}([^ \t:]+): (.*)$`)
	// fieldAnyRe matches any line that looks like a `key: value` field, whatever
	// its indentation.
	fieldAnyRe = regexp.MustCompile(`^[ \t]*[^ \t:]+: `)
	// controlRe matches C0 and C1 controls (CR, LF, and tab among them) plus the
	// Unicode line and paragraph separators. Splitting on these differs across
	// runtimes (Python's `splitlines` recognizes U+2028; JavaScript and Go do not),
	// so a value carrying one is rejected rather than parsed differently by each port.
	controlRe = regexp.MustCompile(`[\x00-\x1F\x{007F}-\x{009F}\x{2028}\x{2029}]`)
	padRe     = regexp.MustCompile("^[ \t]|[ \t]$")
)

var fields = []string{"owner", "carries", "read-when"}

// ValueRepresentationError is why a string cannot be carried as a block value, or
// "" when it can. Shared with the validator so a manifest identity the block could
// never express (an empty, padded, or multi-line `owner.name`) is reported against
// the manifest rather than surfacing as an unfixable mismatch.
func ValueRepresentationError(value string) string {
	if value == "" {
		return "the value is empty"
	}
	if padRe.MatchString(value) {
		return "the value has leading or trailing whitespace"
	}
	if controlRe.MatchString(value) {
		return "the value carries a control or line-separator character"
	}
	return ""
}

// quoteJSON renders s exactly as Node's JSON.stringify(s) would, so the
// unparseable-line message is byte-identical across the SDKs.
func quoteJSON(s string) string {
	b, _ := jsonenc.Marshal(s)
	return string(b)
}

// openRecord is the record currently being read: its name, where it started,
// whether it is still usable, and the fields seen so far.
type openRecord struct {
	mount  string
	line   int
	valid  bool
	fields map[string]string
}

// Parse parses every `leji-mounts` block in a boot profile.
func Parse(text string) Parsed {
	var entries []Entry
	var errs []Error
	scan := indexfile.ScanFencedBlocks(text, "leji-mounts")

	var open *openRecord
	closeRecord := func() {
		record := open
		if record == nil {
			return
		}
		open = nil
		for _, field := range fields {
			if _, ok := record.fields[field]; !ok {
				errs = append(errs, Error{Line: record.line,
					Message: "mount \"" + record.mount + "\" is missing the \"" + field + "\" field"})
				record.valid = false
			}
		}
		if record.valid {
			entries = append(entries, Entry{
				Mount:    record.mount,
				Owner:    record.fields["owner"],
				Carries:  record.fields["carries"],
				ReadWhen: record.fields["read-when"],
				Line:     record.line,
			})
		}
	}

	for _, block := range scan.Blocks {
		// The info string is the tag alone. Whatever follows it, one token or several,
		// arrives here as the block's remainder and is a targeted error naming it in
		// full; the block is consumed either way, so a typo never degrades to prose.
		if block.HasToken {
			errs = append(errs, Error{Line: block.OpenLine,
				Message: "the leji-mounts info string carries nothing after the tag, but this fence declares \"" + block.Token + "\""})
		}
		for _, bl := range block.Lines {
			raw, line := bl.Text, bl.Line
			trimmed := indexfile.StripASCIIPad(raw)
			if trimmed == "" || strings.HasPrefix(trimmed, "#") {
				continue
			}
			if record := recordRe.FindStringSubmatch(raw); record != nil {
				closeRecord()
				name := record[1]
				bad := ValueRepresentationError(name)
				if bad != "" {
					errs = append(errs, Error{Line: line, Message: "mount name is unusable: " + bad})
				}
				open = &openRecord{mount: name, line: line, valid: bad == "", fields: map[string]string{}}
				continue
			}
			if strings.HasPrefix(trimmed, "- mount:") {
				errs = append(errs, Error{Line: line,
					Message: `a "- mount:" record must start at column 1, followed by one space`})
				if open != nil {
					open.valid = false
				}
				continue
			}
			field := fieldRe.FindStringSubmatch(raw)
			if field == nil {
				message := "unparseable line " + quoteJSON(raw) + " (expected \"- mount: <name>\" or \"  <key>: <value>\")"
				if fieldAnyRe.MatchString(raw) {
					message = `a field line must be indented exactly two spaces, as "  <key>: <value>"`
				}
				errs = append(errs, Error{Line: line, Message: message})
				if open != nil {
					open.valid = false
				}
				continue
			}
			key, value := field[1], field[2]
			if open == nil {
				errs = append(errs, Error{Line: line,
					Message: "field \"" + key + "\" appears before any \"- mount:\" record"})
				continue
			}
			known := false
			for _, f := range fields {
				if f == key {
					known = true
					break
				}
			}
			if !known {
				errs = append(errs, Error{Line: line,
					Message: "mount \"" + open.mount + "\" carries the unknown field \"" + key + "\""})
				open.valid = false
				continue
			}
			if _, seen := open.fields[key]; seen {
				errs = append(errs, Error{Line: line,
					Message: "mount \"" + open.mount + "\" declares the \"" + key + "\" field twice"})
				open.valid = false
				continue
			}
			bad := ValueRepresentationError(value)
			if bad != "" {
				errs = append(errs, Error{Line: line,
					Message: "mount \"" + open.mount + "\" field \"" + key + "\" is unusable: " + bad})
				open.valid = false
				continue
			}
			open.fields[key] = value
		}
		// A block boundary closes the record it opened: records never span blocks.
		closeRecord()
	}

	if scan.Unterminated {
		errs = append(errs, Error{Line: scan.Blocks[len(scan.Blocks)-1].OpenLine,
			Message: "unterminated leji-mounts block (no closing fence)"})
	}
	// Source-line order, stable within a line (Array.prototype.sort is stable, as
	// are Go's SliceStable and Python's sorted, which the ports use).
	sort.SliceStable(errs, func(i, j int) bool { return errs[i].Line < errs[j].Line })
	return Parsed{Entries: entries, Errors: errs, SawBlock: len(scan.Blocks) > 0}
}
