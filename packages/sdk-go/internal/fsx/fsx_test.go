package fsx

import (
	"os"
	"path/filepath"
	"testing"
)

func TestUnderPathEdges(t *testing.T) {
	cases := []struct {
		rel, declared string
		want          bool
	}{
		{"docs/domain/x.md", "docs/", true},
		{"docs", "docs/", true},
		{"docsx/y.md", "docs/", false},
		{"anything", "", true},
		{"anything", ".", true},
	}
	for _, c := range cases {
		if got := UnderPath(c.rel, c.declared); got != c.want {
			t.Fatalf("UnderPath(%q,%q)=%v want %v", c.rel, c.declared, got, c.want)
		}
	}
}

func TestWalkMdFileAndDir(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "docs", "sub"), 0o755)
	os.WriteFile(filepath.Join(dir, "docs", "a.md"), []byte("# a"), 0o644)
	os.WriteFile(filepath.Join(dir, "docs", "sub", "b.md"), []byte("# b"), 0o644)
	os.WriteFile(filepath.Join(dir, "docs", "c.txt"), []byte("c"), 0o644)
	os.WriteFile(filepath.Join(dir, "leji.json"), []byte("{}"), 0o644)

	got := WalkMd(dir, "docs/")
	want := []string{"docs/a.md", "docs/sub/b.md"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("walkMd dir got %v want %v", got, want)
	}
	if single := WalkMd(dir, "docs/a.md"); len(single) != 1 || single[0] != "docs/a.md" {
		t.Fatalf("walkMd file got %v", single)
	}
	if nonMd := WalkMd(dir, "leji.json"); len(nonMd) != 0 {
		t.Fatalf("walkMd on non-md file should be empty, got %v", nonMd)
	}
	if missing := WalkMd(dir, "docs/nonexistent/"); len(missing) != 0 {
		t.Fatalf("walkMd missing dir should be empty, got %v", missing)
	}
}
