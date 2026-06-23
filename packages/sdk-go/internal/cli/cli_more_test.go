package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func example(t *testing.T) string {
	t.Helper()
	return filepath.Join(repoRoot(t), "examples", "monorepo")
}

func copyExample(t *testing.T) string {
	t.Helper()
	dst := t.TempDir()
	if err := os.CopyFS(dst, os.DirFS(example(t))); err != nil {
		t.Fatalf("copy example: %v", err)
	}
	return dst
}

// All optional flags parse; `version` returns before consuming them, so this
// exercises the parseFlags success branches without starting a server.
func TestCLIParseFlagsValidOptions(t *testing.T) {
	argv := []string{"--name", "acme", "--dir", t.TempDir(), "--open", "--check", "--strict", "--port", "0", "-y", "version"}
	if code, _, _ := captureRun(t, argv); code != 0 {
		t.Fatalf("valid flags exit %d", code)
	}
}

// Per-command flag surface from cli.json: globals everywhere, command flags only on
// their command; anything else is a usage error.
func TestCLIRejectsUndeclaredFlags(t *testing.T) {
	ex := example(t)
	for _, argv := range [][]string{
		{"validate", "--strict", "--root", ex},
		{"validate", "--check", "--root", ex},
		{"validate", "--open", "--root", ex},
		{"conformance", "--strict", "--root", ex},
		{"index", "--open", "--root", ex},
	} {
		if code, _, _ := captureRun(t, argv); code != 2 {
			t.Fatalf("%v expected exit 2, got %d", argv, code)
		}
	}
	for _, argv := range [][]string{
		{"index", "--check", "--root", ex},
		{"changelog", "check", "--strict", "--root", ex},
	} {
		if code, _, _ := captureRun(t, argv); code == 2 {
			t.Fatalf("%v should be accepted, got a usage error", argv)
		}
	}
}

func TestCLIParseFlagsMoreErrors(t *testing.T) {
	for _, argv := range [][]string{
		{"--dir"},
		{"--name"},
		{"--port", "abc", "validate"},
		{"--port", "70000", "validate"},
	} {
		if code, _, _ := captureRun(t, argv); code != 2 {
			t.Fatalf("%v expected exit 2, got %d", argv, code)
		}
	}
}

// Read-only commands against the example layer (which is inside the repo's git
// tree, so changelog/index checks resolve). Covers the Run dispatch for
// conformance, freshness, index --check, changelog check, plus the text/JSON
// rendering helpers (freshItems, checklistItems) and the commands/* packages.
func TestCLIReadCommandsOnExample(t *testing.T) {
	ex := example(t)
	for _, argv := range [][]string{
		{"conformance", "--root", ex},
		{"conformance", "--json", "--root", ex},
		{"freshness", "--root", ex},
		{"freshness", "--json", "--root", ex},
		{"index", "--check", "--root", ex},
		{"changelog", "check", "--root", ex},
		{"validate", "--json", "--root", ex},
	} {
		if code, _, errs := captureRun(t, argv); code != 0 {
			t.Fatalf("%v expected exit 0, got %d (%s)", argv, code, errs)
		}
	}
}

// Write commands operate on a throwaway copy / temp dir.
func TestCLIWriteCommandsOnCopy(t *testing.T) {
	cp := copyExample(t)
	if code, _, errs := captureRun(t, []string{"viewer", "--root", cp}); code != 0 {
		t.Fatalf("viewer exit %d (%s)", code, errs)
	}
	if code, _, errs := captureRun(t, []string{"index", "--root", cp}); code != 0 {
		t.Fatalf("index write exit %d (%s)", code, errs)
	}
	if code, _, errs := captureRun(t, []string{"init", "--yes", "--dir", t.TempDir()}); code != 0 {
		t.Fatalf("init exit %d (%s)", code, errs)
	}
}

// viewer prints the serve hint (parity with the Node/Python SDKs).
func TestCLIViewerServeHint(t *testing.T) {
	cp := copyExample(t)
	code, out, errs := captureRun(t, []string{"viewer", "--root", cp})
	if code != 0 {
		t.Fatalf("viewer exit %d (%s)", code, errs)
	}
	if !strings.Contains(out, "serve locally: leji view") {
		t.Fatalf("expected serve hint, got: %s", out)
	}
}

// bare viewer rejects --open (a serve-only flag): it belongs to `viewer serve`
// and `view`, not the generate-only bare `viewer`.
func TestCLIViewerRejectsOpen(t *testing.T) {
	cp := copyExample(t)
	code, out, errs := captureRun(t, []string{"viewer", "--open", "--root", cp})
	if code != 2 {
		t.Fatalf("viewer --open expected exit 2, got %d", code)
	}
	if !strings.Contains(out+errs, "not valid for \"viewer\"") {
		t.Fatalf("expected not-valid-for message, got: %s%s", out, errs)
	}
}

// `leji viewer <not-serve-or-build>` is a usage error.
func TestCLIViewerBadSub(t *testing.T) {
	cp := copyExample(t)
	code, out, errs := captureRun(t, []string{"viewer", "frobnicate", "--root", cp})
	if code != 2 {
		t.Fatalf("viewer frobnicate expected exit 2, got %d", code)
	}
	if !strings.Contains(out+errs, "usage: leji viewer [serve|build]") {
		t.Fatalf("expected viewer usage error, got: %s%s", out, errs)
	}
}

// `leji viewer build` exports a self-contained static folder carrying the protect
// warning (mirrors the Node units.test.ts viewer build test).
func TestCLIViewerBuild(t *testing.T) {
	cp := copyExample(t)
	code, out, errs := captureRun(t, []string{"viewer", "build", "--out", "out", "--root", cp})
	if code != 0 {
		t.Fatalf("viewer build exit %d (%s%s)", code, out, errs)
	}
	if !strings.Contains(out, "Exported the static viewer to out/") {
		t.Fatalf("expected export message, got: %s", out)
	}
	out2 := filepath.Join(cp, "out")
	for _, rel := range []string{
		filepath.Join("index.html"),
		filepath.Join("assets", "docsify.min.js"),
		filepath.Join("content", "boot-profile.md"),
		filepath.Join("content", "overview.md"),
		filepath.Join("content", "_sidebar.md"),
		filepath.Join("content", "domain", "glossary.md"),
	} {
		if _, err := os.Stat(filepath.Join(out2, rel)); err != nil {
			t.Fatalf("expected %s to exist: %v", rel, err)
		}
	}
	if _, err := os.Stat(filepath.Join(out2, "content", ".leji")); err == nil {
		t.Fatal("content/.leji should not be exported")
	}
	html, err := os.ReadFile(filepath.Join(out2, "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(html), "<!--") {
		t.Fatalf("expected prepended warning comment, got: %.20s", string(html))
	}
	if !strings.Contains(string(html), "Host the exported folder behind internal authentication") {
		t.Fatal("expected protect warning in exported index.html")
	}
}

// view (alias for `viewer serve`) is a recognized command: it dispatches, and on
// a dir with no manifest returns 1 before binding a server, so it never hangs.
func TestCLIViewCommandRecognized(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "no-manifest-here")
	code, out, errs := captureRun(t, []string{"view", "--root", missing})
	if code != 1 {
		t.Fatalf("view on a manifest-less dir: exit %d (out=%s err=%s)", code, out, errs)
	}
}

// `leji view <anything>` is a usage error (view takes no subcommand).
func TestCLIViewBadSub(t *testing.T) {
	cp := copyExample(t)
	code, out, errs := captureRun(t, []string{"view", "serve", "--root", cp})
	if code != 2 {
		t.Fatalf("view serve expected exit 2, got %d", code)
	}
	if !strings.Contains(out+errs, "usage: leji view") {
		t.Fatalf("expected view usage error, got: %s%s", out, errs)
	}
}

func TestCLIVersionCommandWord(t *testing.T) {
	if code, _, _ := captureRun(t, []string{"version"}); code != 0 {
		t.Fatalf("version command exit %d", code)
	}
}

// freshness --json on a layer with an expired horizon exercises the JSON item
// builder (freshItems) and the freshness report's expired path.
func TestCLIFreshnessJSONWithHorizons(t *testing.T) {
	dir := copyExample(t)
	doc := "---\nfreshness:\n  reviewAfter: 2000-01-01\n---\n# old\n"
	if err := os.WriteFile(filepath.Join(dir, "docs", "domain", "expired.md"), []byte(doc), 0o644); err != nil {
		t.Fatal(err)
	}
	code, out, _ := captureRun(t, []string{"freshness", "--json", "--root", dir})
	if code != 0 {
		t.Fatalf("freshness --json exit %d", code)
	}
	if !strings.Contains(out, "\"expired\"") {
		t.Fatalf("expected an expired list in json: %s", out)
	}
}

// index --json writes the index and renders it as JSON (WriteIndex + the JSON
// array helpers).
func TestCLIIndexJSONWrites(t *testing.T) {
	dir := copyExample(t)
	code, out, _ := captureRun(t, []string{"index", "--json", "--root", dir})
	if code != 0 {
		t.Fatalf("index --json exit %d", code)
	}
	if !strings.Contains(out, "\"entries\"") {
		t.Fatalf("expected entries in json: %s", out)
	}
}
