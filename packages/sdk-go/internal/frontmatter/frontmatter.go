// Package frontmatter extracts a leading YAML frontmatter block with YAML 1.2
// core scalar semantics, matching the Node `yaml` package and the Python
// _LejiLoader: unquoted dates stay strings, only true/false (any common
// casing) are booleans, and duplicate mapping keys are an error.
package frontmatter

import (
	"errors"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Frontmatter is the parsed result: Data is the YAML mapping (nil when absent),
// Body the document after the block, Error set when the block exists but is invalid.
// Keys carries the top-level mapping's authored key order, which a Go map does not:
// the effective profile an inheritance resolves to is presented in that order.
type Frontmatter struct {
	Data  map[string]any
	Keys  []string
	Body  string
	Error string
}

// Submatch 1 is the line terminator ending the block's last line; Parse slices by
// its length so a CRLF file's terminator is kept whole.
var fence = regexp.MustCompile(`(\r?\n)---[ \t]*\r?\n`)

// Parse extracts the frontmatter block from a markdown document.
func Parse(text string) Frontmatter {
	if !strings.HasPrefix(text, "---\n") && !strings.HasPrefix(text, "---\r\n") {
		return Frontmatter{Data: nil, Body: text}
	}
	loc := fence.FindStringSubmatchIndex(text[3:])
	if loc == nil {
		return Frontmatter{Data: nil, Body: text, Error: "unterminated frontmatter block"}
	}
	// loc[3] ends submatch 1, which starts at the match start: slicing to it keeps
	// the whole terminator. Taking a fixed single byte leaves a CRLF file's bare
	// `\r` in the raw YAML, which yaml.v3 tolerates but the Node SDK's parser folds
	// into the last scalar's value. All three SDKs hand their YAML library the same
	// bytes rather than relying on a given library's leniency.
	raw := text[3 : 3+loc[3]]
	body := text[3+loc[1]:]

	var root yaml.Node
	if err := yaml.Unmarshal([]byte(raw), &root); err != nil {
		first := strings.SplitN(err.Error(), "\n", 2)[0]
		return Frontmatter{Data: nil, Body: body, Error: "invalid YAML: " + first}
	}
	// An empty document yields a Node with no content.
	if root.Kind == 0 || len(root.Content) == 0 {
		return Frontmatter{Data: nil, Body: body, Error: "frontmatter is not a YAML mapping"}
	}
	val, err := convert(root.Content[0])
	if err != nil {
		first := strings.SplitN(err.Error(), "\n", 2)[0]
		return Frontmatter{Data: nil, Body: body, Error: "invalid YAML: " + first}
	}
	m, ok := val.(map[string]any)
	if !ok {
		return Frontmatter{Data: nil, Body: body, Error: "frontmatter is not a YAML mapping"}
	}
	return Frontmatter{Data: m, Keys: topLevelKeys(root.Content[0]), Body: body}
}

// topLevelKeys is the authored key order of the frontmatter mapping. Duplicate
// keys never reach here (convert rejects them), so the order is one key per pair.
func topLevelKeys(node *yaml.Node) []string {
	for node != nil && node.Kind == yaml.DocumentNode && len(node.Content) > 0 {
		node = node.Content[0]
	}
	if node == nil || node.Kind != yaml.MappingNode {
		return nil
	}
	keys := make([]string, 0, len(node.Content)/2)
	for i := 0; i+1 < len(node.Content); i += 2 {
		key, err := scalarKey(node.Content[i])
		if err != nil {
			return nil
		}
		keys = append(keys, key)
	}
	return keys
}

var boolRe = regexp.MustCompile(`^(?:true|True|TRUE|false|False|FALSE)$`)
var intRe = regexp.MustCompile(`^[-+]?[0-9]+$`)
var octRe = regexp.MustCompile(`^0o[0-7]+$`)
var hexRe = regexp.MustCompile(`^0x[0-9a-fA-F]+$`)
var floatRe = regexp.MustCompile(`^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$`)

// convert walks a yaml.Node into Go values under YAML 1.2 core scalar resolution
// (no yes/no/on/off booleans, no timestamp coercion).
func convert(node *yaml.Node) (any, error) {
	switch node.Kind {
	case yaml.DocumentNode:
		if len(node.Content) == 0 {
			return nil, nil
		}
		return convert(node.Content[0])
	case yaml.MappingNode:
		out := make(map[string]any, len(node.Content)/2)
		for i := 0; i < len(node.Content); i += 2 {
			keyNode := node.Content[i]
			valNode := node.Content[i+1]
			key, err := scalarKey(keyNode)
			if err != nil {
				return nil, err
			}
			if _, seen := out[key]; seen {
				return nil, errors.New("duplicate key: " + key)
			}
			v, err := convert(valNode)
			if err != nil {
				return nil, err
			}
			out[key] = v
		}
		return out, nil
	case yaml.SequenceNode:
		out := make([]any, 0, len(node.Content))
		for _, c := range node.Content {
			v, err := convert(c)
			if err != nil {
				return nil, err
			}
			out = append(out, v)
		}
		return out, nil
	case yaml.AliasNode:
		return convert(node.Alias)
	case yaml.ScalarNode:
		return scalar(node), nil
	default:
		return nil, nil
	}
}

func scalarKey(node *yaml.Node) (string, error) {
	v := scalar(node)
	switch t := v.(type) {
	case string:
		return t, nil
	case bool:
		if t {
			return "true", nil
		}
		return "false", nil
	case int64:
		return strconv.FormatInt(t, 10), nil
	case float64:
		return strconv.FormatFloat(t, 'g', -1, 64), nil
	case nil:
		return "null", nil
	default:
		return node.Value, nil
	}
}

// scalar resolves a scalar node under YAML 1.2 core rules. Quoted scalars
// (style != 0 with quote styles) are always strings.
func scalar(node *yaml.Node) any {
	// Explicit tags take precedence for the few cases yaml.v3 records.
	switch node.Tag {
	case "!!str":
		return node.Value
	case "!!null":
		return nil
	case "!!bool":
		// yaml.v3 may resolve yes/no here under 1.1; re-check under 1.2.
	}
	// Quoted or block scalars are strings verbatim.
	if node.Style == yaml.SingleQuotedStyle || node.Style == yaml.DoubleQuotedStyle ||
		node.Style == yaml.LiteralStyle || node.Style == yaml.FoldedStyle {
		return node.Value
	}
	val := node.Value
	switch val {
	case "", "~", "null", "Null", "NULL":
		return nil
	}
	if boolRe.MatchString(val) {
		return strings.EqualFold(val, "true")
	}
	if intRe.MatchString(val) {
		if n, err := strconv.ParseInt(val, 10, 64); err == nil {
			return n
		}
	}
	if octRe.MatchString(val) {
		if n, err := strconv.ParseInt(val[2:], 8, 64); err == nil {
			return n
		}
	}
	if hexRe.MatchString(val) {
		if n, err := strconv.ParseInt(val[2:], 16, 64); err == nil {
			return n
		}
	}
	if floatRe.MatchString(val) {
		if f, err := strconv.ParseFloat(val, 64); err == nil {
			return f
		}
	}
	switch val {
	case ".inf", ".Inf", ".INF", "+.inf", "+.Inf", "+.INF":
		// Leave as string; schema validation never needs infinities here.
		return val
	}
	return val
}
