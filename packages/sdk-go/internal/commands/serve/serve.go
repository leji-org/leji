// Package serve is the viewer's local preview server: the virtual mounts, the
// route table, and the policy headers a browser sees. Every network import the CLI
// makes lives here and nowhere else — the static export is a separate package whose
// transitive imports carry none of them, which is what makes the export's
// no-network guarantee checkable rather than asserted.
package serve

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/indexgen"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/viewer"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/layout"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

const (
	// cspChrome is the SPA shell's policy, sent as a response header on every
	// chrome response so it holds for documents reached outside the shell too.
	// Mirrors the meta in templates/viewer/index.html; keep the two in step.
	cspChrome = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; frame-src 'none'"
	// cspContent is the policy for everything served out of the layer itself.
	// `sandbox` with no tokens puts a /content/ document in an opaque origin with
	// scripting off, so a governed file framed or opened directly is inert rather
	// than same-origin code.
	cspContent = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox"
)

// loopbackHosts are the host names the local preview answers to.
var loopbackHosts = map[string]bool{"localhost": true, "127.0.0.1": true, "[::1]": true}

// loopbackHost reports whether the Host header names the loopback interface:
// hostname only, since the port a request arrives on is already fixed by the
// loopback bind. A missing Host is accepted (an HTTP/1.0 client omits it).
func loopbackHost(host string) bool {
	if host == "" {
		return true
	}
	name := host
	if strings.HasPrefix(host, "[") {
		name = host[:strings.Index(host, "]")+1]
	} else if i := strings.Index(host, ":"); i >= 0 {
		name = host[:i]
	}
	return loopbackHosts[strings.ToLower(name)]
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

// serveFrom serves `sub` (clean relative path; "" -> index.html) from mountRoot.
// Lexically contains the target, applies the servable-roots whitelist by name,
// follows a dir to index.html, then realpath-checks so a symlink can't escape and
// judges the resolved path by the whitelist too. Mirrors Node: 200 ok, 403
// containment violation, 404 on a denied name or any stat/read failure. `inert`
// marks the layer's own content mount, whose files are never given an active
// content type however they are named.
func serveFrom(w http.ResponseWriter, rootAbs, mountRoot, sub string, inert bool) {
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
	// The servable-roots whitelist: under `.leji/`, only `viewer/` is servable.
	// Judged by name on the requested path and again on the resolved one, so a
	// symlink under the content root cannot reach a private role either.
	if !layout.ServablePath(rootAbs, abs) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("not found"))
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
	if !layout.ServablePath(rootAbs, real) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("not found"))
		return
	}
	body, err := os.ReadFile(real)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("not found"))
		return
	}
	ext := strings.ToLower(path.Ext(real))
	ct := contentTypes[ext]
	if ct == "" {
		ct = "application/octet-stream"
	}
	if inert && viewer.ActiveExtensions[ext] {
		ct = "text/plain; charset=utf-8"
	}
	w.Header().Set("content-type", ct)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// sidebarCache is the live-sidebar cache entry: the tree fingerprint it was built
// from, the assembled sidebar, (when the index generated cleanly) the serialized
// context index served live for the classification chip, and the manifest and entries
// that index projected, so the overview map is a projection of the same generation
// rather than a second one.
type sidebarCache struct {
	key       string
	body      string
	indexJSON string
	hasIndex  bool
	manifest  *manifest.Manifest
	entries   []indexgen.IndexEntry
}

// layerIndex is one clean generation of the layer: the manifest and the entries the
// overview map is rendered from. Kept as process state (the last one that generated
// cleanly), never as a file.
type layerIndex struct {
	manifest *manifest.Manifest
	entries  []indexgen.IndexEntry
}

// Options are what a direct caller already knows and the server would otherwise
// recompute. Entries is an index snapshot for the initial layer map: a caller that
// has just generated the viewer hands over what it projected, and a caller that
// passes none gets one live generation at startup instead.
//
// NIL is the only "no snapshot" spelling, standing for the reference's `undefined`;
// an EMPTY non-nil slice is a snapshot that says the layer governs nothing, and it
// suppresses the startup generation exactly as a full one does. `GenerateViewer`
// never returns a nil `IndexEntries`, so a caller that passes what it projected
// always passes a snapshot.
type Options struct {
	Entries []indexgen.IndexEntry
}

// testHookAfterAuthorize, when set by a test in this package, runs inside the overview
// route's allow predicate once every check has passed on the resolved source and
// before its bytes are taken. It exists for the one canary that has to land a symlink
// swap in that window deterministically, and is nil in every other run.
var testHookAfterAuthorize func()

// testHookIndexGenerated, when set by a test in this package, runs once per live index
// generation this server performs. It exists so a test can prove a generation did NOT
// happen (the supplied snapshot suppressing the startup one), which no response can
// show, and is nil in every other run.
var testHookIndexGenerated func()

// statusWriter records the status code written so the access log can report it.
type statusWriter struct {
	http.ResponseWriter
	code int
}

func (w *statusWriter) WriteHeader(code int) {
	w.code = code
	w.ResponseWriter.WriteHeader(code)
}

// newHandler builds the virtual-mount handler and nothing else — the servable
// roots: viewer chrome (root `.leji/viewer/`) at "/", the layer's markdown
// (rootPath/) under "/content/"; "/content/_sidebar.md" maps to the generated
// sidebar in viewer/. Everything else under `.leji/` is denied by name, so the
// private roles are unreachable however the request is spelled and whatever a
// symlink under the content root points at.
// The generated sidebar and the stored context index are served live from the
// tree (fingerprint-cached), so a long-running viewer never shows a deleted or
// moved document. logf, when set, receives one terse access-log line per request.
func newHandler(rootAbs, base, contentAbs, viewerAbs string, logf func(string), opts Options) http.Handler {
	// The content mount as it really is on disk: the boundary a resolved source is
	// judged against has to be resolved itself, or a symlinked rootPath component would
	// put every legitimate document outside its own mount.
	contentReal := contentAbs
	if resolved, ok := fsx.ResolvedPath(contentAbs); ok {
		contentReal = resolved
	}
	// withinContent reports whether a RESOLVED path lies under the content mount.
	withinContent := func(resolved string) bool {
		return strings.HasPrefix(resolved, contentReal+string(filepath.Separator))
	}
	// The layer root in the same resolved, absolute form: rootAbs is whatever the
	// caller named (the CLI's default `--root .` stays relative through EvalSymlinks),
	// and the guards below judge a path the resolver has already absolutized. Judging
	// an absolute source against a relative root reads as "outside the repository" and
	// refuses every page.
	resolvedRoot := rootAbs
	if resolved, ok := fsx.ResolvedPath(rootAbs); ok {
		resolvedRoot = resolved
	}
	// Live-sidebar cache, invalidated by a tree fingerprint: one stat pass over
	// leji.json + every markdown file under the content root (paths, mtimes,
	// sizes — no content reads). The common unchanged-tree reload serves the
	// cached string at stat cost; any create, delete, or edit still lands on the
	// very next fetch. WalkTree skips dotdirs, so the viewer's own artifacts
	// never invalidate the cache.
	var mu sync.Mutex
	var cache *sidebarCache
	treeFingerprint := func() string {
		var parts []string
		add := func(rel string) {
			st, err := os.Stat(filepath.Join(rootAbs, rel))
			if err != nil {
				parts = append(parts, rel+"\x00gone")
				return
			}
			parts = append(parts, fmt.Sprintf("%s\x00%d\x00%d", rel, st.ModTime().UnixNano(), st.Size()))
		}
		add("leji.json")
		walkBase := base
		if walkBase == "" {
			walkBase = "."
		}
		for _, rel := range fsx.WalkTree(rootAbs, walkBase) {
			add(rel)
		}
		return strings.Join(parts, "\n")
	}
	// refresh rebuilds the cache for key from the live tree; returns nil when the
	// manifest is missing or the tree will not index cleanly (callers then fall
	// back to the generated artifact).
	refresh := func(key string) *sidebarCache {
		load := manifest.LoadManifest(rootAbs)
		if load.Manifest == nil {
			return nil
		}
		// An operational failure reading the stored index is the same "cannot refresh"
		// answer a tree that will not index cleanly gives: the served page falls back to
		// the generated artifact rather than taking down the preview server.
		if testHookIndexGenerated != nil {
			testHookIndexGenerated()
		}
		idx, ierr := indexgen.GenerateIndex(rootAbs, load.Manifest)
		if ierr != nil {
			return nil
		}
		for _, f := range idx.Findings {
			if f.Severity == findings.Error {
				return nil
			}
		}
		var entries []indexgen.IndexEntry
		if idx.Index != nil {
			entries = idx.Index.Entries
		}
		var discard []findings.Finding
		c := &sidebarCache{
			key:      key,
			body:     viewer.AssembleSidebar(rootAbs, load.Manifest, entries, &discard),
			manifest: load.Manifest,
			entries:  entries,
		}
		if idx.Index != nil {
			c.indexJSON = indexgen.SerializeIndex(idx.Index)
			c.hasIndex = true
		}
		cache = c
		return c
	}
	// liveIndex is the one live index generation behind every generated route, cached
	// by the same fingerprint: the sidebar, the served context index, and the overview
	// map are projections of ONE index per tree state, never of three. Nil when the
	// layer cannot be indexed right now (no manifest, an error finding, or a generator
	// that failed), which is each route's cue to fall back.
	liveIndex := func() *sidebarCache {
		mu.Lock()
		defer mu.Unlock()
		key := treeFingerprint()
		c := cache
		if c == nil || c.key != key {
			c = refresh(key)
		}
		return c
	}
	// The layer map is process state, not a file. The overview route renders it into
	// the page's markers per fetch, from the live index above; the last index that
	// generated cleanly is kept, so a tree caught mid-edit still shows the map it last
	// had rather than a page with a hole in it. The initial one is computed here, by
	// the same generation the sidebar route makes per fetch, unless the caller handed
	// over the snapshot its own generation just produced.
	var lastGoodMu sync.Mutex
	var lastGoodMap *layerIndex
	if opts.Entries == nil {
		if c := liveIndex(); c != nil {
			lastGoodMap = &layerIndex{manifest: c.manifest, entries: c.entries}
		}
	} else if load := manifest.LoadManifest(rootAbs); load.Manifest != nil {
		lastGoodMap = &layerIndex{manifest: load.Manifest, entries: opts.Entries}
	}
	serveText := func(w http.ResponseWriter, contentType, body string) {
		w.Header().Set("content-type", contentType)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(body))
	}
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Policy headers ride every response, not just the SPA shell: a document
		// served straight out of /content/ is same-origin and would otherwise run
		// with no policy at all. Set before any write; the content mount downgrades
		// to the inert policy once the route is known.
		w.Header().Set("x-content-type-options", "nosniff")
		w.Header().Set("content-security-policy", cspChrome)
		// Loopback binding alone does not stop DNS rebinding: a hostile page whose
		// name resolves to 127.0.0.1 reaches this server with its own Host. Only the
		// loopback names the viewer is actually addressed by are answered. The port is
		// deliberately not part of the test: a rebound request carries the right port
		// anyway, so matching it adds nothing. Don't "fix" this by checking it.
		if !loopbackHost(r.Host) {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte("forbidden"))
			return
		}
		// A malformed percent-encoding leaves RawPath set but Path empty/wrong;
		// detect a decode error and answer 400 rather than crash.
		urlPath, err := decodePath(r.URL)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte("bad request"))
			return
		}
		rel := urlPathToRel(urlPath)
		if rel == "content" || strings.HasPrefix(rel, "content/") {
			w.Header().Set("content-security-policy", cspContent)
		}
		// Refuse any dotfile or VCS-internal segment in the request path: the .leji
		// viewer dir is reached only through the mounts below.
		for _, seg := range strings.Split(rel, "/") {
			if seg == ".git" || (strings.HasPrefix(seg, ".") && seg != "." && seg != "") {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte("not found"))
				return
			}
		}
		// The generated sidebar lives in the viewer dir but is served as if at the
		// content root, so Docsify's basePath /content/ + _sidebar alias resolve it.
		// Docsify fetches it once per page load, so it is rebuilt from the live tree
		// on every request: a long-running server never shows a deleted or moved
		// document. When the tree is mid-edit and will not index cleanly, fall back
		// to the last generated artifact rather than failing the dashboard.
		if rel == "content/_sidebar.md" {
			if c := liveIndex(); c != nil {
				serveText(w, "text/markdown; charset=utf-8", c.body)
				return
			}
			serveFrom(w, rootAbs, viewerAbs, "_sidebar.md", false)
			return
		}
		// The stored context index is served live (same fingerprint cache as the
		// sidebar), so per-page classification badges never disagree with the tree.
		if strings.HasPrefix(rel, "content/") {
			load := manifest.LoadManifest(rootAbs)
			if load.Manifest != nil {
				if idxRel, ok := viewer.RelativeToRoot(manifest.EffectiveIndexPath(load.Manifest), load.Manifest.RootPath); ok && rel == "content/"+idxRel {
					if c := liveIndex(); c != nil && c.hasIndex {
						serveText(w, "application/json; charset=utf-8", c.indexJSON)
						return
					}
				}
			}
		}
		// The generated Manifest page lives in the viewer dir (gitignored chrome) but
		// is linked from the sidebar and fetched under the content root, like
		// _sidebar.md. Reserved underscore name; served from the last generation.
		if rel == "content/_manifest.md" {
			serveFrom(w, rootAbs, viewerAbs, "_manifest.md", false)
			return
		}
		// The overview homepage is served RENDERED: the source bytes with the layer map
		// substituted between the author's markers, so the counts a reader sees are the
		// ones the tree has right now and the committed file is never rewritten to say
		// so. The route is a content route first: it makes every check serveFrom makes
		// on this path, with the same answers, plus the generation guards (repository
		// containment, no private `.leji/` role), because this is the one content path
		// the tool also writes.
		//
		// EVERY one of those checks is bound to the VERIFIED target, not to a path
		// resolved beforehand: the guarded read judges the resolved location, opens it,
		// proves the descriptor is that same regular file, and the bytes come from that
		// descriptor. A pre-read realpath plus a separate read leaves the window this
		// closes: a link swapped in between resolves somewhere else (inside the
		// repository, outside the content mount) and the read follows it past a check
		// that judged the old target.
		if rel == "content/"+viewer.OverviewRel {
			abs := filepath.Join(contentAbs, viewer.OverviewRel)
			// By name first, exactly as serveFrom does, before anything is resolved.
			if !layout.ServablePath(rootAbs, abs) {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte("not found"))
				return
			}
			src, err := fsx.OpenVerifiedSource(abs, func(resolved string) bool {
				ok := withinContent(resolved) &&
					layout.ServablePath(resolvedRoot, resolved) &&
					layout.WritableTarget(resolvedRoot, resolved, "").OK
				if ok && testHookAfterAuthorize != nil {
					testHookAfterAuthorize()
				}
				return ok
			})
			var source []byte
			landed := ""
			if err == nil {
				if src.Resolved {
					landed = src.Real
				}
				if src.File != nil {
					body, rerr := io.ReadAll(src.File)
					_ = src.File.Close()
					if rerr == nil {
						source = body
					}
				}
			}
			if source == nil {
				// The refusal names where the source resolves NOW: outside the content
				// mount is the mount's own answer (403), and everything else (a private
				// role, a directory, an absent or unresolvable entry) is a plain miss.
				if landed != "" && !withinContent(landed) {
					w.WriteHeader(http.StatusForbidden)
					_, _ = w.Write([]byte("forbidden"))
					return
				}
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte("not found"))
				return
			}
			// A live generation that fails outright (an unreadable content root, an
			// invalid manifest, a document the walk cannot read) serves the last map that
			// did generate; before the first one ever did, the source bytes as they are.
			// A source without markers is served unchanged whatever the index says.
			var index *layerIndex
			if c := liveIndex(); c != nil {
				index = &layerIndex{manifest: c.manifest, entries: c.entries}
			}
			lastGoodMu.Lock()
			if index != nil {
				lastGoodMap = index
			}
			mapIndex := index
			if mapIndex == nil {
				mapIndex = lastGoodMap
			}
			lastGoodMu.Unlock()
			body := source
			if mapIndex != nil {
				// Decoded the way Node's Buffer.toString('utf8') decodes, so a source that
				// is not valid UTF-8 renders to the same bytes in all three SDKs. Only the
				// rendered branch decodes; a markerless page is served raw below.
				if text, markersFound := viewer.RenderOverview(viewer.DecodeUTF8(source), mapIndex.manifest, mapIndex.entries); markersFound {
					body = []byte(text)
				}
			}
			w.Header().Set("content-type", "text/markdown; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(body)
			return
		}
		if rel == "content" || strings.HasPrefix(rel, "content/") {
			sub := ""
			if rel != "content" {
				sub = rel[len("content/"):]
			}
			// An agent profile that declares `inherits` is served resolved: the file
			// on disk is one half, and presenting it as the effective profile is the
			// thing a consumer must not do. So this branch fails closed. If anything
			// at all goes wrong, a file that declares `inherits` still gets a findings
			// page; only a file that is not half a profile falls through to disk.
			if strings.HasSuffix(sub, ".md") {
				repoRel := sub
				if base != "" && base != "." {
					repoRel = base + "/" + sub
				}
				page, served := "", false
				load := manifest.LoadManifest(rootAbs)
				if load.Manifest != nil {
					page, served = viewer.ResolvedProfilePage(rootAbs, load.Manifest, repoRel)
				} else if viewer.DeclaresInherits(rootAbs, repoRel) {
					page = viewer.UnresolvedProfilePage(repoRel, []findings.Finding{
						findings.New("artifact-parse", findings.Error, "the layer manifest could not be read", "leji.json"),
					})
					served = true
				}
				if served {
					serveText(w, "text/markdown; charset=utf-8", page)
					return
				}
			}
			serveFrom(w, rootAbs, contentAbs, sub, true)
			return
		}
		// Everything else (`/`, /index.html, /assets/*) is viewer chrome.
		serveFrom(w, rootAbs, viewerAbs, rel, false)
	})
	if logf == nil {
		return inner
	}
	// Access log: one terse line per request, after the status is known.
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sw := &statusWriter{ResponseWriter: w, code: http.StatusOK}
		inner.ServeHTTP(sw, r)
		logf(r.Method + " " + r.URL.RequestURI() + " " + strconv.Itoa(sw.code))
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

// urlPathToRel turns a request URL path into a clean relative route key.
// Separators fold to "/" and the path is cleaned against a root, so one request
// has one route key on any platform — filepath.Clean follows the host and
// answered differently on Windows, missing every "content/" route test.
// Canonicalization only; serveFrom enforces containment.
func urlPathToRel(urlPath string) string {
	return strings.TrimLeft(path.Clean("/"+strings.ReplaceAll(urlPath, "\\", "/")), "/")
}

// Serve serves the viewer at the web root on 127.0.0.1, returning the listener and
// http.Server. Port 0 picks a free port. rootRel is the context root (e.g. "docs");
// the viewer is served at "/" and content docs under "/content/". logf, when set,
// receives one access-log line per request. A caller that has just generated the
// viewer may hand over the index snapshot it projected as the initial layer map;
// one that passes none gets a live generation at startup instead.
func Serve(root string, port int, rootRel string, logf func(string), opts ...Options) (net.Listener, *http.Server, error) {
	rootAbs := resolveRoot(root)
	base := fsx.StripSlash(rootRel)
	contentAbs := rootAbs
	if base != "" && base != "." {
		contentAbs = filepath.Join(rootAbs, base)
	}
	// A direct SDK caller could pass an escaping rootRel (e.g. ".."); refuse to mount
	// content outside the layer root.
	if !fsx.ResolvedWithinRoot(rootAbs, contentAbs) {
		return nil, nil, fmt.Errorf("viewer root %q escapes the layer root", rootRel)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		return nil, nil, err
	}
	viewerAbs := layout.Abs(rootAbs, layout.ViewerRel)
	options := Options{}
	if len(opts) > 0 {
		options = opts[0]
	}
	srv := &http.Server{Handler: newHandler(rootAbs, base, contentAbs, viewerAbs, logf, options)}
	return ln, srv, nil
}

// OpenBrowser best-effort opens url in the default browser. Never blocks or fails
// the caller: a missing opener is a silent no-op.
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
