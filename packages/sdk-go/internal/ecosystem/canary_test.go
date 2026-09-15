package ecosystem

// The check-before-act window inside the eligibility gate: the entry is a regular
// file of this repository when it is judged and something else by the time it is
// opened. Both canaries land the swap through testHookAfterJudgment, inline and
// deterministically rather than raced, so the window is exercised on every run (the
// idiom the export and serve canaries use). Transcribed from the TypeScript
// contract tests (packages/sdk/test/ecosystem.test.ts).

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// swapAfterJudgment performs swap once, when the entry at target has just been
// judged and before the verified open resolves it.
func swapAfterJudgment(t *testing.T, target string, swap func()) *bool {
	t.Helper()
	fired := false
	testHookAfterJudgment = func(abs string) {
		if fired || abs != target {
			return
		}
		fired = true
		swap()
	}
	t.Cleanup(func() { testHookAfterJudgment = nil })
	return &fired
}

func TestCheckBeforeActEntrySwappedToALinkBetweenTheJudgmentAndTheOpenIsRefused(t *testing.T) {
	// Nothing has to be swapped back for a check that judges the entry once and then
	// trusts the open to pass, because the open resolves the link and verifies its
	// target perfectly well. What refuses it is the descriptor's own identity against
	// a fresh lstat of the NAME afterwards. Mutation that reddens: judge with lstat
	// and take the bytes back by path name (the pre-change shape) — the decoy's
	// packageManager and its declaration decide the answer.
	dir := t.TempDir()
	manifest := filepath.Join(dir, "package.json")
	decoy := filepath.Join(dir, "decoy.json")
	write(t, manifest, "{}")
	write(t, decoy, `{"packageManager":"pnpm@9.12.0","devDependencies":{"@leji-org/leji":"^1"}}`)

	fired := swapAfterJudgment(t, manifest, func() {
		if err := os.Remove(manifest); err != nil {
			t.Errorf("remove the judged entry: %v", err)
			return
		}
		if err := os.Symlink(decoy, manifest); err != nil {
			t.Errorf("retarget the name: %v", err)
		}
	})
	report := Detect(dir)

	if !*fired {
		t.Fatal("the seam fired: a regular file at the lstat, a link at the open")
	}
	if info, err := os.Lstat(manifest); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("the entry really is a link now: %v (%v)", info, err)
	}
	if report.Reason == nil || *report.Reason != "refused-evidence" {
		t.Fatalf("reason = %v, want refused-evidence", report.Reason)
	}
	if !reflect.DeepEqual(report.All[0].Evidence, []string{"package.json"}) {
		t.Errorf("evidence = %v, want [package.json]", report.All[0].Evidence)
	}
	if report.All[0].Manager != nil {
		t.Errorf("the swapped-in packageManager selected nothing: %v", *report.All[0].Manager)
	}
	if report.All[0].DirectDeclared {
		t.Error("and the swapped-in target was never read")
	}
}

func TestCheckBeforeActANameRenamedAwayAndLinkedBackToItsOwnInodeIsRefused(t *testing.T) {
	// The case every comparison against the FIRST lstat accepts: the entry the run
	// judged is renamed and its old name becomes a link to that same inode, so each
	// identity the open can see agrees — the resolve lands on that file, the
	// descriptor's stat is the judged inode, and the verified open's own recheck
	// matches. Only a FRESH lstat of the NAME catches it, because a symlink's inode is
	// never the inode of the file it points at, and a lockfile reached through a link
	// is not this repository's evidence. Mutation that reddens: compare the descriptor
	// with the initial stat instead of with a fresh one.
	dir := t.TempDir()
	write(t, filepath.Join(dir, "package.json"), "{}")
	lock := filepath.Join(dir, "package-lock.json")
	moved := filepath.Join(dir, "real.lock")
	write(t, lock, "")

	fired := swapAfterJudgment(t, lock, func() {
		if err := os.Rename(lock, moved); err != nil {
			t.Errorf("rename the judged entry away: %v", err)
			return
		}
		if err := os.Symlink(moved, lock); err != nil {
			t.Errorf("link the name back to its own inode: %v", err)
		}
	})
	report := Detect(dir)

	if !*fired {
		t.Fatal("the seam fired: the name was relinked to its own inode")
	}
	entry, err := os.Lstat(lock)
	if err != nil || entry.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("the entry really is a link now: %v (%v)", entry, err)
	}
	through, terr := os.Stat(lock)
	target, merr := os.Stat(moved)
	if terr != nil || merr != nil || !os.SameFile(through, target) {
		t.Fatal("and it points at the very inode that was judged")
	}
	if report.Reason == nil || *report.Reason != "refused-evidence" {
		t.Fatalf("reason = %v, want refused-evidence", report.Reason)
	}
	if !reflect.DeepEqual(report.All[0].Evidence, []string{"package-lock.json"}) {
		t.Errorf("evidence = %v, want [package-lock.json]", report.All[0].Evidence)
	}
	if report.All[0].LockEvidenced {
		t.Error("the relinked name evidenced no manager")
	}
}

func TestAManifestThisRunCannotOpenIsUnreadableNotRefused(t *testing.T) {
	// The other half of the verified-read composition: what the run could not COMPLETE
	// on an entry it never saw contradicted is not a refusal. A regular file of this
	// repository whose open is denied keeps the outcome it has always had — the
	// manifest is unreadable, so neither the lockfile nor the ecosystem default is
	// consulted — while a swap stays refused-evidence above. Mutation that reddens:
	// collapse every failure in verify to refused, and this reports refused-evidence
	// instead.
	dir := t.TempDir()
	manifest := filepath.Join(dir, "package.json")
	write(t, manifest, "{}")
	write(t, filepath.Join(dir, "package-lock.json"), "")
	if err := os.Chmod(manifest, 0o000); err != nil {
		t.Skipf("the mode cannot be set here: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(manifest, 0o644) })
	if f, err := os.Open(manifest); err == nil {
		_ = f.Close()
		t.Skip("the mode is not enforced here (root, or a filesystem that ignores it)")
	}
	report := Detect(dir)

	if report.Reason == nil || *report.Reason != "unreadable-manifest" {
		t.Fatalf("reason = %v, want unreadable-manifest", report.Reason)
	}
	if report.All[0].Manager != nil {
		t.Errorf("manager = %v, want none", *report.All[0].Manager)
	}
	if len(report.All[0].Evidence) != 0 {
		t.Errorf("evidence = %v, want none", report.All[0].Evidence)
	}
}

func write(t *testing.T, abs, body string) {
	t.Helper()
	if err := os.WriteFile(abs, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
