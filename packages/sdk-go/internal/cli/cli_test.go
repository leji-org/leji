package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	initcmd "github.com/leji-org/leji/packages/sdk-go/internal/commands/init"
	"github.com/leji-org/leji/packages/sdk-go/internal/schemas"
)

func repoRoot(t *testing.T) string {
	t.Helper()
	wd, _ := os.Getwd()
	return filepath.Join(wd, "..", "..", "..", "..")
}

func fixture(t *testing.T, name string) string {
	return filepath.Join(repoRoot(t), "fixtures", name)
}

// captureRun runs the CLI capturing stdout/stderr by swapping os.Stdout/Stderr.
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
	// --version and lowercase -v print the version and exit 0.
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
	// the layer root (the H1 fix). Point machine.indexPath under docs/evil, a
	// symlink to an outside dir, and assert the escape is reported, exit 1, and
	// nothing lands outside the root.
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

const gitlabBlock = "# >>> leji ci (managed) >>>\n" +
	"leji-validate:\n" +
	"  image: node:22\n" +
	"  script:\n" +
	"    - npx -y @leji-org/leji@latest validate\n" +
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
	if string(before) != initcmd.BuildCircleCiConfig() {
		t.Fatalf("created config not byte-exact:\n%s", before)
	}
	code, out, _ = captureRun(t, []string{"ci", "--root", dir, "--provider", "circleci", "--json"})
	if code != 0 {
		t.Fatalf("ci circleci (manual) exit %d", code)
	}
	var j2 struct {
		Action  string `json:"action"`
		Created bool   `json:"created"`
		Snippet string `json:"snippet"`
	}
	if err := json.Unmarshal([]byte(out), &j2); err != nil {
		t.Fatalf("not JSON: %v (%q)", err, out)
	}
	if j2.Action != "manual" || j2.Created {
		t.Fatalf("expected manual/created=false, got %+v", j2)
	}
	if j2.Snippet != initcmd.BuildCircleCiSnippet() {
		t.Fatalf("manual snippet not byte-exact: %q", j2.Snippet)
	}
	after, _ := os.ReadFile(cc)
	if string(after) != string(before) {
		t.Fatalf("existing config should be left untouched")
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
	if string(got) != initcmd.BuildAzurePipeline() {
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
