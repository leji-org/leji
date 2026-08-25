// Package schemas loads the vendored JSON Schemas (draft 2020-12) and the
// cli.json surface, and validates data against a named schema, mirroring the
// Node (ajv2020) and Python (Draft202012Validator) SDKs.
package schemas

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dlclark/regexp2"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/santhosh-tekuri/jsonschema/v6/kind"
	"golang.org/x/text/language"
	"golang.org/x/text/message"

	"github.com/leji-org/leji/packages/sdk-go/internal/assets"
	"github.com/leji-org/leji/packages/sdk-go/internal/jsonenc"
)

// SupportedLines are the spec lines this SDK supports.
var SupportedLines = []string{"1.0"}

// SDKVersion is overridable via ldflags; defaults to match Node/Python.
var SDKVersion = "1.4.1"

type CliOption struct {
	Flags   string `json:"flags"`
	Summary string `json:"summary"`
}

// CliGroup is one display section of the command list, in the order help and the
// site show them.
type CliGroup struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// CliExitCode carries the code as a json.Number so help prints the literal the
// asset holds (`0`), never a float rendering of it.
type CliExitCode struct {
	Code    json.Number `json:"code"`
	Meaning string      `json:"meaning"`
}

type CliCommand struct {
	Name string `json:"name"`
	// Group is the CliGroup id this command is listed under; exactly one, and
	// always a declared id. AliasOf, when set, names the primary command this one
	// stands for, itself never an alias.
	Group       string      `json:"group"`
	AliasOf     string      `json:"aliasOf,omitempty"`
	Summary     string      `json:"summary"`
	Usage       string      `json:"usage"`
	Description string      `json:"description"`
	Details     []string    `json:"details,omitempty"`
	Options     []CliOption `json:"options"`
	Examples    []string    `json:"examples"`
}

type CliSpec struct {
	Name          string        `json:"name"`
	Summary       string        `json:"summary"`
	Usage         string        `json:"usage"`
	GlobalOptions []CliOption   `json:"globalOptions"`
	ExitCodes     []CliExitCode `json:"exitCodes"`
	Groups        []CliGroup    `json:"groups"`
	Commands      []CliCommand  `json:"commands"`
}

func LoadCliSpec() (CliSpec, error) {
	var spec CliSpec
	b, err := assets.FS.ReadFile("cli.json")
	if err != nil {
		return spec, err
	}
	if err := json.Unmarshal(b, &spec); err != nil {
		return spec, err
	}
	return spec, nil
}

var (
	mu        sync.Mutex
	compiled  = map[string]*jsonschema.Schema{}
	enPrinter = message.NewPrinter(language.English)
)

func getValidator(name string) (*jsonschema.Schema, error) {
	mu.Lock()
	defer mu.Unlock()
	if s, ok := compiled[name]; ok {
		return s, nil
	}
	raw, err := assets.FS.ReadFile("schemas/" + name + ".schema.json")
	if err != nil {
		return nil, err
	}
	doc, err := jsonschema.UnmarshalJSON(strings.NewReader(string(raw)))
	if err != nil {
		return nil, err
	}
	c := jsonschema.NewCompiler()
	// The Leji schemas use ECMAScript lookahead patterns (e.g. the relPath
	// guard `(?!/)(?!\./)...`). Go's RE2 rejects lookaheads, so use the same
	// ECMAScript regex engine semantics that ajv (Node) and Python jsonschema
	// rely on, via dlclark/regexp2.
	c.UseRegexpEngine(ecmaCompile)
	res := "mem://" + name + ".schema.json"
	if err := c.AddResource(res, doc); err != nil {
		return nil, err
	}
	s, err := c.Compile(res)
	if err != nil {
		return nil, err
	}
	compiled[name] = s
	return s, nil
}

// quoteJSON renders s exactly as Node's JSON.stringify(s) and Python's
// json.dumps(ensure_ascii=False) would, so a message naming a property, a pattern
// or an enum value is byte-identical across the SDKs.
func quoteJSON(v any) string {
	b, err := jsonenc.Marshal(v)
	if err != nil {
		return "null"
	}
	return string(b)
}

// plural agrees the count noun with the limit, so a bound of 1 does not read as
// "1 items". The limit is a schema constant, so the branch resolves identically in
// all three SDKs.
func plural(limit int, one, many string) string {
	if limit == 1 {
		return one
	}
	if many != "" {
		return many
	}
	return one + "s"
}

// normalizedMessage is the Leji sentence for a violation kind, or "" to fall back
// to the validator's own text.
//
// Three validators phrase and order the same violation differently (ajv, this one,
// and Python's jsonschema), and the parity harness compares stdout byte for byte, so
// any schema failure that reaches output has to be phrased here rather than passed
// through. The kinds covered are the ones the five shipped schemas can actually
// produce; anything else keeps the fallback, so a schema keyword added later degrades
// to un-normalized text instead of to a wrong sentence.
//
// The offending value never appears. A schema violation is about shape, and the path
// already tells a reader where to look; echoing authored bytes would push
// context-layer content into CI logs, pull-request comments, and the MCP tool
// response, which is exactly what the derived-surface rule
// (machine-readable-surface.md, Requirement 8) exists to prevent. Property names are
// the exception: an unexpected or missing key is the thing the reader has to act on,
// and the message is useless without it. Constraint operands come from the schema,
// not from the document, so they are always safe to name.
func normalizedMessage(k jsonschema.ErrorKind) []string {
	switch v := k.(type) {
	case *kind.Required:
		out := make([]string, 0, len(v.Missing))
		for _, p := range v.Missing {
			out = append(out, "is missing required property "+quoteJSON(p))
		}
		return out
	case *kind.AdditionalProperties:
		out := make([]string, 0, len(v.Properties))
		for _, p := range v.Properties {
			out = append(out, "has unexpected property "+quoteJSON(p)+"; this object declares a closed set")
		}
		return out
	// Anchored at the document root by the caller, not at the offending object: this
	// validator records no instance location for a property-name failure (the
	// "instance" it judged is the name, which has none), and a cross-SDK guarantee
	// that holds in two of three is not a guarantee. The property name is the
	// actionable part and is preserved; the path precision is the deliberate trade.
	case *kind.PropertyNames:
		return []string{"has an invalid property name " + quoteJSON(v.Property)}
	case *kind.Type:
		return []string{"must be of type " + strings.Join(v.Want, " or ")}
	case *kind.Pattern:
		return []string{"must match pattern " + quoteJSON(v.Want)}
	case *kind.Enum:
		parts := make([]string, 0, len(v.Want))
		for _, w := range v.Want {
			parts = append(parts, quoteJSON(w))
		}
		return []string{"must be one of: " + strings.Join(parts, ", ")}
	case *kind.MinLength:
		return []string{fmt.Sprintf("must be at least %d %s", v.Want, plural(v.Want, "character", ""))}
	case *kind.MinItems:
		return []string{fmt.Sprintf("must have at least %d %s", v.Want, plural(v.Want, "item", ""))}
	case *kind.MinProperties:
		return []string{fmt.Sprintf("must have at least %d %s", v.Want, plural(v.Want, "property", "properties"))}
	case *kind.Minimum:
		return []string{"must be at least " + v.Want.RatString()}
	case *kind.Maximum:
		return []string{"must be at most " + v.Want.RatString()}
	case *kind.UniqueItems:
		return []string{"must not contain duplicate items"}
	}
	return nil
}

// SchemaErrors validates data against a vendored schema and returns one
// human-readable error string per violation, phrased identically in all three SDKs.
// Conditional `if` wrapper errors are dropped for finding-count parity.
func SchemaErrors(name string, data any) []string {
	s, err := getValidator(name)
	if err != nil {
		return []string{fmt.Sprintf("(root) schema unavailable: %v", err)}
	}
	verr := s.Validate(data)
	if verr == nil {
		return nil
	}
	ve, ok := verr.(*jsonschema.ValidationError)
	if !ok {
		return []string{verr.Error()}
	}
	var rendered []string
	var walk func(e *jsonschema.ValidationError)
	walk = func(e *jsonschema.ValidationError) {
		// Drop the conditional `if` wrapper: ajv reports if/then failures twice (the
		// inner error plus a "must match then schema" wrapper); the Python jsonschema
		// reports the inner only.
		if kw := lastKeyword(e); kw == "if" {
			return
		}
		where := "(root)"
		if len(e.InstanceLocation) > 0 {
			where = "/" + strings.Join(e.InstanceLocation, "/")
		}
		// A propertyNames node carries the offending property; its cause only repeats
		// the keyword that judged it. Stop here so the two do not both surface, which
		// is the same choice the Node port makes by dropping the inner error.
		if msgs := normalizedMessage(e.ErrorKind); len(msgs) > 0 {
			if _, isNames := e.ErrorKind.(*kind.PropertyNames); isNames || len(e.Causes) == 0 {
				if isNames {
					where = "(root)"
				}
				for _, m := range msgs {
					rendered = append(rendered, where+" "+m)
				}
				return
			}
		}
		if len(e.Causes) == 0 {
			rendered = append(rendered, where+" "+e.ErrorKind.LocalizedString(enPrinter))
			return
		}
		for _, c := range e.Causes {
			walk(c)
		}
	}
	walk(ve)
	return finishViolations(rendered)
}

// finishViolations deduplicates and orders violations identically in all three SDKs.
// Order is bytewise over the rendered line: the three validators emit the same
// failures in different orders, and a stable total order is what makes the byte
// comparison meaningful.
func finishViolations(rendered []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(rendered))
	for _, r := range rendered {
		if !seen[r] {
			seen[r] = true
			out = append(out, r)
		}
	}
	sort.Strings(out)
	return out
}

// ecmaRegexp adapts a regexp2 ECMAScript pattern to jsonschema.Regexp.
type ecmaRegexp regexp2.Regexp

func (re *ecmaRegexp) MatchString(s string) bool {
	matched, err := (*regexp2.Regexp)(re).MatchString(s)
	return err == nil && matched
}

func (re *ecmaRegexp) String() string {
	return (*regexp2.Regexp)(re).String()
}

func ecmaCompile(s string) (jsonschema.Regexp, error) {
	re, err := regexp2.Compile(s, regexp2.ECMAScript)
	if err != nil {
		return nil, err
	}
	// Bound backtracking so a pathological pattern cannot hang the process. A
	// timeout surfaces as an error from MatchString, which MatchString treats as
	// a non-match (err == nil guard), so the guardrail fails closed safely.
	re.MatchTimeout = 1 * time.Second
	return (*ecmaRegexp)(re), nil
}

// lastKeyword returns the final keyword segment of a ValidationError, e.g.
// "enum", "required", or "if" for the conditional wrapper node.
func lastKeyword(e *jsonschema.ValidationError) string {
	if e.ErrorKind == nil {
		return ""
	}
	kp := e.ErrorKind.KeywordPath()
	if len(kp) == 0 {
		return ""
	}
	return kp[len(kp)-1]
}
