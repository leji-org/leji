package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	initcmd "github.com/leji-org/leji/packages/sdk-go/internal/commands/init"
	"github.com/leji-org/leji/packages/sdk-go/internal/schemas"
)

// ciGolden reads one committed generated-CI golden: the byte oracle both this port
// and the reference are checked against.
func ciGolden(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(repoRoot(t), "fixtures", "ci-goldens", name))
	if err != nil {
		t.Fatalf("ci golden %s: %v", name, err)
	}
	return string(data)
}

func repoRoot(t *testing.T) string {
	t.Helper()
	wd, _ := os.Getwd()
	return filepath.Join(wd, "..", "..", "..", "..")
}

func fixture(t *testing.T, name string) string {
	return filepath.Join(repoRoot(t), "fixtures", name)
}

// captureRun runs the CLI, capturing stdout/stderr.
func captureRun(t *testing.T, argv []string) (int, string, string) {
	t.Helper()
	origOut, origErr := os.Stdout, os.Stderr
	rOut, wOut, _ := os.Pipe()
	rErr, wErr, _ := os.Pipe()
	os.Stdout, os.Stderr = wOut, wErr
	code := Run(argv)
	wOut.Close()
	wErr.Close()
	os.Stdout, os.Stderr = origOut, origErr
	out := drain(rOut)
	errs := drain(rErr)
	return code, out, errs
}

func drain(r *os.File) string {
	var sb strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			sb.Write(buf[:n])
		}
		if err != nil {
			break
		}
	}
	r.Close()
	return sb.String()
}

func TestCLIVersion(t *testing.T) {
	for _, flag := range []string{"--version", "-v"} {
		code, out, _ := captureRun(t, []string{flag})
		if code != 0 {
			t.Fatalf("%s exit %d", flag, code)
		}
		if strings.TrimSpace(out) != schemas.SDKVersion {
			t.Fatalf("%s output %q", flag, out)
		}
	}
	// -V was removed (no --verbose to guard against); it is now an unknown option.
	code, _, errs := captureRun(t, []string{"-V"})
	if code != 2 {
		t.Fatalf("-V exit %d", code)
	}
	if !strings.Contains(errs, "unknown option -V") {
		t.Fatalf("-V stderr %q", errs)
	}
}

func TestCLIVersionFlagShortCircuitsCommand(t *testing.T) {
	// `init -v` prints the version and must not scaffold (no side effects).
	dir := t.TempDir()
	code, out, _ := captureRun(t, []string{"init", "--dir", dir, "-v"})
	if code != 0 {
		t.Fatalf("init -v exit %d", code)
	}
	if strings.TrimSpace(out) != schemas.SDKVersion {
		t.Fatalf("init -v output %q", out)
	}
	if _, err := os.Stat(filepath.Join(dir, "leji.json")); err == nil {
		t.Fatal("-v should not have scaffolded a layer")
	}
}

func TestIndexAutoSeedsChangelogWhenIndexed(t *testing.T) {
	dir := t.TempDir()
	if code, _, errs := captureRun(t, []string{"init", "--yes", "--dir", dir, "--name", "demo-context"}); code != 0 {
		t.Fatalf("init: %s", errs)
	}
	cl := filepath.Join(dir, "docs", "context-changelog.json")
	if _, err := os.Stat(cl); err == nil {
		t.Fatal("core init should not write a changelog")
	}
	// Claim indexed, then index should complete the surface by seeding the changelog.
	mp := filepath.Join(dir, "leji.json")
	b, _ := os.ReadFile(mp)
	if err := os.WriteFile(mp, []byte(strings.Replace(string(b), `"claimedLevel": "core"`, `"claimedLevel": "indexed"`, 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	code, out, errs := captureRun(t, []string{"index", "--root", dir, "--json"})
	if code != 0 {
		t.Fatalf("index: %s", errs)
	}
	if !strings.Contains(out, `"changelog": "docs/context-changelog.json"`) {
		t.Fatalf("index did not report seeding the changelog: %s", out)
	}
	if _, err := os.Stat(cl); err != nil {
		t.Fatal("changelog should have been seeded")
	}
	// A second run must not re-seed (never overwrites an existing changelog).
	if _, out2, _ := captureRun(t, []string{"index", "--root", dir, "--json"}); strings.Contains(out2, `"changelog"`) {
		t.Fatalf("changelog re-seeded: %s", out2)
	}
}

func TestIndexDoesNotSeedChangelogOnCoreLayer(t *testing.T) {
	dir := t.TempDir()
	if code, _, errs := captureRun(t, []string{"init", "--yes", "--dir", dir, "--name", "demo-context"}); code != 0 {
		t.Fatalf("init: %s", errs)
	}
	if _, out, _ := captureRun(t, []string{"index", "--root", dir, "--json"}); strings.Contains(out, `"changelog"`) {
		t.Fatalf("core layer should not seed a changelog: %s", out)
	}
	if _, err := os.Stat(filepath.Join(dir, "docs", "context-changelog.json")); err == nil {
		t.Fatal("core layer: no changelog should exist")
	}
}

func TestIndexRefusesSymlinkedAncestorEscape(t *testing.T) {
	// writeIndex must refuse to write through a symlinked ancestor that escapes
	// the layer root (the H1 fix): escape reported, exit 1, nothing written outside.
	outside := t.TempDir()
	dir := t.TempDir()
	if code, _, errs := captureRun(t, []string{"init", "--dir", dir, "--yes", "--level", "indexed", "--name", "demo"}); code != 0 {
		t.Fatalf("init: %s", errs)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "docs", "evil")); err != nil {
		t.Fatal(err)
	}
	mp := filepath.Join(dir, "leji.json")
	b, err := os.ReadFile(mp)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	machine, _ := m["machine"].(map[string]any)
	if machine == nil {
		machine = map[string]any{}
	}
	machine["indexPath"] = "docs/evil/context-index.json"
	m["machine"] = machine
	out, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mp, append(out, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	code, stdout, stderr := captureRun(t, []string{"index", "--root", dir, "--json"})
	if code != 1 {
		t.Fatalf("expected exit 1, got %d\nstdout: %s\nstderr: %s", code, stdout, stderr)
	}
	if !strings.Contains(stdout, "resolves outside the layer root") && !strings.Contains(stderr, "resolves outside the layer root") {
		t.Fatalf("escape not reported\nstdout: %s\nstderr: %s", stdout, stderr)
	}
	if _, err := os.Stat(filepath.Join(outside, "context-index.json")); err == nil {
		t.Fatal("nothing should have been written outside the root")
	}
}

func TestCLINoCommandExits2(t *testing.T) {
	code, out, _ := captureRun(t, []string{})
	if code != 2 {
		t.Fatalf("no-command exit %d", code)
	}
	if !strings.Contains(out, "Usage: leji") {
		t.Fatalf("expected usage, got %q", out)
	}
}

func TestCLIHelpExits0(t *testing.T) {
	code, out, _ := captureRun(t, []string{"help"})
	if code != 0 {
		t.Fatalf("help exit %d", code)
	}
	if !strings.Contains(out, "leji.org/cli") {
		t.Fatalf("help missing reference link")
	}
}

func TestCLIUnknownCommandExits2(t *testing.T) {
	code, _, errs := captureRun(t, []string{"frobnicate"})
	if code != 2 {
		t.Fatalf("unknown command exit %d", code)
	}
	if !strings.Contains(errs, "unknown command") {
		t.Fatalf("expected unknown command, got %q", errs)
	}
}

func TestCLIUnknownFlagExits2(t *testing.T) {
	code, _, errs := captureRun(t, []string{"validate", "--frobnicate"})
	if code != 2 {
		t.Fatalf("unknown flag exit %d", code)
	}
	if !strings.Contains(errs, "unknown option") {
		t.Fatalf("expected unknown option, got %q", errs)
	}
}

func TestCLIBadFlagValuesExit2(t *testing.T) {
	cases := [][]string{
		{"validate", "--root"},
		{"init", "--level", "galactic"},
		{"changelog", "frobnicate"},
	}
	for _, argv := range cases {
		code, _, _ := captureRun(t, argv)
		if code != 2 {
			t.Fatalf("%v expected exit 2, got %d", argv, code)
		}
	}
}

// init/adopt --mode: invalid and missing values fail with usage exit 2; solo
// plans the starters. Mirrors the Node run.test.ts working-mode test.
func TestCLIInitModeValidationAndSoloPlan(t *testing.T) {
	dir := t.TempDir()
	code, _, errs := captureRun(t, []string{"init", "--dir", dir, "--yes", "--mode", "squad"})
	if code != 2 {
		t.Fatalf("invalid mode should exit 2, got %d", code)
	}
	if !strings.Contains(errs, "--mode must be solo or team") {
		t.Fatalf("expected the mode usage error, got %q", errs)
	}
	code, _, errs = captureRun(t, []string{"init", "--dir", dir, "--yes", "--mode"})
	if code != 2 {
		t.Fatalf("missing mode value should exit 2, got %d", code)
	}
	if !strings.Contains(errs, "--mode requires a value") {
		t.Fatalf("expected the missing-value error, got %q", errs)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("usage errors write nothing, got %d entries", len(entries))
	}

	code, out, _ := captureRun(t, []string{"init", "--dir", dir, "--yes", "--mode", "solo", "--dry-run"})
	if code != 0 {
		t.Fatalf("solo dry-run exit %d", code)
	}
	for _, rel := range []string{"docs/domain/identity.md", "docs/practice/writing-style.md"} {
		planned := false
		for _, line := range strings.Split(out, "\n") {
			if strings.Contains(line, rel) && strings.HasPrefix(strings.TrimSpace(line), "create") {
				planned = true
			}
		}
		if !planned {
			t.Fatalf("dry-run plan should create %s, got:\n%s", rel, out)
		}
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("dry-run writes nothing, got %d entries", len(entries))
	}
}

func TestCLIValidateJSONFailingFixture(t *testing.T) {
	code, out, _ := captureRun(t, []string{"validate", "--root", fixture(t, "invalid-bad-decision"), "--json"})
	if code != 1 {
		t.Fatalf("expected exit 1, got %d", code)
	}
	if !strings.Contains(out, `"command": "validate"`) || !strings.Contains(out, `"errors": 2`) {
		t.Fatalf("unexpected json: %s", out)
	}
}

func TestCLIIndexCheckJSONStale(t *testing.T) {
	code, out, _ := captureRun(t, []string{"index", "--check", "--root", fixture(t, "invalid-stale-index"), "--json"})
	if code != 1 {
		t.Fatalf("expected exit 1, got %d", code)
	}
	if !strings.Contains(out, `"stale": true`) {
		t.Fatalf("expected stale true, got %s", out)
	}
}

// unindexedLine is the generate run's closing nudge. Spec-pinned byte for byte
// and identical in all three SDKs, so it is asserted as an exact string, never a
// pattern; the zero case is asserted as absence.
func unindexedLine(n int) string {
	return fmt.Sprintf("%d file(s) unindexed: add to a category index or leave as reference deliberately", n)
}

// seedLayerAt scaffolds a core layer, the shape the unindexed nudge is measured on.
func seedLayerAt(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if code, _, errs := captureRun(t, []string{"init", "--yes", "--dir", dir, "--name", "demo-context"}); code != 0 {
		t.Fatalf("init: %s", errs)
	}
	return dir
}

func TestCLIIndexReportsUnindexedCount(t *testing.T) {
	dir := seedLayerAt(t)
	// Two markdown files under the governed root that no category index lists.
	if err := os.MkdirAll(filepath.Join(dir, "docs", "notes"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"docs/notes/loose.md", "docs/stray.md"} {
		if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(rel)), []byte("# Loose\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	code, out, _ := captureRun(t, []string{"index", "--root", dir})
	// A nudge, never a gate: the count does not move the exit code.
	if code != 0 {
		t.Fatalf("expected exit 0, got %d", code)
	}
	lines := strings.Split(strings.TrimSuffix(out, "\n"), "\n")
	if last := lines[len(lines)-1]; last != unindexedLine(2) {
		t.Fatalf("last line %q, want %q", last, unindexedLine(2))
	}
}

func TestCLIIndexQuietWhenNothingUnindexed(t *testing.T) {
	dir := seedLayerAt(t)
	code, out, _ := captureRun(t, []string{"index", "--root", dir})
	if code != 0 {
		t.Fatalf("expected exit 0, got %d", code)
	}
	if strings.Contains(out, "unindexed") {
		t.Fatalf("expected no nudge at zero, got %q", out)
	}
	lines := strings.Split(strings.TrimSuffix(out, "\n"), "\n")
	if last := lines[len(lines)-1]; !strings.HasPrefix(last, "ok (") {
		t.Fatalf("last line %q, want the ok summary", last)
	}
}

func TestCLIIndexCheckIgnoresUnindexedCount(t *testing.T) {
	dir := seedLayerAt(t)
	if err := os.WriteFile(filepath.Join(dir, "docs", "stray.md"), []byte("# Stray\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, _, errs := captureRun(t, []string{"index", "--root", dir}); code != 0 {
		t.Fatalf("index: %s", errs)
	}
	code, out, _ := captureRun(t, []string{"index", "--check", "--root", dir})
	if code != 0 {
		t.Fatalf("expected exit 0, got %d", code)
	}
	if strings.Contains(out, "unindexed") {
		t.Fatalf("--check must stay silent, got %q", out)
	}
}

func TestCLIIndexJSONCarriesNoNudge(t *testing.T) {
	dir := seedLayerAt(t)
	if err := os.WriteFile(filepath.Join(dir, "docs", "stray.md"), []byte("# Stray\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, out, _ := captureRun(t, []string{"index", "--root", dir, "--json"})
	if code != 0 {
		t.Fatalf("expected exit 0, got %d", code)
	}
	// One document and nothing after it: the payload must still parse whole.
	var payload map[string]any
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		t.Fatalf("stdout is not one JSON document: %v (%q)", err, out)
	}
	if payload["written"] != "docs/context-index.json" {
		t.Fatalf("unexpected payload: %s", out)
	}
	// The nudge is text-mode only. The count is not part of the index run's
	// contract, so no consumer may start reading it off this document — not at
	// the top level, not tucked into summary or a later extra.
	if hasKeyDeep(payload, "unindexed") {
		t.Fatalf("--json must carry no unindexed field, got: %s", out)
	}
}

// hasKeyDeep reports whether key appears anywhere in the document, at any depth.
// Checking the whole tree rather than the top level alone is what makes the JSON
// assertion hold against a field added later inside summary or a future extra.
func hasKeyDeep(value any, key string) bool {
	switch v := value.(type) {
	case map[string]any:
		if _, ok := v[key]; ok {
			return true
		}
		for _, child := range v {
			if hasKeyDeep(child, key) {
				return true
			}
		}
	case []any:
		for _, child := range v {
			if hasKeyDeep(child, key) {
				return true
			}
		}
	}
	return false
}

func TestCLIIndexNoNudgeWhenIndexWriteFails(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses permission bits")
	}
	dir := seedLayerAt(t)
	if err := os.WriteFile(filepath.Join(dir, "docs", "stray.md"), []byte("# Stray\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, _, errs := captureRun(t, []string{"index", "--root", dir}); code != 0 {
		t.Fatalf("index: %s", errs)
	}
	// The nudge would have something to say here: the count is nonzero, so the
	// silence below is the operational failure's doing and not an empty set.
	_, before, _ := captureRun(t, []string{"status", "--root", dir, "--json"})
	var status struct {
		Unindexed []string `json:"unindexed"`
	}
	if err := json.Unmarshal([]byte(before), &status); err != nil {
		t.Fatalf("status: %v (%q)", err, before)
	}
	if len(status.Unindexed) == 0 {
		t.Fatal("expected a nonzero unindexed count before the failed write")
	}
	target := filepath.Join(dir, "docs", "context-index.json")
	if err := os.Chmod(target, 0o444); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(target, 0o644) // restore so the temp tree can be cleaned up
	code, out, errs := captureRun(t, []string{"index", "--root", dir})
	// An operational failure surfaces its error and nothing else: generation
	// never completed, so the layer has no count worth reporting.
	if code != 2 {
		t.Fatalf("a failed index write should exit 2, got %d", code)
	}
	if !strings.HasPrefix(errs, "leji: ") || !strings.Contains(errs, "context-index.json") ||
		!strings.Contains(strings.ToLower(errs), "permission denied") {
		t.Fatalf("expected the write error on stderr, got %q", errs)
	}
	if strings.Contains(out, "unindexed") {
		t.Fatalf("no nudge on a failed write, got %q", out)
	}
}

func TestCLIValidateValidFixture(t *testing.T) {
	code, _, _ := captureRun(t, []string{"validate", "--root", fixture(t, "valid-minimal-core")})
	if code != 0 {
		t.Fatalf("expected exit 0, got %d", code)
	}
}

func TestCLIChangelogWithoutSubcommandExits2(t *testing.T) {
	code, _, _ := captureRun(t, []string{"changelog"})
	if code != 2 {
		t.Fatalf("expected exit 2, got %d", code)
	}
}

func TestCLIHelpListsAllCommands(t *testing.T) {
	_, out, _ := captureRun(t, []string{"--help"})
	spec, err := schemas.LoadCliSpec()
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range spec.Commands {
		if !strings.Contains(out, c.Name) {
			t.Fatalf("help missing command %q", c.Name)
		}
	}
}

func TestCLIDocumentedCommandsAreKnown(t *testing.T) {
	spec, _ := schemas.LoadCliSpec()
	for _, c := range spec.Commands {
		argv := strings.Split(c.Name, " ")
		dir := t.TempDir()
		full := append(argv, "--root", dir)
		if c.Name == "init" {
			full = append(full, "--yes")
		}
		if c.Name == "changelog compact" {
			full = append(full, "--keep", "1")
		}
		if c.Name == "agent" {
			full = append(full, "--host", "codex", "--name", "reviewer")
		}
		if c.Name == "mounts locate" || c.Name == "mounts update-pin" {
			full = append(full, "some-mount")
		}
		code, _, errs := captureRun(t, full)
		if strings.Contains(errs, "unknown command") {
			t.Fatalf("%q should be known", c.Name)
		}
		if code == 2 {
			t.Fatalf("%q should not be a usage error", c.Name)
		}
	}
}

func TestCLIStartNoManifestExits1(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "no-such-layer")
	code, out, errs := captureRun(t, []string{"start", "--root", dir})
	if code != 1 {
		t.Fatalf("missing manifest should exit 1, got %d (%s%s)", code, out, errs)
	}
	if !strings.Contains(out+errs, "manifest-missing") && !strings.Contains(out+errs, "no leji.json") {
		t.Fatalf("expected manifest-missing finding, got %q / %q", out, errs)
	}
}

func TestCLIStartFallsBackOnCoreLayerNonTTY(t *testing.T) {
	dir := t.TempDir()
	if code, _, errs := captureRun(t, []string{"init", "--dir", dir, "--yes", "--name", "demo"}); code != 0 {
		t.Fatalf("init failed: %d %s", code, errs)
	}
	// Under `go test` stdin is not a TTY, so interactive=false: never launch,
	// never hang; print the boot commands and exit 0.
	code, out, errs := captureRun(t, []string{"start", "--root", dir})
	if code != 0 {
		t.Fatalf("start on a core layer should exit 0, got %d (%s%s)", code, out, errs)
	}
	if !strings.Contains(out, "To enter this context layer") {
		t.Fatalf("expected boot commands, got %q", out)
	}
}

// Mirrors run.test.ts "ci: writes the workflow when absent, is idempotent, and
// exits 1 with no manifest".
func TestCLICiWritesIdempotentAndNoManifest(t *testing.T) {
	dir := t.TempDir()
	if code, _, errs := captureRun(t, []string{"init", "--dir", dir, "--yes", "--name", "demo"}); code != 0 {
		t.Fatalf("init failed: %d %s", code, errs)
	}
	wf := filepath.Join(dir, ".github", "workflows", "leji.yml")
	if _, err := os.Stat(wf); err == nil {
		t.Fatalf("core init should write no CI workflow")
	}

	code, out, errs := captureRun(t, []string{"ci", "--root", dir})
	if code != 0 {
		t.Fatalf("ci should exit 0, got %d (%s%s)", code, out, errs)
	}
	if !strings.Contains(out, "Wrote") || !strings.Contains(out, "leji.yml") {
		t.Fatalf("expected Wrote .../leji.yml, got %q", out)
	}
	before, err := os.ReadFile(wf)
	if err != nil {
		t.Fatalf("workflow not written: %v", err)
	}

	code, out, errs = captureRun(t, []string{"ci", "--root", dir, "--json"})
	if code != 0 {
		t.Fatalf("ci --json should exit 0, got %d (%s%s)", code, out, errs)
	}
	var payload struct {
		Created bool `json:"created"`
	}
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		t.Fatalf("ci --json output not JSON: %v (%q)", err, out)
	}
	if payload.Created {
		t.Fatalf("idempotent: workflow should not be re-created")
	}
	after, _ := os.ReadFile(wf)
	if string(after) != string(before) {
		t.Fatalf("existing workflow should be left untouched")
	}

	missing := filepath.Join(t.TempDir(), "no-such-layer")
	code, out, errs = captureRun(t, []string{"ci", "--root", missing})
	if code != 1 {
		t.Fatalf("missing manifest should exit 1, got %d (%s%s)", code, out, errs)
	}
	if !strings.Contains(out+errs, "manifest-missing") && !strings.Contains(out+errs, "no leji.json") {
		t.Fatalf("expected manifest-missing finding, got %q / %q", out, errs)
	}
}

// `stage: .pre` is deliberate: without an explicit stage GitLab assigns `test`, and a
// pipeline whose own `stages:` list omits it rejects the whole configuration.
const gitlabBlock = "# >>> leji ci (managed) >>>\n" +
	"leji-validate:\n" +
	"  stage: .pre\n" +
	"  image: node:22\n" +
	"  script:\n" +
	"    - npx -y @leji-org/leji@1 validate\n" +
	"    - npx -y @leji-org/leji@1 index --check\n" +
	"# <<< leji ci (managed) <<<\n"

func seededCiDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if code, _, errs := captureRun(t, []string{"init", "--dir", dir, "--yes", "--name", "demo"}); code != 0 {
		t.Fatalf("init failed: %d %s", code, errs)
	}
	return dir
}

// Mirrors run.test.ts "ci --provider github: explicit github matches the
// default, JSON carries provider/action/created".
func TestCLICiProviderGithub(t *testing.T) {
	dir := seededCiDir(t)
	code, out, errs := captureRun(t, []string{"ci", "--root", dir, "--provider", "github", "--json"})
	if code != 0 {
		t.Fatalf("ci github exit %d (%s%s)", code, out, errs)
	}
	var j struct {
		Provider string `json:"provider"`
		Action   string `json:"action"`
		Created  bool   `json:"created"`
		Workflow string `json:"workflow"`
	}
	if err := json.Unmarshal([]byte(out), &j); err != nil {
		t.Fatalf("not JSON: %v (%q)", err, out)
	}
	if j.Provider != "github" || j.Action != "created" || !j.Created || j.Workflow != ".github/workflows/leji.yml" {
		t.Fatalf("unexpected JSON: %+v", j)
	}
	if _, err := os.Stat(filepath.Join(dir, ".github", "workflows", "leji.yml")); err != nil {
		t.Fatalf("workflow not written: %v", err)
	}
}

// Mirrors run.test.ts "ci --provider gitlab: creates the managed block, is idempotent".
func TestCLICiProviderGitlabCreate(t *testing.T) {
	dir := seededCiDir(t)
	gl := filepath.Join(dir, ".gitlab-ci.yml")
	code, out, errs := captureRun(t, []string{"ci", "--root", dir, "--provider", "gitlab", "--json"})
	if code != 0 {
		t.Fatalf("ci gitlab exit %d (%s%s)", code, out, errs)
	}
	var j struct {
		Provider string `json:"provider"`
		Action   string `json:"action"`
	}
	if err := json.Unmarshal([]byte(out), &j); err != nil {
		t.Fatalf("not JSON: %v (%q)", err, out)
	}
	if j.Provider != "gitlab" || j.Action != "created" {
		t.Fatalf("unexpected JSON: %+v", j)
	}
	b, _ := os.ReadFile(gl)
	if string(b) != gitlabBlock {
		t.Fatalf("new file is not exactly the managed block: %q", string(b))
	}
	code, out, _ = captureRun(t, []string{"ci", "--root", dir, "--provider", "gitlab", "--json"})
	var j2 struct {
		Action string `json:"action"`
	}
	_ = json.Unmarshal([]byte(out), &j2)
	if j2.Action != "unchanged" {
		t.Fatalf("idempotent re-run should be unchanged, got %q", j2.Action)
	}
	b2, _ := os.ReadFile(gl)
	if string(b2) != gitlabBlock {
		t.Fatalf("idempotent byte-for-byte failed: %q", string(b2))
	}
}

// Mirrors run.test.ts "ci --provider gitlab: appends to an existing config,
// byte-exactly, for every trailing-newline case".
func TestCLICiProviderGitlabMerge(t *testing.T) {
	cases := []struct {
		label, base, expected string
	}{
		{"trailing newline", "stages:\n  - test\n", "stages:\n  - test\n" + "\n" + gitlabBlock},
		{"no trailing newline", "stages:\n  - test", "stages:\n  - test" + "\n\n" + gitlabBlock},
		{"empty file", "", gitlabBlock},
	}
	for _, c := range cases {
		dir := seededCiDir(t)
		gl := filepath.Join(dir, ".gitlab-ci.yml")
		os.WriteFile(gl, []byte(c.base), 0o644)
		code, out, errs := captureRun(t, []string{"ci", "--root", dir, "--provider", "gitlab"})
		if code != 0 {
			t.Fatalf("%s: exit %d (%s%s)", c.label, code, out, errs)
		}
		b, _ := os.ReadFile(gl)
		if string(b) != c.expected {
			t.Fatalf("%s: byte-exact merge failed: %q", c.label, string(b))
		}
		code, out, _ = captureRun(t, []string{"ci", "--root", dir, "--provider", "gitlab", "--json"})
		var j struct {
			Action string `json:"action"`
		}
		_ = json.Unmarshal([]byte(out), &j)
		if j.Action != "unchanged" {
			t.Fatalf("%s: idempotent re-run should be unchanged, got %q", c.label, j.Action)
		}
	}
}

// Mirrors run.test.ts "ci --provider gitlab: replaces a stale managed block,
// preserving surrounding content".
func TestCLICiProviderGitlabReplaceStale(t *testing.T) {
	dir := seededCiDir(t)
	gl := filepath.Join(dir, ".gitlab-ci.yml")
	stale := "# >>> leji ci (managed) >>>\nleji-validate:\n  image: node:18\n# <<< leji ci (managed) <<<\n"
	os.WriteFile(gl, []byte("before:\n  keep: 1\n\n"+stale+"\nafter:\n  keep: 2\n"), 0o644)
	code, out, errs := captureRun(t, []string{"ci", "--root", dir, "--provider", "gitlab"})
	if code != 0 {
		t.Fatalf("exit %d (%s%s)", code, out, errs)
	}
	b, _ := os.ReadFile(gl)
	want := "before:\n  keep: 1\n\n" + gitlabBlock + "\nafter:\n  keep: 2\n"
	if string(b) != want {
		t.Fatalf("stale-replace failed: %q", string(b))
	}
	if strings.Contains(string(b), "node:18") {
		t.Fatalf("stale block not replaced")
	}
}

// Mirrors run.test.ts "ci --provider circleci: creates when absent, prints a
// snippet (no edit) when present".
func TestCLICiProviderCircleci(t *testing.T) {
	dir := seededCiDir(t)
	cc := filepath.Join(dir, ".circleci", "config.yml")
	code, out, errs := captureRun(t, []string{"ci", "--root", dir, "--provider", "circleci", "--json"})
	if code != 0 {
		t.Fatalf("ci circleci exit %d (%s%s)", code, out, errs)
	}
	var j struct {
		Action string `json:"action"`
	}
	_ = json.Unmarshal([]byte(out), &j)
	if j.Action != "created" {
		t.Fatalf("expected created, got %q", j.Action)
	}
	before, err := os.ReadFile(cc)
	if err != nil {
		t.Fatalf("config not written: %v", err)
	}
	if string(before) != ciGolden(t, "circleci-node-fallback.yml") {
		t.Fatalf("created config not byte-exact:\n%s", before)
	}
	// A file leji generated is leji's to keep current: the re-run recognizes its own
	// bytes and reports unchanged rather than handing back a snippet for a file the
	// user never wrote.
	code, out, _ = captureRun(t, []string{"ci", "--root", dir, "--provider", "circleci", "--json"})
	if code != 0 {
		t.Fatalf("ci circleci (again) exit %d", code)
	}
	var j2 struct {
		Action  string `json:"action"`
		Created bool   `json:"created"`
		Snippet string `json:"snippet"`
	}
	if err := json.Unmarshal([]byte(out), &j2); err != nil {
		t.Fatalf("not JSON: %v (%q)", err, out)
	}
	if j2.Action != "unchanged" || j2.Created {
		t.Fatalf("expected unchanged/created=false, got %+v", j2)
	}
	after, _ := os.ReadFile(cc)
	if string(after) != string(before) {
		t.Fatalf("idempotent byte-for-byte")
	}

	// Someone else's config: never modified, and the snippet comes back to add by hand.
	foreign := seededCiDir(t)
	fcc := filepath.Join(foreign, ".circleci", "config.yml")
	if err := os.MkdirAll(filepath.Dir(fcc), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fcc, []byte("version: 2.1\njobs:\n  mine: {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, out, _ = captureRun(t, []string{"ci", "--root", foreign, "--provider", "circleci", "--json"})
	if code != 0 {
		t.Fatalf("ci circleci (foreign) exit %d", code)
	}
	var j3 struct {
		Action  string `json:"action"`
		Snippet string `json:"snippet"`
	}
	if err := json.Unmarshal([]byte(out), &j3); err != nil {
		t.Fatalf("not JSON: %v (%q)", err, out)
	}
	if j3.Action != "manual" {
		t.Fatalf("a foreign config is manual, got %+v", j3)
	}
	// The hand-add snippet is the generated config without its two leading lines
	// (the ownership marker and `version: 2.1`): it is pasted into a file leji does
	// not own, so it claims nothing.
	configLines := strings.Split(ciGolden(t, "circleci-node-fallback.yml"), "\n")
	if want := strings.Join(configLines[2:], "\n"); j3.Snippet != want {
		t.Fatalf("manual snippet not byte-exact:\n%q\nwant\n%q", j3.Snippet, want)
	}
	if body, _ := os.ReadFile(fcc); string(body) != "version: 2.1\njobs:\n  mine: {}\n" {
		t.Fatalf("foreign config left untouched")
	}
}

// Mirrors run.test.ts "ci --provider azure: dedicated pipeline file + activation
// note (JSON and human), idempotent, byte-exact".
func TestCLICiProviderAzure(t *testing.T) {
	d1 := seededCiDir(t)
	az := filepath.Join(d1, ".azure-pipelines", "leji.yml")
	code, out, errs := captureRun(t, []string{"ci", "--root", d1, "--provider", "azure", "--json"})
	if code != 0 {
		t.Fatalf("ci azure exit %d (%s%s)", code, out, errs)
	}
	var j struct {
		Provider string `json:"provider"`
		Action   string `json:"action"`
		Created  bool   `json:"created"`
		Workflow string `json:"workflow"`
		Note     string `json:"note"`
	}
	if err := json.Unmarshal([]byte(out), &j); err != nil {
		t.Fatalf("not JSON: %v (%q)", err, out)
	}
	if j.Provider != "azure" || j.Action != "created" || !j.Created {
		t.Fatalf("expected azure/created, got %+v", j)
	}
	if j.Workflow != ".azure-pipelines/leji.yml" {
		t.Fatalf("unexpected workflow: %q", j.Workflow)
	}
	if !strings.Contains(j.Note, "Azure Pipelines does not auto-run") {
		t.Fatalf("unexpected note: %q", j.Note)
	}
	got, err := os.ReadFile(az)
	if err != nil {
		t.Fatalf("pipeline not written: %v", err)
	}
	if string(got) != ciGolden(t, "azure-node-fallback.yml") {
		t.Fatalf("pipeline file not byte-exact:\n%s", got)
	}
	code, out, _ = captureRun(t, []string{"ci", "--root", d1, "--provider", "azure", "--json"})
	if code != 0 {
		t.Fatalf("ci azure (again) exit %d", code)
	}
	var j2 struct {
		Action string `json:"action"`
	}
	_ = json.Unmarshal([]byte(out), &j2)
	if j2.Action != "unchanged" {
		t.Fatalf("expected unchanged, got %q", j2.Action)
	}
	// a fresh create prints the activation note in human output
	d2 := seededCiDir(t)
	code, out, _ = captureRun(t, []string{"ci", "--root", d2, "--provider", "azure"})
	if code != 0 {
		t.Fatalf("ci azure (human) exit %d", code)
	}
	if !strings.Contains(out, "Wrote") || !strings.Contains(out, ".azure-pipelines/leji.yml") {
		t.Fatalf("expected Wrote line, got %q", out)
	}
	if !strings.Contains(out, "Azure Pipelines does not auto-run this file") {
		t.Fatalf("expected activation note in human output, got %q", out)
	}
}

// Mirrors run.test.ts "ci --provider: invalid value and missing value both fail
// with usage exit 2".
func TestCLICiProviderInvalidAndMissing(t *testing.T) {
	dir := seededCiDir(t)
	code, _, errs := captureRun(t, []string{"ci", "--root", dir, "--provider", "bogus"})
	if code != 2 {
		t.Fatalf("invalid provider should exit 2, got %d", code)
	}
	if !strings.Contains(errs, `unknown provider "bogus"; expected github, gitlab, circleci, or azure`) {
		t.Fatalf("unexpected stderr: %q", errs)
	}
	code, _, errs = captureRun(t, []string{"ci", "--root", dir, "--provider"})
	if code != 2 {
		t.Fatalf("missing provider value should exit 2, got %d", code)
	}
	if !strings.Contains(errs, "--provider requires a value") {
		t.Fatalf("unexpected stderr: %q", errs)
	}
}

// Mirrors run.test.ts "ci: refuses to write through a symlink that escapes the root".
func TestCLICiSymlinkRefused(t *testing.T) {
	// GitLab guards before it reads/rewrites, so a symlinked target file pointing
	// outside the root is refused outright (no read, no write).
	dir := seededCiDir(t)
	os.Symlink("/etc/hosts", filepath.Join(dir, ".gitlab-ci.yml"))
	code, _, errs := captureRun(t, []string{"ci", "--root", dir, "--provider", "gitlab"})
	if code != 2 {
		t.Fatalf("gitlab symlink should exit 2, got %d", code)
	}
	if !strings.Contains(errs, "refusing to write through a symlink that escapes the target") {
		t.Fatalf("unexpected stderr: %q", errs)
	}
	// Every provider guards before touching the target, so a final-file symlink that
	// escapes the root is refused outright (no read, no write) even when it exists.
	for _, tc := range []struct{ provider, targetRel string }{
		{"github", ".github/workflows/leji.yml"},
		{"circleci", ".circleci/config.yml"},
		{"azure", ".azure-pipelines/leji.yml"},
	} {
		dir := seededCiDir(t)
		target := filepath.Join(dir, tc.targetRel)
		os.MkdirAll(filepath.Dir(target), 0o755)
		os.Symlink("/etc/hosts", target)
		code, _, errs := captureRun(t, []string{"ci", "--root", dir, "--provider", tc.provider})
		if code != 2 {
			t.Fatalf("%s: escaping target symlink should exit 2, got %d", tc.provider, code)
		}
		if !strings.Contains(errs, "refusing to write through a symlink that escapes the target") {
			t.Fatalf("%s: unexpected stderr: %q", tc.provider, errs)
		}
	}
	// A symlinked PARENT directory that escapes the root is likewise caught before
	// any write happens.
	for _, tc := range []struct{ provider, parentRel string }{
		{"github", ".github/workflows"},
		{"circleci", ".circleci"},
		{"azure", ".azure-pipelines"},
	} {
		dir := seededCiDir(t)
		parent := filepath.Join(dir, tc.parentRel)
		os.MkdirAll(filepath.Dir(parent), 0o755)
		os.Symlink("/etc", parent)
		code, _, errs := captureRun(t, []string{"ci", "--root", dir, "--provider", tc.provider})
		if code != 2 {
			t.Fatalf("%s: escaping parent dir should exit 2, got %d", tc.provider, code)
		}
		if !strings.Contains(errs, "refusing to write through a symlink that escapes the target") {
			t.Fatalf("%s: unexpected stderr: %q", tc.provider, errs)
		}
	}
	// The atomic-write sibling temp path (<target>.leji-tmp) must also be guarded.
	for _, tc := range []struct{ provider, targetRel string }{
		{"github", ".github/workflows/leji.yml"},
		{"gitlab", ".gitlab-ci.yml"},
		{"circleci", ".circleci/config.yml"},
		{"azure", ".azure-pipelines/leji.yml"},
	} {
		dir := seededCiDir(t)
		tmp := filepath.Join(dir, tc.targetRel+".leji-tmp")
		os.MkdirAll(filepath.Dir(tmp), 0o755)
		os.Symlink("/etc/hosts", tmp)
		code, _, errs := captureRun(t, []string{"ci", "--root", dir, "--provider", tc.provider})
		if code != 2 {
			t.Fatalf("%s: escaping temp symlink should exit 2, got %d", tc.provider, code)
		}
		if !strings.Contains(errs, "refusing to write through a symlink that escapes the target") {
			t.Fatalf("%s: unexpected stderr: %q", tc.provider, errs)
		}
	}
}

// Mirrors run.test.ts "ci: an unwritable target dir yields a normalized error".
func TestCLICiUnwritableTarget(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses permission bits")
	}
	dir := seededCiDir(t)
	wf := filepath.Join(dir, ".github", "workflows")
	if err := os.MkdirAll(wf, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(wf, 0o555); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(wf, 0o755) // restore so the temp tree can be cleaned up
	code, _, errs := captureRun(t, []string{"ci", "--root", dir, "--provider", "github"})
	if code != 2 {
		t.Fatalf("unwritable target should exit 2, got %d", code)
	}
	if !strings.Contains(errs, `cannot write ".github/workflows/leji.yml": permission denied`) {
		t.Fatalf("unexpected stderr: %q", errs)
	}
}

// Mirrors run.test.ts "ci: a write failure after the temp file cleans up".
func TestCLICiWriteFailureCleansUp(t *testing.T) {
	t.Setenv("LEJI_TEST_FAIL_RENAME", "1")
	dir := seededCiDir(t)
	code, _, errs := captureRun(t, []string{"ci", "--root", dir, "--provider", "github"})
	if code != 2 {
		t.Fatalf("injected write failure should exit 2, got %d", code)
	}
	if !strings.Contains(errs, `cannot write ".github/workflows/leji.yml"`) || strings.Contains(errs, "permission denied") {
		t.Fatalf("expected generic write error, got %q", errs)
	}
	if _, err := os.Stat(filepath.Join(dir, ".github", "workflows", "leji.yml")); !os.IsNotExist(err) {
		t.Fatalf("target should not exist after a failed write")
	}
	if _, err := os.Stat(filepath.Join(dir, ".github", "workflows", "leji.yml.leji-tmp")); !os.IsNotExist(err) {
		t.Fatalf("temp file should be cleaned up")
	}
}

// Mirrors run.test.ts "agent: writing the default binding prints the
// selects-vs-loads guidance (human and JSON); other keys and re-runs do not".
func TestCLIAgentDefaultGuidance(t *testing.T) {
	dir := seededCiDir(t)
	// human output: the guidance follows the success lines, byte-exact
	code, out, errs := captureRun(t, []string{"agent", "--name", "default", "--root", dir})
	if code != 0 {
		t.Fatalf("agent default exit %d (%s%s)", code, out, errs)
	}
	if !strings.Contains(out, `Bound agent "default"`) {
		t.Fatalf("expected the bound line, got %q", out)
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if last := lines[len(lines)-1]; last != initcmd.AgentsDefaultNote {
		t.Fatalf("last line is not the guidance: %q", last)
	}
	// written-only: a re-run binds nothing and stays terse, in both modes
	code, out, _ = captureRun(t, []string{"agent", "--name", "default", "--root", dir})
	if code != 0 || strings.Contains(out, "selects a role profile") {
		t.Fatalf("no guidance when nothing was bound: %d %q", code, out)
	}
	if _, j, _ := runJSON(t, []string{"agent", "--name", "default", "--json", "--root", dir}); j["note"] != nil {
		t.Fatalf("re-run JSON should carry no note: %v", j["note"])
	}
	// JSON mode carries the same sentence in `note` (the CI activation-note pattern)
	code, j, errs := runJSON(t, []string{"agent", "--name", "default", "--json", "--root", seededCiDir(t)})
	if code != 0 {
		t.Fatalf("agent default --json exit %d (%s)", code, errs)
	}
	if j["note"] != initcmd.AgentsDefaultNote {
		t.Fatalf("JSON note not byte-exact: %v", j["note"])
	}
	// any other binding stays quiet, in both modes
	code, out, _ = captureRun(t, []string{"agent", "--name", "reviewer", "--root", dir})
	if code != 0 || strings.Contains(out, "selects a role profile") {
		t.Fatalf("no guidance for a non-default key: %d %q", code, out)
	}
	code, j2, _ := runJSON(t, []string{"agent", "--name", "thought-partner", "--json", "--root", dir})
	if code != 0 || j2["note"] != nil {
		t.Fatalf("non-default key JSON should carry no note: %d %v", code, j2["note"])
	}
}
