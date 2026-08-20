package fsx

import (
	"net"
	"os"
	"path/filepath"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/layout"
)

// The write boundary at its own level: the strict within-root primitive, the rule
// GuardedWrite applies through every convenience, and the verified read that decides
// what is standing at a target before anything acts on it. The canary suite pins the
// same rule through the commands; these pin the mechanism, so a port has a per-case
// oracle rather than an end-to-end one. Mirrors the reference's test/fsx.test.ts.

// repo is a temp repository root, resolved (macOS hands out /var -> /private/var).
func repo(t *testing.T) string {
	t.Helper()
	real, ok := ResolvedPath(t.TempDir())
	if !ok {
		t.Fatal("the scratch directory must resolve")
	}
	return real
}

// outside is a destination outside any repository, for the escape cases.
func outside(t *testing.T) string {
	t.Helper()
	return repo(t)
}

func mustWrite(t *testing.T, abs, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func mustSymlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
}

func mustBeEmpty(t *testing.T, dir, why string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("%s: %v", why, entries)
	}
}

// writeGuarded is WriteFileGuarded with the error channel asserted away, since these
// cases are about verdicts.
func writeGuarded(t *testing.T, root, target, role, body string, opts WriteOptions) layout.TargetVerdict {
	t.Helper()
	verdict, err := WriteFileGuarded(root, target, role, []byte(body), opts)
	if err != nil {
		t.Fatalf("WriteFileGuarded(%s): %v", target, err)
	}
	return verdict
}

// --- the strict within-root primitive ----------------------------------------

func TestResolvedWithinRootExistingAbsentDanglingEscapingCaseVariant(t *testing.T) {
	root := repo(t)
	mustWrite(t, filepath.Join(root, "file.md"), "x\n")
	if !ResolvedWithinRoot(root, filepath.Join(root, "file.md")) {
		t.Fatal("an existing file inside root is contained")
	}
	if !ResolvedWithinRoot(root, filepath.Join(root, "not-yet", "file.md")) {
		t.Fatal("a not-yet-created target is contained")
	}

	away := outside(t)
	mustSymlink(t, filepath.Join(away, "gone.md"), filepath.Join(root, "dangling.md"))
	if ResolvedWithinRoot(root, filepath.Join(root, "dangling.md")) {
		t.Fatal("a dangling link out of root is not contained")
	}

	mustWrite(t, filepath.Join(away, "real.md"), "x\n")
	mustSymlink(t, filepath.Join(away, "real.md"), filepath.Join(root, "escape.md"))
	if ResolvedWithinRoot(root, filepath.Join(root, "escape.md")) {
		t.Fatal("a link resolving out of root is not contained")
	}

	if err := os.Mkdir(filepath.Join(root, "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	mustSymlink(t, away, filepath.Join(root, "dir", "up"))
	if ResolvedWithinRoot(root, filepath.Join(root, "dir", "up", "new.md")) {
		t.Fatal("a symlinked ancestor is not contained")
	}

	// A `.LEJI/` spelling on a case-insensitive filesystem resolves to the directory
	// the filesystem actually holds, which is what the `.leji/` rule then judges.
	if err := os.MkdirAll(layout.Abs(root, layout.DistRel), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, ".LEJI")); err == nil {
		verdict := writeGuarded(t, root, filepath.Join(root, ".LEJI", "dist", "x.html"), "", "x", WriteOptions{})
		if verdict.OK || verdict.Role != "dist" {
			t.Fatalf("a .LEJI/ spelling is judged as the .leji/ role it opens, got %+v", verdict)
		}
	}
}

func TestResolvedWithinRootFailsClosedOnAnUnresolvablePath(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: a 0o000 directory is still traversable")
	}
	root := repo(t)
	closed := filepath.Join(root, "closed")
	mustWrite(t, filepath.Join(closed, "target.md"), "x\n")
	if err := os.Chmod(closed, 0o000); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chmod(closed, 0o700) }()
	if _, err := os.Stat(filepath.Join(closed, "target.md")); err == nil {
		t.Skip("this platform allows traversal of a 0o000 directory")
	}
	if ResolvedWithinRoot(root, filepath.Join(closed, "target.md")) {
		t.Fatal("unresolvable fails closed")
	}
	verdict := writeGuarded(t, root, filepath.Join(closed, "target.md"), "", "x", WriteOptions{})
	if verdict.OK || !verdict.Unresolvable {
		t.Fatalf("the chokepoint refuses it as unresolvable, got %+v", verdict)
	}
}

// --- the rule, through the conveniences ---------------------------------------

func TestTheWriteRuleRefusesOutsideTheRepositoryWhateverTheRole(t *testing.T) {
	root := repo(t)
	away := outside(t)
	if err := os.MkdirAll(layout.Abs(root, layout.LejiDir), 0o755); err != nil {
		t.Fatal(err)
	}
	mustSymlink(t, away, layout.Abs(root, layout.DistRel))

	verdict := writeGuarded(t, root, filepath.Join(layout.Abs(root, layout.DistRel), "index.html"),
		layout.DistRel, "x", WriteOptions{})
	if verdict.OK || !verdict.OutsideRoot {
		t.Fatalf("an own-role target relocated out of the repository is refused, got %+v", verdict)
	}
	mustBeEmpty(t, away, "nothing may be written outside")

	cleared, err := RmGuarded(root, layout.Abs(root, layout.DistRel), layout.DistRel)
	if err != nil {
		t.Fatal(err)
	}
	if !cleared.OutsideRoot {
		t.Fatalf("the clear is refused the same way, got %+v", cleared)
	}
	if _, err := os.Stat(away); err != nil {
		t.Fatalf("the out-of-tree directory still stands: %v", err)
	}
}

func TestTheWriteRuleRefusesAnotherRoleAndPassesItsOwn(t *testing.T) {
	root := repo(t)
	if err := os.MkdirAll(layout.Abs(root, layout.WorkRel), 0o755); err != nil {
		t.Fatal(err)
	}

	crossed := writeGuarded(t, root, filepath.Join(layout.Abs(root, layout.WorkRel), "stolen.md"),
		layout.DistRel, "x", WriteOptions{})
	if crossed.OK || crossed.Role != "work" {
		t.Fatalf("the export role may not write into the work role, got %+v", crossed)
	}
	if _, err := os.Lstat(filepath.Join(layout.Abs(root, layout.WorkRel), "stolen.md")); err == nil {
		t.Fatal("nothing may be written")
	}

	own := writeGuarded(t, root, filepath.Join(layout.Abs(root, layout.DistRel), "index.html"),
		layout.DistRel, "x", WriteOptions{})
	if !own.OK {
		t.Fatalf("its own role passes, got %+v", own)
	}
	if content := writeGuarded(t, root, filepath.Join(root, "overview.md"), "", "x", WriteOptions{}); !content.OK {
		t.Fatalf("ordinary content passes, got %+v", content)
	}

	roleless := writeGuarded(t, root, filepath.Join(layout.Abs(root, layout.DistRel), "other.html"), "", "x", WriteOptions{})
	if roleless.OK || roleless.Role != "dist" {
		t.Fatalf("content has no legitimate .leji/ landing, got %+v", roleless)
	}

	bare := writeGuarded(t, root, filepath.Join(layout.Abs(root, layout.LejiDir), "loose.md"),
		layout.DistRel, "x", WriteOptions{})
	if bare.OK || bare.Role != "loose.md" {
		t.Fatalf("the role is the first segment under .leji/, got %+v", bare)
	}
	lejiItself, err := RmGuarded(root, layout.Abs(root, layout.LejiDir), layout.DistRel)
	if err != nil {
		t.Fatal(err)
	}
	if lejiItself.OK || lejiItself.Role != "" {
		t.Fatalf(".leji/ itself is never the export role, got %+v", lejiItself)
	}
	if _, err := os.Stat(layout.Abs(root, layout.WorkRel)); err != nil {
		t.Fatalf("the trust domain still stands: %v", err)
	}
}

func TestTheWriteRuleCatchesAParentSymlinkedOutOfRoot(t *testing.T) {
	root := repo(t)
	away := outside(t)
	mustSymlink(t, away, filepath.Join(root, "redirect"))
	verdict := writeGuarded(t, root, filepath.Join(root, "redirect", "planted.md"), "", "x", WriteOptions{})
	if verdict.OK || !verdict.OutsideRoot {
		t.Fatalf("a parent symlinked out of root is refused, got %+v", verdict)
	}
	mustBeEmpty(t, away, "the parent was not written through")
}

func TestTheConveniencesExclusiveMkdirpRenameAtomicAndGuardedOpen(t *testing.T) {
	root := repo(t)
	away := outside(t)

	created := writeGuarded(t, root, filepath.Join(root, "leji.json"), "", "{}\n", WriteOptions{Exclusive: true})
	if !created.OK {
		t.Fatalf("an exclusive create of a free name succeeds, got %+v", created)
	}
	again := writeGuarded(t, root, filepath.Join(root, "leji.json"), "", `{"other":1}`+"\n", WriteOptions{Exclusive: true})
	if again.OK || !again.Exists {
		t.Fatalf("an existing target is its own verdict, never an overwrite, got %+v", again)
	}
	if body, err := os.ReadFile(filepath.Join(root, "leji.json")); err != nil || string(body) != "{}\n" {
		t.Fatalf("the bytes are untouched, got %q (%v)", body, err)
	}

	madeVerdict, real, err := MkdirpGuarded(root, filepath.Join(layout.Abs(root, layout.DistRel), "content"), layout.DistRel)
	if err != nil || !madeVerdict.OK {
		t.Fatalf("mkdirp of its own role succeeds, got %+v (%v)", madeVerdict, err)
	}
	if want := filepath.Join(layout.Abs(root, layout.DistRel), "content"); real != want {
		t.Fatalf("the checked resolved path comes back: %q want %q", real, want)
	}

	mustSymlink(t, away, filepath.Join(root, "out"))
	escaped, _, err := MkdirpGuarded(root, filepath.Join(root, "out", "deep"), "")
	if err != nil || escaped.OK {
		t.Fatalf("mkdirp is guarded too, got %+v (%v)", escaped, err)
	}
	mustBeEmpty(t, away, "mkdirp wrote outside the repository")

	renamed, err := RenameGuarded(root, filepath.Join(root, "leji.json"), filepath.Join(root, "out", "leji.json"), "")
	if err != nil || renamed.OK {
		t.Fatalf("a rename with an escaping destination is refused, got %+v (%v)", renamed, err)
	}
	if _, err := os.Stat(filepath.Join(root, "leji.json")); err != nil {
		t.Fatalf("and the source is still there: %v", err)
	}
	moved, err := RenameGuarded(root, filepath.Join(root, "leji.json"), filepath.Join(root, "moved.json"), "")
	if err != nil || !moved.OK {
		t.Fatalf("a contained rename succeeds, got %+v (%v)", moved, err)
	}

	atomic, err := WriteFileAtomicGuarded(root, filepath.Join(root, "ci.yml"), "", []byte("jobs:\n"))
	if err != nil || !atomic.OK {
		t.Fatalf("the atomic write succeeds, got %+v (%v)", atomic, err)
	}
	if body, err := os.ReadFile(filepath.Join(root, "ci.yml")); err != nil || string(body) != "jobs:\n" {
		t.Fatalf("the atomic write landed: %q (%v)", body, err)
	}
	if _, err := os.Lstat(filepath.Join(root, "ci.yml.leji-tmp")); err == nil {
		t.Fatal("the temp sibling is gone")
	}
	escapedAtomic, err := WriteFileAtomicGuarded(root, filepath.Join(root, "out", "ci.yml"), "", []byte("x"))
	if err != nil || escapedAtomic.OK {
		t.Fatalf("an escaping atomic destination is refused, got %+v (%v)", escapedAtomic, err)
	}

	opened, err := OpenWriteGuarded(root, filepath.Join(layout.Abs(root, layout.DistRel), "assets", "app.css"),
		layout.DistRel, 0o644)
	if err != nil || opened.File == nil {
		t.Fatalf("a guarded open of its own role succeeds, got %+v (%v)", opened.Verdict, err)
	}
	if _, err := opened.File.WriteString("body{}\n"); err != nil {
		t.Fatal(err)
	}
	if err := opened.File.Close(); err != nil {
		t.Fatal(err)
	}
	if body, err := os.ReadFile(opened.Real); err != nil || string(body) != "body{}\n" {
		t.Fatalf("the bytes land in the judged file: %q (%v)", body, err)
	}
	refusedOpen, err := OpenWriteGuarded(root, filepath.Join(root, "out", "app.css"), "", 0)
	if err != nil || refusedOpen.File != nil {
		t.Fatalf("an escaping open is refused, got %+v (%v)", refusedOpen.Verdict, err)
	}
	mustBeEmpty(t, away, "nothing landed outside the repository")
}

func TestAnExclusiveCreateIsDecidedOnTheStandingEntry(t *testing.T) {
	// O_EXCL on the RESOLVED path is not enough: a dangling symlink resolves to its
	// missing destination, so resolving first would let `leji.json -> nowhere` create
	// the file the link points at. ANY standing entry is Exists, and nothing anywhere
	// is created. Mutation that reddens: resolve before the lstat — the dangling cases
	// create the link's destination.
	root := repo(t)
	away := outside(t)
	work := layout.Abs(root, layout.WorkRel)
	mustWrite(t, filepath.Join(work, "private.json"), "private\n")
	target := filepath.Join(root, "leji.json")
	const bytes = `{"schemaVersion":"1.0"}` + "\n"

	cases := []struct {
		name    string
		plant   func()
		landing string
	}{
		{"a dangling link to a contained path", func() {
			mustSymlink(t, filepath.Join(root, "missing.json"), target)
		}, filepath.Join(root, "missing.json")},
		{"a dangling link out of the repository", func() {
			mustSymlink(t, filepath.Join(away, "missing.json"), target)
		}, filepath.Join(away, "missing.json")},
		{"a link into another role", func() {
			mustSymlink(t, filepath.Join(work, "planted.json"), target)
		}, filepath.Join(work, "planted.json")},
		{"a link to a standing file in another role", func() {
			mustSymlink(t, filepath.Join(work, "private.json"), target)
		}, target},
		{"a directory", func() {
			if err := os.Mkdir(target, 0o755); err != nil {
				t.Fatal(err)
			}
		}, target},
	}
	for _, c := range cases {
		c.plant()
		verdict := writeGuarded(t, root, target, "", bytes, WriteOptions{Exclusive: true})
		if verdict.OK || !verdict.Exists {
			t.Fatalf("%s: must be reported as an existing target, got %+v", c.name, verdict)
		}
		if c.landing != target {
			if _, err := os.Lstat(c.landing); err == nil {
				t.Fatalf("%s: the link's destination was created", c.name)
			}
		}
		if err := os.RemoveAll(target); err != nil {
			t.Fatal(err)
		}
	}
	if body, err := os.ReadFile(filepath.Join(work, "private.json")); err != nil || string(body) != "private\n" {
		t.Fatalf("the other role's file was never written through: %q (%v)", body, err)
	}

	// A standing regular file is the ordinary case, and its bytes stay as they were.
	mustWrite(t, target, "original\n")
	overExisting := writeGuarded(t, root, target, "", bytes, WriteOptions{Exclusive: true})
	if !overExisting.Exists {
		t.Fatalf("an existing regular file is never overwritten, got %+v", overExisting)
	}
	if body, err := os.ReadFile(target); err != nil || string(body) != "original\n" {
		t.Fatalf("its bytes stand: %q (%v)", body, err)
	}
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}

	// Nothing standing: the resolved path is judged, its parents included, and created.
	if free := writeGuarded(t, root, target, "", bytes, WriteOptions{Exclusive: true}); !free.OK {
		t.Fatalf("a free name is created, got %+v", free)
	}
	if body, err := os.ReadFile(target); err != nil || string(body) != bytes {
		t.Fatalf("the bytes landed: %q (%v)", body, err)
	}
	mustBeEmpty(t, away, "nothing was created outside the repository at any point")
	entries, err := os.ReadDir(work)
	if err != nil || len(entries) != 1 || entries[0].Name() != "private.json" {
		t.Fatalf("nor in another role: %v (%v)", entries, err)
	}
}

func TestARefusedWriteEstablishesNoDirectory(t *testing.T) {
	root := repo(t)
	if err := os.MkdirAll(layout.Abs(root, layout.WorkRel), 0o755); err != nil {
		t.Fatal(err)
	}
	verdict := writeGuarded(t, root, filepath.Join(layout.Abs(root, layout.WorkRel), "deep", "nested", "x.md"),
		layout.DistRel, "x", WriteOptions{})
	if verdict.OK {
		t.Fatalf("the crossing write is refused, got %+v", verdict)
	}
	if _, err := os.Stat(filepath.Join(layout.Abs(root, layout.WorkRel), "deep")); err == nil {
		t.Fatal("no parent may be created for a refused write")
	}
}

// --- the verified read ---------------------------------------------------------

func TestVerifiedTargetReadAbsentRegularDanglingSocketDirectory(t *testing.T) {
	root := repo(t)
	target := filepath.Join(root, "leji-badge.svg")

	read, err := VerifiedTargetRead(root, target, "")
	if err != nil || read.Status != ReadAbsent {
		t.Fatalf("nothing standing there is absent, got %+v (%v)", read, err)
	}

	mustWrite(t, target, "svg\n")
	read, err = VerifiedTargetRead(root, target, "")
	if err != nil || read.Status != ReadRegular || string(read.Bytes) != "svg\n" {
		t.Fatalf("a regular file comes back with its bytes, got %+v (%v)", read, err)
	}
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}

	mustSymlink(t, filepath.Join(root, "missing.svg"), target)
	read, err = VerifiedTargetRead(root, target, "")
	if err != nil || read.Status != ReadRefused || read.Reason != RefusedUnverifiable {
		t.Fatalf("a standing dangling link is never read as absent, got %+v (%v)", read, err)
	}
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}

	sock := filepath.Join(root, "sock")
	listener, err := net.Listen("unix", sock)
	if err != nil {
		t.Skipf("unix sockets unavailable here: %v", err)
	}
	read, err = VerifiedTargetRead(root, sock, "")
	if err != nil || read.Status != ReadRefused || read.Reason != RefusedNotRegular {
		t.Fatalf("a socket is refused on its own kind, got %+v (%v)", read, err)
	}
	mustSymlink(t, sock, target)
	read, err = VerifiedTargetRead(root, target, "")
	if err != nil || read.Status != ReadRefused || read.Reason != RefusedNotRegular {
		t.Fatalf("a link to a socket is settled on what it resolves to, got %+v (%v)", read, err)
	}
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	_ = listener.Close()
	_ = os.Remove(sock)

	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	read, err = VerifiedTargetRead(root, target, "")
	if err != nil || read.Status != ReadRefused || read.Reason != RefusedNotRegular {
		t.Fatalf("a directory is refused, got %+v (%v)", read, err)
	}
}

func TestVerifiedTargetReadOutsideRootAnotherRoleAndASymlinkedParent(t *testing.T) {
	root := repo(t)
	away := outside(t)
	mustWrite(t, filepath.Join(away, "real.svg"), "svg\n")

	escaping := filepath.Join(root, "escape.svg")
	mustSymlink(t, filepath.Join(away, "real.svg"), escaping)
	read, err := VerifiedTargetRead(root, escaping, "")
	if err != nil || read.Status != ReadRefused || read.Reason != RefusedOutsideRoot {
		t.Fatalf("a source resolving out of the repository is refused, got %+v (%v)", read, err)
	}

	work := layout.Abs(root, layout.WorkRel)
	mustWrite(t, filepath.Join(work, "private.svg"), "svg\n")
	crossing := filepath.Join(root, "crossing.svg")
	mustSymlink(t, filepath.Join(work, "private.svg"), crossing)
	read, err = VerifiedTargetRead(root, crossing, "")
	if err != nil || read.Status != ReadRefused || read.Reason != RefusedOtherRole {
		t.Fatalf("a source resolving into another role is refused, got %+v (%v)", read, err)
	}
	read, err = VerifiedTargetRead(root, crossing, layout.WorkRel)
	if err != nil || read.Status != ReadRegular {
		t.Fatalf("its own role reads through, got %+v (%v)", read, err)
	}

	mustSymlink(t, away, filepath.Join(root, "redirect"))
	read, err = VerifiedTargetRead(root, filepath.Join(root, "redirect", "real.svg"), "")
	if err != nil || read.Status != ReadRefused || read.Reason != RefusedOutsideRoot {
		t.Fatalf("a parent symlinked out of root is refused, got %+v (%v)", read, err)
	}
}

func TestGuardRootResolvesARootReachedThroughASymlinkedAncestor(t *testing.T) {
	root := repo(t)
	parent := repo(t)
	link := filepath.Join(parent, "repo")
	mustSymlink(t, root, link)
	if got := GuardRoot(link); got != root {
		t.Fatalf("both sides of the rule come through one resolver: %q want %q", got, root)
	}
	if verdict := writeGuarded(t, GuardRoot(link), filepath.Join(link, "x.md"), "", "x", WriteOptions{}); !verdict.OK {
		t.Fatalf("a write under the linked root is allowed, got %+v", verdict)
	}
	if body, err := os.ReadFile(filepath.Join(root, "x.md")); err != nil || string(body) != "x" {
		t.Fatalf("and it lands in the resolved root: %q (%v)", body, err)
	}
}

func TestVerifiedTargetReadOnALinkThroughSomethingThatIsNotADirectory(t *testing.T) {
	// `link -> somefile/child`, where `somefile` is a regular file: the link stands,
	// but following it hits ENOTDIR, so there is no entry to have a kind. The
	// reference's following stat returns undefined for that exactly as it does for a
	// missing entry, so the read continues and the resolver — which refuses any
	// non-ENOENT failure — makes it a standing entry this run could not verify.
	// Mutation that reddens: propagate the follow-stat's ENOTDIR — the command reports
	// an OS error instead of its own refusal.
	root := repo(t)
	mustWrite(t, filepath.Join(root, "somefile"), "x\n")
	target := filepath.Join(root, "link")
	mustSymlink(t, filepath.Join("somefile", "child"), target)

	read, err := VerifiedTargetRead(root, target, "")
	if err != nil {
		t.Fatalf("a link through a non-directory must not fail the run: %v", err)
	}
	if read.Status != ReadRefused || read.Reason != RefusedUnverifiable {
		t.Fatalf("want refused/unverifiable, got %+v", read)
	}

	// The ORIGINAL entry is judged less leniently, exactly as the reference's lstat
	// is: a TARGET PATH that itself runs through a file is an operational failure, not
	// a standing entry, and it travels out.
	if _, derr := VerifiedTargetRead(root, filepath.Join(root, "somefile", "child"), ""); derr == nil {
		t.Fatal("a target path running through a file must fail the run")
	}
}
