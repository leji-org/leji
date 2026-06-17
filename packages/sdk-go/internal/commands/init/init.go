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
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

type Options struct {
	Dir   string
	Yes   bool
	Name  string
	Level string // "core" | "indexed"
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
		"- **<Term>**: <what it means here, including what it does not mean>.\n"},
	"system": {"invariants.md", "System Invariants",
		"The constraints every change lives with.",
		"- <An invariant every change must respect, e.g. \"money values are integer minor units\">.\n"},
	"practice": {"conventions.md", "Conventions",
		"Conventions and patterns applied automatically.",
		"- <A convention that has proven out at least twice (the proven-twice gate)>.\n"},
	"governance": {"operating-rules.md", "Operating Rules",
		"What agents may do unprompted and what needs a human gate.",
		"- Proceed without asking when: <defaults>.\n- Stop and ask when: <escalation triggers>.\n"},
}

func stubContent(title, summary, body string) string {
	return "---\nsummary: " + summary + "\n---\n\n# " + title + "\n\n" + body
}

// buildManifest constructs the typed manifest and the ordered serialization.
func buildManifest(a answers) (*manifest.Manifest, []byte) {
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
		Machine: &manifest.Machine{
			AgentProfilesPath:   r + "agents/",
			DecisionRecordsPath: r + "decisions/",
		},
		Owners: manifest.Owners{
			Primary: manifest.Owner{Name: a.ownerName, Contact: a.ownerContact},
		},
		Conformance: &manifest.Conformance{
			ClaimedLevel: a.level,
			ClaimedAt:    time.Now().UTC().Format("2006-01-02"),
		},
	}
	if a.level == "indexed" {
		m.Machine = &manifest.Machine{
			IndexPath:           r + "context-index.json",
			ChangelogPath:       r + "context-changelog.json",
			AgentProfilesPath:   r + "agents/",
			DecisionRecordsPath: r + "decisions/",
		}
	}
	for _, c := range a.categories {
		m.Categories[c] = manifest.CategoryMapping{Paths: []string{r + c + "/"}}
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
	machine := newOrdered()
	if a.level == "indexed" {
		machine.set("indexPath", r+"context-index.json")
		machine.set("changelogPath", r+"context-changelog.json")
	}
	machine.set("agentProfilesPath", r+"agents/")
	machine.set("decisionRecordsPath", r+"decisions/")
	root.set("machine", machine)
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

	var buf bytes.Buffer
	root.encode(&buf)
	buf.WriteByte('\n')
	return m, buf.Bytes()
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

// InitLayer bootstraps a context layer. Returns an error when leji.json exists.
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
	m, manifestBytes := buildManifest(a)
	var written []string
	r := a.rootPath

	if err := writeFileOnce(root, m.BootProfilePath, buildBootProfile(a), &written); err != nil {
		return Result{}, err
	}
	for _, category := range a.categories {
		if category == "decisions" {
			continue
		}
		stub := categoryStubs[category]
		if err := writeFileOnce(root, r+category+"/"+stub.file, stubContent(stub.title, stub.summary, stub.body), &written); err != nil {
			return Result{}, err
		}
	}
	if err := writeFileOnce(root, r+"decisions/0001-adopt-leji.md", buildFirstDecision(a), &written); err != nil {
		return Result{}, err
	}
	if err := writeFileOnce(root, r+"agents/core.md", buildCoreProfile(a), &written); err != nil {
		return Result{}, err
	}

	if a.level == "indexed" {
		changelogPaths := append(append([]string{}, written...), "leji.json")
		if err := writeFileOnce(root, m.Machine.ChangelogPath, buildChangelog(a, changelogPaths), &written); err != nil {
			return Result{}, err
		}
	}

	if err := os.MkdirAll(root, 0o755); err != nil {
		return Result{}, err
	}
	if err := os.WriteFile(filepath.Join(root, "leji.json"), manifestBytes, 0o644); err != nil {
		return Result{}, err
	}
	written = append(written, "leji.json")

	if a.level == "indexed" {
		if _, err := indexgen.WriteIndex(root, m); err != nil {
			return Result{}, err
		}
		written = append(written, m.Machine.IndexPath)
	}

	sort.Strings(written)
	return Result{Written: written, Manifest: m}, nil
}

// EnteringTheLayer is the post-init guidance printed by the CLI.
func EnteringTheLayer(m *manifest.Manifest) string {
	boot := m.BootProfilePath
	lines := []string{
		"",
		"Enter the layer by direct invocation, so the boot profile is the agent's first context:",
		"",
		"   claude \"Read ./" + boot + ", follow all instructions, and tell me when you are ready to begin.\"",
		"   codex \"Read ./" + boot + " and follow it before doing anything else.\"",
		"",
		"Package the invocation for the whole team (package.json):",
		"",
		"   \"start\": \"claude 'Read ./" + boot + ", follow all instructions, and tell me when you are ready to begin.'\"",
		"",
		"Next: fill in the seeded documents, then run `leji validate` and `leji conformance`.",
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
