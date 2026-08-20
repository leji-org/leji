package detectcmd

import (
	"regexp"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/detect"
	"github.com/leji-org/leji/packages/sdk-go/internal/ecosystem"
)

// RenderDetect handles the empty case and a ranked, non-empty case.
func TestRenderDetectEmptyAndRanked(t *testing.T) {
	// A root with no manifest: the ecosystem line is present in both shapes and says
	// so, without changing what the host list reports.
	eco := ecosystem.Detect(t.TempDir())
	empty := RenderDetect(nil, eco)
	if !regexp.MustCompile(`No coding-agent hosts detected`).MatchString(empty) {
		t.Fatalf("empty case should report no hosts, got:\n%s", empty)
	}

	ranked := RenderDetect([]detect.DetectedHost{
		{
			ID:         "claude-code",
			Name:       "Claude Code",
			Strength:   detect.Confirmed,
			OnPath:     true,
			InRepo:     false,
			UserConfig: false,
			Adapter:    "CLAUDE.md",
		},
		{
			ID:         "cursor",
			Name:       "Cursor",
			Strength:   detect.ProjectPresent,
			OnPath:     false,
			InRepo:     true,
			UserConfig: false,
			Adapter:    ".cursor/rules/leji.md",
		},
	}, eco)

	mustMatch := func(re string) {
		t.Helper()
		if !regexp.MustCompile(`(?s)` + re).MatchString(ranked) {
			t.Fatalf("expected /%s/ to match render output:\n%s", re, ranked)
		}
	}
	// Strength, name, the PATH signal, and the adapter all appear, in order.
	mustMatch(`confirmed.*Claude Code.*binary on PATH.*CLAUDE\.md`)
	mustMatch(`leji init --agent`)
	mustMatch(`Ecosystem: none detected`)
	if !regexp.MustCompile(`Ecosystem: none detected`).MatchString(empty) {
		t.Fatalf("the empty case carries the ecosystem line too:\n%s", empty)
	}
}
