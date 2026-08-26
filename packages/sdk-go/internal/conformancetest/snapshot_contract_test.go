package conformancetest

// The shared fixture is the byte contract for the snapshot helper, and these goldens
// are the frozen bytes the Node reference (packages/sdk/test/snapshot-contract.test.ts)
// and the Python port assert against too. The walked payload is `payload/`; the seeds
// and the goldens live beside it, outside the walk, so a golden never has to contain
// its own digest.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const snapshotFixture = "snapshot-contract"

type snapshotSymlink struct {
	At string `json:"at"`
	To string `json:"to"`
}

type snapshotGolden struct {
	File     string `json:"file"`
	Walk     string `json:"walk"`
	RepoRoot string `json:"repoRoot"`
}

// snapshotDeclaration is the fixture's `leji-test.json`: what a walk must find that git
// cannot carry (the two `.git` seeds, an empty directory, a symlink) and which golden
// each walk is compared to.
type snapshotDeclaration struct {
	Seeds   []seed `json:"seeds"`
	Runtime struct {
		Directories []string          `json:"directories"`
		Symlinks    []snapshotSymlink `json:"symlinks"`
	} `json:"runtime"`
	Goldens map[string]snapshotGolden `json:"goldens"`
}

func snapshotDecl(t *testing.T) snapshotDeclaration {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(fixturesDir(t), snapshotFixture, "leji-test.json"))
	if err != nil {
		t.Fatal(err)
	}
	var decl snapshotDeclaration
	if err := json.Unmarshal(b, &decl); err != nil {
		t.Fatal(err)
	}
	if len(decl.Seeds) == 0 || len(decl.Goldens) == 0 {
		t.Fatal("the fixture declaration must carry its seeds and its goldens")
	}
	return decl
}

// snapshotWorkingCopy is a working copy of the fixture with everything the declaration
// says a walk must find: the declared seeds materialized as real `.git` directories by
// the harness's own seed materializer, then the entries git cannot track (an empty
// directory, a symlink) created here.
//
// Windows: creating a symlink needs SeCreateSymbolicLinkPrivilege (Developer Mode or an
// elevated shell), which an ordinary account does not hold, and `payload/link` is one of
// the entries the contract is about, and a walk without it is not this contract. The Go
// suite runs on ubuntu-latest in CI, so nothing is lost there; a Windows developer gets
// a documented skip rather than a failure about a privilege. Line endings are not a
// second Windows hazard: `.gitattributes` disables conversion for every path, so the
// committed bytes are the checked-out bytes and the digests hold.
func snapshotWorkingCopy(t *testing.T, decl snapshotDeclaration) string {
	t.Helper()
	dir := materialize(t, snapshotFixture, decl.Seeds)
	for _, rel := range decl.Runtime.Directories {
		if err := os.MkdirAll(fixtureAbs(dir, fixtureRel(t, rel, "runtime.directories entry")), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, link := range decl.Runtime.Symlinks {
		at := fixtureAbs(dir, fixtureRel(t, link.At, "runtime.symlinks[].at"))
		if err := os.Symlink(filepath.FromSlash(link.To), at); err != nil {
			if runtime.GOOS == "windows" {
				t.Skipf("this platform refuses symlink creation without privilege, and %s is part of the contract: %v", link.At, err)
			}
			t.Fatal(err)
		}
	}
	return dir
}

// snapshotGoldenLines is the frozen bytes of one golden, as the lines a walk must
// produce.
func snapshotGoldenLines(t *testing.T, decl snapshotDeclaration, name string) []string {
	t.Helper()
	g, ok := decl.Goldens[name]
	if !ok {
		t.Fatalf("the declaration must name the %q golden", name)
	}
	b, err := os.ReadFile(filepath.Join(fixturesDir(t), snapshotFixture, g.File))
	if err != nil {
		t.Fatal(err)
	}
	text := string(b)
	if !strings.HasSuffix(text, "\n") {
		t.Fatalf("%s: a golden ends with a newline", name)
	}
	return strings.Split(strings.TrimSuffix(text, "\n"), "\n")
}

// snapshotWalk is the walked directory and repository root one golden declares, as
// absolute paths inside a working copy.
func snapshotWalk(t *testing.T, decl snapshotDeclaration, dir, name string) (string, string) {
	t.Helper()
	g := decl.Goldens[name]
	return fixtureAbs(dir, fixtureRel(t, g.Walk, "goldens[].walk")),
		fixtureAbs(dir, fixtureRel(t, g.RepoRoot, "goldens[].repoRoot"))
}

func TestSnapshotContractWholeRepositoryWalk(t *testing.T) {
	decl := snapshotDecl(t)
	dir := snapshotWorkingCopy(t, decl)
	walk, repoRoot := snapshotWalk(t, decl, dir, "repo")
	lines := snapshotTree(t, walk, repoRoot)

	if want := snapshotGoldenLines(t, decl, "repo"); !equalStrings(lines, want) {
		t.Fatalf("the walk must be the frozen golden, line for line:\n got=%v\nwant=%v", lines, want)
	}

	// What the golden says, said again as claims, so a re-baked golden that lost one of
	// them fails here rather than passing quietly.
	for _, line := range lines {
		if line == ".git/\tdir" || strings.HasPrefix(line, ".git/") {
			t.Fatalf("the repository .git must be absent from the snapshot: %s", line)
		}
	}
	if !containsLine(lines, "pkg/.git/\tdir") {
		t.Fatal("the nested .git must be an entry of its own")
	}
	if !hasPrefixLine(lines, "pkg/.git/HEAD\tsha256:") {
		t.Fatal("and its contents must be digested like any other file")
	}
	if !containsLine(lines, "empty/\tdir") {
		t.Fatal("an empty directory must be recorded, so its creation is detectable")
	}
	if !containsLine(lines, "link\tnon-regular") {
		t.Fatal("a symlink must be marked, never followed")
	}

	// The ordering is bytewise over UTF-8. Go's own string comparison already is, so
	// this vector is not the trap here that it is in the Node reference (where a default
	// sort orders UTF-16 code units and puts these two the other way). It is the proof
	// that this port's order IS the goldens' order: `ｚ` (EF BD 9A) before `😀`
	// (F0 9F 98 80).
	wide := indexOfPrefix(lines, "ｚ.txt\t")
	grin := indexOfPrefix(lines, "😀.txt\t")
	if wide < 0 || grin < 0 {
		t.Fatal("both non-ASCII entries must be recorded")
	}
	if wide >= grin {
		t.Fatal("the wide latin z must precede the emoji, which is UTF-8 byte order")
	}
	for i := 1; i < len(lines); i++ {
		if lines[i-1] > lines[i] {
			t.Fatalf("the lines must be sorted bytewise: %q before %q", lines[i-1], lines[i])
		}
	}
}

func TestSnapshotContractRepoRootDefaultsToTheWalkedDirectory(t *testing.T) {
	decl := snapshotDecl(t)
	dir := snapshotWorkingCopy(t, decl)
	walk, _ := snapshotWalk(t, decl, dir, "repo")
	if want := snapshotGoldenLines(t, decl, "repo"); !equalStrings(snapshotTree(t, walk, ""), want) {
		t.Fatal("an unstated repoRoot is the whole-repository call, the same walk")
	}
}

func TestSnapshotContractSubtreeWalk(t *testing.T) {
	decl := snapshotDecl(t)
	dir := snapshotWorkingCopy(t, decl)
	walk, repoRoot := snapshotWalk(t, decl, dir, "subtree")
	golden := snapshotGoldenLines(t, decl, "subtree")

	// Root means the repository, not the call: `pkg/.git` is content, and the paths are
	// relative to the walked directory.
	if got := snapshotTree(t, walk, repoRoot); !equalStrings(got, golden) {
		t.Fatalf("the frozen subtree golden:\n got=%v\nwant=%v", got, golden)
	}

	// The same walk claiming the subtree as the repository excludes exactly the .git
	// lines, and nothing else moves.
	var own []string
	for _, line := range golden {
		if line == ".git/\tdir" || strings.HasPrefix(line, ".git/") {
			continue
		}
		own = append(own, line)
	}
	if len(own) == len(golden) {
		t.Fatal("the subtree golden must carry the .git lines this case removes")
	}
	if len(own) == 0 {
		t.Fatal("and the walk must still record the rest of the subtree")
	}
	if got := snapshotTree(t, walk, walk); !equalStrings(got, own) {
		t.Fatalf("its own .git is the one entry excluded:\n got=%v\nwant=%v", got, own)
	}
}

func containsLine(lines []string, want string) bool {
	for _, line := range lines {
		if line == want {
			return true
		}
	}
	return false
}

func hasPrefixLine(lines []string, prefix string) bool {
	return indexOfPrefix(lines, prefix) >= 0
}

func indexOfPrefix(lines []string, prefix string) int {
	for i, line := range lines {
		if strings.HasPrefix(line, prefix) {
			return i
		}
	}
	return -1
}
