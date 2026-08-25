package conformancetest

// The one tree-snapshot contract the badge and canary suites share. Both ask the same
// question of a tree (is it byte-identical to what it was?) and both used to answer it
// with their own private walker, so a fix to one reached the other only by hand. The
// contract lives here, is pinned by `fixtures/snapshot-contract/` (asserted in
// snapshot_contract_test.go), and is the same contract the Node and Python suites hold:
// packages/sdk/test/helpers/snapshot.ts is the reference, and the goldens are frozen
// bytes all three walk to.

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// snapshotTree is every entry under dir as one line, so a comparison covers
// appearance, disappearance, content and entry kind:
//
//   - regular file: `path<TAB>sha256:<hex>`
//   - directory: `path/<TAB>dir`, an entry of its own, so a created empty directory shows
//   - symlink or any other non-regular entry: `path<TAB>non-regular`, never followed
//
// Paths are POSIX and relative to dir itself, and the lines are sorted bytewise,
// which is what sort.Strings on Go strings already is, and what the goldens carry.
//
// Exactly one entry is excluded: `<repoRoot>/.git`, when it lies inside dir. That one
// is the harness's own scaffolding, and git's background maintenance rewrites it under
// a running test: on a hosted runner that reached a comparison like this one two ways,
// a transient the walk opens and git removes mid-walk
// (`open .git/objects/maintenance.lock: no such file or directory`) and a pack that is
// simply not the pack the first snapshot saw. Both are the runner's git, never the
// subject, and both were seen on one rc run. Every other `.git` (a nested package, a
// mount, a work directory) is content and is walked like anything else.
//
// repoRoot means the repository, not the call. An empty repoRoot defaults to dir, the
// whole-repository call; a subtree call passes the repository root explicitly, so
// snapshotTree(t, pkg, repo) records `pkg/.git` as the content it is.
func snapshotTree(t *testing.T, dir, repoRoot string) []string {
	t.Helper()
	root, err := filepath.Abs(dir)
	if err != nil {
		t.Fatal(err)
	}
	if repoRoot == "" {
		repoRoot = dir
	}
	rootOfRepo, err := filepath.Abs(repoRoot)
	if err != nil {
		t.Fatal(err)
	}
	excluded := filepath.Join(rootOfRepo, ".git")

	var out []string
	var walk func(rel string)
	walk = func(rel string) {
		abs := root
		if rel != "" {
			abs = filepath.Join(root, filepath.FromSlash(rel))
		}
		entries, err := os.ReadDir(abs)
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range entries {
			childAbs := filepath.Join(abs, e.Name())
			if childAbs == excluded {
				continue
			}
			childRel := e.Name()
			if rel != "" {
				childRel = rel + "/" + e.Name()
			}
			switch {
			case e.IsDir():
				out = append(out, childRel+"/\tdir")
				walk(childRel)
			case e.Type().IsRegular():
				body, err := os.ReadFile(childAbs)
				if err != nil {
					t.Fatal(err)
				}
				sum := sha256.Sum256(body)
				out = append(out, childRel+"\tsha256:"+hex.EncodeToString(sum[:]))
			default:
				out = append(out, childRel+"\tnon-regular")
			}
		}
	}
	walk("")
	sort.Strings(out)
	return out
}

// snapshot is the whole-repository call under its historical name, kept for the render
// suite (render_test.go), whose Node counterparts (export.test.ts, renderlint.test.ts)
// keep private walkers of their own: the shared-helper rule covers the badge and canary
// suites, and widening it here would be a change nobody planned. It is the shared helper,
// not a second implementation: `snapshotTree(t, dir, dir)` and nothing else.
func snapshot(t *testing.T, dir string) []string {
	t.Helper()
	return snapshotTree(t, dir, dir)
}
