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

// init --agent wires a vendor redirect and the layer still validates clean.
func TestInitAgentWiresRedirect(t *testing.T) {
	dir := t.TempDir()
	res, err := InitLayer(Options{Dir: dir, Yes: true, Agent: "claude-code"})
	if err != nil {
		t.Fatalf("init --agent: %v", err)
	}
	if !contains(res.Written, "CLAUDE.md") {
		t.Fatalf("adapter should be created, written: %v", res.Written)
	}
	body, err := os.ReadFile(filepath.Join(dir, "CLAUDE.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "docs/boot-profile.md") {
		t.Fatalf("adapter redirect missing boot profile path: %q", body)
	}
	load := manifest.LoadManifest(dir)
	if load.Manifest == nil {
		t.Fatal("manifest did not load")
	}
	if len(load.Manifest.VendorAdapters) != 1 || load.Manifest.VendorAdapters[0] != "CLAUDE.md" {
		t.Fatalf("vendorAdapters = %v, want [CLAUDE.md]", load.Manifest.VendorAdapters)
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

// init --agent rejects an unknown host.
func TestInitAgentRejectsUnknownHost(t *testing.T) {
	dir := t.TempDir()
	_, err := InitLayer(Options{Dir: dir, Yes: true, Agent: "frobnicate"})
	if err == nil {
		t.Fatal("expected an error for an unknown agent")
	}
	if !strings.Contains(err.Error(), "unknown agent") {
		t.Fatalf("expected 'unknown agent' error, got: %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "leji.json")); statErr == nil {
		t.Fatal("a rejected agent should not have written leji.json")
	}
}

// init --agent cursor wires a directory-style adapter that validates clean.
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
	if !contains(res.Written, ".cursor/rules/leji.md") {
		t.Fatalf("cursor adapter should be created, written: %v", res.Written)
	}
	body, err := os.ReadFile(filepath.Join(dir, ".cursor", "rules", "leji.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "docs/boot-profile.md") {
		t.Fatalf("adapter redirect missing boot profile path: %q", body)
	}
	load := manifest.LoadManifest(dir)
	if load.Manifest == nil {
		t.Fatal("manifest did not load")
	}
	if len(load.Manifest.VendorAdapters) != 1 || load.Manifest.VendorAdapters[0] != ".cursor/rules/leji.md" {
		t.Fatalf("vendorAdapters = %v, want [.cursor/rules/leji.md]", load.Manifest.VendorAdapters)
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

// init --ci writes a GitHub Actions validation workflow.
func TestInitCiWritesWorkflow(t *testing.T) {
	dir := t.TempDir()
	res, err := InitLayer(Options{Dir: dir, Yes: true, Ci: true})
	if err != nil {
		t.Fatalf("init --ci: %v", err)
	}
	if !contains(res.Written, ".github/workflows/leji.yml") {
		t.Fatalf("workflow should be created, written: %v", res.Written)
	}
	body, err := os.ReadFile(filepath.Join(dir, ".github", "workflows", "leji.yml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "leji@latest validate") {
		t.Fatalf("workflow missing validate run: %q", body)
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

// init --agent + --reviewer wires a multi-agent setup that validates clean:
// the primary adapter, the reviewer role binding, and the reviewer's adapter.
func TestInitAgentAndReviewerWiresMultiAgent(t *testing.T) {
	dir := t.TempDir()
	if _, err := exec.LookPath("git"); err == nil {
		cmd := exec.Command("git", "init", "-q")
		cmd.Dir = dir
		if err := cmd.Run(); err != nil {
			t.Fatalf("git init: %v", err)
		}
	}
	res, err := InitLayer(Options{Dir: dir, Yes: true, Agent: "claude-code", Reviewer: "codex"})
	if err != nil {
		t.Fatalf("init --agent --reviewer: %v", err)
	}
	load := manifest.LoadManifest(dir)
	if load.Manifest == nil {
		t.Fatal("manifest did not load")
	}
	// Primary adapter + reviewer role binding + reviewer adapter.
	if load.Manifest.Agents["reviewer"] != "docs/agents/reviewer.md" {
		t.Fatalf("agents.reviewer = %q, want docs/agents/reviewer.md", load.Manifest.Agents["reviewer"])
	}
	if !contains(load.Manifest.VendorAdapters, "CLAUDE.md") {
		t.Fatalf("vendorAdapters missing CLAUDE.md: %v", load.Manifest.VendorAdapters)
	}
	if !contains(load.Manifest.VendorAdapters, "AGENTS.md") {
		t.Fatalf("vendorAdapters missing AGENTS.md: %v", load.Manifest.VendorAdapters)
	}
	body, err := os.ReadFile(filepath.Join(dir, "docs", "agents", "reviewer.md"))
	if err != nil {
		t.Fatal(err)
	}
	reviewer := string(body)
	if !strings.Contains(reviewer, "\nrole: reviewer\n") {
		t.Fatalf("reviewer profile missing role: reviewer:\n%s", reviewer)
	}
	if !strings.Contains(reviewer, "\nhost: codex\n") {
		t.Fatalf("reviewer profile missing host: codex:\n%s", reviewer)
	}
	if !contains(res.Written, "docs/agents/reviewer.md") {
		t.Fatalf("reviewer profile not in written: %v", res.Written)
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

// init --reviewer rejects an unknown host.
func TestInitReviewerRejectsUnknownHost(t *testing.T) {
	dir := t.TempDir()
	_, err := InitLayer(Options{Dir: dir, Yes: true, Reviewer: "frobnicate"})
	if err == nil {
		t.Fatal("expected an error for an unknown reviewer host")
	}
	if !strings.Contains(err.Error(), "unknown agent") {
		t.Fatalf("expected 'unknown agent' error, got: %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "leji.json")); statErr == nil {
		t.Fatal("a rejected reviewer should not have written leji.json")
	}
}
