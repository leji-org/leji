package initcmd

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/leji-org/leji/packages/sdk-go/internal/detect"
	"github.com/leji-org/leji/packages/sdk-go/internal/ecosystem"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

// Mirrors packages/sdk/test/preflight.test.ts: the report is read-only, every probe
// failure fails closed, and only per-clone or per-user state is ever offered.

var preflightManifest = &manifest.Manifest{Leji: "1.0", RootPath: "docs/", BootProfilePath: "docs/boot-profile.md"}

var (
	claudeStartHost = &StartHost{ID: "claude-code", Bin: "claude", Name: "Claude Code"}
	codexStartHost  = &StartHost{ID: "codex", Bin: "codex", Name: "Codex"}
	copilotHost     = detectedHost("copilot", "GitHub Copilot", true)
)

// preflightGitLayer is a committed example layer in its own git repository: the shape
// every hook class is derived from.
func preflightGitLayer(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	gitRun := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v (%s)", args, err, out)
		}
	}
	gitRun("init", "-q")
	if err := os.MkdirAll(filepath.Join(dir, "docs"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "docs", "boot-profile.md"), []byte("# boot\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	gitRun("add", "-A")
	gitRun("-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-qm", "seed")
	return dir
}

type recordedProbe struct {
	bin  string
	args []string
	cwd  string
	opts RunOptions
}

// probeIO answers each Run in order (the last result repeats) and records every call,
// so a probe's argv, cwd and bounds can be asserted.
func probeIO(results []LaunchResult, answers ...string) (*HandoffIO, *[]recordedProbe, *[]string) {
	runs := []recordedProbe{}
	questions := []string{}
	idx := 0
	answered := 0
	hio := &HandoffIO{
		ReadLine: func(q, _ string) string {
			questions = append(questions, q)
			if answered < len(answers) {
				a := answers[answered]
				if len(answers) > 1 {
					answered++
				}
				return a
			}
			return ""
		},
		Run: func(bin string, args []string, cwd string, opts RunOptions) LaunchResult {
			runs = append(runs, recordedProbe{bin: bin, args: args, cwd: cwd, opts: opts})
			res := LaunchResult{Started: true, Stdout: "1.4.0\n"}
			if len(results) > 0 {
				if idx < len(results) {
					res = results[idx]
				} else {
					res = results[len(results)-1]
				}
			}
			idx++
			return res
		},
	}
	return hio, &runs, &questions
}

func okProbe() []LaunchResult { return []LaunchResult{{Started: true, Stdout: "1.4.0\n"}} }

func runFor(t *testing.T, dir string, host *StartHost, detected []detect.DetectedHost, hio *HandoffIO) PreflightResult {
	t.Helper()
	return RunPreflight(PreflightOptions{
		Root: dir, Manifest: preflightManifest, Host: host, Detected: detected, Report: ecosystem.Detect(dir),
	}, hio)
}

func rowByID(t *testing.T, checks []Check, id string) Check {
	t.Helper()
	for _, c := range checks {
		if c.ID == id {
			return c
		}
	}
	t.Fatalf("no %s check in %v", id, checks)
	return Check{}
}

func writeAt(t *testing.T, dir, rel, content string) {
	t.Helper()
	abs := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", rel, err)
	}
}

// installNodeBin writes the bin shim a Node package manager's install puts in the
// tree. The probe executes this file directly, so every Node case that expects a
// version has to have it.
func installNodeBin(t *testing.T, dir string) string {
	t.Helper()
	binDir := filepath.Join(dir, "node_modules", ".bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	abs := filepath.Join(binDir, "leji")
	if err := os.WriteFile(abs, []byte("#!/bin/sh\necho 1.4.0\n"), 0o755); err != nil {
		t.Fatalf("write shim: %v", err)
	}
	return abs
}

func gitConfigAt(t *testing.T, dir, key, value string) {
	t.Helper()
	cmd := exec.Command("git", "config", key, value)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git config: %v (%s)", err, out)
	}
}

// --- hookStatus: one class per ownership -------------------------------------

func TestHookStatusOrdinaryCloneIsPersonalAndAbsent(t *testing.T) {
	dir := preflightGitLayer(t)
	s := HookStatus(dir, []string{"leji"})
	if s.Ownership != "personal" || s.State != "absent" || s.Path != ".git/hooks/pre-commit" || s.Managed != "file" {
		t.Fatalf("status = %+v", s)
	}
}

func TestHookStatusManagedIsCurrentAndForeignIsForeign(t *testing.T) {
	dir := preflightGitLayer(t)
	if _, err := EnsureLocalHook(dir, []string{"leji"}); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if s := HookStatus(dir, []string{"leji"}); s.State != "current" {
		t.Fatalf("state = %q, want current", s.State)
	}
	writeAt(t, dir, ".git/hooks/pre-commit", "#!/bin/sh\necho mine\n")
	s := HookStatus(dir, []string{"leji"})
	if s.State != "foreign" || s.Ownership != "personal" {
		t.Fatalf("status = %+v, want foreign/personal", s)
	}
}

func TestHookStatusHuskyIsShared(t *testing.T) {
	dir := preflightGitLayer(t)
	gitConfigAt(t, dir, "core.hooksPath", ".husky/_")
	s := HookStatus(dir, []string{"leji"})
	if s.Ownership != "shared" || s.State != "absent" || s.Path != ".husky/pre-commit" || s.Managed != "block" {
		t.Fatalf("status = %+v", s)
	}
}

func TestHookStatusWorktreeHooksPathIsShared(t *testing.T) {
	dir := preflightGitLayer(t)
	gitConfigAt(t, dir, "core.hooksPath", "githooks")
	s := HookStatus(dir, []string{"leji"})
	if s.Ownership != "shared" || s.Path != "githooks/pre-commit" {
		t.Fatalf("status = %+v", s)
	}
}

func TestHookStatusGlobalHooksPathIsExternalAndReportOnly(t *testing.T) {
	dir := preflightGitLayer(t)
	outside := t.TempDir()
	gitConfigAt(t, dir, "core.hooksPath", outside)
	s := HookStatus(dir, []string{"leji"})
	if s.Ownership != "external" {
		t.Fatalf("ownership = %q, want external", s.Ownership)
	}
	hio, _, _ := probeIO(okProbe())
	row := rowByID(t, runFor(t, dir, nil, nil, hio).Checks, CheckHook)
	if row.Status != "missing" || !strings.Contains(strings.Join(row.Fix, "\n"), "leji pre-commit (managed)") {
		t.Fatalf("row = %+v", row)
	}
	if _, err := os.Stat(filepath.Join(outside, "pre-commit")); !os.IsNotExist(err) {
		t.Fatalf("the report wrote into the external hooks dir")
	}
}

func TestHookStatusLinkedWorktreeResolvesSharedHooksDirAsPersonal(t *testing.T) {
	main := preflightGitLayer(t)
	wt := filepath.Join(t.TempDir(), "wt")
	cmd := exec.Command("git", "worktree", "add", "-q", wt)
	cmd.Dir = main
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("git worktree unavailable: %v (%s)", err, out)
	}
	s := HookStatus(wt, []string{"leji"})
	// The hooks git runs live in the COMMON dir, outside this worktree. It is still
	// per-clone state, but the writer refuses everything outside the repository root,
	// so it is reported rather than offered.
	if s.Ownership != "outside-root" || s.State != "absent" {
		t.Fatalf("status = %+v", s)
	}
	hio, _, questions := probeIO(okProbe(), "y")
	res := runFor(t, wt, nil, nil, hio)
	row := rowByID(t, res.Checks, CheckHook)
	if row.Status != "missing" || !strings.Contains(row.Detail, "hooks dir is outside this worktree") ||
		!strings.Contains(strings.Join(row.Fix, "\n"), "leji pre-commit (managed)") {
		t.Fatalf("row = %+v", row)
	}
	OfferPreflightFixes(PreflightOfferOptions{Root: wt, Host: nil, Result: res, Runner: []string{"leji"}, Interactive: true}, hio, &strings.Builder{})
	if len(*questions) != 0 {
		t.Fatalf("a target outside the worktree is never offered: %v", *questions)
	}
	if _, err := os.Stat(filepath.Join(main, ".git", "hooks", "pre-commit")); !os.IsNotExist(err) {
		t.Fatalf("a hook was written for a linked worktree")
	}
}

func TestHookStatusNonRepositoryIsNoGit(t *testing.T) {
	s := HookStatus(t.TempDir(), []string{"leji"})
	if s.Ownership != "no-git" || s.Path != "" {
		t.Fatalf("status = %+v", s)
	}
}

// --- the version probe --------------------------------------------------------

func TestCLIUndeclaredIsASharedGapCarryingTheDeclareCommand(t *testing.T) {
	dir := preflightGitLayer(t)
	writeAt(t, dir, "package.json", `{"name":"app","packageManager":"pnpm@9.0.0"}`+"\n")
	hio, _, _ := probeIO([]LaunchResult{{Started: false, Err: errors.New("spawn leji ENOENT")}})
	res := runFor(t, dir, nil, nil, hio)
	row := rowByID(t, res.Checks, CheckCLI)
	if row.Status != "shared-gap" || !reflect.DeepEqual(row.Fix, []string{"pnpm add -D @leji-org/leji"}) {
		t.Fatalf("row = %+v", row)
	}
	if res.Ready {
		t.Fatalf("a shared cli gap still leaves the clone unready")
	}
}

func TestCLIUndeclaredNamesAnAmbientLejiAsYourOwnInstall(t *testing.T) {
	dir := preflightGitLayer(t)
	writeAt(t, dir, "package.json", `{"name":"app"}`+"\n")
	hio, _, _ := probeIO(okProbe())
	row := rowByID(t, runFor(t, dir, nil, nil, hio).Checks, CheckCLI)
	if row.Detail != "not declared here (PATH has your own 1.4.0)" {
		t.Fatalf("detail = %q", row.Detail)
	}
}

func TestCLIDeclaredNodeIsProbedByExecutingTheInstalledShim(t *testing.T) {
	dir := preflightGitLayer(t)
	writeAt(t, dir, "package.json", `{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}`+"\n")
	writeAt(t, dir, "pnpm-lock.yaml", "lockfileVersion: 9\n")
	binAbs := installNodeBin(t, dir)
	hio, runs, _ := probeIO(okProbe())
	res := runFor(t, dir, nil, nil, hio)
	row := rowByID(t, res.Checks, CheckCLI)
	want := "1.4.0 (node_modules/.bin/leji)"
	if row.Status != "ok" || row.Detail != want || row.Fix != nil {
		t.Fatalf("row = %+v", row)
	}
	p := (*runs)[0]
	wantCwd, _ := filepath.Abs(dir)
	// The shim itself, by absolute path: no `pnpm exec`, no `npx`, no shell.
	wantBin := filepath.Join(wantCwd, "node_modules", ".bin", "leji")
	_ = binAbs
	if p.bin != wantBin || !reflect.DeepEqual(p.args, []string{"--version"}) || p.cwd != wantCwd {
		t.Fatalf("probe = %+v", p)
	}
	if !p.opts.Capture || !p.opts.Quiet || p.opts.TimeoutMs != 10000 || p.opts.MaxBytes != 4096 {
		t.Fatalf("probe opts = %+v", p.opts)
	}
	// The environment REPLACES this process's: no inherited PATH, no HOME of the user's.
	if p.opts.Env == nil {
		t.Fatalf("the probe passes no environment")
	}
	if p.opts.Env["PATH"] != nodeBinDir() {
		t.Fatalf("probe PATH = %q, want the node binary's dir %q", p.opts.Env["PATH"], nodeBinDir())
	}
	if p.opts.Env["HOME"] == os.Getenv("HOME") {
		t.Fatalf("the probe inherited HOME")
	}
	for _, leaked := range []string{"NODE_OPTIONS", "LD_PRELOAD", "GOPATH"} {
		if _, ok := p.opts.Env[leaked]; ok {
			t.Fatalf("%s must not reach the probe", leaked)
		}
	}
	// The clone still has no hook, so one ok row is not readiness.
	if res.Ready || rowByID(t, res.Checks, CheckHook).Status != "missing" {
		t.Fatalf("ready = %v", res.Ready)
	}
}

func TestCLINodeWithoutTheInstalledShimIsMissingAndRunsNoManager(t *testing.T) {
	dir := preflightGitLayer(t)
	writeAt(t, dir, "package.json", `{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}`+"\n")
	writeAt(t, dir, "package-lock.json", `{"lockfileVersion":3}`+"\n")
	hio, runs, _ := probeIO(okProbe())
	row := rowByID(t, runFor(t, dir, nil, nil, hio).Checks, CheckCLI)
	wantFix := []string{"npm install", "npx --no-install @leji-org/leji --version"}
	if row.Status != "missing" || row.Detail != "not installed yet (node_modules/.bin/leji)" ||
		!reflect.DeepEqual(row.Fix, wantFix) {
		t.Fatalf("row = %+v", row)
	}
	// Nothing was executed at all: a missing shim is answered from the filesystem.
	if len(*runs) != 0 {
		t.Fatalf("no probe should run when the shim is absent: %+v", *runs)
	}
}

func TestCLIShimResolvingOutsideTheRepositoryIsRefused(t *testing.T) {
	dir := preflightGitLayer(t)
	writeAt(t, dir, "package.json", `{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}`+"\n")
	writeAt(t, dir, "package-lock.json", `{"lockfileVersion":3}`+"\n")
	outside := t.TempDir()
	target := filepath.Join(outside, "leji")
	if err := os.WriteFile(target, []byte("#!/bin/sh\necho 9.9.9\n"), 0o755); err != nil {
		t.Fatalf("write: %v", err)
	}
	binDir := filepath.Join(dir, "node_modules", ".bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.Symlink(target, filepath.Join(binDir, "leji")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	hio, runs, _ := probeIO(okProbe())
	row := rowByID(t, runFor(t, dir, nil, nil, hio).Checks, CheckCLI)
	if row.Status != "missing" || len(*runs) != 0 {
		t.Fatalf("row = %+v runs = %+v", row, *runs)
	}
}

func TestCLIProbeOverridesForUvAndGo(t *testing.T) {
	uvDir := preflightGitLayer(t)
	writeAt(t, uvDir, "pyproject.toml", "[project]\nname = \"app\"\ndependencies = [\"leji\"]\n")
	writeAt(t, uvDir, "uv.lock", "version = 1\n")
	hio, runs, _ := probeIO(okProbe())
	runFor(t, uvDir, nil, nil, hio)
	if !reflect.DeepEqual((*runs)[0].args, []string{"run", "--no-sync", "leji", "--version"}) {
		t.Fatalf("uv never syncs to answer a probe: %v", (*runs)[0].args)
	}

	goDir := preflightGitLayer(t)
	writeAt(t, goDir, "go.mod", "module example.com/app\n\ngo 1.24\n\ntool github.com/leji-org/leji/packages/sdk-go/cmd/leji\n")
	ghio, gruns, _ := probeIO(okProbe())
	runFor(t, goDir, nil, nil, ghio)
	if !reflect.DeepEqual((*gruns)[0].args, []string{"tool", "leji", "--version"}) {
		t.Fatalf("go probe args = %v", (*gruns)[0].args)
	}
	goEnv := (*gruns)[0].opts.Env
	for k, want := range map[string]string{"GOFLAGS": "-mod=readonly", "GOTOOLCHAIN": "local", "GOPROXY": "off", "GOWORK": "off"} {
		if goEnv[k] != want {
			t.Fatalf("go probe %s = %q, want %q", k, goEnv[k], want)
		}
	}
	// A manager has to be found on PATH, so PATH survives; nothing unrelated does.
	if goEnv["PATH"] != os.Getenv("PATH") {
		t.Fatalf("go probe PATH = %q", goEnv["PATH"])
	}
	for _, leaked := range []string{"NODE_OPTIONS", "LD_PRELOAD", "GOPRIVATE"} {
		if _, ok := goEnv[leaked]; ok {
			t.Fatalf("%s must not reach the probe", leaked)
		}
	}
}

func TestCLIEveryProbeFailureFailsClosed(t *testing.T) {
	dir := preflightGitLayer(t)
	writeAt(t, dir, "package.json", `{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}`+"\n")
	writeAt(t, dir, "package-lock.json", `{"lockfileVersion":3}`+"\n")
	installNodeBin(t, dir)
	failures := []LaunchResult{
		{Started: false, Err: errors.New("spawn npx ENOENT")},             // never started
		{Started: true, Err: errors.New("context deadline exceeded")},     // timed out
		{Started: true, Err: errors.New("exit status 1")},                 // ran, failed
		{Started: true, Stdout: "leji version one\n"},                     // malformed
		{Started: true, Stdout: "\n"},                                     // empty
		{Started: true, Err: errors.New("probe output exceeded the cap")}, // over the cap
	}
	for _, outcome := range failures {
		hio, _, _ := probeIO([]LaunchResult{outcome})
		row := rowByID(t, runFor(t, dir, nil, nil, hio).Checks, CheckCLI)
		wantFix := []string{"npm install", "npx --no-install @leji-org/leji --version"}
		if row.Status != "missing" || !reflect.DeepEqual(row.Fix, wantFix) {
			t.Fatalf("row = %+v for outcome %+v", row, outcome)
		}
	}
}

func TestCLIBelowTheSpecLineMinimumIsMissing(t *testing.T) {
	dir := preflightGitLayer(t)
	writeAt(t, dir, "package.json", `{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}`+"\n")
	installNodeBin(t, dir)
	hio, _, _ := probeIO([]LaunchResult{{Started: true, Stdout: "0.9.3\n"}})
	row := rowByID(t, runFor(t, dir, nil, nil, hio).Checks, CheckCLI)
	if row.Status != "missing" || !strings.Contains(row.Detail, "is below 1.0.0 for spec 1.0") {
		t.Fatalf("row = %+v", row)
	}
}

// --- MCP rows -----------------------------------------------------------------

func TestMcpRegisteredIsOkAndUnregisteredOffersTheUserScope(t *testing.T) {
	dir := preflightGitLayer(t)
	okIO, _, _ := probeIO([]LaunchResult{{Started: true, Stdout: "1.4.0\n"}, {Started: true}})
	if row := rowByID(t, runFor(t, dir, claudeStartHost, []detect.DetectedHost{claudeHost}, okIO).Checks, CheckMCP); row.Status != "ok" {
		t.Fatalf("row = %+v", row)
	}
	missIO, _, _ := probeIO([]LaunchResult{{Started: true, Stdout: "1.4.0\n"}, {Started: true, Err: errors.New("exit status 1")}})
	row := rowByID(t, runFor(t, dir, claudeStartHost, []detect.DetectedHost{claudeHost}, missIO).Checks, CheckMCP)
	if row.Status != "missing" || !reflect.DeepEqual(row.Fix, []string{"claude mcp add leji --scope user -- npx -y @leji-org/mcp"}) {
		t.Fatalf("row = %+v", row)
	}
}

func TestMcpCodexRegistersAtUserLevelAndHasNoSharedForm(t *testing.T) {
	dir := preflightGitLayer(t)
	hio, _, _ := probeIO([]LaunchResult{{Started: true, Stdout: "1.4.0\n"}, {Started: true, Err: errors.New("exit status 1")}})
	checks := runFor(t, dir, codexStartHost, []detect.DetectedHost{codexHost}, hio).Checks
	if row := rowByID(t, checks, CheckMCP); !reflect.DeepEqual(row.Fix, []string{"codex mcp add leji -- npx -y @leji-org/mcp"}) {
		t.Fatalf("row = %+v", row)
	}
	if row := rowByID(t, checks, CheckMCPShared); row.Status != "n/a" {
		t.Fatalf("Codex has no shared form: %+v", row)
	}
}

func TestMcpSeveralHostsAndNoPickIsUnresolved(t *testing.T) {
	dir := preflightGitLayer(t)
	hio, _, _ := probeIO(okProbe())
	row := rowByID(t, runFor(t, dir, nil, []detect.DetectedHost{claudeHost, codexHost}, hio).Checks, CheckMCP)
	if row.Status != "unresolved" || !strings.Contains(row.Detail, "Claude Code, Codex") ||
		!reflect.DeepEqual(row.Fix, []string{"leji start --agent <name>"}) {
		t.Fatalf("row = %+v", row)
	}
}

func TestMcpUnregisterableHostGetsTheStandardConfigAndItsPath(t *testing.T) {
	dir := preflightGitLayer(t)
	hio, _, _ := probeIO(okProbe())
	row := rowByID(t, runFor(t, dir, nil, []detect.DetectedHost{cursorHost}, hio).Checks, CheckMCP)
	if row.Status != "missing" || row.Fix[0] != ".cursor/mcp.json (project scope)" ||
		!strings.Contains(strings.Join(row.Fix, "\n"), `"@leji-org/mcp"`) {
		t.Fatalf("row = %+v", row)
	}
}

func TestMcpPrintedBlockTakesTheShapeTheHostConfigFileUses(t *testing.T) {
	dir := preflightGitLayer(t)
	// VS Code, which is how GitHub Copilot reads MCP servers, spells the map
	// `servers`; pasting the common `mcpServers` block into .vscode/mcp.json leaves
	// the editor with a file it ignores.
	hio, _, _ := probeIO(okProbe())
	copilot := rowByID(t, runFor(t, dir, nil, []detect.DetectedHost{copilotHost}, hio).Checks, CheckMCP)
	want := []string{
		".vscode/mcp.json (project scope)",
		"{",
		`  "servers": {`,
		`    "leji": { "command": "npx", "args": ["-y", "@leji-org/mcp"] }`,
		"  }",
		"}",
	}
	if copilot.Status != "missing" || !reflect.DeepEqual(copilot.Fix, want) {
		t.Fatalf("row = %+v", copilot)
	}
	// Every other host Leji cannot register for takes the common shape.
	chio, _, _ := probeIO(okProbe())
	cursor := rowByID(t, runFor(t, dir, nil, []detect.DetectedHost{cursorHost}, chio).Checks, CheckMCP)
	if !strings.Contains(strings.Join(cursor.Fix, "\n"), `  "mcpServers": {`) {
		t.Fatalf("row = %+v", cursor)
	}
}

func TestMcpNoDetectedHostIsSkippedAndNeverCountsAgainstReady(t *testing.T) {
	dir := preflightGitLayer(t)
	writeAt(t, dir, "package.json", `{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}`+"\n")
	installNodeBin(t, dir)
	if _, err := EnsureLocalHook(dir, []string{"leji"}); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	hio, _, _ := probeIO(okProbe())
	res := runFor(t, dir, nil, nil, hio)
	if rowByID(t, res.Checks, CheckMCP).Status != "skipped" || !res.Ready {
		t.Fatalf("checks = %+v ready = %v", res.Checks, res.Ready)
	}
}

func TestMcpSharedPresenceAndAbsence(t *testing.T) {
	dir := preflightGitLayer(t)
	absentIO, _, _ := probeIO([]LaunchResult{{Started: true, Stdout: "1.4.0\n"}, {Started: true}})
	res := runFor(t, dir, claudeStartHost, []detect.DetectedHost{claudeHost}, absentIO)
	gap := rowByID(t, res.Checks, CheckMCPShared)
	if gap.Status != "shared-gap" ||
		!reflect.DeepEqual(gap.Fix, []string{"claude mcp add leji --scope project -- npx -y @leji-org/mcp"}) {
		t.Fatalf("row = %+v", gap)
	}
	if res.Ready {
		t.Fatalf("ready is decided by cli, mcp and hook")
	}
	writeAt(t, dir, ".mcp.json", `{"mcpServers":{}}`+"\n")
	presentIO, _, _ := probeIO([]LaunchResult{{Started: true, Stdout: "1.4.0\n"}, {Started: true}})
	if row := rowByID(t, runFor(t, dir, claudeStartHost, []detect.DetectedHost{claudeHost}, presentIO).Checks, CheckMCPShared); row.Status != "ok" {
		t.Fatalf("row = %+v", row)
	}
}

func TestMcpSharedNeverDecidesReadyOnItsOwn(t *testing.T) {
	dir := preflightGitLayer(t)
	writeAt(t, dir, "package.json", `{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}`+"\n")
	installNodeBin(t, dir)
	if _, err := EnsureLocalHook(dir, []string{"npx", "--no-install", "@leji-org/leji"}); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	hio, _, _ := probeIO([]LaunchResult{{Started: true, Stdout: "1.4.0\n"}, {Started: true}})
	res := runFor(t, dir, claudeStartHost, []detect.DetectedHost{claudeHost}, hio)
	if rowByID(t, res.Checks, CheckMCPShared).Status != "shared-gap" || !res.Ready {
		t.Fatalf("checks = %+v ready = %v", res.Checks, res.Ready)
	}
}

// --- the report ---------------------------------------------------------------

func TestChecksAreAlwaysTheSameFourIdsInOrder(t *testing.T) {
	dir := preflightGitLayer(t)
	hio, _, _ := probeIO(okProbe())
	got := []string{}
	for _, c := range runFor(t, dir, claudeStartHost, []detect.DetectedHost{claudeHost}, hio).Checks {
		got = append(got, c.ID)
	}
	if !reflect.DeepEqual(got, []string{"cli", "mcp", "mcp-shared", "hook"}) {
		t.Fatalf("ids = %v", got)
	}
}

// --- the Setup block ------------------------------------------------------------
// The three scenarios the layout was cut against, as exact bytes: the other two SDKs
// print these same strings, so the render is pinned here rather than described.

// checkRow is a check exactly as the internal constructors build it.
func checkRow(id, status, detail string, fix ...string) Check {
	return newCheck(id, status, detail, fix)
}

const (
	mcpUserFix    = "claude mcp add leji --scope user -- npx -y @leji-org/mcp"
	mcpProjectFix = "claude mcp add leji --scope project -- npx -y @leji-org/mcp"
)

var startScenarios = []struct {
	name   string
	checks []Check
	want   string
}{
	{
		// Nothing is this clone's to fix: the CLI, the shared server and the hook are
		// all the repository's own state.
		name: "every gap belongs to a maintainer",
		checks: []Check{
			checkRow(CheckCLI, "shared-gap", "not declared in this repository", "npm i -D @leji-org/leji"),
			checkRow(CheckMCP, "ok", "registered for Claude Code"),
			checkRow(CheckMCPShared, "shared-gap", "no .mcp.json committed", mcpProjectFix),
			checkRow(CheckHook, "shared-gap", "no leji block in .husky/pre-commit", "leji ci --hooks"),
		},
		want: strings.Join([]string{
			"Setup for this clone",
			"",
			"  team  Leji CLI    not declared in this repository",
			"        $ npm i -D @leji-org/leji",
			"  ok    MCP server  registered for Claude Code",
			"  team  Team MCP    no .mcp.json committed",
			"        $ " + mcpProjectFix,
			"  team  Git hook    no leji block in .husky/pre-commit",
			"        $ leji ci --hooks",
			"",
			"  3 fixes for a maintainer. The agent starts either way.",
		}, "\n"),
	},
	{
		// The CLI and the hook are the maintainer's; both MCP registrations are there.
		name: "the CLI and the hook are a maintainer's, both MCP rows ok",
		checks: []Check{
			checkRow(CheckCLI, "shared-gap", "not declared here (PATH has your own 1.4.0)", "npm i -D @leji-org/leji"),
			checkRow(CheckMCP, "ok", "registered for Claude Code"),
			checkRow(CheckMCPShared, "ok", ".mcp.json committed"),
			checkRow(CheckHook, "shared-gap", "no leji block in .husky/pre-commit", "leji ci --hooks"),
		},
		want: strings.Join([]string{
			"Setup for this clone",
			"",
			"  team  Leji CLI    not declared here (PATH has your own 1.4.0)",
			"        $ npm i -D @leji-org/leji",
			"  ok    MCP server  registered for Claude Code",
			"  ok    Team MCP    .mcp.json committed",
			"  team  Git hook    no leji block in .husky/pre-commit",
			"        $ leji ci --hooks",
			"",
			"  2 fixes for a maintainer. The agent starts either way.",
		}, "\n"),
	},
	{
		// One fix each: this user's own registration, and the one a maintainer commits.
		name: "one fix for this user and one for a maintainer",
		checks: []Check{
			checkRow(CheckCLI, "ok", "1.4.0 (node_modules/.bin/leji)"),
			checkRow(CheckMCP, "missing", "not registered for Claude Code", mcpUserFix),
			checkRow(CheckMCPShared, "shared-gap", "no .mcp.json committed", mcpProjectFix),
			checkRow(CheckHook, "ok", "runs leji checks before each commit: .git/hooks/pre-commit"),
		},
		want: strings.Join([]string{
			"Setup for this clone",
			"",
			"  ok    Leji CLI    1.4.0 (node_modules/.bin/leji)",
			"  you   MCP server  not registered for Claude Code",
			"        $ " + mcpUserFix,
			"  team  Team MCP    no .mcp.json committed",
			"        $ " + mcpProjectFix,
			"  ok    Git hook    runs leji checks before each commit: .git/hooks/pre-commit",
			"",
			"  1 fix for you, 1 for a maintainer. The agent starts either way.",
		}, "\n"),
	},
}

func TestRenderPreflightScenarios(t *testing.T) {
	for _, sc := range startScenarios {
		t.Run(sc.name, func(t *testing.T) {
			block := RenderPreflight(sc.checks, false)
			if block != sc.want {
				t.Fatalf("block =\n%s\nwant\n%s", block, sc.want)
			}
			if strings.ContainsAny(block, "–—") {
				t.Fatalf("no en or em dash reaches the terminal: %q", block)
			}
		})
	}
}

func TestNoRowOfAnyScenarioWrapsAt80Columns(t *testing.T) {
	for _, sc := range startScenarios {
		for _, l := range strings.Split(RenderPreflight(sc.checks, false), "\n") {
			// Commands and snippets are exact and exempt: they are what a person pastes.
			if strings.HasPrefix(l, preflightFixIndent) {
				continue
			}
			if len(l) > 80 {
				t.Fatalf("%s: %d columns: %q", sc.name, len(l), l)
			}
		}
	}
}

func TestRenderPreflightSnippetIsPastedAndCommandCarriesThePrompt(t *testing.T) {
	snippet := RenderPreflight([]Check{
		newSnippetCheck(CheckHook, "missing", "add it yourself; hooks run from /etc/hooks", []string{"#!/bin/sh", "leji ci"}),
	}, false)
	if !strings.Contains(snippet, "\n        #!/bin/sh\n        leji ci\n") {
		t.Fatalf("block = %q", snippet)
	}
	// A Check assembled outside this file has no fix kind, and still renders as a command.
	plain := RenderPreflight([]Check{
		{ID: CheckHook, Status: "missing", Detail: "none yet (per clone)", Fix: []string{"leji ci --hooks"}},
	}, false)
	if !strings.Contains(plain, "\n        $ leji ci --hooks\n") {
		t.Fatalf("block = %q", plain)
	}
}

func TestRenderPreflightNothingOwedIsOneClosingLine(t *testing.T) {
	block := RenderPreflight([]Check{
		checkRow(CheckCLI, "ok", "1.4.0 (node_modules/.bin/leji)"),
		checkRow(CheckMCP, "skipped", "no coding agent detected"),
	}, false)
	lines := strings.Split(block, "\n")
	if lines[len(lines)-1] != "  Setup complete." {
		t.Fatalf("block = %q", block)
	}
}

// --- the color convention -------------------------------------------------------

func TestRenderPreflightColorOffLeavesNotOneEscapeByte(t *testing.T) {
	for _, sc := range startScenarios {
		if strings.Contains(RenderPreflight(sc.checks, false), "\x1b") {
			t.Fatalf("%s: an escape reached a plain render", sc.name)
		}
	}
}

func TestRenderPreflightColorOnWrapsTheStatusWordOnly(t *testing.T) {
	block := RenderPreflight([]Check{
		checkRow(CheckCLI, "ok", "1.4.0 (node_modules/.bin/leji)"),
		checkRow(CheckMCP, "missing", "not registered for Claude Code"),
		checkRow(CheckMCPShared, "shared-gap", "no .mcp.json committed"),
		checkRow(CheckHook, "n/a", "not a git repository"),
	}, true)
	want := strings.Join([]string{
		"Setup for this clone",
		"",
		"  \x1b[32mok\x1b[0m    Leji CLI    1.4.0 (node_modules/.bin/leji)",
		"  \x1b[33myou\x1b[0m   MCP server  not registered for Claude Code",
		"  \x1b[36mteam\x1b[0m  Team MCP    no .mcp.json committed",
		"  \x1b[2mn/a\x1b[0m   Git hook    not a git repository",
		"",
		"  1 fix for you, 1 for a maintainer. The agent starts either way.",
	}, "\n")
	if block != want {
		t.Fatalf("block =\n%q\nwant\n%q", block, want)
	}
}

func TestColorDecisionIsATerminalThatHasNotAskedForPlainText(t *testing.T) {
	lookup := func(m map[string]string) func(string) (string, bool) {
		return func(k string) (string, bool) {
			v, ok := m[k]
			return v, ok
		}
	}
	cases := []struct {
		isTTY bool
		env   map[string]string
		want  bool
	}{
		{true, map[string]string{}, true},
		{false, map[string]string{}, false},
		{true, map[string]string{"NO_COLOR": "1"}, false},
		{true, map[string]string{"NO_COLOR": ""}, false},
		{false, map[string]string{"NO_COLOR": ""}, false},
		{true, map[string]string{"TERM": "dumb"}, false},
		{true, map[string]string{"TERM": "xterm-256color"}, true},
		{false, map[string]string{"TERM": "xterm-256color"}, false},
	}
	for _, c := range cases {
		if got := ColorDecision(c.isTTY, lookup(c.env)); got != c.want {
			t.Fatalf("ColorDecision(%v, %v) = %v", c.isTTY, c.env, got)
		}
	}
}

// --- the consented repairs ----------------------------------------------------

func TestOfferPreflightFixesWritesNothingNonInteractively(t *testing.T) {
	dir := preflightGitLayer(t)
	hio, runs, questions := probeIO([]LaunchResult{{Started: true, Stdout: "1.4.0\n"}, {Started: true, Err: errors.New("exit status 1")}})
	res := runFor(t, dir, claudeStartHost, []detect.DetectedHost{claudeHost}, hio)
	before := len(*runs)
	OfferPreflightFixes(PreflightOfferOptions{Root: dir, Host: claudeStartHost, Result: res, Runner: []string{"leji"}, Interactive: false}, hio, &strings.Builder{})
	if len(*questions) != 0 || len(*runs) != before {
		t.Fatalf("questions=%v runs=%d", *questions, len(*runs))
	}
	if _, err := os.Stat(filepath.Join(dir, ".git", "hooks", "pre-commit")); !os.IsNotExist(err) {
		t.Fatalf("a non-interactive run wrote the hook")
	}
}

func TestOfferPreflightFixesRegistersThenInstallsInThatOrder(t *testing.T) {
	dir := preflightGitLayer(t)
	hio, runs, questions := probeIO([]LaunchResult{{Started: true, Stdout: "1.4.0\n"}, {Started: true, Err: errors.New("exit status 1")}, {Started: true}}, "y")
	res := runFor(t, dir, claudeStartHost, []detect.DetectedHost{claudeHost}, hio)
	OfferPreflightFixes(PreflightOfferOptions{Root: dir, Host: claudeStartHost, Result: res, Runner: []string{"leji"}, Interactive: true}, hio, &strings.Builder{})
	if len(*questions) != 2 || !strings.Contains((*questions)[0], "Register the Leji MCP server for Claude Code") ||
		!strings.Contains((*questions)[1], "Install the pre-commit hook") {
		t.Fatalf("questions = %v", *questions)
	}
	last := (*runs)[len(*runs)-1]
	want := []string{"mcp", "add", "leji", "--scope", "user", "--", "npx", "-y", "@leji-org/mcp"}
	if !reflect.DeepEqual(last.args, want) {
		t.Fatalf("registration = %v", last.args)
	}
	if _, err := os.Stat(filepath.Join(dir, ".git", "hooks", "pre-commit")); err != nil {
		t.Fatalf("the clone hook was not written: %v", err)
	}
}

func TestOfferPreflightFixesNeverOffersASharedGap(t *testing.T) {
	dir := preflightGitLayer(t)
	gitConfigAt(t, dir, "core.hooksPath", ".husky/_")
	hio, _, questions := probeIO(okProbe(), "y")
	res := runFor(t, dir, nil, nil, hio)
	if rowByID(t, res.Checks, CheckHook).Status != "shared-gap" {
		t.Fatalf("checks = %+v", res.Checks)
	}
	OfferPreflightFixes(PreflightOfferOptions{Root: dir, Host: nil, Result: res, Runner: []string{"leji"}, Interactive: true}, hio, &strings.Builder{})
	if len(*questions) != 0 {
		t.Fatalf("a committed hook is a maintainer decision: %v", *questions)
	}
	if _, err := os.Stat(filepath.Join(dir, ".husky", "pre-commit")); !os.IsNotExist(err) {
		t.Fatalf("the shared hook was written")
	}
}

func TestOfferPreflightFixesDeclinesCleanly(t *testing.T) {
	dir := preflightGitLayer(t)
	hio, _, questions := probeIO([]LaunchResult{{Started: true, Stdout: "1.4.0\n"}, {Started: true, Err: errors.New("exit status 1")}}, "n")
	res := runFor(t, dir, claudeStartHost, []detect.DetectedHost{claudeHost}, hio)
	OfferPreflightFixes(PreflightOfferOptions{Root: dir, Host: claudeStartHost, Result: res, Runner: []string{"leji"}, Interactive: true}, hio, &strings.Builder{})
	if len(*questions) != 2 {
		t.Fatalf("questions = %v", *questions)
	}
	if _, err := os.Stat(filepath.Join(dir, ".git", "hooks", "pre-commit")); !os.IsNotExist(err) {
		t.Fatalf("a declined offer wrote the hook")
	}
}

func TestSecondRunOfAnAllOkCloneOffersNothing(t *testing.T) {
	dir := preflightGitLayer(t)
	writeAt(t, dir, "package.json", `{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}`+"\n")
	writeAt(t, dir, ".mcp.json", `{"mcpServers":{}}`+"\n")
	installNodeBin(t, dir)
	if _, err := EnsureLocalHook(dir, []string{"npx", "--no-install", "@leji-org/leji"}); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	hio, _, questions := probeIO([]LaunchResult{{Started: true, Stdout: "1.4.0\n"}, {Started: true}}, "y")
	res := runFor(t, dir, claudeStartHost, []detect.DetectedHost{claudeHost}, hio)
	for _, c := range res.Checks {
		if c.Status != "ok" {
			t.Fatalf("checks = %+v", res.Checks)
		}
	}
	if !res.Ready {
		t.Fatalf("ready = false")
	}
	OfferPreflightFixes(PreflightOfferOptions{Root: dir, Host: claudeStartHost, Result: res, Runner: []string{"leji"}, Interactive: true}, hio, &strings.Builder{})
	if len(*questions) != 0 {
		t.Fatalf("questions = %v", *questions)
	}
}

// --- the capture bounds, against a real child ---------------------------------
// The probe's two guarantees are about THIS process: nothing of its environment
// reaches the child, and nothing the child prints can grow past the cap or outlast
// the deadline. Both are exercised against real programs, not fakes.

// captureStub writes an executable /bin/sh script and returns its path.
func captureStub(t *testing.T, dir, name, body string) string {
	t.Helper()
	abs := filepath.Join(dir, name)
	if err := os.WriteFile(abs, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatalf("write stub: %v", err)
	}
	return abs
}

const captureCanaryVar = "LEJI_PROBE_CANARY"

// The deadline a run that must NOT reach it is given: generous enough that a loaded
// runner cannot trip it, so finishing early can only mean the cap cut the child off.
const overflowTimeoutMs = 30000

// The bound a terminated run has to finish inside: far below the deadline above, and
// far above anything scheduling delay on a busy machine can add. What it proves is
// which mechanism ended the run, not how fast the machine is.
const promptWithin = 15 * time.Second

// How long a stub holds stdout open after it has said its piece: longer than every
// deadline in this file, so a run that ended early ended because leji ended it and not
// because the child happened to exit.
const stubHold = "sleep 60"

func TestCaptureReplacesTheEnvironmentRatherThanExtendingIt(t *testing.T) {
	dir := t.TempDir()
	stub := captureStub(t, dir, "echo-canary", `printf '%s' "${`+captureCanaryVar+`:-}"`)
	t.Setenv(captureCanaryVar, "leaked")

	// The parent has it; the probe's environment does not, because Env replaces.
	res := captureRun(stub, nil, dir, RunOptions{
		Capture: true, TimeoutMs: 10000, MaxBytes: 4096, Env: map[string]string{"PATH": "/usr/bin:/bin"},
	})
	if !res.Started || res.Err != nil {
		t.Fatalf("res = %+v", res)
	}
	if res.Stdout != "" {
		t.Fatalf("the parent's %s reached the probe: %q", captureCanaryVar, res.Stdout)
	}
	// The positive control: what the caller names IS present, so the empty result
	// above is replacement rather than a stub that cannot see any environment.
	kept := captureRun(stub, nil, dir, RunOptions{
		Capture: true, TimeoutMs: 10000, MaxBytes: 4096,
		Env: map[string]string{"PATH": "/usr/bin:/bin", captureCanaryVar: "named"},
	})
	if kept.Stdout != "named" {
		t.Fatalf("a named variable did not reach the probe: %+v", kept)
	}
}

func TestCaptureKillsAChildThatStreamsPastTheCap(t *testing.T) {
	dir := t.TempDir()
	// 1 MiB in 1 KiB writes, far past the cap, then a slow tail: a run that did not
	// kill the child at the cap would still be waiting when the deadline arrives.
	stub := captureStub(t, dir, "flood", "i=0\nwhile [ $i -lt 1024 ]; do printf '%1024s' ''; i=$((i+1)); done\n"+stubHold)
	started := time.Now()
	res := captureRun(stub, nil, dir, RunOptions{Capture: true, TimeoutMs: overflowTimeoutMs, MaxBytes: 4096})
	elapsed := time.Since(started)
	if !res.Started || res.Err == nil || res.Err.Error() != "probe output exceeded the cap" {
		t.Fatalf("res = %+v", res)
	}
	if len(res.Stdout) > 4096 {
		t.Fatalf("held %d bytes, more than the cap", len(res.Stdout))
	}
	if elapsed >= promptWithin {
		t.Fatalf("the cap did not cut the child off: %s, against a %dms deadline", elapsed, overflowTimeoutMs)
	}
}

func TestCaptureEndsASparseOverflowPromptly(t *testing.T) {
	// One byte past the cap, then a child that holds stdout open and does nothing. The
	// overflow has to be decided from that single byte, not from a full buffer or from
	// EOF, or the run would sit until the deadline.
	dir := t.TempDir()
	const cap = 64
	stub := captureStub(t, dir, "trickle", "printf '%"+strconv.Itoa(cap+1)+"s' ''\n"+stubHold)
	started := time.Now()
	res := captureRun(stub, nil, dir, RunOptions{Capture: true, TimeoutMs: overflowTimeoutMs, MaxBytes: cap})
	elapsed := time.Since(started)
	if !res.Started || res.Err == nil || res.Err.Error() != "probe output exceeded the cap" {
		t.Fatalf("res = %+v", res)
	}
	if elapsed >= promptWithin {
		t.Fatalf("a sparse overflow waited for the deadline: %s, against a %dms deadline", elapsed, overflowTimeoutMs)
	}
}

func TestCaptureCapBoundary(t *testing.T) {
	dir := t.TempDir()
	const cap = 64
	for _, tc := range []struct {
		name   string
		size   int
		capped bool
	}{
		{"below the cap", cap - 1, false},
		{"exactly the cap", cap, false},
		{"one past the cap", cap + 1, true},
	} {
		stub := captureStub(t, dir, "size-"+tc.name[:5]+strconv.Itoa(tc.size),
			"printf '%"+strconv.Itoa(tc.size)+"s' ''")
		res := captureRun(stub, nil, dir, RunOptions{Capture: true, TimeoutMs: 10000, MaxBytes: cap})
		gotCapped := res.Err != nil && res.Err.Error() == "probe output exceeded the cap"
		if gotCapped != tc.capped {
			t.Fatalf("%s (%d bytes): capped = %v, want %v (res %+v)", tc.name, tc.size, gotCapped, tc.capped, res)
		}
		if !tc.capped && len(res.Stdout) != tc.size {
			t.Fatalf("%s: held %d bytes, want %d", tc.name, len(res.Stdout), tc.size)
		}
	}
}

func TestCaptureTimesOutAChildThatNeverFinishes(t *testing.T) {
	dir := t.TempDir()
	stub := captureStub(t, dir, "hang", stubHold)
	started := time.Now()
	res := captureRun(stub, nil, dir, RunOptions{Capture: true, TimeoutMs: 500, MaxBytes: 4096})
	elapsed := time.Since(started)
	if !res.Started || res.Err == nil {
		t.Fatalf("res = %+v", res)
	}
	// Here the deadline IS the mechanism under test; the bound only has to separate it
	// from the child's own 60s, with room for a loaded runner.
	if elapsed >= promptWithin {
		t.Fatalf("the timeout did not end the run (%s)", elapsed)
	}
}
