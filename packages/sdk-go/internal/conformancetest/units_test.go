package conformancetest

// Go equivalents of units.test.ts / sdk.test.ts / run.test.ts: the parts the
// shared fixtures do not exercise (index, freshness, conformance, changelog,
// viewer, init).

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/changelog"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/conformance"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/freshness"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/indexgen"
	initcmd "github.com/leji-org/leji/packages/sdk-go/internal/commands/init"
	statuscmd "github.com/leji-org/leji/packages/sdk-go/internal/commands/status"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/validate"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/viewer"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/layer"
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
	// Conformance evaluates the directory it is given, so a layer outside a git
	// repository fails core's git requirement. Any test asserting a verified level
	// has to run somewhere git can answer.
	gitInit(t, dst)
	gitCommitAll(t, dst)
	return dst
}

func gitInit(t *testing.T, dir string) {
	t.Helper()
	for _, args := range [][]string{
		{"init", "-q"},
		{"config", "user.email", "test@example.com"},
		{"config", "user.name", "Test"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v failed: %v: %s", args, err, out)
		}
	}
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
	result := validateLayer(t, exampleDir(t), false)
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
	check := checkIndex(t, dir, m)
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
	check := checkIndex(t, dir, m)
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
		id, path, title, category, kind, date, summary, fresh string
	}
	wants := []want{
		{"adopt-leji", "docs/decisions/0001-adopt-leji.md", "Adopt the Leji context layer", "decisions", "record", "2026-06-10", "", ""},
		{"glossary", "docs/domain/glossary.md", "Glossary", "domain", "intent", "", "What invoice, credit note, and settlement mean at Acme.", ""},
		{"system-invariants", "docs/system/invariants.md", "System Invariants", "system", "intent", "", "Money handling, ledger append-only rule, service boundaries.", "2026-12-10"},
	}
	for i, w := range wants {
		e := got[i]
		if e.ID != w.id || e.Path != w.path || e.Title != w.title || e.Category != w.category || e.Summary != w.summary {
			t.Fatalf("entry %d mismatch: %+v vs %+v", i, e, w)
		}
		if e.Kind != w.kind || e.Date != w.date {
			t.Fatalf("entry %d kind/date mismatch: got %s/%q want %s/%q", i, e.Kind, e.Date, w.kind, w.date)
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
	result, err := conformance.Report(dir, false)
	if err != nil {
		t.Fatalf("conformance: %v", err)
	}
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
	result, err := conformance.Report(dir, false)
	if err != nil {
		t.Fatalf("conformance: %v", err)
	}
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
		".leji/viewer/index.html",
		".leji/viewer/_sidebar.md",
		".leji/viewer/assets/docsify-copy-code.min.js",
		".leji/viewer/assets/docsify-mermaid.js",
		".leji/viewer/assets/docsify-sidebar-collapse.min.css",
		".leji/viewer/assets/docsify-sidebar-collapse.min.js",
		".leji/viewer/assets/docsify.min.js",
		".leji/viewer/assets/leji-logo.svg",
		".leji/viewer/assets/mermaid.min.js",
		".leji/viewer/assets/prism-bash.min.js",
		".leji/viewer/assets/prism-json.min.js",
		".leji/viewer/assets/prism-markdown.min.js",
		".leji/viewer/assets/prism-typescript.min.js",
		".leji/viewer/assets/roboto-mono-400-latin-ext.woff2",
		".leji/viewer/assets/roboto-mono-400-latin.woff2",
		".leji/viewer/assets/roboto-mono-400-vietnamese.woff2",
		".leji/viewer/assets/search.min.js",
		".leji/viewer/assets/source-sans-pro-300-latin-ext.woff2",
		".leji/viewer/assets/source-sans-pro-300-latin.woff2",
		".leji/viewer/assets/source-sans-pro-300-vietnamese.woff2",
		".leji/viewer/assets/source-sans-pro-400-latin-ext.woff2",
		".leji/viewer/assets/source-sans-pro-400-latin.woff2",
		".leji/viewer/assets/source-sans-pro-400-vietnamese.woff2",
		".leji/viewer/assets/source-sans-pro-600-latin-ext.woff2",
		".leji/viewer/assets/source-sans-pro-600-latin.woff2",
		".leji/viewer/assets/source-sans-pro-600-vietnamese.woff2",
		".leji/viewer/assets/theme-init.js",
		".leji/viewer/assets/third-party-licenses.txt",
		".leji/viewer/assets/viewer-boot.js",
		".leji/viewer/assets/vue.css",
		".leji/viewer/assets/zoom-image.min.js",
		"docs/overview.md",
		".leji/viewer/_manifest.md",
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
	page0, _ := os.ReadFile(filepath.Join(dir, ".leji", "viewer", "index.html"))
	for _, want := range []string{"assets/mermaid.min.js", "assets/docsify-mermaid.js"} {
		if !strings.Contains(string(page0), want) {
			t.Fatalf("expected mermaid wired into index.html by default: %q", want)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, ".leji", "viewer", "assets", "mermaid.min.js")); err != nil {
		t.Fatalf("expected mermaid asset copied by default: %v", err)
	}
	// The content mount is the SDK's value, carried in the config block; the boot
	// script routes from it instead of hardcoding a root, which is what lets the
	// export flavor be relative.
	bootJS, _ := os.ReadFile(filepath.Join(dir, ".leji", "viewer", "assets", "viewer-boot.js"))
	if !strings.Contains(string(bootJS), "basePath: lejiContentBase") {
		t.Fatalf("expected the boot script to route from the generated base, got: %q", bootJS)
	}
	if !strings.Contains(string(page0), `"basePath":"/content/"`) {
		t.Fatal("expected the served flavor to mount content at the app root")
	}
	// Default theming: the Leji mark (in the name HTML, served relative to the page
	// so basePath does not break it), brand green with the mermaid node-text color
	// the SDK computed for it (dark, at 5.14:1 against the accent), and the layer
	// name/title.
	page, _ := os.ReadFile(filepath.Join(dir, ".leji", "viewer", "index.html"))
	for _, want := range []string{
		"/assets/leji-logo.svg",
		"\"themeColor\":\"#009F71\"",
		"\"lejiMermaidTextColor\":\"#1a1a1a\"",
		"acme-billing-context",
		"<title>acme-billing-context</title>",
	} {
		if !strings.Contains(string(page), want) {
			t.Fatalf("expected index.html to contain %q", want)
		}
	}
	// A configured accent is computed over too, not just the default: a dark accent
	// flips the mermaid node text to white, end to end through the generator.
	darkDir := copyTree(t, exampleDir(t))
	darkM := loadM(t, darkDir)
	darkM.Viewer = &manifest.Viewer{Theme: &manifest.Theme{Primary: "#164E42"}}
	if _, err := viewer.GenerateViewer(darkDir, darkM); err != nil {
		t.Fatalf("GenerateViewer (configured accent): %v", err)
	}
	darkPage, _ := os.ReadFile(filepath.Join(darkDir, ".leji", "viewer", "index.html"))
	for _, want := range []string{
		"\"themeColor\":\"#164E42\"",
		"\"lejiMermaidTextColor\":\"#ffffff\"",
	} {
		if !strings.Contains(string(darkPage), want) {
			t.Fatalf("expected index.html to contain %q", want)
		}
	}
	sidebar, _ := os.ReadFile(filepath.Join(dir, ".leji", "viewer", "_sidebar.md"))
	want := "- [🤖 Boot profile](/boot-profile.md)\n- [📄 Manifest](/_manifest.md)\n\n---\n\n" +
		"- **🤖 Agents**\n  - [Agent Core](/agents/core.md)\n  - [Thought Partner (Codex)](/agents/thought-partner.md)\n" +
		"- **📖 Domain**\n  - [Glossary](/domain/glossary.md)\n" +
		"- **⚙️ System**\n  - [Invariants](/system/invariants.md)\n" +
		"- **🧭 Decisions**\n  - [Adopt the Leji context layer](/decisions/0001-adopt-leji.md)\n"
	if string(sidebar) != want {
		t.Fatalf("sidebar mismatch:\n got=%q\nwant=%q", sidebar, want)
	}
	// Deterministic: regeneration is byte-identical.
	if _, err := viewer.GenerateViewer(dir, m); err != nil {
		t.Fatalf("GenerateViewer (regen): %v", err)
	}
	again, _ := os.ReadFile(filepath.Join(dir, ".leji", "viewer", "_sidebar.md"))
	if string(again) != want {
		t.Fatalf("regenerated sidebar diverged:\n got=%q\nwant=%q", again, want)
	}
}

func TestViewerBrandConfig(t *testing.T) {
	dir := copyTree(t, exampleDir(t))
	m := loadM(t, dir)
	m.Viewer = &manifest.Viewer{
		Logo:    "assets/brand.svg",
		Theme:   &manifest.Theme{Primary: "#FF6600"},
		Title:   "Acme Billing",
		Favicon: "assets/icon.svg",
		Pins:    []manifest.ViewerPin{{Path: "docs/domain/glossary.md"}, {Path: "docs/nope.md"}},
	}
	result, err := viewer.GenerateViewer(dir, m)
	if err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	page, _ := os.ReadFile(filepath.Join(dir, ".leji", "viewer", "index.html"))
	// A relative logo path is served from the content mount; absolute/url is used as-is.
	for _, want := range []string{
		"/content/assets/brand.svg",
		"\"themeColor\":\"#FF6600\"",
		"<title>Acme Billing</title>",
		"href=\"/content/assets/icon.svg\"",
	} {
		if !strings.Contains(string(page), want) {
			t.Fatalf("expected index.html to contain %q", want)
		}
	}
	sidebar, _ := os.ReadFile(filepath.Join(dir, ".leji", "viewer", "_sidebar.md"))
	top := strings.SplitN(string(sidebar), "---", 2)[0]
	if !strings.Contains(top, "- [Glossary](/domain/glossary.md)") {
		t.Fatalf("expected the pinned page in the top zone, got: %q", top)
	}
	pinMissing := false
	for _, f := range result.Findings {
		if f.Rule == "viewer-pin-missing" && f.Path == "docs/nope.md" {
			pinMissing = true
		}
	}
	if !pinMissing {
		t.Fatal("expected a missing pin to be surfaced, not silently dropped")
	}
}

func TestBuildSidebarSkipsOutOfRootBootAndRendersPlainEntries(t *testing.T) {
	m := loadM(t, exampleDir(t))
	// Boot profile outside rootPath: relativeToRoot fails, so no boot line.
	m.BootProfilePath = "README.md"
	m.RootPath = "docs/"
	sidebar := viewer.BuildSidebar(m, []viewer.SidebarGroup{
		{
			Label: "💰 Finance",
			Entries: []viewer.SidebarEntry{
				{Rel: "domain/glossary.md", Title: "Glossary"},
				{Rel: "records/status.md", Title: "Status"},
			},
		},
		{Label: "Empty group"},
	}, nil, nil, false)
	if strings.Contains(sidebar, "Boot profile") {
		t.Fatal("expected the out-of-root boot profile to be omitted")
	}
	if !strings.Contains(sidebar, "- **💰 Finance**") {
		t.Fatalf("expected the group label to be the index-file H1, verbatim, bold, got: %q", sidebar)
	}
	if !strings.Contains(sidebar, "  - [Glossary](/domain/glossary.md)") {
		t.Fatalf("expected entries to render as plain links, got: %q", sidebar)
	}
	if strings.Contains(sidebar, "lj-rec") {
		t.Fatalf("expected no record badges in the sidebar (kind and date are page-chip metadata now), got: %q", sidebar)
	}
	if strings.Contains(sidebar, "Empty group") {
		t.Fatal("expected empty groups to be skipped")
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
	page, _ := os.ReadFile(filepath.Join(dir, ".leji", "viewer", "index.html"))
	if strings.Contains(string(page), "mermaid.min.js") {
		t.Fatal("expected no mermaid script when disabled")
	}
	if strings.Contains(string(page), "docsify-mermaid.js") {
		t.Fatal("expected no mermaid plugin when disabled")
	}
	if _, err := os.Stat(filepath.Join(dir, ".leji", "viewer", "assets", "mermaid.min.js")); err == nil {
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
	v := validateLayer(t, dir, false)
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
	gitInit(t, dir)
	if _, err := initcmd.InitLayer(initcmd.Options{Dir: dir, Yes: true, Level: "indexed", Name: "acme-context"}); err != nil {
		t.Fatal(err)
	}
	gitCommitAll(t, dir)
	v := validateLayer(t, dir, false)
	for _, f := range v.Findings {
		if f.Severity == findings.Error {
			t.Fatalf("unexpected error: %s", f.Rule)
		}
	}
	c, cerr := conformance.Report(dir, false)
	if cerr != nil {
		t.Fatalf("conformance: %v", cerr)
	}
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

// --- intent/records ---

func recordsFixtureDir(t *testing.T) string {
	t.Helper()
	return filepath.Join(repoRoot(t), "fixtures", "valid-records")
}

func kindsByPath(scan layer.CategoryScan) map[string]string {
	out := map[string]string{}
	for _, d := range scan.Docs {
		out[d.RelPath] = d.Kind
	}
	return out
}

func TestRecordsFixtureResolvesKindsByBlockAndFileSelectorOverride(t *testing.T) {
	dir := recordsFixtureDir(t)
	m := loadM(t, dir)
	kinds := kindsByPath(layer.ScanCategories(dir, m))
	if kinds["docs/domain/overview.md"] != "intent" {
		t.Fatalf("overview.md: got %q want intent", kinds["docs/domain/overview.md"])
	}
	if kinds["docs/records/2026-07-03-status.md"] != "record" {
		t.Fatalf("2026-07-03-status.md: got %q want record", kinds["docs/records/2026-07-03-status.md"])
	}
	if kinds["docs/records/ledger.md"] != "record" {
		t.Fatalf("ledger.md: got %q want record", kinds["docs/records/ledger.md"])
	}
	// The file selector beats the record directory selector.
	if kinds["docs/records/escalation-policy.md"] != "intent" {
		t.Fatalf("rates.md: got %q want intent", kinds["docs/records/escalation-policy.md"])
	}
	// Decision-category documents are inherently records.
	if kinds["docs/decisions/0001-adopt-leji.md"] != "record" {
		t.Fatalf("0001-adopt-leji.md: got %q want record", kinds["docs/decisions/0001-adopt-leji.md"])
	}
}

func TestRecordsFrontmatterKindOverridesBlockKindAndInvalidKindErrors(t *testing.T) {
	dir := copyTree(t, recordsFixtureDir(t))
	os.WriteFile(filepath.Join(dir, "docs", "records", "pinned.md"),
		[]byte("---\nkind: intent\n---\n\n# Pinned\n\nA record-directory file declaring itself intent.\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "docs", "domain", "bad.md"),
		[]byte("---\nkind: sometimes\n---\n\n# Bad\n\nInvalid kind value.\n"), 0o644)
	m := loadM(t, dir)
	scan := layer.ScanCategories(dir, m)
	if kinds := kindsByPath(scan); kinds["docs/records/pinned.md"] != "intent" {
		t.Fatalf("pinned.md: got %q want intent", kinds["docs/records/pinned.md"])
	}
	found := false
	for _, f := range scan.Findings {
		if f.Rule == "kind-invalid" && f.Path == "docs/domain/bad.md" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected kind-invalid for docs/domain/bad.md, got %v", scan.Findings)
	}
}

func TestRecordsRouteSeparatesIntentDocumentsFromRecordCandidates(t *testing.T) {
	dir := recordsFixtureDir(t)
	m := loadM(t, dir)
	result, _ := layer.Route(dir, m, layer.RouteInput{
		Paths:      []string{"docs/records/ledger.md"},
		Categories: []string{"domain"},
	})
	docPaths := map[string]bool{}
	for _, d := range result.Documents {
		docPaths[d.Path] = true
		if strings.HasPrefix(d.Path, "docs/records/2") {
			t.Fatalf("records never route as documents: %s", d.Path)
		}
	}
	if !docPaths["docs/domain/overview.md"] {
		t.Fatal("expected docs/domain/overview.md in documents")
	}
	if !docPaths["docs/records/escalation-policy.md"] {
		t.Fatal("the intent-overridden file routes as required context")
	}
	byPath := map[string]layer.RoutedRecord{}
	for _, r := range result.Records {
		byPath[r.Path] = r
	}
	statusDate := "2026-07-03"
	wantStatus := layer.RoutedRecord{Path: "docs/records/2026-07-03-status.md", Category: "domain", Date: &statusDate, Required: false}
	if got, ok := byPath["docs/records/2026-07-03-status.md"]; !ok || !reflect.DeepEqual(got, wantStatus) {
		t.Fatalf("status record mismatch: got %+v want %+v", got, wantStatus)
	}
	wantLedger := layer.RoutedRecord{Path: "docs/records/ledger.md", Category: "domain", Date: nil, Required: true}
	if got, ok := byPath["docs/records/ledger.md"]; !ok || !reflect.DeepEqual(got, wantLedger) {
		t.Fatalf("ledger record mismatch: got %+v want %+v", got, wantLedger)
	}
	// Decision records route via `decisions`, never as generic records.
	if _, ok := byPath["docs/decisions/0001-adopt-leji.md"]; ok {
		t.Fatal("decision record must not appear in records")
	}
}

func TestRecordsFreshnessSkipsRecordsAndIndexCarriesKindAndDates(t *testing.T) {
	dir := recordsFixtureDir(t)
	m := loadM(t, dir)
	report := freshness.FreshnessReport(dir, m, false)
	if report.Declared != 0 {
		t.Fatalf("no intent doc in the fixture declares a horizon; declared=%d", report.Declared)
	}
	// Generate on a copy so the fixture stays pristine.
	copyDir := copyTree(t, dir)
	result := mustWriteIndex(t, copyDir, loadM(t, copyDir))
	entries := map[string]indexgen.IndexEntry{}
	for _, e := range result.Index.Entries {
		entries[e.Path] = e
	}
	if e := entries["docs/records/2026-07-03-status.md"]; e.Kind != "record" || e.Date != "2026-07-03" {
		t.Fatalf("status entry: got kind %q date %q", e.Kind, e.Date)
	}
	if e := entries["docs/records/ledger.md"]; e.Kind != "record" || e.Date != "" {
		t.Fatalf("ledger entry: got kind %q date %q", e.Kind, e.Date)
	}
	if e := entries["docs/records/escalation-policy.md"]; e.Kind != "intent" {
		t.Fatalf("rates entry: got kind %q", e.Kind)
	}
}

func TestRecordsFullyDisplacedBroadSelectorReportedAsShadowed(t *testing.T) {
	dir := copyTree(t, recordsFixtureDir(t))
	// Shrink the record directory to only the file the intent selector steals.
	os.Remove(filepath.Join(dir, "docs", "records", "2026-07-03-status.md"))
	os.Remove(filepath.Join(dir, "docs", "records", "ledger.md"))
	m := loadM(t, dir)
	report := statusReport(t, dir, m)
	want := []statuscmd.ShadowedSelector{{IndexFile: "docs/context/domain.md", Path: "docs/records/"}}
	if !reflect.DeepEqual(report.Shadowed, want) {
		t.Fatalf("shadowed mismatch: got %+v want %+v", report.Shadowed, want)
	}
}

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

// --- gate helpers -------------------------------------------------------------
// These commands now carry an error channel, because an operational read failure on
// an allowed path propagates instead of being swallowed (the reference throws it).
// A test that does not construct such a failure asserts there is none.

func validateLayer(t *testing.T, root string, content bool) validate.Result {
	t.Helper()
	res, err := validate.ValidateLayer(root, content)
	if err != nil {
		t.Fatalf("ValidateLayer(%s): %v", root, err)
	}
	return res
}

func checkIndex(t *testing.T, root string, m *manifest.Manifest) indexgen.Result {
	t.Helper()
	res, err := indexgen.CheckIndex(root, m)
	if err != nil {
		t.Fatalf("CheckIndex(%s): %v", root, err)
	}
	return res
}

func statusReport(t *testing.T, root string, m *manifest.Manifest) statuscmd.Report {
	t.Helper()
	res, err := statuscmd.StatusReport(root, m)
	if err != nil {
		t.Fatalf("StatusReport(%s): %v", root, err)
	}
	return res
}

func compactChangelog(t *testing.T, root string, m *manifest.Manifest, opts changelog.CompactOptions) changelog.CompactResult {
	t.Helper()
	res, err := changelog.CompactChangelog(root, m, opts)
	if err != nil {
		t.Fatalf("CompactChangelog(%s): %v", root, err)
	}
	return res
}
