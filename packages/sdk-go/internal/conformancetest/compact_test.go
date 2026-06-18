package conformancetest

// Go equivalents of the `changelog compact` units in units.test.ts: keep/before/
// both/no-op/id-dedupe, and that the result still passes append-only discipline.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/changelog"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/validate"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
)

const changelogRel = "docs/context-changelog.json"

// seedWithEntries copies the example into a fresh git repo whose changelog
// carries `count` dated entries, then commits it (so append-only has a baseline).
func seedWithEntries(t *testing.T, count int) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-q")
	run("config", "user.email", "t@e.com")
	run("config", "user.name", "T")
	cp := exec.Command("cp", "-r", exampleDir(t)+"/.", dir)
	if out, err := cp.CombinedOutput(); err != nil {
		t.Fatalf("cp: %v: %s", err, out)
	}
	abs := filepath.Join(dir, changelogRel)
	log := readChangelog(t, abs)
	entries := make([]any, 0, count)
	for i := 0; i < count; i++ {
		entries = append(entries, map[string]any{
			"id":      fmt.Sprintf("e-%02d", i+1),
			"date":    fmt.Sprintf("2026-0%d-%02d", 1+i/28, (i%28)+1),
			"type":    "added",
			"summary": fmt.Sprintf("Change %d.", i+1),
			"paths":   []any{fmt.Sprintf("docs/file-%d.md", i+1)},
		})
	}
	log["entries"] = entries
	writeChangelog(t, abs, log)
	run("add", "-A")
	run("commit", "-qm", "seed")
	return dir
}

func errorFindings(fs []findings.Finding) []findings.Finding {
	var out []findings.Finding
	for _, f := range fs {
		if f.Severity == findings.Error {
			out = append(out, f)
		}
	}
	return out
}

func lastEntry(t *testing.T, abs string) map[string]any {
	t.Helper()
	log := readChangelog(t, abs)
	entries := entriesOf(log)
	if len(entries) == 0 {
		t.Fatal("no entries")
	}
	e, _ := entries[len(entries)-1].(map[string]any)
	return e
}

func TestCompactKeepFoldsOldest(t *testing.T) {
	dir := seedWithEntries(t, 10)
	m := loadM(t, dir)
	result := changelog.CompactChangelog(dir, m, changelog.CompactOptions{Keep: 4, HasKeep: true})
	if errs := errorFindings(result.Findings); len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
	if result.Folded != 6 {
		t.Fatalf("folded = %d, want 6", result.Folded)
	}
	if result.Kept != 5 {
		t.Fatalf("kept = %d, want 5", result.Kept)
	}

	abs := filepath.Join(dir, changelogRel)
	log := readChangelog(t, abs)
	entries := entriesOf(log)
	wantSurvivors := []string{"e-07", "e-08", "e-09", "e-10"}
	for i, want := range wantSurvivors {
		e, _ := entries[i].(map[string]any)
		if e["id"] != want {
			t.Fatalf("survivor %d = %v, want %s", i, e["id"], want)
		}
	}
	c := lastEntry(t, abs)
	if c["type"] != "compaction" {
		t.Fatalf("last entry type = %v", c["type"])
	}
	compacted, _ := c["compacted"].(map[string]any)
	if compacted["entries"].(float64) != 6 {
		t.Fatalf("compacted.entries = %v", compacted["entries"])
	}
	if compacted["firstId"] != "e-01" || compacted["lastId"] != "e-06" {
		t.Fatalf("compacted range = %v..%v", compacted["firstId"], compacted["lastId"])
	}
	gotPaths, _ := c["paths"].([]any)
	wantPaths := []string{
		"docs/file-1.md", "docs/file-2.md", "docs/file-3.md",
		"docs/file-4.md", "docs/file-5.md", "docs/file-6.md",
	}
	if len(gotPaths) != len(wantPaths) {
		t.Fatalf("paths = %v", gotPaths)
	}
	for i, w := range wantPaths {
		if gotPaths[i] != w {
			t.Fatalf("path %d = %v, want %s", i, gotPaths[i], w)
		}
	}

	// The compacted changelog passes append-only discipline against the baseline.
	check := validate.CheckChangelogAppendOnly(dir, changelogRel, false)
	if errs := errorFindings(check.Findings); len(errs) != 0 {
		t.Fatalf("append-only errors after compact: %v", errs)
	}
	// And the whole layer still validates clean.
	v := validate.ValidateLayer(dir, false)
	if errs := errorFindings(v.Findings); len(errs) != 0 {
		t.Fatalf("layer validate errors after compact: %v", errs)
	}
}

func TestCompactBeforeCutoff(t *testing.T) {
	dir := seedWithEntries(t, 10)
	m := loadM(t, dir)
	result := changelog.CompactChangelog(dir, m, changelog.CompactOptions{Before: "2026-01-06", HasBefore: true})
	if errs := errorFindings(result.Findings); len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
	if result.Folded != 5 {
		t.Fatalf("folded = %d, want 5", result.Folded)
	}
	c := lastEntry(t, filepath.Join(dir, changelogRel))
	compacted, _ := c["compacted"].(map[string]any)
	if compacted["firstId"] != "e-01" || compacted["lastId"] != "e-05" {
		t.Fatalf("compacted range = %v..%v", compacted["firstId"], compacted["lastId"])
	}
	check := validate.CheckChangelogAppendOnly(dir, changelogRel, false)
	if errs := errorFindings(check.Findings); len(errs) != 0 {
		t.Fatalf("append-only errors: %v", errs)
	}
}

func TestCompactBothFlagsIntersection(t *testing.T) {
	dir := seedWithEntries(t, 10)
	m := loadM(t, dir)
	// --keep 3 marks e-01..e-07 foldable; --before 2026-01-04 marks e-01..e-03.
	// The intersection (both must accept) is e-01..e-03.
	result := changelog.CompactChangelog(dir, m, changelog.CompactOptions{
		Keep: 3, HasKeep: true, Before: "2026-01-04", HasBefore: true,
	})
	if result.Folded != 3 {
		t.Fatalf("folded = %d, want 3", result.Folded)
	}
	c := lastEntry(t, filepath.Join(dir, changelogRel))
	compacted, _ := c["compacted"].(map[string]any)
	if compacted["firstId"] != "e-01" || compacted["lastId"] != "e-03" {
		t.Fatalf("compacted range = %v..%v", compacted["firstId"], compacted["lastId"])
	}
}

func TestCompactNoOp(t *testing.T) {
	dir := seedWithEntries(t, 5)
	m := loadM(t, dir)
	abs := filepath.Join(dir, changelogRel)
	before, _ := os.ReadFile(abs)
	result := changelog.CompactChangelog(dir, m, changelog.CompactOptions{Keep: 10, HasKeep: true})
	if result.Folded != 0 {
		t.Fatalf("folded = %d, want 0", result.Folded)
	}
	if len(result.Findings) != 0 {
		t.Fatalf("expected no findings, got %v", result.Findings)
	}
	after, _ := os.ReadFile(abs)
	if string(before) != string(after) {
		t.Fatal("file changed on no-op")
	}
}

func TestCompactDedupesID(t *testing.T) {
	dir := seedWithEntries(t, 6)
	today := time.Now().UTC().Format("2006-01-02")
	abs := filepath.Join(dir, changelogRel)
	log := readChangelog(t, abs)
	entries := entriesOf(log)
	first, _ := entries[0].(map[string]any)
	first["id"] = "compaction-" + today // collide with the id the compactor will pick
	writeChangelog(t, abs, log)
	m := loadM(t, dir)
	result := changelog.CompactChangelog(dir, m, changelog.CompactOptions{Keep: 2, HasKeep: true})
	if result.Folded == 0 {
		t.Fatal("expected folding")
	}
	c := lastEntry(t, abs)
	if c["id"] != "compaction-"+today+"-2" {
		t.Fatalf("compaction id = %v, want %s", c["id"], "compaction-"+today+"-2")
	}
}

// jsonRoundTrip is a small guard that the serializer emits valid JSON.
func TestCompactProducesValidJSON(t *testing.T) {
	dir := seedWithEntries(t, 4)
	m := loadM(t, dir)
	changelog.CompactChangelog(dir, m, changelog.CompactOptions{Keep: 1, HasKeep: true})
	b, _ := os.ReadFile(filepath.Join(dir, changelogRel))
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("serialized changelog is not valid JSON: %v", err)
	}
}
