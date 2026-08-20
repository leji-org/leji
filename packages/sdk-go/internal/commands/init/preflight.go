package initcmd

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	"github.com/leji-org/leji/packages/sdk-go/internal/detect"
	"github.com/leji-org/leji/packages/sdk-go/internal/ecosystem"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

// `leji start`'s preflight: what a person who just cloned an adopted repository has
// to fix before the layer's tooling actually works here, computed READ-ONLY and
// reported as a fixed list of rows. Transcribes packages/sdk/src/commands/preflight.ts.
//
// The distinction the whole report turns on is who owns each gap. A gap in state that
// lives in this clone or in this user's own configuration is PERSONAL: it is offered,
// on a real terminal, and otherwise printed as an exact command. A gap in state the
// repository commits is SHARED: it is reported with the maintainer's command and
// never repaired here, because that write would land in files the whole team owns.
// Nothing here blocks entry either way: the agent still boots, and --json's `ready`
// is the scriptable signal.

// Check ids, in the fixed order every report and every SDK prints them.
const (
	CheckCLI       = "cli"
	CheckMCP       = "mcp"
	CheckMCPShared = "mcp-shared"
	CheckHook      = "hook"
)

// Check is what one check found. "ok" needs nothing; "missing" is personal (offered
// here, or printed); "shared-gap" is the repository's own state, for a maintainer;
// "skipped" means the check does not apply to this machine; "n/a" means it does not
// apply to this host; "unresolved" means the run could not tell which host to answer
// for.
type Check struct {
	ID     string
	Status string
	Detail string
	// Fix is the exact commands that close this gap, or nil when there is nothing
	// to run.
	Fix []string
	// fixKind is how the fix prints: a command line takes the "$ " prompt, a snippet
	// is pasted as it stands (a config block, a hook body). Unexported, so it can
	// never reach the --json document, which publishes exactly four keys.
	fixKind string
}

// How a fix prints. Every check built here sets one; the zero value renders as a
// command, which is what a Check assembled outside this file gets.
const (
	fixKindCommand = "command"
	fixKindSnippet = "snippet"
)

// PreflightResult is the whole read-only answer.
type PreflightResult struct {
	// Ready is true when every check whose id is cli, mcp or hook is ok, skipped, or
	// not applicable. The shared MCP row is project hygiene and never counts against it.
	Ready  bool
	Checks []Check
	// Hook is the resolved hook target, so the consent step acts on what the report saw.
	Hook HookReport
}

// --- the text table -------------------------------------------------------
// Every string the Setup block prints lives here once, so the three SDKs transcribe
// one table rather than re-deriving prose.

// The block's fixed geometry: <margin><status><gutter><subject><gutter><detail>, so
// every detail starts at the same column and the status word is the first thing read.
// A fix line is indented under the SUBJECT column, a half indent that reads as
// "belongs to the row above" and keeps long commands inside 80 columns.
const (
	preflightMargin       = "  "
	preflightGutter       = "  "
	preflightStatusWidth  = 4
	preflightSubjectWidth = 10
	preflightFixIndent    = "        "
)

// minSDKForSpecLine is the lowest SDK version that shipped support for a spec line.
// A layer declares exactly one version expectation, its spec line; this is what that
// expectation means for the CLI resolved here. The comparison is on the major, which
// is where a line's support is added or dropped.
var minSDKForSpecLine = map[string]string{"1.0": "1.0.0"}

// startStatusLabel is the word that names WHO owns the row. The status values stay
// the contract; these labels are what a person reads, and several statuses share one.
var startStatusLabel = map[string]string{
	"ok":         "ok",
	"missing":    "you",
	"shared-gap": "team",
	"skipped":    "n/a",
	"n/a":        "n/a",
	"unresolved": "you",
}

var startSubject = map[string]string{
	CheckCLI:       "Leji CLI",
	CheckMCP:       "MCP server",
	CheckMCPShared: "Team MCP",
	CheckHook:      "Git hook",
}

// Every detail is one short clause. Where a template carries a path, the path is its
// LAST token: a row that overflows overflows into the path, never through the prose,
// and nothing here is ever clipped (a truncated path misleads).
const (
	startHeading = "Setup for this clone"

	textCLIUndeclared          = "not declared in this repository"
	textMCPNone                = "no coding agent detected"
	textMCPSharedOther         = "none for this host"
	textMCPSharedNoHost        = "no host selected"
	textHookNoGit              = "not a git repository"
	textHookAbsentPersonal     = "none yet (per clone)"
	textSummaryComplete        = "Setup complete."
	textOfferHook              = "Install the pre-commit hook for this clone (validate + index --check)?"
	textOfferHookFailed        = "The hook could not be written here; add it yourself:"
	textOfferPrompt            = "Y/n"
	startPreflightAgentFixLine = "leji start --agent <name>"
)

func textCLIOk(version, runner string) string {
	return version + " (" + runner + ")"
}

func textCLIBelowMinimum(version, runner, minimum, line string) string {
	return version + " (" + runner + ") is below " + minimum + " for spec " + line
}

func textCLIUnresolvable(runner string) string {
	return runner + " reported no version here"
}

func textCLIUnresolvableNoInstall(runner string) string {
	return runner + " reported no version; run this repo's install"
}

func textCLINotInstalled(bin string) string {
	return "not installed yet (" + bin + ")"
}

func textCLIVerify(runner string) string {
	return runner + " --version"
}

func textCLIUndeclaredAmbient(version string) string {
	return "not declared here (PATH has your own " + version + ")"
}

func textMCPRegistered(host string) string { return "registered for " + host }
func textMCPMissing(host string) string    { return "not registered for " + host }

func textMCPManual(host string) string {
	return "not registered for " + host + "; add it yourself:"
}

// textMCPManualPath is the first line of that snippet: where the block goes, and at
// which scope.
func textMCPManualPath(config, scope string) string {
	return config + " (" + scope + " scope)"
}

func textMCPUnresolved(hosts []string) string {
	return "pick one: " + strings.Join(hosts, ", ")
}

func textMCPSharedPresent(file string) string {
	return file + " committed"
}

func textMCPSharedAbsent(file string) string {
	return "no " + file + " committed"
}

func textHookCurrent(target string) string {
	return "runs leji checks before each commit: " + target
}

func textHookAbsentShared(target string) string {
	return "no leji block in " + target
}

func textHookForeign(target string) string {
	return "not leji-managed; add the block to " + target
}

func textHookOutsideRoot(target string) string {
	return "hooks dir is outside this worktree: " + target
}

func textHookExternal(target string) string {
	return "add it yourself; hooks run from " + target
}

// The closing line: who owes how many fixes, and that neither answer blocks entry.
func textSummaryFixes(n int) string {
	if n == 1 {
		return "1 fix"
	}
	return strconv.Itoa(n) + " fixes"
}

func textSummaryYou(fixes string) string {
	return fixes + " for you. The agent starts either way."
}

func textSummaryTeam(fixes string) string {
	return fixes + " for a maintainer. The agent starts either way."
}

func textSummaryBoth(fixes string, team int) string {
	return fixes + " for you, " + strconv.Itoa(team) + " for a maintainer. The agent starts either way."
}

func textOfferMcp(host string) string {
	return "Register the Leji MCP server for " + host + " for your user?"
}

func textOfferMcpDone(host string) string {
	return "Registered the Leji MCP server for " + host + "."
}

func textOfferMcpFailed(bin string) string {
	return bin + " did not register cleanly; run it yourself:"
}

func textOfferHookDone(target string) string {
	return "Wrote " + target + "; it runs before every commit in this clone."
}

// --- the version probe ----------------------------------------------------

// How long a probe may take, and how much of its output is read. A probe that
// exceeds either bound fails closed, exactly like one that never started.
const (
	probeTimeoutMs = 10000
	probeMaxBytes  = 4096
)

// nodeBinRel is the one path a probe may execute directly: the bin shim a Node
// package manager installs for the declared dependency. It is a file this
// repository's own install put there, not a script the repository authors, which is
// the whole reason it is safe to run when npm/pnpm/yarn/bun are not.
const nodeBinRel = "node_modules/.bin/leji"

// nodeManagers are the Node managers whose declared CLI arrives as that shim.
var nodeManagers = map[string]bool{"npm": true, "pnpm": true, "yarn": true, "bun": true}

// managerProbeArgv is what the probe runs for a manager whose CLI is a
// console-script entry of the declared dependency rather than a file in the
// repository. Each carries the flag that keeps the manager from installing,
// syncing, or fetching anything, and none of them runs a script the repository
// declares.
var managerProbeArgv = map[string][]string{
	"uv":     {"uv", "run", "--no-sync", "leji"},
	"poetry": {"poetry", "run", "leji"},
	"pdm":    {"pdm", "run", "leji"},
	"pipenv": {"pipenv", "run", "leji"},
	"go":     {"go", "tool", "leji"},
}

// goProbeEnv is the environment the Go probe forces: a read-only module graph, no
// toolchain download, no module proxy, and no workspace file redirecting the build.
var goProbeEnv = map[string]string{
	"GOFLAGS":     "-mod=readonly",
	"GOTOOLCHAIN": "local",
	"GOPROXY":     "off",
	"GOWORK":      "off",
}

// probePlatformEnv are the variables the probe passes through whatever it runs.
// Everything else in the caller's environment is dropped: a probe is not the user's
// shell, and an inherited NODE_OPTIONS, npm_config_*, or LD_PRELOAD is exactly the
// kind of thing that turns "ask for a version" into "run something else".
var probePlatformEnv = []string{"SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP", "WINDIR"}

// probeManagerEnv is the per-manager configuration the probe keeps, because without
// it the manager cannot find the environment it is being asked about. Nothing beyond
// this is inherited.
var probeManagerEnv = map[string][]string{
	"uv":     {"UV_CACHE_DIR", "UV_PROJECT_ENVIRONMENT", "VIRTUAL_ENV"},
	"poetry": {"POETRY_HOME", "POETRY_VIRTUALENVS_PATH", "POETRY_CACHE_DIR", "VIRTUAL_ENV"},
	"pdm":    {"PDM_HOME", "PDM_CACHE_DIR", "VIRTUAL_ENV"},
	"pipenv": {"PIPENV_VENV_IN_PROJECT", "WORKON_HOME", "VIRTUAL_ENV"},
	"go":     {"GOPATH", "GOMODCACHE", "GOCACHE", "GOBIN"},
}

func passThrough(names []string, into map[string]string) {
	for _, name := range names {
		if v, ok := os.LookupEnv(name); ok {
			into[name] = v
		}
	}
}

// spawnedProbeEnv is the environment for a probe that has to find a program on the
// caller's PATH (a package manager, or the ambient `leji`): PATH and HOME survive
// because the manager cannot answer without them, plus the manager's own named
// configuration. Nothing else does.
func spawnedProbeEnv(manager string) map[string]string {
	env := map[string]string{}
	passThrough([]string{"PATH", "Path", "HOME"}, env)
	passThrough(probePlatformEnv, env)
	if manager != "" {
		passThrough(probeManagerEnv[manager], env)
	}
	if manager == "go" {
		for k, v := range goProbeEnv {
			env[k] = v
		}
	}
	return env
}

// directProbeEnv is the environment for the direct execution of the repository's own
// bin shim: nothing of the caller's is inherited at all. PATH holds only the
// directory of the node binary the shim's interpreter line resolves, and HOME points
// at a temporary directory so no user configuration is read.
func directProbeEnv() map[string]string {
	env := map[string]string{"PATH": nodeBinDir(), "HOME": os.TempDir()}
	passThrough(probePlatformEnv, env)
	return env
}

// nodeBinDir is where a `node` the shim can use lives, resolved on the caller's PATH
// once. Empty when there is none: the shim then fails to start, the probe fails
// closed, and the row says the CLI could not be run here.
func nodeBinDir() string {
	p, err := exec.LookPath("node")
	if err != nil {
		return ""
	}
	return filepath.Dir(p)
}

// versionRe is a bare <major>.<minor>.<patch> with an optional prerelease or build
// tail, which is what every `leji --version` prints. Anything else is not a version
// this probe will believe.
var versionRe = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)([-+][0-9A-Za-z.-]+)?$`)

type foundVersion struct {
	text  string
	major int
}

func parseVersion(stdout string) *foundVersion {
	for _, raw := range strings.Split(stdout, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		m := versionRe.FindStringSubmatch(line)
		if m == nil {
			return nil
		}
		major, err := strconv.Atoi(m[1])
		if err != nil {
			return nil
		}
		return &foundVersion{text: line, major: major}
	}
	return nil
}

// probePlan is how this repository's declared CLI would be asked for its version.
// "direct" is the installed Node shim, executed as a file; "spawned" is a manager or
// the ambient binary, found on the caller's PATH; "absent" is a Node repository whose
// install has not produced the shim (not installed, or a Yarn PnP tree that has no
// bin directory) — reported, never worked around by asking a package manager to run a
// script.
type probePlan struct {
	kind string // "direct" | "spawned" | "absent"
	bin  string
	args []string
	env  map[string]string
}

// binCandidates are the names a Node bin shim can take, strongest first. Windows
// installs a .cmd wrapper beside (or instead of) the extensionless shim.
func binCandidates() []string {
	if runtime.GOOS == "windows" {
		return []string{"leji.cmd", "leji.exe", "leji"}
	}
	return []string{"leji"}
}

// installedNodeBin is the installed shim's absolute path, or "". Every condition is
// checked before the path is ever executed: a regular file after symlinks are
// followed (npm installs the shim AS a symlink, so links are expected), resolving
// inside the real repository root, and executable where the platform records that.
func installedNodeBin(root string) string {
	for _, name := range binCandidates() {
		abs := filepath.Join(root, "node_modules", ".bin", name)
		if !fsx.ResolvedWithinRoot(root, abs) {
			continue
		}
		info, err := os.Stat(abs)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if runtime.GOOS != "windows" && info.Mode()&0o111 == 0 {
			continue
		}
		return abs
	}
	return ""
}

func planProbe(root string, report ecosystem.Report) probePlan {
	selected := report.Selected
	manager := ""
	if selected != nil && selected.DirectDeclared && selected.Manager != nil {
		manager = *selected.Manager
	}
	if manager != "" && nodeManagers[manager] {
		bin := installedNodeBin(root)
		if bin == "" {
			return probePlan{kind: "absent"}
		}
		return probePlan{kind: "direct", bin: bin, env: directProbeEnv()}
	}
	if argv, ok := managerProbeArgv[manager]; ok && manager != "" {
		return probePlan{kind: "spawned", bin: argv[0], args: append([]string(nil), argv[1:]...), env: spawnedProbeEnv(manager)}
	}
	// Undeclared, pip, and pre-1.24 Go all reach the CLI the same way a person does:
	// whatever `leji` the PATH resolves, run with the same sanitized environment.
	return probePlan{kind: "spawned", bin: "leji", env: spawnedProbeEnv("")}
}

// probeVersion asks the CLI this repository would run for its version. Argv, never a
// shell; cwd pinned to the root; stdin closed; output and time bounded; a sanitized
// environment; and never a package manager's script runner. Every failure mode — a
// missing executable, a non-zero exit, a timeout, output that is not a version — comes
// back as nil, because a probe that cannot answer is not evidence that the CLI is there.
func probeVersion(root string, plan probePlan, hio *HandoffIO) *foundVersion {
	if plan.kind == "absent" || hio == nil || hio.Run == nil {
		return nil
	}
	args := append(append([]string{}, plan.args...), "--version")
	res := hio.Run(plan.bin, args, root, RunOptions{
		Quiet:     true,
		Capture:   true,
		TimeoutMs: probeTimeoutMs,
		MaxBytes:  probeMaxBytes,
		Env:       plan.env,
	})
	if !res.Started || res.Err != nil {
		return nil
	}
	return parseVersion(res.Stdout)
}

// --- the checks -----------------------------------------------------------

func newCheck(id, status, detail string, fix []string) Check {
	return Check{ID: id, Status: status, Detail: detail, Fix: fix, fixKind: fixKindCommand}
}

// newSnippetCheck is the same row whose fix is pasted rather than run: the host's MCP
// config block, and the hook body leji must not write itself.
func newSnippetCheck(id, status, detail string, fix []string) Check {
	return Check{ID: id, Status: status, Detail: detail, Fix: fix, fixKind: fixKindSnippet}
}

func argvLine(argv []string) string { return strings.Join(argv, " ") }

func cliRow(root string, m *manifest.Manifest, report ecosystem.Report, hio *HandoffIO) Check {
	selected := report.Selected
	runner := ecosystem.RunnerArgv(report)
	specLine := m.Leji
	minimum, hasMinimum := minSDKForSpecLine[specLine]
	plan := planProbe(root, report)

	if selected == nil || !selected.DirectDeclared {
		// The gap is the repository's declaration, which is a committed file: report it
		// with the maintainer's command whatever this machine happens to have. The plain
		// `leji` is still probed, so an ambient install is named as what it is.
		found := probeVersion(root, plan, hio)
		var fix []string
		if selected != nil && selected.Add != nil {
			fix = []string{argvLine(selected.Add)}
		}
		detail := textCLIUndeclared
		if found != nil {
			detail = textCLIUndeclaredAmbient(found.text)
		}
		return newCheck(CheckCLI, "shared-gap", detail, fix)
	}
	manager := ""
	if selected.Manager != nil {
		manager = *selected.Manager
	}
	found := probeVersion(root, plan, hio)
	// The row names what actually answered: the installed shim for a Node repository,
	// and the manager's own runner everywhere else.
	shown := argvLine(runner)
	nodeShim := plan.kind == "direct" || plan.kind == "absent"
	if nodeShim {
		shown = nodeBinRel
	}
	var fix []string
	if argv := ecosystem.ManagerInstallArgv(manager); argv != nil {
		fix = []string{argvLine(argv)}
		// A Node repository whose shim is absent gets the install command AND the way
		// to confirm it worked, because leji will not run a package manager to find out.
		if nodeShim {
			fix = append(fix, textCLIVerify(argvLine(runner)))
		}
	}
	if plan.kind == "absent" {
		return newCheck(CheckCLI, "missing", textCLINotInstalled(nodeBinRel), fix)
	}
	if found == nil {
		// A manager with no single install command (pip, pre-1.24 Go) has no argv to
		// print, so the row itself has to carry the instruction.
		detail := textCLIUnresolvable(shown)
		if fix == nil {
			detail = textCLIUnresolvableNoInstall(shown)
		}
		return newCheck(CheckCLI, "missing", detail, fix)
	}
	if hasMinimum {
		if minMajor, err := strconv.Atoi(strings.SplitN(minimum, ".", 2)[0]); err == nil && found.major < minMajor {
			return newCheck(CheckCLI, "missing", textCLIBelowMinimum(found.text, shown, minimum, specLine), fix)
		}
	}
	return newCheck(CheckCLI, "ok", textCLIOk(found.text, shown), nil)
}

// personalMcpAdd is the argv that registers the server for THIS USER on a host, or
// nil when the host has no registration command at all.
func personalMcpAdd(hostID string) (string, []string) {
	spec := detect.SpecByID(hostID)
	if spec == nil {
		return "", nil
	}
	argv := spec.McpAddUser
	if argv == nil {
		argv = spec.McpAdd
	}
	if argv == nil {
		return "", nil
	}
	return spec.Bins[0], argv
}

func mcpRow(root string, host *StartHost, detected []detect.DetectedHost, hio *HandoffIO) Check {
	if host == nil {
		launchable := StartHosts(detected)
		if len(launchable) > 1 {
			names := make([]string, 0, len(launchable))
			for _, h := range launchable {
				names = append(names, h.Name)
			}
			return newCheck(CheckMCP, "unresolved", textMCPUnresolved(names), []string{startPreflightAgentFixLine})
		}
		// A host Leji cannot register for is still worth a row: the person can add the
		// standard configuration by hand, which is the only fix that exists for it.
		for _, h := range detected {
			spec := detect.SpecByID(h.ID)
			if spec == nil || spec.McpConfig == nil {
				continue
			}
			fix := append(
				[]string{textMCPManualPath(spec.McpConfig.Path, spec.McpConfig.Scope)},
				strings.Split(detect.McpJSONConfig(spec.McpConfig.Shape), "\n")...,
			)
			return newSnippetCheck(CheckMCP, "missing", textMCPManual(h.Name), fix)
		}
		return newCheck(CheckMCP, "skipped", textMCPNone, nil)
	}
	spec := detect.SpecByID(host.ID)
	if spec != nil && len(spec.McpCheck) > 0 && hio != nil && hio.Run != nil {
		res := hio.Run(host.Bin, spec.McpCheck, root, RunOptions{Quiet: true})
		if res.Started && res.Err == nil {
			return newCheck(CheckMCP, "ok", textMCPRegistered(host.Name), nil)
		}
	}
	bin, argv := personalMcpAdd(host.ID)
	var fix []string
	if argv != nil {
		fix = []string{bin + " " + argvLine(argv)}
	}
	return newCheck(CheckMCP, "missing", textMCPMissing(host.Name), fix)
}

// committedFile reports whether a regular file stands at rel directly inside the
// repository root.
func committedFile(root, rel string) bool {
	abs := filepath.Join(root, rel)
	info, err := os.Stat(abs)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	return fsx.ResolvedWithinRoot(root, abs)
}

func mcpSharedRow(root string, host *StartHost) Check {
	if host == nil {
		return newCheck(CheckMCPShared, "n/a", textMCPSharedNoHost, nil)
	}
	spec := detect.SpecByID(host.ID)
	if spec == nil || spec.McpSharedFile == "" || spec.McpAdd == nil {
		return newCheck(CheckMCPShared, "n/a", textMCPSharedOther, nil)
	}
	if committedFile(root, spec.McpSharedFile) {
		return newCheck(CheckMCPShared, "ok", textMCPSharedPresent(spec.McpSharedFile), nil)
	}
	return newCheck(CheckMCPShared, "shared-gap", textMCPSharedAbsent(spec.McpSharedFile),
		[]string{detect.McpCommand(spec, spec.McpAdd)})
}

var hookFix = []string{"leji ci --hooks"}

func hookRow(status HookReport) Check {
	if status.Ownership == "no-git" {
		return newCheck(CheckHook, "missing", textHookNoGit, nil)
	}
	if status.State == "current" {
		return newCheck(CheckHook, "ok", textHookCurrent(status.Path), nil)
	}
	if status.Ownership == "personal" {
		if status.State == "absent" {
			return newCheck(CheckHook, "missing", textHookAbsentPersonal, hookFix)
		}
		return newSnippetCheck(CheckHook, "missing", textHookForeign(status.Path), strings.Split(status.Snippet, "\n"))
	}
	if status.Ownership == "shared" {
		return newCheck(CheckHook, "shared-gap", textHookAbsentShared(status.Path), hookFix)
	}
	if status.Ownership == "outside-root" {
		// A linked worktree's hooks live in the common git directory, outside this
		// working tree. It is still per-clone state, but the writer refuses anything
		// outside the repository root, so the only honest answer is the snippet.
		return newSnippetCheck(CheckHook, "missing", textHookOutsideRoot(status.Path), strings.Split(status.Snippet, "\n"))
	}
	// Outside the repository entirely: reported with the snippet, never written.
	return newSnippetCheck(CheckHook, "missing", textHookExternal(status.Path), strings.Split(status.Snippet, "\n"))
}

// --- the report -----------------------------------------------------------

// PreflightOptions configures RunPreflight.
type PreflightOptions struct {
	// Root is the layer root; every check reads from it and nothing else.
	Root     string
	Manifest *manifest.Manifest
	// Host is the host `leji start` resolved for this run, or nil when none was selected.
	Host     *StartHost
	Detected []detect.DetectedHost
	Report   ecosystem.Report
}

var readyIDs = map[string]bool{CheckCLI: true, CheckMCP: true, CheckHook: true}
var readyStatuses = map[string]bool{"ok": true, "skipped": true, "n/a": true}

// RunPreflight runs every check, in the fixed order, writing nothing. The only child
// processes are the bounded version probe and the host's own registration query, both
// through the injectable IO.
func RunPreflight(opts PreflightOptions, hio *HandoffIO) PreflightResult {
	root, err := filepath.Abs(opts.Root)
	if err != nil {
		root = opts.Root
	}
	hook := HookStatus(root, ecosystem.RunnerArgv(opts.Report))
	checks := []Check{
		cliRow(root, opts.Manifest, opts.Report, hio),
		mcpRow(root, opts.Host, opts.Detected, hio),
		mcpSharedRow(root, opts.Host),
		hookRow(hook),
	}
	ready := true
	for _, c := range checks {
		if readyIDs[c.ID] && !readyStatuses[c.Status] {
			ready = false
		}
	}
	return PreflightResult{Ready: ready, Checks: checks, Hook: hook}
}

// startStatusColor is the escape each label wears when color is on. The word is
// styled; its padding is not, so the columns line up whether or not the escapes are
// there.
var startStatusColor = map[string]string{
	"ok":   "\x1b[32m",
	"you":  "\x1b[33m",
	"team": "\x1b[36m",
	"n/a":  "\x1b[2m",
}

const startColorReset = "\x1b[0m"

// ColorDecision reports whether the Setup block may color its status words: a real
// terminal that has not asked for plain text. NO_COLOR disables at any value, empty
// included, because the convention is presence. A pure function of the two things it
// reads (the env lookup is passed in, so a test needs no process), decided once at the
// CLI boundary and injected, so nothing downstream consults the process and every
// piped byte is escape-free by construction. The stdin prompt gate stays separate.
func ColorDecision(isTTY bool, env func(string) (string, bool)) bool {
	if !isTTY {
		return false
	}
	if _, ok := env("NO_COLOR"); ok {
		return false
	}
	if term, _ := env("TERM"); term == "dumb" {
		return false
	}
	return true
}

func padRight(s string, width int) string {
	if len(s) >= width {
		return s
	}
	return s + strings.Repeat(" ", width-len(s))
}

func summaryLine(you, team int) string {
	switch {
	case you > 0 && team > 0:
		return textSummaryBoth(textSummaryFixes(you), team)
	case you > 0:
		return textSummaryYou(textSummaryFixes(you))
	case team > 0:
		return textSummaryTeam(textSummaryFixes(team))
	}
	return textSummaryComplete
}

// RenderPreflight is the Setup block: a heading, one fixed-column row per check with
// its fixes under it, and one closing line counting what is owed. The counts come from
// the labels the rows already printed, so the block can never say something its own
// rows do not.
func RenderPreflight(checks []Check, color bool) string {
	lines := []string{startHeading, ""}
	you, team := 0, 0
	for _, c := range checks {
		label := startStatusLabel[c.Status]
		switch label {
		case "you":
			you++
		case "team":
			team++
		}
		word := label
		if color {
			word = startStatusColor[label] + label + startColorReset
		}
		status := word + strings.Repeat(" ", preflightStatusWidth-len(label))
		lines = append(lines, preflightMargin+status+preflightGutter+padRight(startSubject[c.ID], preflightSubjectWidth)+preflightGutter+c.Detail)
		prompt := "$ "
		if c.fixKind == fixKindSnippet {
			prompt = ""
		}
		for _, fix := range c.Fix {
			lines = append(lines, preflightFixIndent+prompt+fix)
		}
	}
	lines = append(lines, "", preflightMargin+summaryLine(you, team))
	return strings.Join(lines, "\n")
}

// --- the consented repairs ------------------------------------------------

// PreflightOfferOptions configures OfferPreflightFixes.
type PreflightOfferOptions struct {
	Root   string
	Host   *StartHost
	Result PreflightResult
	// Runner is the runner the hook would be written with, so the report and the
	// write agree.
	Runner []string
	// Interactive is a real TTY and not --json; nothing is offered or written otherwise.
	Interactive bool
}

// OfferPreflightFixes offers the personal repairs the report found, in the order it
// printed them. Only state this user or this clone owns is ever offered: the host
// registration for this user, and the per-clone hook. A shared gap is never offered,
// because accepting it would write a file the repository commits.
func OfferPreflightFixes(opts PreflightOfferOptions, hio *HandoffIO, out io.Writer) {
	if !opts.Interactive || hio == nil {
		return
	}
	yes := func(question string) bool {
		a := strings.ToLower(hio.ReadLine(question, textOfferPrompt))
		return a == "" || a == "y" || a == "yes"
	}
	byID := func(id string) *Check {
		for i := range opts.Result.Checks {
			if opts.Result.Checks[i].ID == id {
				return &opts.Result.Checks[i]
			}
		}
		return nil
	}

	mcp := byID(CheckMCP)
	if mcp != nil && mcp.Status == "missing" && opts.Host != nil && hio.Run != nil {
		if bin, argv := personalMcpAdd(opts.Host.ID); argv != nil {
			if yes(textOfferMcp(opts.Host.Name)) {
				res := hio.Run(bin, argv, opts.Root, RunOptions{})
				if res.Started && res.Err == nil {
					fmt.Fprintln(out, textOfferMcpDone(opts.Host.Name))
				} else {
					fmt.Fprintln(out, textOfferMcpFailed(bin))
					fmt.Fprintln(out, preflightFixIndent+"$ "+bin+" "+argvLine(argv))
				}
			}
		}
	}

	hook := opts.Result.Hook
	if hook.Ownership == "personal" && hook.State == "absent" && yes(textOfferHook) {
		written, err := EnsureLocalHook(opts.Root, opts.Runner)
		if err != nil || written.Action == "manual" {
			fmt.Fprintln(out, textOfferHookFailed)
			fmt.Fprintf(out, "\n%s\n", written.Snippet)
		} else {
			fmt.Fprintln(out, textOfferHookDone(written.Path))
		}
	}
}
