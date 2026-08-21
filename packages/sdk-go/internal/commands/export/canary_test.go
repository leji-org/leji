package export

// The check/use gap on the READ side, and the check-before-act answer to it. These need a mutation
// landing at one exact moment inside a run, which no fixture can plant, so they are
// constructed here — over the example layer, with the planted bytes in a private role.

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

// token is the planted byte string: it must never reach an export.
const token = "LEJI-TRUST-CANARY"

// captureStderr runs fn with os.Stderr redirected to a pipe and returns what it
// wrote. The boundary-skip warning is a stderr contract, so it is read from the file
// the process actually writes to.
func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	orig := os.Stderr
	os.Stderr = w
	done := make(chan string, 1)
	go func() {
		body, _ := io.ReadAll(r)
		done <- string(body)
	}()
	fn()
	os.Stderr = orig
	_ = w.Close()
	out := <-done
	_ = r.Close()
	return out
}

// countToken counts recursive occurrences of the token under dir (an absent dir
// counts as zero).
func countToken(t *testing.T, dir string) (int, []string) {
	t.Helper()
	if _, err := os.Stat(dir); err != nil {
		return 0, nil
	}
	count := 0
	var where []string
	err := filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !d.Type().IsRegular() {
			return err
		}
		body, rerr := os.ReadFile(p)
		if rerr != nil {
			return rerr
		}
		if hits := strings.Count(string(body), token); hits > 0 {
			count += hits
			rel, _ := filepath.Rel(dir, p)
			where = append(where, rel)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return count, where
}

func TestCheckBeforeActAncestorSwappedAfterEnumerationIsNeverFollowed(t *testing.T) {
	// The content walk enumerates a real directory; before the export uses what it
	// enumerated, that directory becomes a symlink into a private role. Every later
	// read or copy BY PATH then goes through the link, with the walk's checks all
	// behind it — and a revalidation that lstats the final component alone follows the
	// swapped ancestor to a perfectly ordinary file. So a carried source is resolved,
	// its RESOLVED path judged, and its bytes taken from the descriptor fstat proved a
	// regular file: the check and the use hold one inode. Mutation that reddens:
	// revalidate with Lstat and read/copy by path again — the planted bytes below are
	// linted and land in the export.
	dir := exampleCopy(t)
	writeUnder(t, dir, "docs/domain/asset.txt", "an ordinary carried asset\n")
	decoy := filepath.Join(dir, ".leji", "work", "swapped")
	if err := os.MkdirAll(decoy, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(decoy, "glossary.md"), []byte("# planted "+token+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(decoy, "asset.txt"), []byte(token+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	m := manifest.LoadManifest(dir).Manifest
	if m == nil {
		t.Fatal("the example manifest must load")
	}

	// The swap, at the one moment that matters: after the walk has enumerated the
	// carried set and before any of it is used. Deterministic, not a race — the hook
	// performs it inline, so the window is exercised on every run.
	domainDir := filepath.Join(dir, "docs", "domain")
	swapped := false
	testHookAfterEnumerate = func() {
		if swapped {
			return
		}
		swapped = true
		if err := os.Rename(domainDir, filepath.Join(dir, "docs", "domain-real")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join("..", ".leji", "work", "swapped"), domainDir); err != nil {
			t.Fatal(err)
		}
	}
	defer func() { testHookAfterEnumerate = nil }()

	var built BuildResult
	var buildErr error
	stderr := captureStderr(t, func() {
		built, buildErr = BuildViewer(dir, m, "", Options{})
	})
	if buildErr != nil {
		t.Fatalf("BuildViewer: %v", buildErr)
	}
	if !swapped {
		t.Fatal("the ancestor must have been swapped between the walk and the use")
	}
	if !built.Wrote {
		t.Fatal("the export still runs to completion")
	}
	distDir := filepath.Join(dir, ".leji", "dist")
	if _, err := os.Stat(filepath.Join(distDir, "index.html")); err != nil {
		t.Fatalf("the export still ran to completion: %v", err)
	}
	if count, where := countToken(t, distDir); count != 0 {
		t.Fatalf("no planted byte may reach the export: %v", where)
	}
	for _, rel := range []string{"glossary.md", "asset.txt"} {
		if _, err := os.Stat(filepath.Join(distDir, "content", "domain", rel)); err == nil {
			t.Fatalf("the redirected source must be dropped rather than followed: %s", rel)
		}
	}
	// A source that now resolves into a private role is a level-2 refusal: dropping it
	// silently would leave an operator with a quietly shorter export and no reason.
	var warnings []string
	for _, line := range strings.Split(stderr, "\n") {
		if strings.HasPrefix(line, "skipped domain/") {
			warnings = append(warnings, line)
		}
	}
	if len(warnings) == 0 {
		t.Fatalf("the redirected sources must be named on stderr: %q", stderr)
	}
	for _, line := range warnings {
		if !strings.Contains(line, "resolves into .leji/work (private); not served or exported") {
			t.Fatalf("boundary-skip wording: %q", line)
		}
	}
}
