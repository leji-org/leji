package conformancetest

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/freshness"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/indexgen"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/validate"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

func TestFreshnessReportExpiredAndUpcoming(t *testing.T) {
	dir := copyTree(t, exampleDir(t))
	writeDoc := func(rel, date string) {
		c := "---\nfreshness:\n  reviewAfter: " + date + "\n---\n# doc\n"
		if err := os.WriteFile(filepath.Join(dir, rel), []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	writeDoc("docs/domain/expired.md", "2000-01-01")
	writeDoc("docs/domain/soon.md", time.Now().UTC().Add(10*24*time.Hour).Format("2006-01-02"))
	writeDoc("docs/domain/far.md", time.Now().UTC().Add(90*24*time.Hour).Format("2006-01-02"))

	m := manifest.LoadManifest(dir).Manifest
	rep := freshness.FreshnessReport(dir, m, false)
	has := func(items []freshness.Item, rel string) bool {
		for _, it := range items {
			if it.Path == rel {
				return true
			}
		}
		return false
	}
	if !has(rep.Expired, "docs/domain/expired.md") {
		t.Fatalf("expired.md (past) should be expired, got %v", rep.Expired)
	}
	if !has(rep.Upcoming, "docs/domain/soon.md") {
		t.Fatalf("soon.md (+10d) should be upcoming, got %v", rep.Upcoming)
	}
	if has(rep.Upcoming, "docs/domain/far.md") {
		t.Fatal("far.md (+90d) is beyond the 30-day horizon and must not be upcoming")
	}
	strict := freshness.FreshnessReport(dir, m, true)
	hasExpiredErr := false
	for _, f := range strict.Findings {
		if f.Rule == "freshness-expired" && f.Severity == findings.Error {
			hasExpiredErr = true
		}
	}
	if !hasExpiredErr {
		t.Fatalf("--strict should raise expired to a freshness-expired error, got %v", strict.Findings)
	}
}

func TestAgentsMapBadTargetFlagged(t *testing.T) {
	dir := copyTree(t, exampleDir(t))
	mpath := filepath.Join(dir, "leji.json")
	var raw map[string]any
	b, _ := os.ReadFile(mpath)
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatal(err)
	}
	agents, _ := raw["agents"].(map[string]any)
	if agents == nil {
		agents = map[string]any{}
		raw["agents"] = agents
	}
	// A real file with frontmatter, outside the profiles dir, that is not a valid
	// agent profile: checkAgentsMap validates its frontmatter and flags it.
	agents["bad"] = "docs/domain/glossary.md"
	out, _ := json.MarshalIndent(raw, "", "  ")
	if err := os.WriteFile(mpath, append(out, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	res := validate.ValidateLayer(dir)
	found := false
	for _, f := range res.Findings {
		if f.Rule == "profile-frontmatter" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a profile-frontmatter finding, got %v", res.Findings)
	}
}

// A doc carrying tags/owners/links exercises the index entry array path: strArray
// (parse) and toAnySlice + the ordered writeValue array branch (serialize).
func TestIndexEntryArraysSerialized(t *testing.T) {
	dir := copyTree(t, exampleDir(t))
	doc := "---\nsummary: tagged doc\ntags:\n  - billing\n  - core\nowners:\n  - jo\nlinks:\n  - https://example.com\n---\n# Tagged\n"
	if err := os.WriteFile(filepath.Join(dir, "docs/domain/tagged.md"), []byte(doc), 0o644); err != nil {
		t.Fatal(err)
	}
	m := manifest.LoadManifest(dir).Manifest
	if _, err := indexgen.WriteIndex(dir, m); err != nil {
		t.Fatalf("WriteIndex: %v", err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "docs", "context-index.json"))
	if !strings.Contains(string(b), "\"tags\"") || !strings.Contains(string(b), "billing") {
		t.Fatalf("expected serialized tags in the index: %s", string(b))
	}
	// CheckIndex compares the stored (now tagged) index against the tree, running
	// the array comparison path: entryComparable -> toAnySlice, strArray non-nil.
	if res := indexgen.CheckIndex(dir, m); res.Stale != nil && *res.Stale {
		t.Fatalf("freshly written index should be current, findings: %v", res.Findings)
	}
}

// Append-only check against a real git HEAD baseline: appending a new entry is
// allowed and the verifier sorts the HEAD entries (compareByDateID / entryDate /
// entryIDStr) while confirming the surviving entries are immutable.
func TestChangelogAppendOnlyGitBaseline(t *testing.T) {
	dir := gitSeedExample(t)
	clPath := filepath.Join(dir, "docs", "context-changelog.json")
	cl := readChangelog(t, clPath)
	entries, _ := cl["entries"].([]any)
	entries = append(entries, map[string]any{
		"id": "zzz-new", "date": "2026-06-20", "type": "added",
		"summary":    "a newly appended entry",
		"paths":      []any{"docs/domain/glossary.md"},
		"categories": []any{"domain"},
	})
	cl["entries"] = entries
	out, _ := json.MarshalIndent(cl, "", "  ")
	if err := os.WriteFile(clPath, append(out, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	m := manifest.LoadManifest(dir).Manifest
	res := validate.CheckChangelogAppendOnly(dir, m.Machine.ChangelogPath, false)
	for _, f := range res.Findings {
		if f.Severity == findings.Error {
			t.Fatalf("appending a new entry should be allowed, got error %v", res.Findings)
		}
	}
	if !res.Verified {
		t.Fatal("expected the changelog to verify against the git baseline")
	}
}

// Removing an entry from other than the oldest end is an append-only violation.
// Exercises the removal-detection path, the canonical (date,id) sort, and the
// pluralized diagnostic.
func TestChangelogIllegalRemovalDetected(t *testing.T) {
	dir := gitSeedExample(t)
	clPath := filepath.Join(dir, "docs", "context-changelog.json")
	cl := readChangelog(t, clPath)
	entries, _ := cl["entries"].([]any)
	if len(entries) < 2 {
		t.Skip("example changelog needs 2+ entries for this case")
	}
	// drop the newest entry (not the oldest end) -> illegal removal
	cl["entries"] = entries[:len(entries)-1]
	out, _ := json.MarshalIndent(cl, "", "  ")
	if err := os.WriteFile(clPath, append(out, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	m := manifest.LoadManifest(dir).Manifest
	res := validate.CheckChangelogAppendOnly(dir, m.Machine.ChangelogPath, false)
	violated := false
	for _, f := range res.Findings {
		if f.Rule == "changelog-append-only" {
			violated = true
		}
	}
	if !violated {
		t.Fatalf("removing a non-oldest entry should yield a changelog-append-only finding, got %v", res.Findings)
	}
}

func gitCommitAll(t *testing.T, dir string) {
	t.Helper()
	for _, args := range [][]string{{"init", "-q"}, {"config", "user.email", "t@e.com"}, {"config", "user.name", "T"}, {"add", "-A"}, {"commit", "-qm", "seed"}} {
		c := exec.Command("git", args...)
		c.Dir = dir
		if o, err := c.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, o)
		}
	}
}

// Proves the (date, id) tiebreak (machine-readable-surface.md: (date,id) is a total
// order even when dates tie). HEAD's array order [bbb, aaa] is the REVERSE of the
// canonical order [aaa, bbb] (same date; "aaa" < "bbb"), so canonical-oldest is aaa
// and newest is bbb. Dropping bbb is illegal "from other than the oldest end" only
// if the verifier sorts by (date, id); an array-order impl would treat bbb as oldest
// and not flag it. Asserting that specific violation proves the tiebreak ran.
func TestChangelogSameDateTiebreakOrder(t *testing.T) {
	dir := copyTree(t, exampleDir(t))
	clPath := filepath.Join(dir, "docs", "context-changelog.json")
	mk := func(id, path, cat string) map[string]any {
		return map[string]any{"id": id, "date": "2026-06-10", "type": "added", "summary": id, "paths": []any{path}, "categories": []any{cat}}
	}
	head := map[string]any{
		"$schema":       "https://leji.org/schemas/v1.0/context-changelog.schema.json",
		"schemaVersion": "1.0",
		"entries":       []any{mk("bbb", "docs/system/invariants.md", "system"), mk("aaa", "docs/domain/glossary.md", "domain")},
	}
	b, _ := json.MarshalIndent(head, "", "  ")
	if err := os.WriteFile(clPath, append(b, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCommitAll(t, dir)
	cur := map[string]any{
		"$schema":       head["$schema"],
		"schemaVersion": "1.0",
		"entries":       []any{mk("aaa", "docs/domain/glossary.md", "domain")},
	}
	b2, _ := json.MarshalIndent(cur, "", "  ")
	if err := os.WriteFile(clPath, append(b2, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	m := manifest.LoadManifest(dir).Manifest
	res := validate.CheckChangelogAppendOnly(dir, m.Machine.ChangelogPath, false)
	proved := false
	for _, f := range res.Findings {
		if f.Rule == "changelog-append-only" && strings.Contains(f.Message, "other than the oldest end") {
			proved = true
		}
	}
	if !proved {
		t.Fatalf("dropping the canonically-newest same-date entry must violate via the (date,id) tiebreak, got %v", res.Findings)
	}
}
