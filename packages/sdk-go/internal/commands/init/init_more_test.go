package initcmd

import (
	"io"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

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

// Interactive init with all-blank input: every prompt falls back to its default,
// producing a core layer with domain+system+decisions mapped.
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

// Interactive init with explicit answers: the answers are honored (name, root,
// the practice category from a `y`, the indexed level) and indexed writes the
// machine index + changelog.
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
