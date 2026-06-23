package initcmd

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// init refuses to write through a symlinked context root that escapes the dir;
// nothing leaks into the outside directory.
func TestInitRefusesSymlinkedRootEscape(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	// The context root `docs/` is a symlink to a real directory outside `dir`.
	if err := os.Symlink(outside, filepath.Join(dir, "docs")); err != nil {
		t.Fatal(err)
	}

	_, err := InitLayer(Options{Dir: dir, Yes: true})
	if err == nil {
		t.Fatal("init should refuse a context root symlinked outside the target")
	}
	if !strings.Contains(err.Error(), "escapes the target") {
		t.Fatalf("error should mention escapes the target, got: %v", err)
	}

	// Nothing leaked into the outside directory through the escaping symlink.
	entries, rerr := os.ReadDir(outside)
	if rerr != nil {
		t.Fatal(rerr)
	}
	if len(entries) != 0 {
		t.Fatalf("no files should be written outside the target, got %d", len(entries))
	}
}

// adopt --wire-adapters refuses to overwrite a symlinked-outside vendor file:
// the outside content is unchanged and the symlink is not replaced.
func TestAdoptWireAdaptersRefusesSymlinkedOutsideVendor(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	exec.Command("git", "init", "-q", dir).Run()
	secretPath := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secretPath, []byte("OUTSIDE SECRET CONTENT\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// CLAUDE.md is a symlink pointing at a file outside the repository.
	if err := os.Symlink(secretPath, filepath.Join(dir, "CLAUDE.md")); err != nil {
		t.Fatal(err)
	}
	gitCommitAll(t, dir)

	if _, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true, WireAdapters: true}); err != nil {
		t.Fatalf("adopt should succeed treating the escaping symlink as absent: %v", err)
	}

	// The outside file is untouched and CLAUDE.md still points out (not overwritten).
	got, _ := os.ReadFile(secretPath)
	if string(got) != "OUTSIDE SECRET CONTENT\n" {
		t.Fatalf("outside file was modified: %q", string(got))
	}
	info, lerr := os.Lstat(filepath.Join(dir, "CLAUDE.md"))
	if lerr != nil {
		t.Fatal(lerr)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("the symlink was replaced; it should be left untouched")
	}
}

// adopt does not migrate a symlinked-outside vendor file: it is not in Migrated
// and no imported doc contains the outside secret.
func TestAdoptDoesNotMigrateSymlinkedOutsideVendor(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	exec.Command("git", "init", "-q", dir).Run()
	secretPath := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secretPath, []byte("TOP SECRET DO NOT MIGRATE\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secretPath, filepath.Join(dir, "CLAUDE.md")); err != nil {
		t.Fatal(err)
	}
	gitCommitAll(t, dir)

	res, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true})
	if err != nil {
		t.Fatalf("adopt: %v", err)
	}

	if contains(res.Migrated, "CLAUDE.md") {
		t.Fatal("an escaping symlink should be treated as absent, not migrated")
	}
	importedDir := filepath.Join(dir, "docs", "governance")
	if entries, derr := os.ReadDir(importedDir); derr == nil {
		for _, e := range entries {
			if !strings.HasPrefix(e.Name(), "imported-") {
				continue
			}
			body, _ := os.ReadFile(filepath.Join(importedDir, e.Name()))
			if strings.Contains(string(body), "TOP SECRET") {
				t.Fatalf("the outside secret was read into %s", e.Name())
			}
		}
	}
}

// migrationDoc fences migrated content so raw HTML is shown verbatim: the
// <script> payload lives inside a ``` fence, not as a bare rendered line.
func TestMigrationDocFencesRawHTML(t *testing.T) {
	dir := t.TempDir()
	exec.Command("git", "init", "-q", dir).Run()
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"),
		[]byte("Instructions.\n<script>alert(1)</script>\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCommitAll(t, dir)

	if _, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true}); err != nil {
		t.Fatalf("adopt: %v", err)
	}

	imported, err := os.ReadFile(filepath.Join(dir, "docs", "governance", "imported-claude.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(imported), "```") {
		t.Fatal("migrated content should be wrapped in a fenced code block")
	}
	// The script text is present, inside the fence (not as a bare rendered line).
	fenceRe := regexp.MustCompile("(?s)(`{3,})\n(.*?)\n`{3,}")
	m := fenceRe.FindStringSubmatch(string(imported))
	if m == nil {
		t.Fatal("a fenced code block should delimit the imported content")
	}
	if !strings.Contains(m[2], "<script>alert(1)</script>") {
		t.Fatalf("the raw script should live inside the fence, got: %q", m[2])
	}
}
