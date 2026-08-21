package serve

import (
	"bufio"
	"bytes"
	"io"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/export"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/viewer"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

// exampleCopy is a scratch copy of the example layer, the fixture the serve legs
// answer requests against.
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

func TestServeServesViewerAndContent(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	if _, err := viewer.GenerateViewer(dir, m); err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	ln, srv, err := Serve(dir, 0, m.RootPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	go func() { _ = srv.Serve(ln) }()

	base := "http://" + ln.Addr().String()
	get := func(p string) (int, string) {
		resp, err := http.Get(base + p)
		if err != nil {
			t.Fatalf("GET %s: %v", p, err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp.StatusCode, string(body)
	}

	if code, body := get("/"); code != http.StatusOK || !strings.Contains(body, "viewer-boot.js") {
		t.Fatalf("GET /: status %d (want 200) body lacks boot script", code)
	}
	if code, _ := get("/assets/docsify.min.js"); code != http.StatusOK {
		t.Fatalf("GET /assets/docsify.min.js: status %d, want 200", code)
	}
	if code, _ := get("/content/domain/glossary.md"); code != http.StatusOK {
		t.Fatalf("GET /content/domain/glossary.md: status %d, want 200", code)
	}
	// The generated sidebar is served as if at the content root.
	if code, _ := get("/content/_sidebar.md"); code != http.StatusOK {
		t.Fatalf("GET /content/_sidebar.md: status %d, want 200", code)
	}
	// The internal .leji path is not reachable by a direct URL.
	if code, _ := get("/content/.leji/viewer/index.html"); code != http.StatusNotFound {
		t.Fatalf("GET /content/.leji/viewer/index.html: status %d, want 404", code)
	}
	if code, _ := get("/..%2f..%2fetc%2fpasswd"); code == http.StatusOK {
		t.Fatalf("GET traversal: status %d, want not 200", code)
	}
}

func TestServeSecurityBranches(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	if _, err := viewer.GenerateViewer(dir, m); err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	ln, srv, err := Serve(dir, 0, m.RootPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	go func() { _ = srv.Serve(ln) }()

	// Send a raw request line so malformed/uncleaned paths reach the server intact
	// (the http.Client would normalize or reject them client-side first).
	status := func(rawPath string) int {
		conn, err := net.Dial("tcp", ln.Addr().String())
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		defer conn.Close()
		_, _ = conn.Write([]byte("GET " + rawPath + " HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"))
		resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatalf("read response for %s: %v", rawPath, err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		return resp.StatusCode
	}

	if code := status("/%E0%A4%A"); code != http.StatusBadRequest {
		t.Fatalf("GET /%%E0%%A4%%A: status %d, want 400", code)
	}
	if code := status("/.git/config"); code != http.StatusNotFound {
		t.Fatalf("GET /.git/config: status %d, want 404", code)
	}
	if code := status("/"); code != http.StatusOK {
		t.Fatalf("GET /: status %d, want 200", code)
	}
	if code := status("/content/.leji/viewer/index.html"); code != http.StatusNotFound {
		t.Fatalf("GET /content/.leji/viewer/index.html: status %d, want 404", code)
	}
	rootPath := strings.TrimRight(m.RootPath, "/")
	if os.Symlink("/etc/hosts", filepath.Join(dir, rootPath, "evil")) == nil {
		if code := status("/content/evil"); code != http.StatusForbidden {
			t.Fatalf("GET /content/evil: status %d, want 403", code)
		}
	}
}

// The served sidebar and context index are live: a document added after
// generation shows up on the next fetch without regenerating, and the index
// endpoint serves the freshly generated JSON (the classification chip's source).
func TestServeLiveSidebarAndIndex(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	if _, err := viewer.GenerateViewer(dir, m); err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	ln, srv, err := Serve(dir, 0, m.RootPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	go func() { _ = srv.Serve(ln) }()

	base := "http://" + ln.Addr().String()
	get := func(p string) (int, string) {
		resp, err := http.Get(base + p)
		if err != nil {
			t.Fatalf("GET %s: %v", p, err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp.StatusCode, string(body)
	}

	if code, body := get("/content/_sidebar.md"); code != http.StatusOK || !strings.Contains(body, "Glossary") {
		t.Fatalf("GET /content/_sidebar.md: status %d, body %q", code, body)
	}
	// A new ungoverned doc lands in the Reference drawer on the very next fetch,
	// without regenerating the viewer.
	rootPath := strings.TrimRight(m.RootPath, "/")
	extra := filepath.Join(dir, rootPath, "fresh-note.md")
	if err := os.WriteFile(extra, []byte("---\ntitle: Fresh Note\n---\n\n# Fresh Note\n"), 0o644); err != nil {
		t.Fatalf("write fresh-note.md: %v", err)
	}
	if code, body := get("/content/_sidebar.md"); code != http.StatusOK || !strings.Contains(body, "[Fresh Note](/fresh-note.md)") {
		t.Fatalf("expected the live sidebar to pick up the new doc, status %d, body %q", code, body)
	}
	if _, body := get("/content/_sidebar.md"); !strings.Contains(body, "- **Reference**") {
		t.Fatalf("expected the reference drawer around ungoverned docs, body %q", body)
	}
	// The stored index path serves the live index JSON.
	code, body := get("/content/context-index.json")
	if code != http.StatusOK || !strings.Contains(body, `"entries"`) {
		t.Fatalf("GET /content/context-index.json: status %d, body %q", code, body)
	}
}

// A direct SDK caller cannot mount content outside the layer root via an
// escaping rootRel (e.g. "..").
func TestServeRejectsEscapingRootRel(t *testing.T) {
	dir := exampleCopy(t)
	for _, rootRel := range []string{"..", "../.."} {
		ln, srv, err := Serve(dir, 0, rootRel, nil)
		if err == nil {
			if srv != nil {
				srv.Close()
			}
			if ln != nil {
				_ = ln.Close()
			}
			t.Fatalf("Serve(%q): expected an error, got nil", rootRel)
		}
		if !strings.Contains(err.Error(), "escapes the layer root") {
			t.Fatalf("Serve(%q): error %q, want it to mention escaping the layer root", rootRel, err)
		}
	}
}

// Every response carries the policy headers, and the layer's own files never come
// back with an active content type: same-origin execution of governed content was
// the reported blocker.
func TestServeSendsPolicyHeadersAndInertContentTypes(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	rootPath := strings.TrimRight(m.RootPath, "/")
	for name, body := range map[string]string{
		"evil.html": "<script>alert(1)</script>",
		"evil.svg":  `<svg xmlns="http://www.w3.org/2000/svg"></svg>`,
	} {
		if err := os.WriteFile(filepath.Join(dir, rootPath, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := viewer.GenerateViewer(dir, m); err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	ln, srv, err := Serve(dir, 0, m.RootPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	go func() { _ = srv.Serve(ln) }()

	base := "http://" + ln.Addr().String()
	get := func(p string) *http.Response {
		resp, err := http.Get(base + p)
		if err != nil {
			t.Fatalf("GET %s: %v", p, err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		return resp
	}

	if ct := get("/content/evil.html").Header.Get("content-type"); ct != "text/plain; charset=utf-8" {
		t.Fatalf("GET /content/evil.html: content-type %q, want text/plain", ct)
	}
	// SVG keeps its real type so a configured logo/favicon still renders. Its
	// inertness is the policy's job, not the content type's: the sandbox puts a
	// navigated or framed SVG in an opaque origin with scripting off.
	svg := get("/content/evil.svg")
	if ct := svg.Header.Get("content-type"); ct != "image/svg+xml" {
		t.Fatalf("GET /content/evil.svg: content-type %q, want image/svg+xml", ct)
	}
	if csp := svg.Header.Get("content-security-policy"); !strings.Contains(csp, "sandbox") {
		t.Fatalf("GET /content/evil.svg: policy %q, want the sandbox", csp)
	}
	if got := svg.Header.Get("x-content-type-options"); got != "nosniff" {
		t.Fatalf("GET /content/evil.svg: x-content-type-options %q, want nosniff", got)
	}
	// The policy rides every route, 404s and chrome included.
	for _, p := range []string{"/", "/assets/docsify.min.js", "/content/domain/glossary.md", "/content/nope.md"} {
		resp := get(p)
		if got := resp.Header.Get("x-content-type-options"); got != "nosniff" {
			t.Fatalf("GET %s: x-content-type-options %q, want nosniff", p, got)
		}
		if resp.Header.Get("content-security-policy") == "" {
			t.Fatalf("GET %s: no content-security-policy", p)
		}
	}
	// The shell keeps its own policy; layer content gets the inert one.
	shell := get("/").Header.Get("content-security-policy")
	if !strings.Contains(shell, "script-src 'self'") || !strings.Contains(shell, "frame-src 'none'") {
		t.Fatalf("chrome policy = %q", shell)
	}
	if doc := get("/content/domain/glossary.md").Header.Get("content-security-policy"); !strings.Contains(doc, "sandbox") {
		t.Fatalf("content policy = %q", doc)
	}
}

// Loopback binding alone does not stop DNS rebinding: only the names the viewer is
// actually addressed by are answered.
func TestServeRejectsForeignHost(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	if _, err := viewer.GenerateViewer(dir, m); err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	ln, srv, err := Serve(dir, 0, m.RootPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	go func() { _ = srv.Serve(ln) }()

	// A raw request line: the http.Client always sends the dialed authority.
	status := func(host string) int {
		conn, err := net.Dial("tcp", ln.Addr().String())
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		defer conn.Close()
		_, _ = conn.Write([]byte("GET / HTTP/1.1\r\nHost: " + host + "\r\nConnection: close\r\n\r\n"))
		resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatalf("read response for %s: %v", host, err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		return resp.StatusCode
	}

	for _, host := range []string{"localhost", "localhost:5354", "127.0.0.1", "[::1]:5354"} {
		if code := status(host); code != http.StatusOK {
			t.Fatalf("Host %q: status %d, want 200", host, code)
		}
	}
	for _, host := range []string{"evil.example", "rebound.example:5354"} {
		if code := status(host); code != http.StatusForbidden {
			t.Fatalf("Host %q: status %d, want 403", host, code)
		}
	}
}

// --- link classes stay inside the router (serve half) ---
// The generation half — sidebar destinations emitted app-root absolute — is pinned
// in viewer_more_test.go. These pin what the server answers: an untouched document
// body, the routing config in the shipped boot script, the click paths off a nested
// page, and the not-found contract.

// serveOnFreePort serves dir's viewer on a free loopback port, returning the base
// URL; the server is closed when the test ends.
func serveOnFreePort(t *testing.T, dir, rootRel string) string {
	t.Helper()
	ln, srv, err := Serve(dir, 0, rootRel, nil)
	if err != nil {
		t.Fatalf("Serve: %v", err)
	}
	t.Cleanup(func() { srv.Close() })
	go func() { _ = srv.Serve(ln) }()
	return "http://" + ln.Addr().String()
}

// fetch GETs url and returns the status and the full response body.
func fetch(t *testing.T, url string) (int, []byte) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body of %s: %v", url, err)
	}
	return resp.StatusCode, body
}

func TestServeLeavesDocumentBytesAlone(t *testing.T) {
	dir := exampleCopy(t)
	// One instance of every link class a real document mixes. Routing is config plus
	// the generated sidebar, never a transform over the author's markdown, so the
	// served bytes are the file's. How an image path resolves under relativePath is
	// a separate item and is deliberately not asserted here.
	body := strings.Join([]string{
		"# Links",
		"",
		"- [parent](../target.md)",
		"- [sibling](sibling.md)",
		"- [root](/root-target.md)",
		"- [fragment](#fragment)",
		"- [doc fragment](target.md#fragment)",
		"- [query](target.md?q=1)",
		"- [external](https://leji.org/spec)",
		"",
		"![x](assets/x.svg)",
		"",
		`<img src="assets/x.svg">`,
		"",
	}, "\n")
	writeUnder(t, dir, "docs/notes/deep/links.md", body)
	m := manifest.LoadManifest(dir).Manifest
	if _, err := viewer.GenerateViewer(dir, m); err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	base := serveOnFreePort(t, dir, m.RootPath)

	code, served := fetch(t, base+"/content/notes/deep/links.md")
	if code != http.StatusOK {
		t.Fatalf("GET /content/notes/deep/links.md: status %d, want 200", code)
	}
	onDisk, err := os.ReadFile(filepath.Join(dir, "docs", "notes", "deep", "links.md"))
	if err != nil {
		t.Fatalf("read links.md: %v", err)
	}
	if !bytes.Equal(served, onDisk) {
		t.Fatalf("the viewer never rewrites document markdown:\n got=%q\nwant=%q", served, onDisk)
	}
}

func TestRoutingConfigShipsServedAndBuilt(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	if _, err := viewer.GenerateViewer(dir, m); err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	// Both settings live in the boot script's static overlay, not the injected JSON
	// config block, so the assertion is on the asset text.
	assertRouting := func(boot, where string) {
		t.Helper()
		for _, want := range []*regexp.Regexp{
			regexp.MustCompile(`relativePath:\s*true`),
			regexp.MustCompile(`notFoundPage:\s*false`),
		} {
			if !want.MatchString(boot) {
				t.Fatalf("expected %s in the %s boot script", want, where)
			}
		}
	}
	base := serveOnFreePort(t, dir, m.RootPath)
	code, boot := fetch(t, base+"/assets/viewer-boot.js")
	if code != http.StatusOK {
		t.Fatalf("GET /assets/viewer-boot.js: status %d, want 200", code)
	}
	assertRouting(string(boot), "served")

	if _, err := export.BuildViewer(dir, m, "out", export.Options{}); err != nil {
		t.Fatalf("BuildViewer: %v", err)
	}
	built, err := os.ReadFile(filepath.Join(dir, "out", "assets", "viewer-boot.js"))
	if err != nil {
		t.Fatalf("read the built boot script: %v", err)
	}
	assertRouting(string(built), "built")
}

// resolveRoute resolves a markdown destination the way Docsify's relativePath
// routing does: against the linking document's own directory, except a
// leading-slash destination, which is app-root (content-root) absolute.
func resolveRoute(fromRel, dest string) string {
	if strings.HasPrefix(dest, "/") {
		return dest[1:]
	}
	return path.Join(path.Dir(fromRel), dest)
}

func TestServeAnswersTheLinksANestedPageCarries(t *testing.T) {
	dir := exampleCopy(t)
	writeUnder(t, dir, "docs/practice/feature-workflow.md", "# Feature workflow\n")
	writeUnder(t, dir, "docs/work/spec.md", "# Spec\n")
	writeUnder(t, dir, "docs/work/README.md", strings.Join([]string{
		"# Work",
		"",
		"- [workflow](../practice/feature-workflow.md)",
		"- [spec](spec.md)",
		"- [glossary](/domain/glossary.md)",
		"",
	}, "\n"))
	m := manifest.LoadManifest(dir).Manifest
	if _, err := viewer.GenerateViewer(dir, m); err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	base := serveOnFreePort(t, dir, m.RootPath)

	for _, dest := range []string{"../practice/feature-workflow.md", "spec.md", "/domain/glossary.md"} {
		target := resolveRoute("work/README.md", dest)
		if code, _ := fetch(t, base+"/content/"+target); code != http.StatusOK {
			t.Fatalf("%s routes to /content/%s: status %d, want 200", dest, target, code)
		}
	}
	// The pre-fix escape: the same `../` destination resolved against the server
	// root instead of the router. The server has no such route, which is exactly
	// why the link must stay in-app.
	if code, _ := fetch(t, base+"/practice/feature-workflow.md"); code != http.StatusNotFound {
		t.Fatalf("leaving the router lands on a URL the server cannot answer: status %d, want 404", code)
	}
}

func TestServeUnknownDocumentRouteIsTheOnly404(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	res, err := viewer.GenerateViewer(dir, m)
	if err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	// The config disables Docsify's secondary _404.md fetch (pinned by the routing
	// config test above) and the viewer generates no such page. That the browser
	// therefore makes exactly one failing request is verified at the browser level,
	// not here.
	if _, err := os.Stat(filepath.Join(dir, ".leji", "viewer", "_404.md")); err == nil {
		t.Fatal("expected no _404.md in the generated viewer")
	}
	for _, w := range res.Written {
		if strings.HasSuffix(w, "_404.md") {
			t.Fatalf("_404.md is not written anywhere, got %q", w)
		}
	}
	base := serveOnFreePort(t, dir, m.RootPath)
	if code, _ := fetch(t, base+"/content/does-not-exist.md"); code != http.StatusNotFound {
		t.Fatalf("the missing document itself is the one 404: status %d, want 404", code)
	}
}
