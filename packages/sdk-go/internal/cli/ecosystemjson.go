package cli

import (
	"github.com/leji-org/leji/packages/sdk-go/internal/ecosystem"
)

// ecosystemJSON renders a detection report as the insertion-ordered object the
// --json surface pins: the same key order as the TypeScript reference, empty
// arrays as arrays, and absent argv as null.
func ecosystemJSON(report ecosystem.Report) *jsonObj {
	o := newJSONObj()
	if report.Selected == nil {
		o.set("selected", nil)
	} else {
		o.set("selected", ecoResultJSON(*report.Selected))
	}
	all := make([]any, 0, len(report.All))
	for _, r := range report.All {
		all = append(all, ecoResultJSON(r))
	}
	o.set("all", all)
	if report.Reason == nil {
		o.set("reason", nil)
	} else {
		o.set("reason", *report.Reason)
	}
	return o
}

func ecoResultJSON(r ecosystem.Result) *jsonObj {
	o := newJSONObj()
	o.set("ecosystem", r.Ecosystem)
	o.set("status", r.Status)
	o.set("manifest", strOrNil(r.Manifest))
	o.set("manager", strOrNil(r.Manager))
	o.set("source", strOrNil(r.Source))
	o.set("evidence", stringsToAny(r.Evidence))
	o.set("add", argvOrNil(r.Add))
	o.set("runner", argvOrNil(r.Runner))
	o.set("directDeclared", r.DirectDeclared)
	o.set("lockEvidenced", r.LockEvidenced)
	candidates := make([]any, 0, len(r.Candidates))
	for _, c := range r.Candidates {
		co := newJSONObj()
		co.set("manager", c.Manager)
		co.set("add", argvOrNil(c.Add))
		candidates = append(candidates, co)
	}
	o.set("candidates", candidates)
	return o
}

func strOrNil(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// argvOrNil keeps the contract's distinction: an absent command is null, never an
// empty array.
func argvOrNil(argv []string) any {
	if argv == nil {
		return nil
	}
	return stringsToAny(argv)
}

func stringsToAny(items []string) []any {
	out := make([]any, 0, len(items))
	for _, s := range items {
		out = append(out, s)
	}
	return out
}
