package initcmd

// Mirrors packages/sdk/test/units.test.ts ("ci: provider inference from the
// origin remote", "ci --hooks: managed pre-commit hook is created, idempotent,
// and never clobbers") and packages/sdk/test/onboarding.test.ts ("approval
// guard: installs idempotently and preserves existing settings", "approval
// guard: blocks until written and printed, inert after onboarding").

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestCiProviderInferenceFromOriginRemote(t *testing.T) {
	cases := []struct {
		url  string
		want string
	}{
		{"git@github.com:acme/app.git", "github"},
		{"git@gitlab.com:acme/app.git", "gitlab"},
		{"https://gitlab.example.co/acme/app.git", "gitlab"},
		{"https://dev.azure.com/acme/app/_git/app", "azure"},
		{"https://bitbucket.org/acme/app.git", ""},
		{"", ""},
	}
	for _, c := range cases {
		if got := CiProviderFromRemote(c.url); got != c.want {
			t.Fatalf("CiProviderFromRemote(%q) = %q, want %q", c.url, got, c.want)
		}
	}
}

func TestEnsureLocalHookCreatedIdempotentNeverClobbers(t *testing.T) {
	dir := gitInitRepo(t)
	first, err := EnsureLocalHook(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if first.Action != "created" {
		t.Fatalf("first action = %q, want created", first.Action)
	}
	second, err := EnsureLocalHook(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if second.Action != "unchanged" {
		t.Fatalf("second action = %q, want unchanged", second.Action)
	}
	hookPath := filepath.Join(dir, ".git", "hooks", "pre-commit")
	info, err := os.Stat(hookPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&0o111 == 0 {
		t.Fatal("hook is not executable")
	}
	if err := os.WriteFile(hookPath, []byte("#!/bin/sh\necho custom hook\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	third, err := EnsureLocalHook(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if third.Action != "manual" || third.Reason != "foreign-hook" {
		t.Fatalf("third = %q/%q, want manual/foreign-hook", third.Action, third.Reason)
	}
	if !strings.Contains(third.Snippet, "\"$LEJI\" validate") {
		t.Fatalf("manual snippet missing the gate: %q", third.Snippet)
	}
	if !strings.Contains(third.Snippet, "node_modules/.bin/leji") {
		t.Fatalf("manual snippet should prefer the local bin: %q", third.Snippet)
	}
	got, _ := os.ReadFile(hookPath)
	if !strings.Contains(string(got), "custom hook") {
		t.Fatal("foreign hook was touched")
	}
}

func TestEnsureLocalHookRequiresGitRepo(t *testing.T) {
	dir := t.TempDir()
	if _, err := EnsureLocalHook(dir); err == nil ||
		err.Error() != "not a git repository (no .git directory); hooks need one" {
		t.Fatalf("expected the no-git error, got %v", err)
	}
}

func gitInitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if out, err := exec.Command("git", "-C", dir, "init", "-q").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, out)
	}
	return dir
}

func setHooksPath(t *testing.T, dir, value string) {
	t.Helper()
	if out, err := exec.Command("git", "-C", dir, "config", "core.hooksPath", value).CombinedOutput(); err != nil {
		t.Fatalf("git config core.hooksPath: %v: %s", err, out)
	}
}

// Mirrors units.test.ts "ci --hooks: husky (.husky/_) merges a managed block ...".
func TestEnsureLocalHookHuskyMergesManagedBlock(t *testing.T) {
	dir := gitInitRepo(t)
	setHooksPath(t, dir, ".husky/_")
	huskyPre := filepath.Join(dir, ".husky", "pre-commit")
	if err := os.MkdirAll(filepath.Dir(huskyPre), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(huskyPre, []byte("#!/bin/sh\nnpm test\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	r, err := EnsureLocalHook(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if r.Path != ".husky/pre-commit" {
		t.Fatalf("path = %q, want .husky/pre-commit", r.Path)
	}
	if r.Action != "updated" || r.Managed != "block" {
		t.Fatalf("action/managed = %q/%q, want updated/block", r.Action, r.Managed)
	}
	got, _ := os.ReadFile(huskyPre)
	if !strings.Contains(string(got), "npm test") {
		t.Fatal("existing husky content was touched")
	}
	if !strings.Contains(string(got), huskyMarkerStart) {
		t.Fatal("managed block not merged")
	}
	if _, err := os.Stat(filepath.Join(dir, ".git", "hooks", "pre-commit")); err == nil {
		t.Fatal(".git/hooks/pre-commit should not be written")
	}
	again, err := EnsureLocalHook(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if again.Action != "unchanged" {
		t.Fatalf("rerun action = %q, want unchanged", again.Action)
	}
}

// Mirrors units.test.ts "ci --hooks: husky repo without .husky/pre-commit ...".
func TestEnsureLocalHookHuskyCreatesFileWhenAbsent(t *testing.T) {
	dir := gitInitRepo(t)
	setHooksPath(t, dir, ".husky/_")
	r, err := EnsureLocalHook(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if r.Action != "created" || r.Managed != "block" {
		t.Fatalf("action/managed = %q/%q, want created/block", r.Action, r.Managed)
	}
	huskyPre := filepath.Join(dir, ".husky", "pre-commit")
	body, _ := os.ReadFile(huskyPre)
	if !strings.HasPrefix(string(body), "#!/bin/sh\n") {
		t.Fatal("husky hook missing shebang")
	}
	info, err := os.Stat(huskyPre)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&0o111 == 0 {
		t.Fatal("husky hook is not executable")
	}
	if _, err := os.Stat(filepath.Join(dir, ".git", "hooks", "pre-commit")); err == nil {
		t.Fatal(".git/hooks/pre-commit should not be written")
	}
}

// Mirrors units.test.ts "ci --hooks: direct .husky (v8) hook is executable and
// mode-corrected on rerun".
func TestEnsureLocalHookDirectHuskyV8ModeCorrection(t *testing.T) {
	dir := gitInitRepo(t)
	setHooksPath(t, dir, ".husky")
	first, err := EnsureLocalHook(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if first.Action != "created" || first.Path != ".husky/pre-commit" || first.Managed != "block" {
		t.Fatalf("first = %q/%q/%q, want created/.husky/pre-commit/block", first.Action, first.Path, first.Managed)
	}
	huskyPre := filepath.Join(dir, ".husky", "pre-commit")
	if info, _ := os.Stat(huskyPre); info.Mode()&0o111 == 0 {
		t.Fatal("created hook is not executable")
	}
	second, err := EnsureLocalHook(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if second.Action != "unchanged" {
		t.Fatalf("second action = %q, want unchanged", second.Action)
	}
	if err := os.Chmod(huskyPre, 0o644); err != nil {
		t.Fatal(err)
	}
	third, err := EnsureLocalHook(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if third.Action != "updated" {
		t.Fatalf("third action = %q, want updated (mode-only correction)", third.Action)
	}
	if info, _ := os.Stat(huskyPre); info.Mode()&0o111 == 0 {
		t.Fatal("hook was not re-made executable")
	}
}

// Mirrors units.test.ts "ci: local-first CI variant ..." / "ci: npx @1 fallback ...".
func TestCiTemplateVariantsLocalVsNpx(t *testing.T) {
	gh := BuildGithubWorkflow(true)
	if !strings.Contains(gh, "- run: npm ci") || !strings.Contains(gh, "npx --no-install @leji-org/leji validate") {
		t.Fatalf("local github variant missing npm ci / --no-install:\n%s", gh)
	}
	if strings.Contains(gh, "npx -y @leji-org/leji@1") {
		t.Fatal("local github variant should not use the npx @1 fallback")
	}
	if fb := BuildGithubWorkflow(false); !strings.Contains(fb, "npx -y @leji-org/leji@1 validate") || strings.Contains(fb, "npm ci") {
		t.Fatalf("fallback github variant wrong:\n%s", fb)
	}
}

func TestDeclaresLejiDepDetection(t *testing.T) {
	dir := t.TempDir()
	if declaresLejiDep(dir) {
		t.Fatal("no package.json should not declare the dep")
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte("{ not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if declaresLejiDep(dir) {
		t.Fatal("unparseable package.json should not declare the dep")
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"devDependencies":{"@leji-org/leji":"^1.3.0"}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if !declaresLejiDep(dir) {
		t.Fatal("devDependencies entry should declare the dep")
	}
	// A leading UTF-8 BOM is stripped, so a valid manifest is still detected.
	bom := append([]byte{0xEF, 0xBB, 0xBF}, []byte(`{"dependencies":{"@leji-org/leji":"1.3.0"}}`)...)
	if err := os.WriteFile(filepath.Join(dir, "package.json"), bom, 0o644); err != nil {
		t.Fatal(err)
	}
	if !declaresLejiDep(dir) {
		t.Fatal("BOM-prefixed manifest should still declare the dep")
	}
	// dependencies as a JSON array is not an object -> treated as absent, not an error.
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"dependencies":["@leji-org/leji"]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if declaresLejiDep(dir) {
		t.Fatal("array dependencies field should be treated as absent")
	}
	// A non-finite JSON constant (NaN) fails the strict parse -> not declared.
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"dependencies":{"@leji-org/leji":NaN}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if declaresLejiDep(dir) {
		t.Fatal("a NaN value should fail the strict parse")
	}
}

// Mirrors units.test.ts "ci --hooks: a byte-current .git/hooks/pre-commit that lost
// its exec bit is mode-corrected".
func TestEnsureLocalHookStandaloneModeCorrection(t *testing.T) {
	dir := gitInitRepo(t)
	first, err := EnsureLocalHook(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if first.Action != "created" {
		t.Fatalf("first action = %q, want created", first.Action)
	}
	hookPath := filepath.Join(dir, ".git", "hooks", "pre-commit")
	if info, _ := os.Stat(hookPath); info.Mode()&0o111 == 0 {
		t.Fatal("created hook is not executable")
	}
	if second, _ := EnsureLocalHook(dir); second.Action != "unchanged" {
		t.Fatalf("second action = %q, want unchanged", second.Action)
	}
	if err := os.Chmod(hookPath, 0o644); err != nil {
		t.Fatal(err)
	}
	third, err := EnsureLocalHook(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if third.Action != "updated" {
		t.Fatalf("third action = %q, want updated (mode-only correction)", third.Action)
	}
	if info, _ := os.Stat(hookPath); info.Mode()&0o111 == 0 {
		t.Fatal("hook was not re-made executable")
	}
}

// Mirrors units.test.ts "ci --hooks: a relative out-of-root core.hooksPath reports a
// normalized target".
func TestEnsureLocalHookRelativeOutOfRootNormalized(t *testing.T) {
	dir := gitInitRepo(t)
	setHooksPath(t, dir, "../sibling-ext/.husky/_")
	r, err := EnsureLocalHook(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if r.Action != "manual" || r.Reason != "outside-root" || r.Managed != "block" {
		t.Fatalf("r = %q/%q/%q, want manual/outside-root/block", r.Action, r.Reason, r.Managed)
	}
	want := filepath.ToSlash(filepath.Join(filepath.Dir(dir), "sibling-ext", ".husky", "pre-commit"))
	if r.Path != want {
		t.Fatalf("path = %q, want normalized %q", r.Path, want)
	}
	if strings.Contains(r.Path, "..") {
		t.Fatalf("reported path is not normalized: %q", r.Path)
	}
}

// Mirrors units.test.ts "ci --hooks: a custom core.hooksPath dir ...".
func TestEnsureLocalHookCustomDirWritesManagedFile(t *testing.T) {
	dir := gitInitRepo(t)
	setHooksPath(t, dir, "githooks")
	r, err := EnsureLocalHook(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if r.Path != "githooks/pre-commit" {
		t.Fatalf("path = %q, want githooks/pre-commit", r.Path)
	}
	if r.Action != "created" || r.Managed != "file" {
		t.Fatalf("action/managed = %q/%q, want created/file", r.Action, r.Managed)
	}
	custom := filepath.Join(dir, "githooks", "pre-commit")
	got, _ := os.ReadFile(custom)
	if !strings.Contains(string(got), hookMarker) {
		t.Fatal("managed hook marker missing")
	}
	info, _ := os.Stat(custom)
	if info.Mode()&0o111 == 0 {
		t.Fatal("custom hook is not executable")
	}
	if _, err := os.Stat(filepath.Join(dir, ".git", "hooks", "pre-commit")); err == nil {
		t.Fatal(".git/hooks/pre-commit should not be written")
	}
}

// Mirrors units.test.ts "ci --hooks: a core.hooksPath outside the repo ...".
func TestEnsureLocalHookHooksPathOutsideRepoIsManual(t *testing.T) {
	dir := gitInitRepo(t)
	outside := t.TempDir()
	setHooksPath(t, dir, outside)
	r, err := EnsureLocalHook(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if r.Action != "manual" || r.Managed != "file" || r.Reason != "outside-root" {
		t.Fatalf("action/managed/reason = %q/%q/%q, want manual/file/outside-root", r.Action, r.Managed, r.Reason)
	}
	if r.Path != outside+"/pre-commit" {
		t.Fatalf("path = %q, want %q", r.Path, outside+"/pre-commit")
	}
	if !strings.Contains(r.Snippet, "\"$LEJI\" validate") {
		t.Fatalf("manual snippet missing the gate: %q", r.Snippet)
	}
	if _, err := os.Stat(filepath.Join(outside, "pre-commit")); err == nil {
		t.Fatal("nothing should be written outside the repo")
	}
	if _, err := os.Stat(filepath.Join(dir, ".git", "hooks", "pre-commit")); err == nil {
		t.Fatal(".git/hooks/pre-commit should not be written")
	}
}

func TestApprovalGuardInstallsIdempotentlyPreservesSettings(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	// JSON.stringify({...}, null, 2): the shape the Node SDK would have written.
	initial := "{\n" +
		"  \"existing\": true,\n" +
		"  \"hooks\": {\n" +
		"    \"PreToolUse\": [\n" +
		"      {\n" +
		"        \"matcher\": \"Bash\",\n" +
		"        \"hooks\": [\n" +
		"          {\n" +
		"            \"type\": \"command\",\n" +
		"            \"command\": \"echo hi\"\n" +
		"          }\n" +
		"        ]\n" +
		"      }\n" +
		"    ]\n" +
		"  }\n" +
		"}"
	settingsPath := filepath.Join(dir, ".claude", "settings.json")
	if err := os.WriteFile(settingsPath, []byte(initial), 0o644); err != nil {
		t.Fatal(err)
	}
	action, err := EnsureApprovalGuard(dir, "docs/")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if action != "installed" {
		t.Fatalf("first action = %q, want installed", action)
	}
	action, err = EnsureApprovalGuard(dir, "docs/")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if action != "unchanged" {
		t.Fatalf("second action = %q, want unchanged", action)
	}
	raw, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	// Byte parity with Node's JSON.parse → mutate → JSON.stringify(_, null, 2).
	want := "{\n" +
		"  \"existing\": true,\n" +
		"  \"hooks\": {\n" +
		"    \"PreToolUse\": [\n" +
		"      {\n" +
		"        \"matcher\": \"Bash\",\n" +
		"        \"hooks\": [\n" +
		"          {\n" +
		"            \"type\": \"command\",\n" +
		"            \"command\": \"echo hi\"\n" +
		"          }\n" +
		"        ]\n" +
		"      },\n" +
		"      {\n" +
		"        \"matcher\": \"AskUserQuestion\",\n" +
		"        \"hooks\": [\n" +
		"          {\n" +
		"            \"type\": \"command\",\n" +
		"            \"command\": \"node \\\"$CLAUDE_PROJECT_DIR/docs/.leji/hooks/approval-guard.mjs\\\"\"\n" +
		"          }\n" +
		"        ]\n" +
		"      }\n" +
		"    ]\n" +
		"  }\n" +
		"}\n"
	if string(raw) != want {
		t.Fatalf("settings.json diverges from the Node serialization:\n%s", string(raw))
	}
	var settings struct {
		Existing bool `json:"existing"`
		Hooks    struct {
			PreToolUse []struct {
				Matcher string `json:"matcher"`
			} `json:"PreToolUse"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(raw, &settings); err != nil {
		t.Fatal(err)
	}
	if !settings.Existing {
		t.Fatal("unrelated settings not preserved")
	}
	matchers := []string{}
	for _, e := range settings.Hooks.PreToolUse {
		matchers = append(matchers, e.Matcher)
	}
	if strings.Join(matchers, ",") != "Bash,AskUserQuestion" {
		t.Fatalf("matchers = %v, want [Bash AskUserQuestion]", matchers)
	}
	if _, err := os.Stat(filepath.Join(dir, "docs", ".leji", "hooks", "approval-guard.mjs")); err != nil {
		t.Fatal("guard script not written")
	}
}

func TestApprovalGuardBlocksUntilWrittenAndPrintedInertAfterOnboarding(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not on PATH")
	}
	dir := t.TempDir()
	if _, err := EnsureApprovalGuard(dir, "docs/"); err != nil {
		t.Fatal(err)
	}
	lejiDir := filepath.Join(dir, "docs", ".leji")
	script := filepath.Join(lejiDir, "hooks", "approval-guard.mjs")
	if err := os.WriteFile(filepath.Join(lejiDir, "onboarding-brief.md"), []byte("brief"), 0o644); err != nil {
		t.Fatal(err)
	}
	run := func(transcript string) int {
		cmd := exec.Command("node", script)
		cmd.Stdin = strings.NewReader(`{"transcript_path":` + string(mustJSON(transcript)) + `}`)
		cmd.Env = append(os.Environ(), "CLAUDE_PROJECT_DIR="+dir)
		err := cmd.Run()
		if err == nil {
			return 0
		}
		if exitErr, ok := err.(*exec.ExitError); ok {
			return exitErr.ExitCode()
		}
		t.Fatalf("could not run node: %v", err)
		return -1
	}
	if got := run("/nonexistent"); got != 2 {
		t.Fatalf("no proposal: exit %d, want 2 (blocked)", got)
	}
	if err := os.WriteFile(filepath.Join(lejiDir, "proposal.md"), []byte("# Proposal for approval\n\nbody\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t1 := filepath.Join(dir, "t1.jsonl")
	line1, _ := json.Marshal(map[string]any{
		"type": "assistant", "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "about to ask"}}},
	})
	if err := os.WriteFile(t1, append(line1, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := run(t1); got != 2 {
		t.Fatalf("written but not printed: exit %d, want 2 (blocked)", got)
	}
	t2 := filepath.Join(dir, "t2.jsonl")
	line2, _ := json.Marshal(map[string]any{
		"type": "assistant", "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "# Proposal for approval\nbody"}}},
	})
	if err := os.WriteFile(t2, append(line2, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := run(t2); got != 0 {
		t.Fatalf("written and printed: exit %d, want 0 (allowed)", got)
	}
	if err := os.Remove(filepath.Join(lejiDir, "onboarding-brief.md")); err != nil {
		t.Fatal(err)
	}
	if got := run("/nonexistent"); got != 0 {
		t.Fatalf("brief gone: exit %d, want 0 (guard inert)", got)
	}
}

func mustJSON(s string) []byte {
	b, _ := json.Marshal(s)
	return b
}

// The generated hook's stale-index message is literal text, not a command the
// shell runs. Mirrors packages/sdk/test/onboarding.test.ts ("ci --hooks: the
// stale-index message is literal text, not a command the hook runs"); a stub
// `leji` stands in for the CLI so the test needs no built binary, and the marker
// it would leave behind proves whether the shell ran the backticked text.
func TestHookStaleIndexMessageIsLiteralNotExecuted(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh")
	}
	dir := gitInitRepo(t)
	if _, err := EnsureLocalHook(dir); err != nil {
		t.Fatalf("EnsureLocalHook: %v", err)
	}
	binDir := filepath.Join(dir, "node_modules", ".bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// validate passes, `index --check` fails (the stale-index path), and a bare
	// `index` — which only a command substitution could reach — leaves a marker.
	stub := "#!/bin/sh\n" +
		"case \"$1$2\" in\n" +
		"  validate) exit 0 ;;\n" +
		"  index--check) exit 1 ;;\n" +
		"  index) echo regenerated > \"$(dirname \"$0\")/../../ran-index\"; exit 0 ;;\n" +
		"esac\n" +
		"exit 0\n"
	if err := os.WriteFile(filepath.Join(binDir, "leji"), []byte(stub), 0o755); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command("sh", filepath.Join(".git", "hooks", "pre-commit"))
	cmd.Dir = dir
	var stderr strings.Builder
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		t.Fatal("the hook should reject the commit")
	}
	want := "leji: stored index is stale; run `leji index` and stage the result."
	if !strings.Contains(stderr.String(), want) {
		t.Fatalf("message was not literal: %q", stderr.String())
	}
	if _, statErr := os.Stat(filepath.Join(dir, "ran-index")); !os.IsNotExist(statErr) {
		t.Fatal("the hook executed `leji index` instead of printing it")
	}
}
