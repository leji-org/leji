package fsx

import (
	"io"
	"os"
	"path/filepath"
	"testing"
)

// The guarded read: what it hands back, and the window it closes. `allow` is called
// after the resolve and before the open, which is exactly the window the post-open
// recheck exists for — so the swap below is performed from inside it, deterministically,
// rather than raced.

func TestOpenVerifiedSourceReadsAnAllowedSource(t *testing.T) {
	dir := t.TempDir()
	abs := filepath.Join(dir, "doc.md")
	if err := os.WriteFile(abs, []byte("authorized\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	src, err := OpenVerifiedSource(abs, func(string) bool { return true })
	if err != nil {
		t.Fatalf("OpenVerifiedSource: %v", err)
	}
	if src.File == nil {
		t.Fatal("an allowed regular file must open")
	}
	defer func() { _ = src.File.Close() }()
	body, err := io.ReadAll(src.File)
	if err != nil || string(body) != "authorized\n" {
		t.Fatalf("bytes = %q (%v)", body, err)
	}
}

func TestOpenVerifiedSourceRefusesWhatAllowRejectsAndNamesWhereItLands(t *testing.T) {
	// The resolved spelling of the scratch dir, since the assertions below compare
	// against what the resolver hands back (on macOS /var is itself a symlink).
	dir, ok := ResolvedPath(t.TempDir())
	if !ok {
		t.Fatal("the scratch directory must resolve")
	}
	target := filepath.Join(dir, "private.md")
	if err := os.WriteFile(target, []byte("planted\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "doc.md")
	if err := os.Symlink("private.md", link); err != nil {
		t.Fatal(err)
	}
	src, err := OpenVerifiedSource(link, func(resolved string) bool { return resolved != target })
	if err != nil {
		t.Fatalf("OpenVerifiedSource: %v", err)
	}
	if src.File != nil {
		_ = src.File.Close()
		t.Fatal("a refused source must not open")
	}
	// The refusal names where the source actually resolves, so a caller's boundary
	// message points at the role the bytes would have come from.
	if !src.Resolved || src.Real != target {
		t.Fatalf("real = %q (resolved=%v), want %q", src.Real, src.Resolved, target)
	}
}

func TestOpenVerifiedSourceRefusesANonRegularSource(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "adir")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	src, err := OpenVerifiedSource(sub, func(string) bool { return true })
	if err != nil {
		t.Fatalf("OpenVerifiedSource: %v", err)
	}
	if src.File != nil {
		_ = src.File.Close()
		t.Fatal("only a regular file may be handed back")
	}
}

func TestOpenVerifiedSourceRefusesASwapBetweenTheCheckAndTheOpen(t *testing.T) {
	// The residual the descriptor pinning alone leaves: the swap lands AFTER the
	// realpath that authorized the source and BEFORE the open on it, so the open
	// follows the new link and the descriptor holds planted bytes while every check has
	// already passed on the authorized path. fstat cannot see it — the decoy is a
	// perfectly ordinary regular file. The recheck after the open resolves the source
	// once more and requires the same location AND the same file identity, so the bytes
	// about to be read are proved to be the ones `allow` judged. Mutation that reddens:
	// drop the recheck and trust fstat alone — the planted bytes are handed back.
	dir := t.TempDir()
	tree := filepath.Join(dir, "tree")
	decoy := filepath.Join(dir, "decoy")
	for _, d := range []string{tree, decoy} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(tree, "doc.md"), []byte("authorized\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(decoy, "doc.md"), []byte("planted\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	swapped := false
	src, err := OpenVerifiedSource(filepath.Join(tree, "doc.md"), func(resolved string) bool {
		if !swapped {
			swapped = true
			if err := os.Rename(tree, filepath.Join(dir, "tree-real")); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink("decoy", tree); err != nil {
				t.Fatal(err)
			}
		}
		return true // authorized on the path as it resolved a moment ago
	})
	if err != nil {
		t.Fatalf("OpenVerifiedSource: %v", err)
	}
	if !swapped {
		t.Fatal("the ancestor must have been swapped between the check and the open")
	}
	if src.File != nil {
		body, _ := io.ReadAll(src.File)
		_ = src.File.Close()
		t.Fatalf("a source whose path and descriptor diverged must never be read: got %q", body)
	}
}

func TestOpenVerifiedSourceRefusingADanglingSwapNamesTheAllowedPath(t *testing.T) {
	// The other branch of the same window: the swap points the source at a target that
	// does not exist. The source is still refused — path and descriptor diverged — but
	// there is no location to name, so the refusal carries the ORIGINAL allowed path.
	// The reference implementation gets there by stat'ing the recheck path BEFORE
	// comparing it, so the stat failure lands in its catch and returns `real`; Python
	// does the same. The caller reads that path to decide its refusal semantics, so
	// naming the dangling target instead would turn a silent drop into a private-role
	// boundary warning naming a role the bytes never came from. Mutation that reddens:
	// compare the paths before stat'ing, and the dangling target comes back.
	dir, ok := ResolvedPath(t.TempDir())
	if !ok {
		t.Fatal("the scratch directory must resolve")
	}
	target := filepath.Join(dir, "authorized.md")
	if err := os.WriteFile(target, []byte("authorized\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "doc.md")
	if err := os.Symlink("authorized.md", link); err != nil {
		t.Fatal(err)
	}

	swapped := false
	src, err := OpenVerifiedSource(link, func(string) bool {
		if !swapped {
			swapped = true
			// Re-pointed after the resolve authorized it and before the open: the open
			// is on the resolved path, so it still succeeds and fstat still sees the
			// authorized regular file — only the recheck resolves elsewhere, to a
			// target that was never created.
			if err := os.Remove(link); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink("ghost.md", link); err != nil {
				t.Fatal(err)
			}
		}
		return true
	})
	if err != nil {
		t.Fatalf("OpenVerifiedSource: %v", err)
	}
	if !swapped {
		t.Fatal("the source must have been re-pointed between the check and the open")
	}
	if src.File != nil {
		_ = src.File.Close()
		t.Fatal("a source whose path and descriptor diverged must never be read")
	}
	if !src.Resolved || src.Real != target {
		t.Fatalf("real = %q (resolved=%v), want the allowed path %q", src.Real, src.Resolved, target)
	}
}
