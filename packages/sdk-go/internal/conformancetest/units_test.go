package conformancetest

// Go equivalents of units.test.ts / sdk.test.ts / run.test.ts: the parts the
// shared fixtures do not exercise (index gen/check, freshness, conformance
// scoring, changelog append-only against git, viewer, init).

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/conformance"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/freshness"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/indexgen"
	initcmd "github.com/leji-org/leji/packages/sdk-go/internal/commands/init"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/validate"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/viewer"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

func repoRoot(t *testing.T) string {
	t.Helper()
	wd, _ := os.Getwd()
	return filepath.Join(wd, "..", "..", "..", "..")
}

func exampleDir(t *testing.T) string {
	return filepath.Join(repoRoot(t), "examples", "monorepo")
}

func copyTree(t *testing.T, src string) string {
	t.Helper()
	dst := t.TempDir()
	cmd := exec.Command("cp", "-r", src+"/.", dst)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("cp failed: %v: %s", err, out)
	}
	return dst
}

func hasRule(fs []findings.Finding, rule string) bool {
	for _, f := range fs {
		if f.Rule == rule {
			return true
		}
	}
	return false
}

func loadM(t *testing.T, dir string) *manifest.Manifest {
	t.Helper()
	m := manifest.LoadManifest(dir).Manifest
	if m == nil {
		t.Fatalf("manifest failed to load in %s", dir)
	}
	return m
}

func mustWriteIndex(t *testing.T, dir string, m *manifest.Manifest) indexgen.Result {
	t.Helper()
	result, err := indexgen.WriteIndex(dir, m)
	if err != nil {
		t.Fatalf("WriteIndex: %v", err)
	}
	return result
}

func TestExampleValidatesClean(t *testing.T) {
	result := validate.ValidateLayer(exampleDir(t), false)
	for _, f := range result.Findings {
		if f.Severity == findings.Error {
			t.Fatalf("unexpected error finding: %s %s", f.Rule, f.Message)
		}
	}
}

func TestIndexRoundTripCurrent(t *testing.T) {
	dir := copyTree(t, exampleDir(t))
	m := loadM(t, dir)
	mustWriteIndex(t, dir, m)
	check := indexgen.CheckIndex(dir, m)
	if check.Stale == nil || *check.Stale {
		t.Fatalf("expected fresh index, stale=%v", check.Stale)
	}
}

func TestIndexGoesStaleOnEdit(t *testing.T) {
	dir := copyTree(t, exampleDir(t))
	m := loadM(t, dir)
	mustWriteIndex(t, dir, m)
	f := filepath.Join(dir, "docs", "domain", "glossary.md")
	b, _ := os.ReadFile(f)
	os.WriteFile(f, append(b, []byte("\n- **Refund**: a reversal.\n")...), 0o644)
	check := indexgen.CheckIndex(dir, m)
	if check.Stale == nil || !*check.Stale {
		t.Fatal("expected stale index")
	}
	if !hasRule(check.Findings, "index-stale") {
		t.Fatal("expected index-stale finding")
	}
}

func TestIndexIDStableAcrossMove(t *testing.T) {
	dir := copyTree(t, exampleDir(t))
	m := loadM(t, dir)
	mustWriteIndex(t, dir, m)
	os.Rename(filepath.Join(dir, "docs", "domain", "glossary.md"),
		filepath.Join(dir, "docs", "domain", "terms.md"))
	result := mustWriteIndex(t, dir, m)
	var moved *indexgen.IndexEntry
	for i := range result.Index.Entries {
		if result.Index.Entries[i].Path == "docs/domain/terms.md" {
			moved = &result.Index.Entries[i]
		}
	}
	if moved == nil || moved.ID != "glossary" {
		t.Fatalf("expected moved id glossary, got %v", moved)
	}
}

func TestGeneratedIndexContentExact(t *testing.T) {
	dir := copyTree(t, exampleDir(t))
	m := loadM(t, dir)
	result := mustWriteIndex(t, dir, m)
	got := result.Index.Entries
	if len(got) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(got))
	}
	type want struct {
		id, path, title, category, summary, fresh string
	}
	wants := []want{
		{"adopt-leji", "docs/decisions/0001-adopt-leji.md", "Adopt the Leji context layer", "decisions", "", ""},
		{"glossary", "docs/domain/glossary.md", "Glossary", "domain", "What invoice, credit note, and settlement mean at Acme.", ""},
		{"system-invariants", "docs/system/invariants.md", "System Invariants", "system", "Money handling, ledger append-only rule, service boundaries.", "2026-12-10"},
	}
	for i, w := range wants {
		e := got[i]
		if e.ID != w.id || e.Path != w.path || e.Title != w.title || e.Category != w.category || e.Summary != w.summary {
			t.Fatalf("entry %d mismatch: %+v vs %+v", i, e, w)
		}
		if w.fresh != "" && (e.Freshness == nil || e.Freshness.ReviewAfter != w.fresh) {
			t.Fatalf("entry %d freshness mismatch: %+v", i, e.Freshness)
		}
	}
}

func TestFreshnessExpired(t *testing.T) {
	dir := copyTree(t, exampleDir(t))
	inv := filepath.Join(dir, "docs", "system", "invariants.md")
	b, _ := os.ReadFile(inv)
	os.WriteFile(inv, []byte(replace(string(b), "reviewAfter: 2026-12-10", "reviewAfter: 2020-01-01")), 0o644)
	m := loadM(t, dir)
	report := freshness.FreshnessReport(dir, m, false)
	if len(report.Expired) != 1 {
		t.Fatalf("expected 1 expired, got %d", len(report.Expired))
	}
	if report.Findings[0].Rule != "freshness-expired" || report.Findings[0].Severity != findings.Warning {
		t.Fatalf("expected freshness-expired warning, got %+v", report.Findings[0])
	}
	strict := freshness.FreshnessReport(dir, m, true)
	if strict.Findings[0].Severity != findings.Error {
		t.Fatal("expected error under strict")
	}
}

func TestConformanceOverClaimFails(t *testing.T) {
	dir := copyTree(t, exampleDir(t))
	mp := filepath.Join(dir, "leji.json")
	b, _ := os.ReadFile(mp)
	os.WriteFile(mp, []byte(replace(string(b), `"claimedLevel": "indexed"`, `"claimedLevel": "governed"`)), 0o644)
	inv := filepath.Join(dir, "docs", "system", "invariants.md")
	ib, _ := os.ReadFile(inv)
	os.WriteFile(inv, []byte(replace(string(ib), "freshness:\n  reviewAfter: 2026-12-10\n", "")), 0o644)
	m := loadM(t, dir)
	mustWriteIndex(t, dir, m)
	result := conformance.Report(dir)
	if result.VerifiedLevel != "indexed" {
		t.Fatalf("expected verified indexed, got %q", result.VerifiedLevel)
	}
	if !hasRule(result.Findings, "conformance-claim") {
		t.Fatal("expected conformance-claim finding")
	}
}

func TestGovernedVerifiesWithProfiles(t *testing.T) {
	dir := copyTree(t, exampleDir(t))
	mp := filepath.Join(dir, "leji.json")
	b, _ := os.ReadFile(mp)
	os.WriteFile(mp, []byte(replace(string(b), `"claimedLevel": "indexed"`, `"claimedLevel": "governed"`)), 0o644)
	m := loadM(t, dir)
	mustWriteIndex(t, dir, m)
	result := conformance.Report(dir)
	if result.VerifiedLevel != "governed" {
		t.Fatalf("expected governed, got %q", result.VerifiedLevel)
	}
	if len(result.Findings) != 0 {
		t.Fatalf("expected no findings, got %v", result.Findings)
	}
}

func TestViewerGeneratesSidebar(t *testing.T) {
	dir := copyTree(t, exampleDir(t))
	m := loadM(t, dir)
	result, err := viewer.GenerateViewer(dir, m)
	if err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	wantWritten := []string{
		"docs/.leji/viewer/index.html",
		"docs/.leji/viewer/_sidebar.md",
		"docs/.leji/viewer/assets/docsify-copy-code.min.js",
		"docs/.leji/viewer/assets/docsify-mermaid.js",
		"docs/.leji/viewer/assets/docsify-sidebar-collapse.min.css",
		"docs/.leji/viewer/assets/docsify-sidebar-collapse.min.js",
		"docs/.leji/viewer/assets/docsify.min.js",
		"docs/.leji/viewer/assets/leji-logo.svg",
		"docs/.leji/viewer/assets/mermaid.min.js",
		"docs/.leji/viewer/assets/prism-bash.min.js",
		"docs/.leji/viewer/assets/prism-json.min.js",
		"docs/.leji/viewer/assets/prism-markdown.min.js",
		"docs/.leji/viewer/assets/prism-typescript.min.js",
		"docs/.leji/viewer/assets/search.min.js",
		"docs/.leji/viewer/assets/viewer-boot.js",
		"docs/.leji/viewer/assets/vue.css",
		"docs/.leji/viewer/assets/zoom-image.min.js",
		"docs/overview.md",
	}
	if len(result.Written) != len(wantWritten) {
		t.Fatalf("unexpected written: %v", result.Written)
	}
	for i, w := range wantWritten {
		if result.Written[i] != w {
			t.Fatalf("unexpected written: %v", result.Written)
		}
	}
	// Mermaid is on by default: the two scripts + their assets are present.
	page0, _ := os.ReadFile(filepath.Join(dir, "docs", ".leji", "viewer", "index.html"))
	for _, want := range []string{"assets/mermaid.min.js", "assets/docsify-mermaid.js"} {
		if !strings.Contains(string(page0), want) {
			t.Fatalf("expected mermaid wired into index.html by default: %q", want)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "docs", ".leji", "viewer", "assets", "mermaid.min.js")); err != nil {
		t.Fatalf("expected mermaid asset copied by default: %v", err)
	}
	bootJS, _ := os.ReadFile(filepath.Join(dir, "docs", ".leji", "viewer", "assets", "viewer-boot.js"))
	if !strings.Contains(string(bootJS), "basePath: '/content/'") {
		t.Fatalf("expected content mount in the boot script, got: %q", bootJS)
	}
	// Default theming: the Leji mark (in the name HTML, served relative to the page
	// so basePath does not break it) and the brand blue, plus the layer name/title.
	page, _ := os.ReadFile(filepath.Join(dir, "docs", ".leji", "viewer", "index.html"))
	for _, want := range []string{
		"/assets/leji-logo.svg",
		"\"themeColor\":\"#223F93\"",
		"acme-billing-context",
		"<title>acme-billing-context</title>",
	} {
		if !strings.Contains(string(page), want) {
			t.Fatalf("expected index.html to contain %q", want)
		}
	}
	sidebar, _ := os.ReadFile(filepath.Join(dir, "docs", ".leji", "viewer", "_sidebar.md"))
	want := "- [🤖 Boot profile](boot-profile.md)\n\n---\n\n" +
		"- 📖 Domain\n  - [Glossary](domain/glossary.md)\n" +
		"- ⚙️ System\n  - [System Invariants](system/invariants.md)\n" +
		"- 🧭 Decisions\n  - [Adopt the Leji context layer](decisions/0001-adopt-leji.md)\n"
	if string(sidebar) != want {
		t.Fatalf("sidebar mismatch:\n got=%q\nwant=%q", sidebar, want)
	}
}

func TestViewerThemeOverrides(t *testing.T) {
	dir := copyTree(t, exampleDir(t))
	m := loadM(t, dir)
	m.Viewer = &manifest.Viewer{
		Logo:           "assets/brand.svg",
		Theme:          &manifest.Theme{Primary: "#FF6600"},
		CategoryEmojis: map[string]string{"domain": "💰"},
	}
	if _, err := viewer.GenerateViewer(dir, m); err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	page, _ := os.ReadFile(filepath.Join(dir, "docs", ".leji", "viewer", "index.html"))
	// A relative logo path is served from the content mount; the configured primary wins.
	for _, want := range []string{"/content/assets/brand.svg", "\"themeColor\":\"#FF6600\""} {
		if !strings.Contains(string(page), want) {
			t.Fatalf("expected index.html to contain %q", want)
		}
	}
	sidebar, _ := os.ReadFile(filepath.Join(dir, "docs", ".leji", "viewer", "_sidebar.md"))
	if !strings.Contains(string(sidebar), "- 💰 Domain") {
		t.Fatalf("expected overridden domain emoji, got: %q", sidebar)
	}
	if !strings.Contains(string(sidebar), "- ⚙️ System") {
		t.Fatalf("expected default system emoji, got: %q", sidebar)
	}
}

func TestViewerMermaidDisabled(t *testing.T) {
	dir := copyTree(t, exampleDir(t))
	m := loadM(t, dir)
	disabled := false
	m.Viewer = &manifest.Viewer{Mermaid: &disabled}
	result, err := viewer.GenerateViewer(dir, m)
	if err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	page, _ := os.ReadFile(filepath.Join(dir, "docs", ".leji", "viewer", "index.html"))
	if strings.Contains(string(page), "mermaid.min.js") {
		t.Fatal("expected no mermaid script when disabled")
	}
	if strings.Contains(string(page), "docsify-mermaid.js") {
		t.Fatal("expected no mermaid plugin when disabled")
	}
	if _, err := os.Stat(filepath.Join(dir, "docs", ".leji", "viewer", "assets", "mermaid.min.js")); err == nil {
		t.Fatal("expected mermaid asset not copied when disabled")
	}
	for _, w := range result.Written {
		if strings.Contains(w, "mermaid") {
			t.Fatalf("expected no mermaid entry in written, got %q", w)
		}
	}
	// The non-mermaid polish plugins still ship.
	if !strings.Contains(string(page), "docsify-copy-code.min.js") {
		t.Fatal("expected copy-code still wired when mermaid is off")
	}
}

func TestInitYesValidatesCleanCore(t *testing.T) {
	dir := t.TempDir()
	result, err := initcmd.InitLayer(initcmd.Options{Dir: dir, Yes: true})
	if err != nil {
		t.Fatal(err)
	}
	if !containsStr(result.Written, "leji.json") {
		t.Fatal("leji.json not written")
	}
	// init does not `git init`, so a freshly scaffolded layer in a bare temp dir
	// carries exactly the not-in-git warning; its content is otherwise clean.
	v := validate.ValidateLayer(dir, false)
	for _, f := range v.Findings {
		if f.Rule != "git-required" {
			t.Fatalf("expected only git-required, got %v", v.Findings)
		}
	}
	if len(v.Findings) != 1 {
		t.Fatalf("expected exactly one git-required finding, got %v", v.Findings)
	}
}

func TestInitIndexedVerifiesImmediately(t *testing.T) {
	dir := t.TempDir()
	if _, err := initcmd.InitLayer(initcmd.Options{Dir: dir, Yes: true, Level: "indexed", Name: "acme-context"}); err != nil {
		t.Fatal(err)
	}
	v := validate.ValidateLayer(dir, false)
	for _, f := range v.Findings {
		if f.Severity == findings.Error {
			t.Fatalf("unexpected error: %s", f.Rule)
		}
	}
	c := conformance.Report(dir)
	if c.ClaimedLevel != "indexed" || c.VerifiedLevel != "indexed" {
		t.Fatalf("expected indexed/indexed, got %s/%s", c.ClaimedLevel, c.VerifiedLevel)
	}
}

func TestInitRefusesOverwrite(t *testing.T) {
	dir := t.TempDir()
	if _, err := initcmd.InitLayer(initcmd.Options{Dir: dir, Yes: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := initcmd.InitLayer(initcmd.Options{Dir: dir, Yes: true}); err == nil {
		t.Fatal("expected refusal error")
	}
}

func TestChangelogAppendOnlyModifiedEntry(t *testing.T) {
	dir := gitSeedExample(t)
	rel := filepath.Join("docs", "context-changelog.json")
	abs := filepath.Join(dir, rel)
	b, _ := os.ReadFile(abs)
	mod := replace(string(b), "Seeded the billing context layer.", "Rewritten history.")
	if mod == string(b) {
		// Fall back: just change the first summary value if exact text differs.
		mod = replaceFirstSummary(string(b))
	}
	os.WriteFile(abs, []byte(mod), 0o644)
	result := validate.CheckChangelogAppendOnly(dir, "docs/context-changelog.json", false)
	if !hasRule(result.Findings, "changelog-append-only") {
		t.Fatalf("expected changelog-append-only, got %v", result.Findings)
	}
}

func TestChangelogCompactionPasses(t *testing.T) {
	dir := gitSeedExample(t)
	abs := filepath.Join(dir, "docs", "context-changelog.json")
	// Drop the oldest entry and append a compaction entry covering it.
	dropOldestWithCompaction(t, abs)
	result := validate.CheckChangelogAppendOnly(dir, "docs/context-changelog.json", false)
	for _, f := range result.Findings {
		if f.Severity == findings.Error {
			t.Fatalf("unexpected error after valid compaction: %s %s", f.Rule, f.Message)
		}
	}
}

func TestChangelogReorderNotViolation(t *testing.T) {
	dir := gitSeedExample(t)
	abs := filepath.Join(dir, "docs", "context-changelog.json")
	reverseEntries(t, abs)
	result := validate.CheckChangelogAppendOnly(dir, "docs/context-changelog.json", false)
	if hasRule(result.Findings, "changelog-append-only") {
		t.Fatalf("reordering should not violate append-only: %v", result.Findings)
	}
}

// --- helpers ---

func replace(s, old, new string) string {
	out := ""
	i := 0
	for {
		j := indexOfStr(s[i:], old)
		if j < 0 {
			out += s[i:]
			break
		}
		out += s[i:i+j] + new
		i += j + len(old)
	}
	return out
}

func indexOfStr(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func containsStr(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}
