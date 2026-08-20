package initcmd

import (
	"encoding/json"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/indexgen"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
	"github.com/leji-org/leji/packages/sdk-go/internal/writeplan"
)

// init --dry-run writes nothing; the plan creates the brief and marks an
// existing vendor file wont-modify.
func TestInitDryRunWritesNothing(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte("some existing agent config\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := InitLayer(Options{Dir: dir, Yes: true, DryRun: true})
	if err != nil {
		t.Fatalf("dry-run init: %v", err)
	}
	if !res.DryRun {
		t.Fatal("result.DryRun should be true")
	}
	if len(res.Written) != 0 {
		t.Fatalf("dry-run wrote files: %v", res.Written)
	}
	if _, err := os.Stat(filepath.Join(dir, "leji.json")); err == nil {
		t.Fatal("dry-run creates no manifest")
	}

	var creates []string
	for _, e := range res.Plan {
		if e.Status == writeplan.Create {
			creates = append(creates, e.Rel)
		}
	}
	if !contains(creates, "leji.json") {
		t.Fatalf("plan should create leji.json, got %v", creates)
	}
	if !contains(creates, ".leji/work/onboarding-brief.md") {
		t.Fatalf("plan should create the brief, got %v", creates)
	}
	var vendor *writeplan.PlanEntry
	for i := range res.Plan {
		if res.Plan[i].Rel == "CLAUDE.md" {
			vendor = &res.Plan[i]
		}
	}
	if vendor == nil || vendor.Status != writeplan.WontModify {
		t.Fatalf("existing CLAUDE.md should be wont-modify, got %+v", vendor)
	}
}

// init writes the onboarding brief under a dot-dir, excluded from the index.
func TestInitWritesBriefExcludedFromIndex(t *testing.T) {
	dir := t.TempDir()
	if _, err := InitLayer(Options{Dir: dir, Yes: true, Level: "indexed", Name: "acme-context"}); err != nil {
		t.Fatalf("init: %v", err)
	}
	brief := filepath.Join(dir, ".leji", "work", "onboarding-brief.md")
	if _, err := os.Stat(brief); err != nil {
		t.Fatalf("brief not written: %v", err)
	}
	load := manifest.LoadManifest(dir)
	if load.Manifest == nil {
		t.Fatal("manifest did not load")
	}
	res, err := indexgen.WriteIndex(dir, load.Manifest)
	if err != nil {
		t.Fatalf("writeIndex: %v", err)
	}
	for _, e := range res.Index.Entries {
		if strings.Contains(e.Path, ".leji") {
			t.Fatalf("transient brief appears in the index: %s", e.Path)
		}
	}
}

// validate --content warns on a fresh scaffold but never errors.
func TestValidateContentWarnsOnFreshScaffold(t *testing.T) {
	dir := t.TempDir()
	if _, err := InitLayer(Options{Dir: dir, Yes: true}); err != nil {
		t.Fatalf("init: %v", err)
	}
	res := validateLayer(t, dir, true)
	rules := map[string]bool{}
	errors := 0
	for _, f := range res.Findings {
		rules[f.Rule] = true
		if f.Severity == findings.Error {
			errors++
		}
	}
	for _, want := range []string{"content-identity", "content-placeholder", "content-thin"} {
		if !rules[want] {
			t.Fatalf("expected %s, got rules %v", want, rules)
		}
	}
	if errors != 0 {
		t.Fatalf("content findings must be warning-only; got %d errors", errors)
	}
}

// validate without --content does not emit content findings.
func TestValidateWithoutContentNoContentFindings(t *testing.T) {
	dir := t.TempDir()
	if _, err := InitLayer(Options{Dir: dir, Yes: true}); err != nil {
		t.Fatalf("init: %v", err)
	}
	res := validateLayer(t, dir, false)
	for _, f := range res.Findings {
		if strings.HasPrefix(f.Rule, "content-") {
			t.Fatalf("unexpected content finding without --content: %s", f.Rule)
		}
	}
}

func TestPopulatedLayerPassesContentLint(t *testing.T) {
	dir := t.TempDir()
	if _, err := InitLayer(Options{Dir: dir, Yes: true}); err != nil {
		t.Fatalf("init: %v", err)
	}
	boot := strings.Join([]string{
		"# Boot Profile",
		"",
		"## Identity",
		"",
		"Acme is a B2B invoicing platform in production since 2024.",
		"",
		"## Loading",
		"",
		"- docs/system/invariants.md: the rules every change lives with",
		"",
		"## Posture",
		"",
		"- Proceed without asking: doc fixes.",
		"- Stop and ask: settlement math.",
		"- Never: bypass the ledger.",
		"",
		"## Maintenance",
		"",
		"Append to docs/decisions when you change this layer.",
		"",
	}, "\n")
	mustWrite(t, filepath.Join(dir, "docs", "boot-profile.md"), boot)
	mustWrite(t, filepath.Join(dir, "docs", "domain", "glossary.md"),
		"---\nsummary: terms\n---\n\n# Glossary\n\n- Invoice: a request for payment.\n- Credit note: reduces an invoice.\n- Settlement: matching funds to invoices.\n")
	mustWrite(t, filepath.Join(dir, "docs", "system", "invariants.md"),
		"---\nsummary: rules\n---\n\n# System Invariants\n\n- Money is integer minor units.\n- Invoices are immutable once sent.\n- The ledger is the source of truth.\n")

	res := validateLayer(t, dir, true)
	for _, f := range res.Findings {
		if strings.HasPrefix(f.Rule, "content-") {
			var got []string
			for _, ff := range res.Findings {
				got = append(got, ff.Rule)
			}
			t.Fatalf("expected no content findings, got: %s", strings.Join(got, ", "))
		}
	}
}

// init --agent scaffolds a clean layer without creating or declaring any vendor
// adapter.
func TestInitAgentWiresRedirect(t *testing.T) {
	dir := t.TempDir()
	res, err := InitLayer(Options{Dir: dir, Yes: true, Agent: "claude-code"})
	if err != nil {
		t.Fatalf("init --agent: %v", err)
	}
	if contains(res.Written, "CLAUDE.md") {
		t.Fatalf("init --agent must not create a vendor adapter, written: %v", res.Written)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "CLAUDE.md")); !os.IsNotExist(statErr) {
		t.Fatalf("CLAUDE.md should not exist, stat err: %v", statErr)
	}
	load := manifest.LoadManifest(dir)
	if load.Manifest == nil {
		t.Fatal("manifest did not load")
	}
	if len(load.Manifest.VendorAdapters) != 0 {
		t.Fatalf("vendorAdapters should be empty, got %v", load.Manifest.VendorAdapters)
	}
	if _, err := exec.LookPath("git"); err == nil {
		cmd := exec.Command("git", "init", "-q")
		cmd.Dir = dir
		if err := cmd.Run(); err != nil {
			t.Fatalf("git init: %v", err)
		}
	}
	v := validateLayer(t, dir, false)
	errCount := 0
	for _, f := range v.Findings {
		if f.Severity == findings.Error {
			errCount++
		}
	}
	if errCount != 0 {
		t.Fatalf("expected no errors, got %d: %+v", errCount, v.Findings)
	}
}

// init --agent never overwrites an existing entrypoint.
func TestInitAgentNeverOverwrites(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte("my own config\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := InitLayer(Options{Dir: dir, Yes: true, Agent: "claude-code"})
	if err != nil {
		t.Fatalf("init --agent: %v", err)
	}
	if contains(res.Written, "CLAUDE.md") {
		t.Fatalf("CLAUDE.md should not be (re)written, written: %v", res.Written)
	}
	body, err := os.ReadFile(filepath.Join(dir, "CLAUDE.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "my own config\n" {
		t.Fatalf("existing entrypoint was modified: %q", body)
	}
	load := manifest.LoadManifest(dir)
	if load.Manifest == nil {
		t.Fatal("manifest did not load")
	}
	if len(load.Manifest.VendorAdapters) != 0 {
		t.Fatalf("vendorAdapters should be empty, got %v", load.Manifest.VendorAdapters)
	}
}

// --agent names the handoff host, so an unknown value is a usage error naming the
// accepted set, the way --mode and --level reject theirs. It is checked before any
// filesystem work, so the directory is left untouched.
func TestInitAgentRejectsUnlaunchableHost(t *testing.T) {
	dir := t.TempDir()
	_, err := InitLayer(Options{Dir: dir, Yes: true, Agent: "frobnicate"})
	if err == nil {
		t.Fatal("init --agent frobnicate should have errored")
	}
	want := `--agent must be a launchable host (claude-code, codex); got "frobnicate"`
	if err.Error() != want {
		t.Fatalf("error = %q, want %q", err.Error(), want)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "leji.json")); !os.IsNotExist(statErr) {
		t.Fatalf("nothing should have been written, stat err: %v", statErr)
	}
}

// init writes the portable AGENTS.md pointer by default and validates clean.
func TestInitWritesPortableAgentsPointer(t *testing.T) {
	dir := t.TempDir()
	res, err := InitLayer(Options{Dir: dir, Yes: true})
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if !contains(res.Written, "AGENTS.md") {
		t.Fatalf("written should include AGENTS.md, got %v", res.Written)
	}
	body, err := os.ReadFile(filepath.Join(dir, "AGENTS.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "Read ./docs/boot-profile.md first. It is the canonical context entrypoint for this repository.\n" {
		t.Fatalf("AGENTS.md content = %q", body)
	}
	// The pointer is the well-known portable adapter; no manifest declaration needed.
	load := manifest.LoadManifest(dir)
	if load.Manifest == nil {
		t.Fatal("manifest did not load")
	}
	if len(load.Manifest.VendorAdapters) != 0 {
		t.Fatalf("vendorAdapters should be empty, got %v", load.Manifest.VendorAdapters)
	}
	gitInit(t, dir)
	v := validateLayer(t, dir, false)
	errCount := 0
	for _, f := range v.Findings {
		if f.Severity == findings.Error {
			errCount++
		}
	}
	if errCount != 0 {
		t.Fatalf("expected no errors, got %d: %+v", errCount, v.Findings)
	}
}

// init --no-agents skips the portable AGENTS.md pointer.
func TestInitNoAgentsSkipsPortablePointer(t *testing.T) {
	dir := t.TempDir()
	res, err := InitLayer(Options{Dir: dir, Yes: true, NoAgents: true})
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if contains(res.Written, "AGENTS.md") {
		t.Fatalf("AGENTS.md should not be written, got %v", res.Written)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "AGENTS.md")); !os.IsNotExist(statErr) {
		t.Fatalf("AGENTS.md should not exist, stat err: %v", statErr)
	}
}

// init never touches an existing AGENTS.md (stays leave-as-is).
func TestInitNeverTouchesExistingAgentsFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte("my own instructions\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := InitLayer(Options{Dir: dir, Yes: true})
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if contains(res.Written, "AGENTS.md") {
		t.Fatalf("AGENTS.md should not be written, got %v", res.Written)
	}
	body, err := os.ReadFile(filepath.Join(dir, "AGENTS.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "my own instructions\n" {
		t.Fatalf("existing AGENTS.md was modified: %q", body)
	}
	var entry *writeplan.PlanEntry
	for i := range res.Plan {
		if res.Plan[i].Rel == "AGENTS.md" {
			entry = &res.Plan[i]
		}
	}
	if entry == nil || entry.Status != writeplan.WontModify {
		t.Fatalf("existing AGENTS.md should be wont-modify in the plan, got %+v", entry)
	}
}

// --agent selects the handoff host and nothing else: no vendor entrypoint file, no
// `vendorAdapters` manifest key. Only the portable AGENTS.md pointer is written.
func TestInitAgentCreatesNoVendorAdapter(t *testing.T) {
	dir := t.TempDir()
	if _, err := exec.LookPath("git"); err == nil {
		cmd := exec.Command("git", "init", "-q")
		cmd.Dir = dir
		if err := cmd.Run(); err != nil {
			t.Fatalf("git init: %v", err)
		}
	}
	res, err := InitLayer(Options{Dir: dir, Yes: true, Agent: "claude-code"})
	if err != nil {
		t.Fatalf("init --agent claude-code: %v", err)
	}
	if contains(res.Written, "CLAUDE.md") {
		t.Fatalf("vendor adapter must not be created, written: %v", res.Written)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "CLAUDE.md")); !os.IsNotExist(statErr) {
		t.Fatalf("CLAUDE.md should not exist, stat err: %v", statErr)
	}
	load := manifest.LoadManifest(dir)
	if load.Manifest == nil {
		t.Fatal("manifest did not load")
	}
	if len(load.Manifest.VendorAdapters) != 0 {
		t.Fatalf("vendorAdapters should be empty, got %v", load.Manifest.VendorAdapters)
	}
	v := validateLayer(t, dir, false)
	errCount := 0
	for _, f := range v.Findings {
		if f.Severity == findings.Error {
			errCount++
		}
	}
	if errCount != 0 {
		t.Fatalf("expected no errors, got %d: %+v", errCount, v.Findings)
	}
}

// init does not write a CI workflow (that is `leji ci`).
func TestInitDoesNotWriteCiWorkflow(t *testing.T) {
	dir := t.TempDir()
	res, err := InitLayer(Options{Dir: dir, Yes: true})
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if contains(res.Written, ".github/workflows/leji.yml") {
		t.Fatalf("init no longer creates CI; use leji ci. written: %v", res.Written)
	}
	if _, err := os.Stat(filepath.Join(dir, ".github", "workflows", "leji.yml")); !os.IsNotExist(err) {
		t.Fatalf("workflow should not exist, stat err: %v", err)
	}
}

func mustWrite(t *testing.T, abs, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// agent wires a named reviewer (profile + binding) into a clean layer, creating
// no vendor adapter.
func TestAgentWiresNamedReviewer(t *testing.T) {
	dir := t.TempDir()
	if _, err := exec.LookPath("git"); err == nil {
		cmd := exec.Command("git", "init", "-q")
		cmd.Dir = dir
		if err := cmd.Run(); err != nil {
			t.Fatalf("git init: %v", err)
		}
	}
	if _, err := InitLayer(Options{Dir: dir, Yes: true, Agent: "claude-code"}); err != nil {
		t.Fatalf("init --agent: %v", err)
	}
	load := manifest.LoadManifest(dir)
	res, err := AddAgent(dir, load.Manifest, AgentOptions{Host: "codex", Name: "reviewer"})
	if err != nil {
		t.Fatalf("AddAgent: %v", err)
	}
	if !res.ProfileCreated || !res.ManifestChanged {
		t.Fatalf("expected profile + manifest created, got %+v", res)
	}
	if res.HostID != "codex" {
		t.Fatalf("expected host codex, got %q", res.HostID)
	}
	load = manifest.LoadManifest(dir)
	if load.Manifest.Agents["reviewer"] != "docs/agents/reviewer.md" {
		t.Fatalf("agents.reviewer = %q, want docs/agents/reviewer.md", load.Manifest.Agents["reviewer"])
	}
	if len(load.Manifest.VendorAdapters) != 0 {
		t.Fatalf("agent must not create vendor adapters, got %v", load.Manifest.VendorAdapters)
	}
	// The AGENTS.md on disk is init's portable pointer (default-on), not
	// addAgent's work.
	pointer, err := os.ReadFile(filepath.Join(dir, "AGENTS.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(pointer) != "Read ./docs/boot-profile.md first. It is the canonical context entrypoint for this repository.\n" {
		t.Fatalf("AGENTS.md should be init's portable pointer, got %q", pointer)
	}
	body, err := os.ReadFile(filepath.Join(dir, "docs", "agents", "reviewer.md"))
	if err != nil {
		t.Fatal(err)
	}
	reviewer := string(body)
	if !strings.Contains(reviewer, "\nid: reviewer\n") || !strings.Contains(reviewer, "\nrole: reviewer\n") || !strings.Contains(reviewer, "\nhost: codex\n") {
		t.Fatalf("reviewer profile missing id/role/host:\n%s", reviewer)
	}
	v := validateLayer(t, dir, false)
	errCount := 0
	for _, f := range v.Findings {
		if f.Severity == findings.Error {
			errCount++
		}
	}
	if errCount != 0 {
		t.Fatalf("expected no errors, got %d: %+v", errCount, v.Findings)
	}
}

// agent with no --host binds a resident agent: profile with no host: frontmatter
// line, bound in the agents map, no vendor file.
func TestAgentBindsResidentWithoutHost(t *testing.T) {
	dir := t.TempDir()
	if _, err := exec.LookPath("git"); err == nil {
		cmd := exec.Command("git", "init", "-q")
		cmd.Dir = dir
		_ = cmd.Run()
	}
	if _, err := InitLayer(Options{Dir: dir, Yes: true}); err != nil {
		t.Fatalf("init: %v", err)
	}
	m := manifest.LoadManifest(dir).Manifest
	res, err := AddAgent(dir, m, AgentOptions{Name: "reviewer"})
	if err != nil {
		t.Fatalf("AddAgent: %v", err)
	}
	if !res.ProfileCreated || !res.ManifestChanged {
		t.Fatalf("expected profile + manifest created, got %+v", res)
	}
	if res.HostID != "" {
		t.Fatalf("resident agent should have no host, got %q", res.HostID)
	}
	load := manifest.LoadManifest(dir)
	if load.Manifest.Agents["reviewer"] != "docs/agents/reviewer.md" {
		t.Fatalf("agents.reviewer = %q, want docs/agents/reviewer.md", load.Manifest.Agents["reviewer"])
	}
	if len(load.Manifest.VendorAdapters) != 0 {
		t.Fatalf("resident agent must not create vendor adapters, got %v", load.Manifest.VendorAdapters)
	}
	body, err := os.ReadFile(filepath.Join(dir, "docs", "agents", "reviewer.md"))
	if err != nil {
		t.Fatal(err)
	}
	reviewer := string(body)
	if strings.Contains(reviewer, "\nhost:") {
		t.Fatalf("resident profile must not pin a host:\n%s", reviewer)
	}
	if strings.Contains(reviewer, "(host ") {
		t.Fatalf("resident profile prose must not mention a host:\n%s", reviewer)
	}
	if !strings.Contains(reviewer, "\nid: reviewer\n") || !strings.Contains(reviewer, "\nrole: reviewer\n") {
		t.Fatalf("resident profile missing id/role:\n%s", reviewer)
	}
}

// agent is idempotent: a second run with the same args changes nothing.
func TestAgentIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	if _, err := InitLayer(Options{Dir: dir, Yes: true}); err != nil {
		t.Fatalf("init: %v", err)
	}
	m := manifest.LoadManifest(dir).Manifest
	if _, err := AddAgent(dir, m, AgentOptions{Host: "codex", Name: "reviewer"}); err != nil {
		t.Fatalf("AddAgent: %v", err)
	}
	after, err := os.ReadFile(filepath.Join(dir, "leji.json"))
	if err != nil {
		t.Fatal(err)
	}
	res2, err := AddAgent(dir, m, AgentOptions{Host: "codex", Name: "reviewer"})
	if err != nil {
		t.Fatalf("AddAgent second: %v", err)
	}
	if res2.ProfileCreated || res2.ManifestChanged {
		t.Fatalf("expected nothing created on second run, got %+v", res2)
	}
	again, err := os.ReadFile(filepath.Join(dir, "leji.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(again) {
		t.Fatalf("leji.json changed on idempotent run:\n%s\n---\n%s", after, again)
	}
}

// agent appends a second binding without disturbing the first.
func TestAgentAppendsSecondBinding(t *testing.T) {
	dir := t.TempDir()
	if _, err := exec.LookPath("git"); err == nil {
		cmd := exec.Command("git", "init", "-q")
		cmd.Dir = dir
		_ = cmd.Run()
	}
	if _, err := InitLayer(Options{Dir: dir, Yes: true}); err != nil {
		t.Fatalf("init: %v", err)
	}
	if _, err := AddAgent(dir, manifest.LoadManifest(dir).Manifest, AgentOptions{Host: "codex", Name: "reviewer"}); err != nil {
		t.Fatalf("AddAgent reviewer: %v", err)
	}
	if _, err := AddAgent(dir, manifest.LoadManifest(dir).Manifest, AgentOptions{Host: "claude-code", Name: "thought-partner", Role: "advisor"}); err != nil {
		t.Fatalf("AddAgent thought-partner: %v", err)
	}
	load := manifest.LoadManifest(dir)
	if load.Manifest.Agents["reviewer"] != "docs/agents/reviewer.md" {
		t.Fatalf("agents.reviewer = %q", load.Manifest.Agents["reviewer"])
	}
	if load.Manifest.Agents["thought-partner"] != "docs/agents/thought-partner.md" {
		t.Fatalf("agents.thought-partner = %q", load.Manifest.Agents["thought-partner"])
	}
	body, err := os.ReadFile(filepath.Join(dir, "docs", "agents", "thought-partner.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "\nrole: advisor\n") {
		t.Fatalf("thought-partner profile missing role: advisor:\n%s", body)
	}
	v := validateLayer(t, dir, false)
	for _, f := range v.Findings {
		if f.Severity == findings.Error {
			t.Fatalf("expected no errors: %+v", v.Findings)
		}
	}
}

// agent rejects an unknown host and a non-kebab name.
func TestAgentRejectsUnknownHostAndBadName(t *testing.T) {
	dir := t.TempDir()
	res, err := InitLayer(Options{Dir: dir, Yes: true})
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if _, err := AddAgent(dir, res.Manifest, AgentOptions{Host: "frobnicate", Name: "reviewer"}); err == nil || !strings.Contains(err.Error(), "unknown host") {
		t.Fatalf("expected 'unknown host' error, got: %v", err)
	}
	if _, err := AddAgent(dir, res.Manifest, AgentOptions{Host: "codex", Name: "Bad Name"}); err == nil || !strings.Contains(err.Error(), "lowercase letters") {
		t.Fatalf("expected 'lowercase letters' error, got: %v", err)
	}
}

const manifestNoAgents = `{
  "leji": "1.0",
  "categories": {},
  "owners": {
    "primary": { "name": "x" }
  }
}
`

// BindAgentInManifestText creates the agents map in schema position.
func TestBindAgentCreatesMap(t *testing.T) {
	out, changed, err := manifest.BindAgentInManifestText(manifestNoAgents, "reviewer", "docs/agents/reviewer.md")
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Fatal("expected changed=true")
	}
	want := `{
  "leji": "1.0",
  "categories": {},
  "agents": {
    "reviewer": "docs/agents/reviewer.md"
  },
  "owners": {
    "primary": { "name": "x" }
  }
}
`
	if out != want {
		t.Fatalf("mismatch:\n%s", out)
	}
}

// BindAgentInManifestText prepends a second agent and is idempotent.
func TestBindAgentPrependsAndIdempotent(t *testing.T) {
	one, _, _ := manifest.BindAgentInManifestText(manifestNoAgents, "reviewer", "docs/agents/reviewer.md")
	two, changed, _ := manifest.BindAgentInManifestText(one, "thought-partner", "docs/agents/thought-partner.md")
	if !changed {
		t.Fatal("expected changed=true")
	}
	if !strings.Contains(two, `"agents": {`+"\n"+`    "thought-partner": "docs/agents/thought-partner.md",`+"\n"+`    "reviewer": "docs/agents/reviewer.md"`+"\n"+`  },`) {
		t.Fatalf("second agent not prepended:\n%s", two)
	}
	again, changedAgain, _ := manifest.BindAgentInManifestText(two, "reviewer", "docs/agents/reviewer.md")
	if changedAgain {
		t.Fatal("expected changed=false on already-bound name")
	}
	if again != two {
		t.Fatal("idempotent bind altered text")
	}
}

// init refuses on a dirty git working tree and writes nothing.
func TestInitRefusesOnDirtyTree(t *testing.T) {
	dir := t.TempDir()
	gitInit(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "NOTES.md"), []byte("wip\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := InitLayer(Options{Dir: dir, Yes: true})
	if err == nil {
		t.Fatal("expected a refusal on a dirty tree")
	}
	if !strings.Contains(err.Error(), "uncommitted changes") {
		t.Fatalf("expected 'uncommitted changes', got: %v", err)
	}
	if _, serr := os.Stat(filepath.Join(dir, "leji.json")); serr == nil {
		t.Fatal("nothing should be written on refusal")
	}
}

// init proceeds on a clean committed git tree.
func TestInitProceedsOnCleanTree(t *testing.T) {
	dir := t.TempDir()
	gitInit(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# repo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCommitAll(t, dir)
	res, err := InitLayer(Options{Dir: dir, Yes: true})
	if err != nil {
		t.Fatalf("init on a clean tree: %v", err)
	}
	if !contains(res.Written, "leji.json") {
		t.Fatalf("leji.json not written: %v", res.Written)
	}
}

// init --dry-run is allowed on a dirty git tree.
func TestInitDryRunAllowedOnDirtyTree(t *testing.T) {
	dir := t.TempDir()
	gitInit(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "NOTES.md"), []byte("wip\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := InitLayer(Options{Dir: dir, Yes: true, DryRun: true})
	if err != nil {
		t.Fatalf("dry-run init on a dirty tree: %v", err)
	}
	if !res.DryRun {
		t.Fatal("result.DryRun should be true")
	}
	if _, serr := os.Stat(filepath.Join(dir, "leji.json")); serr == nil {
		t.Fatal("dry-run creates no manifest")
	}
}

// init is allowed in a non-git directory (no undo net required to bootstrap).
func TestInitAllowedInNonGitDir(t *testing.T) {
	dir := t.TempDir() // not a git repo
	res, err := InitLayer(Options{Dir: dir, Yes: true})
	if err != nil {
		t.Fatalf("init in a non-git dir: %v", err)
	}
	if !contains(res.Written, "leji.json") {
		t.Fatalf("leji.json not written: %v", res.Written)
	}
}

// --- working mode (solo / team) ---

// fileTree returns every file under dir (repo-relative POSIX, .git excluded),
// with contents.
func fileTree(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		rel, rerr := filepath.Rel(dir, p)
		if rerr != nil {
			return rerr
		}
		b, rerr := os.ReadFile(p)
		if rerr != nil {
			return rerr
		}
		out[filepath.ToSlash(rel)] = string(b)
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", dir, err)
	}
	return out
}

// assertManifestCategoryOrder asserts leji.json maps exactly want, in order.
func assertManifestCategoryOrder(t *testing.T, dir string, want []string) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "leji.json"))
	if err != nil {
		t.Fatalf("read leji.json: %v", err)
	}
	load := manifest.LoadManifest(dir)
	if load.Manifest == nil {
		t.Fatal("manifest did not load")
	}
	if len(load.Manifest.Categories) != len(want) {
		t.Fatalf("categories = %v, want %v", load.Manifest.Categories, want)
	}
	last := -1
	for _, c := range want {
		if _, ok := load.Manifest.Categories[c]; !ok {
			t.Fatalf("category %q missing, got %v", c, load.Manifest.Categories)
		}
		idx := strings.Index(string(b), "\""+c+"\":")
		if idx < 0 {
			t.Fatalf("category key %q not serialized:\n%s", c, b)
		}
		if idx <= last {
			t.Fatalf("category %q out of canonical order:\n%s", c, b)
		}
		last = idx
	}
}

// init --mode solo scaffolds the identity and writing-style starters.
func TestInitModeSoloScaffoldsStarters(t *testing.T) {
	dir := t.TempDir()
	res, err := InitLayer(Options{Dir: dir, Yes: true, Mode: "solo"})
	if err != nil {
		t.Fatalf("init --mode solo: %v", err)
	}
	if res.Mode != "solo" {
		t.Fatalf("mode = %q, want solo", res.Mode)
	}
	for _, rel := range []string{"docs/domain/identity.md", "docs/practice/writing-style.md"} {
		if !contains(res.Written, rel) {
			t.Fatalf("%s not written: %v", rel, res.Written)
		}
		b, rerr := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
		if rerr != nil {
			t.Fatal(rerr)
		}
		if !strings.Contains(string(b), "## Source basis") {
			t.Fatalf("%s missing the Source basis section:\n%s", rel, b)
		}
	}
	// Solo forces domain + practice; canonical category order in the manifest.
	assertManifestCategoryOrder(t, dir, []string{"domain", "system", "practice", "decisions"})
}

// The solo boot profile routes identity and writing work by task, never preloaded.
func TestSoloBootProfileRoutesByTask(t *testing.T) {
	dir := t.TempDir()
	if _, err := InitLayer(Options{Dir: dir, Yes: true, Mode: "solo"}); err != nil {
		t.Fatalf("init --mode solo: %v", err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "docs", "boot-profile.md"))
	if err != nil {
		t.Fatal(err)
	}
	boot := string(b)
	cut := strings.Index(boot, "Load by task type")
	if cut < 0 {
		t.Fatalf("boot profile missing the task-type section:\n%s", boot)
	}
	unconditional, routed := boot[:cut], boot[cut:]
	if !strings.Contains(routed, "`docs/domain/identity.md`") {
		t.Fatalf("identity not routed by task:\n%s", routed)
	}
	if !strings.Contains(routed, "`docs/practice/writing-style.md`") {
		t.Fatalf("writing style not routed by task:\n%s", routed)
	}
	if strings.Contains(unconditional, "identity.md") {
		t.Fatalf("identity in the unconditional set:\n%s", unconditional)
	}
	if strings.Contains(unconditional, "writing-style.md") {
		t.Fatalf("writing style in the unconditional set:\n%s", unconditional)
	}
}

// The solo brief is mode-stamped and carries the interview and artifact rules.
func TestSoloBriefModeStampedWithArtifactRules(t *testing.T) {
	dir := t.TempDir()
	if _, err := InitLayer(Options{Dir: dir, Yes: true, Mode: "solo"}); err != nil {
		t.Fatalf("init --mode solo: %v", err)
	}
	b, err := os.ReadFile(filepath.Join(dir, ".leji", "work", "onboarding-brief.md"))
	if err != nil {
		t.Fatal(err)
	}
	brief := string(b)
	if !strings.Contains(brief, "**Working mode:** solo") {
		t.Fatal("brief missing the solo mode stamp")
	}
	if !strings.Contains(brief, ".leji/work/onboarding-inputs/") {
		t.Fatal("drop folder should sit in the workspace role")
	}
	if !strings.Contains(brief, "untrusted data") {
		t.Fatal("artifact consent rules missing")
	}
	if strings.Contains(brief, "<mode>") {
		t.Fatal("unreplaced mode marker")
	}
	if strings.Contains(brief, "<root>/") {
		t.Fatal("unreplaced root marker")
	}
}

// Omitted mode and explicit --mode team are byte-identical, with no solo starters.
func TestOmittedModeAndExplicitTeamIdentical(t *testing.T) {
	a := t.TempDir()
	b := t.TempDir()
	if _, err := InitLayer(Options{Dir: a, Yes: true, Name: "acme-context"}); err != nil {
		t.Fatalf("init (omitted mode): %v", err)
	}
	res, err := InitLayer(Options{Dir: b, Yes: true, Name: "acme-context", Mode: "team"})
	if err != nil {
		t.Fatalf("init --mode team: %v", err)
	}
	if res.Mode != "team" {
		t.Fatalf("mode = %q, want team", res.Mode)
	}
	treeA, treeB := fileTree(t, a), fileTree(t, b)
	if len(treeA) != len(treeB) {
		t.Fatalf("file sets differ: %d vs %d files", len(treeA), len(treeB))
	}
	// The scaffold now writes a context index at every level, and its `generatedAt`
	// is wall-clock: two runs a millisecond apart differ there and nowhere else.
	// Null it the way the cross-SDK parity harness does, so this stays a byte
	// comparison of everything the two modes actually control.
	generatedAt := regexp.MustCompile(`("generatedAt": ")[^"]*"`)
	stable := func(rel, content string) string {
		if strings.HasSuffix(rel, "context-index.json") {
			return generatedAt.ReplaceAllString(content, `${1}<GENERATED_AT>"`)
		}
		return content
	}
	for rel, content := range treeA {
		got, ok := treeB[rel]
		if !ok {
			t.Fatalf("%s missing from the explicit-team tree", rel)
		}
		if stable(rel, got) != stable(rel, content) {
			t.Fatalf("%s differs between omitted and explicit team", rel)
		}
	}
	if _, serr := os.Stat(filepath.Join(a, "docs", "domain", "identity.md")); !os.IsNotExist(serr) {
		t.Fatalf("team scaffolds no identity starter, stat err: %v", serr)
	}
	brief, err := os.ReadFile(filepath.Join(a, ".leji", "work", "onboarding-brief.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(brief), "**Working mode:** team") {
		t.Fatal("team brief missing a concrete mode stamp")
	}
}

// An invalid mode fails before any filesystem mutation.
func TestInvalidModeFailsBeforeAnyWrite(t *testing.T) {
	dir := t.TempDir()
	// Direct SDK callers can pass arbitrary strings; validation happens pre-write.
	_, err := InitLayer(Options{Dir: dir, Yes: true, Mode: "squad"})
	if err == nil || !strings.Contains(err.Error(), "--mode must be solo or team") {
		t.Fatalf("expected the mode validation error, got: %v", err)
	}
	entries, rerr := os.ReadDir(dir)
	if rerr != nil {
		t.Fatal(rerr)
	}
	if len(entries) != 0 {
		t.Fatalf("nothing should be written, got %d entries", len(entries))
	}
}

// init --mode solo --dry-run writes nothing and plans both starters.
func TestInitSoloDryRunPlansStarters(t *testing.T) {
	dir := t.TempDir()
	res, err := InitLayer(Options{Dir: dir, Yes: true, Mode: "solo", DryRun: true})
	if err != nil {
		t.Fatalf("solo dry-run init: %v", err)
	}
	if !res.DryRun {
		t.Fatal("result.DryRun should be true")
	}
	if res.Mode != "solo" {
		t.Fatalf("mode = %q, want solo", res.Mode)
	}
	if len(res.Written) != 0 {
		t.Fatalf("dry-run wrote files: %v", res.Written)
	}
	entries, rerr := os.ReadDir(dir)
	if rerr != nil {
		t.Fatal(rerr)
	}
	if len(entries) != 0 {
		t.Fatalf("dry-run touches nothing, got %d entries", len(entries))
	}
	var creates []string
	for _, e := range res.Plan {
		if e.Status == writeplan.Create {
			creates = append(creates, e.Rel)
		}
	}
	if !contains(creates, "docs/domain/identity.md") || !contains(creates, "docs/practice/writing-style.md") {
		t.Fatalf("plan should create both starters, got %v", creates)
	}
}

// Indexed solo init seeds the changelog with the starters and no dot-paths.
func TestIndexedSoloChangelogSeedsStartersNoDotPaths(t *testing.T) {
	dir := t.TempDir()
	if _, err := InitLayer(Options{Dir: dir, Yes: true, Mode: "solo", Level: "indexed"}); err != nil {
		t.Fatalf("indexed solo init: %v", err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "docs", "context-changelog.json"))
	if err != nil {
		t.Fatal(err)
	}
	var log struct {
		Entries []struct {
			Paths []string `json:"paths"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(b, &log); err != nil {
		t.Fatalf("parse changelog: %v", err)
	}
	if len(log.Entries) == 0 {
		t.Fatal("changelog has no entries")
	}
	paths := log.Entries[0].Paths
	if !contains(paths, "docs/domain/identity.md") || !contains(paths, "docs/practice/writing-style.md") {
		t.Fatalf("starters not seeded: %v", paths)
	}
	for _, p := range paths {
		for _, seg := range strings.Split(p, "/") {
			if strings.HasPrefix(seg, ".") {
				t.Fatalf("dot-path %q must never seed the machine changelog", p)
			}
		}
	}
}

// adopt --mode solo scaffolds the starters and maps practice.
func TestAdoptModeSoloScaffoldsStarters(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "docs", "notes.md"), []byte("# Notes\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true, Mode: "solo"})
	if err != nil {
		t.Fatalf("adopt --mode solo: %v", err)
	}
	if res.Mode != "solo" {
		t.Fatalf("mode = %q, want solo", res.Mode)
	}
	if !contains(res.Written, "docs/domain/identity.md") || !contains(res.Written, "docs/practice/writing-style.md") {
		t.Fatalf("starters not written: %v", res.Written)
	}
	assertManifestCategoryOrder(t, dir, []string{"domain", "system", "practice", "decisions"})
}

// adopt --mode solo never overwrites an existing identity or writing-style doc.
func TestAdoptSoloNeverOverwritesExistingStarter(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "docs", "domain", "identity.md"), "# Mine already\n")
	res, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true, Mode: "solo"})
	if err != nil {
		t.Fatalf("adopt --mode solo: %v", err)
	}
	b, rerr := os.ReadFile(filepath.Join(dir, "docs", "domain", "identity.md"))
	if rerr != nil {
		t.Fatal(rerr)
	}
	if string(b) != "# Mine already\n" {
		t.Fatalf("existing identity.md was overwritten: %q", b)
	}
	if contains(res.Written, "docs/domain/identity.md") {
		t.Fatalf("existing file should be skipped, not written: %v", res.Written)
	}
	var planned *writeplan.PlanEntry
	for i := range res.Plan {
		if res.Plan[i].Rel == "docs/domain/identity.md" {
			planned = &res.Plan[i]
		}
	}
	if planned == nil || planned.Status != writeplan.SkipExists {
		t.Fatalf("identity.md should plan as skip-exists, got %+v", planned)
	}
}

// adopt --mode solo --dry-run writes nothing and plans the starters.
func TestAdoptSoloDryRunPlansStarters(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "docs", "notes.md"), []byte("# Notes\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true, Mode: "solo", DryRun: true})
	if err != nil {
		t.Fatalf("solo dry-run adopt: %v", err)
	}
	if !res.DryRun {
		t.Fatal("result.DryRun should be true")
	}
	if len(res.Written) != 0 {
		t.Fatalf("dry-run wrote files: %v", res.Written)
	}
	if _, serr := os.Stat(filepath.Join(dir, "leji.json")); serr == nil {
		t.Fatal("dry-run creates no manifest")
	}
	var creates []string
	for _, e := range res.Plan {
		if e.Status == writeplan.Create {
			creates = append(creates, e.Rel)
		}
	}
	if !contains(creates, "docs/domain/identity.md") || !contains(creates, "docs/practice/writing-style.md") {
		t.Fatalf("plan should create both starters, got %v", creates)
	}
}

// init refuses while files under .leji/ are tracked by git, leaving the tree untouched.
func TestInitRefusesTrackedLejiWorkspace(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	dir := t.TempDir()
	gitInit(t, dir)
	mustWrite(t, filepath.Join(dir, ".leji", "work", "stale.md"), "tracked artifact\n")
	gitCommitAll(t, dir)

	_, err := InitLayer(Options{Dir: dir, Yes: true, Mode: "solo"})
	if err == nil || !strings.Contains(err.Error(), "1 file(s) under .leji/ are tracked by git") {
		t.Fatalf("expected the tracked-workspace refusal, got: %v", err)
	}
	if _, serr := os.Stat(filepath.Join(dir, "leji.json")); serr == nil {
		t.Fatal("no scaffold should be written")
	}
	if _, serr := os.Stat(filepath.Join(dir, ".gitignore")); serr == nil {
		t.Fatal("not even the ignore file should be written")
	}
}

// adopt refuses on a dirty git working tree.
func TestAdoptRefusesOnDirtyTree(t *testing.T) {
	dir := t.TempDir()
	gitInit(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "NOTES.md"), []byte("wip\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true})
	if err == nil {
		t.Fatal("expected a refusal on a dirty tree")
	}
	if !strings.Contains(err.Error(), "uncommitted changes") {
		t.Fatalf("expected 'uncommitted changes', got: %v", err)
	}
}
