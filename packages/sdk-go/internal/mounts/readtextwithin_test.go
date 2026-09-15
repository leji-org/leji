package mounts

// The resolver-state read at its own level. In the package rather than beside the
// external mounts_test files, because readTextWithin is unexported and the per-case
// oracle is the point. Mirrors the Python test beside leji.mounts.read_text_within.

import (
	"os"
	"path/filepath"
	"testing"
)

// Containment is judged first and existence second, the order the link resolver
// already uses. Both checks must pass either way, so what the order has to leave
// unchanged is the set of refusals.
func TestReadTextWithinReadsAContainedFileAndRefusesAnEscapingOne(t *testing.T) {
	root := t.TempDir()
	away := t.TempDir()

	if err := os.WriteFile(filepath.Join(root, "inside.json"), []byte("inside\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(away, "real.json"), []byte("outside\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(away, "real.json"), filepath.Join(root, "escape.json")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := os.Mkdir(filepath.Join(root, "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(away, filepath.Join(root, "dir", "up")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	if text, ok := readTextWithin(root, filepath.Join(root, "inside.json")); !ok || text != "inside\n" {
		t.Fatalf("contained file: got (%q, %v), want (\"inside\\n\", true)", text, ok)
	}
	for _, name := range []string{"escape.json", "absent.json", "dir"} {
		if text, ok := readTextWithin(root, filepath.Join(root, name)); ok || text != "" {
			t.Fatalf("%s: got (%q, %v), want (\"\", false)", name, text, ok)
		}
	}
	if text, ok := readTextWithin(root, filepath.Join(root, "dir", "up", "real.json")); ok || text != "" {
		t.Fatalf("symlinked ancestor: got (%q, %v), want (\"\", false)", text, ok)
	}
}
