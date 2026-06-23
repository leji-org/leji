// Package manifest loads and structurally validates leji.json: existence, JSON
// parse, declared spec line, manifest schema. Content-level checks live in the
// validate command.
package manifest

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/schemas"
)

// CategoryIDs in canonical order.
var CategoryIDs = []string{"domain", "system", "practice", "governance", "decisions"}

// ConformanceLevels in ascending order.
var ConformanceLevels = []string{"core", "indexed", "governed", "federated"}

const Filename = "leji.json"

type Owner struct {
	Name    string `json:"name"`
	Contact string `json:"contact,omitempty"`
}

type CategoryMapping struct {
	Paths []string `json:"paths"`
}

type Machine struct {
	IndexPath           string `json:"indexPath,omitempty"`
	ChangelogPath       string `json:"changelogPath,omitempty"`
	AgentProfilesPath   string `json:"agentProfilesPath,omitempty"`
	DecisionRecordsPath string `json:"decisionRecordsPath,omitempty"`
}

type Mount struct {
	Path   string `json:"path"`
	Name   string `json:"name"`
	Owner  Owner  `json:"owner"`
	Role   string `json:"role,omitempty"`
	Source string `json:"source,omitempty"`
}

type Federation struct {
	Mounts []Mount `json:"mounts,omitempty"`
}

type Owners struct {
	Primary    Owner  `json:"primary"`
	Continuity *Owner `json:"continuity,omitempty"`
}

type Conformance struct {
	ClaimedLevel string `json:"claimedLevel,omitempty"`
	ClaimedAt    string `json:"claimedAt,omitempty"`
}

type Theme struct {
	Primary string `json:"primary,omitempty"`
}

type Viewer struct {
	Port           *int              `json:"port,omitempty"`
	Logo           string            `json:"logo,omitempty"`
	Theme          *Theme            `json:"theme,omitempty"`
	Mermaid        *bool             `json:"mermaid,omitempty"`
	CategoryEmojis map[string]string `json:"categoryEmojis,omitempty"`
}

// Manifest is the typed view of leji.json. Categories preserve insertion order
// via the Machine map ordering helpers below where it matters.
type Manifest struct {
	Schema          string                     `json:"$schema,omitempty"`
	Leji            string                     `json:"leji"`
	Name            string                     `json:"name"`
	Description     string                     `json:"description,omitempty"`
	RootPath        string                     `json:"rootPath"`
	BootProfilePath string                     `json:"bootProfilePath"`
	Categories      map[string]CategoryMapping `json:"categories"`
	Machine         *Machine                   `json:"machine,omitempty"`
	Agents          map[string]string          `json:"agents,omitempty"`
	Viewer          *Viewer                    `json:"viewer,omitempty"`
	Owners          Owners                     `json:"owners"`
	Conformance     *Conformance               `json:"conformance,omitempty"`
	Federation      *Federation                `json:"federation,omitempty"`
	VendorAdapters  []string                   `json:"vendorAdapters,omitempty"`
}

// MachineEntries returns the declared machine.* string fields in the canonical
// emit order (indexPath, changelogPath, agentProfilesPath, decisionRecordsPath),
// skipping empties. Used for paths-outside-root, which iterates machine entries.
func (m *Manifest) MachineEntries() [][2]string {
	if m.Machine == nil {
		return nil
	}
	var out [][2]string
	if m.Machine.IndexPath != "" {
		out = append(out, [2]string{"indexPath", m.Machine.IndexPath})
	}
	if m.Machine.ChangelogPath != "" {
		out = append(out, [2]string{"changelogPath", m.Machine.ChangelogPath})
	}
	if m.Machine.AgentProfilesPath != "" {
		out = append(out, [2]string{"agentProfilesPath", m.Machine.AgentProfilesPath})
	}
	if m.Machine.DecisionRecordsPath != "" {
		out = append(out, [2]string{"decisionRecordsPath", m.Machine.DecisionRecordsPath})
	}
	return out
}

type Load struct {
	Manifest *Manifest
	Findings []findings.Finding
}

var lineRe = regexp.MustCompile(`^\d+\.\d+$`)

// LoadManifest reads and structurally validates leji.json at root.
func LoadManifest(root string) Load {
	abs := filepath.Join(root, Filename)
	if !fsx.Exists(abs) || !fsx.IsFile(abs) {
		return Load{Manifest: nil, Findings: []findings.Finding{
			findings.New("manifest-missing", findings.Error, "no "+Filename+" at the repository root", Filename),
		}}
	}
	// Confine the read: a symlinked leji.json that resolves outside the layer root
	// must not be read (an MCP exposes this read to an agent). Mirrors Node's
	// readTextWithin.
	if !fsx.ResolvesUnder(root, abs) {
		return Load{Manifest: nil, Findings: []findings.Finding{
			findings.New("manifest-parse", findings.Error, Filename+" resolves outside the layer root", Filename),
		}}
	}
	text, err := fsx.ReadText(abs)
	if err != nil {
		return Load{Manifest: nil, Findings: []findings.Finding{
			findings.New("manifest-parse", findings.Error, "invalid JSON: "+err.Error(), Filename),
		}}
	}
	var data any
	if err := json.Unmarshal([]byte(text), &data); err != nil {
		return Load{Manifest: nil, Findings: []findings.Finding{
			findings.New("manifest-parse", findings.Error, "invalid JSON: "+err.Error(), Filename),
		}}
	}

	var fs []findings.Finding
	if obj, ok := data.(map[string]any); ok {
		if line, ok := obj["leji"].(string); ok && lineRe.MatchString(line) && !slices.Contains(schemas.SupportedLines, line) {
			fs = append(fs, findings.New("manifest-line", findings.Error,
				fmt.Sprintf("declared spec line %q is not supported by this SDK (supported: %s)", line, joinLines()), Filename))
			return Load{Manifest: nil, Findings: fs}
		}
	}

	schemaErrs := schemas.SchemaErrors("context-manifest", data)
	for _, e := range schemaErrs {
		fs = append(fs, findings.New("manifest-schema", findings.Error, e, Filename))
	}
	if len(schemaErrs) > 0 {
		return Load{Manifest: nil, Findings: fs}
	}

	var m Manifest
	if err := json.Unmarshal([]byte(text), &m); err != nil {
		// Schema passed but struct decode failed: treat as a schema-level error.
		fs = append(fs, findings.New("manifest-schema", findings.Error, "invalid JSON: "+err.Error(), Filename))
		return Load{Manifest: nil, Findings: fs}
	}
	return Load{Manifest: &m, Findings: fs}
}

func joinLines() string {
	return strings.Join(schemas.SupportedLines, ", ")
}

// ClaimedLevel returns the effective conformance claim; absent is core.
func ClaimedLevel(m *Manifest) string {
	if m.Conformance != nil && m.Conformance.ClaimedLevel != "" {
		return m.Conformance.ClaimedLevel
	}
	return "core"
}

// LevelAtLeast reports whether level >= threshold in the conformance order.
func LevelAtLeast(level, threshold string) bool {
	return slices.Index(ConformanceLevels, level) >= slices.Index(ConformanceLevels, threshold)
}

// Effective foundational-path resolvers. The spec (machine-readable-surface.md)
// defines default locations under rootPath for the machine surface, so tooling
// resolves an undeclared path to its default rather than failing: leji.json lives
// at the repository root; everything else defaults under rootPath/.
func machineField(m *Manifest, get func(*Machine) string) string {
	if m.Machine != nil {
		if v := get(m.Machine); v != "" {
			return v
		}
	}
	return ""
}

// EffectiveIndexPath is machine.indexPath or rootPath+context-index.json.
func EffectiveIndexPath(m *Manifest) string {
	if v := machineField(m, func(x *Machine) string { return x.IndexPath }); v != "" {
		return v
	}
	return m.RootPath + "context-index.json"
}

// EffectiveChangelogPath is machine.changelogPath or rootPath+context-changelog.json.
func EffectiveChangelogPath(m *Manifest) string {
	if v := machineField(m, func(x *Machine) string { return x.ChangelogPath }); v != "" {
		return v
	}
	return m.RootPath + "context-changelog.json"
}

// EffectiveAgentProfilesPath is machine.agentProfilesPath or rootPath+agents/.
func EffectiveAgentProfilesPath(m *Manifest) string {
	if v := machineField(m, func(x *Machine) string { return x.AgentProfilesPath }); v != "" {
		return v
	}
	return m.RootPath + "agents/"
}

// EffectiveDecisionRecordsPath is machine.decisionRecordsPath or rootPath+decisions/.
func EffectiveDecisionRecordsPath(m *Manifest) string {
	if v := machineField(m, func(x *Machine) string { return x.DecisionRecordsPath }); v != "" {
		return v
	}
	return m.RootPath + "decisions/"
}

// MappedCategories returns categories present in the manifest in canonical order.
func (m *Manifest) MappedCategories() []string {
	var out []string
	for _, c := range CategoryIDs {
		if _, ok := m.Categories[c]; ok {
			out = append(out, c)
		}
	}
	return out
}

// --- In-place manifest text edits ---------------------------------------------
//
// `leji agent` (and any future post-init command that touches leji.json) edits
// the raw manifest text rather than parsing and re-serializing the whole object.
// This is deliberate: it preserves the user's field order, formatting, and any
// keys this SDK does not model, and it is the only way the three reference SDKs
// can produce byte-identical output (a generic parse + re-serialize diverges,
// e.g. Go alphabetizes map keys). The edits below assume the canonical two-space
// layout every SDK emits, and `owners` (a required key) as a stable anchor for
// inserting a new top-level key in schema position (right after `agents` would
// sit, before `owners`).

// insertAfterMarkerLine inserts line (already indented) as the first member
// directly after the line that opens marker (e.g. `"agents": {` or
// `"vendorAdapters": [`). Prepending sidesteps fixing up the previous last
// member's trailing comma.
func insertAfterMarkerLine(text, marker, line string) (string, error) {
	at := strings.Index(text, marker)
	if at < 0 {
		return "", fmt.Errorf("leji.json: cannot locate %q to anchor the edit", marker)
	}
	nl := strings.Index(text[at:], "\n")
	if nl < 0 {
		return "", fmt.Errorf("leji.json: malformed %q block", marker)
	}
	nl += at
	return text[:nl+1] + line + "\n" + text[nl+1:], nil
}

// insertBeforeOwners inserts a multi-line top-level block immediately before the
// `owners` key, so a newly created `agents` / `vendorAdapters` key lands in
// schema position.
func insertBeforeOwners(text string, lines []string) (string, error) {
	anchor := "\n  \"owners\":"
	at := strings.Index(text, anchor)
	if at < 0 {
		return "", fmt.Errorf("leji.json: cannot locate the \"owners\" key to anchor the edit")
	}
	return text[:at+1] + strings.Join(lines, "\n") + "\n" + text[at+1:], nil
}

// BindAgentInManifestText binds a named agent to its profile path in the
// manifest's `agents` map. Creates the map (before `owners`) when absent,
// otherwise prepends the entry. Idempotent: an already-bound name leaves the
// text untouched.
func BindAgentInManifestText(text, name, profileRel string) (string, bool, error) {
	var parsed struct {
		Agents map[string]json.RawMessage `json:"agents"`
	}
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		return "", false, err
	}
	if parsed.Agents != nil {
		if _, ok := parsed.Agents[name]; ok {
			return text, false, nil
		}
	}
	entry := "\"" + name + "\": \"" + profileRel + "\""
	if parsed.Agents == nil {
		out, err := insertBeforeOwners(text, []string{"  \"agents\": {", "    " + entry, "  },"})
		return out, true, err
	}
	out, err := insertAfterMarkerLine(text, "\"agents\": {", "    "+entry+",")
	return out, true, err
}

// DeclareVendorAdapterInManifestText declares a vendor adapter path in the
// manifest's `vendorAdapters` array. Creates the array (before `owners`) when
// absent, otherwise prepends the entry. Idempotent: an already-declared path
// leaves the text untouched.
func DeclareVendorAdapterInManifestText(text, adapter string) (string, bool, error) {
	var parsed struct {
		VendorAdapters []string `json:"vendorAdapters"`
	}
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		return "", false, err
	}
	if slices.Contains(parsed.VendorAdapters, adapter) {
		return text, false, nil
	}
	entry := "\"" + adapter + "\""
	if parsed.VendorAdapters == nil {
		out, err := insertBeforeOwners(text, []string{"  \"vendorAdapters\": [", "    " + entry, "  ],"})
		return out, true, err
	}
	out, err := insertAfterMarkerLine(text, "\"vendorAdapters\": [", "    "+entry+",")
	return out, true, err
}
