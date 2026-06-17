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
	argv := []string{"--name", "acme", "--dir", t.TempDir(), "--serve", "--check", "--strict", "--port", "0", "-y", "version"}
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
		{"validate", "--serve", "--root", ex},
		{"conformance", "--strict", "--root", ex},
		{"index", "--serve", "--root", ex},
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
	if code, _, errs := captureRun(t, []string{"docs", "--root", cp}); code != 0 {
		t.Fatalf("docs exit %d (%s)", code, errs)
	}
	if code, _, errs := captureRun(t, []string{"index", "--root", cp}); code != 0 {
		t.Fatalf("index write exit %d (%s)", code, errs)
	}
	if code, _, errs := captureRun(t, []string{"init", "--yes", "--dir", t.TempDir()}); code != 0 {
		t.Fatalf("init exit %d (%s)", code, errs)
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
