package findings

import "testing"

func TestNewAndNewNoPath(t *testing.T) {
	f := New("rule-a", Error, "boom", "docs/x.md")
	if f.Rule != "rule-a" || f.Severity != Error || f.Message != "boom" || f.Path != "docs/x.md" {
		t.Fatalf("New populated wrong fields: %#v", f)
	}
	if !f.HasPath {
		t.Fatalf("New must set HasPath true")
	}

	n := NewNoPath("rule-b", Warning, "heads up")
	if n.HasPath {
		t.Fatalf("NewNoPath must leave HasPath false")
	}
	if n.Path != "" {
		t.Fatalf("NewNoPath must leave Path empty, got %q", n.Path)
	}
}

func TestSortOrdersByPathRuleMessageStable(t *testing.T) {
	in := []Finding{
		{Path: "b.md", Rule: "r1", Message: "m"},
		{Path: "a.md", Rule: "r2", Message: "z"},
		{Path: "a.md", Rule: "r2", Message: "a"},
		{Path: "a.md", Rule: "r1", Message: "m"},
		{Path: "", Rule: "r9", Message: "no path"},
	}
	out := Sort(in)

	wantOrder := []struct{ path, rule, msg string }{
		{"", "r9", "no path"},
		{"a.md", "r1", "m"},
		{"a.md", "r2", "a"},
		{"a.md", "r2", "z"},
		{"b.md", "r1", "m"},
	}
	if len(out) != len(wantOrder) {
		t.Fatalf("length mismatch: got %d want %d", len(out), len(wantOrder))
	}
	for i, w := range wantOrder {
		if out[i].Path != w.path || out[i].Rule != w.rule || out[i].Message != w.msg {
			t.Fatalf("position %d = %#v, want %v", i, out[i], w)
		}
	}
	// Sort must not mutate the input slice.
	if in[0].Path != "b.md" {
		t.Fatalf("Sort mutated its input: %#v", in)
	}
}

func TestSummarizeCountsBySeverity(t *testing.T) {
	in := []Finding{
		{Severity: Error},
		{Severity: Warning},
		{Severity: Error},
		{Severity: Warning},
		{Severity: Warning},
	}
	s := Summarize(in)
	if s.Errors != 2 {
		t.Fatalf("errors = %d want 2", s.Errors)
	}
	if s.Warnings != 3 {
		t.Fatalf("warnings = %d want 3", s.Warnings)
	}
}

func TestSummarizeEmpty(t *testing.T) {
	s := Summarize(nil)
	if s.Errors != 0 || s.Warnings != 0 {
		t.Fatalf("empty summary should be zero, got %#v", s)
	}
}

func TestHasErrors(t *testing.T) {
	cases := []struct {
		name string
		in   []Finding
		want bool
	}{
		{"empty", nil, false},
		{"only warnings", []Finding{{Severity: Warning}, {Severity: Warning}}, false},
		{"one error", []Finding{{Severity: Warning}, {Severity: Error}}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := HasErrors(c.in); got != c.want {
				t.Fatalf("HasErrors = %v want %v", got, c.want)
			}
		})
	}
}
