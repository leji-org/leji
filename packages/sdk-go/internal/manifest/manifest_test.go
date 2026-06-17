package manifest

import (
	"os"
	"path/filepath"
	"testing"
)

func writeManifest(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, Filename), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

const validManifest = `{
  "leji": "1.0",
  "name": "acme-billing-context",
  "rootPath": "docs/",
  "bootProfilePath": "docs/boot-profile.md",
  "categories": { "domain": { "paths": ["docs/domain/"] } },
  "machine": {
    "indexPath": "docs/context-index.json",
    "changelogPath": "docs/context-changelog.json",
    "agentProfilesPath": "docs/agents/",
    "decisionRecordsPath": "docs/decisions/"
  },
  "owners": { "primary": { "name": "Jo Lee", "contact": "jo@acme.example" } },
  "conformance": { "claimedLevel": "indexed", "claimedAt": "2026-06-10" }
}`

func hasRule(t *testing.T, dir, rule string) bool {
	t.Helper()
	for _, f := range LoadManifest(dir).Findings {
		if f.Rule == rule {
			return true
		}
	}
	return false
}

func TestLoadManifestMissing(t *testing.T) {
	dir := t.TempDir()
	res := LoadManifest(dir)
	if res.Manifest != nil {
		t.Fatalf("expected nil manifest when file missing")
	}
	if !hasRule(t, dir, "manifest-missing") {
		t.Fatalf("expected manifest-missing finding, got %#v", res.Findings)
	}
}

func TestLoadManifestInvalidJSON(t *testing.T) {
	dir := writeManifest(t, "{ not valid json")
	res := LoadManifest(dir)
	if res.Manifest != nil {
		t.Fatalf("expected nil manifest on parse error")
	}
	if !hasRule(t, dir, "manifest-parse") {
		t.Fatalf("expected manifest-parse finding, got %#v", res.Findings)
	}
}

func TestLoadManifestUnsupportedLine(t *testing.T) {
	// A well-formed spec line that this SDK does not support short-circuits to
	// a manifest-line finding before schema validation.
	dir := writeManifest(t, `{
  "leji": "2.0",
  "name": "x",
  "rootPath": "docs/",
  "bootProfilePath": "docs/boot-profile.md",
  "categories": { "domain": { "paths": ["docs/"] } },
  "owners": { "primary": { "name": "Jo" } }
}`)
	res := LoadManifest(dir)
	if res.Manifest != nil {
		t.Fatalf("expected nil manifest for unsupported line")
	}
	if !hasRule(t, dir, "manifest-line") {
		t.Fatalf("expected manifest-line finding, got %#v", res.Findings)
	}
}

func TestLoadManifestSchemaViolation(t *testing.T) {
	// Missing required fields (owners, bootProfilePath) trips schema validation.
	dir := writeManifest(t, `{ "leji": "1.0", "name": "x", "rootPath": "docs/", "categories": {} }`)
	res := LoadManifest(dir)
	if res.Manifest != nil {
		t.Fatalf("expected nil manifest on schema failure")
	}
	if !hasRule(t, dir, "manifest-schema") {
		t.Fatalf("expected manifest-schema finding, got %#v", res.Findings)
	}
}

func TestLoadManifestValid(t *testing.T) {
	dir := writeManifest(t, validManifest)
	res := LoadManifest(dir)
	if res.Manifest == nil {
		t.Fatalf("expected manifest to load, findings: %#v", res.Findings)
	}
	if len(res.Findings) != 0 {
		t.Fatalf("valid manifest should yield no findings, got %#v", res.Findings)
	}
	m := res.Manifest
	if m.Name != "acme-billing-context" {
		t.Fatalf("name = %q", m.Name)
	}
	if m.BootProfilePath != "docs/boot-profile.md" {
		t.Fatalf("bootProfilePath = %q", m.BootProfilePath)
	}
	if m.Machine == nil || m.Machine.AgentProfilesPath != "docs/agents/" {
		t.Fatalf("machine not decoded: %#v", m.Machine)
	}
}

func TestMachineEntries(t *testing.T) {
	m := &Manifest{Machine: &Machine{
		IndexPath:           "docs/context-index.json",
		ChangelogPath:       "docs/context-changelog.json",
		AgentProfilesPath:   "docs/agents/",
		DecisionRecordsPath: "docs/decisions/",
	}}
	got := m.MachineEntries()
	want := [][2]string{
		{"indexPath", "docs/context-index.json"},
		{"changelogPath", "docs/context-changelog.json"},
		{"agentProfilesPath", "docs/agents/"},
		{"decisionRecordsPath", "docs/decisions/"},
	}
	if len(got) != len(want) {
		t.Fatalf("entries len %d want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("entry %d = %v want %v", i, got[i], want[i])
		}
	}
}

func TestMachineEntriesSkipsEmptyAndNil(t *testing.T) {
	if (&Manifest{}).MachineEntries() != nil {
		t.Fatalf("nil machine should yield nil entries")
	}
	m := &Manifest{Machine: &Machine{IndexPath: "docs/i.json"}}
	got := m.MachineEntries()
	if len(got) != 1 || got[0] != [2]string{"indexPath", "docs/i.json"} {
		t.Fatalf("expected only indexPath, got %v", got)
	}
}

func TestClaimedLevel(t *testing.T) {
	if got := ClaimedLevel(&Manifest{}); got != "core" {
		t.Fatalf("absent conformance should be core, got %q", got)
	}
	if got := ClaimedLevel(&Manifest{Conformance: &Conformance{}}); got != "core" {
		t.Fatalf("empty claimedLevel should be core, got %q", got)
	}
	m := &Manifest{Conformance: &Conformance{ClaimedLevel: "governed"}}
	if got := ClaimedLevel(m); got != "governed" {
		t.Fatalf("claimedLevel = %q want governed", got)
	}
}

func TestLevelAtLeast(t *testing.T) {
	cases := []struct {
		level, threshold string
		want             bool
	}{
		{"core", "core", true},
		{"indexed", "core", true},
		{"core", "indexed", false},
		{"federated", "governed", true},
		{"governed", "federated", false},
	}
	for _, c := range cases {
		if got := LevelAtLeast(c.level, c.threshold); got != c.want {
			t.Fatalf("LevelAtLeast(%q,%q)=%v want %v", c.level, c.threshold, got, c.want)
		}
	}
}

func TestMappedCategoriesCanonicalOrder(t *testing.T) {
	// Insertion order in the map is deliberately scrambled; output must follow
	// CategoryIDs canonical order and skip absent categories.
	m := &Manifest{Categories: map[string]CategoryMapping{
		"decisions": {},
		"domain":    {},
		"practice":  {},
	}}
	got := m.MappedCategories()
	want := []string{"domain", "practice", "decisions"}
	if len(got) != len(want) {
		t.Fatalf("mapped len %d want %d (%v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("mapped[%d] = %q want %q", i, got[i], want[i])
		}
	}
}
