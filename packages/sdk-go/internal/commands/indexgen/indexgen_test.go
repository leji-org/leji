package indexgen

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

func repoRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(wd, "..", "..", "..", "..", "..")
}

// copyExample copies the indexed example layer into a temp dir.
func copyExample(t *testing.T) string {
	t.Helper()
	src := filepath.Join(repoRoot(t), "examples", "monorepo")
	dir := t.TempDir()
	if err := os.CopyFS(dir, os.DirFS(src)); err != nil {
		t.Fatalf("copy example: %v", err)
	}
	return dir
}

func loadManifest(t *testing.T, dir string) *manifest.Manifest {
	t.Helper()
	res := manifest.LoadManifest(dir)
	if res.Manifest == nil {
		t.Fatalf("load manifest: %v", res.Findings)
	}
	return res.Manifest
}

func TestGenerateIndexStableIDs(t *testing.T) {
	dir := copyExample(t)
	m := loadManifest(t, dir)
	res := GenerateIndex(dir, m)
	if res.Index == nil {
		t.Fatalf("generate produced no index: %v", res.Findings)
	}
	for _, f := range res.Findings {
		if f.Severity == "error" {
			t.Fatalf("unexpected error finding: %+v", f)
		}
	}
	if len(res.Index.Entries) == 0 {
		t.Fatal("expected category entries")
	}
	// IDs are lowercase-hyphen and unique; regenerating yields the same ids.
	seen := map[string]bool{}
	for _, e := range res.Index.Entries {
		if seen[e.ID] {
			t.Fatalf("duplicate id %q", e.ID)
		}
		seen[e.ID] = true
		if e.ID == "" || strings.ToLower(e.ID) != e.ID {
			t.Fatalf("id not lowercase-hyphen: %q", e.ID)
		}
	}
	// Regenerating yields the same entries (ids/paths/hashes). The top-level
	// generatedAt timestamp is intentionally not stable, so compare entries only.
	second := GenerateIndex(dir, m)
	if len(second.Index.Entries) != len(res.Index.Entries) {
		t.Fatal("entry count changed across regenerations")
	}
	for i := range res.Index.Entries {
		a, b := res.Index.Entries[i], second.Index.Entries[i]
		if a.ID != b.ID || a.Path != b.Path || a.ContentHash != b.ContentHash {
			t.Fatalf("entry %d not stable: %+v vs %+v", i, a, b)
		}
	}
}

func TestCheckIndexFreshThenStale(t *testing.T) {
	dir := copyExample(t)
	m := loadManifest(t, dir)

	// The committed example ships a current index: CheckIndex is fresh.
	res := CheckIndex(dir, m)
	if res.Stale == nil || *res.Stale {
		t.Fatalf("committed example should be fresh: stale=%v findings=%v", res.Stale, res.Findings)
	}
	for _, f := range res.Findings {
		if f.Severity == "error" {
			t.Fatalf("fresh check should have no error findings: %+v", f)
		}
	}

	// Add a new category doc without regenerating the index: now stale.
	newDoc := filepath.Join(dir, "docs", "domain", "newterm.md")
	if err := os.WriteFile(newDoc, []byte("---\nsummary: A new term.\n---\n\n# New Term\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res = CheckIndex(dir, m)
	if res.Stale == nil || !*res.Stale {
		t.Fatalf("adding an unindexed doc should be stale: %+v", res)
	}
	found := false
	for _, f := range res.Findings {
		if f.Rule == "index-stale" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected index-stale finding, got %+v", res.Findings)
	}
}

func TestCheckIndexMissingIsRequired(t *testing.T) {
	dir := copyExample(t)
	m := loadManifest(t, dir)
	rel := manifest.EffectiveIndexPath(m)
	if err := os.Remove(filepath.Join(dir, filepath.FromSlash(rel))); err != nil {
		t.Fatal(err)
	}
	res := CheckIndex(dir, m)
	if res.Stale == nil || !*res.Stale {
		t.Fatalf("missing index should be stale: %+v", res)
	}
	found := false
	for _, f := range res.Findings {
		if f.Rule == "index-required" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected index-required, got %+v", res.Findings)
	}
}

func TestWriteIndexRoundTrips(t *testing.T) {
	dir := copyExample(t)
	m := loadManifest(t, dir)
	rel := manifest.EffectiveIndexPath(m)
	// Remove then write: the file is recreated and a follow-up check is fresh.
	if err := os.Remove(filepath.Join(dir, filepath.FromSlash(rel))); err != nil {
		t.Fatal(err)
	}
	res, err := WriteIndex(dir, m)
	if err != nil {
		t.Fatalf("write index: %v", err)
	}
	if res.Index == nil {
		t.Fatalf("write produced no index: %v", res.Findings)
	}
	if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(rel))); err != nil {
		t.Fatalf("index not written: %v", err)
	}
	check := CheckIndex(dir, m)
	if check.Stale == nil || *check.Stale {
		t.Fatalf("freshly written index should be fresh: %+v", check)
	}
}

func TestWriteIndexRefusesSymlinkEscape(t *testing.T) {
	dir := copyExample(t)
	outside := t.TempDir()
	// Point machine.indexPath under docs/evil, a symlink escaping the layer root.
	if err := os.Symlink(outside, filepath.Join(dir, "docs", "evil")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	m := loadManifest(t, dir)
	m.Machine = &manifest.Machine{IndexPath: "docs/evil/context-index.json"}

	res, err := WriteIndex(dir, m)
	if err != nil {
		t.Fatalf("write index returned error: %v", err)
	}
	found := false
	for _, f := range res.Findings {
		if strings.Contains(f.Message, "resolves outside the layer root") {
			found = true
		}
	}
	if !found {
		t.Fatalf("escape should be reported: %+v", res.Findings)
	}
	if _, err := os.Stat(filepath.Join(outside, "context-index.json")); !os.IsNotExist(err) {
		t.Fatal("nothing should be written outside the root")
	}
}
