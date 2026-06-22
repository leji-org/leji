package viewer

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestServePathContainment exercises the virtual-mount handler's guards: viewer
// chrome served at the web root, content under /content/, while traversal,
// dotfile/.git, and symlink escapes are refused.
func TestServePathContainment(t *testing.T) {
	root := t.TempDir()
	contentAbs := resolveRoot(root)
	viewerAbs := filepath.Join(contentAbs, ".leji", "viewer")

	if err := os.MkdirAll(viewerAbs, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(viewerAbs, "index.html"), []byte("<h1>ok</h1>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(contentAbs, "doc.md"), []byte("# doc"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(contentAbs, ".secret"), []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(contentAbs, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}

	// A target outside the root and a symlink under the content dir pointing to it.
	outside := t.TempDir()
	secretPath := filepath.Join(outside, "outside.txt")
	if err := os.WriteFile(secretPath, []byte("escaped"), 0o644); err != nil {
		t.Fatal(err)
	}
	linkSupported := os.Symlink(secretPath, filepath.Join(contentAbs, "escape.txt")) == nil

	handler := newHandler(contentAbs, viewerAbs)

	type tc struct {
		name string
		path string
		want func(int) bool
	}
	is := func(code int) func(int) bool { return func(c int) bool { return c == code } }
	forbiddenOrNotFound := func(c int) bool {
		return c == http.StatusForbidden || c == http.StatusNotFound
	}
	cases := []tc{
		{"web root -> viewer index", "/", is(http.StatusOK)},
		{"content file", "/content/doc.md", is(http.StatusOK)},
		{"traversal", "/../../etc/passwd", forbiddenOrNotFound},
		{"dotfile", "/content/.secret", is(http.StatusNotFound)},
		{"git path", "/.git/config", is(http.StatusNotFound)},
		{".leji not reachable", "/content/.leji/viewer/index.html", is(http.StatusNotFound)},
	}
	if linkSupported && runtime.GOOS != "windows" {
		cases = append(cases, tc{"symlink escape", "/content/escape.txt", forbiddenOrNotFound})
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "http://example.com"+c.path, nil)
			// Preserve the raw (uncleaned) path so traversal reaches the handler.
			req.URL.Path = c.path
			req.URL.RawPath = c.path
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if !c.want(rec.Code) {
				t.Fatalf("%s: unexpected status %d", c.path, rec.Code)
			}
		})
	}
}
