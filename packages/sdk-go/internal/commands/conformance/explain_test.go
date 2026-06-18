package conformance

import (
	"os/exec"
	"strings"
	"testing"

	initcmd "github.com/leji-org/leji/packages/sdk-go/internal/commands/init"
)

// conformance --explain guides toward the next level: a fresh core layer points
// at "indexed" and surfaces the content-lint pointer.
func TestRenderExplainGuidesTowardNextLevel(t *testing.T) {
	dir := t.TempDir()
	if _, err := initcmd.InitLayer(initcmd.Options{Dir: dir, Yes: true}); err != nil { // core, not indexed
		t.Fatalf("init: %v", err)
	}
	if _, err := exec.LookPath("git"); err == nil {
		cmd := exec.Command("git", "init", "-q")
		cmd.Dir = dir
		if err := cmd.Run(); err != nil {
			t.Fatalf("git init: %v", err)
		}
	}
	explain := RenderExplain(Report(dir))
	if !strings.Contains(explain, `To reach "indexed"`) {
		t.Fatalf("expected guidance toward indexed, got:\n%s", explain)
	}
	if !strings.Contains(explain, "validate --content") {
		t.Fatalf("expected content-lint pointer, got:\n%s", explain)
	}
}

// RenderExplain covers two branches reachable only by constructed results: the
// federated (top) case has nothing further to reach, and a verified=core layer
// whose every next-level (indexed) item already passes is told to bump the claim.
// Mirrors the Node SDK's renderExplain branch test.
func TestRenderExplainFederatedAndAllPass(t *testing.T) {
	top := RenderExplain(Result{
		ClaimedLevel:  "federated",
		VerifiedLevel: "federated",
	})
	if !strings.Contains(top, "top conformance level") {
		t.Fatalf("federated layer should report the top conformance level, got:\n%s", top)
	}

	allPass := RenderExplain(Result{
		ClaimedLevel:  "core",
		VerifiedLevel: "core",
		Items: []ChecklistItem{
			{ID: "index-current", Level: "indexed", Description: "index", Status: Pass},
			{ID: "changelog", Level: "indexed", Description: "changelog", Status: Pass},
		},
	})
	if !strings.Contains(allPass, `all "indexed" checks already pass`) {
		t.Fatalf("all-pass next level should advise bumping the claim, got:\n%s", allPass)
	}
}
