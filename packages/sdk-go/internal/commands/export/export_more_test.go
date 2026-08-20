package export

// The export's own legs, moved here with the pipeline they exercise: containment
// and the role reservation, the marker-verified clearing, the active-type exclusion,
// the default output role, and the relative-base export flavor. The generation half
// of each pairing stays with the generator.

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

// exampleCopy is a scratch copy of the example layer, the fixture these legs export.
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

// Mirrors the Node test: viewer build exports a self-contained static folder
// carrying the protect warning, and refuses an escaping, root, or absolute --out.
func TestBuildViewerExportsAndRejects(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	r, err := BuildViewer(dir, m, "out", Options{})
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
		if _, err := BuildViewer(dir, m, bad, Options{}); err == nil || !strings.Contains(err.Error(), "refusing to build the viewer") {
			t.Fatalf("BuildViewer(%q, Options{}): expected the containment refusal, got %v", bad, err)
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
		if _, err := BuildViewer(dir, m, bad, Options{}); err == nil || !strings.Contains(err.Error(), "refusing to build the viewer") {
			t.Fatalf("BuildViewer(%q, Options{}): expected the containment refusal, got %v", bad, err)
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
	if _, err := BuildViewer(dir, m, "out", Options{}); err != nil {
		t.Fatalf("BuildViewer: %v", err)
	}
	stale := filepath.Join(dir, "out", "stale.txt")
	if err := os.WriteFile(stale, []byte("from the previous export"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := BuildViewer(dir, m, "out", Options{}); err != nil {
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
	if _, err := BuildViewer(dir, m, "notes", Options{}); err == nil ||
		!strings.Contains(err.Error(), "neither empty nor a previous viewer export") {
		t.Fatalf("BuildViewer(notes, Options{}): expected the occupied-target refusal, got %v", err)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatalf("the occupied target was touched: %v", err)
	}
	// An empty directory is a fine target.
	if err := os.MkdirAll(filepath.Join(dir, "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := BuildViewer(dir, m, "empty", Options{}); err != nil {
		t.Fatalf("BuildViewer(empty, Options{}): %v", err)
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
	if _, err := BuildViewer(dir, m, "out", Options{}); err != nil {
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

func TestBuildViewerDefaultOutputIsTheDistRole(t *testing.T) {
	dir := exampleCopy(t)
	// exampleCopy copies the working tree, which may carry a gitignored pre-1.4
	// `docs/.leji/` left by a local run; clear it so the absence asserted below is
	// this run's doing and not a checkout's history.
	if err := os.RemoveAll(filepath.Join(dir, "docs", ".leji")); err != nil {
		t.Fatal(err)
	}
	m := manifest.LoadManifest(dir).Manifest
	r, err := BuildViewer(dir, m, "", Options{})
	if err != nil {
		t.Fatalf("BuildViewer: %v", err)
	}
	if got := filepath.ToSlash(r.Out); got != ".leji/dist" {
		t.Fatalf("default output = %q, want %q", got, ".leji/dist")
	}
	for _, rel := range []string{".leji/dist/index.html", ".leji/dist/content/boot-profile.md"} {
		if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(rel))); err != nil {
			t.Fatalf("expected %s: %v", rel, err)
		}
	}
	// The pre-1.4 locations are never created, and nothing reads or writes a tree
	// under the context root: a run leaves rootPath/.leji/ absent.
	if _, err := os.Stat(filepath.Join(dir, "docs", ".leji")); err == nil {
		t.Fatal("no tree must be created under the context root")
	}
	if _, err := os.Stat(filepath.Join(dir, ".leji", "viewer-dist")); err == nil {
		t.Fatal("the old output name must not be used")
	}
}

func TestBuildViewerOutNeverResolvesInsideALejiRoleButDist(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	// The roles are the tool's own: an export target inside any of them is refused,
	// including a role this version has never heard of, because the rule denies by name
	// rather than listing what to protect.
	for _, target := range []string{".leji", ".leji/mounts", ".leji/mounts/cache", ".leji/viewer", ".leji/work", ".leji/future"} {
		if _, err := BuildViewer(dir, m, target, Options{}); err == nil ||
			!strings.Contains(err.Error(), "reserved for the tool's own roles") {
			t.Fatalf("--out %s must be refused, got %v", target, err)
		}
	}
	// The canary bytes a refusal must never have touched: the private roles are still
	// exactly as planted.
	writeUnder(t, dir, ".leji/mounts/store/keep", "private\n")
	if _, err := BuildViewer(dir, m, ".leji/mounts", Options{}); err == nil {
		t.Fatal("--out .leji/mounts must be refused")
	}
	body, err := os.ReadFile(filepath.Join(dir, ".leji", "mounts", "store", "keep"))
	if err != nil || string(body) != "private\n" {
		t.Fatal("the private role must be intact")
	}
	// The reserved role itself is the one accepted spelling.
	if _, err := BuildViewer(dir, m, ".leji/dist", Options{}); err != nil {
		t.Fatalf(".leji/dist must be accepted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".leji", "dist", "index.html")); err != nil {
		t.Fatalf("expected the export at the dist role: %v", err)
	}
	// EXACT: the reservation names the directory the role is, never a path underneath
	// it — relative or absolute, since a caller may spell either.
	for _, target := range []string{".leji/dist/site", filepath.Join(dir, ".leji", "dist", "site")} {
		if _, err := BuildViewer(dir, m, target, Options{}); err == nil ||
			!strings.Contains(err.Error(), "is the reserved export target itself, never a path inside it") {
			t.Fatalf("--out %s must be refused, got %v", target, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, ".leji", "dist", "site")); err == nil {
		t.Fatal("nothing must be written inside the reserved target")
	}
}

// caseInsensitiveFs reports whether this directory sits on a filesystem that cannot
// tell `.leji` from `.LEJI`. Asked of the volume rather than inferred from the
// platform: a case-sensitive volume on macOS and a case-insensitive one on Linux
// both exist.
func caseInsensitiveFs(t *testing.T, dir string) bool {
	t.Helper()
	probe := filepath.Join(dir, "leji-case-probe")
	if err := os.MkdirAll(probe, 0o755); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.RemoveAll(probe) }()
	_, err := os.Stat(filepath.Join(dir, "LEJI-CASE-PROBE"))
	return err == nil
}

func TestBuildViewerOutIsJudgedInResolvedForm(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	writeUnder(t, dir, ".leji/mounts/store/keep", "private\n")
	// A symlink is a spelling, not an exemption: what the write would land in is what
	// the reservation judges, so an ordinary-looking --out that redirects into a private
	// role is refused exactly as the literal path is.
	if err := os.Symlink(filepath.Join(".leji", "mounts"), filepath.Join(dir, "redirect")); err != nil {
		t.Fatal(err)
	}
	if _, err := BuildViewer(dir, m, "redirect/export", Options{}); err == nil ||
		!strings.Contains(err.Error(), "reserved for the tool's own roles") {
		t.Fatalf("a redirected --out must be refused, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".leji", "mounts", "export")); err == nil {
		t.Fatal("nothing must be written through it")
	}
	if body, err := os.ReadFile(filepath.Join(dir, ".leji", "mounts", "store", "keep")); err != nil || string(body) != "private\n" {
		t.Fatal("the private role must be intact")
	}
	// Where the filesystem cannot tell the two spellings apart, `.LEJI/` names the
	// reserved role and is refused as one. Where it can, `.LEJI/` is an ordinary
	// directory name and there is nothing to assert, so the volume decides.
	if caseInsensitiveFs(t, dir) {
		if _, err := BuildViewer(dir, m, ".LEJI/mounts/export", Options{}); err == nil ||
			!strings.Contains(err.Error(), "reserved for the tool's own roles") {
			t.Fatalf("a case-variant spelling of a reserved role is the reserved role, got %v", err)
		}
		if _, err := os.Stat(filepath.Join(dir, ".leji", "mounts", "export")); err == nil {
			t.Fatal("nothing must be written under the case variant")
		}
	}
	// The redirection rule is about the destination, not about symlinks: one that lands
	// somewhere ordinary still exports.
	if err := os.MkdirAll(filepath.Join(dir, "real-out"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("real-out", filepath.Join(dir, "link-out")); err != nil {
		t.Fatal(err)
	}
	if _, err := BuildViewer(dir, m, "link-out", Options{}); err != nil {
		t.Fatalf("an ordinary redirected --out must export: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "real-out", "index.html")); err != nil {
		t.Fatalf("the export must land in the resolved target: %v", err)
	}
}

func TestBuildViewerExportFlavorCarriesNoRootAbsoluteURL(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	if _, err := BuildViewer(dir, m, "", Options{}); err != nil {
		t.Fatalf("BuildViewer: %v", err)
	}
	served, err := os.ReadFile(filepath.Join(dir, ".leji", "viewer", "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	exported, err := os.ReadFile(filepath.Join(dir, ".leji", "dist", "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	// One code path, two flavors: the servable area holds the app-root base, the export
	// holds the relative one. index.html is the only file that differs.
	if !strings.Contains(string(served), `"basePath":"/content/"`) {
		t.Fatal("the served flavor must mount content at the app root")
	}
	if !strings.Contains(string(served), `href="/assets/leji-logo.svg"`) {
		t.Fatal("the served favicon must be app-root absolute")
	}
	if !strings.Contains(string(exported), `"basePath":"content/"`) {
		t.Fatal("the exported flavor must mount content relative to the page")
	}
	if strings.Contains(string(exported), `"basePath":"/content/"`) {
		t.Fatal("no export-flavored page may keep the app-root base")
	}
	// The machine-checkable proxy gate for subpath hosting: nothing in the exported
	// shell — attributes or config — addresses the server root. (Sidebar link
	// destinations are route strings resolved against basePath, not fetch paths, and
	// live in _sidebar.md, not here.)
	body := string(exported)
	if i := strings.Index(body, "-->"); i >= 0 {
		body = body[i+3:]
	}
	if hits := rootAbsoluteAttrRe.FindAllString(body, -1); len(hits) > 0 {
		t.Fatalf("root-absolute href/src in the exported shell: %v", hits)
	}
	if hits := rootAbsoluteConfigRe.FindAllString(body, -1); len(hits) > 0 {
		t.Fatalf("root-absolute URL inside the exported config block: %v", hits)
	}
	// The servable area never holds export-flavored bytes, and the two trees agree on
	// everything else the chrome ships.
	for _, rel := range []string{"assets/viewer-boot.js", "assets/docsify.min.js"} {
		a, err := os.ReadFile(filepath.Join(dir, ".leji", "dist", filepath.FromSlash(rel)))
		if err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(filepath.Join(dir, ".leji", "viewer", filepath.FromSlash(rel)))
		if err != nil {
			t.Fatal(err)
		}
		if string(a) != string(b) {
			t.Fatalf("%s must be flavor-neutral", rel)
		}
	}
}

// The export flavor's proxy gate: no URL the exported chrome emits may be
// root-absolute, or the tree breaks the moment it is hosted under a subpath.
var (
	rootAbsoluteAttrRe   = regexp.MustCompile(`(?:href|src)="/[^"]*"`)
	rootAbsoluteConfigRe = regexp.MustCompile(`\\"/(?:content|assets)/[^\\"]*\\"`)
)

func TestClearableExportPropagatesAnOperationalReadFailure(t *testing.T) {
	// The marker that authorizes clearing a previous export is read through the
	// verified read. A refusal is "not a previous export"; an operational failure on
	// an allowed path is the filesystem failing, and the reference lets it throw — so
	// it travels out as an error rather than deciding the delete either way. Mutation
	// that reddens: swallow the error in clearableExport — the run reports the
	// occupied-target refusal instead of the read failure.
	if os.Geteuid() == 0 {
		t.Skip("running as root bypasses permission bits; the read cannot be made to fail")
	}
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	marker := filepath.Join(dir, "out", "index.html")
	writeUnder(t, dir, "out/index.html", exportMarker+"previous export\n")
	if err := os.Chmod(marker, 0o000); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chmod(marker, 0o644) }()
	if f, oerr := os.Open(marker); oerr == nil {
		_ = f.Close()
		t.Skip("this platform ignores the mode; the read cannot be made to fail")
	}

	_, err := BuildViewer(dir, m, "out", Options{})
	if err == nil {
		t.Fatal("an unreadable marker must fail the run, not decide the clear")
	}
	if strings.Contains(err.Error(), "neither empty nor a previous viewer export") {
		t.Fatalf("the read failure must not be reported as an occupied target: %v", err)
	}
	if !strings.Contains(err.Error(), "permission denied") {
		t.Fatalf("the operational failure must surface: %v", err)
	}
}
