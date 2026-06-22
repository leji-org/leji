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

// TestServeServesViewerAndContent exercises the virtual mount: the contained
// viewer chrome is served at the web root, the layer's markdown under /content/,
// and the generated sidebar as if at the content root. The internal .leji path is
// not reachable by a direct URL. Mirrors the Node/Python SDKs.
func TestServeServesViewerAndContent(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	if _, err := GenerateViewer(dir, m); err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	ln, srv, err := Serve(dir, 0, m.RootPath) // port 0 -> a free port
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

	// The viewer chrome is served at the web root, no redirect needed.
	if code, body := get("/"); code != http.StatusOK || !strings.Contains(body, "viewer-boot.js") {
		t.Fatalf("GET /: status %d (want 200) body lacks boot script", code)
	}
	// Viewer assets are served from the root.
	if code, _ := get("/assets/docsify.min.js"); code != http.StatusOK {
		t.Fatalf("GET /assets/docsify.min.js: status %d, want 200", code)
	}
	// The layer's markdown is mounted under /content/.
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
	// Path traversal is refused.
	if code, _ := get("/..%2f..%2fetc%2fpasswd"); code == http.StatusOK {
		t.Fatalf("GET traversal: status %d, want not 200", code)
	}
}

// TestServeSecurityBranches exercises the 400/404/403 guards: a malformed
// percent-encoding answers 400, a .git/dotfile segment 404, and a symlink under
// the content dir that resolves outside the root 403.
func TestServeSecurityBranches(t *testing.T) {
	dir := exampleCopy(t)
	m := manifest.LoadManifest(dir).Manifest
	if _, err := GenerateViewer(dir, m); err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	ln, srv, err := Serve(dir, 0, m.RootPath)
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
	// A symlink under the content dir that resolves outside the root -> 403.
	rootPath := strings.TrimRight(m.RootPath, "/")
	if os.Symlink("/etc/hosts", filepath.Join(dir, rootPath, "evil")) == nil {
		if code := status("/content/evil"); code != http.StatusForbidden {
			t.Fatalf("GET /content/evil: status %d, want 403", code)
		}
	}
}
