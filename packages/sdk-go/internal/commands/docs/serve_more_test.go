package docs

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

func TestResolveDocsPort(t *testing.T) {
	flag := 1234
	if got := ResolveDocsPort(&manifest.Manifest{}, &flag); got != 1234 {
		t.Fatalf("flag port: got %d, want 1234", got)
	}
	mp := 4321
	if got := ResolveDocsPort(&manifest.Manifest{DocsBlock: &manifest.Docs{Port: &mp}}, nil); got != 4321 {
		t.Fatalf("manifest port: got %d, want 4321", got)
	}
	if got := ResolveDocsPort(&manifest.Manifest{}, nil); got != 5354 {
		t.Fatalf("default port: got %d, want 5354", got)
	}
}

func TestServeRunsAndServesIndex(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "index.html"), []byte("<h1>hi</h1>"), 0o644); err != nil {
		t.Fatal(err)
	}
	ln, srv, err := Serve(root, 0) // port 0 -> a free port
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	go func() { _ = srv.Serve(ln) }()

	base := "http://" + ln.Addr().String()
	// "/" resolves to index.html (the directory branch); "/index.html" serves the file.
	for _, p := range []string{"/", "/index.html"} {
		resp, err := http.Get(base + p)
		if err != nil {
			t.Fatalf("GET %s: %v", p, err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s: status %d, want 200", p, resp.StatusCode)
		}
	}
}

// A directory request without a trailing slash redirects (301) so the viewer's
// relative asset paths resolve (e.g. /sub -> /sub/), matching the Node/Python SDKs.
func TestServeDirectoryTrailingSlashRedirect(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sub", "index.html"), []byte("<h1>sub</h1>"), 0o644); err != nil {
		t.Fatal(err)
	}
	handler := newHandler(resolveRoot(root))

	req := httptest.NewRequest(http.MethodGet, "http://example.com/sub", nil)
	req.URL.Path = "/sub"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusMovedPermanently {
		t.Fatalf("GET /sub: status %d, want 301", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != "/sub/" {
		t.Fatalf("GET /sub: Location %q, want \"/sub/\"", loc)
	}

	// With the trailing slash it serves the directory's index.html.
	req2 := httptest.NewRequest(http.MethodGet, "http://example.com/sub/", nil)
	req2.URL.Path = "/sub/"
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("GET /sub/: status %d, want 200", rec2.Code)
	}
}
