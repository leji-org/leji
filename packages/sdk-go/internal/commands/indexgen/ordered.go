package indexgen

import (
	"bytes"
	"encoding/json"
)

// ordered is an insertion-ordered JSON object that encodes with a fixed key
// order and 2-space indentation, byte-compatible with JSON.stringify(_,null,2).
type ordered struct {
	keys   []string
	values map[string]any
}

func newOrdered() *ordered {
	return &ordered{values: map[string]any{}}
}

func (o *ordered) set(key string, value any) {
	if _, ok := o.values[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.values[key] = value
}

// encodeIndent writes the object as indented JSON. prefix is the current line
// prefix; indent is the per-level indent string.
func (o *ordered) encodeIndent(buf *bytes.Buffer, prefix, indent string) {
	if len(o.keys) == 0 {
		buf.WriteString("{}")
		return
	}
	buf.WriteString("{\n")
	inner := prefix + indent
	for i, k := range o.keys {
		buf.WriteString(inner)
		kb, _ := json.Marshal(k)
		buf.Write(kb)
		buf.WriteString(": ")
		writeValue(buf, o.values[k], inner, indent)
		if i < len(o.keys)-1 {
			buf.WriteByte(',')
		}
		buf.WriteByte('\n')
	}
	buf.WriteString(prefix)
	buf.WriteByte('}')
}

func writeValue(buf *bytes.Buffer, value any, prefix, indent string) {
	switch v := value.(type) {
	case *ordered:
		v.encodeIndent(buf, prefix, indent)
	case json.RawMessage:
		// Already-indented object; reindent by prefixing each newline.
		reindent(buf, v, prefix)
	case []json.RawMessage:
		if len(v) == 0 {
			buf.WriteString("[]")
			return
		}
		buf.WriteString("[\n")
		inner := prefix + indent
		for i, e := range v {
			buf.WriteString(inner)
			reindent(buf, e, inner)
			if i < len(v)-1 {
				buf.WriteByte(',')
			}
			buf.WriteByte('\n')
		}
		buf.WriteString(prefix)
		buf.WriteByte(']')
	case []string:
		if len(v) == 0 {
			buf.WriteString("[]")
			return
		}
		buf.WriteString("[\n")
		inner := prefix + indent
		for i, s := range v {
			buf.WriteString(inner)
			sb, _ := json.Marshal(s)
			buf.Write(sb)
			if i < len(v)-1 {
				buf.WriteByte(',')
			}
			buf.WriteByte('\n')
		}
		buf.WriteString(prefix)
		buf.WriteByte(']')
	default:
		b, _ := json.Marshal(v)
		buf.Write(b)
	}
}

// reindent writes already-rendered JSON, adding prefix after each newline so a
// nested block lines up under its parent.
func reindent(buf *bytes.Buffer, raw []byte, prefix string) {
	for i := 0; i < len(raw); i++ {
		buf.WriteByte(raw[i])
		if raw[i] == '\n' {
			buf.WriteString(prefix)
		}
	}
}
