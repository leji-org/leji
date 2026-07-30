package viewer

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

func TestResolveViewerPort(t *testing.T) {
	flag := 1234
	if got := ResolveViewerPort(&manifest.Manifest{}, &flag); got != 1234 {
		t.Fatalf("flag port: got %d, want 1234", got)
	}
	mp := 4321
	if got := ResolveViewerPort(&manifest.Manifest{Viewer: &manifest.Viewer{Port: &mp}}, nil); got != 4321 {
		t.Fatalf("manifest port: got %d, want 4321", got)
	}
	if got := ResolveViewerPort(&manifest.Manifest{}, nil); got != 5354 {
		t.Fatalf("default port: got %d, want 5354", got)
	}
}

func TestServeServesViewerAndContent(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	if _, err := GenerateViewer(dir, m); err != nil {
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
	if _, err := GenerateViewer(dir, m); err != nil {
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
	if _, err := GenerateViewer(dir, m); err != nil {
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
	if code, body := get("/content/_sidebar.md"); code != http.StatusOK || !strings.Contains(body, "[Fresh Note](fresh-note.md)") {
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
	if _, err := GenerateViewer(dir, m); err != nil {
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
	if _, err := GenerateViewer(dir, m); err != nil {
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
