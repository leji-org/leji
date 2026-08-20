package manifest

// The mount pin span. Mirrors lib/manifest.ts.
//
// `leji mounts update-pin` moves one declared pin. The agent edits in manifest.go
// anchor on the canonical two-space layout, which the manifest schema does not
// require, so a pin move gets a lexical scanner instead: it walks the document as
// JSON tokens, finds `federation.mounts[i]` whose `name` equals the addressed
// mount, and returns the byte span of THAT object's `pin` string value. Only that
// span is replaced. Nothing is reserialized or normalized, so field order,
// indentation, line endings, escapes, unmodeled keys, and every other byte of the
// file survive untouched.

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/leji-org/leji/packages/sdk-go/internal/jsonenc"
)

// pinScanError is a lexical failure: the document is not shaped the way a manifest
// is. Callers turn it into the same "cannot locate" refusal as a missing mount,
// because both mean the same thing operationally — this text has no such pin to
// move.
type pinScanError struct{ msg string }

func (e pinScanError) Error() string { return e.msg }

// pinAmbiguityError is a duplicate key on the path to the pin. JSON does not forbid
// one, and the two readers of this document disagree about which wins: a lexical
// scan takes the FIRST member, a parser keeps the LAST. So a manifest carrying two
// `pin` keys on the addressed mount could have its first span rewritten while the
// pin every parser reads stays exactly as it was — a reported change that changed
// nothing. The scanner refuses that document instead of picking a winner, and this
// error carries its own message out rather than collapsing into "cannot locate".
type pinAmbiguityError struct{ msg string }

func (e pinAmbiguityError) Error() string { return e.msg }

// quoteJSONString renders s the way Node's JSON.stringify(s) does, which is how
// every message below spells a key or a name.
func quoteJSONString(s string) string {
	b, err := jsonenc.Marshal(s)
	if err != nil {
		return `"` + s + `"`
	}
	return string(b)
}

// jsonMember is one object member: its decoded key and the index of its value.
type jsonMember struct {
	key     string
	valueAt int
}

// uniqueMember returns the one member named key, or nil when there is none. Two or
// more is refused: every key this scanner reads sits on the path to the pin, so an
// ambiguous one makes the whole edit ambiguous.
func uniqueMember(members []jsonMember, key, where string) (*jsonMember, error) {
	var found *jsonMember
	for i := range members {
		if members[i].key != key {
			continue
		}
		if found != nil {
			return nil, pinAmbiguityError{fmt.Sprintf("duplicate key %s %s", quoteJSONString(key), where)}
		}
		found = &members[i]
	}
	return found, nil
}

// skipJSONWs returns the index of the first character at or after i that is not
// JSON whitespace.
func skipJSONWs(text string, i int) int {
	for i < len(text) && (text[i] == ' ' || text[i] == '\t' || text[i] == '\n' || text[i] == '\r') {
		i++
	}
	return i
}

// jsonString is one scanned JSON string: its decoded value (escapes resolved, for
// comparison only) and the span of its RAW contents between the quotes, which is
// the only thing an edit ever replaces.
type jsonString struct {
	value        string
	contentStart int
	end          int
}

// hexUnit reads the four hex digits of a \uXXXX escape at off.
func hexUnit(text string, off int) (rune, bool) {
	if off+4 > len(text) {
		return 0, false
	}
	v := 0
	for i := off; i < off+4; i++ {
		c := text[i]
		switch {
		case c >= '0' && c <= '9':
			v = v*16 + int(c-'0')
		case c >= 'a' && c <= 'f':
			v = v*16 + int(c-'a') + 10
		case c >= 'A' && c <= 'F':
			v = v*16 + int(c-'A') + 10
		default:
			return 0, false
		}
	}
	return rune(v), true
}

// scanJSONString scans one JSON string starting at the opening quote.
func scanJSONString(text string, i int) (jsonString, error) {
	if i >= len(text) || text[i] != '"' {
		return jsonString{}, pinScanError{"expected a string"}
	}
	contentStart := i + 1
	var out strings.Builder
	j := contentStart
	for j < len(text) {
		c := text[j]
		if c == '"' {
			return jsonString{value: out.String(), contentStart: contentStart, end: j + 1}, nil
		}
		if c != '\\' {
			out.WriteByte(c)
			j++
			continue
		}
		if j+1 >= len(text) {
			break
		}
		esc := text[j+1]
		j += 2
		switch esc {
		case '"', '\\', '/':
			out.WriteByte(esc)
		case 'b':
			out.WriteByte('\b')
		case 'f':
			out.WriteByte('\f')
		case 'n':
			out.WriteByte('\n')
		case 'r':
			out.WriteByte('\r')
		case 't':
			out.WriteByte('\t')
		case 'u':
			unit, ok := hexUnit(text, j)
			if !ok {
				return jsonString{}, pinScanError{`malformed \u escape`}
			}
			j += 4
			// A surrogate PAIR spelled as two escapes reassembles into its astral
			// character by the same rule the parser uses, so an escaped name compares
			// equal to a raw one. An unpaired surrogate cannot be carried in a Go
			// string, and decodes to U+FFFD exactly as every parser of these bytes
			// would give the caller.
			if utf16.IsSurrogate(unit) {
				if lo, ok := hexUnit(text, j+2); ok && j+1 < len(text) && text[j] == '\\' && text[j+1] == 'u' {
					if r := utf16.DecodeRune(unit, lo); r != utf8.RuneError {
						out.WriteRune(r)
						j += 6
						break
					}
				}
				out.WriteRune(utf8.RuneError)
				break
			}
			out.WriteRune(unit)
		default:
			return jsonString{}, pinScanError{"unknown escape"}
		}
	}
	return jsonString{}, pinScanError{"unterminated string"}
}

// skipJSONValue returns the index just past the value beginning at i, whatever it
// is. Objects and arrays are skipped STRUCTURALLY (nesting counted through their
// own members), so a `pin` key inside some unrelated nested object is never
// mistaken for a mount's.
func skipJSONValue(text string, i int) (int, error) {
	i = skipJSONWs(text, i)
	if i >= len(text) {
		return 0, pinScanError{"expected a value"}
	}
	c := text[i]
	if c == '"' {
		s, err := scanJSONString(text, i)
		if err != nil {
			return 0, err
		}
		return s.end, nil
	}
	if c == '{' || c == '[' {
		closer := byte('}')
		if c == '[' {
			closer = ']'
		}
		j := i + 1
		for {
			j = skipJSONWs(text, j)
			if j >= len(text) {
				return 0, pinScanError{"unterminated container"}
			}
			if text[j] == closer {
				return j + 1, nil
			}
			if text[j] == ',' || text[j] == ':' {
				j++
				continue
			}
			next, err := skipJSONValue(text, j)
			if err != nil {
				return 0, err
			}
			j = next
		}
	}
	// A literal or a number: everything up to the next structural character.
	j := i
	for j < len(text) && !strings.ContainsRune(" \t\n\r,}]", rune(text[j])) {
		j++
	}
	if j == i {
		return 0, pinScanError{"expected a value"}
	}
	return j, nil
}

// jsonMembers returns each member of the object beginning at i, as (decoded key,
// index of its value), plus the index just past the object.
func jsonMembers(text string, i int) ([]jsonMember, int, error) {
	i = skipJSONWs(text, i)
	if i >= len(text) || text[i] != '{' {
		return nil, 0, pinScanError{"expected an object"}
	}
	var members []jsonMember
	j := i + 1
	for {
		j = skipJSONWs(text, j)
		if j >= len(text) {
			return nil, 0, pinScanError{"unterminated object"}
		}
		if text[j] == '}' {
			return members, j + 1, nil
		}
		if text[j] == ',' {
			j++
			continue
		}
		key, err := scanJSONString(text, j)
		if err != nil {
			return nil, 0, err
		}
		j = skipJSONWs(text, key.end)
		if j >= len(text) || text[j] != ':' {
			return nil, 0, pinScanError{`expected ":"`}
		}
		valueAt := skipJSONWs(text, j+1)
		members = append(members, jsonMember{key: key.value, valueAt: valueAt})
		next, err := skipJSONValue(text, valueAt)
		if err != nil {
			return nil, 0, err
		}
		j = next
	}
}

// pinSpan is the raw span of a mount's `pin` value and the value it holds.
type pinSpan struct {
	value        string
	contentStart int
	contentEnd   int
}

// findMountPinSpan returns the raw span of `federation.mounts[i].pin` for the mount
// named name, with the value the span currently holds. found is false when there is
// no such mount, or no `pin` on it.
func findMountPinSpan(text, name string) (span pinSpan, found bool, err error) {
	rootMembers, _, err := jsonMembers(text, 0)
	if err != nil {
		return pinSpan{}, false, err
	}
	federation, err := uniqueMember(rootMembers, "federation", "in the manifest root")
	if err != nil || federation == nil {
		return pinSpan{}, false, err
	}
	federationMembers, _, err := jsonMembers(text, federation.valueAt)
	if err != nil {
		return pinSpan{}, false, err
	}
	mountsKey, err := uniqueMember(federationMembers, "mounts", `in "federation"`)
	if err != nil || mountsKey == nil {
		return pinSpan{}, false, err
	}
	i := skipJSONWs(text, mountsKey.valueAt)
	if i >= len(text) || text[i] != '[' {
		return pinSpan{}, false, pinScanError{"expected an array"}
	}
	i++
	for {
		i = skipJSONWs(text, i)
		if i >= len(text) {
			return pinSpan{}, false, pinScanError{"unterminated array"}
		}
		if text[i] == ']' {
			return pinSpan{}, false, nil
		}
		if text[i] == ',' {
			i++
			continue
		}
		if text[i] != '{' {
			next, err := skipJSONValue(text, i)
			if err != nil {
				return pinSpan{}, false, err
			}
			i = next
			continue
		}
		entryMembers, entryEnd, err := jsonMembers(text, i)
		if err != nil {
			return pinSpan{}, false, err
		}
		// A mount whose own name is ambiguous cannot be told apart from the addressed
		// one, so the document is refused before any element is matched.
		nameMember, err := uniqueMember(entryMembers, "name", "in a federation mount")
		if err != nil {
			return pinSpan{}, false, err
		}
		matched := false
		if nameMember != nil && nameMember.valueAt < len(text) && text[nameMember.valueAt] == '"' {
			s, err := scanJSONString(text, nameMember.valueAt)
			if err != nil {
				return pinSpan{}, false, err
			}
			matched = s.value == name
		}
		if matched {
			pinMember, err := uniqueMember(entryMembers, "pin", "in mount "+quoteJSONString(name))
			if err != nil {
				return pinSpan{}, false, err
			}
			if pinMember == nil {
				return pinSpan{}, false, nil
			}
			if pinMember.valueAt >= len(text) || text[pinMember.valueAt] != '"' {
				return pinSpan{}, false, pinScanError{"pin is not a string"}
			}
			pin, err := scanJSONString(text, pinMember.valueAt)
			if err != nil {
				return pinSpan{}, false, err
			}
			return pinSpan{value: pin.value, contentStart: pin.contentStart, contentEnd: pin.end - 1}, true, nil
		}
		i = entryEnd
	}
}

// ReplaceMountPinInManifestText moves one declared mount's pin, in place. `from` is
// what the span must currently hold — the value the comparison was computed against
// — so a manifest that moved underneath the run is refused rather than overwritten.
// Everything outside the pin value's own bytes is returned exactly as it came in.
//
// The error is returned when the pin cannot be located, or holds something other
// than `from`. Both are internal refusals after the manifest has already parsed and
// validated.
func ReplaceMountPinInManifestText(text, name, from, to string) (out string, changed bool, err error) {
	span, found, err := findMountPinSpan(text, name)
	if err != nil {
		// An ambiguous document is refused on its own terms; a merely malformed one
		// is the same answer as a mount that is not there.
		var ambiguity pinAmbiguityError
		if errors.As(err, &ambiguity) {
			return "", false, fmt.Errorf("%s: %s", Filename, ambiguity.msg)
		}
		var scan pinScanError
		if !errors.As(err, &scan) {
			return "", false, err
		}
		found = false
	}
	if !found {
		return "", false, fmt.Errorf("%s: cannot locate the pin of mount %s", Filename, quoteJSONString(name))
	}
	if span.value != from {
		return "", false, fmt.Errorf("%s: pin of mount %s is not %s", Filename, quoteJSONString(name), quoteJSONString(from))
	}
	if from == to {
		return text, false, nil
	}
	return text[:span.contentStart] + to + text[span.contentEnd:], true, nil
}
