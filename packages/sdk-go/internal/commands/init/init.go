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
	"strconv"
	"strings"
	"time"

	"github.com/leji-org/leji/packages/sdk-go/internal/assets"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/indexgen"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/validate"
	"github.com/leji-org/leji/packages/sdk-go/internal/detect"
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
	// Agent wires a vendor adapter: a host id/alias, "auto" (top detected), or "none".
	Agent string
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
	// Detected lists the coding-agent hosts found for this repo, ranked; informs
	// the handoff offer.
	Detected []detect.DetectedHost
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

// ensureLejiGitignored ensures the repository-root .gitignore ignores `.leji/`
// (the generated viewer and the transient onboarding brief, neither of which
// belongs in version control). Idempotent: creates the file if absent, appends
// the line (adding a leading newline when the file lacks a trailing one) only
// when the exact line is not already present. Matches the line exactly, so it
// never treats a comment or `docs/.leji/` as equivalent. Mirrors the Node SDK.
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

// writeManifestExclusive creates leji.json with O_EXCL so the entry point's
// existence check and the write are atomic: a concurrent run, or a symlink
// planted between check and write, cannot be overwritten or followed. An
// already-exists error is surfaced as the same message each entry point uses for
// its initial guard. Mirrors the Node SDK's writeManifestExclusive.
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
// so it is excluded from the index, the viewer, and the changelog.
func BriefPath(rootPath string) string {
	return rootPath + ".leji/onboarding-brief.md"
}

// CIWorkflowPath is the CI workflow path, relative to the repository root.
const CIWorkflowPath = ".github/workflows/leji.yml"

// GitlabCIPath and CircleCIConfigPath are the per-provider CI config paths,
// relative to the repository root.
const GitlabCIPath = ".gitlab-ci.yml"
const CircleCIConfigPath = ".circleci/config.yml"
const AzurePipelinePath = ".azure-pipelines/leji.yml"

const gitlabMarkerStart = "# >>> leji ci (managed) >>>"
const gitlabMarkerEnd = "# <<< leji ci (managed) <<<"

// AzureActivationNote is printed/returned when an Azure pipeline file is created:
// Azure Pipelines does not auto-discover a YAML file (unlike the other three), so
// the file is written but the pipeline still has to be created in Azure DevOps.
const AzureActivationNote = "Azure Pipelines does not auto-run this file. Create a pipeline that points at it (e.g. `az pipelines create --yml-path .azure-pipelines/leji.yml`), and on Azure Repos add a build-validation branch policy on main for pull-request checks."

// CiProvider is the CI provider targeted by `leji ci`.
type CiProvider = string

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

// EnsureCiWorkflow adds a CI workflow that runs `leji validate` on every change
// (the `leji ci` command), so CI can be added to a layer created without it.
// GitHub gets its own workflow file; GitLab is create-or-merge into the shared
// `.gitlab-ci.yml` via a marker-delimited managed block; CircleCI is created if
// absent, else left untouched (a snippet to add by hand is returned). All
// operations are deterministic text, so the three reference SDKs stay
// byte-identical. Refuses a symlink that escapes root. Mirrors the Node SDK.
func EnsureCiWorkflow(root, provider string) (CiResult, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return CiResult{}, err
	}
	switch provider {
	case "github":
		abs := filepath.Join(rootAbs, CIWorkflowPath)
		if err := guardWithinRoot(rootAbs, abs, CIWorkflowPath); err != nil {
			return CiResult{}, err
		}
		if _, err := os.Stat(abs); err == nil {
			return CiResult{Provider: provider, Path: CIWorkflowPath, Action: "unchanged"}, nil
		}
		if err := writeFileAtomic(rootAbs, abs, CIWorkflowPath, BuildGithubWorkflow()); err != nil {
			return CiResult{}, err
		}
		return CiResult{Provider: provider, Path: CIWorkflowPath, Action: "created"}, nil
	case "gitlab":
		abs := filepath.Join(rootAbs, GitlabCIPath)
		if err := guardWithinRoot(rootAbs, abs, GitlabCIPath); err != nil {
			return CiResult{}, err
		}
		block := BuildGitlabBlock()
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
			return CiResult{Provider: provider, Path: CircleCIConfigPath, Action: "manual", Snippet: BuildCircleCiSnippet()}, nil
		}
		if err := writeFileAtomic(rootAbs, abs, CircleCIConfigPath, BuildCircleCiConfig()); err != nil {
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
		if err := writeFileAtomic(rootAbs, abs, AzurePipelinePath, BuildAzurePipeline()); err != nil {
			return CiResult{}, err
		}
		return CiResult{Provider: provider, Path: AzurePipelinePath, Action: "created", Note: AzureActivationNote}, nil
	}
	// Unreachable from the CLI (it validates first); guards direct helper callers so
	// an unknown provider errors consistently across the three SDKs.
	return CiResult{}, fmt.Errorf("unknown provider %q", provider)
}

func guardWithinRoot(rootAbs, abs, rel string) error {
	if !fsx.ResolvesUnder(rootAbs, abs) {
		return fmt.Errorf("refusing to write through a symlink that escapes the target: %q", rel)
	}
	return nil
}

// writeFileAtomic writes contents to abs atomically: a sibling temp file, then a
// rename over the target, so an interrupted or failed write can never leave a
// partial file. On any failure the temp file is removed (no repo-visible artifact)
// and a deterministic, OS-text-free error is returned so the three SDKs report I/O
// failures byte-identically. Mirrors the Node SDK.
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

// maybeInjectWriteFailure is test-only fault injection: when LEJI_TEST_FAIL_RENAME is set,
// it simulates a write that fails after the temp file exists but before the rename commits,
// so the cleanup and normalized-error path can be exercised identically across the SDKs.
func maybeInjectWriteFailure() error {
	if os.Getenv("LEJI_TEST_FAIL_RENAME") != "" {
		return errors.New("injected write failure")
	}
	return nil
}

// writeFailure renders a deterministic, OS-text-free message for a failed CI-file
// write, keeping stderr byte-identical across the Node, Go, and Python SDKs.
func writeFailure(rel string, err error) error {
	if errors.Is(err, os.ErrPermission) {
		return fmt.Errorf("cannot write %q: permission denied", rel)
	}
	return fmt.Errorf("cannot write %q", rel)
}

// mergeGitlabBlock inserts/replaces the managed block in an existing
// `.gitlab-ci.yml`, byte-exactly. It replaces the first managed block and drops
// any later duplicate managed blocks, so the file is left with exactly one.
// Mirrors the Node SDK.
func mergeGitlabBlock(text, block string) string {
	if start, end, ok := managedBlockSpan(text); ok {
		return text[:start] + block + stripManagedBlocks(text[end:])
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
func managedBlockSpan(text string) (start, end int, ok bool) {
	start = strings.Index(text, gitlabMarkerStart)
	if start == -1 {
		return 0, 0, false
	}
	rel := strings.Index(text[start:], gitlabMarkerEnd)
	if rel == -1 {
		return 0, 0, false
	}
	endMarker := start + rel
	nl := strings.Index(text[endMarker:], "\n")
	if nl == -1 {
		end = len(text)
	} else {
		end = endMarker + nl + 1
	}
	return start, end, true
}

// stripManagedBlocks removes every managed block from text (drops duplicates left
// after the first).
func stripManagedBlocks(text string) string {
	var out strings.Builder
	rest := text
	for {
		start, end, ok := managedBlockSpan(rest)
		if !ok {
			out.WriteString(rest)
			return out.String()
		}
		out.WriteString(rest[:start])
		rest = rest[end:]
	}
}

// BuildGithubWorkflow is the GitHub Actions workflow: a standalone file under
// .github/workflows/. The YAML is byte-identical across SDKs.
func BuildGithubWorkflow() string {
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

// BuildGitlabBlock is the GitLab CI marker-delimited job merged into the shared
// .gitlab-ci.yml.
func BuildGitlabBlock() string {
	return gitlabMarkerStart + "\n" +
		"leji-validate:\n" +
		"  image: node:22\n" +
		"  script:\n" +
		"    - npx -y @leji-org/leji@latest validate\n" +
		gitlabMarkerEnd + "\n"
}

// BuildCircleCiConfig is the CircleCI config written when .circleci/config.yml is absent.
func BuildCircleCiConfig() string {
	return "version: 2.1\n" +
		"jobs:\n" +
		"  leji-validate:\n" +
		"    docker:\n" +
		"      - image: node:22\n" +
		"    steps:\n" +
		"      - checkout\n" +
		"      - run: npx -y @leji-org/leji@latest validate\n" +
		"workflows:\n" +
		"  leji:\n" +
		"    jobs:\n" +
		"      - leji-validate\n"
}

// BuildCircleCiSnippet is the jobs + workflows fragment to add by hand to an
// existing CircleCI config.
func BuildCircleCiSnippet() string {
	return "jobs:\n" +
		"  leji-validate:\n" +
		"    docker:\n" +
		"      - image: node:22\n" +
		"    steps:\n" +
		"      - checkout\n" +
		"      - run: npx -y @leji-org/leji@latest validate\n" +
		"workflows:\n" +
		"  leji:\n" +
		"    jobs:\n" +
		"      - leji-validate\n"
}

// BuildAzurePipeline is the Azure Pipelines config: a dedicated
// .azure-pipelines/leji.yml the user wires to a pipeline.
func BuildAzurePipeline() string {
	return "trigger:\n" +
		"  - main\n" +
		"pool:\n" +
		"  vmImage: ubuntu-latest\n" +
		"steps:\n" +
		"  - task: NodeTool@0\n" +
		"    inputs:\n" +
		"      versionSpec: '22.x'\n" +
		"  - script: npx -y @leji-org/leji@latest validate\n" +
		"    displayName: leji validate\n"
}

func hostIDs() []string {
	ids := make([]string, len(detect.HostSpecs))
	for i, s := range detect.HostSpecs {
		ids[i] = s.ID
	}
	return ids
}

// agentTokenRe matches a kebab identifier. A name (also the agent-profile `id`
// and the agents-map key) and a role must be kebab identifiers: matches the
// agent-profile schema's id pattern, is safe as a path segment, and is safe to
// interpolate into YAML frontmatter and JSON.
var agentTokenRe = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

func assertAgentToken(label, value string) error {
	if !agentTokenRe.MatchString(value) {
		return fmt.Errorf("%s must be lowercase letters, digits, and single dashes (e.g. \"thought-partner\"); got %q", label, value)
	}
	return nil
}

// BuildAgentProfile is a starter agent profile for a named agent bound to a
// host. The body is keyed off the role: `reviewer` (the default) keeps the
// review-focused posture; any other role gets a neutral template the author
// fills in. The frontmatter satisfies the agent-profile schema
// (id/name/role/requiredRead/mustAskWhen).
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
			"  - " + rootPath + "boot-profile.md\n" +
			"  - " + rootPath + "agents/core.md\n" +
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
		"  - " + rootPath + "boot-profile.md\n" +
		"  - " + rootPath + "agents/core.md\n" +
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

// AgentOptions configures AddAgent.
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

// AddAgent wires a named agent into an existing layer (the `leji agent`
// command): write a starter profile under the agent-profiles path, wire the
// host's vendor adapter if absent, and bind the agent (and adapter) in leji.json
// via an in-place text edit that preserves the rest of the file. Never
// overwrites an existing profile or adapter, and re-running with the same
// arguments is a no-op.
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

// assertCleanWorkingTree refuses to mutate a dirty working tree. init/adopt write
// (and adopt moves) many files; the "git restore cleanly undoes Leji's writes"
// safety net only holds if the tree was clean to begin with, so a dirty tree is
// refused outright rather than entangling Leji's writes with the user's
// uncommitted work. A non-git directory has no such net and is allowed: that is how
// a fresh layer is bootstrapped before `git init`. Callers skip this under DryRun.
func assertCleanWorkingTree(root string) error {
	if clean, isRepo := git.WorkingTreeClean(root); isRepo && !clean {
		return errors.New("the working tree has uncommitted changes; commit or stash them first so this stays cleanly reversible (preview with --dry-run)")
	}
	return nil
}

// InitLayer bootstraps a context layer. Returns an error when leji.json exists.
// With DryRun, computes the write plan and touches nothing.
func InitLayer(opts Options) (Result, error) {
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
	a := prompt(opts)
	// The interactive root path (and every path derived from it) must stay a
	// relative, in-tree path before anything is written, so an answer like
	// "../../etc/" or an absolute path cannot escape the target directory.
	if err := validateRelPath(fsx.StripSlash(a.rootPath)); err != nil {
		return Result{}, fmt.Errorf("context root %q is not a safe relative path: %w", a.rootPath, err)
	}
	m, ord := buildManifest(a, nil)
	r := a.rootPath
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
		return Result{Written: []string{}, Manifest: m, Plan: plan, DryRun: true, Detected: detected}, nil
	}

	var written []string
	if err := os.MkdirAll(root, 0o755); err != nil {
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
	if err := ensureLejiGitignored(root); err != nil {
		return Result{}, err
	}

	sort.Strings(written)
	return Result{Written: written, Manifest: m, Plan: plan, DryRun: false, Detected: detected}, nil
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

// --- handoff offer (post-scaffold) ---

// promptHostIDs are the CLI hosts that accept an inline prompt argument, so Leji
// can launch the handoff for the user (`claude "..."`, `codex "..."`). Directory-
// style IDE hosts (Cursor, Windsurf) and prompt syntaxes we have not verified
// (Gemini) are deliberately left out; when only those are present the offer is
// skipped and the printed instructions stand. Mirrors the two commands documented
// in EnteringTheLayer and the Node SDK's PROMPT_HOST_IDS.
var promptHostIDs = []string{"claude-code", "codex"}

type promptHost struct {
	id   string
	bin  string
	name string
}

// LaunchResult mirrors the outcome of spawning an agent: Started is false when
// the process never started (e.g. binary not found); a non-nil Err with
// Started=true means it ran but did not finish cleanly (non-zero exit or signal).
type LaunchResult struct {
	Started bool
	Err     error
}

// HandoffIO is injectable I/O for the handoff offer, so the interactive flow
// (prompting and launching a child process) is deterministically testable.
// DefaultHandoffIO is the production wiring; tests pass a fake that scripts the
// answer and records the launch instead of spawning.
type HandoffIO struct {
	// ReadLine prompts and returns one trimmed line; "" means accept the default.
	ReadLine func(question, fallback string) string
	// Launch runs the chosen agent with the prompt from cwd; cwd anchors the agent
	// at the layer root so a relative prompt path resolves (matters for
	// `leji start --root <dir>`). An empty cwd uses the current directory.
	Launch func(bin, promptArg, cwd string) LaunchResult
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
		Launch: func(bin, promptArg, cwd string) LaunchResult {
			cmd := exec.Command(bin, promptArg)
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
	}
}

// promptCapableHosts returns the detected hosts (on PATH) that can be launched
// with an inline prompt, ranked (detected is already strongest-first).
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

// pickFromMultiple asks which of several detected hosts to launch (numbered), or
// none. Launching an agent is a side effect, so it requires an explicit, in-range
// number. Empty / n / junk / out-of-range all skip and fall back to the printed
// instructions; we never launch an agent the user did not pick.
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

// chooseHost asks which detected host to hand off to (or none): a single host
// confirms [Y/n]; several are numbered via pickFromMultiple.
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

// launchHost launches a chosen host with promptArg from cwd. Returns true only on
// a clean exit; a spawn failure or a non-zero/signalled exit returns false so the
// caller can fall back to printed instructions.
func launchHost(host promptHost, promptArg string, hio *HandoffIO, cwd string, out io.Writer) bool {
	fmt.Fprintf(out, "\nStarting %s: %s \"%s\"\n\n", host.name, host.bin, promptArg)
	res := hio.Launch(host.bin, promptArg, cwd)
	if !res.Started {
		fmt.Fprintf(os.Stderr, "\nleji: could not start %s (%v).\n", host.bin, res.Err)
		return false
	}
	// Started but exited non-zero or was killed (e.g. Ctrl-C): did not finish
	// cleanly, so fall back to the printed instructions.
	return res.Err == nil
}

// HandoffOffer offers to hand the scaffold to a detected agent and launch it
// directly. Interactive only: fires when interactive is set (a TTY and not --yes)
// and at least one prompt-capable host is on PATH. Returns true when an agent was
// launched and finished cleanly (the caller prints nothing further), false to
// fall back to the printed instructions (no agent detected, declined, could not
// start, or did not finish cleanly). Never fires non-interactively, so
// scripted/CI output and cross-SDK parity are unchanged.
func HandoffOffer(m *manifest.Manifest, detected []detect.DetectedHost, interactive bool, hio *HandoffIO, out io.Writer, agent string) (bool, error) {
	if !interactive {
		return false, nil
	}
	promptArg := "Read ./" + BriefPath(m.RootPath) + " and follow it."
	// --agent forces a specific launchable host (skipping the prompt); otherwise the
	// detected hosts drive the offer. The interactive gate above keeps this off the
	// scripted/CI path, so cross-SDK parity is unchanged.
	var chosen *promptHost
	if agent != "" {
		id := detect.ResolveHostId(agent)
		var spec *detect.HostSpec
		if id != "" && contains(promptHostIDs, id) {
			spec = detect.SpecByID(id)
		}
		if spec == nil {
			return false, fmt.Errorf("--agent must be a launchable host (%s); got %q", strings.Join(promptHostIDs, ", "), agent)
		}
		chosen = &promptHost{id: spec.ID, bin: spec.Bins[0], name: spec.Name}
	} else {
		hosts := promptCapableHosts(detected)
		if len(hosts) == 0 {
			return false, nil
		}
		chosen = chooseHost(hosts, promptArg, hio, out)
	}
	if chosen == nil {
		return false, nil
	}
	return launchHost(*chosen, promptArg, hio, "", out), nil
}

// --- start (enter an existing layer) ---

// StartOutcome is the result of EnterLayer: an agent launched cleanly, fell back
// to the printed commands (nothing to launch), or the boot profile is
// missing/invalid.
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
}

// bootPrompt is the prompt `leji start` hands the agent: point it at the boot profile.
func bootPrompt(bootRel string) string {
	return "Read ./" + bootRel + ", follow it, and tell me when you're ready."
}

// EnterLayer boots a coding agent into an existing layer, pointed at the boot
// profile. One detected host launches directly; several prompt; Agent forces a
// specific launchable host. Launches from the layer root so the relative boot path
// resolves. Returns StartLaunched on a clean run, StartFallback when there is
// nothing to launch (no host, non-interactive, or the launch failed), or
// StartBootMissing when the boot profile path is unsafe or absent. Returns a
// non-nil error on an unknown/non-launchable Agent (a usage error → exit 2).
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
		id := detect.ResolveHostId(opts.Agent)
		var spec *detect.HostSpec
		if id != "" && contains(promptHostIDs, id) {
			spec = detect.SpecByID(id)
		}
		if spec == nil {
			return StartFallback, fmt.Errorf("--agent must be a launchable host (%s); got %q", strings.Join(promptHostIDs, ", "), opts.Agent)
		}
		host = &promptHost{id: spec.ID, bin: spec.Bins[0], name: spec.Name}
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
	if launchHost(*host, promptArg, hio, root, out) {
		return StartLaunched, nil
	}
	return StartFallback, nil
}

// EnteringViaBoot is printed when `leji start` launches nothing (no agent,
// non-interactive, or a failed launch): the copy-paste commands to enter the layer
// via the boot profile.
func EnteringViaBoot(m *manifest.Manifest) string {
	promptArg := bootPrompt(m.BootProfilePath)
	lines := []string{
		"",
		"No coding agent was launched. To enter this context layer, run one of:",
		"",
		"   claude \"" + promptArg + "\"",
		"   codex \"" + promptArg + "\"",
		"",
		"Each points the agent at the boot profile, which loads the team context before any work.",
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
	// shown verbatim, never rendered: the fenced migration cannot inject script into
	// the Docsify preview. (That preview is a local, trusted-content viewer, not a
	// sandbox; other layer documents are still rendered as authored.)
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

	r := a.rootPath

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
			Result:       Result{Written: []string{}, Manifest: m, Plan: plan, DryRun: true, Detected: detected},
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
	if err := ensureLejiGitignored(root); err != nil {
		return AdoptResult{}, err
	}

	sort.Strings(written)
	return AdoptResult{
		Result:       Result{Written: written, Manifest: m, Plan: plan, DryRun: false, Detected: detected},
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
