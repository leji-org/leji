package changelog

import (
	"bytes"
	"sort"

	"github.com/leji-org/leji/packages/sdk-go/internal/jsonenc"
)

// entryKeyOrder is the schema field order for a serialized changelog entry,
// mirrored across the SDKs.
var entryKeyOrder = []string{
	"id", "date", "type", "summary", "paths", "categories",
	"decisionRefs", "proposedBy", "approvedBy", "breaking", "compacted",
}

// orderedEntry returns the (key, value) pairs of an entry in schema order, then
// any remaining keys sorted, so no data is dropped on a re-serialize.
func orderedEntry(e entry) [][2]any {
	var out [][2]any
	seen := map[string]bool{}
	for _, k := range entryKeyOrder {
		if v, ok := e[k]; ok && v != nil {
			out = append(out, [2]any{k, v})
			seen[k] = true
		}
	}
	rest := make([]string, 0, len(e))
	for k := range e {
		if !seen[k] {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	for _, k := range rest {
		if v := e[k]; v != nil {
			out = append(out, [2]any{k, v})
		}
	}
	return out
}

// serializeChangelog emits a changelog with stable key order, 2-space indent, and
// a trailing newline, matching JSON.stringify(_, null, 2)+"\n": $schema first (if
// present), then schemaVersion (defaulting to "1.0"), then any other top-level
// keys sorted, then entries.
func serializeChangelog(log map[string]any) string {
	var pairs [][2]any
	if v, ok := log["$schema"]; ok && v != nil {
		pairs = append(pairs, [2]any{"$schema", v})
	}
	sv := log["schemaVersion"]
	if sv == nil {
		sv = "1.0"
	}
	pairs = append(pairs, [2]any{"schemaVersion", sv})

	rest := make([]string, 0, len(log))
	for k := range log {
		if k == "$schema" || k == "schemaVersion" || k == "entries" {
			continue
		}
		rest = append(rest, k)
	}
	sort.Strings(rest)
	for _, k := range rest {
		pairs = append(pairs, [2]any{k, log[k]})
	}

	rawEntries, _ := log["entries"].([]entry)
	entriesVal := make([]any, 0, len(rawEntries))
	for _, e := range rawEntries {
		entriesVal = append(entriesVal, orderedEntry(e))
	}
	pairs = append(pairs, [2]any{"entries", entriesVal})

	var buf bytes.Buffer
	writeObject(&buf, pairs, "", "  ")
	buf.WriteByte('\n')
	return buf.String()
}

// writeObject encodes an ordered list of key/value pairs as an indented JSON
// object. An [][2]any value is itself treated as an ordered object.
func writeObject(buf *bytes.Buffer, pairs [][2]any, prefix, indent string) {
	if len(pairs) == 0 {
		buf.WriteString("{}")
		return
	}
	buf.WriteString("{\n")
	inner := prefix + indent
	for i, kv := range pairs {
		buf.WriteString(inner)
		kb, _ := jsonenc.Marshal(kv[0])
		buf.Write(kb)
		buf.WriteString(": ")
		writeValue(buf, kv[1], inner, indent)
		if i < len(pairs)-1 {
			buf.WriteByte(',')
		}
		buf.WriteByte('\n')
	}
	buf.WriteString(prefix)
	buf.WriteByte('}')
}

func writeValue(buf *bytes.Buffer, value any, prefix, indent string) {
	switch v := value.(type) {
	case [][2]any:
		writeObject(buf, v, prefix, indent)
	case map[string]any:
		// A nested object whose key order is not load-bearing: sort for determinism.
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		pairs := make([][2]any, 0, len(keys))
		for _, k := range keys {
			pairs = append(pairs, [2]any{k, v[k]})
		}
		writeObject(buf, pairs, prefix, indent)
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
