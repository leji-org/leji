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
	Indexes []string `json:"indexes"`
}

type Machine struct {
	IndexPath           string `json:"indexPath,omitempty"`
	ChangelogPath       string `json:"changelogPath,omitempty"`
	AgentProfilesPath   string `json:"agentProfilesPath,omitempty"`
	DecisionRecordsPath string `json:"decisionRecordsPath,omitempty"`
}

type Mount struct {
	Name         string   `json:"name"`
	Source       string   `json:"source"`
	Pin          string   `json:"pin"`
	TrackingRef  string   `json:"trackingRef,omitempty"`
	Owner        Owner    `json:"owner"`
	Role         string   `json:"role,omitempty"`
	Categories   []string `json:"categories,omitempty"`
	Topics       []string `json:"topics,omitempty"`
	RequiredWhen []string `json:"requiredWhen,omitempty"`
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

// ViewerPin is one viewer.pins entry: canonically a repo-relative path string,
// or `{ path, label }` when the team curates the sidebar label (emoji welcome).
type ViewerPin struct {
	Path  string
	Label string
}

// UnmarshalJSON accepts both pin forms (a bare string or an object), mirroring
// the Node SDK's `string | { path, label? }` union.
func (p *ViewerPin) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		p.Path = s
		p.Label = ""
		return nil
	}
	var obj struct {
		Path  string `json:"path"`
		Label string `json:"label"`
	}
	if err := json.Unmarshal(b, &obj); err != nil {
		return err
	}
	p.Path = obj.Path
	p.Label = obj.Label
	return nil
}

type Viewer struct {
	Port           *int              `json:"port,omitempty"`
	Logo           string            `json:"logo,omitempty"`
	Title          string            `json:"title,omitempty"`
	AgentsLabel    string            `json:"agentsLabel,omitempty"`
	Favicon        string            `json:"favicon,omitempty"`
	Homepage       string            `json:"homepage,omitempty"`
	Pins           []ViewerPin       `json:"pins,omitempty"`
	GroupOrder     []string          `json:"groupOrder,omitempty"`
	Theme          *Theme            `json:"theme,omitempty"`
	Mermaid        *bool             `json:"mermaid,omitempty"`
	PoweredBy      *bool             `json:"poweredBy,omitempty"`
	CategoryEmojis map[string]string `json:"categoryEmojis,omitempty"`
}

// Manifest is the typed view of leji.json.
// Actor is one entry in the optional actor registry.
type Actor struct {
	Roles    []string          `json:"roles"`
	Commands map[string]string `json:"commands"`
}

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
	// Actors is the optional actor registry: stable actor ids to the roles they can
	// fill and a command template per role, because one actor can need different
	// invocations in different roles.
	Actors         map[string]Actor `json:"actors,omitempty"`
	Viewer         *Viewer          `json:"viewer,omitempty"`
	Owners         Owners           `json:"owners"`
	Conformance    *Conformance     `json:"conformance,omitempty"`
	Federation     *Federation      `json:"federation,omitempty"`
	VendorAdapters []string         `json:"vendorAdapters,omitempty"`
}

// MachineEntries returns declared machine.* fields in canonical emit order
// (indexPath, changelogPath, agentProfilesPath, decisionRecordsPath), skipping empties.
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
	if !fsx.ResolvedWithinRoot(root, abs) {
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
	// Before anything reads a value: a manifest string that is not a well-formed
	// Unicode scalar sequence is refused whole, never carried into a hash, a sort,
	// or output. The message quotes nothing back — echoing the offending text is
	// exactly the outcome the check exists to prevent.
	if !AllStringsScalar([]byte(text)) {
		return Load{Manifest: nil, Findings: []findings.Finding{
			findings.New("manifest-not-scalar", findings.Error,
				Filename+" carries a string that is not a well-formed Unicode scalar sequence (an unpaired surrogate)",
				Filename),
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
		// The 1.2 category shape fails as a pile of raw schema text ("must NOT have
		// additional properties"), which never names the thing to change. One sentence
		// turns that into an actionable read.
		if declaresCategoryPaths(data) {
			fs = append(fs, findings.New("manifest-schema", findings.Error,
				`a category declares "paths", the 1.2 form: 1.3 categories declare "indexes" instead (see "Migrating a 1.2 manifest" in the changelog)`,
				Filename))
		}
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

// declaresCategoryPaths reports whether any category maps to an object carrying
// the removed 1.2 `paths` key.
func declaresCategoryPaths(data any) bool {
	obj, ok := data.(map[string]any)
	if !ok {
		return false
	}
	cats, ok := obj["categories"].(map[string]any)
	if !ok {
		return false
	}
	for _, v := range cats {
		if entry, ok := v.(map[string]any); ok {
			if _, has := entry["paths"]; has {
				return true
			}
		}
	}
	return false
}

func joinLines() string {
	return strings.Join(schemas.SupportedLines, ", ")
}

// AllStringsScalar reports whether every string in a JSON document is a
// well-formed Unicode scalar sequence: no unpaired surrogate. A JSON parser
// accepts an escaped lone surrogate, but strict UTF-8 encoding of one raises in
// some runtimes and silently substitutes U+FFFD in others, so the same document
// would crash one implementation and produce output in another. Go's decoder is
// one of the substituting ones, which destroys the evidence, so this reads the
// document text: in valid JSON a backslash only ever appears inside a string.
func AllStringsScalar(raw []byte) bool {
	for i := 0; i < len(raw); i++ {
		if raw[i] != '\\' || i+1 >= len(raw) {
			continue
		}
		if raw[i+1] != 'u' {
			i++ // an escaped backslash never starts an escape of its own
			continue
		}
		cp, ok := hex4(raw, i+2)
		if !ok {
			i++
			continue
		}
		if cp >= 0xDC00 && cp <= 0xDFFF {
			return false // a low surrogate with no high surrogate before it
		}
		if cp >= 0xD800 && cp <= 0xDBFF {
			lo, loOK := hex4(raw, i+8)
			if !loOK || raw[i+6] != '\\' || raw[i+7] != 'u' || lo < 0xDC00 || lo > 0xDFFF {
				return false
			}
			i += 11 // the whole pair
			continue
		}
		i += 5
	}
	return true
}

// hex4 reads the four hex digits of a \uXXXX escape at off.
func hex4(raw []byte, off int) (int, bool) {
	if off+4 > len(raw) {
		return 0, false
	}
	v := 0
	for _, c := range raw[off : off+4] {
		switch {
		case c >= '0' && c <= '9':
			v = v*16 + int(c-'0')
		case c >= 'a' && c <= 'f':
			v = v*16 + int(c-'a') + 10
		case c >= 'A' && c <= 'F':
			v = v*16 + int(c-'A') + 10
		default:
			return 0, false
		}
	}
	return v, true
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

// Effective foundational-path resolvers. Per spec (machine-readable-surface.md),
// an undeclared machine path resolves to its default under rootPath/ rather than
// failing (leji.json itself lives at the repository root).
func machineField(m *Manifest, get func(*Machine) string) string {
	if m.Machine != nil {
		if v := get(m.Machine); v != "" {
			return v
		}
	}
	return ""
}

// EffectiveIndexPath is machine.indexPath or rootPath/context-index.json.
func EffectiveIndexPath(m *Manifest) string {
	if v := machineField(m, func(x *Machine) string { return x.IndexPath }); v != "" {
		return v
	}
	return fsx.JoinUnderRoot(m.RootPath, "context-index.json")
}

// EffectiveChangelogPath is machine.changelogPath or rootPath/context-changelog.json.
func EffectiveChangelogPath(m *Manifest) string {
	if v := machineField(m, func(x *Machine) string { return x.ChangelogPath }); v != "" {
		return v
	}
	return fsx.JoinUnderRoot(m.RootPath, "context-changelog.json")
}

// EffectiveAgentProfilesPath is machine.agentProfilesPath or rootPath/agents/.
func EffectiveAgentProfilesPath(m *Manifest) string {
	if v := machineField(m, func(x *Machine) string { return x.AgentProfilesPath }); v != "" {
		return v
	}
	return fsx.JoinUnderRoot(m.RootPath, "agents/")
}

// EffectiveDecisionRecordsPath is machine.decisionRecordsPath or rootPath/decisions/.
func EffectiveDecisionRecordsPath(m *Manifest) string {
	if v := machineField(m, func(x *Machine) string { return x.DecisionRecordsPath }); v != "" {
		return v
	}
	return fsx.JoinUnderRoot(m.RootPath, "decisions/")
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

// In-place manifest text edits: `leji agent` and similar edit the raw manifest
// text rather than parse + re-serialize, to preserve the user's field order,
// formatting, and unmodeled keys, and because it is the only way the three SDKs
// produce byte-identical output (Go alphabetizes map keys). The edits assume the
// canonical two-space layout and use `owners` (required) as the anchor for
// inserting a new top-level key in schema position.

// insertAfterMarkerLine inserts line (already indented) as the first member after
// the line opening marker (e.g. `"agents": {`). Prepending sidesteps fixing up the
// previous last member's trailing comma.
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
// `owners` key, so a newly created `agents` key lands in schema position.
func insertBeforeOwners(text string, lines []string) (string, error) {
	anchor := "\n  \"owners\":"
	at := strings.Index(text, anchor)
	if at < 0 {
		return "", fmt.Errorf("leji.json: cannot locate the \"owners\" key to anchor the edit")
	}
	return text[:at+1] + strings.Join(lines, "\n") + "\n" + text[at+1:], nil
}

// BindAgentInManifestText binds a named agent to its profile path in the `agents`
// map, creating it (before `owners`) when absent. Idempotent.
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
