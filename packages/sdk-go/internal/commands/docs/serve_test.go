package docs

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestServePathContainment exercises the serve handler's path-containment guard:
// a normal file succeeds, while traversal, absolute, dotfile/.git, and symlink
// escapes are refused.
func TestServePathContainment(t *testing.T) {
	root := t.TempDir()
	rootAbs := resolveRoot(root)

	if err := os.WriteFile(filepath.Join(root, "index.html"), []byte("<h1>ok</h1>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".secret"), []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".git", "config"), []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}

	// A target outside the root and a symlink under the root pointing to it.
	outside := t.TempDir()
	secretPath := filepath.Join(outside, "outside.txt")
	if err := os.WriteFile(secretPath, []byte("escaped"), 0o644); err != nil {
		t.Fatal(err)
	}
	linkSupported := os.Symlink(secretPath, filepath.Join(root, "escape.txt")) == nil

	handler := newHandler(rootAbs)

	forbiddenOrNotFound := func(code int) bool {
		return code == http.StatusForbidden || code == http.StatusNotFound
	}

	type tc struct {
		name string
		path string
		want func(int) bool
	}
	cases := []tc{
		{"normal file", "/index.html", func(c int) bool { return c == http.StatusOK }},
		{"traversal", "/../../etc/passwd", forbiddenOrNotFound},
		{"absolute path", "/etc/passwd", forbiddenOrNotFound},
		{"dotfile", "/.secret", func(c int) bool { return c == http.StatusNotFound }},
		{"git path", "/.git/config", func(c int) bool { return c == http.StatusNotFound }},
	}
	if linkSupported && runtime.GOOS != "windows" {
		cases = append(cases, tc{"symlink escape", "/escape.txt", forbiddenOrNotFound})
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "http://example.com"+c.path, nil)
			// Preserve the raw (uncleaned) path so traversal reaches the handler.
			req.URL.Path = c.path
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if !c.want(rec.Code) {
				t.Fatalf("%s: unexpected status %d", c.path, rec.Code)
			}
		})
	}
}
