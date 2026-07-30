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
	Message  string
	// HasPath distinguishes "no path" from "empty-string path" so the emitted
	// JSON can omit the field, matching Node/Python.
	HasPath bool
}

func New(rule string, severity Severity, message, path string) Finding {
	return Finding{Rule: rule, Severity: severity, Message: message, Path: path, HasPath: true}
}

func NewNoPath(rule string, severity Severity, message string) Finding {
	return Finding{Rule: rule, Severity: severity, Message: message}
}

type Summary struct {
	Errors   int `json:"errors"`
	Warnings int `json:"warnings"`
}

// Sort orders findings by (path, rule, message); stable to mirror JS sort.
func Sort(in []Finding) []Finding {
	out := make([]Finding, len(in))
	copy(out, in)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Path != b.Path {
			return a.Path < b.Path
		}
		if a.Rule != b.Rule {
			return a.Rule < b.Rule
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
