package changelog

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

const changelogRel = "docs/context-changelog.json"

// seedLayer writes a minimal indexed manifest plus a changelog carrying `count`
// dated entries (e-01 .. e-NN, dated 2026-01-01 onward) and returns the root.
func seedLayer(t *testing.T, count int) string {
	t.Helper()
	dir := t.TempDir()
	man := map[string]any{
		"leji":            "1.0",
		"name":            "fixture",
		"rootPath":        "docs/",
		"bootProfilePath": "docs/boot-profile.md",
		"categories": map[string]any{
			"domain":    map[string]any{"paths": []any{"docs/domain/"}},
			"decisions": map[string]any{"paths": []any{"docs/decisions/"}},
		},
		"owners": map[string]any{"primary": map[string]any{"name": "Fixture Owner"}},
		"conformance": map[string]any{
			"claimedLevel": "indexed",
		},
	}
	mb, _ := json.MarshalIndent(man, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "leji.json"), mb, 0o644); err != nil {
		t.Fatal(err)
	}
	writeChangelog(t, dir, count)
	return dir
}

func writeChangelog(t *testing.T, dir string, count int) {
	t.Helper()
	entries := make([]map[string]any, 0, count)
	for i := 0; i < count; i++ {
		entries = append(entries, map[string]any{
			"id":      fmt.Sprintf("e-%02d", i+1),
			"date":    fmt.Sprintf("2026-01-%02d", i+1),
			"type":    "added",
			"summary": fmt.Sprintf("Change %d.", i+1),
			"paths":   []any{fmt.Sprintf("docs/file-%d.md", i+1)},
		})
	}
	log := map[string]any{
		"$schema":       "https://leji.org/schemas/v1.0/context-changelog.schema.json",
		"schemaVersion": "1.0",
		"entries":       entries,
	}
	lb, _ := json.MarshalIndent(log, "", "  ")
	abs := filepath.Join(dir, filepath.FromSlash(changelogRel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, append(lb, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

func loadManifest(t *testing.T, dir string) *manifest.Manifest {
	t.Helper()
	res := manifest.LoadManifest(dir)
	if res.Manifest == nil {
		t.Fatalf("load manifest: %v", res.Findings)
	}
	return res.Manifest
}

func readChangelog(t *testing.T, dir string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(changelogRel)))
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func entriesOf(log map[string]any) []map[string]any {
	raw, _ := log["entries"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, e := range raw {
		if obj, ok := e.(map[string]any); ok {
			out = append(out, obj)
		}
	}
	return out
}

func hasRule(fs []findings.Finding, rule string) bool {
	for _, f := range fs {
		if f.Rule == rule {
			return true
		}
	}
	return false
}

func TestCompactRejectsInvalidKeep(t *testing.T) {
	for _, keep := range []int{0, -1, -5} {
		dir := seedLayer(t, 5)
		before, _ := os.ReadFile(filepath.Join(dir, filepath.FromSlash(changelogRel)))
		res := CompactChangelog(dir, loadManifest(t, dir), CompactOptions{Keep: keep, HasKeep: true})
		if res.Folded != 0 || res.Kept != 0 {
			t.Fatalf("keep=%d should not fold: %+v", keep, res)
		}
		if len(res.Findings) != 1 || res.Findings[0].Rule != "invalid-argument" {
			t.Fatalf("keep=%d expected invalid-argument, got %+v", keep, res.Findings)
		}
		if !strings.Contains(res.Findings[0].Message, "keep must be a positive integer") {
			t.Fatalf("unexpected message: %q", res.Findings[0].Message)
		}
		after, _ := os.ReadFile(filepath.Join(dir, filepath.FromSlash(changelogRel)))
		if string(before) != string(after) {
			t.Fatal("file mutated on invalid keep")
		}
	}
}

func TestCompactRejectsMalformedBefore(t *testing.T) {
	for _, before := range []string{"2026-1-1", "nope", "2026/01/01", "20260101"} {
		dir := seedLayer(t, 5)
		res := CompactChangelog(dir, loadManifest(t, dir), CompactOptions{Before: before, HasBefore: true})
		if res.Folded != 0 {
			t.Fatalf("before=%q should not fold", before)
		}
		if len(res.Findings) != 1 || res.Findings[0].Rule != "invalid-argument" {
			t.Fatalf("before=%q expected invalid-argument, got %+v", before, res.Findings)
		}
		if !strings.Contains(res.Findings[0].Message, "before must be a YYYY-MM-DD date") {
			t.Fatalf("unexpected message: %q", res.Findings[0].Message)
		}
	}
}

func TestCompactMissingChangelogIsRequired(t *testing.T) {
	dir := seedLayer(t, 5)
	if err := os.Remove(filepath.Join(dir, filepath.FromSlash(changelogRel))); err != nil {
		t.Fatal(err)
	}
	res := CompactChangelog(dir, loadManifest(t, dir), CompactOptions{Keep: 2, HasKeep: true})
	if res.Folded != 0 || !hasRule(res.Findings, "changelog-required") {
		t.Fatalf("expected changelog-required, got %+v", res)
	}
}

func TestCompactNoOpWhenNothingFolds(t *testing.T) {
	// keep larger than the entry count folds nothing.
	dir := seedLayer(t, 5)
	before, _ := os.ReadFile(filepath.Join(dir, filepath.FromSlash(changelogRel)))
	res := CompactChangelog(dir, loadManifest(t, dir), CompactOptions{Keep: 10, HasKeep: true})
	if res.Folded != 0 || len(res.Findings) != 0 || res.Kept != 5 {
		t.Fatalf("keep>count should be a clean no-op: %+v", res)
	}
	after, _ := os.ReadFile(filepath.Join(dir, filepath.FromSlash(changelogRel)))
	if string(before) != string(after) {
		t.Fatal("no-op must not rewrite the file")
	}

	// before earlier than every entry also folds nothing.
	res = CompactChangelog(dir, loadManifest(t, dir), CompactOptions{Before: "2025-01-01", HasBefore: true})
	if res.Folded != 0 || len(res.Findings) != 0 {
		t.Fatalf("before earlier than all should be a no-op: %+v", res)
	}
}

func TestCompactByKeepFoldsOldest(t *testing.T) {
	dir := seedLayer(t, 10)
	res := CompactChangelog(dir, loadManifest(t, dir), CompactOptions{Keep: 4, HasKeep: true})
	if res.Folded != 6 || res.Kept != 5 {
		t.Fatalf("keep 4 of 10: folded=%d kept=%d", res.Folded, res.Kept)
	}
	es := entriesOf(readChangelog(t, dir))
	gotIDs := []string{}
	for _, e := range es {
		gotIDs = append(gotIDs, e["id"].(string))
	}
	want := []string{"e-07", "e-08", "e-09", "e-10"}
	for i, id := range want {
		if gotIDs[i] != id {
			t.Fatalf("survivors order wrong: %v", gotIDs)
		}
	}
	c := es[len(es)-1]
	if c["type"] != "compaction" {
		t.Fatalf("last entry is not a compaction: %+v", c)
	}
	comp := c["compacted"].(map[string]any)
	if comp["firstId"] != "e-01" || comp["lastId"] != "e-06" {
		t.Fatalf("compacted range wrong: %+v", comp)
	}
	if int(comp["entries"].(float64)) != 6 {
		t.Fatalf("compacted count wrong: %+v", comp)
	}
}

func TestCompactByBeforeAndBothFlags(t *testing.T) {
	dir := seedLayer(t, 10)
	// before only: dates 2026-01-01..05 fold (strictly before 2026-01-06).
	res := CompactChangelog(dir, loadManifest(t, dir), CompactOptions{Before: "2026-01-06", HasBefore: true})
	if res.Folded != 5 {
		t.Fatalf("before only folded=%d", res.Folded)
	}
	comp := entriesOf(readChangelog(t, dir))
	last := comp[len(comp)-1]["compacted"].(map[string]any)
	if last["firstId"] != "e-01" || last["lastId"] != "e-05" {
		t.Fatalf("before range wrong: %+v", last)
	}

	// both flags: intersection of keep 3 (folds e-01..e-07) and before 2026-01-04
	// (folds e-01..e-03) is e-01..e-03.
	dir2 := seedLayer(t, 10)
	res = CompactChangelog(dir2, loadManifest(t, dir2), CompactOptions{Keep: 3, HasKeep: true, Before: "2026-01-04", HasBefore: true})
	if res.Folded != 3 {
		t.Fatalf("both flags folded=%d", res.Folded)
	}
	es := entriesOf(readChangelog(t, dir2))
	c := es[len(es)-1]["compacted"].(map[string]any)
	if c["firstId"] != "e-01" || c["lastId"] != "e-03" {
		t.Fatalf("both range wrong: %+v", c)
	}
}

func TestCompactDedupesCompactionID(t *testing.T) {
	dir := seedLayer(t, 6)
	id := "compaction-" + today()
	log := readChangelog(t, dir)
	es := entriesOf(log)
	es[0]["id"] = id // collide with the id the compactor will pick
	asAny := make([]any, len(es))
	for i, e := range es {
		asAny[i] = e
	}
	log["entries"] = asAny
	lb, _ := json.MarshalIndent(log, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(changelogRel)), append(lb, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	res := CompactChangelog(dir, loadManifest(t, dir), CompactOptions{Keep: 2, HasKeep: true})
	if res.Folded == 0 {
		t.Fatal("expected a fold")
	}
	out := entriesOf(readChangelog(t, dir))
	got := out[len(out)-1]["id"].(string)
	if got != id+"-2" {
		t.Fatalf("expected deduped id %q-2, got %q", id, got)
	}
}

func TestCompactTiebreakByID(t *testing.T) {
	dir := seedLayer(t, 1)
	// Three entries on one date, shuffled; only the (date,id) tiebreak orders them.
	log := map[string]any{
		"$schema":       "https://leji.org/schemas/v1.0/context-changelog.schema.json",
		"schemaVersion": "1.0",
		"entries": []any{
			map[string]any{"id": "b", "date": "2026-01-01", "type": "added", "summary": "b", "paths": []any{"docs/b.md"}},
			map[string]any{"id": "c", "date": "2026-01-01", "type": "added", "summary": "c", "paths": []any{"docs/c.md"}},
			map[string]any{"id": "a", "date": "2026-01-01", "type": "added", "summary": "a", "paths": []any{"docs/a.md"}},
		},
	}
	lb, _ := json.MarshalIndent(log, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(changelogRel)), append(lb, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	res := CompactChangelog(dir, loadManifest(t, dir), CompactOptions{Keep: 1, HasKeep: true})
	if res.Folded != 2 {
		t.Fatalf("expected to fold 2, got %d", res.Folded)
	}
	es := entriesOf(readChangelog(t, dir))
	c := es[len(es)-1]["compacted"].(map[string]any)
	// Canonical order is a,b,c; keep 1 folds a and b.
	if c["firstId"] != "a" || c["lastId"] != "b" {
		t.Fatalf("tiebreak range wrong: %+v", c)
	}
	survivors := []string{}
	for _, e := range es {
		if e["type"] != "compaction" {
			survivors = append(survivors, e["id"].(string))
		}
	}
	if len(survivors) != 1 || survivors[0] != "c" {
		t.Fatalf("survivor should be c, got %v", survivors)
	}
}

func TestSeedChangelogIfMissing(t *testing.T) {
	// Core layer: not seeded.
	core := t.TempDir()
	man := map[string]any{
		"leji":            "1.0",
		"name":            "fixture",
		"rootPath":        "docs/",
		"bootProfilePath": "docs/boot-profile.md",
		"categories": map[string]any{
			"domain":    map[string]any{"paths": []any{"docs/domain/"}},
			"decisions": map[string]any{"paths": []any{"docs/decisions/"}},
		},
		"owners": map[string]any{"primary": map[string]any{"name": "Fixture Owner"}},
	}
	mb, _ := json.MarshalIndent(man, "", "  ")
	if err := os.WriteFile(filepath.Join(core, "leji.json"), mb, 0o644); err != nil {
		t.Fatal(err)
	}
	if rel, err := SeedChangelogIfMissing(core, loadManifest(t, core)); err != nil || rel != "" {
		t.Fatalf("core layer should not seed, got %q err %v", rel, err)
	}
	if _, err := os.Stat(filepath.Join(core, filepath.FromSlash(changelogRel))); !os.IsNotExist(err) {
		t.Fatal("core layer should not have a changelog")
	}

	// Indexed layer with no changelog: seeded.
	dir := seedLayer(t, 1)
	os.Remove(filepath.Join(dir, filepath.FromSlash(changelogRel)))
	rel, err := SeedChangelogIfMissing(dir, loadManifest(t, dir))
	if err != nil || rel != changelogRel {
		t.Fatalf("expected to seed %q, got %q err %v", changelogRel, rel, err)
	}
	es := entriesOf(readChangelog(t, dir))
	if len(es) != 1 || es[0]["id"] != "seed-changelog" {
		t.Fatalf("seeded changelog shape wrong: %+v", es)
	}
	if es[0]["approvedBy"] != "Fixture Owner" {
		t.Fatalf("approvedBy not the owner: %+v", es[0])
	}

	// Already present: not re-seeded.
	sentinel := readChangelog(t, dir)
	if rel, err := SeedChangelogIfMissing(dir, loadManifest(t, dir)); err != nil || rel != "" {
		t.Fatalf("present changelog should not re-seed, got %q err %v", rel, err)
	}
	again := readChangelog(t, dir)
	if fmt.Sprint(sentinel) != fmt.Sprint(again) {
		t.Fatal("present changelog was rewritten")
	}
}

func TestSerializeChangelogOrdering(t *testing.T) {
	out := serializeChangelog(map[string]any{
		"$schema":       "https://leji.org/schemas/v1.0/context-changelog.schema.json",
		"schemaVersion": "1.0",
		"metadata":      map[string]any{"source": "test"},
		"entries": []entry{
			{"id": "x", "date": "2026-01-01", "type": "added", "summary": "s", "zebra": 1, "alpha": 2},
		},
	})
	if !strings.HasSuffix(out, "}\n") {
		t.Fatal("missing trailing newline")
	}
	// $schema appears before schemaVersion before metadata before entries.
	iSchema := strings.Index(out, `"$schema"`)
	iVersion := strings.Index(out, `"schemaVersion"`)
	iMeta := strings.Index(out, `"metadata"`)
	iEntries := strings.Index(out, `"entries"`)
	if !(iSchema < iVersion && iVersion < iMeta && iMeta < iEntries) {
		t.Fatalf("top-level key order wrong: %s", out)
	}
	// Within the entry, known keys precede sorted extras: summary < alpha < zebra.
	iSummary := strings.Index(out, `"summary"`)
	iAlpha := strings.Index(out, `"alpha"`)
	iZebra := strings.Index(out, `"zebra"`)
	if !(iSummary < iAlpha && iAlpha < iZebra) {
		t.Fatalf("entry key order wrong: %s", out)
	}
	// Round-trips to valid JSON preserving the extra key.
	var parsed map[string]any
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("not valid JSON: %v", err)
	}
	if parsed["metadata"].(map[string]any)["source"] != "test" {
		t.Fatal("extra top-level key dropped")
	}
}
