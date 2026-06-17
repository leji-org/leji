package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// newRepo initializes a git repo in a temp dir with a single committed file,
// or skips the test when git is unavailable.
func newRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary not available")
	}
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-q")
	run("config", "user.email", "t@e.com")
	run("config", "user.name", "T")
	run("config", "commit.gpgsign", "false")
	if err := os.WriteFile(filepath.Join(dir, "tracked.md"), []byte("# tracked\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	// A deterministic commit date so LastModified is predictable.
	cmd := exec.Command("git", "commit", "-qm", "seed")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_DATE=2026-06-12T10:00:00",
		"GIT_COMMITTER_DATE=2026-06-12T10:00:00",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git commit: %v: %s", err, out)
	}
	return dir
}

func TestToplevelInRepo(t *testing.T) {
	dir := newRepo(t)
	top, ok := Toplevel(dir)
	if !ok {
		t.Fatalf("expected to find toplevel in a git repo")
	}
	// EvalSymlinks because macOS temp dirs are symlinked (/var -> /private/var).
	wantResolved, _ := filepath.EvalSymlinks(dir)
	gotResolved, _ := filepath.EvalSymlinks(top)
	if gotResolved != wantResolved {
		t.Fatalf("toplevel = %q want %q", gotResolved, wantResolved)
	}
}

func TestToplevelOutsideRepo(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary not available")
	}
	// A bare temp dir that is not a git repo.
	dir := t.TempDir()
	if _, ok := Toplevel(dir); ok {
		t.Fatalf("expected no toplevel outside a git repo")
	}
}

func TestLastModifiedTrackedClean(t *testing.T) {
	dir := newRepo(t)
	date, ok := LastModified(dir, "tracked.md")
	if !ok {
		t.Fatalf("expected a commit date for a clean tracked file")
	}
	if date != "2026-06-12" {
		t.Fatalf("LastModified = %q want 2026-06-12", date)
	}
}

func TestLastModifiedDirtyFile(t *testing.T) {
	dir := newRepo(t)
	// Modify the tracked file in the working tree: status is no longer clean.
	if err := os.WriteFile(filepath.Join(dir, "tracked.md"), []byte("# changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := LastModified(dir, "tracked.md"); ok {
		t.Fatalf("dirty file should not return a commit date")
	}
}

func TestLastModifiedUntracked(t *testing.T) {
	dir := newRepo(t)
	if err := os.WriteFile(filepath.Join(dir, "untracked.md"), []byte("# new\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := LastModified(dir, "untracked.md"); ok {
		t.Fatalf("untracked file should not return a commit date")
	}
}

func TestLastModifiedOutsideRepo(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary not available")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "x.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := LastModified(dir, "x.md"); ok {
		t.Fatalf("outside a repo LastModified must be false")
	}
}

func TestShowHeadTrackedFile(t *testing.T) {
	dir := newRepo(t)
	content, ok := ShowHead(dir, "tracked.md")
	if !ok {
		t.Fatalf("expected HEAD content for a committed file")
	}
	if content != "# tracked\n" {
		t.Fatalf("ShowHead content = %q", content)
	}
}

func TestShowHeadNewFile(t *testing.T) {
	dir := newRepo(t)
	if err := os.WriteFile(filepath.Join(dir, "fresh.md"), []byte("# fresh\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := ShowHead(dir, "fresh.md"); ok {
		t.Fatalf("a file absent from HEAD should return false")
	}
}

func TestShowHeadOutsideRepo(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary not available")
	}
	if _, ok := ShowHead(t.TempDir(), "x.md"); ok {
		t.Fatalf("outside a repo ShowHead must be false")
	}
}
