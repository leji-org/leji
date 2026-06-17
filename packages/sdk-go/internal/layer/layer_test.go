package layer

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

// writeFile creates a file (and parents) under root using a POSIX-style rel path.
func writeFile(t *testing.T, root, rel, content string) {
	t.Helper()
	abs := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func newManifest() *manifest.Manifest {
	return &manifest.Manifest{
		BootProfilePath: "docs/boot-profile.md",
		Categories: map[string]manifest.CategoryMapping{
			"domain": {Paths: []string{"docs/domain/"}},
			"system": {Paths: []string{"docs/system/"}},
		},
		Machine: &manifest.Machine{
			AgentProfilesPath:   "docs/agents/",
			DecisionRecordsPath: "docs/decisions/",
		},
	}
}

func docPaths(docs []ScannedDoc) []string {
	out := make([]string, len(docs))
	for i, d := range docs {
		out[i] = d.RelPath
	}
	return out
}

func TestScanCategoriesExclusionsAndSort(t *testing.T) {
	root := t.TempDir()
	m := newManifest()
	writeFile(t, root, "docs/domain/glossary.md", "---\nid: g\n---\n\nbody")
	writeFile(t, root, "docs/domain/README.md", "# readme is excluded")
	writeFile(t, root, "docs/system/arch.md", "# arch")
	// boot profile lives under a category path but must be excluded
	writeFile(t, root, "docs/boot-profile.md", "# boot")
	// agent profile dir overlaps nothing here but is excluded by predicate
	writeFile(t, root, "docs/agents/tp.md", "---\nid: tp\n---\n")

	docs := ScanCategories(root, m)
	got := docPaths(docs)
	want := []string{"docs/domain/glossary.md", "docs/system/arch.md"}
	if len(got) != len(want) {
		t.Fatalf("scanned %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("doc[%d] = %q want %q", i, got[i], want[i])
		}
	}
	// Frontmatter is parsed: glossary carries id, arch does not.
	for _, d := range docs {
		if d.RelPath == "docs/domain/glossary.md" {
			if d.Frontmatter == nil || d.Frontmatter["id"] != "g" {
				t.Fatalf("glossary frontmatter not parsed: %#v", d.Frontmatter)
			}
			if d.Category != "domain" {
				t.Fatalf("glossary category = %q", d.Category)
			}
		}
	}
}

func TestScanCategoriesLongestDeclaredWins(t *testing.T) {
	root := t.TempDir()
	m := &manifest.Manifest{
		BootProfilePath: "docs/boot-profile.md",
		Categories: map[string]manifest.CategoryMapping{
			// domain claims everything under docs/, system claims the deeper path.
			"domain": {Paths: []string{"docs/"}},
			"system": {Paths: []string{"docs/system/"}},
		},
	}
	writeFile(t, root, "docs/system/arch.md", "# arch")
	docs := ScanCategories(root, m)
	if len(docs) != 1 {
		t.Fatalf("expected 1 doc, got %v", docPaths(docs))
	}
	if docs[0].Category != "system" {
		t.Fatalf("longest declared path should win: got category %q", docs[0].Category)
	}
}

func TestScanAgentProfilesValidatesFrontmatter(t *testing.T) {
	root := t.TempDir()
	m := newManifest()
	// missing frontmatter
	writeFile(t, root, "docs/agents/no-fm.md", "# just a heading\n")
	// readme is skipped
	writeFile(t, root, "docs/agents/README.md", "# skip me")

	profiles := ScanAgentProfiles(root, m)
	var sawNoFM bool
	for _, p := range profiles {
		if p.RelPath == "docs/agents/README.md" {
			t.Fatalf("README.md should be skipped")
		}
		if p.RelPath == "docs/agents/no-fm.md" {
			sawNoFM = true
			if len(p.Findings) == 0 {
				t.Fatalf("missing frontmatter should produce a finding")
			}
			if p.Findings[0].Message != "missing YAML frontmatter" {
				t.Fatalf("unexpected finding message: %q", p.Findings[0].Message)
			}
		}
	}
	if !sawNoFM {
		t.Fatalf("no-fm.md was not scanned")
	}
}

func TestScanAgentProfilesNilWhenNoMachine(t *testing.T) {
	if got := ScanAgentProfiles(t.TempDir(), &manifest.Manifest{}); got != nil {
		t.Fatalf("expected nil with no machine, got %#v", got)
	}
}

func TestScanDecisionRecordsDedupesAcrossDirs(t *testing.T) {
	root := t.TempDir()
	// machine.decisionRecordsPath and categories.decisions point at the same dir;
	// the same file must not be reported twice.
	m := &manifest.Manifest{
		Machine: &manifest.Machine{DecisionRecordsPath: "docs/decisions/"},
		Categories: map[string]manifest.CategoryMapping{
			"decisions": {Paths: []string{"docs/decisions/"}},
		},
	}
	writeFile(t, root, "docs/decisions/0001-pick-db.md", "# no frontmatter\n")
	got := ScanDecisionRecords(root, m)
	if len(got) != 1 {
		t.Fatalf("expected 1 deduped decision record, got %d (%v)", len(got), got)
	}
}

func TestDuplicateIDFindings(t *testing.T) {
	items := []IDItem{
		{ID: "DR-1", RelPath: "a.md"},
		{ID: "DR-1", RelPath: "b.md"}, // duplicate of a.md
		{ID: "DR-2", RelPath: "c.md"},
		{ID: "", RelPath: "d.md"},     // empty id skipped
		{ID: 42, RelPath: "e.md"},     // non-string id skipped
		{ID: "DR-1", RelPath: "a.md"}, // same id, same path: not a duplicate
	}
	fs := DuplicateIDFindings(items, "decision")
	if len(fs) != 1 {
		t.Fatalf("expected exactly 1 duplicate finding, got %d (%v)", len(fs), fs)
	}
	if fs[0].Path != "b.md" || fs[0].Rule != "id-duplicate" {
		t.Fatalf("unexpected duplicate finding: %#v", fs[0])
	}
}

func TestReadJSONArtifact(t *testing.T) {
	root := t.TempDir()

	// Missing file: nil value, no finding.
	v, f := ReadJSONArtifact(root, "docs/missing.json")
	if v != nil || f != nil {
		t.Fatalf("missing file should yield (nil,nil), got (%v,%v)", v, f)
	}

	// Valid JSON.
	writeFile(t, root, "docs/good.json", `{"k":1}`)
	v, f = ReadJSONArtifact(root, "docs/good.json")
	if f != nil {
		t.Fatalf("valid JSON produced finding: %#v", f)
	}
	obj, ok := v.(map[string]any)
	if !ok || obj["k"].(float64) != 1 {
		t.Fatalf("parsed JSON wrong: %#v", v)
	}

	// Invalid JSON: finding, nil value.
	writeFile(t, root, "docs/bad.json", "{ not json")
	v, f = ReadJSONArtifact(root, "docs/bad.json")
	if v != nil {
		t.Fatalf("invalid JSON should yield nil value")
	}
	if f == nil || f.Rule != "artifact-parse" {
		t.Fatalf("expected artifact-parse finding, got %#v", f)
	}
}
