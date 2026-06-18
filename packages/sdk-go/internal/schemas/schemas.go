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
	"golang.org/x/text/language"
	"golang.org/x/text/message"

	"github.com/leji-org/leji/packages/sdk-go/internal/assets"
)

// SupportedLines are the spec lines this SDK supports.
var SupportedLines = []string{"1.0"}

// SDKVersion is overridable via ldflags; defaults to match Node/Python.
var SDKVersion = "1.1.0"

type CliOption struct {
	Flags   string `json:"flags"`
	Summary string `json:"summary"`
}

type CliCommand struct {
	Name        string      `json:"name"`
	Summary     string      `json:"summary"`
	Usage       string      `json:"usage"`
	Description string      `json:"description"`
	Options     []CliOption `json:"options"`
	Examples    []string    `json:"examples"`
}

type CliSpec struct {
	Name          string           `json:"name"`
	Summary       string           `json:"summary"`
	Usage         string           `json:"usage"`
	GlobalOptions []CliOption      `json:"globalOptions"`
	ExitCodes     []map[string]any `json:"exitCodes"`
	Commands      []CliCommand     `json:"commands"`
}

// LoadCliSpec reads the embedded cli.json.
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

// SchemaErrors validates data against a vendored schema and returns one
// human-readable error string per leaf violation. Conditional `if` wrapper
// errors are dropped for finding-count parity with the Node and Python SDKs.
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
	type leaf struct {
		path string
		msg  string
	}
	var leaves []leaf
	var walk func(e *jsonschema.ValidationError)
	walk = func(e *jsonschema.ValidationError) {
		// Drop the conditional `if` wrapper: ajv reports if/then failures twice
		// (the inner error plus a "must match then schema" wrapper); the Python
		// jsonschema reports the inner only. Skipping the `if` keyword node and
		// only emitting leaves keeps the finding count at one per real violation.
		if kw := lastKeyword(e); kw == "if" {
			return
		}
		if len(e.Causes) == 0 {
			where := "(root)"
			if len(e.InstanceLocation) > 0 {
				where = "/" + strings.Join(e.InstanceLocation, "/")
			}
			leaves = append(leaves, leaf{path: where, msg: e.ErrorKind.LocalizedString(enPrinter)})
			return
		}
		for _, c := range e.Causes {
			walk(c)
		}
	}
	walk(ve)
	// Deterministic order by instance path then message.
	sort.SliceStable(leaves, func(i, j int) bool {
		if leaves[i].path != leaves[j].path {
			return leaves[i].path < leaves[j].path
		}
		return leaves[i].msg < leaves[j].msg
	})
	out := make([]string, 0, len(leaves))
	for _, l := range leaves {
		out = append(out, l.path+" "+l.msg)
	}
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
