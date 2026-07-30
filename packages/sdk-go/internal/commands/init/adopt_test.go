package initcmd

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/validate"
	"github.com/leji-org/leji/packages/sdk-go/internal/detect"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
	"github.com/leji-org/leji/packages/sdk-go/internal/writeplan"
)

func gitInit(t *testing.T, dir string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		return
	}
	cmd := exec.Command("git", "init", "-q")
	cmd.Dir = dir
	if err := cmd.Run(); err != nil {
		t.Fatalf("git init: %v", err)
	}
}

// gitCommitAll commits dir clean; the dirty-tree guard refuses an uncommitted tree.
func gitCommitAll(t *testing.T, dir string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		return
	}
	add := exec.Command("git", "add", "-A")
	add.Dir = dir
	if err := add.Run(); err != nil {
		t.Fatalf("git add: %v", err)
	}
	commit := exec.Command("git", "-c", "user.name=T", "-c", "user.email=t@e.com", "commit", "-q", "-m", "seed")
	commit.Dir = dir
	if err := commit.Run(); err != nil {
		t.Fatalf("git commit: %v", err)
	}
}

// adopt writes the portable AGENTS.md pointer only when absent.
func TestAdoptWritesPortableAgentsPointerWhenAbsent(t *testing.T) {
	dir := t.TempDir()
	gitInit(t, dir)
	if err := os.MkdirAll(filepath.Join(dir, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "docs", "README.md"), []byte("# Docs\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCommitAll(t, dir)
	res, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true})
	if err != nil {
		t.Fatalf("adopt: %v", err)
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
}

// adopt --no-agents skips the pointer; an existing AGENTS.md keeps the migrate flow.
func TestAdoptNoAgentsAndExistingAgentsFile(t *testing.T) {
	skipDir := t.TempDir()
	gitInit(t, skipDir)
	skipped, err := AdoptLayer(AdoptOptions{Dir: skipDir, Yes: true, NoAgents: true})
	if err != nil {
		t.Fatalf("adopt --no-agents: %v", err)
	}
	if contains(skipped.Written, "AGENTS.md") {
		t.Fatalf("AGENTS.md should not be written, got %v", skipped.Written)
	}
	if _, statErr := os.Stat(filepath.Join(skipDir, "AGENTS.md")); !os.IsNotExist(statErr) {
		t.Fatalf("AGENTS.md should not exist, stat err: %v", statErr)
	}

	dir := t.TempDir()
	gitInit(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte("Team instructions here.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCommitAll(t, dir)
	res, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true})
	if err != nil {
		t.Fatalf("adopt: %v", err)
	}
	// Present file: content migrated, original untouched, no pointer overwrite.
	if contains(res.Written, "AGENTS.md") {
		t.Fatalf("AGENTS.md should not be written, got %v", res.Written)
	}
	if len(res.Migrated) != 1 || res.Migrated[0] != "AGENTS.md" {
		t.Fatalf("migrated = %v, want [AGENTS.md]", res.Migrated)
	}
	body, err := os.ReadFile(filepath.Join(dir, "AGENTS.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "Team instructions here.\n" {
		t.Fatalf("existing AGENTS.md was modified: %q", body)
	}
}

func TestAdoptReusesDocsRootAndMigrates(t *testing.T) {
	dir := t.TempDir()
	gitInit(t, dir)
	if err := os.MkdirAll(filepath.Join(dir, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "docs", "README.md"), []byte("# Docs\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte("Always run tests. Use 3-space indent.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCommitAll(t, dir)

	res, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true})
	if err != nil {
		t.Fatalf("adopt: %v", err)
	}
	if res.DetectedRoot != "docs/" {
		t.Fatalf("detectedRoot = %q, want docs/", res.DetectedRoot)
	}
	if len(res.Migrated) != 1 || res.Migrated[0] != "CLAUDE.md" {
		t.Fatalf("migrated = %v, want [CLAUDE.md]", res.Migrated)
	}
	if !res.Draft {
		t.Fatal("a non-redirecting vendor file should make it a draft")
	}

	body, err := os.ReadFile(filepath.Join(dir, "CLAUDE.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "Always run tests. Use 3-space indent.\n" {
		t.Fatalf("original CLAUDE.md was modified: %q", body)
	}
	imported := filepath.Join(dir, "docs", "governance", "imported-claude.md")
	ib, err := os.ReadFile(imported)
	if err != nil {
		t.Fatalf("migrated file not written: %v", err)
	}
	if !strings.Contains(string(ib), "Always run tests") {
		t.Fatalf("migrated content missing: %q", ib)
	}
	if _, err := os.Stat(filepath.Join(dir, "docs", "decisions", "0002-adopt-existing-agent-context.md")); err != nil {
		t.Fatalf("adopt-existing decision not written: %v", err)
	}

	// Non-redirecting entrypoint makes validate error.
	v := validate.ValidateLayer(dir, false)
	found := false
	for _, f := range v.Findings {
		if f.Rule == "vendor-adapter-redirect" && f.Severity == findings.Error {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a vendor-adapter-redirect error, got %+v", v.Findings)
	}
}

func TestAdoptWireAdaptersConvertsAndValidates(t *testing.T) {
	dir := t.TempDir()
	gitInit(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte("Always run tests.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCommitAll(t, dir)

	res, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true, WireAdapters: true})
	if err != nil {
		t.Fatalf("adopt --wire-adapters: %v", err)
	}
	if res.Draft {
		t.Fatal("wire-adapters should not leave a draft")
	}
	body, err := os.ReadFile(filepath.Join(dir, "CLAUDE.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "docs/boot-profile.md") {
		t.Fatalf("entrypoint not converted to a redirect: %q", body)
	}
	load := manifest.LoadManifest(dir)
	if load.Manifest == nil {
		t.Fatal("manifest did not load")
	}
	if len(load.Manifest.VendorAdapters) != 1 || load.Manifest.VendorAdapters[0] != "CLAUDE.md" {
		t.Fatalf("vendorAdapters = %v, want [CLAUDE.md]", load.Manifest.VendorAdapters)
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

func TestAdoptDryRunShowsOverwriteWritesNothing(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true, DryRun: true, WireAdapters: true})
	if err != nil {
		t.Fatalf("adopt --dry-run: %v", err)
	}
	if len(res.Written) != 0 {
		t.Fatalf("dry-run wrote files: %v", res.Written)
	}
	if _, err := os.Stat(filepath.Join(dir, "leji.json")); err == nil {
		t.Fatal("dry-run creates no manifest")
	}
	var entry *writeplan.PlanEntry
	for i := range res.Plan {
		if res.Plan[i].Rel == "CLAUDE.md" {
			entry = &res.Plan[i]
		}
	}
	if entry == nil || entry.Status != writeplan.Overwrite {
		t.Fatalf("CLAUDE.md should be overwrite, got %+v", entry)
	}
}

func TestAdoptWireAdaptersMigratesMixedFile(t *testing.T) {
	dir := t.TempDir()
	gitInit(t, dir)
	// Mixed file: shares the boot-path line but adds real instructions, so its
	// trimmed content isn't byte-identical to the canonical redirect and the
	// whole file is migrated.
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"),
		[]byte("Read docs/boot-profile.md first. Never deploy on Fridays.\nAlways run the full test suite before committing.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCommitAll(t, dir)
	res, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true, WireAdapters: true})
	if err != nil {
		t.Fatalf("adopt --wire-adapters: %v", err)
	}
	if !contains(res.Migrated, "CLAUDE.md") {
		t.Fatalf("mixed file should be migrated, not silently overwritten; migrated = %v", res.Migrated)
	}
	imported, err := os.ReadFile(filepath.Join(dir, "docs", "governance", "imported-claude.md"))
	if err != nil {
		t.Fatalf("imported governance doc not written: %v", err)
	}
	if !strings.Contains(string(imported), "Never deploy on Fridays") {
		t.Fatalf("same-line instructions not preserved in the layer: %q", imported)
	}
	if !strings.Contains(string(imported), "Always run the full test suite") {
		t.Fatalf("next-line instructions not preserved in the layer: %q", imported)
	}
	body, err := os.ReadFile(filepath.Join(dir, "CLAUDE.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "docs/boot-profile.md") {
		t.Fatalf("entrypoint not converted to a redirect: %q", body)
	}
}

// A file already the canonical redirect is left alone (nothing to preserve).
func TestAdoptWireAdaptersSkipsCanonicalRedirect(t *testing.T) {
	dir := t.TempDir()
	gitInit(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"),
		[]byte(detect.AdapterContent("docs/boot-profile.md")), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCommitAll(t, dir)
	res, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true, WireAdapters: true})
	if err != nil {
		t.Fatalf("adopt --wire-adapters: %v", err)
	}
	if contains(res.Migrated, "CLAUDE.md") {
		t.Fatalf("a file already the canonical redirect must not be migrated; migrated = %v", res.Migrated)
	}
}

func TestAdoptRefusesWhenLayerExists(t *testing.T) {
	dir := t.TempDir()
	if _, err := InitLayer(Options{Dir: dir, Yes: true}); err != nil {
		t.Fatalf("init: %v", err)
	}
	_, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true})
	if err == nil {
		t.Fatal("expected an error when a layer already exists")
	}
	if !strings.Contains(err.Error(), "already has a Leji layer") {
		t.Fatalf("expected 'already has a Leji layer', got: %v", err)
	}
}

// validateErrCount is the number of error-severity findings a layer validates with.
func validateErrCount(t *testing.T, dir string) int {
	t.Helper()
	n := 0
	for _, f := range validate.ValidateLayer(dir, false).Findings {
		if f.Severity == findings.Error {
			n++
		}
	}
	return n
}

// `adopt --yes` then the `adopt --wire-adapters` it prints reaches a clean layer.
func TestAdoptThenPrintedWireAdaptersReachesCleanLayer(t *testing.T) {
	dir := t.TempDir()
	gitInit(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte("# Claude instructions\n\nNever deploy on Fridays.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCommitAll(t, dir)

	adopted, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true})
	if err != nil {
		t.Fatalf("adopt: %v", err)
	}
	if !adopted.Draft {
		t.Fatal("a non-redirecting vendor file should leave an adoption draft")
	}
	if !strings.Contains(EnteringAdopted(adopted), "leji adopt --wire-adapters") {
		t.Fatal("the draft should print the finishing command")
	}

	// The command it printed has to run against the layer it just created.
	wired, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true, WireAdapters: true})
	if err != nil {
		t.Fatalf("adopt --wire-adapters: %v", err)
	}
	if !wired.WiredOnly {
		t.Fatal("expected a wire-only run")
	}
	if len(wired.Wired) != 1 || wired.Wired[0] != "CLAUDE.md" {
		t.Fatalf("Wired = %v", wired.Wired)
	}
	// The content was archived on the first pass, so wiring re-archives nothing.
	if len(wired.Migrated) != 0 {
		t.Fatalf("Migrated = %v, want none", wired.Migrated)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "docs", "governance", "imported-claude-2.md")); !os.IsNotExist(statErr) {
		t.Fatalf("a duplicate archive was written: %v", statErr)
	}
	body, err := os.ReadFile(filepath.Join(dir, "CLAUDE.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "Read ./docs/boot-profile.md first. It is the canonical context entrypoint for this repository.\n" {
		t.Fatalf("CLAUDE.md = %q", body)
	}
	if n := validateErrCount(t, dir); n != 0 {
		t.Fatalf("expected a clean layer, got %d errors", n)
	}

	// Idempotent: everything already redirects, so there is nothing left to wire.
	again, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true, WireAdapters: true})
	if err != nil {
		t.Fatalf("re-wire: %v", err)
	}
	if len(again.Wired) != 0 || len(again.Written) != 0 {
		t.Fatalf("re-wire wrote %v / wired %v", again.Written, again.Wired)
	}
	if !strings.Contains(EnteringAdopted(again), "already redirects to the boot profile") {
		t.Fatalf("re-wire report = %q", EnteringAdopted(again))
	}
}

// adopt --wire-adapters archives a vendor file edited since adoption before
// overwriting it.
func TestWireAdaptersArchivesVendorFileEditedSinceAdoption(t *testing.T) {
	dir := t.TempDir()
	gitInit(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte("original instructions\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCommitAll(t, dir)
	if _, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true}); err != nil {
		t.Fatalf("adopt: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte("hand-written rules added after adoption\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	wired, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true, WireAdapters: true})
	if err != nil {
		t.Fatalf("adopt --wire-adapters: %v", err)
	}
	if len(wired.Migrated) != 1 || wired.Migrated[0] != "CLAUDE.md" {
		t.Fatalf("Migrated = %v, want the newer content archived", wired.Migrated)
	}
	newer, err := os.ReadFile(filepath.Join(dir, "docs", "governance", "imported-claude-2.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(newer), "hand-written rules added after adoption") {
		t.Fatalf("imported-claude-2.md = %q", newer)
	}
	older, err := os.ReadFile(filepath.Join(dir, "docs", "governance", "imported-claude.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(older), "original") {
		t.Fatalf("imported-claude.md = %q", older)
	}
	if n := validateErrCount(t, dir); n != 0 {
		t.Fatalf("expected a clean layer, got %d errors", n)
	}
}

// adopt refuses an existing layer unless --wire-adapters asked for the wiring.
func TestAdoptRefusesExistingLayerWithoutWireAdapters(t *testing.T) {
	dir := t.TempDir()
	gitInit(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# repo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCommitAll(t, dir)
	if _, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true}); err != nil {
		t.Fatalf("adopt: %v", err)
	}
	_, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true})
	if err == nil || !strings.Contains(err.Error(), "already has a Leji layer") {
		t.Fatalf("err = %v, want the existing-layer refusal", err)
	}
}
