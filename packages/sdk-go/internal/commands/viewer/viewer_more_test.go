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
	for _, name := range []string{"index.html", "_sidebar.md"} {
		if _, err := os.Stat(filepath.Join(dir, m.RootPath, ".leji", "viewer", name)); err != nil {
			t.Fatalf("expected generated %s under the viewer dir: %v", name, err)
		}
	}
	wantAssets := []string{
		"docsify-copy-code.min.js",
		"docsify-mermaid.js",
		"docsify-sidebar-collapse.min.css",
		"docsify-sidebar-collapse.min.js",
		"docsify.min.js",
		"fonts-licenses.txt",
		"leji-logo.svg",
		"mermaid.min.js",
		"prism-bash.min.js",
		"prism-json.min.js",
		"prism-markdown.min.js",
		"prism-typescript.min.js",
		"roboto-mono-400-latin-ext.woff2",
		"roboto-mono-400-latin.woff2",
		"roboto-mono-400-vietnamese.woff2",
		"search.min.js",
		"source-sans-pro-300-latin-ext.woff2",
		"source-sans-pro-300-latin.woff2",
		"source-sans-pro-300-vietnamese.woff2",
		"source-sans-pro-400-latin-ext.woff2",
		"source-sans-pro-400-latin.woff2",
		"source-sans-pro-400-vietnamese.woff2",
		"source-sans-pro-600-latin-ext.woff2",
		"source-sans-pro-600-latin.woff2",
		"source-sans-pro-600-vietnamese.woff2",
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
	want = append(want, viewerRel+"/_manifest.md")
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
	sb := BuildSidebar(m, BuildSidebarGroups(dir, m, idx.Index.Entries), nil, nil, false)
	if !strings.Contains(sb, "](") {
		t.Fatalf("expected markdown links in the sidebar, got: %s", sb)
	}
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
	if !strings.Contains(s, "```mermaid\nflowchart LR") {
		t.Fatal("expected the map to be a mermaid flowchart")
	}
	if !strings.Contains(s, "boot --> cat_domain") {
		t.Fatal("expected boot to link to the domain category")
	}
	if !strings.Contains(s, "cat_domain[\"📖 Domain · 1 doc\"]") {
		t.Fatal("expected categories to carry counts, never per-doc nodes")
	}
	if strings.Contains(s, "n_glossary") {
		t.Fatal("expected no per-document nodes (unreadable at scale)")
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
	if !strings.Contains(s, "```mermaid\nflowchart LR") {
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

// Mirrors the Node test: homepage, favicon, and pins accept repo-relative and
// root-relative forms, and an unresolvable homepage warns (viewer-path-missing).
func TestViewerPathFormsAndMissingHomepageWarns(t *testing.T) {
	dir := exampleCopy(t)
	if err := os.WriteFile(filepath.Join(dir, "docs", "HOME.md"), []byte("# Home\n"), 0o644); err != nil {
		t.Fatalf("write HOME.md: %v", err)
	}
	m := manifest.LoadManifest(dir).Manifest
	disabled := false
	m.Viewer = &manifest.Viewer{
		Mermaid:  &disabled,
		Homepage: "docs/HOME.md",                                     // repo-relative: normalized to HOME.md
		Favicon:  "docs/HOME.md",                                     // repo-relative: content URL must not double the root
		Pins:     []manifest.ViewerPin{{Path: "domain/glossary.md"}}, // rootPath-relative pin (canonical form is repo-relative)
	}
	res, err := GenerateViewer(dir, m)
	if err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	for _, f := range res.Findings {
		if f.Rule == "viewer-path-missing" {
			t.Fatalf("expected no viewer-path-missing finding, got: %v", f)
		}
	}
	html, err := os.ReadFile(filepath.Join(dir, "docs", ".leji", "viewer", "index.html"))
	if err != nil {
		t.Fatalf("read index.html: %v", err)
	}
	if !strings.Contains(string(html), `"homepage":"HOME.md"`) {
		t.Fatal("expected the repo-relative homepage normalized")
	}
	if !strings.Contains(string(html), "/content/HOME.md") {
		t.Fatal("expected the favicon URL normalized under the content mount")
	}
	sidebar, err := os.ReadFile(filepath.Join(dir, "docs", ".leji", "viewer", "_sidebar.md"))
	if err != nil {
		t.Fatalf("read _sidebar.md: %v", err)
	}
	top := strings.SplitN(string(sidebar), "---", 2)[0]
	if !strings.Contains(top, "](domain/glossary.md)") {
		t.Fatalf("expected the rootPath-relative pin resolved into the top zone, got: %q", top)
	}
	// An unresolvable homepage is kept as authored and warned about, never silent.
	m.Viewer = &manifest.Viewer{Mermaid: &disabled, Homepage: "docs/NOPE.md"}
	bad, err := GenerateViewer(dir, m)
	if err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	warned := false
	for _, f := range bad.Findings {
		if f.Rule == "viewer-path-missing" {
			warned = true
		}
	}
	if !warned {
		t.Fatal("expected a viewer-path-missing warning for an unresolvable homepage")
	}
}

// Pinning the boot profile replaces its default sidebar line with the pin's own
// label and position (the team's to curate).
func TestViewerBootPinReplacesDefaultLine(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	disabled := false
	m.Viewer = &manifest.Viewer{
		Mermaid: &disabled,
		Pins:    []manifest.ViewerPin{{Path: "docs/boot-profile.md", Label: "🚀 Start here"}},
	}
	if _, err := GenerateViewer(dir, m); err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	sidebar, err := os.ReadFile(filepath.Join(dir, "docs", ".leji", "viewer", "_sidebar.md"))
	if err != nil {
		t.Fatalf("read _sidebar.md: %v", err)
	}
	if strings.Contains(string(sidebar), "🤖 Boot profile") {
		t.Fatalf("expected the default boot line replaced by the pin, got: %q", sidebar)
	}
	if !strings.Contains(string(sidebar), "- [🚀 Start here](boot-profile.md)") {
		t.Fatalf("expected the curated boot pin label, got: %q", sidebar)
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

// Mirrors the Node test: viewer build exports a self-contained static folder
// carrying the protect warning, and refuses an escaping, root, or absolute --out.
func TestBuildViewerExportsAndRejects(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	r, err := BuildViewer(dir, m, "out")
	if err != nil {
		t.Fatalf("BuildViewer: %v", err)
	}
	if r.Out != "out" {
		t.Fatalf("out = %q, want %q", r.Out, "out")
	}
	out := filepath.Join(dir, "out")
	// Chrome at the web root; the layer's markdown under /content/.
	for _, rel := range []string{
		"index.html",
		"assets/docsify.min.js",
		"content/boot-profile.md",
		"content/overview.md",
		"content/_sidebar.md",
		"content/domain/glossary.md",
	} {
		if _, err := os.Stat(filepath.Join(out, rel)); err != nil {
			t.Fatalf("expected exported %s: %v", rel, err)
		}
	}
	// The contained, regenerable .leji/ is never exported into the content.
	if _, err := os.Stat(filepath.Join(out, "content", ".leji")); err == nil {
		t.Fatal("expected .leji to be excluded from the export")
	}
	html, err := os.ReadFile(filepath.Join(out, "index.html"))
	if err != nil {
		t.Fatalf("read exported index.html: %v", err)
	}
	if !strings.HasPrefix(string(html), "<!--") {
		t.Fatal("expected the warning comment prepended")
	}
	if !strings.Contains(string(html), "Host the exported folder behind internal authentication") {
		t.Fatal("expected the protect-your-context warning in the exported index.html")
	}
	// Escaping, repo-root, and absolute outputs are refused before any removal.
	for _, bad := range []string{"../escape", ".", t.TempDir()} {
		if _, err := BuildViewer(dir, m, bad); err == nil || !strings.Contains(err.Error(), "refusing to build the viewer") {
			t.Fatalf("BuildViewer(%q): expected the containment refusal, got %v", bad, err)
		}
	}
}

// The reported reproduction: exporting into a governed directory used to rm -rf it
// and then recurse into its own output until the paths grew too long. The context
// root, anything inside it, and anything containing it are all refused.
func TestBuildViewerRefusesOutInsideTheContextRoot(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	glossary := filepath.Join(dir, "docs", "domain", "glossary.md")
	before, err := os.ReadFile(glossary)
	if err != nil {
		t.Fatalf("read glossary: %v", err)
	}
	for _, bad := range []string{"docs/domain", "docs"} {
		if _, err := BuildViewer(dir, m, bad); err == nil || !strings.Contains(err.Error(), "refusing to build the viewer") {
			t.Fatalf("BuildViewer(%q): expected the containment refusal, got %v", bad, err)
		}
	}
	after, err := os.ReadFile(glossary)
	if err != nil {
		t.Fatalf("glossary gone after the refusal: %v", err)
	}
	if string(after) != string(before) {
		t.Fatal("governed content changed despite the refusal")
	}
}

// The export clears a previous export (recognized by its own marker comment) and
// refuses any other occupied directory.
func TestBuildViewerClearsOnlyItsOwnExport(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	if _, err := BuildViewer(dir, m, "out"); err != nil {
		t.Fatalf("BuildViewer: %v", err)
	}
	stale := filepath.Join(dir, "out", "stale.txt")
	if err := os.WriteFile(stale, []byte("from the previous export"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := BuildViewer(dir, m, "out"); err != nil {
		t.Fatalf("rebuild into a previous export: %v", err)
	}
	if _, err := os.Stat(stale); err == nil {
		t.Fatal("expected a previous export to be rebuilt clean")
	}
	// An occupied directory that is not an export is somebody's content.
	occupied := filepath.Join(dir, "notes")
	if err := os.MkdirAll(occupied, 0o755); err != nil {
		t.Fatal(err)
	}
	keep := filepath.Join(occupied, "keep.md")
	if err := os.WriteFile(keep, []byte("# keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := BuildViewer(dir, m, "notes"); err == nil ||
		!strings.Contains(err.Error(), "neither empty nor a previous viewer export") {
		t.Fatalf("BuildViewer(notes): expected the occupied-target refusal, got %v", err)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatalf("the occupied target was touched: %v", err)
	}
	// An empty directory is a fine target.
	if err := os.MkdirAll(filepath.Join(dir, "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := BuildViewer(dir, m, "empty"); err != nil {
		t.Fatalf("BuildViewer(empty): %v", err)
	}
}

// Active file types never ride into the export: a static host would serve them as
// same-origin documents. The viewer's own vendored assets are unaffected.
func TestBuildViewerExcludesActiveContentTypes(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	for name, body := range map[string]string{
		"evil.html": "<script>alert(1)</script>",
		"evil.svg":  `<svg xmlns="http://www.w3.org/2000/svg"></svg>`,
	} {
		if err := os.WriteFile(filepath.Join(dir, "docs", name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := BuildViewer(dir, m, "out"); err != nil {
		t.Fatalf("BuildViewer: %v", err)
	}
	out := filepath.Join(dir, "out")
	if _, err := os.Stat(filepath.Join(out, "content", "evil.html")); err == nil {
		t.Fatal("expected content/evil.html to be excluded from the export")
	}
	// SVG stays a first-class asset: viewer.logo/viewer.favicon may point at one
	// under the context root, and an SVG in an <img> never executes script.
	if _, err := os.Stat(filepath.Join(out, "content", "evil.svg")); err != nil {
		t.Fatalf("expected content/evil.svg to still be exported: %v", err)
	}
	for _, rel := range []string{"index.html", "assets/docsify.min.js"} {
		if _, err := os.Stat(filepath.Join(out, rel)); err != nil {
			t.Fatalf("expected the chrome's %s to survive: %v", rel, err)
		}
	}
	html, err := os.ReadFile(filepath.Join(out, "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	// Only the prepended warning comment, not the page below it (whose favicon
	// link legitimately names the vendored leji-logo.svg).
	warning, _, _ := strings.Cut(string(html), "-->")
	if !strings.Contains(warning, "Active file types") {
		t.Fatal("expected the export warning to name the exclusion")
	}
	if strings.Contains(warning, ".svg") {
		t.Fatal("the warning must not claim SVG is excluded")
	}
}

// Both values name other placeholders: with sequential substitution passes they
// were expanded a second time, injecting a literal </script> into the JSON island
// and breaking out of the favicon's href attribute.
func TestGenerateViewerHostileManifestCannotBreakOut(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	if m.Viewer == nil {
		m.Viewer = &manifest.Viewer{}
	}
	m.Viewer.Title = "{{MERMAID_SCRIPTS}}"
	m.Viewer.Favicon = "{{DOCSIFY_CONFIG}}"
	if _, err := GenerateViewer(dir, m); err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	page, err := os.ReadFile(filepath.Join(dir, "docs", ".leji", "viewer", "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	html := string(page)
	if !strings.Contains(html, "<title>{{MERMAID_SCRIPTS}}</title>") {
		t.Fatal("expected the hostile title to stay a literal")
	}
	if !strings.Contains(html, `href="/content/{{DOCSIFY_CONFIG}}"`) {
		t.Fatal("expected the hostile favicon to stay inside its attribute")
	}
	if got, want := strings.Count(html, "<script"), 14; got != want {
		t.Fatalf("script tags = %d, want %d (nothing injected)", got, want)
	}
}

// An unusable accent is refused with a warning rather than interpolated into a
// stylesheet; a plain color is kept as authored.
func TestGenerateViewerRejectsUnsafeThemeColor(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	if m.Viewer == nil {
		m.Viewer = &manifest.Viewer{}
	}
	m.Viewer.Theme = &manifest.Theme{Primary: "red; } body { display: none } /*"}
	res, err := GenerateViewer(dir, m)
	if err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	page, err := os.ReadFile(filepath.Join(dir, "docs", ".leji", "viewer", "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(page), `"themeColor":"#223F93"`) {
		t.Fatal("expected the accent to fall back to the default")
	}
	warned := false
	for _, f := range res.Findings {
		if f.Rule == "viewer-theme-invalid" && f.Severity == findings.Warning {
			warned = true
		}
	}
	if !warned {
		t.Fatal("expected the rejected accent to be surfaced")
	}
	m.Viewer.Theme = &manifest.Theme{Primary: "#ff0000"}
	if _, err := GenerateViewer(dir, m); err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	page, err = os.ReadFile(filepath.Join(dir, "docs", ".leji", "viewer", "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(page), `"themeColor":"#ff0000"`) {
		t.Fatal("expected a plain color to be kept as authored")
	}
}

// A manifest label carrying HTML reaches the generated sidebar verbatim, so the
// angle brackets are escaped there.
func TestGenerateViewerEscapesHTMLInSidebarLabels(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	if m.Viewer == nil {
		m.Viewer = &manifest.Viewer{}
	}
	m.Viewer.AgentsLabel = "<img src=x onerror=alert(1)>"
	if _, err := GenerateViewer(dir, m); err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	sidebar, err := os.ReadFile(filepath.Join(dir, "docs", ".leji", "viewer", "_sidebar.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(sidebar), `\<img src=x onerror=alert(1)\>`) {
		t.Fatalf("expected the angle brackets escaped, got %q", string(sidebar))
	}
}
