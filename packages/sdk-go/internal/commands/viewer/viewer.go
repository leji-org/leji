// Package viewer projects the context index into a static Docsify viewer and can
// serve the repository locally on 127.0.0.1.
package viewer

import (
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	"github.com/leji-org/leji/packages/sdk-go/internal/assets"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/indexgen"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/jsonenc"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

// docsifyConfig is the Docsify viewer config embedded in index.html. Field order
// (name, then homepage, then themeColor) and the absence of HTML escaping in
// jsonenc.Marshal make the serialized form byte-identical to the Node SDK's
// JSON.stringify output, before scriptSafeJSON escapes it for <script> embedding.
type docsifyConfig struct {
	Name       string `json:"name"`
	Homepage   string `json:"homepage"`
	ThemeColor string `json:"themeColor"`
}

// ResolveViewerPort: explicit flag, then manifest viewer.port, then 5354.
func ResolveViewerPort(m *manifest.Manifest, flagPort *int) int {
	if flagPort != nil {
		return *flagPort
	}
	if m.Viewer != nil && m.Viewer.Port != nil {
		return *m.Viewer.Port
	}
	return 5354
}

type Result struct {
	Written  []string
	Findings []findings.Finding
	Entries  int
}

var categoryLabels = map[string]string{
	"domain":     "Domain",
	"system":     "System",
	"practice":   "Practice",
	"governance": "Governance",
	"decisions":  "Decisions",
}

// categoryEmoji is the default emoji shown beside each category group in the
// sidebar; overridable per group via manifest viewer.categoryEmojis. Baked
// identically into every SDK so the generated sidebar stays byte-identical.
var categoryEmoji = map[string]string{
	"domain":     "📖",
	"system":     "⚙️",
	"practice":   "🛠️",
	"governance": "🛡️",
	"decisions":  "🧭",
}

// defaultThemeColor is the Leji brand blue, the viewer's default accent when no
// viewer.theme.primary is set. defaultLogo is the vendored Leji mark.
const (
	defaultThemeColor = "#223F93"
	defaultLogo       = "/assets/leji-logo.svg"
)

// mermaidAssets are the vendored assets loaded only when mermaid is enabled;
// skipped otherwise.
var mermaidAssets = map[string]bool{
	"mermaid.min.js":     true,
	"docsify-mermaid.js": true,
}

var httpURLRe = regexp.MustCompile(`^https?://`)

// resolveLogo resolves the viewer logo URL: a configured path is served from the
// content mount (or used as-is when absolute); unset falls back to the vendored
// Leji mark.
func resolveLogo(logo string) string {
	if logo == "" {
		return defaultLogo
	}
	if strings.HasPrefix(logo, "/") || httpURLRe.MatchString(logo) {
		return logo
	}
	return "/content/" + fsx.StripSlash(logo)
}

// htmlEscape escapes text for safe interpolation into HTML element/attribute
// content, matching the Node SDK's htmlEscape byte-for-byte (& < > " '). Go's
// stdlib html.EscapeString emits &#34; for the double quote where Node emits
// &quot;, so we cannot use it here.
func htmlEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, "\"", "&quot;")
	s = strings.ReplaceAll(s, "'", "&#39;")
	return s
}

func relativeToRoot(relPath, rootPath string) (string, bool) {
	base := fsx.StripSlash(rootPath)
	if base == "" || base == "." {
		return relPath, true
	}
	if strings.HasPrefix(relPath, base+"/") {
		return relPath[len(base)+1:], true
	}
	return "", false
}

// mdLinkText escapes a string for Markdown link text (`[...]`): backslash and
// brackets. mdLinkDest escapes a Markdown link destination (`(...)`): backslash
// and parens. Both mirror the Node SDK so the sidebar is byte-identical.
var (
	mdLinkTextRe = regexp.MustCompile(`[\\\[\]]`)
	mdLinkDestRe = regexp.MustCompile(`[\\()]`)
)

func mdLinkText(s string) string {
	return mdLinkTextRe.ReplaceAllString(s, `\$0`)
}

func mdLinkDest(s string) string {
	return mdLinkDestRe.ReplaceAllString(s, `\$0`)
}

// BuildSidebar projects a deterministic Docsify sidebar from the index entries.
// Ungrouped entries (the boot profile) sit above a divider; the category groups
// follow below it, giving the viewer a two-tier sidebar.
func BuildSidebar(m *manifest.Manifest, entries []indexgen.IndexEntry) string {
	var topLines []string
	if boot, ok := relativeToRoot(m.BootProfilePath, m.RootPath); ok {
		topLines = append(topLines, "- [🤖 Boot profile]("+mdLinkDest(boot)+")")
	}
	var groupLines []string
	for _, category := range manifest.CategoryIDs {
		var inCategory []struct {
			title string
			rel   string
		}
		for _, e := range entries {
			if e.Category != category {
				continue
			}
			if rel, ok := relativeToRoot(e.Path, m.RootPath); ok {
				inCategory = append(inCategory, struct {
					title string
					rel   string
				}{e.Title, rel})
			}
		}
		if len(inCategory) == 0 {
			continue
		}
		emoji := categoryEmoji[category]
		if m.Viewer != nil {
			if e, ok := m.Viewer.CategoryEmojis[category]; ok {
				emoji = e
			}
		}
		groupLines = append(groupLines, "- "+emoji+" "+categoryLabels[category])
		for _, e := range inCategory {
			groupLines = append(groupLines, "  - ["+mdLinkText(e.title)+"]("+mdLinkDest(e.rel)+")")
		}
	}
	var sections []string
	if len(topLines) > 0 {
		sections = append(sections, strings.Join(topLines, "\n"))
	}
	if len(groupLines) > 0 {
		sections = append(sections, strings.Join(groupLines, "\n"))
	}
	return strings.Join(sections, "\n\n---\n\n") + "\n"
}

// The overview homepage is seeded once and then user-owned. The layer map lives
// between these markers; `leji viewer` regenerates only the marked block, leaving
// the surrounding prose untouched.
const (
	mapStart = "<!-- leji:generated-map:start -->"
	mapEnd   = "<!-- leji:generated-map:end -->"
)

// mermaidIDRe matches every character not allowed in a mermaid id; mermaidLabelRe
// matches the characters that would break a `["..."]` label.
var (
	mermaidIDRe      = regexp.MustCompile(`[^a-zA-Z0-9]`)
	mermaidLabelRe   = regexp.MustCompile(`["\[\]]`)
	mermaidNewlineRe = regexp.MustCompile(`[\r\n]+`)
)

// mermaidID builds a mermaid id from a slug: safe characters only, never colliding
// with `boot`.
func mermaidID(slug string) string {
	return "n_" + mermaidIDRe.ReplaceAllString(slug, "_")
}

// mermaidLabel builds a mermaid node label: drop the characters that would break
// `["..."]`.
func mermaidLabel(text string) string {
	return mermaidNewlineRe.ReplaceAllString(mermaidLabelRe.ReplaceAllString(text, ""), " ")
}

// buildLayerMap renders a deterministic mermaid flowchart of the layer: boot
// profile -> categories -> documents, derived from the live index in canonical
// order. The node id is the stable index id (not the path).
func buildLayerMap(m *manifest.Manifest, entries []indexgen.IndexEntry) string {
	lines := []string{"flowchart TD", "  boot[\"🤖 Boot profile\"]"}
	for _, category := range manifest.CategoryIDs {
		var inCategory []indexgen.IndexEntry
		for _, e := range entries {
			if e.Category == category {
				inCategory = append(inCategory, e)
			}
		}
		if len(inCategory) == 0 {
			continue
		}
		emoji := categoryEmoji[category]
		if m.Viewer != nil {
			if e, ok := m.Viewer.CategoryEmojis[category]; ok {
				emoji = e
			}
		}
		catID := "cat_" + category
		lines = append(lines, "  "+catID+"[\""+emoji+" "+categoryLabels[category]+"\"]")
		lines = append(lines, "  boot --> "+catID)
		for _, e := range inCategory {
			id := mermaidID(e.ID)
			lines = append(lines, "  "+id+"[\""+mermaidLabel(e.Title)+"\"]")
			lines = append(lines, "  "+catID+" --> "+id)
		}
	}
	return strings.Join(lines, "\n")
}

// mapBlock wraps the generated layer map in the regen markers and a mermaid code
// fence.
func mapBlock(m *manifest.Manifest, entries []indexgen.IndexEntry) string {
	return mapStart + "\n```mermaid\n" + buildLayerMap(m, entries) + "\n```\n" + mapEnd
}

// buildOverviewSeed is the starter overview/home page: a short explainer the owner
// can edit freely, plus the auto-generated layer map inside the regen markers.
func buildOverviewSeed(m *manifest.Manifest, entries []indexgen.IndexEntry) string {
	return "# " + m.Name + `

This is the **Leji context layer** for ` + "`" + m.Name + "`" + `: the shared, validated context
people and coding agents read before working in this repository. Start with the boot
profile, then browse the categories in the sidebar.

This page is yours to edit. The map below is regenerated by ` + "`leji viewer`" + ` between the
markers; the prose around it is left untouched.

` + mapBlock(m, entries) + `

- Write a ` + "```mermaid" + ` code block in any document and it renders as a diagram here.
- Run ` + "`leji conformance`" + ` to see the level this layer claims and verifies.
`
}

// scriptSafeJSON makes a JSON blob safe to embed in an HTML <script> element by
// neutralizing a closing tag and the two JS line terminators U+2028/U+2029. The
// input comes from jsonenc.Marshal (no HTML escaping), so <, >, and & are
// literal here and escaped to < etc., matching the Node SDK's jsonForScript.
func scriptSafeJSON(b []byte) string {
	s := string(b)
	s = strings.ReplaceAll(s, "<", "\\u003c")
	s = strings.ReplaceAll(s, ">", "\\u003e")
	s = strings.ReplaceAll(s, "&", "\\u0026")
	s = strings.ReplaceAll(s, " ", "\\u2028")
	s = strings.ReplaceAll(s, " ", "\\u2029")
	return s
}

// GenerateViewer writes index.html, _sidebar.md, and the vendored viewer assets
// into the context root.
func GenerateViewer(root string, m *manifest.Manifest) (Result, error) {
	result := indexgen.GenerateIndex(root, m)
	var entries []indexgen.IndexEntry
	if result.Index != nil {
		entries = result.Index.Entries
	}

	htmlBytes, err := assets.FS.ReadFile("templates/viewer/index.html")
	if err != nil {
		return Result{}, err
	}
	// The logo + name render as the Docsify sidebar title. The logo is raw HTML
	// inside `name` (an <img> resolved relative to the served page) rather than
	// Docsify's own `logo` option, which prepends basePath (/content/) and would
	// 404 the asset. The name is HTML-escaped; the strict CSP neutralizes handlers.
	var logo string
	var themeColor string
	if m.Viewer != nil {
		logo = m.Viewer.Logo
		if m.Viewer.Theme != nil {
			themeColor = m.Viewer.Theme.Primary
		}
	}
	if themeColor == "" {
		themeColor = defaultThemeColor
	}
	logoURL := htmlEscape(resolveLogo(logo))
	nameHTML := "<img src=\"" + logoURL + "\" alt=\"\" style=\"height:1.7rem;vertical-align:middle;margin-right:0.45rem\" />" + htmlEscape(m.Name)
	configBytes, err := jsonenc.Marshal(docsifyConfig{Name: nameHTML, Homepage: "overview.md", ThemeColor: themeColor})
	if err != nil {
		return Result{}, err
	}
	// Mermaid is on unless explicitly disabled. When off, the two mermaid scripts
	// are omitted from the page and their assets are not copied (a leaner viewer).
	mermaidEnabled := m.Viewer == nil || m.Viewer.Mermaid == nil || *m.Viewer.Mermaid
	mermaidScripts := ""
	if mermaidEnabled {
		mermaidScripts = "\n      <script src=\"assets/mermaid.min.js\"></script>" +
			"\n      <script src=\"assets/docsify-mermaid.js\"></script>"
	}
	page := strings.ReplaceAll(string(htmlBytes), "{{LEJI_NAME_HTML}}", htmlEscape(m.Name))
	page = strings.ReplaceAll(page, "{{DOCSIFY_CONFIG}}", scriptSafeJSON(configBytes))
	page = strings.ReplaceAll(page, "{{MERMAID_SCRIPTS}}", mermaidScripts)
	sidebar := BuildSidebar(m, entries)

	rootDir := fsx.StripSlash(m.RootPath)
	if rootDir == "" {
		rootDir = "."
	}

	// The viewer is contained under rootPath/.leji/viewer/ (gitignored), so it never
	// collides with the user's own files in the context root and keeps the layer clean.
	viewerDir := ".leji/viewer"
	if rootDir != "." {
		viewerDir = rootDir + "/.leji/viewer"
	}

	var written []string
	files := []struct {
		name    string
		content []byte
	}{
		{"index.html", []byte(page)},
		{"_sidebar.md", []byte(sidebar)},
	}

	// Copy every vendored viewer asset (Docsify core, theme, and the search +
	// sidebar-collapse plugins) so nothing loads from a remote CDN. The
	// provenance note is documentation, never shipped.
	assetEntries, err := assets.FS.ReadDir("templates/viewer/assets")
	if err != nil {
		return Result{}, err
	}
	for _, e := range assetEntries {
		if e.IsDir() || e.Name() == "PROVENANCE.txt" || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		if !mermaidEnabled && mermaidAssets[e.Name()] {
			continue
		}
		content, err := assets.FS.ReadFile("templates/viewer/assets/" + e.Name())
		if err != nil {
			return Result{}, err
		}
		files = append(files, struct {
			name    string
			content []byte
		}{"assets/" + e.Name(), content})
	}
	findingList := append([]findings.Finding{}, result.Findings...)
	// Refuse to write through a symlink that escapes the layer root (a symlinked
	// content root, or a pre-placed target file). ResolvesUnder resolves the nearest
	// existing ancestor, so a not-yet-existing target under a symlinked directory
	// is caught before mkdir/write can escape. An escaping target is skipped with
	// an error finding rather than aborting the whole run, mirroring Node's
	// writeWithin.
	for _, f := range files {
		rel := viewerDir + "/" + f.name
		abs := filepath.Join(root, rel)
		if !fsx.ResolvesUnder(root, abs) {
			findingList = append(findingList, findings.New("artifact-parse", findings.Error,
				"viewer path "+rel+" resolves outside the layer root", rel))
			continue
		}
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return Result{}, err
		}
		if err := os.WriteFile(abs, f.content, 0o644); err != nil {
			return Result{}, err
		}
		written = append(written, rel)
	}

	// The overview/home page is committed, user-owned content (not viewer chrome):
	// seeded once and never overwritten. On regeneration, only the marked map block
	// is refreshed; if the owner removed the markers, the page is left entirely alone.
	overviewRel := "overview.md"
	if rootDir != "." {
		overviewRel = rootDir + "/overview.md"
	}
	overviewAbs := filepath.Join(root, overviewRel)
	if !fsx.IsFile(overviewAbs) {
		if !fsx.ResolvesUnder(root, overviewAbs) {
			findingList = append(findingList, findings.New("artifact-parse", findings.Error,
				"viewer path "+overviewRel+" resolves outside the layer root", overviewRel))
		} else {
			if err := os.MkdirAll(filepath.Dir(overviewAbs), 0o755); err != nil {
				return Result{}, err
			}
			if err := os.WriteFile(overviewAbs, []byte(buildOverviewSeed(m, entries)), 0o644); err != nil {
				return Result{}, err
			}
			written = append(written, overviewRel)
		}
	} else if fsx.ResolvesUnder(root, overviewAbs) {
		existing, err := fsx.ReadText(overviewAbs)
		if err != nil {
			return Result{}, err
		}
		start := strings.Index(existing, mapStart)
		end := strings.Index(existing, mapEnd)
		if start >= 0 && end > start {
			updated := existing[:start] + mapBlock(m, entries) + existing[end+len(mapEnd):]
			if updated != existing {
				if err := os.WriteFile(overviewAbs, []byte(updated), 0o644); err != nil {
					return Result{}, err
				}
			}
		} else {
			findingList = append(findingList, findings.New("overview-markers-missing", findings.Warning,
				"overview.md has no generated-map markers; left as-is (map not refreshed)", overviewRel))
		}
	}

	return Result{Written: written, Findings: findingList, Entries: len(entries)}, nil
}

// ProtectWarning is the protect-your-context warning surfaced by `leji viewer
// build` (in stdout and as a comment in the exported index.html): a context layer
// is sensitive and the static export should not be hosted somewhere public.
const ProtectWarning = "This is your context layer (identity, invariants, decisions, sometimes sensitive internal knowledge). Host the exported folder behind internal authentication, not a public or shared bucket where it could be indexed or leaked."

// BuildResult is the result of BuildViewer: the (relative) output dir and the
// findings carried over from regenerating the docs.
type BuildResult struct {
	Out      string
	Findings []findings.Finding
}

// copyTree recursively copies src to dst, preserving file modes. Mirrors Node's
// fs.cpSync(recursive). When skipLejiRoot is true, the top-level .leji directory
// (relative to src) is excluded, mirroring Node's filter.
func copyTree(src, dst string, skipLejiRoot bool) error {
	return filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		if rel == "." {
			return os.MkdirAll(dst, 0o755)
		}
		if skipLejiRoot && strings.Split(filepath.ToSlash(rel), "/")[0] == ".leji" {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		// Skip symlinks: an export is a self-contained static snapshot, and reading
		// through a symlink would copy content from outside the layer into the export.
		if info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		return os.WriteFile(target, data, info.Mode().Perm())
	})
}

// copyFile copies a single file, preserving its mode.
func copyFile(src, dst string) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	return os.WriteFile(dst, data, info.Mode().Perm())
}

// BuildViewer exports a self-contained static viewer into outRel: the same URL
// contract the local server materializes (chrome at the web root, the layer's
// markdown under /content/), so any static host serves it as-is. Regenerates the
// viewer first, then copies the contained chrome and the content docs into a clean
// output dir. The exported index.html carries the protect-your-context warning as
// a comment.
func BuildViewer(root string, m *manifest.Manifest, outRel string) (BuildResult, error) {
	gen, err := GenerateViewer(root, m)
	if err != nil {
		return BuildResult{}, err
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return BuildResult{}, err
	}
	rootDir := fsx.StripSlash(m.RootPath)
	if rootDir == "" {
		rootDir = "."
	}
	contentAbs := rootAbs
	if rootDir != "." {
		contentAbs = filepath.Join(rootAbs, rootDir)
	}
	var outAbs string
	switch {
	case outRel == "":
		outAbs = filepath.Join(contentAbs, ".leji", "viewer-dist")
	case filepath.IsAbs(outRel):
		outAbs = outRel
	default:
		outAbs = filepath.Join(rootAbs, outRel)
	}
	outDisplay, err := filepath.Rel(rootAbs, outAbs)
	if err != nil {
		return BuildResult{}, err
	}

	// Never run the destructive export when generation failed (e.g. a symlinked
	// rootPath escaping the layer): the viewer was not written, and the removal
	// below would otherwise delete an escaped output path.
	for _, fnd := range gen.Findings {
		if fnd.Severity == findings.Error {
			return BuildResult{Out: outDisplay, Findings: gen.Findings}, nil
		}
	}
	// Contain the output (custom or default) before the removal: it must stay inside
	// the repo and not be the repo or context root.
	if outAbs == rootAbs || outAbs == contentAbs || !fsx.ResolvesUnder(rootAbs, outAbs) {
		ref := outRel
		if ref == "" {
			ref = outDisplay
		}
		return BuildResult{}, errors.New(`refusing to build the viewer into "` + ref + `": --out must be a path inside the repository, and not the repository root or the context root`)
	}
	viewerAbs := filepath.Join(contentAbs, ".leji", "viewer")
	outContent := filepath.Join(outAbs, "content")

	// Clean rebuild so a removed source file never lingers in the export.
	if err := os.RemoveAll(outAbs); err != nil {
		return BuildResult{}, err
	}
	if err := os.MkdirAll(outContent, 0o755); err != nil {
		return BuildResult{}, err
	}

	// The layer's content docs under /content/ (everything in the context root
	// except the contained, regenerable .leji/ directory).
	if err := copyTree(contentAbs, outContent, true); err != nil {
		return BuildResult{}, err
	}
	// The generated sidebar is served as if at the content root.
	if err := copyFile(filepath.Join(viewerAbs, "_sidebar.md"), filepath.Join(outContent, "_sidebar.md")); err != nil {
		return BuildResult{}, err
	}
	// The viewer assets at the web root.
	if err := copyTree(filepath.Join(viewerAbs, "assets"), filepath.Join(outAbs, "assets"), false); err != nil {
		return BuildResult{}, err
	}
	// index.html at the web root, with the protect-your-context warning prepended.
	indexHTML, err := os.ReadFile(filepath.Join(viewerAbs, "index.html"))
	if err != nil {
		return BuildResult{}, err
	}
	prepended := "<!--\n  Leji viewer (leji viewer build).\n  " + ProtectWarning + "\n-->\n" + string(indexHTML)
	if err := os.WriteFile(filepath.Join(outAbs, "index.html"), []byte(prepended), 0o644); err != nil {
		return BuildResult{}, err
	}

	return BuildResult{Out: outDisplay, Findings: gen.Findings}, nil
}

var contentTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".md":    "text/markdown; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json; charset=utf-8",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".jpg":   "image/jpeg",
	".jpeg":  "image/jpeg",
	".gif":   "image/gif",
	".ico":   "image/x-icon",
	".txt":   "text/plain; charset=utf-8",
	".woff":  "font/woff",
	".woff2": "font/woff2",
}

// serveFrom serves `sub` (a clean relative path) from under mountRoot; "" ->
// index.html. It lexically contains the target under its mount, follows a
// directory to index.html, then realpath-contains the resolved target so a
// symlink can't escape. Mirrors the Node SDK: 200 on success, 403 on a
// containment violation, 404 on any stat/read failure.
func serveFrom(w http.ResponseWriter, mountRoot, sub string) {
	var abs string
	if sub == "" {
		abs = filepath.Join(mountRoot, "index.html")
	} else {
		abs = filepath.Join(mountRoot, sub)
	}
	if abs != mountRoot && !strings.HasPrefix(abs, mountRoot+string(filepath.Separator)) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte("forbidden"))
		return
	}
	if info, err := os.Stat(abs); err == nil && info.IsDir() {
		abs = filepath.Join(abs, "index.html")
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("not found"))
		return
	}
	if real != mountRoot && !strings.HasPrefix(real, mountRoot+string(filepath.Separator)) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte("forbidden"))
		return
	}
	body, err := os.ReadFile(abs)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("not found"))
		return
	}
	ct := contentTypes[strings.ToLower(path.Ext(abs))]
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("content-type", ct)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// newHandler builds the virtual-mount handler. No symlinks: the contained viewer
// chrome (rootPath/.leji/viewer/) is served at "/", and the layer's markdown
// (rootPath/) under "/content/". The internal .leji path is reachable only
// through these mounts, never by a direct URL.
func newHandler(contentAbs, viewerAbs string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A malformed percent-encoding leaves RawPath set but Path empty/wrong;
		// detect a decode error and answer 400 rather than crash.
		urlPath, err := decodePath(r.URL)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte("bad request"))
			return
		}
		clean := filepath.ToSlash(filepath.Clean("/" + urlPath))
		rel := strings.TrimLeft(clean, "/")
		// Refuse any dotfile or VCS-internal segment in the REQUEST path: the .leji
		// viewer dir is reached only through the mounts below, never by direct URL.
		for _, seg := range strings.Split(rel, "/") {
			if seg == ".git" || (strings.HasPrefix(seg, ".") && seg != "." && seg != "") {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte("not found"))
				return
			}
		}
		// The generated sidebar lives in the viewer dir but is served as if at the
		// content root, so Docsify's basePath /content/ + _sidebar alias resolve it.
		if rel == "content/_sidebar.md" {
			serveFrom(w, viewerAbs, "_sidebar.md")
			return
		}
		if rel == "content" || strings.HasPrefix(rel, "content/") {
			sub := ""
			if rel != "content" {
				sub = rel[len("content/"):]
			}
			serveFrom(w, contentAbs, sub)
			return
		}
		// Everything else (`/`, /index.html, /assets/*) is viewer chrome.
		serveFrom(w, viewerAbs, rel)
	})
}

// decodePath returns the percent-decoded request path, or an error when the
// encoding is malformed (mirrors Node's decodeURIComponent throwing -> 400).
func decodePath(u *url.URL) (string, error) {
	if u.RawPath != "" {
		return url.PathUnescape(u.RawPath)
	}
	return u.Path, nil
}

// resolveRoot resolves symlinks in root, falling back to its absolute path.
func resolveRoot(root string) string {
	rootAbs, err := filepath.EvalSymlinks(root)
	if err != nil {
		rootAbs, _ = filepath.Abs(root)
	}
	return rootAbs
}

// Serve serves the viewer at the web root on 127.0.0.1, a virtual mount with no
// symlinks. Returns the listener and the http.Server. Port 0 picks a free port.
// rootRel is the context root (e.g. "docs"); the contained viewer is served at
// "/" and the content docs under "/content/".
func Serve(root string, port int, rootRel string) (net.Listener, *http.Server, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		return nil, nil, err
	}
	rootAbs := resolveRoot(root)
	contentAbs := rootAbs
	if base := fsx.StripSlash(rootRel); base != "" && base != "." {
		contentAbs = filepath.Join(rootAbs, base)
	}
	viewerAbs := filepath.Join(contentAbs, ".leji", "viewer")
	srv := &http.Server{Handler: newHandler(contentAbs, viewerAbs)}
	return ln, srv, nil
}

// OpenBrowser best-effort opens url in the default browser, used by --open /
// `leji view`. Never blocks and never fails the caller: a missing opener is a
// silent no-op, since opening the browser is a convenience, not part of serving.
func OpenBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	// Start (don't Wait): spawn detached and ignore any error.
	_ = cmd.Start()
}
