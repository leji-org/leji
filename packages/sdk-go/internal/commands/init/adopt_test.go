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

// adopt reuses an existing docs root and migrates vendor content (draft).
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

	// Original is untouched.
	body, err := os.ReadFile(filepath.Join(dir, "CLAUDE.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "Always run tests. Use 3-space indent.\n" {
		t.Fatalf("original CLAUDE.md was modified: %q", body)
	}
	// Content migrated into a Leji-owned governance doc with a single .md.
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

	// Draft is honest: the non-redirecting entrypoint makes validate error.
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

// adopt --wire-adapters converts the entrypoint and validates clean core.
func TestAdoptWireAdaptersConvertsAndValidates(t *testing.T) {
	dir := t.TempDir()
	gitInit(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte("Always run tests.\n"), 0o644); err != nil {
		t.Fatal(err)
	}

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

// adopt --dry-run shows convert vs leave-as-is and writes nothing.
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

// adopt --wire-adapters migrates mixed redirect+instructions before overwriting.
func TestAdoptWireAdaptersMigratesMixedFile(t *testing.T) {
	dir := t.TempDir()
	gitInit(t, dir)
	// A vendor file that shares a line with the boot-path reference AND carries
	// real instructions on the next line. The robust rule migrates the whole file
	// because its trimmed content is not byte-identical to the canonical redirect.
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"),
		[]byte("Read docs/boot-profile.md first. Never deploy on Fridays.\nAlways run the full test suite before committing.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
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

// adopt --wire-adapters leaves a file that is already the canonical redirect
// alone: it is not migrated (nothing to preserve).
func TestAdoptWireAdaptersSkipsCanonicalRedirect(t *testing.T) {
	dir := t.TempDir()
	gitInit(t, dir)
	// A vendor file whose content is exactly the canonical redirect Leji writes.
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"),
		[]byte(detect.AdapterContent("docs/boot-profile.md")), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := AdoptLayer(AdoptOptions{Dir: dir, Yes: true, WireAdapters: true})
	if err != nil {
		t.Fatalf("adopt --wire-adapters: %v", err)
	}
	if contains(res.Migrated, "CLAUDE.md") {
		t.Fatalf("a file already the canonical redirect must not be migrated; migrated = %v", res.Migrated)
	}
}

// adopt refuses when a layer already exists.
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
