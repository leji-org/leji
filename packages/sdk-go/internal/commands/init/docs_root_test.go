package initcmd

import "testing"

// Directory-entry order is unspecified, so the choice must be a function of the
// set and not of the order it arrives in. Injected rather than read from a
// filesystem: two reads return the same order, so a filesystem-backed test would
// pass with the ordering rule reverted. Matches the reference implementation.
func TestPickDocsRoot(t *testing.T) {
	cases := []struct {
		in   []string
		want string
	}{
		{[]string{"Docs", "DOCS"}, "DOCS/"},
		{[]string{"DOCS", "Docs"}, "DOCS/"},
		{[]string{"Docs", "docs", "DOCS"}, "docs/"},
		{[]string{"docs", "Docs"}, "docs/"},
		{[]string{"documentation", "doc", "docs"}, "docs/"},
		{[]string{"documentation", "DOC"}, "DOC/"},
		{[]string{}, ""},
		{[]string{"src", "lib"}, ""},
		// EqualFold would match this onto "docs"; plain lowercasing must not.
		{[]string{"docſ"}, ""},
	}
	for _, c := range cases {
		if got := pickDocsRoot(c.in); got != c.want {
			t.Errorf("pickDocsRoot(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}
