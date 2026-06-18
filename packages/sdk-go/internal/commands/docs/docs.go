// Package docs projects the context index into a static Docsify viewer and can
// serve the repository locally on 127.0.0.1.
package docs

import (
	"html"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
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
// (name, then homepage) and the absence of HTML escaping in jsonenc.Marshal make
// the serialized form byte-identical to the Node SDK's JSON.stringify output,
// before scriptSafeJSON escapes it for <script> embedding.
type docsifyConfig struct {
	Name     string `json:"name"`
	Homepage string `json:"homepage"`
}

// ResolveDocsPort: explicit flag, then manifest docs.port, then 5354.
func ResolveDocsPort(m *manifest.Manifest, flagPort *int) int {
	if flagPort != nil {
		return *flagPort
	}
	if m.DocsBlock != nil && m.DocsBlock.Port != nil {
		return *m.DocsBlock.Port
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

// BuildSidebar projects a deterministic Docsify sidebar from the index entries.
// Ungrouped entries (the boot profile) sit above a divider; the category groups
// follow below it, giving the viewer a two-tier sidebar.
func BuildSidebar(m *manifest.Manifest, entries []indexgen.IndexEntry) string {
	var topLines []string
	if boot, ok := relativeToRoot(m.BootProfilePath, m.RootPath); ok {
		topLines = append(topLines, "- [Boot profile]("+boot+")")
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
		groupLines = append(groupLines, "- "+categoryLabels[category])
		for _, e := range inCategory {
			groupLines = append(groupLines, "  - ["+e.title+"]("+e.rel+")")
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

// GenerateDocs writes index.html, _sidebar.md, and the vendored viewer assets
// into the context root.
func GenerateDocs(root string, m *manifest.Manifest) (Result, error) {
	result := indexgen.GenerateIndex(root, m)
	var entries []indexgen.IndexEntry
	if result.Index != nil {
		entries = result.Index.Entries
	}

	boot, ok := relativeToRoot(m.BootProfilePath, m.RootPath)
	if !ok {
		boot = "boot-profile.md"
	}
	htmlBytes, err := assets.FS.ReadFile("templates/docs-viewer.html")
	if err != nil {
		return Result{}, err
	}
	configBytes, err := jsonenc.Marshal(docsifyConfig{Name: m.Name, Homepage: boot})
	if err != nil {
		return Result{}, err
	}
	page := strings.ReplaceAll(string(htmlBytes), "{{LEJI_NAME_HTML}}", html.EscapeString(m.Name))
	page = strings.ReplaceAll(page, "{{DOCSIFY_CONFIG}}", scriptSafeJSON(configBytes))
	sidebar := BuildSidebar(m, entries)

	rootDir := fsx.StripSlash(m.RootPath)
	if rootDir == "" {
		rootDir = "."
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
	assetEntries, err := assets.FS.ReadDir("templates/docs-viewer-assets")
	if err != nil {
		return Result{}, err
	}
	for _, e := range assetEntries {
		if e.IsDir() || e.Name() == "PROVENANCE.txt" || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		content, err := assets.FS.ReadFile("templates/docs-viewer-assets/" + e.Name())
		if err != nil {
			return Result{}, err
		}
		files = append(files, struct {
			name    string
			content []byte
		}{"docs-viewer-assets/" + e.Name(), content})
	}
	for _, f := range files {
		rel := f.name
		if rootDir != "." {
			rel = rootDir + "/" + f.name
		}
		abs := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return Result{}, err
		}
		if err := os.WriteFile(abs, f.content, 0o644); err != nil {
			return Result{}, err
		}
		written = append(written, rel)
	}
	return Result{Written: written, Findings: result.Findings, Entries: len(entries)}, nil
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

// newHandler builds the static-site handler bound to an already-resolved root.
func newHandler(rootAbs string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		urlPath := r.URL.Path
		clean := filepath.Clean("/" + urlPath)
		rel := strings.TrimPrefix(clean, string(filepath.Separator))
		// Refuse any dotfile or .git segment outright (404).
		for _, seg := range strings.Split(filepath.ToSlash(rel), "/") {
			if seg == "" {
				continue
			}
			if seg == ".git" || strings.HasPrefix(seg, ".") {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte("not found"))
				return
			}
		}
		abs := filepath.Join(rootAbs, rel)
		if abs != rootAbs && !strings.HasPrefix(abs, rootAbs+string(filepath.Separator)) {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte("forbidden"))
			return
		}
		info, err := os.Stat(abs)
		if err != nil {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte("not found"))
			return
		}
		if info.IsDir() {
			// Redirect a directory request without a trailing slash so the
			// viewer's relative asset paths resolve (e.g. /docs -> /docs/).
			if !strings.HasSuffix(r.URL.Path, "/") {
				http.Redirect(w, r, r.URL.Path+"/", http.StatusMovedPermanently)
				return
			}
			abs = filepath.Join(abs, "index.html")
		}
		// Resolve symlinks and re-check containment to close the symlink escape.
		resolved, err := filepath.EvalSymlinks(abs)
		if err != nil {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte("not found"))
			return
		}
		if resolved != rootAbs && !strings.HasPrefix(resolved, rootAbs+string(filepath.Separator)) {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte("forbidden"))
			return
		}
		abs = resolved
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
	})
}

// resolveRoot resolves symlinks in root, falling back to its absolute path.
func resolveRoot(root string) string {
	rootAbs, err := filepath.EvalSymlinks(root)
	if err != nil {
		rootAbs, _ = filepath.Abs(root)
	}
	return rootAbs
}

// Serve serves the repository root as a static site on 127.0.0.1. Returns the
// listener and the http.Server. Port 0 picks a free port.
func Serve(root string, port int) (net.Listener, *http.Server, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		return nil, nil, err
	}
	srv := &http.Server{Handler: newHandler(resolveRoot(root))}
	return ln, srv, nil
}
