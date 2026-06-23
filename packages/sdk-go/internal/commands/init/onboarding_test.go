package initcmd

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/indexgen"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/validate"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
	"github.com/leji-org/leji/packages/sdk-go/internal/writeplan"
)

// init --dry-run writes nothing and reports the plan, including the brief as a
// create entry and an existing vendor file as wont-modify.
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
	if !contains(creates, "docs/.leji/onboarding-brief.md") {
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
	brief := filepath.Join(dir, "docs", ".leji", "onboarding-brief.md")
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
	res := validate.ValidateLayer(dir, true)
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
	res := validate.ValidateLayer(dir, false)
	for _, f := range res.Findings {
		if strings.HasPrefix(f.Rule, "content-") {
			t.Fatalf("unexpected content finding without --content: %s", f.Rule)
		}
	}
}

// a populated layer passes the content lint clean.
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

	res := validate.ValidateLayer(dir, true)
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

// init --agent no longer creates a vendor adapter; it scaffolds the layer (which
// still validates clean) and never declares vendorAdapters.
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
	v := validate.ValidateLayer(dir, false)
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

// init --agent no longer resolves a vendor adapter, so a bogus --agent no longer
// errors from adapter resolution: the layer scaffolds with no vendor file.
func TestInitAgentRejectsUnknownHost(t *testing.T) {
	dir := t.TempDir()
	res, err := InitLayer(Options{Dir: dir, Yes: true, Agent: "frobnicate"})
	if err != nil {
		t.Fatalf("init --agent should not error on a bogus agent, got: %v", err)
	}
	if !contains(res.Written, "leji.json") {
		t.Fatalf("leji.json should still be written: %v", res.Written)
	}
	load := manifest.LoadManifest(dir)
	if load.Manifest == nil {
		t.Fatal("manifest did not load")
	}
	if len(load.Manifest.VendorAdapters) != 0 {
		t.Fatalf("vendorAdapters should be empty, got %v", load.Manifest.VendorAdapters)
	}
}

// init --agent cursor no longer creates a directory-style adapter; the layer
// still scaffolds and validates clean with no vendor file.
func TestInitAgentCursorWiresDirectoryAdapter(t *testing.T) {
	dir := t.TempDir()
	if _, err := exec.LookPath("git"); err == nil {
		cmd := exec.Command("git", "init", "-q")
		cmd.Dir = dir
		if err := cmd.Run(); err != nil {
			t.Fatalf("git init: %v", err)
		}
	}
	res, err := InitLayer(Options{Dir: dir, Yes: true, Agent: "cursor"})
	if err != nil {
		t.Fatalf("init --agent cursor: %v", err)
	}
	if contains(res.Written, ".cursor/rules/leji.md") {
		t.Fatalf("cursor adapter must not be created, written: %v", res.Written)
	}
	if _, statErr := os.Stat(filepath.Join(dir, ".cursor", "rules", "leji.md")); !os.IsNotExist(statErr) {
		t.Fatalf(".cursor/rules/leji.md should not exist, stat err: %v", statErr)
	}
	load := manifest.LoadManifest(dir)
	if load.Manifest == nil {
		t.Fatal("manifest did not load")
	}
	if len(load.Manifest.VendorAdapters) != 0 {
		t.Fatalf("vendorAdapters should be empty, got %v", load.Manifest.VendorAdapters)
	}
	v := validate.ValidateLayer(dir, false)
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

// agent wires a named reviewer into an existing layer that validates clean: the
// new agent's profile and its binding. It no longer creates any vendor adapter.
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
	if _, statErr := os.Stat(filepath.Join(dir, "AGENTS.md")); !os.IsNotExist(statErr) {
		t.Fatalf("AGENTS.md should not exist, stat err: %v", statErr)
	}
	body, err := os.ReadFile(filepath.Join(dir, "docs", "agents", "reviewer.md"))
	if err != nil {
		t.Fatal(err)
	}
	reviewer := string(body)
	if !strings.Contains(reviewer, "\nid: reviewer\n") || !strings.Contains(reviewer, "\nrole: reviewer\n") || !strings.Contains(reviewer, "\nhost: codex\n") {
		t.Fatalf("reviewer profile missing id/role/host:\n%s", reviewer)
	}
	v := validate.ValidateLayer(dir, false)
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

// agent with no --host binds a host-agnostic resident agent: a profile with no
// host: frontmatter line, bound in the agents map, and no vendor file created.
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
	v := validate.ValidateLayer(dir, false)
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

// DeclareVendorAdapterInManifestText creates the array, prepends, and dedupes.
func TestDeclareVendorAdapter(t *testing.T) {
	created, changed, _ := manifest.DeclareVendorAdapterInManifestText(manifestNoAgents, "AGENTS.md")
	if !changed {
		t.Fatal("expected changed=true")
	}
	want := `{
  "leji": "1.0",
  "categories": {},
  "vendorAdapters": [
    "AGENTS.md"
  ],
  "owners": {
    "primary": { "name": "x" }
  }
}
`
	if created != want {
		t.Fatalf("mismatch:\n%s", created)
	}
	second, _, _ := manifest.DeclareVendorAdapterInManifestText(created, "CLAUDE.md")
	if !strings.Contains(second, `"vendorAdapters": [`+"\n"+`    "CLAUDE.md",`+"\n"+`    "AGENTS.md"`+"\n"+`  ],`) {
		t.Fatalf("second adapter not prepended:\n%s", second)
	}
	dupe, changedDupe, _ := manifest.DeclareVendorAdapterInManifestText(second, "AGENTS.md")
	if changedDupe {
		t.Fatal("expected changed=false on duplicate adapter")
	}
	if dupe != second {
		t.Fatal("dedupe altered text")
	}
}

// --- dirty-tree guard on init / adopt ---

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
