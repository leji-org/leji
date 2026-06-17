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
// Body is the document after the block, Error is set when the block exists but
// is invalid.
type Frontmatter struct {
	Data  map[string]any
	Body  string
	Error string
}

var fence = regexp.MustCompile(`\r?\n---[ \t]*\r?\n`)

// Parse extracts the frontmatter block from a markdown document.
func Parse(text string) Frontmatter {
	if !strings.HasPrefix(text, "---\n") && !strings.HasPrefix(text, "---\r\n") {
		return Frontmatter{Data: nil, Body: text}
	}
	loc := fence.FindStringIndex(text[3:])
	if loc == nil {
		return Frontmatter{Data: nil, Body: text, Error: "unterminated frontmatter block"}
	}
	raw := text[3 : 3+loc[0]+1]
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
	return Frontmatter{Data: m, Body: body}
}

var boolRe = regexp.MustCompile(`^(?:true|True|TRUE|false|False|FALSE)$`)
var intRe = regexp.MustCompile(`^[-+]?[0-9]+$`)
var octRe = regexp.MustCompile(`^0o[0-7]+$`)
var hexRe = regexp.MustCompile(`^0x[0-9a-fA-F]+$`)
var floatRe = regexp.MustCompile(`^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$`)

// convert walks a yaml.Node into Go values applying YAML 1.2 core scalar
// resolution (no yes/no/on/off booleans, no timestamp coercion).
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
