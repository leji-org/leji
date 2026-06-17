package docs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/indexgen"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

func exampleCopy(t *testing.T) string {
	t.Helper()
	wd, _ := os.Getwd()
	src := filepath.Join(wd, "..", "..", "..", "..", "..", "examples", "monorepo")
	dst := t.TempDir()
	if err := os.CopyFS(dst, os.DirFS(src)); err != nil {
		t.Fatalf("copy example: %v", err)
	}
	return dst
}

func TestGenerateDocsProjectsViewer(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	res, err := GenerateDocs(dir, m)
	if err != nil {
		t.Fatalf("GenerateDocs: %v", err)
	}
	if res.Entries == 0 {
		t.Fatal("expected indexed entries, got 0")
	}
	// both viewer files land under the context root
	for _, name := range []string{"index.html", "_sidebar.md"} {
		if _, err := os.Stat(filepath.Join(dir, m.RootPath, name)); err != nil {
			t.Fatalf("expected generated %s under the context root: %v", name, err)
		}
	}
}

func TestBuildSidebarProjection(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	idx, err := indexgen.WriteIndex(dir, m)
	if err != nil || idx.Index == nil {
		t.Fatalf("WriteIndex: %v", err)
	}
	sb := BuildSidebar(m, idx.Index.Entries)
	if !strings.Contains(sb, "](") {
		t.Fatalf("expected markdown links in the sidebar, got: %s", sb)
	}
	// a real indexed doc is projected into the sidebar
	if !strings.Contains(sb, "glossary") {
		t.Fatalf("expected the glossary doc to appear in the sidebar, got: %s", sb)
	}
}
