package viewer

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
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

// writeUnder writes rel (forward-slashed, repo-relative) under dir, creating its
// parent directories.
func writeUnder(t *testing.T, dir, rel, text string) {
	t.Helper()
	abs := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatalf("mkdir for %s: %v", rel, err)
	}
	if err := os.WriteFile(abs, []byte(text), 0o644); err != nil {
		t.Fatalf("write %s: %v", rel, err)
	}
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
		if _, err := os.Stat(filepath.Join(dir, ".leji", "viewer", name)); err != nil {
			t.Fatalf("expected generated %s under the viewer dir: %v", name, err)
		}
	}
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
		"third-party-licenses.txt",
		"viewer-boot.js",
		"vue.css",
		"zoom-image.min.js",
	}
	rootDir := strings.TrimRight(m.RootPath, "/")
	// The chrome lives in the unified root `.leji/`, whatever rootPath is.
	viewerRel := ".leji/viewer"
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
	viewer := filepath.Join(dir, ".leji", "viewer")
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
	viewer := filepath.Join(dir, ".leji", "viewer")
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

func TestGenerateViewerSeedsOverviewWithEmptyMarkers(t *testing.T) {
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
		t.Fatal("expected the map markers")
	}
	// The map is derived from the index, so the seed carries the placement mark and
	// one line saying where the map comes from, never a copy of the map itself.
	between := strings.SplitN(s, "<!-- leji:generated-map:start -->\n", 2)[1]
	between = strings.SplitN(between, "\n<!-- leji:generated-map:end -->", 2)[0]
	if between != "<!-- the layer map is rendered here by the viewer and by leji export -->" {
		t.Fatalf("expected the markers to wrap exactly the rendering note, got: %q", between)
	}
	if strings.Contains(s, "```mermaid\nflowchart LR") {
		t.Fatal("expected no map written into the source file")
	}
	if !strings.Contains(s, "this file is never rewritten") {
		t.Fatal("expected the seed to say so in its own prose")
	}
}

func TestGenerateViewerRendersTheMapAndNeverWritesTheSource(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	if _, err := GenerateViewer(dir, m); err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	overview := filepath.Join(dir, m.RootPath, "overview.md")
	seeded, err := os.ReadFile(overview)
	if err != nil {
		t.Fatalf("read overview: %v", err)
	}
	// A second run over the same tree writes nothing: the seed happens once.
	if _, err := GenerateViewer(dir, m); err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	again, err := os.ReadFile(overview)
	if err != nil {
		t.Fatalf("read overview: %v", err)
	}
	if !bytes.Equal(again, seeded) {
		t.Fatal("expected a second run to leave the seeded page byte-identical")
	}
	// The owner rewrites the prose, keeps the markers, and leaves a stale map inside
	// them. Adding a document changes the counts the map would show.
	edited := "# My own title\n\nHand-written intro.\n\n<!-- leji:generated-map:start -->\nstale\n<!-- leji:generated-map:end -->\n\nMore prose.\n"
	if err := os.WriteFile(overview, []byte(edited), 0o644); err != nil {
		t.Fatalf("write overview: %v", err)
	}
	writeUnder(t, dir, "docs/domain/pricing.md", "# Pricing\n\nHow we price.\n")
	before := sha256.Sum256([]byte(edited))
	res, err := GenerateViewer(dir, m)
	if err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	after, err := os.ReadFile(overview)
	if err != nil {
		t.Fatalf("read overview: %v", err)
	}
	if sha256.Sum256(after) != before {
		t.Fatal("expected a reindex that changes the map to leave overview.md byte-identical")
	}
	for _, f := range res.Findings {
		if f.Rule == "overview-markers-missing" {
			t.Fatal("expected no warning when the markers are intact")
		}
	}
	// The map exists at render time, from the same entries the run projected.
	rendered, markersFound := RenderOverview(edited, m, res.IndexEntries)
	if !markersFound {
		t.Fatal("expected the markers to be the placement mark")
	}
	if !strings.Contains(rendered, "# My own title") {
		t.Fatal("expected owner prose preserved around the map")
	}
	if !strings.Contains(rendered, "More prose.") {
		t.Fatal("expected trailing prose preserved")
	}
	if strings.Contains(rendered, "\nstale\n") {
		t.Fatal("expected the stale block ignored, not merged")
	}
	if !strings.Contains(rendered, "cat_domain[\"📖 Domain · 2 docs\"]") {
		t.Fatal("expected the rendered counts to be the tree of today")
	}
	if !strings.Contains(rendered, "```mermaid\n"+buildLayerMap(m, res.IndexEntries)+"\n```") {
		t.Fatal("expected the map block to be buildLayerMap between fences")
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
	html, err := os.ReadFile(filepath.Join(dir, ".leji", "viewer", "index.html"))
	if err != nil {
		t.Fatalf("read index.html: %v", err)
	}
	if !strings.Contains(string(html), `"homepage":"HOME.md"`) {
		t.Fatal("expected the repo-relative homepage normalized")
	}
	if !strings.Contains(string(html), "/content/HOME.md") {
		t.Fatal("expected the favicon URL normalized under the content mount")
	}
	sidebar, err := os.ReadFile(filepath.Join(dir, ".leji", "viewer", "_sidebar.md"))
	if err != nil {
		t.Fatalf("read _sidebar.md: %v", err)
	}
	top := strings.SplitN(string(sidebar), "---", 2)[0]
	if !strings.Contains(top, "](/domain/glossary.md)") {
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
	sidebar, err := os.ReadFile(filepath.Join(dir, ".leji", "viewer", "_sidebar.md"))
	if err != nil {
		t.Fatalf("read _sidebar.md: %v", err)
	}
	if strings.Contains(string(sidebar), "🤖 Boot profile") {
		t.Fatalf("expected the default boot line replaced by the pin, got: %q", sidebar)
	}
	if !strings.Contains(string(sidebar), "- [🚀 Start here](/boot-profile.md)") {
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
		if f.Rule == "overview-markers-missing" && f.Severity == findings.Warning &&
			f.Message == "overview.md has no generated-map markers; the map is not rendered" {
			warned = true
		}
	}
	if !warned {
		t.Fatalf("expected a warning that the map has nowhere to render, got: %v", res.Findings)
	}
	// With nowhere to put it, the page renders as its own source bytes.
	if text, markersFound := RenderOverview(custom, m, res.IndexEntries); text != custom || markersFound {
		t.Fatalf("expected a marker-less page to render as its source, got %q / %v", text, markersFound)
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
	page, err := os.ReadFile(filepath.Join(dir, ".leji", "viewer", "index.html"))
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

// themeWarning is the one message a rejected accent produces, spelled out here so
// a change to the contract's wording fails the suite rather than shipping.
func themeWarning(value string) string {
	return `viewer.theme.primary "` + value + `" is not a hex color (#RGB, #RGBA, #RRGGBB, or #RRGGBBAA); using #009F71`
}

// themeWarnings collects the accent findings of one generation run.
func themeWarnings(fnds []findings.Finding) []findings.Finding {
	var out []findings.Finding
	for _, f := range fnds {
		if f.Rule == "viewer-theme-invalid" && f.Severity == findings.Warning {
			out = append(out, f)
		}
	}
	return out
}

// An unusable accent is refused with a warning rather than interpolated into a
// stylesheet; a plain color is kept as authored.
func TestGenerateViewerRejectsUnsafeThemeColor(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	if m.Viewer == nil {
		m.Viewer = &manifest.Viewer{}
	}
	injection := "red; } body { display: none } /*"
	m.Viewer.Theme = &manifest.Theme{Primary: injection}
	res, err := GenerateViewer(dir, m)
	if err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	page, err := os.ReadFile(filepath.Join(dir, ".leji", "viewer", "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(page), `"themeColor":"#009F71"`) {
		t.Fatal("expected the accent to fall back to the default")
	}
	warnings := themeWarnings(res.Findings)
	if len(warnings) != 1 {
		t.Fatalf("expected the rejected accent to be surfaced once, got %d", len(warnings))
	}
	if warnings[0].Message != themeWarning(injection) {
		t.Errorf("message = %q, want %q", warnings[0].Message, themeWarning(injection))
	}
	m.Viewer.Theme = &manifest.Theme{Primary: "#ff0000"}
	if _, err := GenerateViewer(dir, m); err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	page, err = os.ReadFile(filepath.Join(dir, ".leji", "viewer", "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(page), `"themeColor":"#ff0000"`) {
		t.Fatal("expected a plain color to be kept as authored")
	}
}

// The accent is hex and nothing else: 5 and 7 digits are no CSS color at all, and
// used to reach the page as an unusable accent with no warning while the mermaid
// text color silently defaulted. Keywords are not the contract either, however real
// the name — that acceptance fell out of the injection guard, never design.
func TestGenerateViewerAccentIsHexOnly(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	if m.Viewer == nil {
		m.Viewer = &manifest.Viewer{}
	}
	for _, tc := range []struct {
		accent   string
		accepted bool
	}{
		// The four lengths CSS defines, alpha forms included, case-insensitive.
		{"#0f7", true},
		{"#1234", true},
		{"#009F71", true},
		{"#AABBCCDD", true},
		{"#12345", false},
		{"#1234567", false},
		{"navy", false},
		{"notacolor", false},
		{"transparent", false},
		// A trailing newline does not sneak a hex past the predicate, in any SDK:
		// Go's `$` is end of text without multiline mode, which is what makes it
		// true here.
		{"#009F71\n", false},
	} {
		m.Viewer.Theme = &manifest.Theme{Primary: tc.accent}
		res, err := GenerateViewer(dir, m)
		if err != nil {
			t.Fatalf("GenerateViewer(%q): %v", tc.accent, err)
		}
		page, err := os.ReadFile(filepath.Join(dir, ".leji", "viewer", "index.html"))
		if err != nil {
			t.Fatal(err)
		}
		warnings := themeWarnings(res.Findings)
		if tc.accepted {
			if len(warnings) != 0 {
				t.Errorf("%q: warned, want accepted silently", tc.accent)
			}
			if !strings.Contains(string(page), `"themeColor":"`+tc.accent+`"`) {
				t.Errorf("%q: expected it kept as authored", tc.accent)
			}
			continue
		}
		if len(warnings) != 1 {
			t.Errorf("%q: warnings = %d, want 1", tc.accent, len(warnings))
			continue
		}
		if warnings[0].Message != themeWarning(tc.accent) {
			t.Errorf("%q: message = %q, want %q", tc.accent, warnings[0].Message, themeWarning(tc.accent))
		}
		if !strings.Contains(string(page), `"themeColor":"#009F71"`) {
			t.Errorf("%q: expected the default accent", tc.accent)
		}
	}
}

// wcagContrast is the contrast ratio between two #rrggbb colors, computed here
// rather than through the code under test, so the numeric assertions below are
// derived independently of the implementation they judge.
func wcagContrast(a, b string) float64 {
	luminance := func(hex string) float64 {
		channel := func(i int) float64 {
			v, _ := strconv.ParseUint(hex[1+i*2:3+i*2], 16, 16)
			c := float64(v) / 255
			if c <= 0.03928 {
				return c / 12.92
			}
			return math.Pow((c+0.055)/1.055, 2.4)
		}
		return 0.2126*channel(0) + 0.7152*channel(1) + 0.0722*channel(2)
	}
	x, y := luminance(a), luminance(b)
	return (math.Max(x, y) + 0.05) / (math.Min(x, y) + 0.05)
}

// The mermaid node-text color is computed from the accent over every form
// viewer.theme.primary accepts: the generator resolves what the boot script's
// fallback cannot — the alpha forms, composited over the viewer's white content
// ground. Mirrors the Node SDK's vectors.
func TestMermaidTextColorOverEveryAcceptedForm(t *testing.T) {
	for _, tc := range []struct{ accent, want string }{
		// The two brand accents, and the mid-gray class where neither #1a1a1a nor
		// #ffffff clears 4.5:1 and black buys the last half-stop.
		{"#009F71", "#1a1a1a"},
		{"#223F93", "#ffffff"},
		{"#777777", "#000000"},
		// #RGB expands like the boot script's fallback does.
		{"#0f7", "#1a1a1a"},
		// Alpha composites over white, which lightens: the same accent at half alpha
		// takes dark text, and a black at 47% is light enough for it too.
		{"#009F7180", "#1a1a1a"},
		{"#0007", "#1a1a1a"},
		// Named resolution is gone: navy would take white text if any keyword path
		// survived, so the dark default here is the proof it does not.
		{"navy", "#1a1a1a"},
		// Unresolvable by nature or by typo: the dark default, never a guess.
		{"currentColor", "#1a1a1a"},
		{"notacolor", "#1a1a1a"},
		{"#12345", "#1a1a1a"},
		// A dark accent takes white; the case of the authored hex does not matter.
		{"#1A1A1A", "#ffffff"},
		{"#000080", "#ffffff"},
	} {
		if got := mermaidTextColor(tc.accent); got != tc.want {
			t.Errorf("mermaidTextColor(%q) = %q, want %q", tc.accent, got, tc.want)
		}
	}
	// The default accent's choice is not merely dark, it is accessible: the numeric
	// ratio is what the rule is about, so it is asserted as a number.
	if r := wcagContrast("#009F71", "#1a1a1a"); r < 4.5 {
		t.Errorf("the default accent misses WCAG AA against its text color: %.2f", r)
	}
	if r := wcagContrast("#223F93", "#ffffff"); r < 4.5 {
		t.Errorf("a dark accent misses WCAG AA against white: %.2f", r)
	}
	// The #777777 class: black is chosen because both candidates miss, not because
	// it wins outright over a passing option.
	if wcagContrast("#777777", "#1a1a1a") >= 4.5 || wcagContrast("#777777", "#ffffff") >= 4.5 {
		t.Error("expected both #1a1a1a and #ffffff to miss 4.5:1 against #777777")
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
	sidebar, err := os.ReadFile(filepath.Join(dir, ".leji", "viewer", "_sidebar.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(sidebar), `\<img src=x onerror=alert(1)\>`) {
		t.Fatalf("expected the angle brackets escaped, got %q", string(sidebar))
	}
}

// --- link classes stay inside the router ---
// A relative link on a nested page used to be resolved by the browser against the
// server root, leaving the SPA for a URL the server has no route for. The fix has
// two halves: Docsify's relativePath routing (so a link resolves against the
// document carrying it, exactly as the same file reads on disk) and generated
// sidebar destinations emitted app-root absolute (exempt from that resolution).
// The generation half is pinned here; the serve half lives in serve_more_test.go.

var sidebarDestRe = regexp.MustCompile(`\]\(([^)]*)\)`)

func TestSidebarDestinationsAreAppRootAbsolute(t *testing.T) {
	dir := exampleCopy(t)
	// One layer carrying every sidebar entry class at once: a pinned boot profile,
	// the always-pinned Manifest chrome, a user pin, grouped index entries, and
	// documents nested two directories deep in both the governed and browse zones.
	writeUnder(t, dir, "docs/domain/billing/settlement/netting.md", "# Netting\n")
	writeUnder(t, dir, "docs/notes/team/onboarding/day-one.md", "# Day one\n")
	m := manifest.LoadManifest(dir).Manifest
	m.Viewer = &manifest.Viewer{Pins: []manifest.ViewerPin{
		{Path: "docs/boot-profile.md"},
		{Path: "docs/domain/glossary.md"},
	}}
	res, err := GenerateViewer(dir, m)
	if err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	for _, f := range res.Findings {
		if f.Severity == findings.Error {
			t.Fatalf("unexpected error finding: %v", f)
		}
	}
	sidebar, err := os.ReadFile(filepath.Join(dir, ".leji", "viewer", "_sidebar.md"))
	if err != nil {
		t.Fatalf("read _sidebar.md: %v", err)
	}
	// Each class is present, so the sweep below is not vacuous.
	for _, dest := range []string{
		"/boot-profile.md",                      // the pinned boot profile
		"/_manifest.md",                         // generated Manifest chrome
		"/domain/glossary.md",                   // a user pin in the top zone
		"/system/invariants.md",                 // a grouped index entry
		"/domain/billing/settlement/netting.md", // grouped, nested two deep
		"/notes/team/onboarding/day-one.md",     // browse zone, nested two deep
	} {
		if !strings.Contains(string(sidebar), "]("+dest+")") {
			t.Fatalf("expected %s in the sidebar, got: %q", dest, sidebar)
		}
	}
	// Every emitted destination, parsed rather than sampled: one bare rel anywhere
	// in the sidebar re-resolves against whatever nested route is current.
	dests := sidebarDestRe.FindAllStringSubmatch(string(sidebar), -1)
	if len(dests) < 6 {
		t.Fatalf("expected the matrix to produce links to sweep, got %d", len(dests))
	}
	for _, d := range dests {
		if !strings.HasPrefix(d[1], "/") {
			t.Fatalf("sidebar destination %q is not app-root absolute", d[1])
		}
	}
}

// TestMdLinkDest pins the escape-and-prefix contract on the helper itself. The
// vectors are shared verbatim with the Node and Python SDKs (test/units.test.ts,
// tests/test_units.py): the three must agree byte for byte.
func TestMdLinkDest(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"a.md", "/a.md"},
		{"dir/b.md", "/dir/b.md"},
		// Already absolute: `//…` would be a protocol-relative external URL to Docsify.
		{"/a.md", "/a.md"},
		{"//a.md", "/a.md"},
		// Degenerate input passes through rather than becoming a bare `/`.
		{"", ""},
		{"a(b).md", `/a\(b\).md`},
		{"(x).md", `/\(x\).md`},
		{`a\b.md`, `/a\\b.md`},
	} {
		if got := mdLinkDest(tc.in); got != tc.want {
			t.Fatalf("mdLinkDest(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// --- the rendered page decodes the way the reference decodes ---
// The overview is rendered from a STRING, and the three SDKs must turn the same bytes
// into the same string or the rendered page diverges on any source that is not valid
// UTF-8. Node substitutes U+FFFD per maximal subpart; Go's own conversions do not.
// Every expectation below was captured from Node (`Buffer.from(bytes).toString('utf8')`)
// and is pinned here, so a change to DecodeUTF8 that drifts from the reference reddens.

func TestDecodeUTF8MatchesNodeBufferToString(t *testing.T) {
	cases := []struct {
		name  string
		in    []byte
		want  string // the exact bytes Node produced, as UTF-8
		nodeH string // and their hex, so a failure names the reference directly
	}{
		{"valid ascii", []byte("hello"), "hello", "68656c6c6f"},
		{"valid emoji", []byte{0xF0, 0x9F, 0x98, 0x80}, "\U0001F600", "f09f9880"},
		{"lone FF between ascii", []byte{0x61, 0xFF, 0x62}, "a�b", "61efbfbd62"},
		{"lone continuation", []byte{0x80}, "�", "efbfbd"},
		{"truncated 3-byte at eof", []byte{0xE2, 0x82}, "�", "efbfbd"},
		{"truncated 3-byte then ascii", []byte{0xE2, 0x82, 0x41}, "�A", "efbfbd41"},
		{"overlong 2-byte", []byte{0xC0, 0x80}, "��", "efbfbdefbfbd"},
		{"surrogate", []byte{0xED, 0xA0, 0x80}, "���", "efbfbdefbfbdefbfbd"},
		{"past U+10FFFF", []byte{0xF4, 0x90, 0x80, 0x80}, "����", "efbfbdefbfbdefbfbdefbfbd"},
		{"overlong 4-byte", []byte{0xF0, 0x82, 0x82, 0xAC}, "����", "efbfbdefbfbdefbfbdefbfbd"},
		{"E0 80 80", []byte{0xE0, 0x80, 0x80}, "���", "efbfbdefbfbdefbfbd"},
		{"truncated 4-byte, two bytes", []byte{0xF0, 0x9F}, "�", "efbfbd"},
		{"truncated 4-byte, three bytes", []byte{0xF0, 0x9F, 0x98}, "�", "efbfbd"},
		{"FE FF", []byte{0xFE, 0xFF}, "��", "efbfbdefbfbd"},
		{"lead then ascii", []byte{0xC2, 0x41}, "�A", "efbfbd41"},
	}
	for _, c := range cases {
		got := DecodeUTF8(c.in)
		if hex.EncodeToString([]byte(got)) != c.nodeH {
			t.Errorf("%s: DecodeUTF8(% x) = %q (%s), Node gives %q (%s)",
				c.name, c.in, got, hex.EncodeToString([]byte(got)), c.want, c.nodeH)
		}
	}
}

func TestRenderOverviewOnInvalidUTF8IsByteIdenticalToTheReference(t *testing.T) {
	// The whole rendered document, pinned against the reference. Source and expectation
	// were captured by running the TypeScript SDK's own `renderOverview` over these
	// bytes (packages/sdk/dist/index.js), with the invalid sequences deliberately placed
	// OUTSIDE the marker span (a lone 0xFF before it and an overlong C0 80 after it),
	// so what this pins is the decode and not the substitution. The truncated E2 82
	// inside the span is dropped with the span, as it is in every SDK.
	const srcHex = "232054ff746c650a0a3c212d2d206c656a693a67656e6572617465642d6d61703a73" +
		"7461727420" + "2d2d3e0a7374616c6520e282206d61700a3c212d2d206c656a693a67656e657261" +
		"7465642d6d61703a656e64202d2d3e0a0a5461c080696c0a"
	const wantHex = "232054efbfbd746c650a0a3c212d2d206c656a693a67656e6572617465642d6d61703a" +
		"7374617274202d2d3e0a6060606d65726d6169640a666c6f776368617274204c520a2020626f6f" +
		"745b22f09fa49620426f6f742070726f66696c65225d0a20206361745f646f6d61696e5b22f09f" +
		"939620446f6d61696e20c2b7203120646f63225d0a2020626f6f74202d2d3e206361745f646f6d" +
		"61696e0a6060600a3c212d2d206c656a693a67656e6572617465642d6d61703a656e64202d2d3e" +
		"0a0a5461efbfbdefbfbd696c0a"
	src, err := hex.DecodeString(srcHex)
	if err != nil {
		t.Fatalf("decode the pinned source: %v", err)
	}
	entries := []indexgen.IndexEntry{{ID: "a", Path: "docs/domain/a.md", Title: "A", Category: "domain"}}
	got, markersFound := RenderOverview(DecodeUTF8(src), &manifest.Manifest{Name: "fixture"}, entries)
	if !markersFound {
		t.Fatal("the pinned source carries the marker pair")
	}
	if hex.EncodeToString([]byte(got)) != wantHex {
		t.Fatalf("rendered bytes differ from the reference's\n got: %s\nwant: %s\n\ngot text:\n%s",
			hex.EncodeToString([]byte(got)), wantHex, got)
	}
	// The invalid bytes are gone and the replacement stands where the reference put it.
	if bytes.ContainsRune([]byte(got), 0xFF) {
		t.Fatal("no raw invalid byte may survive the render")
	}
	if !strings.Contains(got, "# T�tle") || !strings.Contains(got, "Ta��il") {
		t.Fatalf("the replacements are not where the reference puts them:\n%s", got)
	}
}
