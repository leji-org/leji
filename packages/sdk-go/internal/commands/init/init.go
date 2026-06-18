// Package initcmd bootstraps a context layer from the vendored templates,
// mirroring the Node init command.
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
	"strings"
	"time"

	"github.com/leji-org/leji/packages/sdk-go/internal/assets"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/indexgen"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/validate"
	"github.com/leji-org/leji/packages/sdk-go/internal/detect"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
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
	// Agent wires a vendor adapter: a host id/alias, "auto" (top detected), or "none".
	Agent string
	// Reviewer designates a second host as the `reviewer` role (multi-agent workflow).
	Reviewer string
	// Ci writes a GitHub Actions workflow that runs `leji validate` in CI.
	Ci bool
	// In/Out are overridable for tests; default to os.Stdin / os.Stdout.
	In  io.Reader
	Out io.Writer
}

type answers struct {
	name         string
	description  string
	rootPath     string
	ownerName    string
	ownerContact string
	categories   []string
	level        string
}

type Result struct {
	Written  []string
	Manifest *manifest.Manifest
	// Plan is the classified write plan (always populated; the only output under DryRun).
	Plan   []writeplan.PlanEntry
	DryRun bool
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
// never consecutive — trimming one per end suffices (mirrors the Node/Python SDKs;
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
	}
}

func prompt(opts Options) answers {
	defaults := defaultAnswers(opts.Dir, opts)
	if opts.Yes {
		return defaults
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
	rootPath := ask("Context root", defaults.rootPath)
	if !strings.HasSuffix(rootPath, "/") {
		rootPath += "/"
	}
	ownerName := ask("Primary owner (name)", defaults.ownerName)
	ownerContact := ask("Primary owner (contact)", defaults.ownerContact)

	var categories []string
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
	categories = append(categories, "decisions")
	if !contains(categories, "domain") && !contains(categories, "system") {
		categories = append([]string{"domain"}, categories...)
		io.WriteString(out, "At least domain or system is required; mapping domain.\n")
	}
	indexed := askYesNo("Generate the machine index and changelog now (indexed level)?", false)
	level := "core"
	if indexed {
		level = "indexed"
	}
	return answers{name, description, rootPath, ownerName, ownerContact, categories, level}
}

func readTemplate(name string) string {
	b, _ := assets.FS.ReadFile("templates/" + name)
	return string(b)
}

// hasDotDotSegment reports whether any path segment is "..".
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

// buildManifest constructs the typed manifest and the ordered root through the
// `conformance` key. adapters, when non-empty, is recorded as vendorAdapters on
// the typed manifest. The ordered root has neither vendorAdapters nor agents yet;
// those keys are appended by serializeManifest after any reviewer wiring, so the
// emitted key order matches Node's object-mutation order.
func buildManifest(a answers, adapters []string) (*manifest.Manifest, *ordered) {
	template := readTemplate("leji.json")
	var tmpl map[string]any
	_ = json.Unmarshal([]byte(template), &tmpl)
	schemaURL, _ := tmpl["$schema"].(string)
	r := a.rootPath

	m := &manifest.Manifest{
		Schema:          schemaURL,
		Leji:            "1.0",
		Name:            a.name,
		Description:     a.description,
		RootPath:        r,
		BootProfilePath: r + "boot-profile.md",
		Categories:      map[string]manifest.CategoryMapping{},
		Owners: manifest.Owners{
			Primary: manifest.Owner{Name: a.ownerName, Contact: a.ownerContact},
		},
		Conformance: &manifest.Conformance{
			ClaimedLevel: a.level,
			ClaimedAt:    time.Now().UTC().Format("2006-01-02"),
		},
	}
	// No `machine` block: every machine-surface path resolves to its spec default
	// under rootPath/, so init writes a minimal leji.json and the resolvers
	// (Effective*Path) find the files at their default locations.
	for _, c := range a.categories {
		m.Categories[c] = manifest.CategoryMapping{Paths: []string{r + c + "/"}}
	}
	if len(adapters) > 0 {
		m.VendorAdapters = adapters
	}

	// Ordered serialization matching the Node object construction order.
	root := newOrdered()
	root.set("$schema", schemaURL)
	root.set("leji", "1.0")
	root.set("name", a.name)
	root.set("description", a.description)
	root.set("rootPath", r)
	root.set("bootProfilePath", r+"boot-profile.md")
	cats := newOrdered()
	for _, c := range a.categories {
		cat := newOrdered()
		cat.set("paths", []string{r + c + "/"})
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
	if len(adapters) > 0 {
		root.set("vendorAdapters", adapters)
	}

	return m, root
}

// serializeManifest renders the finalized ordered root into the leji.json bytes.
func serializeManifest(root *ordered) []byte {
	var buf bytes.Buffer
	root.encode(&buf)
	buf.WriteByte('\n')
	return buf.Bytes()
}

var loadLineRe = regexp.MustCompile("- `[^`]+domain/`[^\n]*\n- `[^`]+system/`[^\n]*\n- `[^`]+decisions/`[^\n]*")
var indexLineRe = regexp.MustCompile("\nThe generated map of this layer is `[^`]+`\\.\n")
var changelogLineRe = regexp.MustCompile("- Append an entry to `[^`]+context-changelog\\.json`[^\n]*\n")
var regenLineRe = regexp.MustCompile("- Regenerate `[^`]+context-index\\.json`[^\n]*\n")

func buildBootProfile(a answers) string {
	text := readTemplate("boot-profile.md")
	if a.rootPath != "docs/" {
		text = strings.ReplaceAll(text, "docs/", a.rootPath)
	}
	text = strings.Replace(text,
		"<One paragraph: what this repository/product is, who it serves, what stage it is at.>",
		a.description, 1)
	r := a.rootPath
	purpose := map[string]string{
		"domain":     "what our core terms mean",
		"system":     "architecture and the invariants every change lives with",
		"practice":   "conventions and patterns applied automatically",
		"governance": "agent guardrails and operating rules",
		"decisions":  "why things are the way they are (check before proposing a reversal)",
	}
	var loadLines []string
	for _, c := range a.categories {
		loadLines = append(loadLines, "- `"+r+c+"/`: "+purpose[c])
	}
	text = loadLineRe.ReplaceAllString(text, strings.Join(loadLines, "\n"))

	if a.level == "core" {
		text = indexLineRe.ReplaceAllString(text, "\n")
		text = changelogLineRe.ReplaceAllString(text, "")
		text = regenLineRe.ReplaceAllString(text, "")
	}
	return text
}

var governanceLineRe = regexp.MustCompile(`(?m)^ {2}- .*governance/\n`)

func buildCoreProfile(a answers) string {
	text := readTemplate("agents/core.md")
	if a.rootPath != "docs/" {
		text = strings.ReplaceAll(text, "docs/", a.rootPath)
	}
	if !contains(a.categories, "governance") {
		text = governanceLineRe.ReplaceAllString(text, "  - "+a.rootPath+"decisions/\n")
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

// buildBrief returns the transient onboarding brief, rewritten for the chosen root.
func buildBrief(a answers) string {
	return strings.ReplaceAll(readTemplate("onboarding-brief.md"), "<root>/", a.rootPath)
}

// BriefPath is the path of the transient onboarding brief, under a dot-directory
// so it is excluded from the index, the docs viewer, and the changelog.
func BriefPath(rootPath string) string {
	return rootPath + ".leji/onboarding-brief.md"
}

// BuildCiWorkflow is the governed on-ramp: a CI job that runs `leji validate`
// on every change. The YAML is byte-identical across SDKs.
func BuildCiWorkflow() string {
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
		"      - run: npx -y @leji-org/leji@latest validate\n"
}

// resolveAdapter resolves the file-style vendor adapter to create, honoring
// the --agent option (a host id/alias, "auto" for the top detected host, or
// "none"/unset for nothing). It never targets an existing entrypoint — those
// are migrated with consent during adoption, never overwritten here — so it
// returns "" when the file is already present.
func resolveAdapter(root, agent string) (string, error) {
	if agent == "" || agent == "none" {
		return "", nil
	}
	var spec *detect.HostSpec
	if agent == "auto" {
		topID := ""
		for _, h := range detect.DetectHosts(detect.Options{Root: root}) {
			if h.Adapter != "" {
				topID = h.ID
				break
			}
		}
		if topID == "" {
			return "", nil
		}
		spec = detect.SpecByID(topID)
	} else {
		id := detect.ResolveHostId(agent)
		if id != "" {
			spec = detect.SpecByID(id)
		}
		if spec == nil {
			return "", fmt.Errorf("unknown agent %q; known: %s", agent, strings.Join(hostIDs(), ", "))
		}
		if spec.Adapter == "" {
			return "", fmt.Errorf("%s uses a directory-style adapter; wiring it is not yet supported", spec.Name)
		}
	}
	if spec == nil || spec.Adapter == "" {
		return "", nil
	}
	if fsx.IsFile(filepath.Join(root, spec.Adapter)) {
		return "", nil
	}
	return spec.Adapter, nil
}

func hostIDs() []string {
	ids := make([]string, len(detect.HostSpecs))
	for i, s := range detect.HostSpecs {
		ids[i] = s.ID
	}
	return ids
}

// BuildRoleProfile is an agent profile for a named role bound to a specific host
// (multi-agent).
func BuildRoleProfile(role, hostID, rootPath string) string {
	title := strings.ToUpper(role[:1]) + role[1:]
	return "---\n" +
		"id: " + role + "\n" +
		"name: " + title + "\n" +
		"role: " + role + "\n" +
		"host: " + hostID + "\n" +
		"inherits: core\n" +
		"purpose: Independent review of proposed context-layer changes before a person approves.\n" +
		"requiredRead:\n" +
		"  - " + rootPath + "boot-profile.md\n" +
		"  - " + rootPath + "agents/core.md\n" +
		"mustAskWhen:\n" +
		"  - a proposal weakens an invariant or guardrail\n" +
		"  - a change to settled behavior lacks a decision record\n" +
		"---\n\n" +
		"# " + title + "\n\n" +
		"A second agent (host `" + hostID + "`) that reviews context-layer proposals against the spec and this\n" +
		"layer's own rules before a person approves. Inherits the core posture; it never loosens it.\n\n" +
		"## Review focus\n\n" +
		"- The proposal matches how this team actually works (domain, system, governance).\n" +
		"- Placeholders are gone and claims are grounded in the repository.\n" +
		"- A change to settled behavior carries a decision record.\n"
}

// WireReviewer designates a secondary host as the `reviewer` role: write its
// agent profile, bind it in manifest.agents, and wire its vendor adapter when
// absent. Mutates the typed manifest (Agents + VendorAdapters) and the ordered
// root (so the emitted key order matches Node's object-mutation order) and
// returns the files to write.
func WireReviewer(root, reviewer string, m *manifest.Manifest, ord *ordered, r string) ([]writeplan.PlannedWrite, error) {
	id := detect.ResolveHostId(reviewer)
	var spec *detect.HostSpec
	if id != "" {
		spec = detect.SpecByID(id)
	}
	if spec == nil {
		return nil, fmt.Errorf("unknown agent %q; known: %s", reviewer, strings.Join(hostIDs(), ", "))
	}
	var out []writeplan.PlannedWrite
	profileRel := r + "agents/reviewer.md"
	out = append(out, writeplan.PlannedWrite{Rel: profileRel, Content: BuildRoleProfile("reviewer", spec.ID, r)})
	if m.Agents == nil {
		m.Agents = map[string]string{}
	}
	m.Agents["reviewer"] = profileRel
	agents := newOrdered()
	agents.set("reviewer", profileRel)
	ord.set("agents", agents)
	if spec.Adapter != "" && !fsx.IsFile(filepath.Join(root, spec.Adapter)) {
		adapters := m.VendorAdapters
		if !contains(adapters, spec.Adapter) {
			adapters = append(adapters, spec.Adapter)
		}
		m.VendorAdapters = adapters
		ord.set("vendorAdapters", adapters)
		out = append(out, writeplan.PlannedWrite{Rel: spec.Adapter, Content: detect.AdapterContent(m.BootProfilePath)})
	}
	return out, nil
}

// InitLayer bootstraps a context layer. Returns an error when leji.json exists.
// With DryRun, computes the write plan and touches nothing.
func InitLayer(opts Options) (Result, error) {
	root, _ := filepath.Abs(opts.Dir)
	if _, err := os.Stat(filepath.Join(root, "leji.json")); err == nil {
		return Result{}, errors.New("leji.json already exists here; init refuses to overwrite an existing layer")
	}
	a := prompt(opts)
	// The interactive root path (and every path derived from it) must stay a
	// relative, in-tree path before anything is written, so an answer like
	// "../../etc/" or an absolute path cannot escape the target directory.
	if err := validateRelPath(fsx.StripSlash(a.rootPath)); err != nil {
		return Result{}, fmt.Errorf("context root %q is not a safe relative path: %w", a.rootPath, err)
	}
	adapter, err := resolveAdapter(root, opts.Agent)
	if err != nil {
		return Result{}, err
	}
	var adapters []string
	if adapter != "" {
		adapters = []string{adapter}
	}
	m, ord := buildManifest(a, adapters)
	r := a.rootPath
	// Multi-agent: a reviewer role bound to a second host (mutates the manifest
	// and the ordered root before leji.json is serialized below).
	var reviewerWrites []writeplan.PlannedWrite
	if opts.Reviewer != "" {
		reviewerWrites, err = WireReviewer(root, opts.Reviewer, m, ord, r)
		if err != nil {
			return Result{}, err
		}
	}
	manifestBytes := serializeManifest(ord)

	// Assemble the files init owns, in write order. leji.json comes first so the
	// overwrite guard is effective on a retry after an interrupted run.
	writes := []writeplan.PlannedWrite{{Rel: "leji.json", Content: string(manifestBytes)}}
	writes = append(writes, writeplan.PlannedWrite{Rel: m.BootProfilePath, Content: buildBootProfile(a)})
	for _, category := range a.categories {
		if category == "decisions" {
			continue
		}
		stub := categoryStubs[category]
		writes = append(writes, writeplan.PlannedWrite{
			Rel:     r + category + "/" + stub.file,
			Content: stubContent(stub.title, stub.summary, stub.body),
		})
	}
	writes = append(writes, writeplan.PlannedWrite{Rel: r + "decisions/0001-adopt-leji.md", Content: buildFirstDecision(a)})
	writes = append(writes, writeplan.PlannedWrite{Rel: r + "agents/core.md", Content: buildCoreProfile(a)})
	writes = append(writes, writeplan.PlannedWrite{Rel: BriefPath(r), Content: buildBrief(a)})
	if adapter != "" {
		writes = append(writes, writeplan.PlannedWrite{Rel: adapter, Content: detect.AdapterContent(m.BootProfilePath)})
	}
	writes = append(writes, reviewerWrites...)
	if opts.Ci {
		writes = append(writes, writeplan.PlannedWrite{Rel: ".github/workflows/leji.yml", Content: BuildCiWorkflow()})
	}
	if a.level == "indexed" {
		// The changelog records the paths seeded; compute from the planned set
		// (everything except the changelog and the generated index).
		seeded := make([]string, len(writes))
		for i, w := range writes {
			seeded[i] = w.Rel
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
	planWrites := writes
	if a.level == "indexed" {
		planWrites = append(append([]writeplan.PlannedWrite{}, writes...),
			writeplan.PlannedWrite{Rel: manifest.EffectiveIndexPath(m), Content: ""})
	}
	plan := writeplan.Build(root, planWrites, wontModify, nil)

	if opts.DryRun {
		return Result{Written: []string{}, Manifest: m, Plan: plan, DryRun: true}, nil
	}

	var written []string
	if err := os.MkdirAll(root, 0o755); err != nil {
		return Result{}, err
	}
	// leji.json is written directly (the guard above already proved it absent);
	// every other file goes through writeFileOnce so nothing is overwritten.
	if !fsx.ResolvesUnder(root, filepath.Join(root, "leji.json")) {
		return Result{}, fmt.Errorf("refusing to write through a symlink that escapes the target: %q", "leji.json")
	}
	if err := os.WriteFile(filepath.Join(root, "leji.json"), manifestBytes, 0o644); err != nil {
		return Result{}, err
	}
	written = append(written, "leji.json")
	for _, w := range writes[1:] {
		if err := writeFileOnce(root, w.Rel, w.Content, &written); err != nil {
			return Result{}, err
		}
	}

	if a.level == "indexed" {
		if _, err := indexgen.WriteIndex(root, m); err != nil {
			return Result{}, err
		}
		written = append(written, manifest.EffectiveIndexPath(m))
	}

	sort.Strings(written)
	return Result{Written: written, Manifest: m, Plan: plan, DryRun: false}, nil
}

// EnteringTheLayer is the post-init guidance printed by the CLI.
func EnteringTheLayer(m *manifest.Manifest) string {
	brief := BriefPath(m.RootPath)
	lines := []string{
		"",
		"The scaffold is in place, but the content is still placeholder. Hand it to your agent",
		"to populate from your actual repository:",
		"",
		"   claude \"Read ./" + brief + " and follow it.\"",
		"   codex \"Read ./" + brief + " and follow it.\"",
		"",
		"The brief teaches the agent the Leji spec and points it at this repo: it reads your",
		"code, asks what it cannot infer, and fills in real context. Prefer to do it yourself?",
		"Edit the seeded documents directly. Either way, check progress with:",
		"",
		"   leji validate --content   # placeholder / thin-content warnings",
		"   leji conformance          # the level reached and what is next",
	}
	return strings.Join(lines, "\n")
}

// --- adoption (existing repositories) ---

var docsCandidates = []string{"docs/", "doc/", "documentation/"}

// AdoptOptions configures adoptLayer: bringing Leji into an existing repository.
type AdoptOptions struct {
	Dir    string
	Yes    bool
	DryRun bool
	// WireAdapters converts present vendor entrypoints to redirects (consented overwrite).
	WireAdapters bool
	Agent        string
	Name         string
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
}

var mdExtRe = regexp.MustCompile(`(?i)\.md$`)

// importedSlug derives the imported-file slug: basename, strip a trailing .md,
// lowercase, non-alnum runs to '-', trim leading/trailing '-'.
func importedSlug(rel string) string {
	base := filepath.Base(rel)
	base = mdExtRe.ReplaceAllString(base, "")
	base = strings.ToLower(base)
	base = nonAlnum.ReplaceAllString(base, "-")
	base = trimDash.ReplaceAllString(base, "")
	return base
}

// longestBacktickRun returns the longest run of consecutive backticks anywhere
// in content (0 if none).
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
	// Wrap the migrated content in a fenced code block so raw HTML/Markdown is
	// shown verbatim, never rendered (no stored XSS in the Docsify local preview).
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
		"Its content was migrated into the layer (see `" + a.rootPath + "governance/`). The original file(s) were left unchanged; converting them to one-line redirects is a separate, consented step (`leji adopt --wire-adapters`).\n\n" +
		"## Consequences\n\n" +
		"The context layer is the single source of truth. Until the vendor entrypoints redirect, the layer does not claim core conformance.\n"
}

// AdoptLayer brings Leji into an existing repository: reuse an existing docs
// root, migrate the content of any vendor entrypoints into the layer (originals
// untouched), and seed the standard scaffold. Refuses when a layer already
// exists. With WireAdapters, converts the present entrypoints to redirects (a
// consented overwrite, after their content has been migrated); otherwise the
// result is an adoption draft that is not yet core-conformant.
func AdoptLayer(opts AdoptOptions) (AdoptResult, error) {
	root, _ := filepath.Abs(opts.Dir)
	if _, err := os.Stat(filepath.Join(root, "leji.json")); err == nil {
		return AdoptResult{}, errors.New("leji.json already exists here; this repository already has a Leji layer")
	}
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
	categories := []string{"domain", "system"}
	if len(toMigrate) > 0 {
		categories = append(categories, "governance")
	}
	categories = append(categories, "decisions")
	a := answers{
		name:         name,
		description:  "Shared context layer for this repository.",
		rootPath:     detectedRoot,
		ownerName:    ownerName,
		ownerContact: gitConfig("user.email"),
		categories:   categories,
		level:        "core",
	}

	newAdapter, err := resolveAdapter(root, opts.Agent)
	if err != nil {
		return AdoptResult{}, err
	}
	r := a.rootPath

	// Convert only files that aren't already the canonical redirect; each has been
	// captured in toMigrate above, so the overwrite never loses content.
	var toConvert []string
	if opts.WireAdapters {
		for _, rel := range vendorPresent {
			t, _ := fsx.ReadText(filepath.Join(root, rel))
			if strings.TrimSpace(t) != canonicalRedirect {
				toConvert = append(toConvert, rel)
			}
		}
	}
	var adapters []string
	if newAdapter != "" {
		adapters = append(adapters, newAdapter)
	}
	for _, rel := range toConvert {
		if !contains(adapters, rel) {
			adapters = append(adapters, rel)
		}
	}
	m, ord := buildManifest(a, adapters)
	manifestBytes := serializeManifest(ord)

	writes := []writeplan.PlannedWrite{{Rel: "leji.json", Content: string(manifestBytes)}}
	writes = append(writes, writeplan.PlannedWrite{Rel: m.BootProfilePath, Content: buildBootProfile(a)})
	for _, category := range a.categories {
		if category == "decisions" {
			continue
		}
		stub := categoryStubs[category]
		writes = append(writes, writeplan.PlannedWrite{
			Rel:     r + category + "/" + stub.file,
			Content: stubContent(stub.title, stub.summary, stub.body),
		})
	}
	writes = append(writes, writeplan.PlannedWrite{Rel: r + "decisions/0001-adopt-leji.md", Content: buildFirstDecision(a)})
	writes = append(writes, writeplan.PlannedWrite{Rel: r + "agents/core.md", Content: buildCoreProfile(a)})
	writes = append(writes, writeplan.PlannedWrite{Rel: BriefPath(r), Content: buildBrief(a)})

	var migrated []string
	usedSlugs := map[string]bool{}
	for _, rel := range toMigrate {
		base := importedSlug(rel)
		// Disambiguate when two source files would collide on the same slug.
		slug := base
		for n := 2; usedSlugs[slug]; n++ {
			slug = fmt.Sprintf("%s-%d", base, n)
		}
		usedSlugs[slug] = true
		content, _ := fsx.ReadText(filepath.Join(root, rel))
		writes = append(writes, writeplan.PlannedWrite{
			Rel:     r + "governance/imported-" + slug + ".md",
			Content: migrationDoc(rel, content),
		})
		migrated = append(migrated, rel)
	}
	if len(migrated) > 0 {
		writes = append(writes, writeplan.PlannedWrite{
			Rel:     r + "decisions/0002-adopt-existing-agent-context.md",
			Content: adoptExistingDecision(a, migrated),
		})
	}

	if newAdapter != "" {
		writes = append(writes, writeplan.PlannedWrite{Rel: newAdapter, Content: detect.AdapterContent(m.BootProfilePath)})
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
	plan := writeplan.Build(root, writes, wontModify, toConvert)
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
			Result:       Result{Written: []string{}, Manifest: m, Plan: plan, DryRun: true},
			DetectedRoot: detectedRoot,
			Migrated:     migrated,
			Draft:        draft,
		}, nil
	}

	var written []string
	if err := os.MkdirAll(root, 0o755); err != nil {
		return AdoptResult{}, err
	}
	if !fsx.ResolvesUnder(root, filepath.Join(root, "leji.json")) {
		return AdoptResult{}, fmt.Errorf("refusing to write through a symlink that escapes the target: %q", "leji.json")
	}
	if err := os.WriteFile(filepath.Join(root, "leji.json"), manifestBytes, 0o644); err != nil {
		return AdoptResult{}, err
	}
	written = append(written, "leji.json")
	convert := map[string]bool{}
	for _, rel := range toConvert {
		convert[rel] = true
	}
	for _, w := range writes[1:] {
		if convert[w.Rel] {
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

	sort.Strings(written)
	return AdoptResult{
		Result:       Result{Written: written, Manifest: m, Plan: plan, DryRun: false},
		DetectedRoot: detectedRoot,
		Migrated:     migrated,
		Draft:        draft,
	}, nil
}

// EnteringAdopted is the post-adopt guidance printed by the CLI.
func EnteringAdopted(result AdoptResult) string {
	lines := []string{EnteringTheLayer(result.Manifest)}
	if len(result.Migrated) > 0 {
		lines = append(lines, "",
			"Migrated "+strings.Join(result.Migrated, ", ")+" into "+result.Manifest.RootPath+"governance/ (originals untouched); refine into the right categories.")
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

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}
