package initcmd

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/conformance"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/validate"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

// The "<named owner>" placeholder must serialize literally in leji.json to stay
// byte-identical across SDKs (Node JSON.stringify / Python json.dumps); the
// ordered encoder disables Go's default HTML-escaping of <, >, &.
func TestSerializeManifestDoesNotHTMLEscapeOwner(t *testing.T) {
	a := defaultAnswers(t.TempDir(), Options{})
	a.ownerName = "<named owner>"
	a.ownerContact = ""
	_, ord := buildManifest(a, nil)
	out := serializeManifest(ord)
	if !bytes.Contains(out, []byte("<named owner>")) {
		t.Fatalf("leji.json should contain the literal owner placeholder; got:\n%s", out)
	}
	// No legitimate \u escapes exist, so any \u proves <, >, or & was HTML-escaped.
	if bytes.Contains(out, []byte{'\\', 'u'}) {
		t.Fatalf("leji.json must not contain \\u escapes (HTML escaping of <, >, &); got:\n%s", out)
	}
}

func TestValidateRelPathRejectsUnsafePaths(t *testing.T) {
	for _, p := range []string{"", "/abs/x", "./leading", ".", "a\\b", "../escape", "docs/../../etc"} {
		if err := validateRelPath(p); err == nil {
			t.Fatalf("validateRelPath(%q) should have errored", p)
		}
	}
	for _, p := range []string{"docs/boot-profile.md", "a/b/c.md", "leji.json"} {
		if err := validateRelPath(p); err != nil {
			t.Fatalf("validateRelPath(%q) unexpected error: %v", p, err)
		}
	}
}

func TestResolveUnderRoot(t *testing.T) {
	root := t.TempDir()
	if _, err := resolveUnderRoot(root, "docs/x.md"); err != nil {
		t.Fatalf("valid path errored: %v", err)
	}
	if _, err := resolveUnderRoot(root, "../escape"); err == nil {
		t.Fatal("traversal should be rejected")
	}
}

// All-blank interactive input: every prompt falls back to default (core layer).
func TestInitLayerInteractiveDefaults(t *testing.T) {
	res, err := InitLayer(Options{Dir: t.TempDir(), In: strings.NewReader(strings.Repeat("\n", 12)), Out: io.Discard})
	if err != nil {
		t.Fatalf("interactive init (defaults): %v", err)
	}
	if !contains(res.Written, "leji.json") {
		t.Fatalf("leji.json not written: %v", res.Written)
	}
	if got := manifest.ClaimedLevel(res.Manifest); got != "core" {
		t.Fatalf("default level = %q, want core", got)
	}
	for _, c := range []string{"domain", "system", "decisions"} {
		if _, ok := res.Manifest.Categories[c]; !ok {
			t.Fatalf("default categories should include %q, got %v", c, res.Manifest.Categories)
		}
	}
}

// Explicit answers are honored (name, root, practice category, indexed level);
// indexed writes the index + changelog.
func TestInitLayerInteractiveAnswers(t *testing.T) {
	answers := "acme\nA layer.\nctx\nJo\njo@example.com\ny\ny\ny\nn\ny\n"
	res, err := InitLayer(Options{Dir: t.TempDir(), In: strings.NewReader(answers), Out: io.Discard})
	if err != nil {
		t.Fatalf("interactive init (answers): %v", err)
	}
	if res.Manifest.Name != "acme" {
		t.Fatalf("name = %q, want acme", res.Manifest.Name)
	}
	if res.Manifest.RootPath != "ctx/" {
		t.Fatalf("rootPath = %q, want ctx/", res.Manifest.RootPath)
	}
	if got := manifest.ClaimedLevel(res.Manifest); got != "indexed" {
		t.Fatalf("level = %q, want indexed", got)
	}
	if _, ok := res.Manifest.Categories["practice"]; !ok {
		t.Fatalf("practice should be mapped (answered y), got %v", res.Manifest.Categories)
	}
	var gotIndex, gotChangelog bool
	for _, w := range res.Written {
		if strings.Contains(w, "context-index.json") {
			gotIndex = true
		}
		if strings.Contains(w, "context-changelog.json") {
			gotChangelog = true
		}
	}
	if !gotIndex || !gotChangelog {
		t.Fatalf("indexed init should write the index + changelog, got %v", res.Written)
	}
}

func hasMachineKey(t *testing.T, dir string) bool {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "leji.json"))
	if err != nil {
		t.Fatalf("read leji.json: %v", err)
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(b, &obj); err != nil {
		t.Fatalf("parse leji.json: %v", err)
	}
	_, ok := obj["machine"]
	return ok
}

// Core init emits no machine block; decisions and agents still resolve to their
// defaults under rootPath.
func TestInitEmitsNoMachineBlockCore(t *testing.T) {
	dir := t.TempDir()
	res, err := InitLayer(Options{Dir: dir, Yes: true})
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if res.Manifest.Machine != nil {
		t.Fatalf("in-memory manifest should carry no machine block, got %#v", res.Manifest.Machine)
	}
	if hasMachineKey(t, dir) {
		t.Fatal("leji.json on disk should have no machine key")
	}
	for _, rel := range []string{"docs/decisions/0001-adopt-leji.md", "docs/agents/core.md"} {
		if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(rel))); err != nil {
			t.Fatalf("%s should exist at its default location: %v", rel, err)
		}
	}
}

// Indexed init: no machine key, yet index and changelog are written at the
// defaults and the resolvers find them.
func TestIndexedInitNoMachineKeyButFilesAtDefaults(t *testing.T) {
	dir := t.TempDir()
	res, err := InitLayer(Options{Dir: dir, Yes: true, Level: "indexed", Name: "acme-context"})
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if res.Manifest.Machine != nil {
		t.Fatalf("no machine block even at indexed level, got %#v", res.Manifest.Machine)
	}
	if hasMachineKey(t, dir) {
		t.Fatal("leji.json on disk should have no machine key")
	}
	for _, rel := range []string{"docs/context-index.json", "docs/context-changelog.json"} {
		if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(rel))); err != nil {
			t.Fatalf("%s should be written at its default location: %v", rel, err)
		}
	}
	if !contains(res.Written, "docs/context-index.json") {
		t.Fatalf("written should include docs/context-index.json, got %v", res.Written)
	}

	// Git baseline lets conformance verify indexed (changelog append-only +
	// git-required derive from it). A repository alone is not enough: append-only
	// compares against HEAD, so the tree has to be committed.
	gitInit(t, dir)
	gitCommitAll(t, dir)

	validation := validate.ValidateLayer(dir, false)
	for _, f := range validation.Findings {
		if f.Severity == findings.Error {
			t.Fatalf("indexed init should validate without errors, got %v", validation.Findings)
		}
	}
	report, rerr := conformance.Report(dir, false)
	if rerr != nil {
		t.Fatalf("conformance: %v", rerr)
	}
	if got := report.VerifiedLevel; got != "indexed" {
		t.Fatalf("conformance verifiedLevel = %q, want indexed", got)
	}
}

// init writes `.leji/` to a repo-root .gitignore, idempotently and without
// adding it to the written list.
func TestInitWritesGitignore(t *testing.T) {
	dir := t.TempDir()
	res, err := InitLayer(Options{Dir: dir, Yes: true})
	if err != nil {
		t.Fatalf("InitLayer: %v", err)
	}
	gitignore := filepath.Join(dir, ".gitignore")
	data, err := os.ReadFile(gitignore)
	if err != nil {
		t.Fatalf("expected .gitignore at the repo root: %v", err)
	}
	lines := strings.Split(string(data), "\n")
	count := 0
	for _, l := range lines {
		if l == ".leji/" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf(".leji/ should appear exactly once, got %d in %q", count, data)
	}
	if contains(res.Written, ".gitignore") {
		t.Fatalf(".gitignore must not be in the written list, got %v", res.Written)
	}
}
