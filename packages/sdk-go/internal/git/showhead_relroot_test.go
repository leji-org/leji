package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// ShowHead must work when root is relative, which is the default ("."). Toplevel
// returns an absolute path while EvalSymlinks on a relative input returns a relative
// one, so a missing filepath.Abs made filepath.Rel fail and ShowHead report "not
// found" for a file that was plainly committed. That was invisible for as long as an
// unreadable HEAD counted as verified: the append-only check simply never ran.
func TestShowHeadWithRelativeRoot(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init", "-q"},
		{"config", "user.email", "test@example.com"},
		{"config", "user.name", "Test"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	if err := os.MkdirAll(filepath.Join(dir, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	rel := filepath.Join("docs", "note.md")
	if err := os.WriteFile(filepath.Join(dir, rel), []byte("committed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", "-A"}, {"commit", "-qm", "seed"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}

	prev, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(prev) })

	got, ok := ShowHead(".", "docs/note.md")
	if !ok {
		t.Fatal(`ShowHead(".", "docs/note.md") reported not found for a committed file`)
	}
	if got != "committed\n" {
		t.Fatalf("ShowHead content = %q, want %q", got, "committed\n")
	}
}
