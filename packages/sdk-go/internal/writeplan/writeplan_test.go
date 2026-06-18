package writeplan

import (
	"regexp"
	"strings"
	"testing"
)

// Render labels every plan status and summarizes the counts, mirroring the Node
// SDK's renderWritePlan test. These render helpers were previously exercised only
// via CLI dispatch.
func TestRenderLabelsEveryStatusAndSummarizesCounts(t *testing.T) {
	out := Render([]PlanEntry{
		{Rel: "leji.json", Status: Create},
		{Rel: "docs/boot-profile.md", Status: SkipExists},
		{Rel: "CLAUDE.md", Status: Overwrite, Note: "convert"},
		{Rel: "AGENTS.md", Status: WontModify, Note: "read-only"},
	})

	mustMatch := func(re string) {
		t.Helper()
		// (?s) lets `.` span the newline-delimited plan block.
		if !regexp.MustCompile(`(?s)` + re).MatchString(out) {
			t.Fatalf("expected /%s/ to match render output:\n%s", re, out)
		}
	}
	mustMatch(`create .*leji\.json`)
	mustMatch(`skip .*docs/boot-profile\.md`)
	mustMatch(`overwrite .*CLAUDE\.md`)
	mustMatch(`Will NOT modify`)
	mustMatch(`AGENTS\.md`)
	mustMatch(`1 to create, 1 already present.*1 to convert`)

	// The convert phrasing must carry the consent qualifier.
	if !strings.Contains(out, "1 to convert (with your consent)") {
		t.Fatalf("expected the convert count to read \"1 to convert (with your consent)\", got:\n%s", out)
	}
}
