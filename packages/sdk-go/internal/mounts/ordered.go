package mounts

import (
	"bytes"

	"github.com/leji-org/leji/packages/sdk-go/internal/jsonenc"
)

// ordered is an insertion-ordered JSON object, byte-compatible with
// JSON.stringify(_, null, 2).
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

func (o *ordered) encodeIndent(buf *bytes.Buffer, prefix, indent string) {
	if len(o.keys) == 0 {
		buf.WriteString("{}")
		return
	}
	buf.WriteString("{\n")
	inner := prefix + indent
	for i, k := range o.keys {
		buf.WriteString(inner)
		kb, _ := jsonenc.Marshal(k)
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
	case []any:
		if len(v) == 0 {
			buf.WriteString("[]")
			return
		}
		buf.WriteString("[\n")
		inner := prefix + indent
		for i, e := range v {
			buf.WriteString(inner)
			writeValue(buf, e, inner, indent)
			if i < len(v)-1 {
				buf.WriteByte(',')
			}
			buf.WriteByte('\n')
		}
		buf.WriteString(prefix)
		buf.WriteByte(']')
	default:
		b, _ := jsonenc.Marshal(v)
		buf.Write(b)
	}
}
