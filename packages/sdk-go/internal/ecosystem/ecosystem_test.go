package ecosystem_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/ecosystem"
)

func repoRoot(t *testing.T) string {
	t.Helper()
	wd, _ := os.Getwd()
	return filepath.Join(wd, "..", "..", "..", "..")
}

func casesDir(t *testing.T) string {
	t.Helper()
	return filepath.Join(repoRoot(t), "fixtures", "ecosystem")
}

// serialize is the one committed formatting of an ecosystem expected.json: the
// report under an `ecosystem` key, two-space indent, one trailing newline.
// Comparing the BYTES is what pins key order, which a deep comparison cannot see
// and which the --json surface makes a public contract.
func serialize(t *testing.T, report ecosystem.Report) string {
	t.Helper()
	wrapper := struct {
		Ecosystem ecosystem.Report `json:"ecosystem"`
	}{Ecosystem: report}
	out, err := ecosystem.MarshalJSONIndent(wrapper, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(out) + "\n"
}

func caseNames(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(casesDir(t))
	if err != nil {
		t.Fatalf("fixtures/ecosystem: %v", err)
	}
	names := []string{}
	for _, e := range entries {
		if e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	return names
}

func TestEcosystemFixtures(t *testing.T) {
	names := caseNames(t)
	if len(names) < 111 {
		t.Fatalf("expected the full ecosystem fixture family, found %d", len(names))
	}
	for _, name := range names {
		dir := filepath.Join(casesDir(t), name)
		expected, err := os.ReadFile(filepath.Join(dir, "expected.json"))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		report := ecosystem.Detect(dir)
		got := serialize(t, report)
		if got != string(expected) {
			t.Errorf("%s: bytes differ\n--- want ---\n%s\n--- got ---\n%s", name, expected, got)
			continue
		}
		// Deep equality too, so a divergence names the field rather than a byte offset.
		var wantAny, gotAny any
		if err := json.Unmarshal(expected, &wantAny); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if err := json.Unmarshal([]byte(got), &gotAny); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !reflect.DeepEqual(wantAny, gotAny) {
			t.Errorf("%s: report differs", name)
		}
	}
}

// The scanner families, transcribed from the TypeScript contract test: every
// inspected field carries both verdicts as shared cases, and this port reads the
// same verdicts off the same fixtures.
func TestScannerFamiliesBothVerdicts(t *testing.T) {
	declared := func(name string) bool {
		report := ecosystem.Detect(filepath.Join(casesDir(t), name))
		if report.Selected == nil {
			t.Fatalf("%s: a scanner case always selects one manager", name)
		}
		return report.Selected.DirectDeclared
	}
	positives := []string{
		"scan-project-deps-inline", "scan-project-deps-multiline", "scan-project-deps-specifier",
		"scan-project-deps-spaced-header", "scan-project-deps-single-quoted",
		"scan-optional-deps-declared", "scan-dependency-groups-declared",
		"scan-tool-uv-dev-declared", "scan-tool-uv-dev-marker",
		"scan-poetry-deps-key", "scan-poetry-deps-quoted-key",
		"scan-poetry-dev-deps-key", "scan-poetry-dev-deps-quoted-key",
		"scan-poetry-group-key", "scan-poetry-group-inline-table",
		"scan-pdm-dev-array", "scan-pdm-dev-key",
		"scan-pipfile-packages", "scan-pipfile-packages-quoted-key",
		"scan-pipfile-dev-packages", "scan-pipfile-dev-packages-bare-key",
		"scan-requirements-declared", "scan-requirements-bare", "scan-requirements-extras",
		"scan-plain-quoted-element", "scan-go-2.0",
	}
	negatives := []string{
		"scan-project-deps-absent", "scan-project-deps-prefix-only", "scan-project-deps-comment",
		"scan-optional-deps-absent", "scan-optional-deps-comment",
		"scan-dependency-groups-absent", "scan-dependency-groups-comment", "scan-dependency-groups-triple-quoted",
		"scan-tool-uv-dev-absent", "scan-tool-uv-dev-comment", "scan-tool-uv-other-field",
		"scan-poetry-deps-absent", "scan-poetry-deps-comment",
		"scan-poetry-dev-deps-absent", "scan-poetry-dev-deps-comment",
		"scan-poetry-group-absent", "scan-poetry-group-comment",
		"scan-pdm-dev-absent", "scan-pdm-dev-comment",
		"scan-pipfile-packages-absent", "scan-pipfile-packages-comment",
		"scan-pipfile-dev-packages-absent", "scan-pipfile-dev-packages-comment",
		"scan-requirements-indented", "scan-requirements-comment",
		"scan-requirements-prefix-only", "scan-requirements-include-line",
		"scan-triple-quoted-element", "scan-triple-quoted-element-literal",
		"scan-multiline-basic-string", "scan-multiline-literal-string", "scan-multiline-string-hides-table",
		"scan-project-description", "scan-project-keywords", "scan-project-classifiers",
		"scan-project-nested-array", "scan-unrelated-table-key",
		"scan-poetry-scripts-key", "scan-pipfile-scripts",
		"scan-go-closed-block", "scan-go-comment", "scan-go-1.9", "scan-go-1.25",
	}
	for _, name := range positives {
		if !declared(name) {
			t.Errorf("%s must declare", name)
		}
	}
	for _, name := range negatives {
		if declared(name) {
			t.Errorf("%s must not declare", name)
		}
	}
	// The families must cover every shared scan case on disk, exactly as the
	// TypeScript partition test asserts: a case this port does not read is a case
	// it can diverge on.
	claimed := map[string]bool{}
	for _, n := range append(append([]string{}, positives...), negatives...) {
		claimed[n] = true
	}
	for _, name := range caseNames(t) {
		if strings.HasPrefix(name, "scan-") && !claimed[name] {
			t.Errorf("shared scanner case %s is not read by this port", name)
		}
	}
}

// The go directive threshold, pinned by shared cases on both sides of 1.24.
func TestGoDirectiveThreshold(t *testing.T) {
	manager := func(name string) string {
		report := ecosystem.Detect(filepath.Join(casesDir(t), name))
		if report.Selected == nil || report.Selected.Manager == nil {
			t.Fatalf("%s: expected a selected manager", name)
		}
		return *report.Selected.Manager
	}
	for name, want := range map[string]string{
		"scan-go-1.9": "go-legacy", "go-1.23-legacy": "go-legacy", "go-no-directive": "go-legacy",
		"go-1.24": "go", "scan-go-1.25": "go", "scan-go-2.0": "go",
	} {
		if got := manager(name); got != want {
			t.Errorf("%s: manager %q, want %q", name, got, want)
		}
	}
}

func plant(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for rel, body := range files {
		if err := os.WriteFile(filepath.Join(dir, rel), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// The packageManager grammar, mirrored from the TypeScript contract test: a
// recognized name wins whatever the lockfiles say, and a value that does not parse
// never falls through to one.
func TestPackageManagerGrammar(t *testing.T) {
	pm := func(value string, extra map[string]string) ecosystem.Report {
		files := map[string]string{"package.json": `{"packageManager":` + quote(value) + `}`}
		for k, v := range extra {
			files[k] = v
		}
		return ecosystem.Detect(plant(t, files))
	}
	for value, want := range map[string]string{
		"pnpm@9.12.0": "pnpm", "bun@1.1.30+e1f2a3b4c5": "bun", "yarn@4.1.0-rc.1": "yarn", "npm": "npm",
	} {
		r := pm(value, nil)
		if r.Selected == nil || r.Selected.Manager == nil || *r.Selected.Manager != want {
			t.Errorf("packageManager %q: want %q", value, want)
		}
	}
	if r := pm("pnpm@9.12.0", map[string]string{"yarn.lock": ""}); r.Selected == nil || *r.Selected.Manager != "pnpm" {
		t.Error("packageManager wins over a lockfile")
	}
	for _, bad := range []string{"pnpm@@9", "pnpm@", "@9.12.0", "Pnpm@9.12.0", "pnpm 9.12.0", "", "hermit@1.0.0"} {
		r := pm(bad, map[string]string{"package-lock.json": ""})
		if r.Reason == nil || *r.Reason != "unsupported-manager" {
			t.Errorf("packageManager %q: want unsupported-manager", bad)
		}
		if r.All[0].Source == nil || *r.All[0].Source != "packageManager" || len(r.All[0].Candidates) != 0 || r.All[0].Add != nil {
			t.Errorf("packageManager %q: no fall-through, no candidates, no add", bad)
		}
	}
	// A non-string value is a present value that does not parse.
	numeric := ecosystem.Detect(plant(t, map[string]string{"package.json": `{"packageManager":9}`}))
	if numeric.Reason == nil || *numeric.Reason != "unsupported-manager" {
		t.Error("a non-string packageManager is unsupported")
	}
}

func quote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// The eligibility gate: a symlinked, dangling or non-regular manifest is refused,
// never read, and an unreadable one consults neither locks nor defaults.
func TestEvidenceEligibility(t *testing.T) {
	outside := plant(t, map[string]string{"package.json": `{"dependencies":{"@leji-org/leji":"1"}}`})

	linked := t.TempDir()
	if err := os.Symlink(filepath.Join(outside, "package.json"), filepath.Join(linked, "package.json")); err != nil {
		t.Fatal(err)
	}
	r := ecosystem.Detect(linked)
	if r.Reason == nil || *r.Reason != "refused-evidence" {
		t.Fatal("a symlinked manifest is refused")
	}
	if !reflect.DeepEqual(r.All[0].Evidence, []string{"package.json"}) || r.All[0].DirectDeclared {
		t.Error("a refused manifest is never read for a declaration")
	}

	dangling := t.TempDir()
	if err := os.Symlink(filepath.Join(dangling, "gone.json"), filepath.Join(dangling, "package.json")); err != nil {
		t.Fatal(err)
	}
	if rr := ecosystem.Detect(dangling); rr.Reason == nil || *rr.Reason != "refused-evidence" {
		t.Error("a dangling manifest is refused")
	}

	dirLock := plant(t, map[string]string{"package.json": "{}"})
	if err := os.Mkdir(filepath.Join(dirLock, "pnpm-lock.yaml"), 0o755); err != nil {
		t.Fatal(err)
	}
	asDir := ecosystem.Detect(dirLock)
	if asDir.Reason == nil || *asDir.Reason != "refused-evidence" ||
		!reflect.DeepEqual(asDir.All[0].Evidence, []string{"pnpm-lock.yaml"}) {
		t.Error("a directory standing where a lockfile belongs is refused")
	}

	inside := plant(t, map[string]string{"package.json": "{}", "other.json": "{}"})
	if err := os.Symlink("./other.json", filepath.Join(inside, "pnpm-lock.yaml")); err != nil {
		t.Fatal(err)
	}
	if ir := ecosystem.Detect(inside); ir.Reason == nil || *ir.Reason != "refused-evidence" {
		t.Error("a symlink that stays inside the root is still not a regular file")
	}

	broken := plant(t, map[string]string{"package.json": `{ "name": `, "package-lock.json": ""})
	br := ecosystem.Detect(broken)
	if br.Reason == nil || *br.Reason != "unreadable-manifest" ||
		br.All[0].Manager != nil || len(br.All[0].Evidence) != 0 || br.All[0].Add != nil {
		t.Error("an unreadable manifest consults neither locks nor defaults")
	}
	if ar := ecosystem.Detect(plant(t, map[string]string{"package.json": "[]"})); ar.Reason == nil || *ar.Reason != "unreadable-manifest" {
		t.Error("valid JSON that is not an object cannot carry a field")
	}
	bom := plant(t, map[string]string{"package.json": "\ufeff{ \"packageManager\": \"yarn@4.1.0\" }"})
	if bm := ecosystem.Detect(bom); bm.Selected == nil || *bm.Selected.Manager != "yarn" {
		t.Error("one BOM is stripped before the strict parse")
	}

	// No walk-up: a parent manifest never answers for the root.
	parent := plant(t, map[string]string{"package.json": "{}", "package-lock.json": ""})
	child := filepath.Join(parent, "child")
	if err := os.Mkdir(child, 0o755); err != nil {
		t.Fatal(err)
	}
	cr := ecosystem.Detect(child)
	if cr.Selected != nil || len(cr.All) != 0 || cr.Reason == nil || *cr.Reason != "none" {
		t.Error("detection never walks up out of the root")
	}
}

// The runner a hook or CI job takes, and the printed block and line, against the
// shared cases.
func TestRunnerBlockAndLine(t *testing.T) {
	report := func(name string) ecosystem.Report { return ecosystem.Detect(filepath.Join(casesDir(t), name)) }
	for name, want := range map[string][]string{
		"node-declared":                    {"npx", "--no-install", "@leji-org/leji"},
		"node-pnpm-lock":                   {"leji"},
		"go-declared-block":                {"go", "tool", "leji"},
		"python-declared-pyproject-groups": {"uv", "run", "leji"},
		"none":                             {"leji"},
		"node-two-lockfiles":               {"leji"},
	} {
		if got := ecosystem.RunnerArgv(report(name)); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: runner %v, want %v", name, got, want)
		}
	}

	if got := ecosystem.RenderBlock(report("node-pnpm-lock")); got !=
		"Detected pnpm (pnpm-lock.yaml). To declare the Leji CLI as a dev dependency so a clean install brings leji, run:\n   pnpm add -D @leji-org/leji" {
		t.Errorf("offer block:\n%s", got)
	}
	if got := ecosystem.RenderBlock(report("node-declared")); got != "The Leji CLI is already declared in package.json." {
		t.Errorf("declared block: %s", got)
	}
	if got := ecosystem.RenderBlock(report("node-two-lockfiles")); got !=
		"Detected package.json with package-lock.json and yarn.lock; leji will not guess the package manager. Declare it with the one this repo uses:\n   npm i -D @leji-org/leji\n   yarn add -D @leji-org/leji" {
		t.Errorf("ambiguous block:\n%s", got)
	}
	for _, name := range []string{"node-packagemanager-unknown", "node-unreadable-manifest", "node-refused-evidence"} {
		block := ecosystem.RenderBlock(report(name))
		if block == "" || strings.Contains(block, "\n   npm") {
			t.Errorf("%s: a block, and never a guessed command", name)
		}
	}
	if got := ecosystem.RenderBlock(report("python-bare-pyproject")); got != strings.Join(ecosystem.TextPipGroups("pyproject.toml"), "\n") {
		t.Errorf("pip block:\n%s", got)
	}
	if got := ecosystem.RenderBlock(report("python-requirements-only")); !strings.Contains(got, "pip install -r requirements-dev.txt") {
		t.Errorf("pip requirements block:\n%s", got)
	}
	if got := ecosystem.RenderBlock(report("go-1.23-legacy")); !strings.Contains(got, "go install "+"github.com/leji-org/leji/packages/sdk-go/cmd/leji@latest") {
		t.Errorf("go-legacy block:\n%s", got)
	}
	if got := ecosystem.RenderBlock(report("none")); !strings.Contains(got, "https://leji.org/quickstart/") {
		t.Errorf("none block:\n%s", got)
	}

	for name, want := range map[string]string{
		"node-pnpm-lock":         "Ecosystem: pnpm (pnpm-lock.yaml); Leji CLI not declared",
		"node-declared":          "Ecosystem: npm (package-lock.json); Leji CLI declared",
		"python-pipfile-only":    "Ecosystem: pipenv (Pipfile); Leji CLI declared",
		"python-tool-uv-no-lock": "Ecosystem: uv (pyproject.toml); Leji CLI not declared",
		"none":                   "Ecosystem: none detected",
	} {
		if got := ecosystem.RenderLine(report(name)); got != want {
			t.Errorf("%s: line %q, want %q", name, got, want)
		}
	}
	for _, name := range caseNames(t) {
		if strings.Contains(ecosystem.RenderLine(report(name)), "\n") {
			t.Errorf("%s: the detect line is one line", name)
		}
	}
}

// A non-finite JSON constant is not strict JSON: the three SDKs must call the same
// bytes unreadable (TS JSON.parse and Go's decoder both refuse; Python needs its
// parse_constant hook to agree).
func TestNonFiniteConstantIsUnreadable(t *testing.T) {
	for _, bad := range []string{
		`{"dependencies":{"@leji-org/leji":NaN}}`,
		`{"packageManager":Infinity}`,
	} {
		dir := plant(t, map[string]string{"package.json": bad, "package-lock.json": ""})
		report := ecosystem.Detect(dir)
		if report.Reason == nil || *report.Reason != "unreadable-manifest" {
			t.Errorf("%s should be unreadable-manifest, got %v", bad, report.Reason)
		}
	}
}

// Trailing content after the first value is not strict JSON: JSON.parse and
// Python's json.loads both refuse it, so the manifest is unreadable rather than
// read as whatever came first.
func TestTrailingContentIsUnreadable(t *testing.T) {
	for _, bad := range []string{
		`{"devDependencies":{"@leji-org/leji":"^1"}} trailing garbage`,
		`{"name":"demo"} {"name":"second"}`,
		`{"name":"demo"}]`,
		`{"name":"demo"} null`,
	} {
		dir := plant(t, map[string]string{"package.json": bad, "package-lock.json": ""})
		report := ecosystem.Detect(dir)
		if report.Reason == nil || *report.Reason != "unreadable-manifest" {
			t.Errorf("%q should be unreadable-manifest, got %v", bad, report.Reason)
		}
	}
	// Trailing whitespace and a trailing newline are not content.
	for _, fine := range []string{"{\"name\":\"demo\"}\n", "  {\"name\":\"demo\"}  \n\n"} {
		dir := plant(t, map[string]string{"package.json": fine, "package-lock.json": ""})
		if report := ecosystem.Detect(dir); report.Reason != nil {
			t.Errorf("%q should parse, got %v", fine, *report.Reason)
		}
	}
}
