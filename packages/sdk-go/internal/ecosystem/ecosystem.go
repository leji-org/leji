// Package ecosystem answers which dependency ecosystem owns a repository root,
// which package manager runs it, how the Leji CLI is declared as a dev dependency
// there, and how a hook or CI job should invoke it.
//
// Pure and offline: it reads a bounded set of files directly under the root and
// writes nothing, launches nothing, and never walks up out of the root (an add in
// a parent directory would write outside the root the user targeted). Every answer
// is a total decision table over repository evidence, so the three SDKs return the
// same report for the same tree. Transcribed from the TypeScript reference
// (packages/sdk/src/lib/ecosystem.ts): tables and strings byte for byte.
package ecosystem

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
)

// DepName is the npm package name. Its presence in package.json's dependency maps
// is what DirectDeclared reports for a Node repository.
const DepName = "@leji-org/leji"

// pyDist is the distribution name on PyPI and the name a Python manifest declares.
const pyDist = "leji"

// goToolPath is the Go module path a `tool` directive names for the CLI.
const goToolPath = "github.com/leji-org/leji/packages/sdk-go/cmd/leji"

// Candidate is one package manager the evidence could not choose between, with
// the command that would declare Leji under it (nil for a print-only manager).
type Candidate struct {
	Manager string   `json:"manager"`
	Add     []string `json:"add"`
}

// Result is one gated ecosystem's answer. TOTAL: every field is set on every
// outcome, so a consumer never has to know which branch produced the result.
// Field order is the JSON contract.
type Result struct {
	Ecosystem      string      `json:"ecosystem"`
	Status         string      `json:"status"`
	Manifest       *string     `json:"manifest"`
	Manager        *string     `json:"manager"`
	Source         *string     `json:"source"`
	Evidence       []string    `json:"evidence"`
	Add            []string    `json:"add"`
	Runner         []string    `json:"runner"`
	DirectDeclared bool        `json:"directDeclared"`
	LockEvidenced  bool        `json:"lockEvidenced"`
	Candidates     []Candidate `json:"candidates"`
}

// Report is the whole answer for one root. Selected is non-nil only when exactly
// one ecosystem is gated AND it chose a manager.
type Report struct {
	Selected *Result  `json:"selected"`
	All      []Result `json:"all"`
	Reason   *string  `json:"reason"`
}

type commandPair struct {
	add    []string
	runner []string
	// install is the manager's own plain install — what a joiner runs on a fresh
	// clone so the declared CLI resolves — and is nil for a manager whose install
	// depends on which requirements file the repository uses.
	install []string
}

// managerCommands is the per-manager command table. `add` nil means a manager
// that cannot declare a dev dependency from the command line; its guidance is
// printed instead. Argv arrays, never shell strings. No version pin: the lockfile
// pins the exact version, and Go needs a selector, so it takes @latest.
var managerCommands = map[string]commandPair{
	"npm":    {add: []string{"npm", "i", "-D", DepName}, runner: []string{"npx", "--no-install", DepName}, install: []string{"npm", "install"}},
	"pnpm":   {add: []string{"pnpm", "add", "-D", DepName}, runner: []string{"pnpm", "exec", "leji"}, install: []string{"pnpm", "install"}},
	"yarn":   {add: []string{"yarn", "add", "-D", DepName}, runner: []string{"yarn", "leji"}, install: []string{"yarn", "install"}},
	"bun":    {add: []string{"bun", "add", "-d", DepName}, runner: []string{"bun", "run", "leji"}, install: []string{"bun", "install"}},
	"uv":     {add: []string{"uv", "add", "--dev", pyDist}, runner: []string{"uv", "run", "leji"}, install: []string{"uv", "sync"}},
	"poetry": {add: []string{"poetry", "add", "--group", "dev", pyDist}, runner: []string{"poetry", "run", "leji"}, install: []string{"poetry", "install"}},
	"pdm":    {add: []string{"pdm", "add", "-dG", "dev", pyDist}, runner: []string{"pdm", "run", "leji"}, install: []string{"pdm", "install"}},
	"pipenv": {add: []string{"pipenv", "install", "--dev", pyDist}, runner: []string{"pipenv", "run", "leji"}, install: []string{"pipenv", "install", "--dev"}},
	"pip":    {add: nil, runner: []string{"leji"}, install: nil},
	// The same command F10's CI table installs a Go repository's tools with.
	"go":        {add: []string{"go", "get", "-tool", goToolPath + "@latest"}, runner: []string{"go", "tool", "leji"}, install: []string{"go", "mod", "download"}},
	"go-legacy": {add: nil, runner: []string{"leji"}, install: nil},
}

// ManagerRunnerArgv returns the runner argv for one manager name, or nil when
// leji does not know it. One runner table serves detection, the hook, and CI.
func ManagerRunnerArgv(manager string) []string {
	if pair, ok := managerCommands[manager]; ok {
		return append([]string(nil), pair.runner...)
	}
	return nil
}

// ManagerInstallArgv returns the plain install argv for one manager name: what a
// joiner runs on a fresh clone so the CLI the repository declares actually
// resolves. Nil when leji does not know the manager, or when the manager has no
// single install command.
func ManagerInstallArgv(manager string) []string {
	if pair, ok := managerCommands[manager]; ok && pair.install != nil {
		return append([]string(nil), pair.install...)
	}
	return nil
}

// plainRunner is the fallback: the CLI on PATH, for every repository that has not
// declared it.
var plainRunner = []string{"leji"}

const (
	nodeManifest = "package.json"
	goManifest   = "go.mod"
	pyproject    = "pyproject.toml"
	pipfile      = "Pipfile"
)

type lockEntry struct {
	file    string
	manager string
	lock    bool
}

// nodeLocks are the Node lockfile families, in the fixed order every list of them
// uses. Two names mark bun (text and binary); either is presence-only evidence.
var nodeLocks = []lockEntry{
	{file: "package-lock.json", manager: "npm"},
	{file: "pnpm-lock.yaml", manager: "pnpm"},
	{file: "yarn.lock", manager: "yarn"},
	{file: "bun.lock", manager: "bun"},
	{file: "bun.lockb", manager: "bun"},
}

var nodeManagers = []string{"npm", "pnpm", "yarn", "bun"}

// pyLocks are the Python lock families, in the fixed order every list of them
// uses. Pipfile is a family member without being a lock: it selects pipenv, but
// only Pipfile.lock evidences a lock.
var pyLocks = []lockEntry{
	{file: "uv.lock", manager: "uv", lock: true},
	{file: "poetry.lock", manager: "poetry", lock: true},
	{file: "pdm.lock", manager: "pdm", lock: true},
	{file: "Pipfile.lock", manager: "pipenv", lock: true},
	{file: pipfile, manager: "pipenv", lock: false},
}

// pyToolTables are the [tool.<x>] tables that name a manager when no lock family
// is present.
var pyToolTables = []struct {
	table   string
	manager string
}{
	{table: "tool.uv", manager: "uv"},
	{table: "tool.poetry", manager: "poetry"},
	{table: "tool.pdm", manager: "pdm"},
}

// requirementsRe matches the root files that gate the Python ecosystem alongside
// the two manifests.
var requirementsRe = regexp.MustCompile(`^requirements[A-Za-z0-9._-]*\.txt$`)

// --- the human block ------------------------------------------------------
// Every string the offer prints lives here once, so the three SDKs transcribe one
// table rather than re-deriving prose.

const offerLead = "To declare the Leji CLI as a dev dependency so a clean install brings leji, run:"
const declareWithTool = "Declare the Leji CLI as a dev dependency with the tool this repo uses."

// Indent is the one indentation every printed command line uses.
const Indent = "   "

// TextOffer renders the offer lead for a detected manager.
func TextOffer(manager, file string) string {
	return "Detected " + manager + " (" + file + "). " + offerLead
}

// TextDeclared renders the already-declared line.
func TextDeclared(manifest string) string {
	return "The Leji CLI is already declared in " + manifest + "."
}

// TextAmbiguous renders the manager-ambiguity lead.
func TextAmbiguous(manifest string, files []string) string {
	return "Detected " + manifest + " with " + joinAnd(files) +
		"; leji will not guess the package manager. Declare it with the one this repo uses:"
}

// TextMultiple renders the several-ecosystems lead; the punctuation closes the
// sentence when no gated ecosystem has a runnable add.
func TextMultiple(manifests []string, commands bool) string {
	tail := "."
	if commands {
		tail = ":"
	}
	return "Detected " + joinAnd(manifests) +
		"; leji will not guess which ecosystem owns this repository. Declare it with the one this repo uses" + tail
}

// TextNone is the per-person install block for a root that gates nothing.
var TextNone = []string{
	"No package.json, pyproject.toml or go.mod here, so there is nothing for leji to declare itself in. Install the Leji CLI for yourself:",
	Indent + "npm install -g " + DepName,
	"Other runtimes and the full walkthrough: https://leji.org/quickstart/",
}

// TextUnsupported renders the unrecognized-packageManager lead.
func TextUnsupported(manifest string) string {
	return "Detected " + manifest +
		", whose packageManager field names a package manager leji does not know; leji will not guess. " + declareWithTool
}

// TextUnreadable renders the unreadable-manifest lead.
func TextUnreadable(manifest string) string {
	return "Could not read " + manifest + ", so leji will not guess the package manager. " + declareWithTool
}

// TextRefused renders the refused-evidence lead.
func TextRefused(files []string) string {
	return "Refusing to read " + joinAnd(files) + ": not a regular file inside this repository. " + declareWithTool
}

// TextPipGroups renders the PEP 735 guidance for a pip repository.
func TextPipGroups(file string) []string {
	return []string{
		"Detected pip (" + file + "). To declare the Leji CLI as a dev dependency so a clean install brings leji, add to " + pyproject + ":",
		Indent + "[dependency-groups]",
		Indent + `dev = ["` + pyDist + `"]`,
		"then run it with pip 25.1 or newer:",
		Indent + "pip install --group dev",
	}
}

// TextPipRequirements renders the requirements-file guidance for a pip repository.
func TextPipRequirements(file string) []string {
	return []string{
		"Detected pip (" + file + "). To declare the Leji CLI as a dev dependency so a clean install brings leji, add a line `" + pyDist + "` to requirements-dev.txt, then run:",
		Indent + "pip install -r requirements-dev.txt",
	}
}

// TextGoLegacy renders the per-person install for a pre-1.24 Go module.
func TextGoLegacy(file string) []string {
	return []string{
		"Detected Go (" + file + ") without a go directive of 1.24 or newer, so leji cannot be declared as a module tool. Install the Leji CLI for yourself:",
		Indent + "go install " + goToolPath + "@latest",
	}
}

// The one-line forms `leji detect` prints.

func lineSelected(manager, file string, declared bool) string {
	state := "not declared"
	if declared {
		state = "declared"
	}
	return "Ecosystem: " + manager + " (" + file + "); Leji CLI " + state
}

const lineNone = "Ecosystem: none detected"

func lineMultiple(manifests []string) string {
	return "Ecosystem: " + joinAnd(manifests) + "; leji will not guess which one owns this repository"
}

func lineAmbiguous(manifest string, files []string) string {
	return "Ecosystem: " + manifest + " with " + joinAnd(files) + "; leji will not guess the package manager"
}

func lineUnsupported(manifest string) string {
	return "Ecosystem: " + manifest + "; unrecognized packageManager field"
}

func lineUnreadable(manifest string) string {
	return "Ecosystem: " + manifest + "; unreadable"
}

func lineRefused(files []string) string {
	return "Ecosystem: " + joinAnd(files) + "; not a regular file inside this repository"
}

// The consent path (plan section 3): the prompt, and every outcome of running the
// manager's own add command. leji writes no manifest byte itself, so these are the
// only words it owns once the user says yes.

// ConsentDisclosure is printed immediately before the prompt, interactive runs
// only. The manager runs here, as the user, with the user's environment: say so
// before asking, not after.
func ConsentDisclosure(bin string) string {
	return "This runs " + bin + " here with your environment, as when you run it yourself: it will contact its registry and may run install scripts."
}

// ConsentPrompt is the question the offer asks.
const ConsentPrompt = "Run it now?"

// ConsentRunning announces the command about to run.
func ConsentRunning(command []string) string {
	return "Running: " + strings.Join(command, " ")
}

// declaredSubject names what each ecosystem's add command actually declares.
var declaredSubject = map[string]string{
	"node":   DepName,
	"python": pyDist,
	"go":     "the leji module tool",
}

// ConsentDeclared reports a clean add, naming what was declared.
func ConsentDeclared(ecosystem string) string {
	return "Declared " + declaredSubject[ecosystem] + "; a clean install now brings leji."
}

// ConsentExited reports a non-zero add.
func ConsentExited(bin string, code int) string {
	return bin + " exited " + strconv.Itoa(code) + "; run it yourself:"
}

// ConsentSignaled reports an add killed by a signal.
func ConsentSignaled(bin, signal string) string {
	return bin + " was terminated (" + signal + "); run it yourself:"
}

// ConsentMissing reports a spawn that never started.
func ConsentMissing(bin string) string {
	return bin + " is not on your PATH; run it yourself once it is:"
}

// ConsentDeclined is printed when the user says no.
const ConsentDeclined = "Skipped; declare it later with:"

// ConsentCommand renders one indented command line, so no caller re-derives the
// indentation.
func ConsentCommand(command []string) string {
	return Indent + strings.Join(command, " ")
}

// joinAnd renders `a`, `a and b`, `a, b and c` — the one list join every message
// uses.
func joinAnd(items []string) string {
	switch len(items) {
	case 0:
		return ""
	case 1:
		return items[0]
	default:
		return strings.Join(items[:len(items)-1], ", ") + " and " + items[len(items)-1]
	}
}

// --- evidence eligibility -------------------------------------------------

// entryKind is what stands at one probed name directly under the root. A gated
// file counts only when lstat says regular file AND its real path lies inside the
// real root: a symlink, a dangling link, a directory, a socket or a FIFO is
// refused rather than read, so no manifest or lockfile can redirect the answer out
// of the repository the user pointed at.
type entryKind int

const (
	entryAbsent entryKind = iota
	entryEligible
	entryRefused
)

func classify(rootAbs, name string) entryKind {
	abs := filepath.Join(rootAbs, name)
	info, err := os.Lstat(abs)
	if err != nil {
		return entryAbsent
	}
	if !info.Mode().IsRegular() {
		return entryRefused
	}
	if fsx.ResolvedWithinRoot(rootAbs, abs) {
		return entryEligible
	}
	return entryRefused
}

// rootScan holds the probed names of one root, classified once.
type rootScan struct {
	rootAbs string
	kinds   map[string]entryKind
	entries []string
	listed  bool
}

func newRootScan(rootAbs string) *rootScan {
	return &rootScan{rootAbs: rootAbs, kinds: map[string]entryKind{}}
}

func (s *rootScan) kind(name string) entryKind {
	if k, ok := s.kinds[name]; ok {
		return k
	}
	k := classify(s.rootAbs, name)
	s.kinds[name] = k
	return k
}

func (s *rootScan) present(name string) bool  { return s.kind(name) != entryAbsent }
func (s *rootScan) eligible(name string) bool { return s.kind(name) == entryEligible }

// refused returns the refused names among names, in the order given.
func (s *rootScan) refused(names []string) []string {
	out := []string{}
	for _, n := range names {
		if s.kind(n) == entryRefused {
			out = append(out, n)
		}
	}
	return out
}

// read returns the bytes of one probed name, or ok=false. Structurally gated: a
// name that is not an eligible regular file inside the real root is never opened,
// so no read can bypass the eligibility rule by being spelled at a new call site.
func (s *rootScan) read(name string) (string, bool) {
	if s.kind(name) != entryEligible {
		return "", false
	}
	data, err := os.ReadFile(filepath.Join(s.rootAbs, name))
	if err != nil {
		return "", false
	}
	return string(data), true
}

// matching returns every root entry matching re, sorted bytewise (never by
// locale: the three SDKs must agree).
func (s *rootScan) matching(re *regexp.Regexp) []string {
	if !s.listed {
		s.listed = true
		items, err := os.ReadDir(s.rootAbs)
		if err == nil {
			for _, item := range items {
				s.entries = append(s.entries, item.Name())
			}
		}
	}
	out := []string{}
	for _, n := range s.entries {
		if re.MatchString(n) {
			out = append(out, n)
		}
	}
	sort.Strings(out)
	return out
}

// --- result construction --------------------------------------------------

// decision is what a branch decided; everything it leaves out is the neutral
// value.
type decision struct {
	ecosystem      string
	status         string
	manifest       *string
	manager        *string
	source         *string
	evidence       []string
	directDeclared bool
	lockEvidenced  bool
	candidates     []Candidate
}

// newResult is the one Result constructor. Every field of the result is set here,
// in the fixed key order the JSON contract pins, so no branch can build a partial
// outcome and Add/Runner always follow the manager rather than the branch.
func newResult(d decision) Result {
	status := d.status
	if status == "" {
		status = "ok"
	}
	evidence := d.evidence
	if evidence == nil {
		evidence = []string{}
	}
	candidates := d.candidates
	if candidates == nil {
		candidates = []Candidate{}
	}
	var add, runner []string
	if d.manager != nil {
		if pair, ok := managerCommands[*d.manager]; ok {
			add = pair.add
			runner = pair.runner
		}
	}
	return Result{
		Ecosystem:      d.ecosystem,
		Status:         status,
		Manifest:       d.manifest,
		Manager:        d.manager,
		Source:         d.source,
		Evidence:       evidence,
		Add:            add,
		Runner:         runner,
		DirectDeclared: d.directDeclared,
		LockEvidenced:  d.lockEvidenced,
		Candidates:     candidates,
	}
}

func candidatesFor(managers []string) []Candidate {
	out := []Candidate{}
	for _, m := range managers {
		var add []string
		if pair, ok := managerCommands[m]; ok {
			add = pair.add
		}
		out = append(out, Candidate{Manager: m, Add: add})
	}
	return out
}

func uniq(items []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, x := range items {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}

func strptr(s string) *string { return &s }

// --- Node -----------------------------------------------------------------

// packageManagerRe is corepack's grammar, <name>[@<version>[+<hash>]]. A value
// that is present but does not parse is malformed — never a fall-through to a
// lockfile or the default, because explicit repository evidence is never
// overridden by a guess.
var packageManagerRe = regexp.MustCompile(`^([a-z][a-z0-9-]*)(?:@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)(?:\+([A-Za-z0-9._-]+))?)?$`)

func nodeResult(scan *rootScan) Result {
	probed := []string{nodeManifest}
	for _, l := range nodeLocks {
		probed = append(probed, l.file)
	}
	if refused := scan.refused(probed); len(refused) > 0 {
		sort.Strings(refused)
		return newResult(decision{
			ecosystem: "node", status: "refused-evidence",
			manifest: strptr(nodeManifest), evidence: refused,
		})
	}
	raw, ok := scan.read(nodeManifest)
	var pkg map[string]any
	if ok {
		pkg = parsePackageJSON(raw)
	}
	if pkg == nil {
		return newResult(decision{ecosystem: "node", status: "unreadable-manifest", manifest: strptr(nodeManifest)})
	}
	var locks []lockEntry
	evidence := []string{}
	for _, l := range nodeLocks {
		if scan.eligible(l.file) {
			locks = append(locks, l)
			evidence = append(evidence, l.file)
		}
	}
	directDeclared := declaresDepIn(pkg)
	selected := func(manager, source string) Result {
		lockEvidenced := false
		for _, l := range locks {
			if l.manager == manager {
				lockEvidenced = true
			}
		}
		return newResult(decision{
			ecosystem: "node", manifest: strptr(nodeManifest), manager: strptr(manager),
			source: strptr(source), evidence: evidence,
			directDeclared: directDeclared, lockEvidenced: lockEvidenced,
		})
	}

	if pmRaw, has := pkg["packageManager"]; has {
		name := ""
		if s, isString := pmRaw.(string); isString {
			if m := packageManagerRe.FindStringSubmatch(s); m != nil {
				name = m[1]
			}
		}
		known := false
		for _, n := range nodeManagers {
			if n == name {
				known = true
			}
		}
		if !known {
			return newResult(decision{
				ecosystem: "node", status: "unsupported-manager", manifest: strptr(nodeManifest),
				source: strptr("packageManager"), evidence: evidence, directDeclared: directDeclared,
			})
		}
		return selected(name, "packageManager")
	}

	families := []string{}
	for _, l := range locks {
		families = append(families, l.manager)
	}
	families = uniq(families)
	if len(families) > 1 {
		return newResult(decision{
			ecosystem: "node", status: "ambiguous-manager", manifest: strptr(nodeManifest),
			evidence: evidence, directDeclared: directDeclared, candidates: candidatesFor(families),
		})
	}
	if len(families) == 1 {
		return selected(families[0], "lockfile")
	}
	return selected("npm", "default")
}

// parsePackageJSON parses strict JSON after one BOM strip; anything else —
// unparseable, or parsed to something that is not a JSON object — leaves the
// manifest unreadable, and locks and defaults are not consulted from incomplete
// evidence.
func parsePackageJSON(raw string) map[string]any {
	text := strings.TrimPrefix(raw, "\ufeff")
	var parsed any
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	if err := dec.Decode(&parsed); err != nil {
		return nil
	}
	// Anything after the first value is not strict JSON: only a clean end of input
	// is acceptable. A second value parses, and trailing garbage errors — both are
	// input JSON.parse and Python's json.loads refuse, so both leave the manifest
	// unreadable rather than being read as the value that happened to come first.
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return nil
	}
	obj, ok := parsed.(map[string]any)
	if !ok {
		return nil
	}
	return obj
}

func declaresDepIn(pkg map[string]any) bool {
	for _, field := range []string{"dependencies", "devDependencies"} {
		deps, ok := pkg[field].(map[string]any)
		if !ok {
			continue
		}
		if _, has := deps[DepName]; has {
			return true
		}
	}
	return false
}

// --- Python ---------------------------------------------------------------

func pythonResult(scan *rootScan) Result {
	requirements := scan.matching(requirementsRe)
	manifest := pythonManifest(scan, requirements)
	probed := []string{pyproject}
	for _, l := range pyLocks {
		probed = append(probed, l.file)
	}
	probed = append(probed, requirements...)
	if refused := scan.refused(uniq(probed)); len(refused) > 0 {
		sort.Strings(refused)
		return newResult(decision{
			ecosystem: "python", status: "refused-evidence", manifest: manifest, evidence: refused,
		})
	}
	pyprojectText, pyprojectOK := "", false
	if scan.eligible(pyproject) {
		pyprojectText, pyprojectOK = scan.read(pyproject)
		if !pyprojectOK {
			return newResult(decision{ecosystem: "python", status: "unreadable-manifest", manifest: manifest})
		}
	}
	pipfileText, pipfileOK := "", false
	if scan.eligible(pipfile) {
		pipfileText, pipfileOK = scan.read(pipfile)
		if !pipfileOK {
			return newResult(decision{ecosystem: "python", status: "unreadable-manifest", manifest: manifest})
		}
	}

	var present []lockEntry
	evidence := []string{}
	for _, l := range pyLocks {
		if scan.eligible(l.file) {
			present = append(present, l)
			evidence = append(evidence, l.file)
		}
	}
	evidence = append(evidence, requirements...)
	directDeclared := pythonDeclared(scan, pyprojectText, pyprojectOK, pipfileText, pipfileOK, requirements)

	families := []string{}
	for _, l := range present {
		families = append(families, l.manager)
	}
	families = uniq(families)
	if len(families) > 1 {
		return newResult(decision{
			ecosystem: "python", status: "ambiguous-manager", manifest: manifest,
			evidence: evidence, directDeclared: directDeclared, candidates: candidatesFor(families),
		})
	}
	if len(families) == 1 {
		// Pipfile alone selects pipenv from the manifest itself; only Pipfile.lock is
		// lock evidence, which is what CI reads to choose a locked install.
		lock := false
		for _, l := range present {
			if l.manager == families[0] && l.lock {
				lock = true
			}
		}
		source := "manifest"
		if lock {
			source = "lockfile"
		}
		return newResult(decision{
			ecosystem: "python", manifest: manifest, manager: strptr(families[0]), source: strptr(source),
			evidence: evidence, directDeclared: directDeclared, lockEvidenced: lock,
		})
	}

	tables := []string{}
	if pyprojectOK {
		for _, t := range pyToolTables {
			if tomlHasTable(pyprojectText, t.table) {
				tables = append(tables, t.manager)
			}
		}
	}
	if len(tables) > 1 {
		return newResult(decision{
			ecosystem: "python", status: "ambiguous-manager", manifest: manifest,
			evidence: evidence, directDeclared: directDeclared, candidates: candidatesFor(tables),
		})
	}
	if len(tables) == 1 {
		return newResult(decision{
			ecosystem: "python", manifest: manifest, manager: strptr(tables[0]), source: strptr("tool-table"),
			evidence: evidence, directDeclared: directDeclared,
		})
	}
	// Nothing named a manager: pip is the ecosystem's default, and it is print-only.
	return newResult(decision{
		ecosystem: "python", manifest: manifest, manager: strptr("pip"), source: strptr("default"),
		evidence: evidence, directDeclared: directDeclared,
	})
}

// pythonManifest applies the manifest precedence: pyproject, then Pipfile, then
// the conventional requirements files. Decided on presence, so a refused entry
// still names what was refused.
func pythonManifest(scan *rootScan, requirements []string) *string {
	if scan.present(pyproject) {
		return strptr(pyproject)
	}
	if scan.present(pipfile) {
		return strptr(pipfile)
	}
	for _, name := range []string{"requirements-dev.txt", "requirements.txt"} {
		for _, r := range requirements {
			if r == name {
				return strptr(name)
			}
		}
	}
	if len(requirements) > 0 {
		return strptr(requirements[0])
	}
	return nil
}

func pythonDeclared(scan *rootScan, pyprojectText string, pyprojectOK bool, pipfileText string, pipfileOK bool, requirements []string) bool {
	if pyprojectOK && tomlDeclaresLeji(pyprojectText, pyprojectFields) {
		return true
	}
	if pipfileOK && tomlDeclaresLeji(pipfileText, pipfileFields) {
		return true
	}
	for _, name := range requirements {
		if !scan.eligible(name) {
			continue
		}
		if text, ok := scan.read(name); ok && requirementsDeclareLeji(text) {
			return true
		}
	}
	return false
}

// --- Go -------------------------------------------------------------------

var goDirectiveRe = regexp.MustCompile(`^go\s+(\d+)\.(\d+)`)

func goResult(scan *rootScan) Result {
	if refused := scan.refused([]string{goManifest}); len(refused) > 0 {
		return newResult(decision{
			ecosystem: "go", status: "refused-evidence", manifest: strptr(goManifest), evidence: refused,
		})
	}
	text, ok := scan.read(goManifest)
	if !ok {
		return newResult(decision{ecosystem: "go", status: "unreadable-manifest", manifest: strptr(goManifest)})
	}
	// Tool dependencies are a Go 1.24 feature; an older or missing directive gets
	// the per-person install instead. go.sum is the manager's business, so a
	// declared tool is its own lock evidence.
	directDeclared := goDeclaresTool(text)
	modern := goDirectiveAtLeast(text, 1, 24)
	manager := "go-legacy"
	if modern {
		manager = "go"
	}
	return newResult(decision{
		ecosystem: "go", manifest: strptr(goManifest), manager: strptr(manager), source: strptr("manifest"),
		directDeclared: directDeclared, lockEvidenced: modern && directDeclared,
	})
}

func goDirectiveAtLeast(text string, major, minor int) bool {
	for _, line := range splitLines(text) {
		m := goDirectiveRe.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil {
			continue
		}
		foundMajor, _ := strconv.Atoi(m[1])
		foundMinor, _ := strconv.Atoi(m[2])
		return foundMajor > major || (foundMajor == major && foundMinor >= minor)
	}
	return false
}

var goToolBlockRe = regexp.MustCompile(`^tool\s*\($`)

// goDeclaresTool reports a `tool <path>` line, or that path inside a `tool (` block.
func goDeclaresTool(text string) bool {
	inBlock := false
	for _, raw := range splitLines(text) {
		line := raw
		if cut := strings.Index(line, "//"); cut >= 0 {
			line = line[:cut]
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if inBlock {
			if line == ")" {
				inBlock = false
			} else if line == goToolPath {
				return true
			}
			continue
		}
		if goToolBlockRe.MatchString(line) {
			inBlock = true
			continue
		}
		if line == "tool "+goToolPath {
			return true
		}
	}
	return false
}

// --- the TOML dependency scan ---------------------------------------------

// tomlFields says which fields of a TOML document declare a dependency.
// Deliberately not a TOML parser: a field-specific, stateful line scan that tracks
// the current table, triple-quoted string state, and the bracket depth of the one
// array it is inspecting. Only the listed fields are inspected, so a description, a
// comment, or an unrelated table cannot produce a false positive — and a false
// positive is the expensive error here, because it suppresses the only offer the
// user gets.
type tomlFields struct {
	keyTable   func(table string) bool
	arrayField func(table, key string) bool
}

var poetryGroupRe = regexp.MustCompile(`^tool\.poetry\.group\.[^.]+\.dependencies$`)

var pyprojectFields = tomlFields{
	keyTable: func(t string) bool {
		return t == "tool.poetry.dependencies" ||
			t == "tool.poetry.dev-dependencies" ||
			t == "tool.pdm.dev-dependencies" ||
			poetryGroupRe.MatchString(t)
	},
	arrayField: func(t, k string) bool {
		return (t == "project" && k == "dependencies") ||
			t == "project.optional-dependencies" ||
			t == "dependency-groups" ||
			(t == "tool.uv" && k == "dev-dependencies") ||
			t == "tool.pdm.dev-dependencies"
	},
}

var pipfileFields = tomlFields{
	keyTable:   func(t string) bool { return t == "packages" || t == "dev-packages" },
	arrayField: func(string, string) bool { return false },
}

// lejiRequirementRe matches a requirement whose distribution name is exactly
// leji: the name, then the end of the token or one of the characters that can
// follow a name in PEP 508 / requirements syntax.
var lejiRequirementRe = regexp.MustCompile(`^leji($|[\[=<>~!;,\s])`)

func tomlDeclaresLeji(text string, fields tomlFields) bool {
	table := ""
	triple := ""
	depth := 0
	inspecting := false
	for _, line := range splitLines(text) {
		i := 0
		if triple != "" {
			close := strings.Index(line, triple)
			if close < 0 {
				continue
			}
			i = close + 3
			triple = ""
		} else if depth == 0 {
			if header, ok := tomlTableHeader(line); ok {
				table = header
				continue
			}
			key, valueAt, ok := tomlKeyAt(line)
			if !ok {
				continue
			}
			if key == pyDist && fields.keyTable(table) {
				return true
			}
			inspecting = fields.arrayField(table, key)
			i = valueAt
		}
		// One character scan carries the rest: strings (whose contents are the only
		// things that can match), bracket depth (which says whether we are inside the
		// inspected array), comments, and a triple quote that runs past this line.
		for i < len(line) {
			c := line[i]
			if c == '#' {
				break
			}
			if c == '"' || c == '\'' {
				fence := strings.Repeat(string(c), 3)
				if strings.HasPrefix(line[i:], fence) {
					close := strings.Index(line[i+3:], fence)
					if close < 0 {
						triple = fence
						break
					}
					// A triple-quoted string is skipped ENTIRELY, on one line as across
					// several: the scanner has no TOML parser to tell a multi-line
					// dependency from prose that merely starts with the name, so the
					// conservative answer is the only safe one.
					i = i + 3 + close + 3
					continue
				}
				text, end := tomlReadString(line, i, c)
				if depth > 0 && inspecting && lejiRequirementRe.MatchString(text) {
					return true
				}
				i = end
				continue
			}
			if c == '[' {
				depth++
			} else if c == ']' && depth > 0 {
				depth--
				if depth == 0 {
					inspecting = false
				}
			}
			i++
		}
	}
	return false
}

var tomlArrayHeaderRe = regexp.MustCompile(`^\s*\[\[\s*([^\]]+?)\s*\]\]\s*(?:#.*)?$`)
var tomlHeaderRe = regexp.MustCompile(`^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$`)
var whitespaceRe = regexp.MustCompile(`\s+`)

// tomlTableHeader matches `[table]` or `[[array-of-tables]]`, with inner
// whitespace removed.
func tomlTableHeader(line string) (string, bool) {
	if m := tomlArrayHeaderRe.FindStringSubmatch(line); m != nil {
		return whitespaceRe.ReplaceAllString(m[1], ""), true
	}
	if m := tomlHeaderRe.FindStringSubmatch(line); m != nil {
		return whitespaceRe.ReplaceAllString(m[1], ""), true
	}
	return "", false
}

var tomlKeyRe = regexp.MustCompile(`^\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_.-]+))\s*=\s*`)

// tomlKeyAt returns the key a line assigns to, bare or quoted, and where its
// value starts.
func tomlKeyAt(line string) (string, int, bool) {
	m := tomlKeyRe.FindStringSubmatchIndex(line)
	if m == nil {
		return "", 0, false
	}
	for g := 1; g <= 3; g++ {
		if m[2*g] >= 0 {
			return line[m[2*g]:m[2*g+1]], m[1], true
		}
	}
	return "", m[1], true
}

// tomlReadString reads one single-line basic or literal string, from its opening
// quote. Escapes are consumed, not decoded: only a `leji` prefix is ever tested
// against the result.
func tomlReadString(line string, start int, quote byte) (string, int) {
	var b strings.Builder
	i := start + 1
	for i < len(line) {
		c := line[i]
		if quote == '"' && c == '\\' {
			if i+1 < len(line) {
				b.WriteByte(line[i+1])
			}
			i += 2
			continue
		}
		if c == quote {
			return b.String(), i + 1
		}
		b.WriteByte(c)
		i++
	}
	return b.String(), len(line)
}

// tomlHasTable reports whether the document opens the given table, or any table
// under it: TOML defines tool.poetry implicitly when a document writes only
// [tool.poetry.dependencies], and a manager's table is present either way. The dot
// is what keeps [tool.uvicorn] from answering for tool.uv. Same header rules as
// the dependency scan, including the multi-line-string state that keeps a table
// name inside a description from counting.
func tomlHasTable(text, table string) bool {
	triple := ""
	for _, line := range splitLines(text) {
		if triple != "" {
			if strings.Contains(line, triple) {
				triple = ""
			}
			continue
		}
		if header, ok := tomlTableHeader(line); ok {
			if header == table || strings.HasPrefix(header, table+".") {
				return true
			}
			continue
		}
		if opened := tomlOpensTriple(line); opened != "" {
			triple = opened
		}
	}
	return false
}

// tomlOpensTriple returns the triple quote a line leaves open, or "".
func tomlOpensTriple(line string) string {
	i := 0
	open := ""
	for i < len(line) {
		c := line[i]
		if c == '#' {
			break
		}
		if c == '"' || c == '\'' {
			fence := strings.Repeat(string(c), 3)
			if strings.HasPrefix(line[i:], fence) {
				close := strings.Index(line[i+3:], fence)
				if close < 0 {
					open = fence
					break
				}
				i = i + 3 + close + 3
				continue
			}
			_, end := tomlReadString(line, i, c)
			i = end
			continue
		}
		i++
	}
	return open
}

var requirementLineRe = regexp.MustCompile(`^leji($|[\s\[=<>~!;,#])`)

// requirementsDeclareLeji reports a `leji` requirement line in a requirements
// file: the name at the start of the line, then end-of-line or a character that
// can follow a name.
func requirementsDeclareLeji(text string) bool {
	for _, line := range splitLines(text) {
		if requirementLineRe.MatchString(line) {
			return true
		}
	}
	return false
}

func splitLines(text string) []string {
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimSuffix(l, "\r")
	}
	return lines
}

// --- the report -----------------------------------------------------------

// Detect detects the dependency ecosystems gated by files directly under rootAbs.
// Reads; never writes, never runs anything, never walks up.
func Detect(rootAbs string) Report {
	abs, err := filepath.Abs(rootAbs)
	if err != nil {
		abs = rootAbs
	}
	scan := newRootScan(abs)
	all := []Result{}
	// Fixed order, so `all` reads the same in every report and in every SDK.
	if scan.present(nodeManifest) {
		all = append(all, nodeResult(scan))
	}
	pythonGated := scan.present(pyproject) || scan.present(pipfile) || len(scan.matching(requirementsRe)) > 0
	if pythonGated {
		all = append(all, pythonResult(scan))
	}
	if scan.present(goManifest) {
		all = append(all, goResult(scan))
	}

	if len(all) == 0 {
		return Report{Selected: nil, All: all, Reason: strptr("none")}
	}
	if len(all) > 1 {
		return Report{Selected: nil, All: all, Reason: strptr("multiple-ecosystems")}
	}
	only := all[0]
	// A manager-less single ecosystem carries its own reason up: the report's
	// reason is never a second, independently derived verdict.
	if only.Status != "ok" {
		return Report{Selected: nil, All: all, Reason: strptr(only.Status)}
	}
	selected := only
	return Report{Selected: &selected, All: all, Reason: nil}
}

// RunnerArgv returns the argv a hook or CI job runs leji with: the detected
// manager's runner when the repository actually declares the CLI, else the plain
// fallback on PATH.
func RunnerArgv(report Report) []string {
	if s := report.Selected; s != nil && s.DirectDeclared && s.Runner != nil {
		return append([]string(nil), s.Runner...)
	}
	return append([]string(nil), plainRunner...)
}

// RenderBlock renders the always-printed human block: what was detected, and what
// to run to declare the Leji CLI. Never a prompt, never a command run — the caller
// owns both.
func RenderBlock(report Report) string {
	return strings.Join(blockLines(report), "\n")
}

func blockLines(report Report) []string {
	if report.Reason != nil && *report.Reason == "none" {
		return TextNone
	}
	if report.Reason != nil && *report.Reason == "multiple-ecosystems" {
		// A print-only ecosystem (pip, pre-1.24 Go) contributes no command here; the
		// lead sentence closes with a period rather than dangling a colon.
		commands := []string{}
		manifests := []string{}
		for _, r := range report.All {
			commands = append(commands, commandLines(r)...)
			manifests = append(manifests, manifestLabel(r))
		}
		return append([]string{TextMultiple(manifests, len(commands) > 0)}, commands...)
	}
	only := report.All[0]
	if only.DirectDeclared && only.Manifest != nil {
		return []string{TextDeclared(*only.Manifest)}
	}
	switch only.Status {
	case "refused-evidence":
		return []string{TextRefused(only.Evidence)}
	case "unreadable-manifest":
		return []string{TextUnreadable(deref(only.Manifest))}
	case "unsupported-manager":
		return []string{TextUnsupported(deref(only.Manifest))}
	case "ambiguous-manager":
		return append([]string{TextAmbiguous(deref(only.Manifest), only.Evidence)}, commandLines(only)...)
	default:
		return okLines(only)
	}
}

// okLines renders the offer for one ecosystem that chose a manager. A manager with
// no add command prints its own guidance instead.
func okLines(r Result) []string {
	if r.Manager != nil && *r.Manager == "pip" {
		if r.Manifest != nil && *r.Manifest == pyproject {
			return TextPipGroups(deciderFile(r))
		}
		return TextPipRequirements(deciderFile(r))
	}
	if r.Manager != nil && *r.Manager == "go-legacy" {
		return TextGoLegacy(deciderFile(r))
	}
	return append([]string{TextOffer(deref(r.Manager), deciderFile(r))}, commandLines(r)...)
}

// commandLines renders the indented command line(s) for one result: its own add
// command, or one per candidate when the evidence could not choose.
func commandLines(r Result) []string {
	if r.Add != nil {
		return []string{ConsentCommand(r.Add)}
	}
	out := []string{}
	for _, c := range r.Candidates {
		if c.Add != nil {
			out = append(out, ConsentCommand(c.Add))
		}
	}
	return out
}

// deciderFile names the one file a message cites as the evidence for the manager:
// the lockfile that selected it, the pyproject that carried its tool table, or the
// manifest.
func deciderFile(r Result) string {
	if r.Source != nil && *r.Source == "lockfile" {
		for _, f := range r.Evidence {
			for _, l := range nodeLocks {
				if l.file == f && r.Manager != nil && l.manager == *r.Manager {
					return f
				}
			}
			for _, l := range pyLocks {
				if l.file == f && r.Manager != nil && l.manager == *r.Manager && l.lock {
					return f
				}
			}
		}
	}
	if r.Source != nil && *r.Source == "tool-table" {
		return pyproject
	}
	if r.Ecosystem == "python" && r.Source != nil && *r.Source == "manifest" {
		return pipfile
	}
	return deref(r.Manifest)
}

func manifestLabel(r Result) string {
	if r.Manifest != nil {
		return *r.Manifest
	}
	return r.Ecosystem
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// RenderLine renders the one line `leji detect` prints about the ecosystem.
func RenderLine(report Report) string {
	if report.Reason != nil && *report.Reason == "none" {
		return lineNone
	}
	if report.Reason != nil && *report.Reason == "multiple-ecosystems" {
		manifests := []string{}
		for _, r := range report.All {
			manifests = append(manifests, manifestLabel(r))
		}
		return lineMultiple(manifests)
	}
	only := report.All[0]
	switch only.Status {
	case "refused-evidence":
		return lineRefused(only.Evidence)
	case "unreadable-manifest":
		return lineUnreadable(deref(only.Manifest))
	case "unsupported-manager":
		return lineUnsupported(deref(only.Manifest))
	case "ambiguous-manager":
		return lineAmbiguous(deref(only.Manifest), only.Evidence)
	default:
		return lineSelected(deref(only.Manager), deciderFile(only), only.DirectDeclared)
	}
}

// MarshalJSONIndent encodes the report exactly as the reference does with
// JSON.stringify(value, null, 2): struct field order is the key order, empty
// arrays stay arrays, absent argv is null, and nothing is HTML-escaped.
func MarshalJSONIndent(v any, prefix, indent string) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent(prefix, indent)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	// Encoder.Encode appends a newline; the caller owns trailing bytes.
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}
