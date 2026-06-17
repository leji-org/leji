package fsx

import (
	"os"
	"path/filepath"
	"testing"
)

// A declared markdown path that is a symlink escaping the root must not be
// returned by WalkMd, whether the link is the top-level declared file or a
// child of a declared directory. Mirrors the TS/Python containment guard.
func TestWalkMdRejectsSymlinkEscape(t *testing.T) {
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.md")
	if err := os.WriteFile(secret, []byte("# secret"), 0o644); err != nil {
		t.Fatal(err)
	}

	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Top-level declared file is a symlink pointing outside the root.
	topLink := filepath.Join(root, "link.md")
	if err := os.Symlink(secret, topLink); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if got := WalkMd(root, "link.md"); len(got) != 0 {
		t.Fatalf("WalkMd top-level symlink escape should yield nothing, got %v", got)
	}
	// Symlinked child inside a declared directory must also be skipped.
	if err := os.Symlink(secret, filepath.Join(root, "docs", "child.md")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	for _, p := range WalkMd(root, "docs/") {
		if p == "docs/child.md" {
			t.Fatalf("WalkMd should skip symlinked child escaping root, got %v", p)
		}
	}
}

func TestToPosix(t *testing.T) {
	got := ToPosix(filepath.Join("a", "b", "c"))
	if got != "a/b/c" {
		t.Fatalf("ToPosix = %q want a/b/c", got)
	}
}

func TestExistsIsDirIsFile(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "f.md")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(dir, "nope")

	if !Exists(file) || !Exists(dir) {
		t.Fatalf("Exists should be true for existing file and dir")
	}
	if Exists(missing) {
		t.Fatalf("Exists should be false for a missing path")
	}
	if !IsDir(dir) || IsDir(file) || IsDir(missing) {
		t.Fatalf("IsDir wrong: dir=%v file=%v missing=%v", IsDir(dir), IsDir(file), IsDir(missing))
	}
	if !IsFile(file) || IsFile(dir) || IsFile(missing) {
		t.Fatalf("IsFile wrong: file=%v dir=%v missing=%v", IsFile(file), IsFile(dir), IsFile(missing))
	}
}

func TestReadText(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "f.md")
	if err := os.WriteFile(file, []byte("hello\nworld\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := ReadText(file)
	if err != nil {
		t.Fatalf("ReadText: %v", err)
	}
	if s != "hello\nworld\n" {
		t.Fatalf("ReadText = %q", s)
	}
	if _, err := ReadText(filepath.Join(dir, "missing")); err == nil {
		t.Fatalf("ReadText on missing file should error")
	}
}

func TestStripSlash(t *testing.T) {
	cases := []struct{ in, want string }{
		{"docs/", "docs"},
		{"docs", "docs"},
		{"", ""},
		{"a/b/", "a/b"},
	}
	for _, c := range cases {
		if got := StripSlash(c.in); got != c.want {
			t.Fatalf("StripSlash(%q) = %q want %q", c.in, got, c.want)
		}
	}
}

func TestWalkMdSkipsHiddenAndNodeModules(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "docs", "node_modules"), 0o755)
	os.MkdirAll(filepath.Join(dir, "docs", ".hidden"), 0o755)
	os.WriteFile(filepath.Join(dir, "docs", "keep.md"), []byte("# k"), 0o644)
	os.WriteFile(filepath.Join(dir, "docs", ".secret.md"), []byte("# s"), 0o644)
	os.WriteFile(filepath.Join(dir, "docs", "node_modules", "dep.md"), []byte("# d"), 0o644)
	os.WriteFile(filepath.Join(dir, "docs", ".hidden", "h.md"), []byte("# h"), 0o644)

	got := WalkMd(dir, "docs/")
	if len(got) != 1 || got[0] != "docs/keep.md" {
		t.Fatalf("WalkMd should only keep docs/keep.md, got %v", got)
	}
}
