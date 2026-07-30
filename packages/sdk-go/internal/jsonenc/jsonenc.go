// Package jsonenc marshals JSON byte-identically to Node's JSON.stringify and
// Python's json.dumps(ensure_ascii=False), which Go's encoding/json does not:
// it escapes <, >, and & unless told otherwise, and escapes U+2028 and U+2029
// even then. Strings are therefore encoded here rather than delegated.
package jsonenc

import (
	"bytes"
	"encoding/json"
	"strconv"
)

// Marshal is like json.Marshal for the value kinds we serialize (strings,
// numbers, bools, null), with Node's escaping rules.
func Marshal(v any) ([]byte, error) {
	if s, ok := v.(string); ok {
		return encodeString(s), nil
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	// Encoder.Encode appends a trailing newline; trim it to match json.Marshal.
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// encodeString reproduces JSON.stringify's string escaping exactly: the two
// mandatory escapes, the five short forms, \u00xx for every other C0 control,
// and raw UTF-8 for everything else (U+2028, U+2029 and the private-use area
// included). Invalid UTF-8 decodes to U+FFFD, as it does in every runtime that
// reads the same bytes into a string.
func encodeString(s string) []byte {
	var b bytes.Buffer
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				b.WriteString(`\u`)
				hex := strconv.FormatInt(int64(r), 16)
				b.WriteString("0000"[len(hex):])
				b.WriteString(hex)
				continue
			}
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.Bytes()
}
