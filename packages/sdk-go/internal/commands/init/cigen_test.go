package initcmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/ecosystem"
)

func goldensDir(t *testing.T) string {
	t.Helper()
	wd, _ := os.Getwd()
	return filepath.Join(wd, "..", "..", "..", "..", "..", "fixtures", "ci-goldens")
}

func golden(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(goldensDir(t), name))
	if err != nil {
		t.Fatalf("golden %s: %v", name, err)
	}
	return string(data)
}

var ciRel = map[string]string{
	"github":   CIWorkflowPath,
	"gitlab":   GitlabCIPath,
	"circleci": CircleCIConfigPath,
	"azure":    AzurePipelinePath,
}

// Every generated variant matches its committed bytes: the goldens are the byte
// oracle for what an adopter's pipeline runs, shared with the reference.
func TestCiVariantsMatchGoldens(t *testing.T) {
	variants := CiVariants()
	if len(variants) != len(CIProviders)*12 {
		t.Fatalf("expected nine local managers plus three fallbacks per provider, got %d", len(variants))
	}
	for _, v := range variants {
		if want := golden(t, v.Provider+"-"+v.Key+".yml"); v.Bytes != want {
			t.Errorf("%s/%s bytes differ\n--- want ---\n%s\n--- got ---\n%s", v.Provider, v.Key, want, v.Bytes)
		}
	}
}

// The hook bodies match, for every runner.
func TestHookGoldens(t *testing.T) {
	for _, manager := range []string{"npm", "pnpm", "yarn", "bun", "uv", "poetry", "pdm", "pipenv", "go"} {
		argv := ecosystem.ManagerRunnerArgv(manager)
		if got := HookBody(argv); got != golden(t, "hook-"+manager+".sh") {
			t.Errorf("hook-%s.sh differs:\n%s", manager, got)
		}
		if got := HuskyBlock(argv); got != golden(t, "husky-"+manager+".sh") {
			t.Errorf("husky-%s.sh differs:\n%s", manager, got)
		}
	}
	if got := HookBody([]string{"leji"}); got != golden(t, "hook-fallback.sh") {
		t.Errorf("hook-fallback.sh differs:\n%s", got)
	}
	if got := HuskyBlock([]string{"leji"}); got != golden(t, "husky-fallback.sh") {
		t.Errorf("husky-fallback.sh differs:\n%s", got)
	}
}

// Every argv element is single-quoted for sh, with the one legal escape, and the
// scalar shim is gone.
func TestShQuoteAndHookShape(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"pnpm", "'pnpm'"},
		{"we'ird", `'we'\''ird'`},
		{"a b", "'a b'"},
		{"x$HOME", "'x$HOME'"},
	} {
		if got := ShQuote(c.in); got != c.want {
			t.Errorf("ShQuote(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	body := HookBody([]string{"weird bin", "quo'te", "$HOME", "`cmd`", "*"})
	if !strings.Contains(body, `'weird bin' 'quo'\''te' '$HOME' '`+"`cmd`"+`' '*' validate || exit 1`) {
		t.Errorf("hostile runner not quoted:\n%s", body)
	}
	if !strings.Contains(body, "echo 'leji: stored index is stale; run `leji index` and stage the result.' >&2") {
		t.Errorf("the stale-index message keeps its own shell quoting:\n%s", body)
	}
	for _, argv := range [][]string{{"leji"}, {"pnpm", "exec", "leji"}, {"go", "tool", "leji"}} {
		for _, gone := range []string{"node_modules", "LEJI=", "$LEJI"} {
			if strings.Contains(HookBody(argv), gone) || strings.Contains(HuskyBlock(argv), gone) {
				t.Errorf("the shim is gone; found %q", gone)
			}
		}
	}
}

func plantRoot(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for rel, body := range files {
		writeFile(t, filepath.Join(dir, rel), body)
	}
	return dir
}

var declaredPkg = "{\n  \"name\": \"demo\",\n  \"devDependencies\": { \"@leji-org/leji\": \"^1\" }\n}\n"

// A declared, lock-evidenced repository gets its own manager job, at every provider.
func TestCiTableLocalJobs(t *testing.T) {
	roots := map[string]map[string]string{
		"pnpm": {"package.json": declaredPkg, "pnpm-lock.yaml": ""},
		"npm":  {"package.json": declaredPkg, "package-lock.json": ""},
		"uv":   {"pyproject.toml": "[project]\nname = \"d\"\nversion = \"0\"\ndependencies = [\"leji\"]\n", "uv.lock": ""},
		"go":   {"go.mod": "module example.com/d\n\ngo 1.24.0\n\ntool github.com/leji-org/leji/packages/sdk-go/cmd/leji\n"},
	}
	for manager, files := range roots {
		for _, provider := range CIProviders {
			dir := plantRoot(t, files)
			r, err := EnsureCiWorkflow(dir, provider, nil)
			if err != nil {
				t.Fatalf("%s/%s: %v", manager, provider, err)
			}
			if r.Action != "created" {
				t.Errorf("%s/%s: action %q, want created", manager, provider, r.Action)
			}
			got := readFile(t, filepath.Join(dir, ciRel[provider]))
			if want := golden(t, provider+"-"+manager+"-local.yml"); got != want {
				t.Errorf("%s/%s bytes differ:\n%s", manager, provider, got)
			}
		}
	}
}

// local needs BOTH the declaration and the lock evidence, and every other state
// falls back to a job that needs no manifest.
func TestCiTableFallbacks(t *testing.T) {
	cases := []struct {
		files map[string]string
		key   string
	}{
		{map[string]string{"package.json": declaredPkg}, "node-fallback"},
		{map[string]string{"package.json": "{\"name\":\"demo\"}\n", "package-lock.json": ""}, "node-fallback"},
		{map[string]string{"package.json": "{}\n", "package-lock.json": "", "yarn.lock": ""}, "node-fallback"},
		{map[string]string{"package.json": "{\"packageManager\":\"hermit@1.0.0\"}\n"}, "node-fallback"},
		{map[string]string{"pyproject.toml": "[project]\nname = \"d\"\nversion = \"0\"\n"}, "python-fallback"},
		{map[string]string{"requirements.txt": "requests\n"}, "python-fallback"},
		{map[string]string{"go.mod": "module example.com/d\n\ngo 1.23\n"}, "go-fallback"},
		{map[string]string{"go.mod": "module example.com/d\n\ngo 1.24.0\n"}, "go-fallback"},
		{map[string]string{"package.json": "{}\n", "pyproject.toml": "[project]\nname=\"d\"\nversion=\"0\"\n"}, "node-fallback"},
	}
	for _, c := range cases {
		dir := plantRoot(t, c.files)
		if _, err := EnsureCiWorkflow(dir, "github", nil); err != nil {
			t.Fatalf("%v: %v", c.files, err)
		}
		if got := readFile(t, filepath.Join(dir, CIWorkflowPath)); got != golden(t, "github-"+c.key+".yml") {
			t.Errorf("expected %s:\n%s", c.key, got)
		}
	}
}

// The bootstrap disclosure appears exactly once, only where a tool is unpinned.
func TestCiUnpinnedDisclosure(t *testing.T) {
	for _, v := range CiVariants() {
		hits := 0
		for _, line := range strings.Split(v.Bytes, "\n") {
			if strings.Contains(line, "is installed unpinned here") {
				hits++
			}
		}
		wants := strings.HasPrefix(v.Key, "poetry-local") || strings.HasPrefix(v.Key, "pdm-local") ||
			strings.HasPrefix(v.Key, "pipenv-local") || (v.Key == "uv-local" && v.Provider != "github")
		want := 0
		if wants {
			want = 1
		}
		if hits != want {
			t.Errorf("%s/%s: %d disclosure lines, want %d", v.Provider, v.Key, hits, want)
		}
	}
	if !strings.Contains(golden(t, "github-uv-local.yml"), "astral-sh/setup-uv@v5") ||
		strings.Contains(golden(t, "github-uv-local.yml"), "pip install uv") {
		t.Error("uv on GitHub uses its own setup action")
	}
	if !strings.Contains(golden(t, "gitlab-uv-local.yml"), "pip install uv && uv sync --locked") {
		t.Error("uv elsewhere is pip-installed")
	}
}

// The marker names the generator version on every whole file, and never inside the
// GitLab block; and the Node fallback job is the pre-1.4 job plus that marker.
func TestCiMarkerAndLegacyJob(t *testing.T) {
	for _, v := range CiVariants() {
		if v.Provider == "gitlab" {
			if strings.Contains(v.Bytes, "generated by leji ci (managed)") {
				t.Errorf("the GitLab block keeps its own markers: %s", v.Key)
			}
			if !strings.HasPrefix(v.Bytes, "# >>> leji ci (managed) >>>\n") {
				t.Errorf("gitlab/%s missing its block marker", v.Key)
			}
			continue
		}
		if !strings.HasPrefix(v.Bytes, CIMarker+"\n") {
			t.Errorf("%s/%s missing the ownership marker", v.Provider, v.Key)
		}
	}
	for _, provider := range []string{"github", "circleci", "azure"} {
		before := golden(t, "legacy-1.3-"+provider+"-fallback.yml")
		if now := golden(t, provider+"-node-fallback.yml"); now != CIMarker+"\n"+before {
			t.Errorf("%s: the fallback job is the pre-1.4 job plus the marker", provider)
		}
	}
}

// Ownership: a file generated by an EARLIER release is upgraded, a re-run is
// unchanged, a manager change is rewritten, and an edited or foreign file is left
// alone with a snippet.
func TestCiOwnership(t *testing.T) {
	pnpm := map[string]string{"package.json": declaredPkg, "pnpm-lock.yaml": ""}
	for _, provider := range []string{"github", "circleci", "azure"} {
		for _, mode := range []string{"local", "fallback"} {
			dir := plantRoot(t, pnpm)
			abs := filepath.Join(dir, ciRel[provider])
			writeFile(t, abs, golden(t, "legacy-1.3-"+provider+"-"+mode+".yml"))
			r, err := EnsureCiWorkflow(dir, provider, nil)
			if err != nil {
				t.Fatal(err)
			}
			if r.Action != "updated" {
				t.Errorf("%s/%s: action %q, want updated", provider, mode, r.Action)
			}
			if got := readFile(t, abs); got != golden(t, provider+"-pnpm-local.yml") {
				t.Errorf("%s/%s: not upgraded to the current job", provider, mode)
			}
		}
	}

	for _, provider := range CIProviders {
		dir := plantRoot(t, map[string]string{
			"pyproject.toml": "[project]\nname = \"d\"\nversion = \"0\"\ndependencies = [\"leji\"]\n",
			"uv.lock":        "",
		})
		if r, _ := EnsureCiWorkflow(dir, provider, nil); r.Action != "created" {
			t.Fatalf("%s: first run should create", provider)
		}
		after := readFile(t, filepath.Join(dir, ciRel[provider]))
		r, err := EnsureCiWorkflow(dir, provider, nil)
		if err != nil {
			t.Fatal(err)
		}
		if r.Action != "unchanged" {
			t.Errorf("%s: re-run action %q, want unchanged", provider, r.Action)
		}
		if readFile(t, filepath.Join(dir, ciRel[provider])) != after {
			t.Errorf("%s: re-run is byte-identical", provider)
		}
	}

	// A file this generator wrote for a different manager: still leji's.
	change := plantRoot(t, pnpm)
	writeFile(t, filepath.Join(change, CIWorkflowPath), golden(t, "github-npm-local.yml"))
	if r, _ := EnsureCiWorkflow(change, "github", nil); r.Action != "updated" {
		t.Error("a manager change rewrites the job leji owns")
	}
	if got := readFile(t, filepath.Join(change, CIWorkflowPath)); got != golden(t, "github-pnpm-local.yml") {
		t.Error("the manager change lands the pnpm job")
	}

	for _, provider := range []string{"github", "circleci", "azure"} {
		edited := plantRoot(t, pnpm)
		mine := golden(t, provider+"-pnpm-local.yml")
		writeFile(t, filepath.Join(edited, ciRel[provider]), mine+"      - run: echo mine\n")
		r, err := EnsureCiWorkflow(edited, provider, nil)
		if err != nil {
			t.Fatal(err)
		}
		if r.Action != "manual" || r.Snippet == "" {
			t.Errorf("%s: an edited generated file is manual with a snippet", provider)
		}
		if readFile(t, filepath.Join(edited, ciRel[provider])) != mine+"      - run: echo mine\n" {
			t.Errorf("%s: the edit is the opt-out and is honored", provider)
		}

		foreign := plantRoot(t, pnpm)
		writeFile(t, filepath.Join(foreign, ciRel[provider]), "name: someone-elses-pipeline\n")
		if r, _ := EnsureCiWorkflow(foreign, provider, nil); r.Action != "manual" {
			t.Errorf("%s: a foreign file is manual", provider)
		}
		if readFile(t, filepath.Join(foreign, ciRel[provider])) != "name: someone-elses-pipeline\n" {
			t.Errorf("%s: a foreign file is untouched", provider)
		}
	}
}

// The legacy registry is scoped to its own provider: the same bytes are leji's at
// one path and somebody else's at another.
func TestCiOwnershipIsProviderScoped(t *testing.T) {
	pnpm := map[string]string{"package.json": declaredPkg, "pnpm-lock.yaml": ""}
	cross := []struct{ provider, foreign string }{
		{"github", "legacy-1.3-circleci-local.yml"},
		{"github", "legacy-1.3-azure-fallback.yml"},
		{"circleci", "legacy-1.3-github-local.yml"},
		{"circleci", "legacy-1.3-azure-local.yml"},
		{"azure", "legacy-1.3-github-fallback.yml"},
		{"azure", "legacy-1.3-circleci-fallback.yml"},
	}
	for _, c := range cross {
		dir := plantRoot(t, pnpm)
		bytes := golden(t, c.foreign)
		writeFile(t, filepath.Join(dir, ciRel[c.provider]), bytes)
		r, err := EnsureCiWorkflow(dir, c.provider, nil)
		if err != nil {
			t.Fatal(err)
		}
		if r.Action != "manual" {
			t.Errorf("%s at the %s path is foreign, got %q", c.foreign, c.provider, r.Action)
		}
		if readFile(t, filepath.Join(dir, ciRel[c.provider])) != bytes {
			t.Errorf("%s: left untouched", c.provider)
		}
	}
	for _, provider := range []string{"github", "circleci", "azure"} {
		dir := plantRoot(t, pnpm)
		writeFile(t, filepath.Join(dir, ciRel[provider]), golden(t, "legacy-1.3-"+provider+"-local.yml"))
		if r, _ := EnsureCiWorkflow(dir, provider, nil); r.Action != "updated" {
			t.Errorf("%s: its own legacy bytes are still recognized", provider)
		}
	}
}

// GitLab still owns only its marked block.
func TestGitlabOwnsOnlyItsBlock(t *testing.T) {
	dir := plantRoot(t, map[string]string{"package.json": declaredPkg, "pnpm-lock.yaml": ""})
	abs := filepath.Join(dir, GitlabCIPath)
	writeFile(t, abs, "stages:\n  - test\n")
	if r, _ := EnsureCiWorkflow(dir, "gitlab", nil); r.Action != "updated" {
		t.Fatal("the block is merged into an existing config")
	}
	merged := readFile(t, abs)
	if !strings.HasPrefix(merged, "stages:\n  - test\n") {
		t.Error("the surrounding config is preserved")
	}
	if !strings.Contains(merged, golden(t, "gitlab-pnpm-local.yml")) {
		t.Error("the managed block is exact")
	}
}

// The hook carries the repository's own runner, and a re-run is idempotent.
func TestEnsureLocalHookUsesTheDetectedRunner(t *testing.T) {
	dir := gitInitRepo(t)
	writeFile(t, filepath.Join(dir, "package.json"), declaredPkg)
	writeFile(t, filepath.Join(dir, "pnpm-lock.yaml"), "")
	r, err := EnsureLocalHook(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if r.Action != "created" {
		t.Fatalf("action %q, want created", r.Action)
	}
	if got := readFile(t, filepath.Join(dir, r.Path)); got != golden(t, "hook-pnpm.sh") {
		t.Errorf("the hook is the pnpm golden:\n%s", got)
	}
	if again, _ := EnsureLocalHook(dir, nil); again.Action != "unchanged" {
		t.Errorf("re-run action %q, want unchanged", again.Action)
	}
}
