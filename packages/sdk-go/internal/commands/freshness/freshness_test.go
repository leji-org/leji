package freshness

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

// buildLayer writes a minimal core manifest with a single domain category and
// returns the root. Callers add category docs with freshness frontmatter.
func buildLayer(t *testing.T) string {
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
		"owners": map[string]any{"primary": map[string]any{"name": "Owner"}},
	}
	mb, _ := json.MarshalIndent(man, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "leji.json"), mb, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "docs", "domain"), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func writeDoc(t *testing.T, dir, rel, reviewAfter, body string) {
	t.Helper()
	fm := ""
	if reviewAfter != "" {
		fm = fmt.Sprintf("---\nfreshness:\n  reviewAfter: %s\n---\n\n", reviewAfter)
	}
	abs := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(fm+body), 0o644); err != nil {
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

func dateOffset(days int) string {
	return time.Now().UTC().AddDate(0, 0, days).Format("2006-01-02")
}

func TestFreshnessReportCountsAndCategories(t *testing.T) {
	dir := buildLayer(t)
	// expired: a horizon in the past.
	writeDoc(t, dir, "docs/domain/old.md", dateOffset(-10), "# Old")
	// upcoming: within the 30-day horizon.
	writeDoc(t, dir, "docs/domain/soon.md", dateOffset(7), "# Soon")
	// far future: declared but neither expired nor upcoming.
	writeDoc(t, dir, "docs/domain/later.md", dateOffset(400), "# Later")
	// no freshness frontmatter: not counted as declared.
	writeDoc(t, dir, "docs/domain/none.md", "", "# None")

	m := loadManifest(t, dir)
	rep := FreshnessReport(dir, m, false)

	if rep.Declared != 3 {
		t.Fatalf("declared = %d, want 3", rep.Declared)
	}
	if len(rep.Expired) != 1 || rep.Expired[0].Path != "docs/domain/old.md" {
		t.Fatalf("expired wrong: %+v", rep.Expired)
	}
	if len(rep.Upcoming) != 1 || rep.Upcoming[0].Path != "docs/domain/soon.md" {
		t.Fatalf("upcoming wrong: %+v", rep.Upcoming)
	}
	// Non-strict: the expired horizon is a warning, not an error.
	if len(rep.Findings) != 1 || rep.Findings[0].Severity != findings.Warning {
		t.Fatalf("non-strict findings wrong: %+v", rep.Findings)
	}
	if rep.Findings[0].Rule != "freshness-expired" {
		t.Fatalf("rule wrong: %+v", rep.Findings[0])
	}
}

func TestFreshnessReportStrictRaisesToError(t *testing.T) {
	dir := buildLayer(t)
	writeDoc(t, dir, "docs/domain/old.md", dateOffset(-1), "# Old")
	m := loadManifest(t, dir)

	rep := FreshnessReport(dir, m, true)
	if len(rep.Findings) != 1 || rep.Findings[0].Severity != findings.Error {
		t.Fatalf("strict should raise to error: %+v", rep.Findings)
	}
}

func TestFreshnessReportEmptyWhenNoHorizons(t *testing.T) {
	dir := buildLayer(t)
	writeDoc(t, dir, "docs/domain/a.md", "", "# A")
	m := loadManifest(t, dir)
	rep := FreshnessReport(dir, m, false)
	if rep.Declared != 0 || len(rep.Expired) != 0 || len(rep.Upcoming) != 0 || len(rep.Findings) != 0 {
		t.Fatalf("expected an empty report, got %+v", rep)
	}
}
