package cli

import (
	"os"
	"path/filepath"
	"testing"
)

// chdirTo enters dir for the duration of the test, the way the CLI is actually
// invoked: from inside the layer, with no path handed in, so root stays the default
// ".". Tests in this package never run in parallel, so the process-wide cwd is safe.
func chdirTo(t *testing.T, dir string) {
	t.Helper()
	prev, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	t.Cleanup(func() { _ = os.Chdir(prev) })
}

// Regression: run from the layer's own directory, every path the viewer judges and
// writes arrives relative. filepath.EvalSymlinks hands a relative path back relative,
// so fsx.ResolvedPathUnder canonicalized `docs/overview.md` from the VOLUME root and
// returned `/docs/overview.md` — the check-before-act guard then approved that path (outside
// `.leji/`) and the seed wrote through it, failing with `mkdir /docs: read-only file
// system`. Node has no such mode: `realpathSync.native` absolutizes whatever it is
// handed. Every existing test passed absolute `t.TempDir()` paths, so none saw it;
// the shared parity harness, which invokes the CLI from the sandbox cwd, did.
func TestViewerRelativeRootFromLayerCwd(t *testing.T) {
	dir := copyExample(t) // rootPath "docs/": the artifacts land outside the content root
	chdirTo(t, dir)

	code, _, errs := captureRun(t, []string{"viewer"})
	if code != 0 {
		t.Fatalf("viewer from the layer cwd exit %d, stderr %q", code, errs)
	}
	code, _, errs = captureRun(t, []string{"viewer", "build"})
	if code != 0 {
		t.Fatalf("viewer build from the layer cwd exit %d, stderr %q", code, errs)
	}

	// The generated trees belong to THIS layer, not to a path rebuilt from the volume
	// root: assert them under dir, and assert the seeded content page landed under the
	// context root rather than at `/docs/overview.md`.
	for _, rel := range []string{
		filepath.Join(".leji", "viewer", "index.html"),
		filepath.Join(".leji", "viewer", "_sidebar.md"),
		filepath.Join(".leji", "dist", "index.html"),
		filepath.Join("docs", "overview.md"),
	} {
		if _, err := os.Stat(filepath.Join(dir, rel)); err != nil {
			t.Fatalf("expected %s under the layer: %v", rel, err)
		}
	}
}

// The same relative invocation on the refusal path: `--out ../escape` must produce
// Node's containment message and exit, byte for byte, because the parity harness
// compares the two. Before the fix the command died on the resolver instead, with an
// unrelated message and no refusal at all. The message is now the write rule's own:
// a target resolving outside the repository is refused by the chokepoint before the
// `--out` collision checks, in the reference and here alike.
func TestViewerBuildRelativeOutRejectFromLayerCwd(t *testing.T) {
	dir := copyExample(t)
	chdirTo(t, dir)

	code, out, errs := captureRun(t, []string{"viewer", "build", "--out", "../escape"})
	if code != 2 {
		t.Fatalf("--out ../escape exit %d, stderr %q", code, errs)
	}
	if out != "" {
		t.Fatalf("--out ../escape wrote to stdout: %q", out)
	}
	want := `leji: refusing to build the viewer into "../escape": it resolves outside the ` +
		`repository; every write stays inside the repository root, so copy the exported folder ` +
		`to your host instead` + "\n"
	if errs != want {
		t.Fatalf("--out ../escape stderr\n got %q\nwant %q", errs, want)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dir), "escape")); err == nil {
		t.Fatal("the refused --out target was created")
	}
}
