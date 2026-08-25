// Package findings is the shared result shape of every check, mirrored by the
// Node and Python SDKs.
package findings

import "sort"

type Severity = string

const (
	Error   Severity = "error"
	Warning Severity = "warning"
)

// Finding is a single rule violation. Path is the repo-root-relative POSIX path,
// empty when none.
type Finding struct {
	Rule     string
	Severity Severity
	Path     string
	// Line is the 1-based line within Path when the rule locates one (the
	// rendering lint); 0 when it does not, and then omitted from the JSON.
	Line int
	// Construct is the closed-token construct a rule names, when it carries one:
	// what the three SDKs compare on for `render-unsupported`, message text being
	// outside the contract. Empty when the rule names none, and then omitted.
	Construct string
	Message   string
	// Detail is which act a rule with more than one failed at, and the resolver's
	// own reason for it: `"<act>: <reason>"`. Serialized immediately after
	// `message`, so the three SDKs emit the same bytes; empty for every rule that
	// names no act, and then omitted.
	Detail string
	// HasPath distinguishes "no path" from "empty-string path" so the emitted
	// JSON can omit the field, matching Node/Python.
	HasPath bool
}

func New(rule string, severity Severity, message, path string) Finding {
	return Finding{Rule: rule, Severity: severity, Message: message, Path: path, HasPath: true}
}

// NewWithDetail is New plus the act the rule failed at. An empty detail is the
// rule that names no act, and emits exactly what New would.
func NewWithDetail(rule string, severity Severity, message, path, detail string) Finding {
	f := New(rule, severity, message, path)
	f.Detail = detail
	return f
}

func NewNoPath(rule string, severity Severity, message string) Finding {
	return Finding{Rule: rule, Severity: severity, Message: message}
}

type Summary struct {
	Errors   int `json:"errors"`
	Warnings int `json:"warnings"`
}

// Sort orders findings by (path, line, rule, construct), message last as the final
// tie-break; stable to mirror JS sort. The line and construct keys carry the
// rendering lint's ordering — two constructs reported on one line stay in the same
// order in all three SDKs — and change nothing for a rule that locates neither.
func Sort(in []Finding) []Finding {
	out := make([]Finding, len(in))
	copy(out, in)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Path != b.Path {
			return a.Path < b.Path
		}
		if a.Line != b.Line {
			return a.Line < b.Line
		}
		if a.Rule != b.Rule {
			return a.Rule < b.Rule
		}
		if a.Construct != b.Construct {
			return a.Construct < b.Construct
		}
		return a.Message < b.Message
	})
	return out
}

func Summarize(in []Finding) Summary {
	var s Summary
	for _, f := range in {
		if f.Severity == Error {
			s.Errors++
		} else {
			s.Warnings++
		}
	}
	return s
}

func HasErrors(in []Finding) bool {
	for _, f := range in {
		if f.Severity == Error {
			return true
		}
	}
	return false
}
