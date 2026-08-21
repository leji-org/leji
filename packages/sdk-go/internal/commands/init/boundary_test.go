package initcmd

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

// The write boundary as these commands meet it: no pathname existence check decides
// a write, so a dangling symlink at a target is a standing entry (never written
// through, never read as absent), and a target resolving out of the repository is the
// same hard refusal a write to it would be. Mirrors the reference's onboarding and
// units cases.

func mustSymlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
}

func isSymlink(t *testing.T, abs string) bool {
	t.Helper()
	st, err := os.Lstat(abs)
	return err == nil && st.Mode()&os.ModeSymlink != 0
}

func standsAt(t *testing.T, abs string) bool {
	t.Helper()
	_, err := os.Lstat(abs)
	return err == nil
}

// treeSnapshot is every entry under dir as `path -> bytes` (symlinks by their
// target), so a run that must write nothing can be held to the whole tree rather
// than to one file.
func treeSnapshot(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	var walk func(rel string)
	walk = func(rel string) {
		abs := dir
		if rel != "" {
			abs = filepath.Join(dir, filepath.FromSlash(rel))
		}
		entries, err := os.ReadDir(abs)
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range entries {
			childRel := e.Name()
			if rel != "" {
				childRel = rel + "/" + e.Name()
			}
			child := filepath.Join(dir, filepath.FromSlash(childRel))
			switch {
			case e.Type()&os.ModeSymlink != 0:
				target, err := os.Readlink(child)
				if err != nil {
					t.Fatal(err)
				}
				out = append(out, childRel+"\x00link:"+target)
			case e.IsDir():
				walk(childRel)
			case e.Type().IsRegular():
				body, err := os.ReadFile(child)
				if err != nil {
					t.Fatal(err)
				}
				out = append(out, childRel+"\x00"+string(body))
			default:
				out = append(out, childRel+"\x00non-regular")
			}
		}
	}
	walk("")
	sort.Strings(out)
	return out
}

func sameTree(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestInitRefusesAGitignoreSymlinkedOutOfTheRepository(t *testing.T) {
	// Previously the one unguarded write in init: the `.leji/` ignore line went out
	// through whatever `.gitignore` resolved to. It now goes through the chokepoint,
	// so a planted link out of the tree is a refusal with nothing written through it.
	// Mutation that reddens: write the merged text by pathname again.
	dir := t.TempDir()
	away := t.TempDir()
	target := filepath.Join(away, "gitignore")
	if err := os.WriteFile(target, []byte("node_modules/\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustSymlink(t, target, filepath.Join(dir, ".gitignore"))

	_, err := InitLayer(Options{Dir: dir, Yes: true, Name: "demo-context"})
	if err == nil || !strings.Contains(err.Error(), "refusing to write through a symlink that escapes the target") {
		t.Fatalf("the escaping .gitignore must be refused, got %v", err)
	}
	if body, rerr := os.ReadFile(target); rerr != nil || string(body) != "node_modules/\n" {
		t.Fatalf("the out-of-tree file must be byte-untouched, got %q (%v)", body, rerr)
	}
	if standsAt(t, filepath.Join(dir, "leji.json")) {
		t.Fatal("the refusal must come before any layer write")
	}
}

func TestInitRefusesADanglingScaffoldTarget(t *testing.T) {
	// A stat follows symlinks, so a dangling target read as absent and the guarded
	// write landed at the link's destination — inside the root, but under a name init
	// never planned. The verified read refuses the standing entry instead.
	dir := t.TempDir()
	target := filepath.Join(dir, "docs", "boot-profile.md")
	mustSymlink(t, "never-created.md", target)

	_, err := InitLayer(Options{Dir: dir, Yes: true})
	if err == nil || !strings.Contains(err.Error(), "escapes the target") {
		t.Fatalf("a dangling scaffold target must be refused, got %v", err)
	}
	if standsAt(t, filepath.Join(dir, "docs", "never-created.md")) {
		t.Fatal("the dangling link's destination must never be created")
	}
	if !isSymlink(t, target) {
		t.Fatal("the planted link must be left exactly as it was")
	}
}

func TestInitRefusesAScaffoldTargetSymlinkedOutsideTheRepository(t *testing.T) {
	// A pathname check sees the link's outside target and reads the name as taken, so
	// init would quietly skip the file it owns. The verified read judges where the
	// entry resolves: outside the root is the same hard refusal a write to it is.
	dir := t.TempDir()
	away := t.TempDir()
	outsideFile := filepath.Join(away, "boot-profile.md")
	if err := os.WriteFile(outsideFile, []byte("# Outside the repository\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustSymlink(t, outsideFile, filepath.Join(dir, "docs", "boot-profile.md"))

	_, err := InitLayer(Options{Dir: dir, Yes: true})
	if err == nil || !strings.Contains(err.Error(), "escapes the target") {
		t.Fatalf("a scaffold target resolving outside the repository must be refused, got %v", err)
	}
	if body, rerr := os.ReadFile(outsideFile); rerr != nil || string(body) != "# Outside the repository\n" {
		t.Fatalf("the outside file must be untouched, got %q (%v)", body, rerr)
	}
}

func TestAdoptTreatsADanglingScaffoldNameAsOccupied(t *testing.T) {
	// The scaffold names were picked with a stat, which follows symlinks: a dangling
	// boot-profile link read as a free name, and the scaffold would have been written
	// at the link's missing destination. Occupancy is decided on the standing entry
	// now, so the alternate name is taken exactly as for an ordinary existing file.
	dir := t.TempDir()
	gitInit(t, dir)
	if err := os.MkdirAll(filepath.Join(dir, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "docs", "notes.md"), []byte("# Notes\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "docs", "boot-profile.md")
	mustSymlink(t, "never-created.md", link)
	gitCommitAll(t, dir)

	res, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true})
	if err != nil {
		t.Fatalf("AdoptLayer: %v", err)
	}
	if res.Manifest.BootProfilePath != "docs/leji-boot-profile.md" {
		t.Fatalf("the alternate name must be scaffolded, got %q", res.Manifest.BootProfilePath)
	}
	if standsAt(t, filepath.Join(dir, "docs", "never-created.md")) {
		t.Fatal("the dangling link's destination must never be created")
	}
	if !isSymlink(t, link) {
		t.Fatal("the planted link must be left exactly as it was")
	}
}

func TestAdoptTreatsADanglingMigrationDocNameAsOccupied(t *testing.T) {
	// The disambiguation loop picks the archive's name. A dangling candidate read by
	// pathname is a free name, and the migrated content would land at the link's
	// missing destination; the standing entry makes it occupied.
	dir := t.TempDir()
	gitInit(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte("original instructions\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	candidate := filepath.Join(dir, "docs", "governance", "imported-claude.md")
	mustSymlink(t, "never-created.md", candidate)
	gitCommitAll(t, dir)

	res, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true})
	if err != nil {
		t.Fatalf("AdoptLayer: %v", err)
	}
	if len(res.Migrated) != 1 || res.Migrated[0] != "CLAUDE.md" {
		t.Fatalf("the vendor content must still be migrated, got %v", res.Migrated)
	}
	if standsAt(t, filepath.Join(dir, "docs", "governance", "never-created.md")) {
		t.Fatal("the dangling link's destination must never be created")
	}
	if !isSymlink(t, candidate) {
		t.Fatal("the planted link must be left exactly as it was")
	}
	alt := filepath.Join(dir, "docs", "governance", "imported-claude-2.md")
	body, err := os.ReadFile(alt)
	if err != nil || !strings.Contains(string(body), "original instructions") {
		t.Fatalf("the next name must carry the archive, got %q (%v)", body, err)
	}
}

func TestAdoptWireAdaptersTreatsADanglingArchiveCandidateAsOccupied(t *testing.T) {
	dir := t.TempDir()
	gitInit(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte("original instructions\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCommitAll(t, dir)
	if _, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true}); err != nil {
		t.Fatalf("AdoptLayer: %v", err)
	}

	candidate := filepath.Join(dir, "docs", "governance", "imported-claude.md")
	if err := os.Remove(candidate); err != nil {
		t.Fatal(err)
	}
	mustSymlink(t, "never-created.md", candidate)
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte("hand-written rules added after adoption\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	wired, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true, WireAdapters: true})
	if err != nil {
		t.Fatalf("adopt --wire-adapters: %v", err)
	}
	if len(wired.Migrated) != 1 || wired.Migrated[0] != "CLAUDE.md" {
		t.Fatalf("the newer content must still be archived, got %v", wired.Migrated)
	}
	if standsAt(t, filepath.Join(dir, "docs", "governance", "never-created.md")) {
		t.Fatal("the dangling link's destination must never be created")
	}
	if !isSymlink(t, candidate) {
		t.Fatal("the planted link must be left exactly as it was")
	}
	alt := filepath.Join(dir, "docs", "governance", "imported-claude-2.md")
	body, err := os.ReadFile(alt)
	if err != nil || !strings.Contains(string(body), "hand-written rules added after adoption") {
		t.Fatalf("the next name must carry the archive, got %q (%v)", body, err)
	}
}

func TestAgentRefusesADanglingProfileNameWritingNeitherHalf(t *testing.T) {
	// A stat follows symlinks, so a dangling profile link read as absent and the
	// profile was written at the link's destination. Both halves are judged before
	// either is written, so a refused profile leaves the manifest binding unwritten.
	dir := t.TempDir()
	gitInit(t, dir)
	if _, err := InitLayer(Options{Dir: dir, Yes: true, Name: "demo"}); err != nil {
		t.Fatalf("InitLayer: %v", err)
	}
	load := manifest.LoadManifest(dir)
	link := filepath.Join(dir, "docs", "agents", "reviewer.md")
	mustSymlink(t, "never-created.md", link)
	before := treeSnapshot(t, dir)

	_, err := AddAgent(dir, load.Manifest, AgentOptions{Host: "codex", Name: "reviewer"})
	if err == nil || !strings.Contains(err.Error(), "escapes the target") {
		t.Fatalf("a dangling profile name must refuse the command, got %v", err)
	}
	if standsAt(t, filepath.Join(dir, "docs", "agents", "never-created.md")) {
		t.Fatal("the dangling link's destination must never be created")
	}
	if !sameTree(before, treeSnapshot(t, dir)) {
		t.Fatal("neither half may be written")
	}
}

func TestAgentRefusesAManifestSymlinkedOutOfTheRepositoryWritingNothing(t *testing.T) {
	// The other formerly unguarded write: the in-place manifest edit that binds the
	// agent. Binding is two writes (a profile file and the manifest edit), so the
	// manifest is judged through the verified read BEFORE either happens: a run that
	// cannot finish must not half-finish. Nothing is written, anywhere.
	dir := t.TempDir()
	away := t.TempDir()
	gitInit(t, dir)
	if _, err := InitLayer(Options{Dir: dir, Yes: true, Name: "demo"}); err != nil {
		t.Fatalf("InitLayer: %v", err)
	}
	load := manifest.LoadManifest(dir)
	manifestAbs := filepath.Join(dir, "leji.json")
	target := filepath.Join(away, "leji.json")
	if err := os.Rename(manifestAbs, target); err != nil {
		t.Fatal(err)
	}
	mustSymlink(t, target, manifestAbs)
	before, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	profileAbs := filepath.Join(dir, "docs", "agents", "reviewer.md")
	if standsAt(t, profileAbs) {
		t.Fatal("the profile must not exist before the run")
	}
	snapshot := treeSnapshot(t, dir)

	_, aerr := AddAgent(dir, load.Manifest, AgentOptions{Name: "reviewer", Role: "reviewer"})
	if aerr == nil || !strings.Contains(aerr.Error(), `refusing to write through a symlink that escapes the target: "leji.json"`) {
		t.Fatalf("the escaping manifest must refuse the command, got %v", aerr)
	}
	if after, rerr := os.ReadFile(target); rerr != nil || string(after) != string(before) {
		t.Fatalf("the out-of-tree manifest must be byte-untouched (%v)", rerr)
	}
	if standsAt(t, profileAbs) {
		t.Fatal("the profile must never be written")
	}
	if !sameTree(snapshot, treeSnapshot(t, dir)) {
		t.Fatal("the whole tree must be byte-identical to the pre-run snapshot")
	}
}

func TestCiRefusesADanglingWorkflowTargetForEveryProvider(t *testing.T) {
	// Every arm decided presence with a stat, which follows symlinks: a dangling
	// workflow link read as absent and the create landed at the link's destination, a
	// name inside the repository the tool never planned. The verified read refuses the
	// standing entry instead, in the same words an escaping target gets.
	for _, c := range []struct{ provider, rel string }{
		{"github", CIWorkflowPath},
		{"gitlab", GitlabCIPath},
		{"circleci", CircleCIConfigPath},
		{"azure", AzurePipelinePath},
	} {
		dir := t.TempDir()
		if _, err := InitLayer(Options{Dir: dir, Yes: true, Name: "demo"}); err != nil {
			t.Fatalf("InitLayer: %v", err)
		}
		target := filepath.Join(dir, filepath.FromSlash(c.rel))
		mustSymlink(t, "never-created.yml", target)

		_, err := EnsureCiWorkflow(dir, c.provider, nil)
		if err == nil || !strings.Contains(err.Error(), "refusing to write through a symlink that escapes the target") {
			t.Fatalf("%s: a dangling workflow target must be refused, got %v", c.provider, err)
		}
		if standsAt(t, filepath.Join(filepath.Dir(target), "never-created.yml")) {
			t.Fatalf("%s: the dangling link's destination must never be created", c.provider)
		}
		if !isSymlink(t, target) {
			t.Fatalf("%s: the planted link must be left exactly as it was", c.provider)
		}
	}
}

func TestCiRefusesAWorkflowTargetThatIsNotARegularFile(t *testing.T) {
	// The merge reads the bytes it is about to rewrite through the verified read, so a
	// target that is not a regular file is the same hard refusal a write to it would
	// be, reported in the SDK's own words rather than as an OS read error.
	dir := t.TempDir()
	if _, err := InitLayer(Options{Dir: dir, Yes: true, Name: "demo"}); err != nil {
		t.Fatalf("InitLayer: %v", err)
	}
	if err := os.Mkdir(filepath.Join(dir, "inside-dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	mustSymlink(t, filepath.Join(dir, "inside-dir"), filepath.Join(dir, GitlabCIPath))

	_, err := EnsureCiWorkflow(dir, "gitlab", nil)
	if err == nil || !strings.Contains(err.Error(), "refusing to write through a symlink that escapes the target") {
		t.Fatalf("a non-regular workflow target must be refused, got %v", err)
	}
}

func TestAdoptPropagatesANonENOENTLstatWhilePickingNames(t *testing.T) {
	// Occupancy is decided on the standing entry, and an lstat that fails for any
	// reason other than absence answers neither "free" nor "occupied": the name cannot
	// be judged, so the run fails rather than quietly moving to an alternate — exactly
	// as the reference's lstat throws for anything but ENOENT. Mutation that reddens:
	// have nothingStandsAt read a failed lstat as "occupied" — adopt scaffolds the
	// alternate name instead of reporting the failure.
	if os.Geteuid() == 0 {
		t.Skip("running as root bypasses directory permissions; the lstat cannot be made to fail")
	}
	dir := t.TempDir()
	gitInit(t, dir)
	if err := os.MkdirAll(filepath.Join(dir, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "docs", "notes.md"), []byte("# Notes\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCommitAll(t, dir)
	// Searchable to nothing: the scaffold names under docs/ cannot be lstat'd at all.
	if err := os.Chmod(filepath.Join(dir, "docs"), 0o000); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chmod(filepath.Join(dir, "docs"), 0o755) }()
	if _, err := os.Lstat(filepath.Join(dir, "docs", "boot-profile.md")); err == nil || os.IsNotExist(err) {
		t.Skip("this platform still answers lstat under a 0o000 directory")
	}

	_, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true})
	if err == nil {
		t.Fatal("an unjudgeable candidate name must fail the run, not fall through to an alternate")
	}
	if !strings.Contains(err.Error(), "permission denied") {
		t.Fatalf("the operational failure must surface: %v", err)
	}
}
