package cli

// The filesystem-mutation invariant: only write-intent commands (init, adopt,
// index, docs) may touch the filesystem. Read/analysis commands, and any command
// invoked with a --help/--version meta-flag, must leave the working tree
// unchanged. Regression guard for the bug where `leji adopt --help` ran adopt and
// scaffolded files instead of printing help.

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/schemas"
)

// snapshot maps each file path under dir (excluding .git) to its content hash.
func snapshot(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			if info.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		sum := sha256.Sum256(b)
		out[rel] = hex.EncodeToString(sum[:])
		return nil
	})
	if err != nil {
		t.Fatalf("snapshot %s: %v", dir, err)
	}
	return out
}

func sameFiles(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

// seedLayer copies the example layer into a fresh temp dir so read commands run
// against real content.
func seedLayer(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	src := filepath.Join(repoRoot(t), "examples", "monorepo")
	if err := os.CopyFS(dir, os.DirFS(src)); err != nil {
		t.Fatalf("copy example layer: %v", err)
	}
	return dir
}

// seedEmpty is a populated-but-no-layer dir where a regressed adopt/init would
// scaffold if a meta-flag were ignored.
func seedEmpty(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# sandbox\n"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	return dir
}

func TestReadCommandsDoNotWrite(t *testing.T) {
	cmds := [][]string{
		{"validate"}, {"conformance"}, {"freshness"}, {"detect"},
		{"index", "--check"}, {"changelog", "check"},
	}
	for _, argv := range cmds {
		t.Run(strings.Join(argv, " "), func(t *testing.T) {
			dir := seedLayer(t)
			before := snapshot(t, dir)
			captureRun(t, append(append([]string{}, argv...), "--root", dir))
			if !sameFiles(before, snapshot(t, dir)) {
				t.Fatalf("%v modified the filesystem", argv)
			}
		})
	}
}

func TestMetaFlagsNeverWrite(t *testing.T) {
	spec, err := schemas.LoadCliSpec()
	if err != nil {
		t.Fatalf("load cli spec: %v", err)
	}
	for _, c := range spec.Commands {
		for _, meta := range []string{"--help", "--version"} {
			t.Run(c.Name+" "+meta, func(t *testing.T) {
				dir := seedEmpty(t)
				before := snapshot(t, dir)
				argv := append(strings.Fields(c.Name), meta, "--root", dir)
				code, out, errOut := captureRun(t, argv)
				if code != 0 {
					t.Fatalf("%s %s exit %d: %s", c.Name, meta, code, errOut)
				}
				if meta == "--help" && !strings.Contains(out, "Usage: leji") {
					t.Fatalf("%s --help did not print usage: %q", c.Name, out)
				}
				if meta == "--version" && strings.TrimSpace(out) != schemas.SDKVersion {
					t.Fatalf("%s --version output %q", c.Name, out)
				}
				if !sameFiles(before, snapshot(t, dir)) {
					t.Fatalf("%s %s wrote files", c.Name, meta)
				}
			})
		}
	}
}

func TestDryRunNeverWrites(t *testing.T) {
	for _, cmd := range []string{"init", "adopt"} {
		t.Run(cmd, func(t *testing.T) {
			dir := seedEmpty(t)
			before := snapshot(t, dir)
			captureRun(t, []string{cmd, "--dry-run", "--yes", "--root", dir})
			if !sameFiles(before, snapshot(t, dir)) {
				t.Fatalf("%s --dry-run wrote files", cmd)
			}
		})
	}
}

// Positive control: a real write-intent run DOES change the tree, proving the
// snapshot detector can actually see writes.
func TestInitWritesProvingDetector(t *testing.T) {
	dir := seedEmpty(t)
	before := snapshot(t, dir)
	code, _, errOut := captureRun(t, []string{"init", "--yes", "--root", dir})
	if code != 0 {
		t.Fatalf("init --yes exit %d: %s", code, errOut)
	}
	if sameFiles(before, snapshot(t, dir)) {
		t.Fatalf("init --yes did not write (detector blind?)")
	}
}
