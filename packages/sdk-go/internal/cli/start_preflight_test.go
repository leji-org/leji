package cli

import (
	"encoding/json"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// `leji start` end to end, through the real command surface. Everything the command
// could reach outside the repository is a stub on a synthetic PATH: the CLI it
// probes, the agent host binaries, and the host commands it would run. Nothing real
// is launched or installed here, and the runs are non-interactive (the test process
// has no TTY on stdin), so no prompt can fire either. Mirrors
// packages/sdk/test/proc/start.test.ts.

// gitBin is the real git binary, the one program these runs cannot stub: the hook
// check asks git where hooks live.
func gitBin(t *testing.T) string {
	t.Helper()
	p, err := exec.LookPath("git")
	if err != nil {
		t.Skipf("git not available: %v", err)
	}
	return p
}

// startStubs builds a directory of executable stubs plus a link to the real git. It
// is the WHOLE PATH of every run below, so what host detection finds is exactly what
// a case declares and never whatever the machine running the suite has installed.
func startStubs(t *testing.T, spec map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range spec {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
			t.Fatalf("stub %s: %v", name, err)
		}
	}
	if err := os.Symlink(gitBin(t), filepath.Join(dir, "git")); err != nil {
		t.Fatalf("git link: %v", err)
	}
	return dir
}

const versionStub = "echo 1.4.0"

func copyTree(t *testing.T, src, dst string) {
	t.Helper()
	err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, info.Mode().Perm())
	})
	if err != nil {
		t.Fatalf("copy %s: %v", src, err)
	}
}

// startFixture copies one seeded joiner root from fixtures/start-preflight/, commits
// it, and points the environment at the stubs the case declares.
func startFixture(t *testing.T, name string, stubs map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	copyTree(t, filepath.Join(repoRoot(t), "fixtures", "start-preflight", name), dir)
	// What the manager's own install would have produced for a Node repository. The
	// probe executes this file directly; no `npx`/`pnpm exec` stub exists, and none is
	// needed.
	if pkg, err := os.ReadFile(filepath.Join(dir, "package.json")); err == nil && strings.Contains(string(pkg), "@leji-org/leji") {
		binDir := filepath.Join(dir, "node_modules", ".bin")
		if err := os.MkdirAll(binDir, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(filepath.Join(binDir, "leji"), []byte("#!/bin/sh\n"+versionStub+"\n"), 0o755); err != nil {
			t.Fatalf("write shim: %v", err)
		}
	}
	stubDir := startStubs(t, stubs)
	t.Setenv("PATH", stubDir)
	t.Setenv("HOME", t.TempDir())
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v (%s)", args, err, out)
		}
	}
	git("init", "-q")
	git("add", "-A")
	git("-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-qm", "seed")
	return dir
}

type startDoc struct {
	Command string `json:"command"`
	OK      bool   `json:"ok"`
	Ready   bool   `json:"ready"`
	Error   string `json:"error"`
	Checks  []struct {
		ID     string   `json:"id"`
		Status string   `json:"status"`
		Detail string   `json:"detail"`
		Fix    []string `json:"fix"`
	} `json:"checks"`
	Ecosystem struct {
		Selected *struct {
			Manager string `json:"manager"`
		} `json:"selected"`
	} `json:"ecosystem"`
}

func decodeStart(t *testing.T, out string) startDoc {
	t.Helper()
	var doc startDoc
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("start --json is not one document: %v\n%s", err, out)
	}
	return doc
}

func checkIDs(doc startDoc) []string {
	ids := make([]string, 0, len(doc.Checks))
	for _, c := range doc.Checks {
		ids = append(ids, c.ID)
	}
	return ids
}

func TestStartPrintsTheSetupBlockBeforeTheEntryInstructions(t *testing.T) {
	dir := startFixture(t, "node-declared", map[string]string{"leji": versionStub})
	code, out, errs := captureRun(t, []string{"start", "--root", dir})
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errs)
	}
	setup := strings.Index(out, "Setup for this clone")
	entry := strings.Index(out, "No coding agent was launched.")
	if setup < 0 || entry <= setup {
		t.Fatalf("the block must print above the entry instructions:\n%s", out)
	}
	if strings.Contains(out, "Starting ") {
		t.Fatalf("a non-interactive run never launches a host:\n%s", out)
	}
	for _, want := range []string{
		"\n  ok    Leji CLI    1.4.0 (node_modules/.bin/leji)\n",
		"\n  n/a   MCP server  no coding agent detected\n",
		"\n  you   Git hook    none yet (per clone)\n",
		"\n        $ leji ci --hooks\n",
		"\n  1 fix for you. The agent starts either way.\n",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in:\n%s", want, out)
		}
	}
	if strings.Contains(out, "\x1b") {
		t.Fatalf("a piped run carries no escape:\n%s", out)
	}
}

func TestStartUndeclaredRepositoryReportsASharedGapAtExitZero(t *testing.T) {
	dir := startFixture(t, "node-undeclared", map[string]string{"leji": versionStub})
	code, out, errs := captureRun(t, []string{"start", "--root", dir})
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errs)
	}
	if !strings.Contains(out, "\n  team  Leji CLI    not declared") ||
		!strings.Contains(out, "\n        $ npm i -D @leji-org/leji\n") {
		t.Fatalf("out:\n%s", out)
	}
}

func TestStartJSONIsOneReportOnlyDocument(t *testing.T) {
	dir := startFixture(t, "node-declared", map[string]string{"leji": versionStub, "claude": "exit 1"})
	code, out, errs := captureRun(t, []string{"start", "--root", dir, "--json"})
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errs)
	}
	doc := decodeStart(t, out)
	if doc.Command != "start" || !doc.OK || doc.Ready {
		t.Fatalf("doc = %+v", doc)
	}
	if got := checkIDs(doc); strings.Join(got, ",") != "cli,mcp,mcp-shared,hook" {
		t.Fatalf("ids = %v", got)
	}
	if doc.Checks[0].Status != "ok" || doc.Checks[1].Status != "missing" ||
		doc.Checks[2].Status != "shared-gap" || doc.Checks[3].Status != "missing" {
		t.Fatalf("statuses = %+v", doc.Checks)
	}
	if len(doc.Checks[1].Fix) != 1 || doc.Checks[1].Fix[0] != "claude mcp add leji --scope user -- npx -y @leji-org/mcp" {
		t.Fatalf("mcp fix = %v", doc.Checks[1].Fix)
	}
	if doc.Ecosystem.Selected == nil || doc.Ecosystem.Selected.Manager != "npm" {
		t.Fatalf("ecosystem = %+v", doc.Ecosystem)
	}
	if strings.Contains(out, "Setup for this clone") {
		t.Fatalf("no human block in a document mode:\n%s", out)
	}
}

func TestStartJSONChecksPublishExactlyFourKeys(t *testing.T) {
	dir := startFixture(t, "node-declared", map[string]string{"leji": versionStub, "claude": "exit 1"})
	code, out, errs := captureRun(t, []string{"start", "--root", dir, "--json"})
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errs)
	}
	var raw struct {
		Checks []map[string]json.RawMessage `json:"checks"`
	}
	if err := json.Unmarshal([]byte(out), &raw); err != nil {
		t.Fatalf("start --json is not one document: %v\n%s", err, out)
	}
	if len(raw.Checks) != 4 {
		t.Fatalf("checks = %d", len(raw.Checks))
	}
	for _, c := range raw.Checks {
		if len(c) != 4 {
			t.Fatalf("a check publishes more than the four contract keys: %v", c)
		}
		for _, k := range []string{"id", "status", "detail", "fix"} {
			if _, ok := c[k]; !ok {
				t.Fatalf("a check is missing %q: %v", k, c)
			}
		}
	}
	// The render-only fix kind is not a document field, at any spelling.
	if strings.Contains(out, "fixKind") || strings.Contains(out, "fix_kind") {
		t.Fatalf("a render-only field reached the document:\n%s", out)
	}
}

func TestStartJSONReportsReadyOnceThePersonalGapsAreClosed(t *testing.T) {
	dir := startFixture(t, "node-mcp-json", map[string]string{"leji": versionStub, "claude": "exit 0"})
	if code, _, errs := captureRun(t, []string{"ci", "--hooks", "--root", dir}); code != 0 {
		t.Fatalf("ci --hooks exit %d: %s", code, errs)
	}
	code, out, errs := captureRun(t, []string{"start", "--root", dir, "--json"})
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errs)
	}
	doc := decodeStart(t, out)
	if !doc.Ready {
		t.Fatalf("doc = %+v", doc)
	}
	for _, c := range doc.Checks {
		if c.Status != "ok" {
			t.Fatalf("checks = %+v", doc.Checks)
		}
	}
}

func TestStartJSONSeveralHostsAndNoAgentIsUnresolved(t *testing.T) {
	dir := startFixture(t, "node-declared", map[string]string{
		"leji": versionStub, "claude": "exit 1", "codex": "exit 1",
	})
	code, out, _ := captureRun(t, []string{"start", "--root", dir, "--json"})
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	doc := decodeStart(t, out)
	if doc.Checks[1].Status != "unresolved" || len(doc.Checks[1].Fix) != 1 ||
		doc.Checks[1].Fix[0] != "leji start --agent <name>" || doc.Checks[2].Status != "n/a" {
		t.Fatalf("checks = %+v", doc.Checks)
	}
}

func TestStartJSONAgentPinsTheHostTheMcpRowsAnswerFor(t *testing.T) {
	dir := startFixture(t, "node-declared", map[string]string{
		"leji": versionStub, "claude": "exit 1", "codex": "exit 1",
	})
	code, out, _ := captureRun(t, []string{"start", "--root", dir, "--agent", "claude-code", "--json"})
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	doc := decodeStart(t, out)
	if doc.Checks[1].Status != "missing" || doc.Checks[2].Status != "shared-gap" {
		t.Fatalf("checks = %+v", doc.Checks)
	}
}

func TestStartAgentBogusJSONIsAUsageError(t *testing.T) {
	dir := startFixture(t, "node-declared", map[string]string{"leji": versionStub})
	code, out, errs := captureRun(t, []string{"start", "--root", dir, "--agent", "bogus", "--json"})
	if code != 2 || !strings.Contains(errs, "--agent must be a launchable host") {
		t.Fatalf("code=%d err=%q", code, errs)
	}
	if strings.TrimSpace(out) != "" {
		t.Fatalf("no document is emitted for a rejected argument: %q", out)
	}
}

func TestStartJSONBootMissingIsTheErrorDocument(t *testing.T) {
	dir := startFixture(t, "node-declared", map[string]string{"leji": versionStub})
	if err := os.Remove(filepath.Join(dir, "docs", "boot-profile.md")); err != nil {
		t.Fatalf("remove: %v", err)
	}
	code, out, _ := captureRun(t, []string{"start", "--root", dir, "--json"})
	if code != 1 {
		t.Fatalf("exit %d", code)
	}
	doc := decodeStart(t, out)
	if doc.OK || doc.Ready || doc.Error != "boot-missing" || len(doc.Checks) != 0 {
		t.Fatalf("doc = %+v", doc)
	}
}

func TestStartNoManifestIsTheFindingsEnvelope(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", startStubs(t, map[string]string{}))
	t.Setenv("HOME", t.TempDir())
	code, out, _ := captureRun(t, []string{"start", "--root", dir, "--json"})
	if code != 1 {
		t.Fatalf("exit %d", code)
	}
	var envelope struct {
		Command  string `json:"command"`
		OK       bool   `json:"ok"`
		Findings []any  `json:"findings"`
	}
	if err := json.Unmarshal([]byte(out), &envelope); err != nil {
		t.Fatalf("not a document: %v\n%s", err, out)
	}
	if envelope.Command != "start" || envelope.OK || envelope.Findings == nil {
		t.Fatalf("envelope = %+v", envelope)
	}
}
