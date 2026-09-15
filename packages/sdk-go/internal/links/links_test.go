package links

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The in-layer link scan, over the same committed fixture bytes the Node SDK's
// test/links.test.ts asserts against, case for case.
//
// The fixture runner compares findings on (rule, severity, path) alone, so the two
// halves of this rule it cannot see are pinned here: which destination the grammar
// reads out of each spelling, the line it reports, and the path that destination
// resolves to.

func repoRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	// internal/links -> packages/sdk-go -> packages -> the repository root.
	root, err := filepath.Abs(filepath.Join(wd, "..", "..", "..", ".."))
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	return root
}

func fixture(t *testing.T, name string) string {
	t.Helper()
	return filepath.Join(repoRoot(t), "fixtures", name)
}

// triple is one link as the (target as written, resolved path, line) contract, the
// resolved path repository-root-relative POSIX and empty for a destination this rule
// never judges.
type triple struct {
	target   string
	resolved string
	line     int
}

func triples(t *testing.T, root, relPath string) []triple {
	t.Helper()
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	layerRootAbs := filepath.Join(rootAbs, "docs")
	text, err := os.ReadFile(filepath.Join(rootAbs, filepath.FromSlash(relPath)))
	if err != nil {
		t.Fatalf("read %s: %v", relPath, err)
	}
	var out []triple
	for _, link := range ScanLinks(string(text)) {
		resolved := ""
		if abs, ok := ResolveTarget(rootAbs, layerRootAbs, relPath, link.Target); ok {
			rel, err := filepath.Rel(rootAbs, abs)
			if err != nil {
				t.Fatalf("rel: %v", err)
			}
			resolved = filepath.ToSlash(rel)
		}
		out = append(out, triple{target: link.Target, resolved: resolved, line: link.Line})
	}
	return out
}

func assertTriples(t *testing.T, got, want []triple) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d links, want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("link %d: got %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestValidLinksEverySpellingItsResolvedPathAndItsLine(t *testing.T) {
	assertTriples(t, triples(t, fixture(t, "valid-links"), "docs/domain/overview.md"), []triple{
		{"dir/README.md", "docs/domain/dir/README.md", 5},
		{"../boot-profile.md", "docs/boot-profile.md", 6},
		{"/decisions/0001-adopt-leji.md", "docs/decisions/0001-adopt-leji.md", 7},
		// A directory resolves to the directory; the README inside it is what makes
		// the target answerable, and the existence rule reads it.
		{"dir/", "docs/domain/dir", 8},
		// Never judged: a bare fragment, and anything carrying a URI scheme.
		{"#overview", "", 9},
		{"https://leji.org/spec/", "", 10},
		{"mailto:owner@example.invalid", "", 11},
		{"dir/with%20space.md", "docs/domain/dir/with space.md", 12},
		// The three spellings of a path a bare run cannot carry plainly: balanced
		// parentheses, the angle-bracketed form, and the backslash-escaped form the
		// viewer emits for a generated link. All three resolve to the same file.
		{"dir/(x).md", "docs/domain/dir/(x).md", 13},
		{"dir/with space.md", "docs/domain/dir/with space.md", 14},
		{`dir/\(x\).md`, "docs/domain/dir/(x).md", 15},
		{"diagram.svg", "docs/domain/diagram.svg", 16},
		// The reference definition on the last line, its title read only far enough
		// to establish that the line is a definition, then discarded.
		{"crlf.md", "docs/domain/crlf.md", 27},
	})
}

func TestValidLinksACodeSpanAndAFencedBlockAreCodeCRLFIncluded(t *testing.T) {
	root := fixture(t, "valid-links")
	crlf, err := os.ReadFile(filepath.Join(root, "docs", "domain", "crlf.md"))
	if err != nil {
		t.Fatalf("read crlf.md: %v", err)
	}
	if !strings.Contains(string(crlf), "\r\n") {
		t.Fatal("the fixture is stored with CRLF line endings")
	}
	assertTriples(t, triples(t, root, "docs/domain/crlf.md"), []triple{
		{"overview.md", "docs/domain/overview.md", 6},
	})
}

func TestInvalidLinkSplitLineASplitBracketParenIsNotALink(t *testing.T) {
	assertTriples(t, triples(t, fixture(t, "invalid-link-split-line"), "docs/domain/overview.md"), []triple{
		{"missing-split.md", "docs/domain/missing-split.md", 10},
	})
}

func TestInvalidLinkEscapesRootDotDotAndASymlinkAreBothUnresolved(t *testing.T) {
	root, err := filepath.Abs(fixture(t, "invalid-link-escapes-root"))
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	layerRootAbs := filepath.Join(root, "docs")

	// The symlink resolves to a file that exists — outside the layer — so existence
	// alone would pass it. Containment is what refuses it.
	symlink := filepath.Join(root, "docs", "domain", "outside-link.md")
	info, err := os.Lstat(symlink)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("the fixture plants a symlink at %s", symlink)
	}
	if _, err := os.Stat(symlink); err != nil {
		t.Fatalf("whose target exists: %v", err)
	}

	cases := []struct {
		relPath string
		target  string
		line    int
	}{
		{"docs/boot-profile.md", "../../outside.md", 9},
		{"docs/domain/overview.md", "outside-link.md", 4},
	}
	for _, c := range cases {
		text, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(c.relPath)))
		if err != nil {
			t.Fatalf("read %s: %v", c.relPath, err)
		}
		scanned := ScanLinks(string(text))
		if len(scanned) != 1 || scanned[0].Target != c.target || scanned[0].Line != c.line {
			t.Fatalf("%s carries one link: got %+v", c.relPath, scanned)
		}
		fs := Findings(root, layerRootAbs, c.relPath, string(text))
		if len(fs) != 1 {
			t.Fatalf("%s reports one finding: got %+v", c.relPath, fs)
		}
		f := fs[0]
		if f.Rule != "link-unresolved" || string(f.Severity) != "error" || f.Path != c.relPath {
			t.Errorf("%s: got (%s, %s, %s)", c.relPath, f.Rule, f.Severity, f.Path)
		}
		if f.Line != c.line {
			t.Errorf("%s: the finding carries the link line: got %d", c.relPath, f.Line)
		}
		if f.Construct != c.target {
			t.Errorf("%s: and the destination as written: got %q", c.relPath, f.Construct)
		}
	}
}

func TestInvalidLinkReadmeEscapesRootADirectoryWhoseREADMELeavesTheLayer(t *testing.T) {
	root, err := filepath.Abs(fixture(t, "invalid-link-readme-escapes-root"))
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	layerRootAbs := filepath.Join(root, "docs")
	relPath := "docs/domain/overview.md"

	// The directory is inside the layer and its README exists, so the directory's own
	// containment check and a bare existence test both pass it. Only containment of
	// the README ITSELF refuses this target.
	readme := filepath.Join(root, "docs", "domain", "section", "README.md")
	info, err := os.Lstat(readme)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("the fixture plants the README as a symlink at %s", readme)
	}
	if _, err := os.Stat(readme); err != nil {
		t.Fatalf("whose target exists: %v", err)
	}

	assertTriples(t, triples(t, root, relPath), []triple{
		{"section/", "docs/domain/section", 4},
	})

	text, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relPath)))
	if err != nil {
		t.Fatalf("read %s: %v", relPath, err)
	}
	fs := Findings(root, layerRootAbs, relPath, string(text))
	if len(fs) != 1 {
		t.Fatalf("one finding: got %+v", fs)
	}
	f := fs[0]
	if f.Rule != "link-unresolved" || string(f.Severity) != "error" || f.Path != relPath {
		t.Errorf("got (%s, %s, %s)", f.Rule, f.Severity, f.Path)
	}
	if f.Line != 4 || f.Construct != "section/" {
		t.Errorf("got line %d, construct %q", f.Line, f.Construct)
	}
}

// The message carries the destination as written, byte for byte, in all three SDKs.
// %q would escape exactly these three, and this CLI would print a different line than
// the other two for the same layer.
func TestTheMessageInterpolatesTheDestinationVerbatim(t *testing.T) {
	cases := []struct{ target, want string }{
		{`missing\name.md`, `link target "missing\name.md" does not resolve`},
		{`a"b.md`, `link target "a"b.md" does not resolve`},
		{"a\tb.md", "link target \"a\tb.md\" does not resolve"},
	}
	for _, c := range cases {
		if got := Message(c.target); got != c.want {
			t.Errorf("Message(%#v) = %#v, want %#v", c.target, got, c.want)
		}
	}
}
