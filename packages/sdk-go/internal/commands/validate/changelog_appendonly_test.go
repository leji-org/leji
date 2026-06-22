package validate_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/validate"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
)

func repoRoot2(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(wd, "..", "..", "..", "..", "..")
}

// gitSeedExample copies the indexed example into a fresh git repo and commits it,
// giving CheckChangelogAppendOnly a HEAD baseline to diff against.
func gitSeedExample(t *testing.T) string {
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
	src := filepath.Join(repoRoot2(t), "examples", "monorepo")
	if out, err := exec.Command("cp", "-r", src+"/.", dir).CombinedOutput(); err != nil {
		t.Fatalf("cp: %v: %s", err, out)
	}
	run("add", "-A")
	run("commit", "-qm", "seed")
	return dir
}

const clRel = "docs/context-changelog.json"

func readCL(t *testing.T, dir string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(clRel)))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func writeCL(t *testing.T, dir string, m map[string]any) {
	t.Helper()
	b, _ := json.MarshalIndent(m, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(clRel)), append(b, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

func entriesSlice(m map[string]any) []any {
	raw, _ := m["entries"].([]any)
	return raw
}

func hasAppendOnlyMsg(fs []findings.Finding, substr string) bool {
	for _, f := range fs {
		if f.Rule == "changelog-append-only" && contains(f.Message, substr) {
			return true
		}
	}
	return false
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func hasRuleSev(fs []findings.Finding, rule string, sev findings.Severity) bool {
	for _, f := range fs {
		if f.Rule == rule && f.Severity == sev {
			return true
		}
	}
	return false
}

func TestChangelogAppendOnlyCleanVerifies(t *testing.T) {
	dir := gitSeedExample(t)
	res := validate.CheckChangelogAppendOnly(dir, clRel, false)
	if !res.Verified {
		t.Fatalf("clean committed changelog should verify: %+v", res.Findings)
	}
	for _, f := range res.Findings {
		if f.Severity == findings.Error {
			t.Fatalf("clean changelog should have no error: %+v", f)
		}
	}
}

func TestChangelogAppendOnlyModifiedEntry(t *testing.T) {
	dir := gitSeedExample(t)
	m := readCL(t, dir)
	es := entriesSlice(m)
	es[0].(map[string]any)["summary"] = "tampered"
	writeCL(t, dir, m)
	res := validate.CheckChangelogAppendOnly(dir, clRel, false)
	if !hasAppendOnlyMsg(res.Findings, "modified since HEAD") {
		t.Fatalf("modifying a surviving entry should flag append-only: %+v", res.Findings)
	}
}

func TestChangelogAppendOnlyRemovalWithoutCompaction(t *testing.T) {
	dir := gitSeedExample(t)
	m := readCL(t, dir)
	es := entriesSlice(m)
	m["entries"] = es[1:] // drop the oldest, no compaction entry
	writeCL(t, dir, m)
	res := validate.CheckChangelogAppendOnly(dir, clRel, false)
	if !hasAppendOnlyMsg(res.Findings, "without a compaction entry") {
		t.Fatalf("dropping the oldest without a compaction entry should flag: %+v", res.Findings)
	}
}

func TestChangelogAppendOnlyRemovalFromWrongEnd(t *testing.T) {
	dir := gitSeedExample(t)
	m := readCL(t, dir)
	es := entriesSlice(m)
	// Drop the newest entry instead of the oldest: not a compaction from the
	// oldest end.
	m["entries"] = es[:len(es)-1]
	writeCL(t, dir, m)
	res := validate.CheckChangelogAppendOnly(dir, clRel, false)
	if !hasAppendOnlyMsg(res.Findings, "other than the oldest end") {
		t.Fatalf("dropping the newest should flag wrong-end removal: %+v", res.Findings)
	}
}

func TestChangelogAppendOnlyCompactedToEmpty(t *testing.T) {
	dir := gitSeedExample(t)
	m := readCL(t, dir)
	m["entries"] = []any{}
	writeCL(t, dir, m)
	res := validate.CheckChangelogAppendOnly(dir, clRel, false)
	if !hasAppendOnlyMsg(res.Findings, "compacted to empty") {
		t.Fatalf("emptying the changelog should flag: %+v", res.Findings)
	}
}

func TestChangelogAppendOnlyMissingIsRequired(t *testing.T) {
	dir := gitSeedExample(t)
	if err := os.Remove(filepath.Join(dir, filepath.FromSlash("docs/missing.json"))); err == nil {
		t.Fatal("setup: should not exist")
	}
	res := validate.CheckChangelogAppendOnly(dir, "docs/missing.json", false)
	if res.Verified {
		t.Fatal("a missing changelog should not verify")
	}
	found := false
	for _, f := range res.Findings {
		if f.Rule == "changelog-required" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected changelog-required, got %+v", res.Findings)
	}
}

func TestChangelogAppendOnlyUnverifiableOutsideGit(t *testing.T) {
	// No git repo: append-only cannot be verified.
	dir := t.TempDir()
	src := filepath.Join(repoRoot2(t), "examples", "monorepo")
	if err := os.CopyFS(dir, os.DirFS(src)); err != nil {
		t.Fatal(err)
	}
	// Non-strict: a warning.
	res := validate.CheckChangelogAppendOnly(dir, clRel, false)
	if res.Verified {
		t.Fatal("cannot be verified without git")
	}
	if !hasRuleSev(res.Findings, "changelog-unverifiable", findings.Warning) {
		t.Fatalf("non-strict should warn: %+v", res.Findings)
	}
	// Strict: an error.
	res = validate.CheckChangelogAppendOnly(dir, clRel, true)
	if !hasRuleSev(res.Findings, "changelog-unverifiable", findings.Error) {
		t.Fatalf("strict should error: %+v", res.Findings)
	}
}
