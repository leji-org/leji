// Package jsonenc provides JSON marshaling that does not HTML-escape <, >, and
// &, so the JSON Leji writes to disk is byte-identical to the Node and Python
// SDKs. Node's JSON.stringify and Python's json.dumps emit these characters
// literally; Go's encoding/json escapes them by default (SetEscapeHTML(true)).
package jsonenc

import (
	"bytes"
	"encoding/json"
)

// Marshal is like json.Marshal but leaves <, >, and & unescaped. It mirrors
// JSON.stringify(value) / json.dumps(value) for the value kinds we serialize
// (strings, numbers, bools, null).
func Marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	// Encoder.Encode appends a trailing newline; trim it to match json.Marshal.
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}
