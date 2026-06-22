package viewer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/indexgen"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
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

func TestGenerateViewerProjectsViewer(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	res, err := GenerateViewer(dir, m)
	if err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	if res.Entries == 0 {
		t.Fatal("expected indexed entries, got 0")
	}
	// both viewer files land under the contained viewer dir (rootPath/.leji/viewer)
	for _, name := range []string{"index.html", "_sidebar.md"} {
		if _, err := os.Stat(filepath.Join(dir, m.RootPath, ".leji", "viewer", name)); err != nil {
			t.Fatalf("expected generated %s under the viewer dir: %v", name, err)
		}
	}
	// the full sorted asset set lands under the viewer dir
	wantAssets := []string{
		"docsify-copy-code.min.js",
		"docsify-mermaid.js",
		"docsify-sidebar-collapse.min.css",
		"docsify-sidebar-collapse.min.js",
		"docsify.min.js",
		"leji-logo.svg",
		"mermaid.min.js",
		"prism-bash.min.js",
		"prism-json.min.js",
		"prism-markdown.min.js",
		"prism-typescript.min.js",
		"search.min.js",
		"viewer-boot.js",
		"vue.css",
		"zoom-image.min.js",
	}
	rootDir := strings.TrimRight(m.RootPath, "/")
	viewerRel := rootDir + "/.leji/viewer"
	want := []string{
		viewerRel + "/index.html",
		viewerRel + "/_sidebar.md",
	}
	for _, a := range wantAssets {
		want = append(want, viewerRel+"/assets/"+a)
	}
	want = append(want, rootDir+"/overview.md")
	if len(res.Written) != len(want) {
		t.Fatalf("written = %v, want %v", res.Written, want)
	}
	for i := range want {
		if res.Written[i] != want[i] {
			t.Fatalf("written[%d] = %q, want %q", i, res.Written[i], want[i])
		}
	}
	viewer := filepath.Join(dir, m.RootPath, ".leji", "viewer")
	html, err := os.ReadFile(filepath.Join(viewer, "index.html"))
	if err != nil {
		t.Fatalf("read index.html: %v", err)
	}
	if !strings.Contains(string(html), `"homepage":"overview.md"`) {
		t.Fatal("expected the overview to be the homepage")
	}
	// Mermaid is on by default: the two scripts + their assets are present.
	for _, s := range []string{"assets/mermaid.min.js", "assets/docsify-mermaid.js"} {
		if !strings.Contains(string(html), s) {
			t.Fatalf("expected %q wired into index.html by default", s)
		}
	}
	if _, err := os.Stat(filepath.Join(viewer, "assets", "mermaid.min.js")); err != nil {
		t.Fatalf("expected mermaid asset copied by default: %v", err)
	}
}

func TestGenerateViewerMermaidDisabled(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	disabled := false
	m.Viewer = &manifest.Viewer{Mermaid: &disabled}
	res, err := GenerateViewer(dir, m)
	if err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	viewer := filepath.Join(dir, m.RootPath, ".leji", "viewer")
	html, err := os.ReadFile(filepath.Join(viewer, "index.html"))
	if err != nil {
		t.Fatalf("read index.html: %v", err)
	}
	if strings.Contains(string(html), "mermaid.min.js") {
		t.Fatal("expected no mermaid script when disabled")
	}
	if strings.Contains(string(html), "docsify-mermaid.js") {
		t.Fatal("expected no mermaid plugin when disabled")
	}
	if _, err := os.Stat(filepath.Join(viewer, "assets", "mermaid.min.js")); err == nil {
		t.Fatal("expected mermaid asset not copied when disabled")
	}
	for _, w := range res.Written {
		if strings.Contains(w, "mermaid") {
			t.Fatalf("expected no mermaid entry in written, got %q", w)
		}
	}
	// The non-mermaid polish plugins still ship.
	if !strings.Contains(string(html), "docsify-copy-code.min.js") {
		t.Fatal("expected copy-code still wired when mermaid is off")
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

func TestGenerateViewerSeedsOverviewMap(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	if _, err := GenerateViewer(dir, m); err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	overview := filepath.Join(dir, m.RootPath, "overview.md")
	text, err := os.ReadFile(overview)
	if err != nil {
		t.Fatalf("expected overview.md seeded at the content root: %v", err)
	}
	s := string(text)
	if !strings.Contains(s, "# "+m.Name) {
		t.Fatalf("expected the overview titled with the layer name, got: %s", s)
	}
	if !strings.Contains(s, "<!-- leji:generated-map:start -->") {
		t.Fatal("expected the regen markers")
	}
	if !strings.Contains(s, "```mermaid\nflowchart TD") {
		t.Fatal("expected the map to be a mermaid flowchart")
	}
	if !strings.Contains(s, "boot --> cat_domain") {
		t.Fatal("expected boot to link to the domain category")
	}
	if !strings.Contains(s, "cat_domain --> n_glossary") {
		t.Fatal("expected the category to link to its docs")
	}
}

func TestGenerateViewerOverviewSeededOnce(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	if _, err := GenerateViewer(dir, m); err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	overview := filepath.Join(dir, m.RootPath, "overview.md")
	// The owner rewrites the prose but keeps the markers.
	edited := "# My own title\n\nHand-written intro.\n\n<!-- leji:generated-map:start -->\nstale\n<!-- leji:generated-map:end -->\n\nMore prose.\n"
	if err := os.WriteFile(overview, []byte(edited), 0o644); err != nil {
		t.Fatalf("write overview: %v", err)
	}
	res, err := GenerateViewer(dir, m)
	if err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	after, err := os.ReadFile(overview)
	if err != nil {
		t.Fatalf("read overview: %v", err)
	}
	s := string(after)
	if !strings.Contains(s, "# My own title") {
		t.Fatal("expected owner prose preserved")
	}
	if !strings.Contains(s, "More prose.") {
		t.Fatal("expected trailing prose preserved")
	}
	if !strings.Contains(s, "```mermaid\nflowchart TD") {
		t.Fatal("expected the stale map block to be refreshed")
	}
	if strings.Contains(s, "\nstale\n") {
		t.Fatal("expected old map content replaced")
	}
	for _, f := range res.Findings {
		if f.Rule == "overview-markers-missing" {
			t.Fatal("expected no warning when the markers are intact")
		}
	}
}

func TestGenerateViewerOverviewWithoutMarkersWarns(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	if _, err := GenerateViewer(dir, m); err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	overview := filepath.Join(dir, m.RootPath, "overview.md")
	custom := "# Fully custom\n\nNo markers here at all.\n"
	if err := os.WriteFile(overview, []byte(custom), 0o644); err != nil {
		t.Fatalf("write overview: %v", err)
	}
	res, err := GenerateViewer(dir, m)
	if err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	after, err := os.ReadFile(overview)
	if err != nil {
		t.Fatalf("read overview: %v", err)
	}
	if string(after) != custom {
		t.Fatal("a marker-less overview is never modified")
	}
	warned := false
	for _, f := range res.Findings {
		if f.Rule == "overview-markers-missing" && f.Severity == findings.Warning {
			warned = true
		}
	}
	if !warned {
		t.Fatal("expected a warning that the map was not refreshed")
	}
}
