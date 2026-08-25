package conformancetest

// The self-managed `.leji/.gitignore`, driven from the shared fixtures: the tool
// ignores its own tree from inside, so a layer whose root `.gitignore` never received
// the `.leji/` line is clean after its first role-creating command. The fixtures own the
// scenario definitions (`lejiIgnore`), so all three SDKs answer the same six questions
// against the same trees; the unit tests below them pin what a fixture cannot construct
// without injecting a fault.
//
// Mirrors packages/sdk/test/leji-ignore.test.ts.

import (
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/cli"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/export"
	initcmd "github.com/leji-org/leji/packages/sdk-go/internal/commands/init"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/layout"
	"github.com/leji-org/leji/packages/sdk-go/internal/lejiignore"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
	"github.com/leji-org/leji/packages/sdk-go/internal/mounts"
)

var ignoreFixtures = []string{
	"valid-leji-ignore-fresh",
	"valid-leji-ignore-existing",
	"valid-leji-ignore-legacy",
}

// plant is the one symlink a scenario has the harness create before the run: a fixture
// cannot commit a symlink, and two of the scenarios are about one.
type plant struct {
	SymlinkAt   string `json:"symlinkAt"`
	SymlinkTo   string `json:"symlinkTo"`
	TargetKind  string `json:"targetKind"`
	TargetBytes string `json:"targetBytes"`
}

type ignoreScenario struct {
	ID                 string    `json:"id"`
	Note               string    `json:"note"`
	Args               []string  `json:"args"`
	Plant              *plant    `json:"plant"`
	Exit               int       `json:"exit"`
	IgnoreFile         string    `json:"ignoreFile"`
	Bytes              *string   `json:"bytes"`
	Notices            int       `json:"notices"`
	UntrackedUnderLeji *[]string `json:"untrackedUnderLeji"`
	Preserved          []string  `json:"preserved"`
	JSONParses         bool      `json:"jsonParses"`
}

type ignoreExpectation struct {
	Seeds      []seed `json:"seeds"`
	LejiIgnore *struct {
		Scenarios []ignoreScenario `json:"scenarios"`
	} `json:"lejiIgnore"`
}

// gitFixture is a pristine working copy of the fixture with every declared seed
// materialized, committed to its own git repository: `git status --porcelain` is one
// half of what these scenarios assert, and it answers nothing useful over an
// uncommitted tree.
func gitFixture(t *testing.T, name string, seeds []seed) string {
	t.Helper()
	dir := materialize(t, name, seeds)
	git := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	git("init", "-q", "-b", "main")
	git("config", "user.email", "fixtures@leji.org")
	git("config", "user.name", "Leji Fixtures")
	git("config", "commit.gpgsign", "false")
	git("add", "-A")
	git("commit", "-qm", "fixture")
	return dir
}

// plantSymlink creates the declared symlink and whatever it points at. A link out of the
// repository is spelled `outside`: it resolves to a directory the harness makes beside
// the working copy, which is the only shape a fixture cannot commit and cannot express
// as a contained relative path.
func plantSymlink(t *testing.T, dir string, declaration *plant) {
	t.Helper()
	at := fixtureAbs(dir, fixtureRel(t, declaration.SymlinkAt, "plant.symlinkAt"))
	var target string
	if declaration.SymlinkTo == "outside" {
		target = filepath.Join(t.TempDir(), "outside")
	} else {
		target = fixtureAbs(dir, fixtureRel(t, declaration.SymlinkTo, "plant.symlinkTo"))
	}
	if declaration.TargetKind == "dir" {
		if err := os.MkdirAll(target, 0o755); err != nil {
			t.Fatal(err)
		}
	} else if err := os.WriteFile(target, []byte(declaration.TargetBytes), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(at), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, at); err != nil {
		t.Fatal(err)
	}
}

// captureCLI runs the CLI with stdout and stderr redirected to pipes. The notice is a
// stderr line under every output mode, so counting it is what the `notices` field pins,
// and the `--json` document must be readable from stdout alone.
func captureCLI(t *testing.T, argv []string) (int, string, string) {
	t.Helper()
	origOut, origErr := os.Stdout, os.Stderr
	rOut, wOut, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	rErr, wErr, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout, os.Stderr = wOut, wErr
	outDone := make(chan string, 1)
	errDone := make(chan string, 1)
	go func() { body, _ := io.ReadAll(rOut); outDone <- string(body) }()
	go func() { body, _ := io.ReadAll(rErr); errDone <- string(body) }()
	code := cli.Run(argv)
	_ = wOut.Close()
	_ = wErr.Close()
	os.Stdout, os.Stderr = origOut, origErr
	out, errText := <-outDone, <-errDone
	_ = rOut.Close()
	_ = rErr.Close()
	return code, out, errText
}

// untrackedUnderLeji is every `git status --porcelain` entry whose path lies under the
// root `.leji/`.
func untrackedUnderLeji(t *testing.T, dir string) []string {
	t.Helper()
	cmd := exec.Command("git", "status", "--porcelain")
	cmd.Dir = dir
	raw, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		rel := strings.Trim(line[3:], `"`)
		if rel == layout.LejiDir || strings.HasPrefix(rel, layout.LejiDir+"/") {
			out = append(out, rel)
		}
	}
	sort.Strings(out)
	return out
}

func TestLejiIgnoreFixtureScenarios(t *testing.T) {
	for _, name := range ignoreFixtures {
		raw, err := os.ReadFile(filepath.Join(fixturesDir(t), name, "expected.json"))
		if err != nil {
			t.Fatal(err)
		}
		var expected ignoreExpectation
		if err := json.Unmarshal(raw, &expected); err != nil {
			t.Fatal(err)
		}
		if expected.LejiIgnore == nil {
			t.Fatalf("%s declares a lejiIgnore block", name)
		}
		for _, scenario := range expected.LejiIgnore.Scenarios {
			t.Run(name+"/"+scenario.ID, func(t *testing.T) {
				dir := gitFixture(t, name, expected.Seeds)
				if scenario.Plant != nil {
					plantSymlink(t, dir, scenario.Plant)
				}
				before := map[string][]byte{}
				for _, rel := range scenario.Preserved {
					abs := fixtureAbs(dir, fixtureRel(t, rel, "preserved entry"))
					body, rerr := os.ReadFile(abs)
					if rerr != nil {
						t.Fatalf("preserved path exists before the run: %s: %v", rel, rerr)
					}
					before[rel] = body
				}

				code, stdout, stderr := captureCLI(t, append(append([]string{}, scenario.Args...), "--root", dir))
				if code != scenario.Exit {
					t.Fatalf("exit %d, want %d (stderr: %s)", code, scenario.Exit, stderr)
				}

				// The one file, judged on its ORIGINAL entry: a symlink standing there
				// was refused, never followed, so lstat is what decides its kind.
				ignoreAbs := layout.Abs(dir, layout.LejiIgnoreRel)
				entry, lerr := os.Lstat(ignoreAbs)
				switch scenario.IgnoreFile {
				case "absent":
					if lerr == nil {
						t.Fatalf("%s must not exist", layout.LejiIgnoreRel)
					}
				case "symlink":
					if lerr != nil || entry.Mode()&os.ModeSymlink == 0 {
						t.Fatalf("%s is still the planted symlink", layout.LejiIgnoreRel)
					}
				default:
					if lerr != nil || !entry.Mode().IsRegular() {
						t.Fatalf("%s is a regular file", layout.LejiIgnoreRel)
					}
					body, rerr := os.ReadFile(ignoreAbs)
					if rerr != nil {
						t.Fatal(rerr)
					}
					if scenario.Bytes == nil || string(body) != *scenario.Bytes {
						t.Fatalf("%s bytes = %q", layout.LejiIgnoreRel, string(body))
					}
				}

				if notices := strings.Count(stderr, lejiignore.Notice); notices != scenario.Notices {
					t.Fatalf("notice count %d, want %d (stderr: %s)", notices, scenario.Notices, stderr)
				}

				if scenario.JSONParses {
					var document map[string]any
					if jerr := json.Unmarshal([]byte(stdout), &document); jerr != nil {
						t.Fatalf("--json stdout parses as one document: %v (%s)", jerr, stdout)
					}
					if strings.Contains(stdout, "was left as is") {
						t.Fatal("the notice is stderr only, never inside the JSON document")
					}
				}

				if scenario.UntrackedUnderLeji != nil {
					got := untrackedUnderLeji(t, dir)
					want := *scenario.UntrackedUnderLeji
					if len(got) != len(want) {
						t.Fatalf("git status under %s/ = %v, want %v", layout.LejiDir, got, want)
					}
					for i := range got {
						if got[i] != want[i] {
							t.Fatalf("git status under %s/ = %v, want %v", layout.LejiDir, got, want)
						}
					}
				}

				for rel, bytes := range before {
					body, rerr := os.ReadFile(fixtureAbs(dir, rel))
					if rerr != nil || string(body) != string(bytes) {
						t.Fatalf("preserved byte-identical: %s", rel)
					}
				}
			})
		}
	}
}

// --- unit level: what a fixture cannot prepare without injecting a fault ----------

// freshIgnoreCopy is the smallest layer these unit tests drive, copied out of the
// fixture family.
func freshIgnoreCopy(t *testing.T) string {
	t.Helper()
	dir := materialize(t, "valid-leji-ignore-fresh", nil)
	if err := os.Remove(filepath.Join(dir, "expected.json")); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestLejiIgnoreNoticeIsFrozenAndSaidOncePerContext(t *testing.T) {
	if want := "leji: .leji/.gitignore exists and was left as is (expected content: *)"; lejiignore.Notice != want {
		t.Fatalf("notice = %q, want %q", lejiignore.Notice, want)
	}
	if lejiignore.Content != "*\n" {
		t.Fatalf("content = %q", lejiignore.Content)
	}

	dir := freshIgnoreCopy(t)
	if err := os.MkdirAll(layout.Abs(dir, layout.LejiDir), 0o755); err != nil {
		t.Fatal(err)
	}
	ignoreAbs := layout.Abs(dir, layout.LejiIgnoreRel)
	if err := os.WriteFile(ignoreAbs, []byte("mine\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	text := captureStderr(t, func() {
		ctx := lejiignore.NewContext()
		for i := 0; i < 3; i++ {
			outcome, err := lejiignore.EnsureFile(dir, ctx)
			if err != nil || outcome != lejiignore.LeftAsIs {
				t.Fatalf("outcome %q err %v", outcome, err)
			}
		}
	})
	if text != lejiignore.Notice+"\n" {
		t.Fatalf("one notice per invocation context: %q", text)
	}
	body, err := os.ReadFile(ignoreAbs)
	if err != nil || string(body) != "mine\n" {
		t.Fatalf("bytes untouched: %q", string(body))
	}
}

func TestLejiIgnoreContextIsPerInvocationNeverPerProcess(t *testing.T) {
	first, second := freshIgnoreCopy(t), freshIgnoreCopy(t)
	for _, dir := range []string{first, second} {
		if err := os.MkdirAll(layout.Abs(dir, layout.LejiDir), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(layout.Abs(dir, layout.LejiIgnoreRel), []byte("mine\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	text := captureStderr(t, func() {
		for _, dir := range []string{first, second} {
			if _, err := lejiignore.EnsureFile(dir, lejiignore.NewContext()); err != nil {
				t.Fatal(err)
			}
		}
	})
	if got := strings.Count(text, lejiignore.Notice); got != 2 {
		t.Fatalf("each invocation says it for itself: %d notices in %q", got, text)
	}
}

func TestLejiIgnoreNeverWritesThroughAnEntryStandingAtTheTarget(t *testing.T) {
	// The check/use gap at the one file this exception allows, from both sides. The READ
	// side first: a symlink into ordinary content standing at the target is refused, so
	// the helper writes nothing and `decoy.txt` is untouched. Then the WRITE side, which
	// is what closes the window a Go test cannot open by interception: the very guarded
	// create the helper makes is asked to run against that same standing entry, and
	// O_EXCL is what makes it report the entry rather than follow it. Mutation that
	// reddens the second half: drop Exclusive from the guarded write in EnsureFile.
	dir := freshIgnoreCopy(t)
	if err := os.MkdirAll(layout.Abs(dir, layout.LejiDir), 0o755); err != nil {
		t.Fatal(err)
	}
	decoy := filepath.Join(dir, "decoy.txt")
	if err := os.WriteFile(decoy, []byte("not the ignore file\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ignoreAbs := layout.Abs(dir, layout.LejiIgnoreRel)
	if err := os.Symlink(decoy, ignoreAbs); err != nil {
		t.Fatal(err)
	}
	outcome, err := lejiignore.EnsureFile(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if outcome == lejiignore.Created {
		t.Fatal("nothing was created through the planted link")
	}
	body, rerr := os.ReadFile(decoy)
	if rerr != nil || string(body) != "not the ignore file\n" {
		t.Fatalf("the link target is untouched: %q", string(body))
	}
	entry, lerr := os.Lstat(ignoreAbs)
	if lerr != nil || entry.Mode()&os.ModeSymlink == 0 {
		t.Fatal("the planted link is still the planted link")
	}

	// The write side, on the same standing entry: the exclusive create reports it
	// instead of following it into `decoy.txt`.
	verdict, werr := fsx.WriteFileGuarded(fsx.GuardRoot(dir), ignoreAbs, "",
		[]byte(lejiignore.Content), fsx.WriteOptions{Exclusive: true})
	if werr != nil {
		t.Fatal(werr)
	}
	if !verdict.Exists {
		t.Fatalf("the exclusive create must report the standing entry, got %+v", verdict)
	}
	body, rerr = os.ReadFile(decoy)
	if rerr != nil || string(body) != "not the ignore file\n" {
		t.Fatalf("the link target is untouched by the create: %q", string(body))
	}
}

func TestLejiIgnoreGenerationAloneEstablishesARole(t *testing.T) {
	// The fixture scenarios drive `viewer build` and `export`, which are one command;
	// this is the other role establisher on the viewer side, reached by its own name.
	dir := freshIgnoreCopy(t)
	code, _, stderr := captureCLI(t, []string{"viewer", "--root", dir})
	if code != 0 {
		t.Fatalf("viewer exited %d (stderr: %s)", code, stderr)
	}
	body, err := os.ReadFile(layout.Abs(dir, layout.LejiIgnoreRel))
	if err != nil || string(body) != lejiignore.Content {
		t.Fatalf("ignore file = %q (%v)", string(body), err)
	}
}

func TestLejiIgnoreOnboardingGuardEstablishesTheWorkRole(t *testing.T) {
	dir := freshIgnoreCopy(t)
	action, err := initcmd.EnsureApprovalGuard(dir, "docs/")
	if err != nil || action != "installed" {
		t.Fatalf("guard action %q err %v", action, err)
	}
	body, rerr := os.ReadFile(layout.Abs(dir, layout.LejiIgnoreRel))
	if rerr != nil || string(body) != lejiignore.Content {
		t.Fatalf("ignore file = %q (%v)", string(body), rerr)
	}
}

func TestLejiIgnoreDirectSDKCallNoticesAtMostOncePerCall(t *testing.T) {
	dir := freshIgnoreCopy(t)
	if err := os.MkdirAll(layout.Abs(dir, layout.LejiDir), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(layout.Abs(dir, layout.LejiIgnoreRel), []byte("mine\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	load := manifest.LoadManifest(dir)
	if load.Manifest == nil {
		t.Fatal("the fixture manifest loads")
	}
	// BuildViewer nests GenerateViewer and establishes two roles of its own.
	text := captureStderr(t, func() {
		if _, err := export.BuildViewer(dir, load.Manifest, "", export.Options{}); err != nil {
			t.Fatal(err)
		}
	})
	if got := strings.Count(text, lejiignore.Notice); got != 1 {
		t.Fatalf("one notice for the whole call: %d in %q", got, text)
	}
}

func TestLejiIgnoreMountsEstablishmentThreadsOneContext(t *testing.T) {
	// `conformance --federation verify` probes reachability PER DECLARED MOUNT and
	// `mounts update-pin --fetch` retains twice (the current pin, then the target); each
	// establishes the managed store through the same helper, so each would say the frozen
	// line again if the invocation's notice state were not threaded all the way down.
	//
	// The declared source is routed to a local empty repository the way the mounts suite
	// routes its own (`insteadOf` is git's own redirection), so the retention establishes
	// the store and then fails locally: nothing here reaches the network.
	dir := freshIgnoreCopy(t)
	if err := os.MkdirAll(layout.Abs(dir, layout.LejiDir), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(layout.Abs(dir, layout.LejiIgnoreRel), []byte("mine\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	routed := filepath.Join(t.TempDir(), "routed.git")
	if out, err := exec.Command("git", "init", "--bare", "-q", routed).CombinedOutput(); err != nil {
		t.Fatalf("git init --bare: %v: %s", err, out)
	}
	const source = "https://github.com/acme/one"
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "url."+routed+".insteadOf")
	t.Setenv("GIT_CONFIG_VALUE_0", source)

	decl := mounts.MountDecl{Name: "one", Source: source, Pin: strings.Repeat("0", 40), TrackingRef: "refs/heads/main"}
	ctx := lejiignore.NewContext()
	text := captureStderr(t, func() {
		for _, oid := range []string{strings.Repeat("0", 40), strings.Repeat("1", 40)} {
			if _, _, err := mounts.RetainPinInStore(dir, decl, "acme/one", oid, ctx); err != nil {
				t.Fatal(err)
			}
		}
	})
	// The guard against a test that passes for the wrong reason: the managed store really
	// was established, so a notice was genuinely available to be said each time.
	entries, err := os.ReadDir(filepath.Join(layout.Abs(dir, layout.MountsRel), "store"))
	if err != nil || len(entries) == 0 {
		t.Fatalf("the managed store was established: %v", err)
	}
	if got := strings.Count(text, lejiignore.Notice); got != 1 {
		t.Fatalf("one notice for the invocation: %d in %q", got, text)
	}
	body, rerr := os.ReadFile(layout.Abs(dir, layout.LejiIgnoreRel))
	if rerr != nil || string(body) != "mine\n" {
		t.Fatalf("bytes untouched: %q", string(body))
	}
}

func TestLejiIgnoreIsNeverCreatedByAReadOnlyCommand(t *testing.T) {
	// Nothing read-only creates the file: the bootstrap requirement is that it appears at
	// the first ROLE creation, and `validate` creates none.
	dir := freshIgnoreCopy(t)
	code, _, stderr := captureCLI(t, []string{"validate", "--root", dir})
	if code != 0 {
		t.Fatalf("validate exited %d (stderr: %s)", code, stderr)
	}
	if _, err := os.Lstat(layout.Abs(dir, layout.LejiDir)); err == nil {
		t.Fatalf("%s/ must not exist after a read-only command", layout.LejiDir)
	}
}
