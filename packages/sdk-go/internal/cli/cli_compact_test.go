package cli

// CLI-level mirrors of the run.test.ts changes: effective foundational paths
// (core layer writes the default index; changelog check resolves the default
// path with no "not declared" message) and `changelog compact` dispatch.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// runJSON runs the CLI capturing stdout and parses it as JSON.
func runJSON(t *testing.T, argv []string) (int, map[string]any, string) {
	t.Helper()
	code, out, errs := captureRun(t, argv)
	var payload map[string]any
	if strings.TrimSpace(out) != "" {
		if err := json.Unmarshal([]byte(out), &payload); err != nil {
			t.Fatalf("output not JSON: %v\n%s", err, out)
		}
	}
	return code, payload, errs
}

func findingsOf(payload map[string]any) []map[string]any {
	raw, _ := payload["findings"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, f := range raw {
		if m, ok := f.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// A core layer with no machine.indexPath writes to the default and reports it.
func TestCLICoreLayerWritesDefaultIndex(t *testing.T) {
	dir := t.TempDir()
	if err := os.CopyFS(dir, os.DirFS(fixture(t, "valid-minimal-core"))); err != nil {
		t.Fatalf("copy fixture: %v", err)
	}
	code, payload, errs := runJSON(t, []string{"index", "--root", dir, "--json"})
	if code != 0 {
		t.Fatalf("index exit %d (%s)", code, errs)
	}
	if payload["written"] != "docs/context-index.json" {
		t.Fatalf("written = %v, want docs/context-index.json", payload["written"])
	}
	for _, f := range findingsOf(payload) {
		msg, _ := f["message"].(string)
		if strings.Contains(msg, "not declared") || strings.Contains(msg, "no machine") {
			t.Fatalf("unexpected not-declared message: %s", msg)
		}
	}
	if !fileExists(filepath.Join(dir, "docs", "context-index.json")) {
		t.Fatal("default index not written")
	}
}

// changelog check on a core layer resolves the default changelog path; the file
// is simply absent, so the finding is the missing-file changelog-required, never
// a "not declared" error.
func TestCLICoreLayerChangelogResolvesDefault(t *testing.T) {
	dir := fixture(t, "valid-minimal-core")
	_, payload, _ := runJSON(t, []string{"changelog", "check", "--root", dir, "--json"})
	sawRequired := false
	for _, f := range findingsOf(payload) {
		msg, _ := f["message"].(string)
		if strings.Contains(msg, "not declared") || strings.Contains(msg, "no machine") {
			t.Fatalf("unexpected not-declared message: %s", msg)
		}
		if f["rule"] == "changelog-required" && strings.Contains(msg, "docs/context-changelog.json does not exist") {
			sawRequired = true
		}
	}
	if !sawRequired {
		t.Fatalf("expected changelog-required for default path, findings: %v", payload["findings"])
	}
}

func TestCLIChangelogCompactRequiresFlag(t *testing.T) {
	code, _, errs := captureRun(t, []string{"changelog", "compact", "--root", example(t)})
	if code != 2 {
		t.Fatalf("compact without flags exit %d, want 2", code)
	}
	if !strings.Contains(errs, "changelog compact requires --keep or --before") {
		t.Fatalf("missing usage message: %s", errs)
	}
}

func TestCLIChangelogCompactKeep(t *testing.T) {
	dir := copyExample(t)
	code, payload, errs := runJSON(t, []string{"changelog", "compact", "--keep", "1", "--root", dir, "--json"})
	if code != 0 {
		t.Fatalf("compact exit %d (%s)", code, errs)
	}
	// The example has 2 entries; keep newest 1 → fold 1, kept = 1 survivor + 1 compaction.
	if payload["folded"].(float64) != 1 {
		t.Fatalf("folded = %v, want 1", payload["folded"])
	}
	if payload["kept"].(float64) != 2 {
		t.Fatalf("kept = %v, want 2", payload["kept"])
	}
	b, _ := os.ReadFile(filepath.Join(dir, "docs", "context-changelog.json"))
	var log map[string]any
	if err := json.Unmarshal(b, &log); err != nil {
		t.Fatalf("changelog not JSON: %v", err)
	}
	entries, _ := log["entries"].([]any)
	last, _ := entries[len(entries)-1].(map[string]any)
	if last["type"] != "compaction" {
		t.Fatalf("last entry type = %v, want compaction", last["type"])
	}
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.Mode().IsRegular()
}
