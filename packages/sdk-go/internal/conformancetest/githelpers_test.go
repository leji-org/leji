package conformancetest

import (
	"encoding/json"
	"os"
	"os/exec"
	"testing"
)

// gitSeedExample copies the example layer into a fresh git repo and commits it,
// so changelog append-only has a HEAD baseline to compare against.
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
	cp := exec.Command("cp", "-r", exampleDir(t)+"/.", dir)
	if out, err := cp.CombinedOutput(); err != nil {
		t.Fatalf("cp: %v: %s", err, out)
	}
	run("add", "-A")
	run("commit", "-qm", "seed")
	return dir
}

func readChangelog(t *testing.T, abs string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(abs)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func writeChangelog(t *testing.T, abs string, m map[string]any) {
	t.Helper()
	b, _ := json.MarshalIndent(m, "", "  ")
	if err := os.WriteFile(abs, append(b, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

func entriesOf(m map[string]any) []any {
	e, _ := m["entries"].([]any)
	return e
}

func replaceFirstSummary(s string) string {
	// Change the value of the first "summary" field, preserving JSON validity.
	var m map[string]any
	if json.Unmarshal([]byte(s), &m) != nil {
		return s
	}
	entries := entriesOf(m)
	if len(entries) > 0 {
		if e, ok := entries[0].(map[string]any); ok {
			e["summary"] = "Rewritten history."
		}
	}
	b, _ := json.MarshalIndent(m, "", "  ")
	return string(b) + "\n"
}

func dropOldestWithCompaction(t *testing.T, abs string) {
	t.Helper()
	m := readChangelog(t, abs)
	entries := entriesOf(m)
	if len(entries) == 0 {
		t.Fatal("no entries to compact")
	}
	dropped, _ := entries[0].(map[string]any)
	rest := append([]any{}, entries[1:]...)
	compaction := map[string]any{
		"id":      "compact-2026-06",
		"date":    "2026-06-12",
		"type":    "compaction",
		"summary": "Compacted the oldest entry; full record in git history.",
		"paths":   []any{"docs/context-changelog.json"},
		"compacted": map[string]any{
			"entries": 1,
			"firstId": dropped["id"],
			"lastId":  dropped["id"],
		},
	}
	m["entries"] = append(rest, compaction)
	writeChangelog(t, abs, m)
}

func reverseEntries(t *testing.T, abs string) {
	t.Helper()
	m := readChangelog(t, abs)
	entries := entriesOf(m)
	for i, j := 0, len(entries)-1; i < j; i, j = i+1, j-1 {
		entries[i], entries[j] = entries[j], entries[i]
	}
	m["entries"] = entries
	writeChangelog(t, abs, m)
}
