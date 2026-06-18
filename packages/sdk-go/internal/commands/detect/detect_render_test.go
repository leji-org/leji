package detectcmd

import (
	"regexp"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/detect"
)

// RenderDetect handles the empty case and a ranked, non-empty case, mirroring the
// Node SDK's renderDetect test. RenderDetect was previously exercised only via CLI
// dispatch.
func TestRenderDetectEmptyAndRanked(t *testing.T) {
	empty := RenderDetect(nil)
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
	})

	mustMatch := func(re string) {
		t.Helper()
		if !regexp.MustCompile(`(?s)` + re).MatchString(ranked) {
			t.Fatalf("expected /%s/ to match render output:\n%s", re, ranked)
		}
	}
	// Strength, name, the PATH signal, and the adapter all appear, in order.
	mustMatch(`confirmed.*Claude Code.*binary on PATH.*CLAUDE\.md`)
	// The init hint guides toward wiring a host into a fresh layer.
	mustMatch(`leji init --agent`)
}
