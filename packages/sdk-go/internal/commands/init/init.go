// Package initcmd bootstraps a context layer from the vendored templates.
package initcmd

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/leji-org/leji/packages/sdk-go/internal/assets"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/indexgen"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/validate"
	"github.com/leji-org/leji/packages/sdk-go/internal/detect"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/git"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
	"github.com/leji-org/leji/packages/sdk-go/internal/writeplan"
)

type Options struct {
	Dir   string
	Yes   bool
	Name  string
	Level string // "core" | "indexed"
	// DryRun computes and returns the write plan without touching the filesystem.
	DryRun bool
	// Agent is the launchable host (id or alias) to hand the scaffold to; rejected
	// when it names none.
	Agent string
	// Mode is the working mode: "solo" scaffolds the identity and writing-style
	// starters and runs the owner-voice interview; empty means "team" (today's
	// behavior).
	Mode string
	// StdinTTY reports whether stdin is a real TTY (the same check that gates the
	// handoff offer). The interactive mode question is TTY-only so the
	// piped-stdin question protocol keeps its exact line count.
	StdinTTY bool
	// NoAgents skips generating the portable `AGENTS.md` pointer (written by
	// default when absent; an existing file is never touched).
	NoAgents bool
	// In/Out are overridable for tests; default to os.Stdin / os.Stdout.
	In  io.Reader
	Out io.Writer
}

// workingModes are the layer's working modes: a team of one ("solo") or a team ("team").
var workingModes = []string{"solo", "team"}

// assertMode validates a mode value from a direct SDK caller before any filesystem work.
func assertMode(mode string) (string, error) {
	if !contains(workingModes, mode) {
		return "", fmt.Errorf("--mode must be solo or team; got %q", mode)
	}
	return mode, nil
}

type answers struct {
	name         string
	description  string
	rootPath     string
	ownerName    string
	ownerContact string
	categories   []string
	level        string
	// mode is the working mode ("solo" | "team"); solo scaffolds the identity
	// and writing-style starters.
	mode string
	// layout holds resolved scaffold paths; nil means the spec defaults under
	// rootPath. adopt fills this with collision-resolved alternates.
	layout *ScaffoldLayout
}

// ScaffoldLayout is the repo-relative paths the scaffolder writes. Defaults derive
// from rootPath; adopt resolves each against the existing tree to avoid clobbering.
type ScaffoldLayout struct {
	BootProfilePath string
	// ContextDir holds the category index files, trailing slash.
	ContextDir string
	// AgentsDir is the agent-profiles directory, trailing slash.
	AgentsDir     string
	IndexPath     string
	ChangelogPath string
}

// defaultLayout is the spec-default layout under a context root (no collision resolution).
func defaultLayout(rootPath string) ScaffoldLayout {
	return ScaffoldLayout{
		BootProfilePath: fsx.JoinUnderRoot(rootPath, "boot-profile.md"),
		ContextDir:      fsx.JoinUnderRoot(rootPath, "context/"),
		AgentsDir:       fsx.JoinUnderRoot(rootPath, "agents/"),
		IndexPath:       fsx.JoinUnderRoot(rootPath, "context-index.json"),
		ChangelogPath:   fsx.JoinUnderRoot(rootPath, "context-changelog.json"),
	}
}

// resolveScaffoldPath picks the first candidate name (under rootPath) absent on
// disk, so adopt never writes its scaffold over a repo's existing content.
func resolveScaffoldPath(root, rootPath, name string, alternates []string, dir bool) string {
	suffix := ""
	if dir {
		suffix = "/"
	}
	for _, candidate := range append([]string{name}, alternates...) {
		rel := fsx.JoinUnderRoot(rootPath, candidate+suffix)
		if !fsx.Exists(filepath.Join(root, fsx.StripSlash(rel))) {
			return rel
		}
	}
	for n := 2; ; n++ {
		rel := fsx.JoinUnderRoot(rootPath, fmt.Sprintf("%s-%d%s", name, n, suffix))
		if !fsx.Exists(filepath.Join(root, fsx.StripSlash(rel))) {
			return rel
		}
	}
}

// resolveLayout resolves a scaffold layout against an existing repo: each colliding
// default path falls back to a safe alternate.
func resolveLayout(root, rootPath string) ScaffoldLayout {
	return ScaffoldLayout{
		BootProfilePath: resolveScaffoldPath(root, rootPath, "boot-profile.md", []string{"leji-boot-profile.md"}, false),
		ContextDir:      resolveScaffoldPath(root, rootPath, "context", []string{"leji-context", "context-layer"}, true),
		AgentsDir:       resolveScaffoldPath(root, rootPath, "agents", []string{"agent-profiles", "leji-agents"}, true),
		IndexPath:       resolveScaffoldPath(root, rootPath, "context-index.json", []string{"leji-context-index.json"}, false),
		ChangelogPath:   resolveScaffoldPath(root, rootPath, "context-changelog.json", []string{"leji-context-changelog.json"}, false),
	}
}

func (a answers) effectiveLayout() ScaffoldLayout {
	if a.layout != nil {
		return *a.layout
	}
	return defaultLayout(a.rootPath)
}

type Result struct {
	Written []string
	// Findings are index-generation findings. Errors mean no index was written, and
	// the caller reports them and fails, the same way `leji index` does.
	Findings []findings.Finding
	Manifest *manifest.Manifest
	// Mode is the working mode the layer was scaffolded with ("solo" | "team").
	Mode string
	// Plan is the classified write plan (always populated; the only output under DryRun).
	Plan   []writeplan.PlanEntry
	DryRun bool
	// Detected lists the coding-agent hosts found for this repo, ranked; informs
	// the handoff offer.
	Detected []detect.DetectedHost
	// Root is the absolute layer root (resolved Dir); the cwd for the handoff launch
	// and the MCP-install offer.
	Root string
}

func gitConfig(key string) string {
	cmd := exec.Command("git", "config", "--get", key)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

var nonAlnum = regexp.MustCompile(`[^a-z0-9]+`)

// nonAlnum collapses each run of non-alphanumerics to a single '-', so dashes are
// never consecutive; trimming one per end suffices (mirrors the Node/Python SDKs;
// avoids the polynomial `-+$` backtracking, harmless under RE2 but kept uniform).
var trimDash = regexp.MustCompile(`^-|-$`)

func slugBase(dir string) string {
	abs, _ := filepath.Abs(dir)
	base := strings.ToLower(filepath.Base(abs))
	base = nonAlnum.ReplaceAllString(base, "-")
	base = trimDash.ReplaceAllString(base, "")
	return base
}

func defaultAnswers(dir string, opts Options) answers {
	base := slugBase(dir)
	name := opts.Name
	if name == "" {
		name = base + "-context"
	}
	ownerName := gitConfig("user.name")
	if ownerName == "" {
		ownerName = "<named owner>"
	}
	level := opts.Level
	if level == "" {
		level = "core"
	}
	return answers{
		name:         name,
		description:  "Shared context layer for this repository.",
		rootPath:     "docs/",
		ownerName:    ownerName,
		ownerContact: gitConfig("user.email"),
		categories:   []string{"domain", "system", "decisions"},
		level:        level,
		mode:         "team",
	}
}

// categoryOrder is the canonical category order for manifests and scaffolds.
var categoryOrder = []string{"domain", "system", "practice", "governance", "decisions"}

// normalizeCategories normalizes a category set: `decisions` always; solo forces
// `domain` + `practice`; the spec minimum (domain or system) holds; canonical
// order regardless of input.
func normalizeCategories(categories []string, mode string) []string {
	set := map[string]bool{}
	for _, c := range categories {
		set[c] = true
	}
	set["decisions"] = true
	if mode == "solo" {
		set["domain"] = true
		set["practice"] = true
	}
	if !set["domain"] && !set["system"] {
		set["domain"] = true
	}
	var out []string
	for _, c := range categoryOrder {
		if set[c] {
			out = append(out, c)
		}
	}
	return out
}

func prompt(opts Options) (answers, error) {
	defaults := defaultAnswers(opts.Dir, opts)
	if opts.Mode != "" {
		m, err := assertMode(opts.Mode)
		if err != nil {
			return answers{}, err
		}
		defaults.mode = m
	}
	if opts.Yes {
		return defaults, nil
	}
	in := opts.In
	if in == nil {
		in = os.Stdin
	}
	out := opts.Out
	if out == nil {
		out = os.Stdout
	}
	reader := bufio.NewReader(in)
	nextLine := func() string {
		line, err := reader.ReadString('\n')
		if err != nil && line == "" {
			return ""
		}
		return strings.TrimRight(line, "\r\n")
	}
	ask := func(q, fallback string) string {
		if fallback != "" {
			io.WriteString(out, q+" ("+fallback+"): ")
		} else {
			io.WriteString(out, q+": ")
		}
		a := strings.TrimSpace(nextLine())
		if a == "" {
			return fallback
		}
		return a
	}
	askYesNo := func(q string, fallback bool) bool {
		hint := "y/N"
		if fallback {
			hint = "Y/n"
		}
		io.WriteString(out, q+" ["+hint+"]: ")
		a := strings.ToLower(strings.TrimSpace(nextLine()))
		if a == "" {
			return fallback
		}
		return a == "y" || a == "yes"
	}

	name := ask("Layer name", defaults.name)
	description := ask("One-line description", defaults.description)
	rootPath := strings.TrimSpace(ask("Context root", defaults.rootPath))
	// A repository-root context layer is canonical "." , never "./" (which the path
	// guard rejects) nor a bare "" that later concatenations would turn into a
	// hidden ".context/". A subdirectory root gets a trailing slash.
	if rootPath == "" || rootPath == "." || rootPath == "./" {
		rootPath = "."
	} else if !strings.HasSuffix(rootPath, "/") {
		rootPath += "/"
	}
	ownerName := ask("Primary owner (name)", defaults.ownerName)
	ownerContact := ask("Primary owner (contact)", defaults.ownerContact)

	// The mode question is TTY-only so the piped-stdin protocol keeps its exact
	// line count; piped runs stay `team` and select solo via --mode solo.
	mode := defaults.mode
	if opts.Mode == "" && opts.StdinTTY {
		a := strings.ToLower(ask("Working mode (team/solo)", "team"))
		if a == "solo" {
			mode = "solo"
		} else {
			mode = "team"
		}
	}

	var categories []string
	if mode == "solo" {
		// Solo forces domain + practice (identity and writing-style live there);
		// system and governance stay the repository's call.
		categories = append(categories, "domain")
		if askYesNo("Map system (architecture, invariants)?", true) {
			categories = append(categories, "system")
		}
		categories = append(categories, "practice")
		if askYesNo("Map governance (agent guardrails, operating rules)?", false) {
			categories = append(categories, "governance")
		}
	} else {
		if askYesNo("Map domain (business language, product semantics)?", true) {
			categories = append(categories, "domain")
		}
		if askYesNo("Map system (architecture, invariants)?", true) {
			categories = append(categories, "system")
		}
		if askYesNo("Map practice (conventions, proven patterns)?", false) {
			categories = append(categories, "practice")
		}
		if askYesNo("Map governance (agent guardrails, operating rules)?", false) {
			categories = append(categories, "governance")
		}
	}
	categories = append(categories, "decisions")
	if !contains(categories, "domain") && !contains(categories, "system") {
		categories = append([]string{"domain"}, categories...)
		io.WriteString(out, "At least domain or system is required; mapping domain.\n")
	}
	indexed := askYesNo("Claim the indexed level (adds the machine changelog)?", false)
	level := "core"
	if indexed {
		level = "indexed"
	}
	return answers{
		name:         name,
		description:  description,
		rootPath:     rootPath,
		ownerName:    ownerName,
		ownerContact: ownerContact,
		categories:   categories,
		level:        level,
		mode:         mode,
	}, nil
}

func readTemplate(name string) string {
	b, _ := assets.FS.ReadFile("templates/" + name)
	return string(b)
}

// hasDotSegment reports whether any path segment starts with '.'. Dot-paths
// (the transient `.leji/` brief) are excluded from the governed machine
// surface, so they never seed the changelog.
func hasDotSegment(rel string) bool {
	for _, seg := range strings.Split(rel, "/") {
		if strings.HasPrefix(seg, ".") {
			return true
		}
	}
	return false
}

func hasDotDotSegment(p string) bool {
	for _, seg := range strings.Split(filepath.ToSlash(p), "/") {
		if seg == ".." {
			return true
		}
	}
	return false
}

// validateRelPath enforces the manifest schema relative-path rule
// (^(?!/)(?!\./)(?!.*(^|/)\.\.(/|$))(?!.*\\).*$): reject absolute paths, a
// leading "./", any ".." segment, and backslashes.
func validateRelPath(rel string) error {
	if rel == "" {
		return fmt.Errorf("empty write path is not allowed")
	}
	if filepath.IsAbs(rel) {
		return fmt.Errorf("path %q is absolute; write paths must be relative to the layer root", rel)
	}
	if strings.Contains(rel, "\\") {
		return fmt.Errorf("path %q contains a backslash; only forward-slash relative paths are allowed", rel)
	}
	slashed := filepath.ToSlash(rel)
	if strings.HasPrefix(slashed, "/") {
		return fmt.Errorf("path %q is absolute; write paths must be relative to the layer root", rel)
	}
	if strings.HasPrefix(slashed, "./") || slashed == "." {
		return fmt.Errorf("path %q must not start with \"./\"", rel)
	}
	if hasDotDotSegment(slashed) {
		return fmt.Errorf("path %q escapes the layer root via \"..\"", rel)
	}
	return nil
}

// resolveUnderRoot validates rel and asserts the resolved target stays under
// the resolved root, returning the absolute write path.
func resolveUnderRoot(root, rel string) (string, error) {
	if err := validateRelPath(rel); err != nil {
		return "", err
	}
	abs := filepath.Join(root, rel)
	relBack, err := filepath.Rel(root, abs)
	if err != nil {
		return "", fmt.Errorf("path %q could not be resolved under the layer root: %w", rel, err)
	}
	if relBack == ".." || strings.HasPrefix(relBack, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path %q escapes the layer root", rel)
	}
	return abs, nil
}

func writeFileOnce(root, rel, content string, written *[]string) error {
	abs, err := resolveUnderRoot(root, rel)
	if err != nil {
		return err
	}
	if !fsx.ResolvesUnder(root, abs) {
		return fmt.Errorf("refusing to write through a symlink that escapes the target: %q", rel)
	}
	if _, err := os.Stat(abs); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		return err
	}
	*written = append(*written, rel)
	return nil
}

// ensureLejiGitignored idempotently ensures the repo-root .gitignore ignores
// `.leji/` (generated viewer + transient brief). Matches the line exactly, so it
// never treats a comment or `docs/.leji/` as equivalent.
func ensureLejiGitignored(rootAbs string) error {
	abs := filepath.Join(rootAbs, ".gitignore")
	const entry = ".leji/"
	text := ""
	if fsx.IsFile(abs) {
		t, err := fsx.ReadText(abs)
		if err != nil {
			return err
		}
		text = t
	}
	for _, line := range strings.Split(text, "\n") {
		if line == entry {
			return nil
		}
	}
	if text == "" {
		return os.WriteFile(abs, []byte(entry+"\n"), 0o644)
	}
	sep := ""
	if !strings.HasSuffix(text, "\n") {
		sep = "\n"
	}
	return os.WriteFile(abs, []byte(text+sep+entry+"\n"), 0o644)
}

// assertLejiWorkspacePrivate refuses to write the transient onboarding workspace
// while any file under `<rootPath>/.leji/` is tracked by git: tracked means the
// ignore boundary is not intact, and private artifacts could land in history.
// The fix is the owner's call (git rm --cached), never run silently.
func assertLejiWorkspacePrivate(root, rootPath string) error {
	lejiDir := fsx.JoinUnderRoot(rootPath, ".leji/")
	tracked, ok := git.TrackedUnder(root, fsx.StripSlash(lejiDir))
	if ok && len(tracked) > 0 {
		return fmt.Errorf("%d file(s) under %s are tracked by git; untrack them (git rm --cached) so onboarding artifacts stay private", len(tracked), lejiDir)
	}
	return nil
}

// writeManifestExclusive creates leji.json with O_EXCL so the existence check and
// write are atomic: a concurrent run or a planted symlink cannot be overwritten or
// followed. Already-exists is surfaced as each entry point's initial-guard message.
func writeManifestExclusive(abs string, content []byte, mode string) error {
	fh, err := os.OpenFile(abs, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			if mode == "adopt" {
				return errors.New("leji.json already exists here; this repository already has a Leji layer")
			}
			return errors.New("leji.json already exists here; init refuses to overwrite an existing layer")
		}
		return err
	}
	defer fh.Close()
	if _, err := fh.Write(content); err != nil {
		return err
	}
	return nil
}

type categoryStub struct {
	file, title, summary, body string
}

var categoryStubs = map[string]categoryStub{
	"domain": {"glossary.md", "Glossary",
		"What the core terms of this product mean, in our own words.",
		"- TODO: define a core term in your own words, including what it does not mean.\n"},
	"system": {"invariants.md", "System Invariants",
		"The constraints every change lives with.",
		"- TODO: state an invariant every change must respect (e.g. money values are integer minor units).\n"},
	"practice": {"conventions.md", "Conventions",
		"Conventions and patterns applied automatically.",
		"- TODO: record a convention that has proven out at least twice (the proven-twice gate).\n"},
	"governance": {"operating-rules.md", "Operating Rules",
		"What agents may do unprompted and what needs a human gate.",
		"- TODO: list what an agent may do without asking.\n- TODO: list what requires a human gate.\n"},
}

func stubContent(title, summary, body string) string {
	return "---\nsummary: " + summary + "\n---\n\n# " + title + "\n\n" + body
}

// soloStarters are the solo-mode starters: owner identity (domain) and writing
// style (practice), scaffolded from canonical templates so the interview has
// real homes to fill.
var soloStarters = []struct {
	category, file, template string
}{
	{"domain", "identity.md", "identity.md"},
	{"practice", "writing-style.md", "writing-style.md"},
}

// buildManifest constructs the typed manifest and the ordered root. The ordered
// root omits vendorAdapters/agents; the caller appends them later so the emitted
// key order matches Node's object-mutation order.
func buildManifest(a answers, adapters []string) (*manifest.Manifest, *ordered) {
	r := a.rootPath
	schemaURL := "https://leji.org/schemas/v1.0/context-manifest.schema.json"
	layout := a.effectiveLayout()
	def := defaultLayout(r)

	m := &manifest.Manifest{
		Schema:          schemaURL,
		Leji:            "1.0",
		Name:            a.name,
		Description:     a.description,
		RootPath:        r,
		BootProfilePath: layout.BootProfilePath,
		Categories:      map[string]manifest.CategoryMapping{},
		Owners: manifest.Owners{
			Primary: manifest.Owner{Name: a.ownerName, Contact: a.ownerContact},
		},
		Conformance: &manifest.Conformance{
			ClaimedLevel: a.level,
			ClaimedAt:    time.Now().UTC().Format("2006-01-02"),
		},
	}
	// A machine block is emitted only for paths that differ from their spec default
	// (a collision-resolved alternate from adopt); otherwise the manifest stays
	// minimal and the resolvers find files at the defaults. So a fresh init, or an
	// adopt with no collisions, emits no machine block.
	machine := &manifest.Machine{}
	hasMachine := false
	if layout.IndexPath != def.IndexPath {
		machine.IndexPath = layout.IndexPath
		hasMachine = true
	}
	if layout.ChangelogPath != def.ChangelogPath {
		machine.ChangelogPath = layout.ChangelogPath
		hasMachine = true
	}
	if layout.AgentsDir != def.AgentsDir {
		machine.AgentProfilesPath = layout.AgentsDir
		hasMachine = true
	}
	if hasMachine {
		m.Machine = machine
	}
	for _, c := range a.categories {
		m.Categories[c] = manifest.CategoryMapping{Indexes: []string{layout.ContextDir + c + ".md"}}
	}
	if len(adapters) > 0 {
		m.VendorAdapters = adapters
	}

	// Key order must match the Node object-construction order.
	root := newOrdered()
	root.set("$schema", schemaURL)
	root.set("leji", "1.0")
	root.set("name", a.name)
	root.set("description", a.description)
	root.set("rootPath", r)
	root.set("bootProfilePath", layout.BootProfilePath)
	cats := newOrdered()
	for _, c := range a.categories {
		cat := newOrdered()
		cat.set("indexes", []string{layout.ContextDir + c + ".md"})
		cats.set(c, cat)
	}
	root.set("categories", cats)
	owners := newOrdered()
	primary := newOrdered()
	primary.set("name", a.ownerName)
	if a.ownerContact != "" {
		primary.set("contact", a.ownerContact)
	}
	owners.set("primary", primary)
	root.set("owners", owners)
	conf := newOrdered()
	conf.set("claimedLevel", a.level)
	conf.set("claimedAt", m.Conformance.ClaimedAt)
	root.set("conformance", conf)
	if hasMachine {
		mo := newOrdered()
		if machine.IndexPath != "" {
			mo.set("indexPath", machine.IndexPath)
		}
		if machine.ChangelogPath != "" {
			mo.set("changelogPath", machine.ChangelogPath)
		}
		if machine.AgentProfilesPath != "" {
			mo.set("agentProfilesPath", machine.AgentProfilesPath)
		}
		root.set("machine", mo)
	}
	if len(adapters) > 0 {
		root.set("vendorAdapters", adapters)
	}

	return m, root
}

// Titles double as the viewer's group labels (the sidebar groups by index-file
// H1), so they carry the category emoji the sidebar used to add itself.
var categoryIndexTitles = map[string]string{
	"domain":     "📖 Domain",
	"system":     "⚙️ System",
	"practice":   "🛠️ Practice",
	"governance": "🛡️ Governance",
	"decisions":  "🧭 Decisions",
}

// categoryIndexFile is a stub category index file: a `leji-index` block listing
// the category's source directory.
func categoryIndexFile(rootPath, category string) string {
	title := categoryIndexTitles[category]
	if title == "" {
		title = category
	}
	return "# " + title + "\n\n" +
		"This index lists the " + category + " content of the layer. Content lives where it sits; " +
		"this file declares what counts as " + category + " context.\n\n" +
		"```leji-index\n" +
		"- path: " + fsx.JoinUnderRoot(rootPath, category+"/") + "\n" +
		"```\n"
}

func serializeManifest(root *ordered) []byte {
	var buf bytes.Buffer
	root.encode(&buf)
	buf.WriteByte('\n')
	return buf.Bytes()
}

// changelogLineRe strips the changelog maintenance duty at core level, where no
// changelog is seeded. The index routing sentence and the regenerate duty stay:
// the index ships at every level.
var changelogLineRe = regexp.MustCompile("- Append an entry to `[^`]*context-changelog\\.json`[^\n]*\n")

// planWithIndexTruth restates the index entry truthfully. Leji owns the generated
// index and regenerates it, so an existing one is replaced rather than skipped;
// writeplan.Build classifies any existing path as "skip-exists", which would promise
// a file is left alone that WriteIndex then rewrites.
func planWithIndexTruth(plan []writeplan.PlanEntry, indexRel string) []writeplan.PlanEntry {
	for i, e := range plan {
		if e.Rel == indexRel && e.Status == "skip-exists" {
			plan[i] = writeplan.PlanEntry{
				Rel:    e.Rel,
				Status: "overwrite",
				Note:   "regenerated from the category index files",
			}
		}
	}
	return plan
}

func buildBootProfile(a answers) string {
	text := readTemplate("boot-profile.md")
	text = strings.Replace(text,
		"<One paragraph: what this repository/product is, who it serves, what stage it is at.>",
		a.description, 1)
	r := a.rootPath

	// Rewrite the template's docs/ prefixes for the chosen root (JoinUnderRoot(".", "")
	// is "", so a "." root yields context-index.json, not .context-index.json).
	text = strings.ReplaceAll(text, "docs/", fsx.JoinUnderRoot(r, ""))

	if a.level == "core" {
		// The index ships at every level, so its routing sentence and its regenerate
		// duty both stay: a core scaffold that denied the index would leave the
		// adopter no instruction for the `leji index --check` gate `leji ci` writes.
		// Only the changelog line goes, since the changelog is an `indexed` artifact.
		text = changelogLineRe.ReplaceAllString(text, "")
	}
	if a.mode == "solo" {
		// Route identity and writing work to the solo starters. Inserted after the
		// root rewrite (the routes carry final paths); one placeholder line stays
		// for the task types the onboarding discovers.
		identityRoute := "- identity, positioning, or public claims → `" + fsx.JoinUnderRoot(r, "domain/") + "identity.md`"
		styleRoute := "- writing or outward-facing communication → `" + fsx.JoinUnderRoot(r, "practice/") + "writing-style.md`"
		text = strings.Replace(text,
			"- <task type> → <paths or category>\n- <task type> → <paths or category>\n",
			identityRoute+"\n"+styleRoute+"\n- <task type> → <paths or category>\n", 1)
	}
	return text
}

var governanceLineRe = regexp.MustCompile(`(?m)^ {2}- .*governance/\n`)

func buildCoreProfile(a answers) string {
	text := readTemplate("agents/core.md")
	text = strings.ReplaceAll(text, "docs/", fsx.JoinUnderRoot(a.rootPath, ""))
	if !contains(a.categories, "governance") {
		text = governanceLineRe.ReplaceAllString(text, "  - "+fsx.JoinUnderRoot(a.rootPath, "decisions/")+"\n")
	}
	return text
}

func buildFirstDecision(a answers) string {
	today := time.Now().UTC().Format("2006-01-02")
	indexedLine := "manifest, boot profile, category content, decision records"
	if a.level == "indexed" {
		indexedLine = "manifest, boot profile, category content, decision records, generated index, machine changelog"
	}
	return "---\n" +
		"id: adopt-leji\n" +
		"title: Adopt the Leji context layer\n" +
		"status: accepted\n" +
		"date: " + today + "\n" +
		"deciders:\n" +
		"  - " + a.ownerName + "\n" +
		"---\n\n" +
		"# Adopt the Leji context layer\n\n" +
		"## Context\n\n" +
		"Engineering knowledge lived in heads, chat threads, and per-tool config files. People and agents had no single place to read how this team thinks.\n\n" +
		"## Decision\n\n" +
		"Adopt Leji at the `" + a.level + "` level: " + indexedLine + ".\n\n" +
		"## Consequences\n\n" +
		"Vendor config files become one-line redirects. Context fixes ride the same review gate as the work that surfaces them. " + a.ownerName + " owns the layer.\n"
}

func buildChangelog(a answers, written []string) string {
	today := time.Now().UTC().Format("2006-01-02")
	root := newOrdered()
	root.set("$schema", "https://leji.org/schemas/v1.0/context-changelog.schema.json")
	root.set("schemaVersion", "1.0")
	entry := newOrdered()
	entry.set("id", "seed-layer")
	entry.set("date", today)
	entry.set("type", "added")
	entry.set("summary", "Seeded the context layer with leji init.")
	entry.set("paths", written)
	entry.set("proposedBy", "leji init")
	entry.set("approvedBy", a.ownerName)
	root.set("entries", []*ordered{entry})
	var buf bytes.Buffer
	root.encode(&buf)
	buf.WriteByte('\n')
	return buf.String()
}

// buildBrief returns the transient onboarding brief, rewritten for the chosen
// root (JoinUnderRoot(".", "") is "", so a "." root yields `.leji/...` and
// `context/...`, never `..leji/` or `.context/`) and stamped with the working
// mode so the agent runs the right interview without re-asking.
func buildBrief(a answers) string {
	text := strings.ReplaceAll(readTemplate("onboarding-brief.md"), "<root>/", fsx.JoinUnderRoot(a.rootPath, ""))
	return strings.ReplaceAll(text, "<mode>", a.mode)
}

// BriefPath is the path of the transient onboarding brief, under a dot-directory
// so it is excluded from the index, the viewer, and the changelog.
func BriefPath(rootPath string) string {
	return fsx.JoinUnderRoot(rootPath, ".leji/onboarding-brief.md")
}

const CIWorkflowPath = ".github/workflows/leji.yml"

// Per-provider CI config paths, relative to the repository root.
const GitlabCIPath = ".gitlab-ci.yml"
const CircleCIConfigPath = ".circleci/config.yml"
const AzurePipelinePath = ".azure-pipelines/leji.yml"

const gitlabMarkerStart = "# >>> leji ci (managed) >>>"
const gitlabMarkerEnd = "# <<< leji ci (managed) <<<"

// depName is the npm package name; its presence in the repo's package.json selects
// the local-first CI and hook variants over the `npx @leji-org/leji@1` fallback.
const depName = "@leji-org/leji"

// AzureActivationNote is printed/returned when an Azure pipeline file is created:
// Azure Pipelines does not auto-discover a YAML file (unlike the other three), so
// the file is written but the pipeline still has to be created in Azure DevOps.
const AzureActivationNote = "Azure Pipelines does not auto-run this file. Create a pipeline that points at it (e.g. `az pipelines create --yml-path .azure-pipelines/leji.yml`), and on Azure Repos add a build-validation branch policy on main for pull-request checks."

// HookResult is the result of EnsureLocalHook: created/updated our managed
// hook, left an unmanaged hook untouched ("manual", with the snippet to add),
// or unchanged. Managed says whether the writer owns a standalone hook file
// (".git/hooks" or a custom core.hooksPath dir) or a marker-delimited block
// inside a husky hook.
type HookResult struct {
	Path    string
	Action  CiAction
	Snippet string // set only when Action == "manual"
	Managed string // "file" | "block"
	// Reason is why a "manual" result was returned: "foreign-hook" (an existing
	// unmanaged hook) or "outside-root" (a hooks dir resolving outside the repo).
	// Empty otherwise.
	Reason string
}

const hookMarker = "# leji pre-commit (managed)"

// The failure message is single-quoted for the SHELL: the backticks around
// `leji index` are literal text, and inside a double-quoted echo sh would run them
// as a command substitution (regenerating the index the hook just refused a commit
// over). Never emit an unquoted backtick, "$(", or "$VAR" into generated shell
// unless expansion is the intent.
const hookBody = "#!/bin/sh\n" +
	hookMarker + "\n" +
	"# Validate the context layer and refuse a commit that would leave the stored\n" +
	"# index stale. Local mirror of the CI gate, preferring a repo-local install;\n" +
	"# delete this file to opt out.\n" +
	"LEJI=\"leji\"\n" +
	"[ -x \"node_modules/.bin/leji\" ] && LEJI=\"node_modules/.bin/leji\"\n" +
	"\"$LEJI\" validate || exit 1\n" +
	"\"$LEJI\" index --check || {\n" +
	"   echo 'leji: stored index is stale; run `leji index` and stage the result.' >&2\n" +
	"   exit 1\n" +
	"}\n"

const huskyMarkerStart = "# >>> leji hooks (managed) >>>"
const huskyMarkerEnd = "# <<< leji hooks (managed) <<<"

// huskyBlock runs the same two gates hookBody runs (preferring a repo-local
// install), wrapped in markers so the block can be merged into a husky repo's
// hand-authored .husky/pre-commit without touching its rest.
const huskyBlock = huskyMarkerStart + "\n" +
	"LEJI=\"leji\"\n" +
	"[ -x \"node_modules/.bin/leji\" ] && LEJI=\"node_modules/.bin/leji\"\n" +
	"\"$LEJI\" validate || exit 1\n" +
	"\"$LEJI\" index --check || {\n" +
	"   echo 'leji: stored index is stale; run `leji index` and stage the result.' >&2\n" +
	"   exit 1\n" +
	"}\n" +
	huskyMarkerEnd + "\n"

// hooksPathConfig returns the configured core.hooksPath for the repo at root, or
// "" when unset. Run from the repo root (git -C) so local, global, and system
// scopes resolve; an argv array, never a shell string. Used ONLY to decide
// husky-shape; the write location comes from gitHooksDir.
func hooksPathConfig(root string) string {
	out, err := exec.Command("git", "-C", root, "config", "core.hooksPath").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// gitHooksDir returns the effective hooks directory git would run, resolved absolute
// against rootAbs, or "" when this is not a git repository. `git rev-parse --git-path
// hooks` is authoritative: it honors core.hooksPath scoping and tilde expansion
// (~/hooks -> $HOME/hooks), and works in linked worktrees where .git is a file.
func gitHooksDir(rootAbs string) string {
	out, err := exec.Command("git", "-C", rootAbs, "rev-parse", "--git-path", "hooks").Output()
	if err != nil {
		return ""
	}
	dir := strings.TrimSpace(string(out))
	if dir == "" {
		return ""
	}
	// Lexically normalize to a cleaned absolute path (matches Node's path.resolve):
	// filepath.Join cleans; Clean the already-absolute case too.
	if !filepath.IsAbs(dir) {
		return filepath.Join(rootAbs, dir)
	}
	return filepath.Clean(dir)
}

// huskyShape returns the husky shape of the configured hooks path: "underscore" for
// husky v9 (.husky/_), "direct" for husky v8 (.husky), or "" when not husky-shaped or
// unset. Decides block-vs-file routing and (with the resolved hooks dir) the
// .husky/pre-commit user-file target.
func huskyShape(rootAbs, hooksPath string) string {
	if hooksPath == "" {
		return ""
	}
	resolved := hooksPath
	if !filepath.IsAbs(resolved) {
		resolved = filepath.Join(rootAbs, resolved)
	}
	resolved = fsx.StripSlash(resolved)
	base := filepath.Base(resolved)
	if base == "_" && filepath.Base(filepath.Dir(resolved)) == ".husky" {
		return "underscore"
	}
	if base == ".husky" {
		return "direct"
	}
	return ""
}

// EnsureLocalHook writes a managed pre-commit hook running the same checks CI runs,
// so drift is caught before a commit instead of at the pipeline. The write location
// is git's effective hooks dir (rev-parse --git-path hooks); core.hooksPath decides
// whether a husky repo gets a managed block in the user-editable .husky/pre-commit
// (v8/v9) or a standalone managed hook is written. A hooks dir resolving outside the
// repo (a global core.hooksPath) is never written — the snippet comes back for a
// manual hand-add, as does an existing unmanaged hook.
func EnsureLocalHook(root string) (HookResult, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		rootAbs = root
	}
	hooksDir := gitHooksDir(rootAbs)
	if hooksDir == "" {
		return HookResult{}, errors.New("not a git repository (no .git directory); hooks need one")
	}
	shape := huskyShape(rootAbs, hooksPathConfig(rootAbs))
	// Husky's user-editable hook is .husky/pre-commit: the hooks dir itself for v8
	// (.husky), its parent for v9 (.husky/_). Only a direct v8 hook is run by git
	// itself, so only it must stay executable.
	target := filepath.Join(hooksDir, "pre-commit")
	if shape == "underscore" {
		target = filepath.Join(filepath.Dir(hooksDir), "pre-commit")
	}
	if !fsx.ResolvesUnder(rootAbs, target) {
		// Never write outside the repository; report the computed target for a hand-add.
		if shape != "" {
			return HookResult{Path: fsx.ToPosix(target), Action: "manual", Snippet: huskyBlock, Managed: "block", Reason: "outside-root"}, nil
		}
		return HookResult{Path: fsx.ToPosix(target), Action: "manual", Snippet: hookBody, Managed: "file", Reason: "outside-root"}, nil
	}
	rel, _ := filepath.Rel(rootAbs, target)
	if shape != "" {
		return ensureHuskyBlock(target, fsx.ToPosix(rel), shape == "direct")
	}
	return ensureHookFile(target, fsx.ToPosix(rel))
}

// ensureHookFile writes/refreshes the standalone managed pre-commit hook at
// hookAbs. Ours (marker present) is created/updated; an existing unmanaged hook
// is never touched and its replacement snippet comes back for a manual merge.
func ensureHookFile(hookAbs, rel string) (HookResult, error) {
	existing := ""
	hasExisting := false
	if fsx.IsFile(hookAbs) {
		t, rerr := fsx.ReadText(hookAbs)
		if rerr != nil {
			return HookResult{}, rerr
		}
		existing = t
		hasExisting = true
	}
	if hasExisting && !strings.Contains(existing, hookMarker) {
		return HookResult{Path: rel, Action: "manual", Snippet: hookBody, Managed: "file", Reason: "foreign-hook"}, nil
	}
	if hasExisting && existing == hookBody {
		// Byte-current. A standalone hook is run by git itself, so a non-executable
		// file is a mode-only correction reported updated, not unchanged.
		exec, err := isExecutable(hookAbs)
		if err != nil {
			return HookResult{}, err
		}
		if !exec {
			if err := os.Chmod(hookAbs, 0o755); err != nil {
				return HookResult{}, err
			}
			return HookResult{Path: rel, Action: "updated", Managed: "file"}, nil
		}
		return HookResult{Path: rel, Action: "unchanged", Managed: "file"}, nil
	}
	if err := os.MkdirAll(filepath.Dir(hookAbs), 0o755); err != nil {
		return HookResult{}, err
	}
	if err := os.WriteFile(hookAbs, []byte(hookBody), 0o755); err != nil {
		return HookResult{}, err
	}
	action := "created"
	if hasExisting {
		action = "updated"
	}
	return HookResult{Path: rel, Action: action, Managed: "file"}, nil
}

// ensureHuskyBlock merges the managed block into a husky hook file at hookAbs,
// following the GitLab managed-block rules: replace an existing block in place
// (unchanged if byte-identical), append it after one blank line to a file without
// it, or create the file as "#!/bin/sh" + block (mode 0755) when absent. The rest
// of a user-authored husky hook is left untouched. requireExec (a direct .husky hook
// git runs itself) forces mode 0755: a byte-current but non-executable file is a
// mode-only correction reported "updated".
func ensureHuskyBlock(hookAbs, rel string, requireExec bool) (HookResult, error) {
	if !fsx.IsFile(hookAbs) {
		if err := os.MkdirAll(filepath.Dir(hookAbs), 0o755); err != nil {
			return HookResult{}, err
		}
		if err := os.WriteFile(hookAbs, []byte("#!/bin/sh\n"+huskyBlock), 0o755); err != nil {
			return HookResult{}, err
		}
		return HookResult{Path: rel, Action: "created", Managed: "block"}, nil
	}
	existing, rerr := fsx.ReadText(hookAbs)
	if rerr != nil {
		return HookResult{}, rerr
	}
	merged := mergeManagedBlock(existing, huskyBlock, huskyMarkerStart, huskyMarkerEnd)
	if merged != existing {
		if err := os.WriteFile(hookAbs, []byte(merged), 0o644); err != nil {
			return HookResult{}, err
		}
		if requireExec {
			if err := os.Chmod(hookAbs, 0o755); err != nil {
				return HookResult{}, err
			}
		}
		return HookResult{Path: rel, Action: "updated", Managed: "block"}, nil
	}
	if requireExec {
		exec, err := isExecutable(hookAbs)
		if err != nil {
			return HookResult{}, err
		}
		if !exec {
			if err := os.Chmod(hookAbs, 0o755); err != nil {
				return HookResult{}, err
			}
			return HookResult{Path: rel, Action: "updated", Managed: "block"}, nil
		}
	}
	return HookResult{Path: rel, Action: "unchanged", Managed: "block"}, nil
}

// isExecutable reports whether the file at abs has any executable bit set.
func isExecutable(abs string) (bool, error) {
	info, err := os.Stat(abs)
	if err != nil {
		return false, err
	}
	return info.Mode()&0o111 != 0, nil
}

// CiProvider is the CI provider targeted by `leji ci`.
type CiProvider = string

// CiProviderFromRemote infers the CI provider from a git remote URL: github.com
// hosts GitHub Actions, any gitlab host (gitlab.com or self-managed) GitLab CI,
// Azure DevOps hosts Azure Pipelines. Returns "" when the remote names none of
// them (CircleCI is not remote-inferable).
func CiProviderFromRemote(url string) CiProvider {
	if url == "" {
		return ""
	}
	u := strings.ToLower(url)
	switch {
	case strings.Contains(u, "github.com"):
		return "github"
	case strings.Contains(u, "gitlab"):
		return "gitlab"
	case strings.Contains(u, "dev.azure.com"), strings.Contains(u, "visualstudio.com"):
		return "azure"
	}
	return ""
}

// CiAction is what EnsureCiWorkflow did.
type CiAction = string

// CiResult is what EnsureCiWorkflow did, for the command to report.
type CiResult struct {
	Provider string
	Path     string
	Action   string // "created" | "updated" | "unchanged" | "manual"
	Snippet  string // set only when Action == "manual"
	Note     string // set only when Action == "created" for azure
}

// EnsureCiWorkflow adds a CI workflow that runs `leji validate` (the `leji ci`
// command). GitHub gets its own file; GitLab is create-or-merge into the shared
// `.gitlab-ci.yml` via a marker-delimited managed block; CircleCI is created if
// absent, else left untouched (a snippet is returned). All deterministic text, so
// the SDKs stay byte-identical. Refuses a symlink that escapes root.
func EnsureCiWorkflow(root, provider string) (CiResult, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return CiResult{}, err
	}
	// Local-first: a repo that declares @leji-org/leji runs its lockfile-pinned
	// install; a repo without one falls back to `npx @leji-org/leji@1`.
	local := declaresLejiDep(rootAbs) && hasNpmLockfile(rootAbs)
	switch provider {
	case "github":
		abs := filepath.Join(rootAbs, CIWorkflowPath)
		if err := guardWithinRoot(rootAbs, abs, CIWorkflowPath); err != nil {
			return CiResult{}, err
		}
		if _, err := os.Stat(abs); err == nil {
			return CiResult{Provider: provider, Path: CIWorkflowPath, Action: "unchanged"}, nil
		}
		if err := writeFileAtomic(rootAbs, abs, CIWorkflowPath, BuildGithubWorkflow(local)); err != nil {
			return CiResult{}, err
		}
		return CiResult{Provider: provider, Path: CIWorkflowPath, Action: "created"}, nil
	case "gitlab":
		abs := filepath.Join(rootAbs, GitlabCIPath)
		if err := guardWithinRoot(rootAbs, abs, GitlabCIPath); err != nil {
			return CiResult{}, err
		}
		block := BuildGitlabBlock(local)
		if _, err := os.Stat(abs); err != nil {
			if err := writeFileAtomic(rootAbs, abs, GitlabCIPath, block); err != nil {
				return CiResult{}, err
			}
			return CiResult{Provider: provider, Path: GitlabCIPath, Action: "created"}, nil
		}
		text, err := fsx.ReadText(abs)
		if err != nil {
			return CiResult{}, err
		}
		merged := mergeGitlabBlock(text, block)
		if merged == text {
			return CiResult{Provider: provider, Path: GitlabCIPath, Action: "unchanged"}, nil
		}
		if err := writeFileAtomic(rootAbs, abs, GitlabCIPath, merged); err != nil {
			return CiResult{}, err
		}
		return CiResult{Provider: provider, Path: GitlabCIPath, Action: "updated"}, nil
	case "circleci":
		abs := filepath.Join(rootAbs, CircleCIConfigPath)
		if err := guardWithinRoot(rootAbs, abs, CircleCIConfigPath); err != nil {
			return CiResult{}, err
		}
		if _, err := os.Stat(abs); err == nil {
			return CiResult{Provider: provider, Path: CircleCIConfigPath, Action: "manual", Snippet: BuildCircleCiSnippet(local)}, nil
		}
		if err := writeFileAtomic(rootAbs, abs, CircleCIConfigPath, BuildCircleCiConfig(local)); err != nil {
			return CiResult{}, err
		}
		return CiResult{Provider: provider, Path: CircleCIConfigPath, Action: "created"}, nil
	case "azure":
		abs := filepath.Join(rootAbs, AzurePipelinePath)
		if err := guardWithinRoot(rootAbs, abs, AzurePipelinePath); err != nil {
			return CiResult{}, err
		}
		// The activation note is intentionally created-only: a re-run on an existing
		// pipeline file stays quiet (no note) rather than repeating the setup guidance.
		if _, err := os.Stat(abs); err == nil {
			return CiResult{Provider: provider, Path: AzurePipelinePath, Action: "unchanged"}, nil
		}
		if err := writeFileAtomic(rootAbs, abs, AzurePipelinePath, BuildAzurePipeline(local)); err != nil {
			return CiResult{}, err
		}
		return CiResult{Provider: provider, Path: AzurePipelinePath, Action: "created", Note: AzureActivationNote}, nil
	}
	// Unreachable from the CLI (it validates first); guards direct helper callers so
	// an unknown provider errors consistently across the three SDKs.
	return CiResult{}, fmt.Errorf("unknown provider %q", provider)
}

// hasNpmLockfile reports whether an npm lockfile is present. The generated
// local-install job runs `npm ci`, which requires one: a pnpm, Yarn or Bun
// repository can declare the dependency and still have none, and the job would fail
// before Leji ran.
func hasNpmLockfile(rootAbs string) bool {
	return fsx.IsFile(filepath.Join(rootAbs, "package-lock.json"))
}

// declaresLejiDep reports whether the repo's root package.json declares
// @leji-org/leji under dependencies or devDependencies. Deterministic and identical
// across SDKs: read bytes, strip a single leading UTF-8 BOM, strict JSON parse (any
// error -> not declared), and count dependencies/devDependencies only when they are
// JSON objects holding the exact key (any other type -> absent, never an error). A
// generic map decode (not a fixed struct) so malformed inputs match the TS reference.
func declaresLejiDep(rootAbs string) bool {
	data, err := os.ReadFile(filepath.Join(rootAbs, "package.json"))
	if err != nil {
		return false
	}
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
	var pkg map[string]json.RawMessage
	if err := json.Unmarshal(data, &pkg); err != nil {
		return false
	}
	for _, field := range []string{"dependencies", "devDependencies"} {
		raw, ok := pkg[field]
		if !ok {
			continue
		}
		var deps map[string]json.RawMessage
		// A non-object value (array/scalar) errors; JSON null decodes to a nil map.
		// Both are treated as absent, never an error.
		if err := json.Unmarshal(raw, &deps); err != nil || deps == nil {
			continue
		}
		if _, ok := deps[depName]; ok {
			return true
		}
	}
	return false
}

func guardWithinRoot(rootAbs, abs, rel string) error {
	if !fsx.ResolvesUnder(rootAbs, abs) {
		return fmt.Errorf("refusing to write through a symlink that escapes the target: %q", rel)
	}
	return nil
}

// writeFileAtomic writes via a sibling temp file then rename, so an interrupted
// write never leaves a partial file. On failure the temp is removed and a
// deterministic, OS-text-free error is returned (byte-identical across SDKs).
func writeFileAtomic(rootAbs, abs, rel, contents string) error {
	tmp := abs + ".leji-tmp"
	// The sibling temp path must not escape the root either (a planted
	// `<target>.leji-tmp` symlink would otherwise be written through before the rename).
	if err := guardWithinRoot(rootAbs, tmp, rel); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return writeFailure(rel, err)
	}
	if err := os.WriteFile(tmp, []byte(contents), 0o644); err != nil {
		_ = os.Remove(tmp)
		return writeFailure(rel, err)
	}
	if err := maybeInjectWriteFailure(); err != nil {
		_ = os.Remove(tmp)
		return writeFailure(rel, err)
	}
	if err := os.Rename(tmp, abs); err != nil {
		_ = os.Remove(tmp)
		return writeFailure(rel, err)
	}
	return nil
}

// maybeInjectWriteFailure is test-only fault injection (LEJI_TEST_FAIL_RENAME):
// simulates failure after the temp file exists but before the rename commits.
func maybeInjectWriteFailure() error {
	if os.Getenv("LEJI_TEST_FAIL_RENAME") != "" {
		return errors.New("injected write failure")
	}
	return nil
}

// writeFailure renders a deterministic, OS-text-free message, keeping stderr
// byte-identical across the SDKs.
func writeFailure(rel string, err error) error {
	if errors.Is(err, os.ErrPermission) {
		return fmt.Errorf("cannot write %q: permission denied", rel)
	}
	return fmt.Errorf("cannot write %q", rel)
}

// mergeGitlabBlock inserts/replaces the managed block in an existing
// `.gitlab-ci.yml`: replaces the first block, drops later duplicates, leaving one.
func mergeGitlabBlock(text, block string) string {
	return mergeManagedBlock(text, block, gitlabMarkerStart, gitlabMarkerEnd)
}

// mergeManagedBlock inserts/replaces a marker-delimited managed block, byte-exactly.
// Replaces the first block, drops later duplicates, leaving one; a block-less file
// gets the block appended after one blank line; an empty file becomes the block.
func mergeManagedBlock(text, block, startMarker, endMarker string) string {
	if start, end, ok := managedBlockSpan(text, startMarker, endMarker); ok {
		return text[:start] + block + stripManagedBlocks(text[end:], startMarker, endMarker)
	}
	if text == "" {
		return block
	}
	sep := "\n\n"
	if strings.HasSuffix(text, "\n") {
		sep = "\n"
	}
	return text + sep + block
}

// managedBlockSpan returns the [start, end) byte span of the first managed block
// in text, or ok=false if there is none.
func managedBlockSpan(text, startMarker, endMarker string) (start, end int, ok bool) {
	start = strings.Index(text, startMarker)
	if start == -1 {
		return 0, 0, false
	}
	rel := strings.Index(text[start:], endMarker)
	if rel == -1 {
		return 0, 0, false
	}
	endMarkerIdx := start + rel
	nl := strings.Index(text[endMarkerIdx:], "\n")
	if nl == -1 {
		end = len(text)
	} else {
		end = endMarkerIdx + nl + 1
	}
	return start, end, true
}

// stripManagedBlocks removes every managed block from text.
func stripManagedBlocks(text, startMarker, endMarker string) string {
	var out strings.Builder
	rest := text
	for {
		start, end, ok := managedBlockSpan(rest, startMarker, endMarker)
		if !ok {
			out.WriteString(rest)
			return out.String()
		}
		out.WriteString(rest[:start])
		rest = rest[end:]
	}
}

// Local-first CI: a repo that declares @leji-org/leji installs its lockfile-pinned
// deps and runs the local bin (`npx --no-install` fails loudly rather than fetch a
// floating version); a repo without one falls back to `npx @leji-org/leji@1`, which
// pins the SDK to its current major (@1): additive-only within a major so a valid
// layer stays valid, and a breaking major never reaches adopter CI without a bump.

// BuildGithubWorkflow is the GitHub Actions workflow file. Byte-identical across SDKs.
func BuildGithubWorkflow(local bool) string {
	run := "      - run: npx -y @leji-org/leji@1 validate\n" +
		"      - run: npx -y @leji-org/leji@1 index --check\n"
	if local {
		run = "      - run: npm ci\n" +
			"      - run: npx --no-install @leji-org/leji validate\n" +
			"      - run: npx --no-install @leji-org/leji index --check\n"
	}
	return "name: leji\n" +
		"on: [push, pull_request]\n" +
		"jobs:\n" +
		"  validate:\n" +
		"    runs-on: ubuntu-latest\n" +
		"    steps:\n" +
		"      - uses: actions/checkout@v4\n" +
		"      - uses: actions/setup-node@v4\n" +
		"        with:\n" +
		"          node-version: '22'\n" +
		run
}

// BuildGitlabBlock is the GitLab CI marker-delimited job merged into the shared
// .gitlab-ci.yml.
func BuildGitlabBlock(local bool) string {
	script := "    - npx -y @leji-org/leji@1 validate\n" +
		"    - npx -y @leji-org/leji@1 index --check\n"
	if local {
		script = "    - npm ci\n" +
			"    - npx --no-install @leji-org/leji validate\n" +
			"    - npx --no-install @leji-org/leji index --check\n"
	}
	return gitlabMarkerStart + "\n" +
		"leji-validate:\n" +
		// `.pre` is always available. Without an explicit stage GitLab assigns
		// `test`, and a pipeline whose own `stages:` omits it rejects the config.
		"  stage: .pre\n" +
		"  image: node:22\n" +
		"  script:\n" +
		script +
		gitlabMarkerEnd + "\n"
}

// circleCiSteps is the CircleCI job steps shared by the config and the hand-add snippet.
func circleCiSteps(local bool) string {
	if local {
		return "      - checkout\n" +
			"      - run: npm ci\n" +
			"      - run: npx --no-install @leji-org/leji validate\n" +
			"      - run: npx --no-install @leji-org/leji index --check\n"
	}
	return "      - checkout\n" +
		"      - run: npx -y @leji-org/leji@1 validate\n" +
		"      - run: npx -y @leji-org/leji@1 index --check\n"
}

// BuildCircleCiConfig is the CircleCI config written when .circleci/config.yml is absent.
func BuildCircleCiConfig(local bool) string {
	return "version: 2.1\n" +
		"jobs:\n" +
		"  leji-validate:\n" +
		"    docker:\n" +
		"      - image: node:22\n" +
		"    steps:\n" +
		circleCiSteps(local) +
		"workflows:\n" +
		"  leji:\n" +
		"    jobs:\n" +
		"      - leji-validate\n"
}

// BuildCircleCiSnippet is the jobs + workflows fragment to add by hand to an
// existing CircleCI config.
func BuildCircleCiSnippet(local bool) string {
	return "jobs:\n" +
		"  leji-validate:\n" +
		"    docker:\n" +
		"      - image: node:22\n" +
		"    steps:\n" +
		circleCiSteps(local) +
		"workflows:\n" +
		"  leji:\n" +
		"    jobs:\n" +
		"      - leji-validate\n"
}

// BuildAzurePipeline is the Azure Pipelines config: a dedicated
// .azure-pipelines/leji.yml the user wires to a pipeline.
func BuildAzurePipeline(local bool) string {
	steps := "  - script: npx -y @leji-org/leji@1 validate\n" +
		"    displayName: leji validate\n" +
		"  - script: npx -y @leji-org/leji@1 index --check\n" +
		"    displayName: leji index --check\n"
	if local {
		steps = "  - script: npm ci\n" +
			"    displayName: install\n" +
			"  - script: npx --no-install @leji-org/leji validate\n" +
			"    displayName: leji validate\n" +
			"  - script: npx --no-install @leji-org/leji index --check\n" +
			"    displayName: leji index --check\n"
	}
	return "trigger:\n" +
		"  - main\n" +
		"pool:\n" +
		"  vmImage: ubuntu-latest\n" +
		"steps:\n" +
		"  - task: NodeTool@0\n" +
		"    inputs:\n" +
		"      versionSpec: '22.x'\n" +
		steps
}

func hostIDs() []string {
	ids := make([]string, len(detect.HostSpecs))
	for i, s := range detect.HostSpecs {
		ids[i] = s.ID
	}
	return ids
}

// agentTokenRe is the agent-profile schema's id pattern: a kebab identifier, safe
// as a path segment and safe to interpolate into YAML frontmatter and JSON.
var agentTokenRe = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

func assertAgentToken(label, value string) error {
	if !agentTokenRe.MatchString(value) {
		return fmt.Errorf("%s must be lowercase letters, digits, and single dashes (e.g. \"thought-partner\"); got %q", label, value)
	}
	return nil
}

// BuildAgentProfile is a starter agent profile. `reviewer` (the default) keeps the
// review-focused posture; any other role gets a neutral template. The frontmatter
// satisfies the agent-profile schema (id/name/role/requiredRead/mustAskWhen).
func BuildAgentProfile(name, role, hostID, rootPath string) string {
	hostLine := ""
	hostNote := ""
	if hostID != "" {
		hostLine = "host: " + hostID + "\n"
		hostNote = " (host `" + hostID + "`)"
	}
	head := "---\n" +
		"id: " + name + "\n" +
		"name: " + name + "\n" +
		"role: " + role + "\n" +
		hostLine +
		"inherits: core\n"
	if role == "reviewer" {
		return head +
			"purpose: Independent review of proposed context-layer changes before a person approves.\n" +
			"requiredRead:\n" +
			"  - " + fsx.JoinUnderRoot(rootPath, "boot-profile.md") + "\n" +
			"  - " + fsx.JoinUnderRoot(rootPath, "agents/core.md") + "\n" +
			"mustAskWhen:\n" +
			"  - a proposal weakens an invariant or guardrail\n" +
			"  - a change to settled behavior lacks a decision record\n" +
			"---\n\n" +
			"# " + name + "\n\n" +
			"A second agent" + hostNote + " that reviews context-layer proposals against the spec and this\n" +
			"layer's own rules before a person approves. Inherits the core posture; it never loosens it.\n\n" +
			"## Review focus\n\n" +
			"- The proposal matches how this team actually works (domain, system, governance).\n" +
			"- Placeholders are gone and claims are grounded in the repository.\n" +
			"- A change to settled behavior carries a decision record.\n"
	}
	return head +
		"requiredRead:\n" +
		"  - " + fsx.JoinUnderRoot(rootPath, "boot-profile.md") + "\n" +
		"  - " + fsx.JoinUnderRoot(rootPath, "agents/core.md") + "\n" +
		"mustAskWhen:\n" +
		"  - a change would weaken an invariant or guardrail\n" +
		"  - a change to settled behavior lacks a decision record\n" +
		"---\n\n" +
		"# " + name + "\n\n" +
		"The `" + role + "` agent" + hostNote + " bound to this context layer. Inherits the core posture\n" +
		"from the boot profile and core profile; it never loosens it.\n\n" +
		"## Responsibilities\n\n" +
		"- TODO: describe what this agent is responsible for.\n" +
		"- TODO: list what it may do unprompted and what needs a human gate.\n"
}

type AgentOptions struct {
	Host string
	Name string
	Role string
}

// AgentResult is what AddAgent did, for the command to report. Each artifact is
// independently idempotent: a *Created/ManifestChanged of false means it was
// already there.
type AgentResult struct {
	Name            string
	Role            string
	HostID          string // "" for a host-agnostic resident agent (no --host)
	ProfilePath     string
	ProfileCreated  bool
	ManifestChanged bool
}

// AddAgent wires a named agent into an existing layer (the `leji agent` command):
// writes a starter profile and binds it in leji.json via an in-place text edit.
// Never overwrites an existing profile; re-running with the same args is a no-op.
func AddAgent(root string, m *manifest.Manifest, opts AgentOptions) (AgentResult, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		rootAbs = root
	}
	name := opts.Name
	role := opts.Role
	if role == "" {
		role = "reviewer"
	}
	if err := assertAgentToken("agent name", name); err != nil {
		return AgentResult{}, err
	}
	if err := assertAgentToken("agent role", role); err != nil {
		return AgentResult{}, err
	}
	// --host is optional: a host pins the profile to a specific external CLI; with
	// none, this is a host-agnostic resident agent any host can run. Either way we
	// never write a vendor file; those are migrated from an existing entrypoint,
	// never created.
	hostID := ""
	if opts.Host != "" {
		id := detect.ResolveHostId(opts.Host)
		var spec *detect.HostSpec
		if id != "" {
			spec = detect.SpecByID(id)
		}
		if spec == nil {
			return AgentResult{}, fmt.Errorf("unknown host %q; known: %s", opts.Host, strings.Join(hostIDs(), ", "))
		}
		hostID = spec.ID
	}

	base := manifest.EffectiveAgentProfilesPath(m)
	if !strings.HasSuffix(base, "/") {
		base += "/"
	}
	profileRel := base + name + ".md"
	profileAbs := filepath.Join(rootAbs, profileRel)
	profileCreated := false
	if !fsx.IsFile(profileAbs) {
		if !fsx.ResolvesUnder(rootAbs, profileAbs) {
			return AgentResult{}, fmt.Errorf("refusing to write through a symlink that escapes the target: %q", profileRel)
		}
		if err := os.MkdirAll(filepath.Dir(profileAbs), 0o755); err != nil {
			return AgentResult{}, err
		}
		if err := os.WriteFile(profileAbs, []byte(BuildAgentProfile(name, role, hostID, m.RootPath)), 0o644); err != nil {
			return AgentResult{}, err
		}
		profileCreated = true
	}

	manifestAbs := filepath.Join(rootAbs, "leji.json")
	original, err := fsx.ReadText(manifestAbs)
	if err != nil {
		return AgentResult{}, err
	}
	text, _, err := manifest.BindAgentInManifestText(original, name, profileRel)
	if err != nil {
		return AgentResult{}, err
	}
	manifestChanged := text != original
	if manifestChanged {
		if err := os.WriteFile(manifestAbs, []byte(text), 0o644); err != nil {
			return AgentResult{}, err
		}
	}

	return AgentResult{
		Name:            name,
		Role:            role,
		HostID:          hostID,
		ProfilePath:     profileRel,
		ProfileCreated:  profileCreated,
		ManifestChanged: manifestChanged,
	}, nil
}

// assertCleanWorkingTree refuses a dirty working tree: the "git restore cleanly
// undoes Leji's writes" safety net only holds if the tree started clean. A non-git
// directory has no such net and is allowed (bootstrapping before `git init`).
func assertCleanWorkingTree(root string) error {
	if clean, isRepo := git.WorkingTreeClean(root); isRepo && !clean {
		return errors.New("the working tree has uncommitted changes; commit or stash them first so this stays cleanly reversible (preview with --dry-run)")
	}
	return nil
}

// InitLayer bootstraps a context layer. Returns an error when leji.json exists.
// With DryRun, computes the write plan and touches nothing.
func InitLayer(opts Options) (Result, error) {
	// Flag values are checked before anything on disk is read, the way the CLI
	// parser rejects --mode/--level.
	if opts.Agent != "" {
		if _, err := assertAgentHost(opts.Agent); err != nil {
			return Result{}, err
		}
	}
	root, _ := filepath.Abs(opts.Dir)
	if _, err := os.Stat(filepath.Join(root, "leji.json")); err == nil {
		return Result{}, errors.New("leji.json already exists here; init refuses to overwrite an existing layer")
	}
	if !opts.DryRun {
		if err := assertCleanWorkingTree(root); err != nil {
			return Result{}, err
		}
	}
	detected := detect.DetectHosts(detect.Options{Root: root})
	a, err := prompt(opts)
	if err != nil {
		return Result{}, err
	}
	a.categories = normalizeCategories(a.categories, a.mode)
	// The interactive root path (and every path derived from it) must stay a
	// relative, in-tree path before anything is written, so an answer like
	// "../../etc/" or an absolute path cannot escape the target directory.
	if err := validateRelPath(fsx.StripSlash(a.rootPath)); err != nil {
		return Result{}, fmt.Errorf("context root %q is not a safe relative path: %w", a.rootPath, err)
	}
	m, ord := buildManifest(a, nil)
	r := a.rootPath
	layout := a.effectiveLayout()
	manifestBytes := serializeManifest(ord)

	// Assemble the files init owns, in write order. leji.json comes first so the
	// overwrite guard is effective on a retry after an interrupted run.
	writes := []writeplan.PlannedWrite{{Rel: "leji.json", Content: string(manifestBytes)}}
	writes = append(writes, writeplan.PlannedWrite{Rel: m.BootProfilePath, Content: buildBootProfile(a)})
	// The portable discovery adapter: a pointer-only AGENTS.md so any host that
	// auto-loads it cold-starts into the boot profile. Default-on; --no-agents
	// skips it, and an existing file is never touched (it stays in wontModify).
	if !opts.NoAgents && !fsx.IsFile(filepath.Join(root, detect.PortableAdapter)) {
		writes = append(writes, writeplan.PlannedWrite{Rel: detect.PortableAdapter, Content: detect.AdapterContent(m.BootProfilePath)})
	}
	for _, category := range a.categories {
		if category == "decisions" {
			continue
		}
		stub := categoryStubs[category]
		writes = append(writes, writeplan.PlannedWrite{
			Rel:     fsx.JoinUnderRoot(r, category+"/") + stub.file,
			Content: stubContent(stub.title, stub.summary, stub.body),
		})
	}
	if a.mode == "solo" {
		// Solo starters live in their category directories, so the existing
		// category index files govern them with no extra wiring.
		for _, s := range soloStarters {
			writes = append(writes, writeplan.PlannedWrite{Rel: fsx.JoinUnderRoot(r, s.category+"/") + s.file, Content: readTemplate(s.template)})
		}
	}
	writes = append(writes, writeplan.PlannedWrite{Rel: fsx.JoinUnderRoot(r, "decisions/") + "0001-adopt-leji.md", Content: buildFirstDecision(a)})
	// Write a stub index file per category so the manifest's `indexes` resolve to
	// real, populated content.
	for _, category := range a.categories {
		writes = append(writes, writeplan.PlannedWrite{Rel: layout.ContextDir + category + ".md", Content: categoryIndexFile(r, category)})
	}
	writes = append(writes, writeplan.PlannedWrite{Rel: layout.AgentsDir + "core.md", Content: buildCoreProfile(a)})
	writes = append(writes, writeplan.PlannedWrite{Rel: BriefPath(r), Content: buildBrief(a)})
	if a.level == "indexed" {
		// The changelog records the paths seeded; compute from the planned set
		// (everything except the changelog and the generated index). Dot-paths
		// (the transient `.leji/` brief) are excluded from the governed machine
		// surface, so they never seed the changelog.
		var seeded []string
		for _, w := range writes {
			if !hasDotSegment(w.Rel) {
				seeded = append(seeded, w.Rel)
			}
		}
		sort.Strings(seeded)
		writes = append(writes, writeplan.PlannedWrite{Rel: manifest.EffectiveChangelogPath(m), Content: buildChangelog(a, seeded)})
	}

	// Foreign entrypoint files Leji detects but will never modify.
	var wontModify []string
	for _, rel := range validate.KnownVendorFiles {
		if fsx.IsFile(filepath.Join(root, rel)) {
			wontModify = append(wontModify, rel)
		}
	}
	// The index is generated at every level, not only at `indexed`. `leji index
	// --check` is a CI gate for any layer, so a scaffold that omits the index hands
	// the adopter a red first run on the documented happy path. The changelog stays
	// gated: it is an `indexed` requirement, and seeding one at `core` over-scaffolds.
	indexRel := manifest.EffectiveIndexPath(m)
	planWrites := append(append([]writeplan.PlannedWrite{}, writes...),
		writeplan.PlannedWrite{Rel: indexRel, Content: ""})
	plan := planWithIndexTruth(writeplan.Build(root, planWrites, wontModify, nil), indexRel)

	if opts.DryRun {
		return Result{Written: []string{}, Manifest: m, Mode: a.mode, Plan: plan, DryRun: true, Detected: detected, Root: root}, nil
	}

	var written []string
	if err := os.MkdirAll(root, 0o755); err != nil {
		return Result{}, err
	}
	// The tracked-file preflight and the `.leji/` ignore run BEFORE any write at
	// all, so the private onboarding workspace can never land in git and a failed
	// preflight leaves the tree untouched.
	if err := assertLejiWorkspacePrivate(root, r); err != nil {
		return Result{}, err
	}
	if err := ensureLejiGitignored(root); err != nil {
		return Result{}, err
	}
	// leji.json is created exclusively (O_EXCL): this closes the check-then-write
	// race and refuses to follow a symlink at the final component, so a concurrent
	// init or a planted symlink cannot be overwritten or escaped. Every other file
	// goes through writeFileOnce so nothing is overwritten.
	if !fsx.ResolvesUnder(root, filepath.Join(root, "leji.json")) {
		return Result{}, fmt.Errorf("refusing to write through a symlink that escapes the target: %q", "leji.json")
	}
	if err := writeManifestExclusive(filepath.Join(root, "leji.json"), manifestBytes, "init"); err != nil {
		return Result{}, err
	}
	written = append(written, "leji.json")
	// The changelog is held back until the index generates cleanly. Seeding it off a
	// tree that cannot be indexed would leave a layer claiming `indexed` with a
	// changelog, no index, and a `leji.json` that blocks re-running `init`.
	changelogRel := ""
	if a.level == "indexed" {
		changelogRel = manifest.EffectiveChangelogPath(m)
	}
	var changelogWrite *writeplan.PlannedWrite
	for i, w := range writes[1:] {
		if changelogRel != "" && w.Rel == changelogRel {
			changelogWrite = &writes[1:][i]
			continue
		}
		if err := writeFileOnce(root, w.Rel, w.Content, &written); err != nil {
			return Result{}, err
		}
	}

	// The whole of the `leji index` rule, not half of it: WriteIndex reports a hard
	// generation failure in Result.Findings with a nil error, so checking only the
	// error return would miss it. On failure the file is not claimed, the dependent
	// changelog is not seeded, and the findings travel out for the caller to report.
	idx, err := indexgen.WriteIndex(root, m)
	if err != nil {
		return Result{}, err
	}
	if !findings.HasErrors(idx.Findings) {
		written = append(written, indexRel)
		if changelogWrite != nil {
			if err := writeFileOnce(root, changelogWrite.Rel, changelogWrite.Content, &written); err != nil {
				return Result{}, err
			}
		}
	}

	sort.Strings(written)
	return Result{Written: written, Findings: idx.Findings, Manifest: m, Mode: a.mode, Plan: plan, DryRun: false, Detected: detected, Root: root}, nil
}

// EnteringTheLayer is the post-init guidance printed by the CLI. The team copy
// is unchanged from pre-mode releases; solo swaps one sentence to name the
// interview.
func EnteringTheLayer(m *manifest.Manifest, mode string) string {
	brief := BriefPath(m.RootPath)
	var how []string
	if mode == "solo" {
		how = []string{
			"The brief teaches the agent the Leji spec and points it at this repo: it reads your",
			"code, interviews you for identity and writing style (answer in text or drop files),",
			"and fills in real context. Prefer to do it yourself?",
		}
	} else {
		how = []string{
			"The brief teaches the agent the Leji spec and points it at this repo: it reads your",
			"code, asks what it cannot infer, and fills in real context. Prefer to do it yourself?",
		}
	}
	lines := []string{
		"",
		"The scaffold is in place, but the content is still placeholder. Hand it to your agent",
		"to populate from your actual repository:",
		"",
		"   claude \"Read ./" + brief + " and follow it.\"",
		"   codex \"Read ./" + brief + " and follow it.\"",
		"",
	}
	lines = append(lines, how...)
	lines = append(lines,
		"Edit the seeded documents directly. Either way, check progress with:",
		"",
		"   leji validate --content   # placeholder / thin-content warnings",
		"   leji conformance          # the level reached and what is next",
	)
	return strings.Join(lines, "\n")
}

// promptHostIDs are the CLI hosts that accept an inline prompt argument, so Leji
// can launch the handoff (`claude "..."`, `codex "..."`). Directory-style IDE hosts
// (Cursor, Windsurf) and unverified prompt syntaxes (Gemini) are left out; when only
// those are present the offer is skipped and the printed instructions stand.
var promptHostIDs = []string{"claude-code", "codex"}

type promptHost struct {
	id   string
	bin  string
	name string
}

// LaunchResult is the outcome of spawning an agent: Started=false means it never
// started; a non-nil Err with Started=true means it ran but did not finish cleanly.
type LaunchResult struct {
	Started bool
	Err     error
}

// HandoffIO is injectable I/O for the handoff offer, so the interactive flow is
// deterministically testable. DefaultHandoffIO is the production wiring.
type HandoffIO struct {
	// ReadLine prompts and returns one trimmed line; "" means accept the default.
	ReadLine func(question, fallback string) string
	// Launch runs the chosen agent with the prompt from cwd; cwd anchors the agent
	// at the layer root so a relative prompt path resolves (matters for
	// `leji start --root <dir>`). An empty cwd uses the current directory. Host
	// flags (from `leji start -- <flags>`) go before the prompt argument.
	Launch func(bin, promptArg, cwd string, hostArgs []string) LaunchResult
	// Run runs a host subcommand (the MCP presence check / register) from cwd. When
	// quiet, child output is suppressed (the check); otherwise it inherits the
	// terminal so the user sees the host's own output.
	Run func(bin string, args []string, cwd string, quiet bool) LaunchResult
}

// DefaultHandoffIO wires a one-shot stdin line reader and a stdio-inherit spawn.
func DefaultHandoffIO(in io.Reader, out io.Writer) *HandoffIO {
	reader := bufio.NewReader(in)
	return &HandoffIO{
		ReadLine: func(question, fallback string) string {
			io.WriteString(out, question+" ["+fallback+"]: ")
			line, err := reader.ReadString('\n')
			if err != nil && line == "" {
				return ""
			}
			return strings.TrimSpace(line)
		},
		Launch: func(bin, promptArg, cwd string, hostArgs []string) LaunchResult {
			// cwd anchors the agent at the layer root so a relative prompt path
			// resolves. Host flags (from `leji start -- <flags>`) go before the
			// prompt argument.
			args := append(append([]string{}, hostArgs...), promptArg)
			cmd := exec.Command(bin, args...)
			cmd.Dir = cwd
			cmd.Stdin = os.Stdin
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
			err := cmd.Run()
			if err == nil {
				return LaunchResult{Started: true}
			}
			// An ExitError means the process started but exited non-zero or was
			// signalled; anything else (e.g. exec.Error) means it never started.
			var exitErr *exec.ExitError
			if errors.As(err, &exitErr) {
				return LaunchResult{Started: true, Err: err}
			}
			return LaunchResult{Started: false, Err: err}
		},
		Run: func(bin string, args []string, cwd string, quiet bool) LaunchResult {
			cmd := exec.Command(bin, args...)
			cmd.Dir = cwd
			if !quiet {
				cmd.Stdin = os.Stdin
				cmd.Stdout = os.Stdout
				cmd.Stderr = os.Stderr
			}
			err := cmd.Run()
			if err == nil {
				return LaunchResult{Started: true}
			}
			var exitErr *exec.ExitError
			if errors.As(err, &exitErr) {
				return LaunchResult{Started: true, Err: err}
			}
			return LaunchResult{Started: false, Err: err}
		},
	}
}

// promptCapableHosts returns the detected on-PATH hosts launchable with an inline
// prompt, ranked (detected is already strongest-first).
func promptCapableHosts(detected []detect.DetectedHost) []promptHost {
	var out []promptHost
	for _, h := range detected {
		if !h.OnPath || !contains(promptHostIDs, h.ID) {
			continue
		}
		if spec := detect.SpecByID(h.ID); spec != nil {
			out = append(out, promptHost{id: h.ID, bin: spec.Bins[0], name: spec.Name})
		}
	}
	return out
}

// resolvePromptHost returns the launchable host an --agent value names (id or
// alias), or nil when it names none. Detection state is irrelevant: the value is
// either a host Leji can launch or it is not.
func resolvePromptHost(agent string) *promptHost {
	id := detect.ResolveHostId(agent)
	if id == "" || !contains(promptHostIDs, id) {
		return nil
	}
	spec := detect.SpecByID(id)
	if spec == nil {
		return nil
	}
	return &promptHost{id: spec.ID, bin: spec.Bins[0], name: spec.Name}
}

// assertAgentHost rejects an --agent value naming no launchable host, the way
// --mode and --level reject unknown values: the accepted set is named and the
// command fails. Silently accepting it made `--agent nosuchhost` behave as if the
// flag were never passed.
func assertAgentHost(agent string) (*promptHost, error) {
	host := resolvePromptHost(agent)
	if host == nil {
		return nil, fmt.Errorf("--agent must be a launchable host (%s); got %q", strings.Join(promptHostIDs, ", "), agent)
	}
	return host, nil
}

// pickFromMultiple asks which of several detected hosts to launch (numbered), or
// none. Requires an explicit in-range number; empty/n/junk/out-of-range all skip,
// so we never launch an agent the user did not pick.
func pickFromMultiple(hosts []promptHost, hio *HandoffIO, out io.Writer) *promptHost {
	io.WriteString(out, "\nDetected coding agents on your PATH:\n")
	for i, h := range hosts {
		fmt.Fprintf(out, "   %d) %s\n", i+1, h.name)
	}
	a := strings.ToLower(hio.ReadLine("Which agent? (number, or Enter to skip)", "skip"))
	if a == "" || a == "n" || a == "no" {
		return nil
	}
	if n, err := strconv.Atoi(a); err == nil && n >= 1 && n <= len(hosts) {
		return &hosts[n-1]
	}
	return nil
}

// chooseHost asks which detected host to hand off to: a single host confirms
// [Y/n]; several are numbered via pickFromMultiple.
func chooseHost(hosts []promptHost, promptArg string, hio *HandoffIO, out io.Writer) *promptHost {
	if len(hosts) == 1 {
		h := hosts[0]
		a := strings.ToLower(hio.ReadLine("Hand the scaffold to "+h.name+" now ("+h.bin+" \""+promptArg+"\")?", "Y/n"))
		if a == "" || a == "y" || a == "yes" {
			return &h
		}
		return nil
	}
	return pickFromMultiple(hosts, hio, out)
}

// launchHost launches a chosen host from cwd. Returns true only on a clean exit;
// a spawn failure or non-zero/signalled exit returns false (caller falls back).
func launchHost(host promptHost, promptArg string, hio *HandoffIO, cwd string, out io.Writer, hostArgs []string) bool {
	argsShown := ""
	if len(hostArgs) > 0 {
		argsShown = strings.Join(hostArgs, " ") + " "
	}
	fmt.Fprintf(out, "\nStarting %s: %s %s\"%s\"\n\n", host.name, host.bin, argsShown, promptArg)
	res := hio.Launch(host.bin, promptArg, cwd, hostArgs)
	if !res.Started {
		fmt.Fprintf(os.Stderr, "\nleji: could not start %s (%v).\n", host.bin, res.Err)
		return false
	}
	// Started but exited non-zero or was killed (e.g. Ctrl-C): did not finish
	// cleanly, so fall back to the printed instructions.
	return res.Err == nil
}

// McpOfferOutcome tells HandoffOffer how to proceed after the MCP offer resolved
// its target host: follow its own flow ("default" or the zero value), launch the
// host the user already picked there ("launch"), or suppress the handoff entirely
// ("skip", the user declined the pick).
type McpOfferOutcome struct {
	next string      // "", "default", "launch", or "skip"
	host *promptHost // the picked host when next == "launch"
}

// HandoffOffer offers to hand the scaffold to a detected agent and launch it.
// Interactive only (never fires non-interactively, so scripted/CI output and
// cross-SDK parity are unchanged). Returns true when an agent launched and finished
// cleanly, false to fall back to the printed instructions.
func HandoffOffer(m *manifest.Manifest, detected []detect.DetectedHost, interactive bool, hio *HandoffIO, out io.Writer, agent, cwd string, mcp McpOfferOutcome) (bool, error) {
	if !interactive {
		return false, nil
	}
	promptArg := "Read ./" + BriefPath(m.RootPath) + " and follow it."
	// --agent forces a specific launchable host (skipping the prompt); otherwise the
	// detected hosts drive the offer. The interactive gate above keeps this off the
	// scripted/CI path, so cross-SDK parity is unchanged.
	var chosen *promptHost
	switch {
	case agent != "":
		host, err := assertAgentHost(agent)
		if err != nil {
			return false, err
		}
		chosen = host
	case mcp.next == "skip":
		// The user declined the host pick during the MCP offer; don't re-ask.
		return false, nil
	case mcp.next == "launch":
		// The pick already happened during the MCP offer; launch the same host, so
		// the registered MCP server and the launched agent never diverge.
		chosen = mcp.host
	default:
		hosts := promptCapableHosts(detected)
		if len(hosts) == 0 {
			return false, nil
		}
		chosen = chooseHost(hosts, promptArg, hio, out)
	}
	if chosen == nil {
		return false, nil
	}
	// Anchor the launch at the layer root so the brief's relative path resolves
	// under `leji init/adopt --dir <x>` run from elsewhere.
	return launchHost(*chosen, promptArg, hio, cwd, out, nil), nil
}

// McpOfferOptions configures OfferMcpInstall, the pre-handoff MCP registration offer.
type McpOfferOptions struct {
	// Root is the absolute layer root: the cwd for the check/register, so a
	// project-scoped write (Claude's `.mcp.json`) lands in this repository.
	Root        string
	Detected    []detect.DetectedHost
	Interactive bool
	// Agent forces a specific launchable host (claude-code/codex); empty means detect.
	Agent string
}

// OfferMcpInstall offers, before the init/adopt handoff launches an agent, to register
// the local Leji MCP server for the launchable host, so the launched session gains
// native spec + validation tools. Interactive only, and skipped when the server is
// already registered (a quiet presence check), so it never nags or fires in scripts/CI.
// With several hosts detected the pick happens ONCE, here, and the returned outcome
// carries it into HandoffOffer, so the registered MCP server and the launched agent
// never diverge. Never returns an error: a failed check or register falls back to a
// printed manual command.
func OfferMcpInstall(opts McpOfferOptions, hio *HandoffIO, out io.Writer) McpOfferOutcome {
	def := McpOfferOutcome{next: "default"}
	if !opts.Interactive {
		return def
	}
	// Resolve the one host this session targets: --agent forces it, a single
	// detected host is it, several ask (numbered, same as the handoff pick).
	var target *promptHost
	picked := false
	if opts.Agent != "" {
		target = resolvePromptHost(opts.Agent)
		// An unknown --agent stays default: HandoffOffer raises the proper error.
		if target == nil {
			return def
		}
	} else {
		hosts := promptCapableHosts(opts.Detected)
		if len(hosts) == 0 {
			return def
		}
		if len(hosts) == 1 {
			target = &hosts[0]
		} else {
			target = pickFromMultiple(hosts, hio, out)
			if target == nil {
				return McpOfferOutcome{next: "skip"}
			}
			picked = true
		}
	}
	outcome := def
	if picked {
		outcome = McpOfferOutcome{next: "launch", host: target}
	}
	spec := detect.SpecByID(target.id)
	if spec == nil || len(spec.McpAdd) == 0 {
		return outcome
	}
	// A handoff-only IO (nil Run) can't run the check/register; skip rather than
	// panic (this function never surfaces an error). Production always wires Run.
	if hio.Run == nil {
		return outcome
	}
	// Skip the offer when already registered (clean exit), so re-running init/adopt
	// never re-nags — but say so: a silent skip is indistinguishable from the offer
	// being broken. A failed check (e.g. an older host CLI) falls through to the offer.
	if len(spec.McpCheck) > 0 {
		chk := hio.Run(target.bin, spec.McpCheck, opts.Root, true)
		if chk.Started && chk.Err == nil {
			fmt.Fprintf(out, "Leji MCP server already registered for %s; skipping the install offer.\n", target.name)
			return outcome
		}
	}
	scopeNote := " (writes .mcp.json here; commit it to share with your team)"
	if target.id == "codex" {
		scopeNote = " (writes ~/.codex config, user-level)"
	}
	answer := strings.ToLower(hio.ReadLine("Register the Leji MCP server for "+target.name+" so the agent can retrieve the spec and validate natively?"+scopeNote, "Y/n"))
	if !(answer == "" || answer == "y" || answer == "yes") {
		return outcome
	}
	res := hio.Run(target.bin, spec.McpAdd, opts.Root, false)
	if !res.Started {
		fmt.Fprintf(os.Stderr, "\nleji: could not run %s (%v); register it manually:\n   %s %s\n", target.bin, res.Err, target.bin, strings.Join(spec.McpAdd, " "))
		return outcome
	}
	if res.Err == nil {
		fmt.Fprintf(out, "Registered the Leji MCP server for %s.\n", target.name)
	} else {
		fmt.Fprintf(out, "%s did not register cleanly; it may already be present, or add it manually:\n   %s %s\n", target.bin, target.bin, strings.Join(spec.McpAdd, " "))
	}
	return outcome
}

// StartOutcome is the result of EnterLayer: an agent launched cleanly, fell back
// to the printed commands, or the boot profile is missing/invalid.
type StartOutcome string

const (
	StartLaunched    StartOutcome = "launched"
	StartFallback    StartOutcome = "fallback"
	StartBootMissing StartOutcome = "boot-missing"
)

// StartOptions configures EnterLayer (the `leji start` command).
type StartOptions struct {
	Root     string
	Manifest *manifest.Manifest
	Detected []detect.DetectedHost
	// Agent forces a specific launchable host (claude-code/codex); empty means detect.
	Agent string
	// Interactive is a real TTY and not --yes; required to launch an interactive agent.
	Interactive bool
	// HostArgs are extra arguments passed verbatim to the launched host binary,
	// before the prompt (from `leji start -- <flags>`, e.g. Claude Code's --chrome).
	HostArgs []string
}

// bootPrompt is the prompt `leji start` hands the agent: point it at the boot profile.
func bootPrompt(bootRel string) string {
	return "Read ./" + bootRel + ", follow it, and tell me when you're ready."
}

// EnterLayer boots a coding agent into an existing layer, pointed at the boot
// profile, launched from the layer root so the relative boot path resolves.
// Returns StartLaunched on a clean run, StartFallback when there is nothing to
// launch, or StartBootMissing when the boot path is unsafe or absent. A non-nil
// error means an unknown/non-launchable Agent (usage error → exit 2).
func EnterLayer(opts StartOptions, hio *HandoffIO, out io.Writer) (StartOutcome, error) {
	root, err := filepath.Abs(opts.Root)
	if err != nil {
		root = opts.Root
	}
	bootRel := opts.Manifest.BootProfilePath
	if validateRelPath(bootRel) != nil || !fsx.IsFile(filepath.Join(root, bootRel)) {
		return StartBootMissing, nil
	}
	promptArg := bootPrompt(bootRel)

	var host *promptHost
	if opts.Agent != "" {
		h, err := assertAgentHost(opts.Agent)
		if err != nil {
			return StartFallback, err
		}
		host = h
	} else {
		hosts := promptCapableHosts(opts.Detected)
		if len(hosts) == 1 {
			host = &hosts[0]
		} else if len(hosts) > 1 && opts.Interactive {
			host = pickFromMultiple(hosts, hio, out)
		}
	}

	if host == nil || !opts.Interactive {
		return StartFallback, nil
	}
	if launchHost(*host, promptArg, hio, root, out, opts.HostArgs) {
		return StartLaunched, nil
	}
	return StartFallback, nil
}

// EnteringViaBoot is printed when `leji start` launches nothing: the copy-paste
// commands to enter the layer via the boot profile.
func EnteringViaBoot(m *manifest.Manifest, hostArgs []string) string {
	promptArg := bootPrompt(m.BootProfilePath)
	// Host flags the user asked for (leji start -- <flags>) stay in the printed
	// commands, so the copy-paste path launches what the direct path would have.
	flagsShown := ""
	if len(hostArgs) > 0 {
		flagsShown = strings.Join(hostArgs, " ") + " "
	}
	lines := []string{
		"",
		"No coding agent was launched. To enter this context layer, run one of:",
		"",
		"   claude " + flagsShown + "\"" + promptArg + "\"",
		"   codex " + flagsShown + "\"" + promptArg + "\"",
		"",
		"Each points the agent at the boot profile, which loads the team context before any work.",
	}
	return strings.Join(lines, "\n")
}

var docsCandidates = []string{"docs/", "doc/", "documentation/"}

// AdoptOptions configures adoptLayer: bringing Leji into an existing repository.
type AdoptOptions struct {
	Dir    string
	Yes    bool
	DryRun bool
	// WireAdapters converts present vendor entrypoints to redirects (consented
	// overwrite). Also accepted on a repository that already has a layer, where it
	// wires only.
	WireAdapters bool
	Agent        string
	Name         string
	// Mode is the working mode: "solo" scaffolds the identity and writing-style
	// starters. Flag-only for adopt (adopt never reads stdin); empty means "team".
	Mode string
	// NoAgents skips generating the portable `AGENTS.md` pointer (written by
	// default when absent; an existing file keeps the migrate/--wire-adapters flow).
	NoAgents bool
}

// AdoptResult is the init result plus what adoption found and did.
type AdoptResult struct {
	Result
	DetectedRoot string
	// Migrated lists vendor files whose content was migrated into the layer.
	Migrated []string
	// Draft is true when a non-redirecting vendor file remains, so the layer is
	// not yet core-conformant.
	Draft bool
	// WiredOnly is true when the run wired adapters into a layer that already
	// existed (--wire-adapters on a repository with a leji.json) instead of
	// adopting a new one.
	WiredOnly bool
	// Wired lists the vendor entrypoints this run converted to redirects.
	Wired []string
}

var mdExtRe = regexp.MustCompile(`(?i)\.md$`)

// importedSlug derives the imported-file slug: basename without .md, lowercased,
// non-alnum runs to '-', trimmed.
func importedSlug(rel string) string {
	base := filepath.Base(rel)
	base = mdExtRe.ReplaceAllString(base, "")
	base = strings.ToLower(base)
	base = nonAlnum.ReplaceAllString(base, "-")
	base = trimDash.ReplaceAllString(base, "")
	return base
}

// longestBacktickRun returns the longest run of consecutive backticks in content.
func longestBacktickRun(content string) int {
	longest, run := 0, 0
	for _, c := range content {
		if c == '`' {
			run++
			if run > longest {
				longest = run
			}
		} else {
			run = 0
		}
	}
	return longest
}

func migrationDoc(sourceRel, content string) string {
	summary := "Agent instructions migrated verbatim from " + sourceRel + "; refine into the right categories."
	// Fence the migrated content so raw HTML/Markdown is shown verbatim, never
	// rendered: the fenced migration cannot inject script into the Docsify preview.
	// The fence is one backtick longer than the longest run in the content.
	fenceLen := longestBacktickRun(content) + 1
	if fenceLen < 3 {
		fenceLen = 3
	}
	fence := strings.Repeat("`", fenceLen)
	return "---\nsummary: " + summary + "\n---\n\n# Imported agent instructions (" + sourceRel + ")\n\n" +
		"<!-- Migrated by `leji adopt` from " + sourceRel + ". Split this into domain/system/practice/governance " +
		"as appropriate; the original file is unchanged. -->\n\n" + fence + "\n" + strings.TrimSpace(content) + "\n" + fence + "\n"
}

func adoptExistingDecision(a answers, migrated []string) string {
	today := time.Now().UTC().Format("2006-01-02")
	return "---\n" +
		"id: adopt-existing-agent-context\n" +
		"title: Adopt existing agent instructions into the context layer\n" +
		"status: accepted\n" +
		"date: " + today + "\n" +
		"deciders:\n" +
		"  - " + a.ownerName + "\n" +
		"---\n\n" +
		"# Adopt existing agent instructions into the context layer\n\n" +
		"## Context\n\n" +
		"This repository already carried agent configuration (" + strings.Join(migrated, ", ") + "). That content is team knowledge that belonged in the context layer, not in a per-tool file.\n\n" +
		"## Decision\n\n" +
		"Its content was migrated into the layer (see `" + fsx.JoinUnderRoot(a.rootPath, "governance/") + "`). The original file(s) were left unchanged; converting them to one-line redirects is a separate, consented step (`leji adopt --wire-adapters`).\n\n" +
		"## Consequences\n\n" +
		"The context layer is the single source of truth. Until the vendor entrypoints redirect, the layer does not claim core conformance.\n"
}

// AdoptLayer brings Leji into an existing repository: reuse an existing docs root,
// migrate vendor-entrypoint content into the layer (originals untouched), and seed
// the scaffold. Refuses when a layer already exists. With WireAdapters, converts
// the present entrypoints to redirects (a consented overwrite, after migration);
// otherwise the result is an adoption draft that is not yet core-conformant.
func AdoptLayer(opts AdoptOptions) (AdoptResult, error) {
	if opts.Agent != "" {
		if _, err := assertAgentHost(opts.Agent); err != nil {
			return AdoptResult{}, err
		}
	}
	root, _ := filepath.Abs(opts.Dir)
	if _, err := os.Stat(filepath.Join(root, "leji.json")); err == nil {
		// `adopt --yes` prints `leji adopt --wire-adapters` as the step that finishes
		// an adoption draft, and by then the layer exists. Refusing the flag here left
		// that repository non-conformant with no command that could fix it, so the
		// flag wires adapters into the layer already on disk and scaffolds nothing.
		if opts.WireAdapters {
			return wireAdaptersIntoLayer(root, opts)
		}
		return AdoptResult{}, errors.New("leji.json already exists here; this repository already has a Leji layer")
	}
	if !opts.DryRun {
		if err := assertCleanWorkingTree(root); err != nil {
			return AdoptResult{}, err
		}
	}
	detected := detect.DetectHosts(detect.Options{Root: root})
	detectedRoot := "docs/"
	for _, d := range docsCandidates {
		if fsx.IsDir(filepath.Join(root, d)) {
			detectedRoot = d
			break
		}
	}
	if err := validateRelPath(fsx.StripSlash(detectedRoot)); err != nil {
		return AdoptResult{}, fmt.Errorf("context root %q is not a safe relative path: %w", detectedRoot, err)
	}

	bootRel := detectedRoot + "boot-profile.md"
	canonicalRedirect := strings.TrimSpace(detect.AdapterContent(bootRel))
	var vendorPresent []string
	for _, rel := range validate.KnownVendorFiles {
		abs := filepath.Join(root, rel)
		// A vendor file that is a symlink resolving outside root is neither read,
		// migrated, nor converted: it is treated as absent.
		if fsx.IsFile(abs) && fsx.ResolvesUnder(root, abs) {
			vendorPresent = append(vendorPresent, rel)
		}
	}
	// Migrate any vendor file that is not already exactly Leji's redirect, so its
	// content (whether on its own lines or sharing a line with the boot-path
	// reference) is archived before --wire-adapters overwrites it. A file that is
	// already the canonical redirect, or empty, has nothing to preserve.
	var toMigrate []string
	for _, rel := range vendorPresent {
		t, _ := fsx.ReadText(filepath.Join(root, rel))
		trimmed := strings.TrimSpace(t)
		if trimmed != "" && trimmed != canonicalRedirect {
			toMigrate = append(toMigrate, rel)
		}
	}

	base := slugBase(root)
	name := opts.Name
	if name == "" {
		name = base + "-context"
	}
	ownerName := gitConfig("user.name")
	if ownerName == "" {
		ownerName = "<named owner>"
	}
	mode := "team"
	if opts.Mode != "" {
		var merr error
		if mode, merr = assertMode(opts.Mode); merr != nil {
			return AdoptResult{}, merr
		}
	}
	categories := []string{"domain", "system"}
	if len(toMigrate) > 0 {
		categories = append(categories, "governance")
	}
	categories = append(categories, "decisions")
	// Adopt over an existing repository: resolve every scaffold path against what is
	// already there so the layer never clobbers existing content. The viewer dir
	// (.leji/, reserved and gitignored) is generated by `leji viewer`, not
	// scaffolded here, so there is nothing to collide at adopt time.
	adoptLayout := resolveLayout(root, detectedRoot)
	a := answers{
		name:         name,
		description:  "Shared context layer for this repository.",
		rootPath:     detectedRoot,
		ownerName:    ownerName,
		ownerContact: gitConfig("user.email"),
		categories:   normalizeCategories(categories, mode),
		level:        "core",
		mode:         mode,
		layout:       &adoptLayout,
	}

	r := a.rootPath
	layout := a.effectiveLayout()

	// Convert only EXISTING vendor entrypoints (never create new ones) that aren't
	// already the canonical redirect; each has been captured in toMigrate above, so
	// the overwrite never loses content.
	var toConvert []string
	if opts.WireAdapters {
		for _, rel := range vendorPresent {
			t, _ := fsx.ReadText(filepath.Join(root, rel))
			if strings.TrimSpace(t) != canonicalRedirect {
				toConvert = append(toConvert, rel)
			}
		}
	}
	m, ord := buildManifest(a, toConvert)
	manifestBytes := serializeManifest(ord)

	writes := []writeplan.PlannedWrite{{Rel: "leji.json", Content: string(manifestBytes)}}
	writes = append(writes, writeplan.PlannedWrite{Rel: m.BootProfilePath, Content: buildBootProfile(a)})
	// The portable discovery adapter, only when no AGENTS.md exists: a present one
	// keeps the migrate/--wire-adapters flow (its content is archived first).
	if !opts.NoAgents && !fsx.IsFile(filepath.Join(root, detect.PortableAdapter)) {
		writes = append(writes, writeplan.PlannedWrite{Rel: detect.PortableAdapter, Content: detect.AdapterContent(m.BootProfilePath)})
	}
	for _, category := range a.categories {
		if category == "decisions" {
			continue
		}
		stub := categoryStubs[category]
		writes = append(writes, writeplan.PlannedWrite{
			Rel:     fsx.JoinUnderRoot(r, category+"/") + stub.file,
			Content: stubContent(stub.title, stub.summary, stub.body),
		})
	}
	if a.mode == "solo" {
		// Solo starters are collision-safe: an existing identity.md or
		// writing-style.md is skipped (skip-exists), never overwritten.
		for _, s := range soloStarters {
			writes = append(writes, writeplan.PlannedWrite{Rel: fsx.JoinUnderRoot(r, s.category+"/") + s.file, Content: readTemplate(s.template)})
		}
	}
	writes = append(writes, writeplan.PlannedWrite{Rel: fsx.JoinUnderRoot(r, "decisions/") + "0001-adopt-leji.md", Content: buildFirstDecision(a)})
	// Write a stub index file per category so the manifest's `indexes` resolve to
	// real, populated content.
	for _, category := range a.categories {
		writes = append(writes, writeplan.PlannedWrite{Rel: layout.ContextDir + category + ".md", Content: categoryIndexFile(r, category)})
	}
	writes = append(writes, writeplan.PlannedWrite{Rel: layout.AgentsDir + "core.md", Content: buildCoreProfile(a)})
	writes = append(writes, writeplan.PlannedWrite{Rel: BriefPath(r), Content: buildBrief(a)})

	var migrated []string
	migrationDocByVendor := map[string]string{}
	plannedRels := map[string]bool{}
	for _, w := range writes {
		plannedRels[w.Rel] = true
	}
	for _, rel := range toMigrate {
		base := importedSlug(rel)
		// Disambiguate against BOTH the planned write set and what already exists on
		// disk, so the migrated copy is never skipped by writeFileOnce. A skipped copy
		// followed by --wire-adapters overwriting the entrypoint would lose content.
		slug := base
		docRel := fsx.JoinUnderRoot(r, "governance/") + "imported-" + slug + ".md"
		for n := 2; plannedRels[docRel] || fsx.Exists(filepath.Join(root, fsx.StripSlash(docRel))); n++ {
			slug = fmt.Sprintf("%s-%d", base, n)
			docRel = fsx.JoinUnderRoot(r, "governance/") + "imported-" + slug + ".md"
		}
		plannedRels[docRel] = true
		content, _ := fsx.ReadText(filepath.Join(root, rel))
		writes = append(writes, writeplan.PlannedWrite{Rel: docRel, Content: migrationDoc(rel, content)})
		migrationDocByVendor[rel] = docRel
		migrated = append(migrated, rel)
	}
	if len(migrated) > 0 {
		writes = append(writes, writeplan.PlannedWrite{
			Rel:     fsx.JoinUnderRoot(r, "decisions/") + "0002-adopt-existing-agent-context.md",
			Content: adoptExistingDecision(a, migrated),
		})
	}

	for _, rel := range toConvert {
		writes = append(writes, writeplan.PlannedWrite{Rel: rel, Content: detect.AdapterContent(m.BootProfilePath)})
	}

	var wontModify []string
	for _, rel := range vendorPresent {
		if !contains(toConvert, rel) {
			wontModify = append(wontModify, rel)
		}
	}
	// Same reasoning as InitLayer: the generated index ships with every adoption so
	// the `leji ci` gate passes on the first run.
	adoptIndexRel := manifest.EffectiveIndexPath(m)
	plan := planWithIndexTruth(writeplan.Build(root, append(append([]writeplan.PlannedWrite{}, writes...),
		writeplan.PlannedWrite{Rel: adoptIndexRel, Content: ""}), wontModify, toConvert), adoptIndexRel)
	draft := false
	for _, rel := range wontModify {
		t, _ := fsx.ReadText(filepath.Join(root, rel))
		if !strings.Contains(t, bootRel) {
			draft = true
			break
		}
	}

	if opts.DryRun {
		return AdoptResult{
			Result:       Result{Written: []string{}, Manifest: m, Mode: a.mode, Plan: plan, DryRun: true, Detected: detected, Root: root},
			DetectedRoot: detectedRoot,
			Migrated:     migrated,
			Draft:        draft,
			Wired:        toConvert,
		}, nil
	}

	var written []string
	if err := os.MkdirAll(root, 0o755); err != nil {
		return AdoptResult{}, err
	}
	// The tracked-file preflight and the `.leji/` ignore run BEFORE any write at
	// all, so the private onboarding workspace can never land in git and a failed
	// preflight leaves the tree untouched.
	if err := assertLejiWorkspacePrivate(root, r); err != nil {
		return AdoptResult{}, err
	}
	if err := ensureLejiGitignored(root); err != nil {
		return AdoptResult{}, err
	}
	if !fsx.ResolvesUnder(root, filepath.Join(root, "leji.json")) {
		return AdoptResult{}, fmt.Errorf("refusing to write through a symlink that escapes the target: %q", "leji.json")
	}
	// O_EXCL: close the check-then-write race and refuse to follow a planted
	// symlink at the final component.
	if err := writeManifestExclusive(filepath.Join(root, "leji.json"), manifestBytes, "adopt"); err != nil {
		return AdoptResult{}, err
	}
	written = append(written, "leji.json")
	convert := map[string]bool{}
	for _, rel := range toConvert {
		convert[rel] = true
	}
	for _, w := range writes[1:] {
		if convert[w.Rel] {
			// Never overwrite a vendor entrypoint until its migrated copy is on disk:
			// if the migration write was skipped, leave the original untouched rather
			// than replacing it with a redirect and losing its content.
			if docRel, ok := migrationDocByVendor[w.Rel]; ok && !contains(written, docRel) {
				continue
			}
			abs, rerr := resolveUnderRoot(root, w.Rel)
			if rerr != nil {
				return AdoptResult{}, rerr
			}
			if !fsx.ResolvesUnder(root, abs) {
				return AdoptResult{}, fmt.Errorf("refusing to write through a symlink that escapes the target: %q", w.Rel)
			}
			if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
				return AdoptResult{}, err
			}
			if err := os.WriteFile(abs, []byte(w.Content), 0o644); err != nil {
				return AdoptResult{}, err
			}
			written = append(written, w.Rel)
		} else {
			if err := writeFileOnce(root, w.Rel, w.Content, &written); err != nil {
				return AdoptResult{}, err
			}
		}
	}

	// Same rule as `leji index`: WriteIndex reports a hard generation failure in
	// Result.Findings with a nil error, so the file is claimed only when it was
	// written, and the findings travel out for the caller to report.
	idx, ierr := indexgen.WriteIndex(root, m)
	if ierr != nil {
		return AdoptResult{}, ierr
	}
	if !findings.HasErrors(idx.Findings) {
		written = append(written, adoptIndexRel)
	}

	sort.Strings(written)
	return AdoptResult{
		Result:       Result{Written: written, Findings: idx.Findings, Manifest: m, Mode: a.mode, Plan: plan, DryRun: false, Detected: detected, Root: root},
		DetectedRoot: detectedRoot,
		Migrated:     migrated,
		Draft:        draft,
		Wired:        toConvert,
	}, nil
}

// archivePath is where a vendor entrypoint's content is archived under
// governance/: the first free imported-<slug>.md, or "" when this exact migration
// doc is already on disk — the normal case, AdoptLayer having archived it on the
// first pass. Mirrors the slug and disambiguation rules AdoptLayer uses.
func archivePath(root, rootPath, vendorRel, doc string) string {
	base := importedSlug(vendorRel)
	for n := 1; ; n++ {
		slug := base
		if n > 1 {
			slug = fmt.Sprintf("%s-%d", base, n)
		}
		rel := fsx.JoinUnderRoot(rootPath, "governance/") + "imported-" + slug + ".md"
		abs := filepath.Join(root, fsx.StripSlash(rel))
		if !fsx.Exists(abs) {
			return rel
		}
		if fsx.IsFile(abs) {
			if existing, err := fsx.ReadText(abs); err == nil && existing == doc {
				return ""
			}
		}
	}
}

// wireAdaptersIntoLayer runs `leji adopt --wire-adapters` against a repository that
// already has a layer: the second half of the two-step adoption whose first half
// prints this command. It converts every present vendor entrypoint that does not
// already redirect to the boot profile, archiving its content under governance/
// first (the same never-lose-content guarantee AdoptLayer gives) and skipping the
// archive when the identical migration doc is already there. It scaffolds nothing,
// rewrites no manifest, and touches no other file.
//
// The clean-tree check AdoptLayer runs is deliberately skipped: the adopt run this
// finishes is what left the tree dirty, so requiring a clean tree would reinstate
// the dead end. Content safety comes from the archive, not from git.
func wireAdaptersIntoLayer(root string, opts AdoptOptions) (AdoptResult, error) {
	load := manifest.LoadManifest(root)
	m := load.Manifest
	if m == nil {
		return AdoptResult{}, errors.New("leji.json is not a readable layer manifest; run `leji validate` for detail")
	}
	r := m.RootPath
	bootRel := m.BootProfilePath
	redirect := detect.AdapterContent(bootRel)
	var vendorPresent []string
	for _, rel := range validate.KnownVendorFiles {
		abs := filepath.Join(root, rel)
		// A vendor file that symlinks outside root is treated as absent, as in AdoptLayer.
		if fsx.IsFile(abs) && fsx.ResolvesUnder(root, abs) {
			vendorPresent = append(vendorPresent, rel)
		}
	}
	var toConvert []string
	for _, rel := range vendorPresent {
		t, _ := fsx.ReadText(filepath.Join(root, rel))
		if strings.TrimSpace(t) != strings.TrimSpace(redirect) {
			toConvert = append(toConvert, rel)
		}
	}

	// Archives first, so a vendor entrypoint is never overwritten before its content
	// is on disk; an empty file has nothing to preserve.
	var writes []writeplan.PlannedWrite
	var archived []string
	for _, rel := range toConvert {
		content, _ := fsx.ReadText(filepath.Join(root, rel))
		if strings.TrimSpace(content) == "" {
			continue
		}
		doc := migrationDoc(rel, content)
		docRel := archivePath(root, r, rel, doc)
		if docRel == "" {
			continue
		}
		writes = append(writes, writeplan.PlannedWrite{Rel: docRel, Content: doc})
		archived = append(archived, rel)
	}
	for _, rel := range toConvert {
		writes = append(writes, writeplan.PlannedWrite{Rel: rel, Content: redirect})
	}

	var wontModify []string
	for _, rel := range vendorPresent {
		if !contains(toConvert, rel) {
			wontModify = append(wontModify, rel)
		}
	}
	plan := writeplan.Build(root, writes, wontModify, toConvert)
	// Detected is empty by construction: wiring finishes an adoption rather than
	// starting one, so this run makes no MCP-install or agent-launch offer.
	result := AdoptResult{
		Result:       Result{Manifest: m, Mode: "team", Plan: plan, Detected: nil, Root: root},
		DetectedRoot: r,
		Migrated:     archived,
		Draft:        false,
		WiredOnly:    true,
		Wired:        toConvert,
	}
	if opts.DryRun {
		result.Written = []string{}
		result.DryRun = true
		return result, nil
	}

	var written []string
	for _, w := range writes {
		abs, rerr := resolveUnderRoot(root, w.Rel)
		if rerr != nil {
			return AdoptResult{}, rerr
		}
		if !fsx.ResolvesUnder(root, abs) {
			return AdoptResult{}, fmt.Errorf("refusing to write through a symlink that escapes the target: %q", w.Rel)
		}
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return AdoptResult{}, err
		}
		if err := os.WriteFile(abs, []byte(w.Content), 0o644); err != nil {
			return AdoptResult{}, err
		}
		written = append(written, w.Rel)
	}
	// Only an archive lands inside the layer, so only an archive can stale the stored
	// index; a plain wiring run leaves the generated index (and its timestamp) alone.
	if len(archived) > 0 {
		idx, ierr := indexgen.WriteIndex(root, m)
		if ierr != nil {
			return AdoptResult{}, ierr
		}
		result.Findings = idx.Findings
		if !findings.HasErrors(idx.Findings) {
			written = append(written, manifest.EffectiveIndexPath(m))
		}
	}
	sort.Strings(written)
	result.Written = written
	result.DryRun = false
	return result, nil
}

// EnteringAdopted is the post-adopt guidance printed by the CLI.
func EnteringAdopted(result AdoptResult) string {
	if result.WiredOnly {
		return enteringWired(result)
	}
	lines := []string{EnteringTheLayer(result.Manifest, result.Mode)}
	if len(result.Migrated) > 0 {
		lines = append(lines, "",
			"Migrated "+strings.Join(result.Migrated, ", ")+" into "+fsx.JoinUnderRoot(result.Manifest.RootPath, "governance/")+" (originals untouched); refine into the right categories.")
	}
	if result.Draft {
		lines = append(lines, "",
			"This is an adoption draft: NOT yet core-conformant, because an existing vendor entrypoint",
			"does not redirect to the boot profile (the spec requires it). Finish with:",
			"",
			"   leji adopt --wire-adapters   # convert them to redirects (their content is already migrated)")
	}
	return strings.Join(lines, "\n")
}

// enteringWired is what `adopt --wire-adapters` reports when it wired an existing layer.
func enteringWired(result AdoptResult) string {
	if len(result.Wired) == 0 {
		return "Every vendor entrypoint already redirects to the boot profile; nothing to wire."
	}
	lines := []string{"Wired " + strings.Join(result.Wired, ", ") + " to redirect to " + result.Manifest.BootProfilePath + "."}
	if len(result.Migrated) > 0 {
		lines = append(lines, "",
			"Archived their previous content in "+fsx.JoinUnderRoot(result.Manifest.RootPath, "governance/")+"; refine into the right categories.")
	}
	lines = append(lines, "", "The layer should now be core-conformant. Confirm with:", "", "   leji validate")
	return strings.Join(lines, "\n")
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}
