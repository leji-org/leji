// Package validate performs full layer validation, mirroring the Node SDK's
// validate command: manifest, level-aware artifact requirements, schema checks,
// frontmatter contracts, and lint rules.
package validate

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/indexgen"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/frontmatter"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/git"
	"github.com/leji-org/leji/packages/sdk-go/internal/layer"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
	"github.com/leji-org/leji/packages/sdk-go/internal/schemas"
)

// KnownVendorFiles are checked for the redirect rule even when undeclared.
var KnownVendorFiles = []string{
	"CLAUDE.md",
	"AGENTS.md",
	"GEMINI.md",
	".cursorrules",
	".cursor/rules",
	".windsurfrules",
	".github/copilot-instructions.md",
}

type Result struct {
	Findings []findings.Finding
	Manifest *manifest.Manifest
}

type ChangelogCheckResult struct {
	Findings []findings.Finding
	Verified bool
}

var headingsRe = regexp.MustCompile(`(?m)^#{1,6}\s+(.+)$`)

func checkDeclaredFile(root, rel, what string, fs *[]findings.Finding) bool {
	if !fsx.IsFile(filepath.Join(root, rel)) {
		*fs = append(*fs, findings.New("missing-declared-file", findings.Error,
			what+" declared in leji.json does not exist", rel))
		return false
	}
	return true
}

func checkBootProfile(root string, m *manifest.Manifest, fs *[]findings.Finding) {
	rel := m.BootProfilePath
	if !checkDeclaredFile(root, rel, "boot profile", fs) {
		return
	}
	text, _ := fsx.ReadText(filepath.Join(root, rel))
	var headings []string
	for _, mm := range headingsRe.FindAllStringSubmatch(text, -1) {
		headings = append(headings, strings.ToLower(mm[1]))
	}
	for _, section := range []string{"identity", "loading", "posture"} {
		found := false
		for _, h := range headings {
			if strings.Contains(h, section) {
				found = true
				break
			}
		}
		if !found {
			*fs = append(*fs, findings.New("boot-profile-sections", findings.Warning,
				fmt.Sprintf("boot profile has no %q heading; it must cover identity, loading, and posture", section), rel))
		}
	}

	var changelogPath string
	if m.Machine != nil {
		changelogPath = m.Machine.ChangelogPath
	}
	decisionsPath := manifest.EffectiveDecisionRecordsPath(m)
	mentions := func(p string) bool {
		if p == "" {
			return false
		}
		base := strings.TrimSuffix(p, "/")
		return strings.Contains(text, base)
	}
	if !mentions(changelogPath) && !mentions(decisionsPath) {
		*fs = append(*fs, findings.New("boot-profile-maintenance", findings.Warning,
			"boot profile references neither the declared changelog nor the decision-records location; state the maintenance duties", rel))
	}
}

func checkCategories(root string, m *manifest.Manifest, fs *[]findings.Finding) {
	mapped := m.MappedCategories()
	hasMapped := func(c string) bool {
		for _, x := range mapped {
			if x == c {
				return true
			}
		}
		return false
	}
	if !(hasMapped("domain") || hasMapped("system")) || !hasMapped("decisions") {
		*fs = append(*fs, findings.New("categories-minimum", findings.Error,
			"a layer must map at least domain or system, plus decisions, to claim any conformance level", "leji.json"))
	}
	for _, category := range mapped {
		for _, declared := range m.Categories[category].Paths {
			if !fsx.Exists(filepath.Join(root, declared)) {
				*fs = append(*fs, findings.New("category-path-missing", findings.Error,
					category+" path does not exist", declared))
			} else if len(fsx.WalkMd(root, declared)) == 0 {
				*fs = append(*fs, findings.New("category-empty", findings.Error,
					category+" path has no markdown content; an empty category must not be mapped", declared))
			}
			if !fsx.UnderPath(declared, m.RootPath) {
				*fs = append(*fs, findings.New("paths-outside-root", findings.Warning,
					fmt.Sprintf("%s path falls outside rootPath %s", category, m.RootPath), declared))
			}
		}
	}
	for _, kv := range m.MachineEntries() {
		key, rel := kv[0], kv[1]
		if !fsx.UnderPath(rel, m.RootPath) {
			*fs = append(*fs, findings.New("paths-outside-root", findings.Warning,
				fmt.Sprintf("machine.%s falls outside rootPath %s", key, m.RootPath), rel))
		}
	}
}

func checkVendorAdapters(root string, m *manifest.Manifest, fs *[]findings.Finding) {
	declared := m.VendorAdapters
	for _, rel := range declared {
		checkDeclaredFile(root, rel, "vendor adapter", fs)
	}
	set := map[string]bool{}
	for _, r := range declared {
		set[r] = true
	}
	for _, r := range KnownVendorFiles {
		set[r] = true
	}
	candidates := make([]string, 0, len(set))
	for r := range set {
		candidates = append(candidates, r)
	}
	sort.Strings(candidates)
	for _, rel := range candidates {
		abs := filepath.Join(root, rel)
		if !fsx.IsFile(abs) {
			continue
		}
		text, _ := fsx.ReadText(abs)
		if !strings.Contains(text, m.BootProfilePath) {
			*fs = append(*fs, findings.New("vendor-adapter-redirect", findings.Error,
				fmt.Sprintf("vendor entrypoint does not redirect to the boot profile (%s)", m.BootProfilePath), rel))
		}
	}
}

func checkOwners(m *manifest.Manifest, fs *[]findings.Finding) {
	primary := m.Owners.Primary.Name
	var continuity string
	if m.Owners.Continuity != nil {
		continuity = m.Owners.Continuity.Name
	}
	if primary != "" && continuity != "" && primary == continuity {
		*fs = append(*fs, findings.New("continuity-self", findings.Warning,
			"continuity owner exists to cover the primary's absence; naming the same person provides none", "leji.json"))
	}
}

func checkAgentsMap(root string, m *manifest.Manifest, fs *[]findings.Finding) {
	profilesDir := manifest.EffectiveAgentProfilesPath(m)
	for _, role := range sortedKeys(m.Agents) {
		rel := m.Agents[role]
		if !checkDeclaredFile(root, rel, fmt.Sprintf("agents.%s profile", role), fs) {
			continue
		}
		if fsx.UnderPath(rel, profilesDir) {
			continue
		}
		text, _ := fsx.ReadText(filepath.Join(root, rel))
		fm := frontmatter.Parse(text)
		switch {
		case fm.Error != "":
			*fs = append(*fs, findings.New("profile-frontmatter", findings.Error, fm.Error, rel))
		case fm.Data == nil:
			*fs = append(*fs, findings.New("profile-frontmatter", findings.Error, "missing YAML frontmatter", rel))
		default:
			for _, e := range schemas.SchemaErrors("agent-profile", fm.Data) {
				*fs = append(*fs, findings.New("profile-frontmatter", findings.Error, e, rel))
			}
		}
	}
}

func checkFederationMounts(root string, m *manifest.Manifest, fs *[]findings.Finding) {
	if m.Federation == nil {
		return
	}
	mounts := m.Federation.Mounts
	seenPaths := map[string]bool{}
	seenNames := map[string]bool{}
	for _, mount := range mounts {
		if seenPaths[mount.Path] {
			*fs = append(*fs, findings.New("mount-duplicate", findings.Error,
				fmt.Sprintf("two mounts declare the same path %q", mount.Path), mount.Path))
		} else {
			seenPaths[mount.Path] = true
		}
		if seenNames[mount.Name] {
			*fs = append(*fs, findings.New("mount-duplicate", findings.Error,
				fmt.Sprintf("two mounts declare the same name %q", mount.Name), mount.Path))
		} else {
			seenNames[mount.Name] = true
		}
		if mount.Name == m.Name {
			*fs = append(*fs, findings.New("mount-self", findings.Error,
				fmt.Sprintf("mount %q reuses the host layer's own name", mount.Name), mount.Path))
		}
	}
	for _, mount := range mounts {
		abs := filepath.Join(root, mount.Path)
		if !fsx.Exists(abs) {
			*fs = append(*fs, findings.New("missing-declared-file", findings.Error,
				fmt.Sprintf("federation mount %q declared in leji.json does not exist", mount.Name), mount.Path))
			continue
		}
		siblingManifest := filepath.Join(abs, "leji.json")
		if !fsx.IsFile(siblingManifest) {
			*fs = append(*fs, findings.New("mount-not-a-layer", findings.Warning,
				"mounted path carries no leji.json; a sibling layer brings its own manifest", mount.Path))
			continue
		}
		text, _ := fsx.ReadText(siblingManifest)
		var sibling map[string]any
		if err := json.Unmarshal([]byte(text), &sibling); err != nil {
			*fs = append(*fs, findings.New("mount-not-a-layer", findings.Warning,
				"mounted leji.json is not valid JSON", mount.Path))
			continue
		}
		if name, ok := sibling["name"].(string); ok && name != mount.Name {
			*fs = append(*fs, findings.New("mount-name-mismatch", findings.Warning,
				fmt.Sprintf("mount declares name %q but the sibling manifest says %q", mount.Name, name), mount.Path))
		}
	}
}

func checkProfilesAndDecisions(root string, m *manifest.Manifest, fs *[]findings.Finding) {
	profiles := layer.ScanAgentProfiles(root, m)
	var ids []layer.IDItem
	knownIDs := map[string]bool{}
	for _, p := range profiles {
		*fs = append(*fs, p.Findings...)
		var id any
		if p.Frontmatter != nil {
			id = p.Frontmatter["id"]
		}
		ids = append(ids, layer.IDItem{ID: id, RelPath: p.RelPath})
		if s, ok := id.(string); ok {
			knownIDs[s] = true
		}
	}
	*fs = append(*fs, layer.DuplicateIDFindings(ids, "agent profile")...)
	for _, p := range profiles {
		if p.Frontmatter == nil {
			continue
		}
		if inherits, ok := p.Frontmatter["inherits"].(string); ok && !knownIDs[inherits] {
			*fs = append(*fs, findings.New("inherits-unknown", findings.Warning,
				fmt.Sprintf("inherits %q but no profile declares that id", inherits), p.RelPath))
		}
	}

	decisions := layer.ScanDecisionRecords(root, m)
	var decisionIDs []layer.IDItem
	for _, d := range decisions {
		*fs = append(*fs, d.Findings...)
		var id any
		if d.Frontmatter != nil {
			id = d.Frontmatter["id"]
		}
		decisionIDs = append(decisionIDs, layer.IDItem{ID: id, RelPath: d.RelPath})
	}
	*fs = append(*fs, layer.DuplicateIDFindings(decisionIDs, "decision record")...)

	validDecisions := 0
	for _, d := range decisions {
		if len(d.Findings) == 0 {
			validDecisions++
		}
	}
	if validDecisions == 0 {
		where := manifest.EffectiveDecisionRecordsPath(m)
		*fs = append(*fs, findings.New("decisions-empty", findings.Error,
			"no valid decision record found; core conformance requires at least one", where))
	}
}

func checkSchemaVersion(rel string, data any, fs *[]findings.Finding) {
	if obj, ok := data.(map[string]any); ok {
		if v, ok := obj["schemaVersion"].(string); ok && !contains(schemas.SupportedLines, v) {
			*fs = append(*fs, findings.New("schema-version", findings.Error,
				fmt.Sprintf("schemaVersion %q is not supported by this SDK", v), rel))
		}
	}
}

type changelogEntry = map[string]any

func entryDate(e changelogEntry) string {
	if d, ok := e["date"].(string); ok {
		return d
	}
	return ""
}
func entryIDStr(e changelogEntry) string {
	if s, ok := e["id"].(string); ok {
		return s
	}
	return ""
}

// CheckChangelogAppendOnly enforces append-only discipline against the git HEAD
// baseline, mirroring the Node algorithm.
func CheckChangelogAppendOnly(root, rel string, strict bool) ChangelogCheckResult {
	var fs []findings.Finding
	data, parseFinding := layer.ReadJSONArtifact(root, rel)
	if parseFinding != nil {
		return ChangelogCheckResult{Findings: []findings.Finding{*parseFinding}, Verified: false}
	}
	if data == nil {
		return ChangelogCheckResult{
			Findings: []findings.Finding{findings.New("changelog-required", findings.Error,
				"changelog "+rel+" does not exist", rel)},
			Verified: false,
		}
	}
	for _, e := range schemas.SchemaErrors("context-changelog", data) {
		fs = append(fs, findings.New("artifact-schema", findings.Error, e, rel))
	}
	checkSchemaVersion(rel, data, &fs)

	entries := extractEntries(data)
	var dupItems []layer.IDItem
	for i, e := range entries {
		dupItems = append(dupItems, layer.IDItem{ID: e["id"], RelPath: fmt.Sprintf("%s#%d", rel, i)})
	}
	for _, f := range layer.DuplicateIDFindings(dupItems, "changelog") {
		f.Path = rel
		f.HasPath = true
		fs = append(fs, f)
	}

	if _, ok := git.Toplevel(root); !ok {
		sev := findings.Warning
		if strict {
			sev = findings.Error
		}
		fs = append(fs, findings.New("changelog-unverifiable", sev,
			"not a git repository; append-only discipline cannot be verified", rel))
		return ChangelogCheckResult{Findings: fs, Verified: false}
	}
	headText, ok := git.ShowHead(root, rel)
	if !ok {
		return ChangelogCheckResult{Findings: fs, Verified: true}
	}
	var headData any
	if err := json.Unmarshal([]byte(headText), &headData); err != nil {
		return ChangelogCheckResult{Findings: fs, Verified: true}
	}
	headEntries := extractEntries(headData)

	if len(headEntries) > 0 && len(entries) == 0 {
		fs = append(fs, findings.New("changelog-append-only", findings.Error,
			"changelog compacted to empty; the compaction entry must survive", rel))
		return ChangelogCheckResult{Findings: fs, Verified: true}
	}

	newIDs := map[string]bool{}
	for _, e := range entries {
		newIDs[entryIDStr(e)] = true
	}
	// headByID / newByID mirror JS Maps keyed by id: a later entry with the same
	// id overwrites the value, but the key keeps its first-insertion position.
	headByID, headOrder := dedupByID(headEntries)
	newByID, _ := dedupByID(entries)

	// Surviving entries (present in both) are immutable, key-order-insensitive.
	// Iterate the deduplicated head map in JS Map (first-insertion) order.
	for _, id := range headOrder {
		headEntry := headByID[id]
		if current, ok := newByID[id]; ok {
			if indexgen.StableStringify(current) != indexgen.StableStringify(headEntry) {
				idText := "?"
				if id != "" {
					idText = id
				}
				fs = append(fs, findings.New("changelog-append-only", findings.Error,
					fmt.Sprintf("entry %q modified since HEAD; surviving entries are immutable", idText), rel))
				return ChangelogCheckResult{Findings: fs, Verified: true}
			}
		}
	}

	// Dropped ids must be a contiguous run from the oldest end of the canonical
	// (date, id) order.
	headCanonical := make([]changelogEntry, len(headEntries))
	copy(headCanonical, headEntries)
	sort.SliceStable(headCanonical, func(i, j int) bool {
		return compareByDateID(headCanonical[i], headCanonical[j]) < 0
	})
	var droppedIDs []string
	for _, e := range headCanonical {
		if !newIDs[entryIDStr(e)] {
			droppedIDs = append(droppedIDs, entryIDStr(e))
		}
	}
	if len(droppedIDs) > 0 {
		oldestPrefix := map[string]bool{}
		for _, e := range headCanonical[:len(droppedIDs)] {
			oldestPrefix[entryIDStr(e)] = true
		}
		fromOldestEnd := true
		for _, id := range droppedIDs {
			if !oldestPrefix[id] {
				fromOldestEnd = false
				break
			}
		}
		if !fromOldestEnd {
			n := len(droppedIDs)
			fs = append(fs, findings.New("changelog-append-only", findings.Error,
				fmt.Sprintf("%d %s removed from other than the oldest end since HEAD; only the oldest entries may be compacted", n, plural(n)), rel))
			return ChangelogCheckResult{Findings: fs, Verified: true}
		}
		hasCompaction := false
		for _, e := range entries {
			if _, inHead := headByID[entryIDStr(e)]; inHead {
				continue
			}
			if t, ok := e["type"].(string); ok && t == "compaction" {
				hasCompaction = true
				break
			}
		}
		if !hasCompaction {
			n := len(droppedIDs)
			fs = append(fs, findings.New("changelog-append-only", findings.Error,
				fmt.Sprintf("%d %s removed since HEAD without a compaction entry recording the drop", n, plural(n)), rel))
		}
	}
	return ChangelogCheckResult{Findings: fs, Verified: true}
}

// dedupByID mirrors a JS Map keyed by entry id: the value is the last entry
// with that id, but keys keep first-insertion order (returned as order).
func dedupByID(entries []changelogEntry) (map[string]changelogEntry, []string) {
	byID := map[string]changelogEntry{}
	var order []string
	for _, e := range entries {
		id := entryIDStr(e)
		if _, seen := byID[id]; !seen {
			order = append(order, id)
		}
		byID[id] = e
	}
	return byID, order
}

func compareByDateID(a, b changelogEntry) int {
	ad, bd := entryDate(a), entryDate(b)
	if ad != bd {
		if ad < bd {
			return -1
		}
		return 1
	}
	ai, bi := entryIDStr(a), entryIDStr(b)
	if ai < bi {
		return -1
	}
	if ai > bi {
		return 1
	}
	return 0
}

func extractEntries(data any) []changelogEntry {
	obj, ok := data.(map[string]any)
	if !ok {
		return nil
	}
	raw, ok := obj["entries"].([]any)
	if !ok {
		return nil
	}
	var out []changelogEntry
	for _, e := range raw {
		if m, ok := e.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// placeholderRe matches the placeholder markers a freshly scaffolded layer
// carries until it is populated: the `TODO:` lines init seeds, or any `<…>`
// angle-bracket stub.
var placeholderRe = regexp.MustCompile(`\bTODO:|<[A-Za-z][^>\n]*>`)

// unconfirmedRe matches high-stakes inferences an agent drafted but the owner has
// not confirmed yet: `TODO(confirm-invariant|gate|owner): …` markers, or
// `UNCONFIRMED:` lines. The `TODO(confirm-…)` form deliberately does not match
// placeholderRe's `TODO:`.
var unconfirmedRe = regexp.MustCompile(`TODO\(confirm[-:][^)\n]*\)|UNCONFIRMED:`)

// genericIdentity is the generic identity init writes by default; real layers replace it.
const genericIdentity = "Shared context layer for this repository."

var sectionBodyHeadingRe = regexp.MustCompile(`(?m)^#{1,6}\s+`)

// sectionBody returns the body text of the first heading whose title contains
// `heading`, up to the next heading.
func sectionBody(text, heading string) string {
	re := regexp.MustCompile(`(?im)^#{1,6}\s+.*` + regexp.QuoteMeta(heading) + `.*$`)
	loc := re.FindStringIndex(text)
	if loc == nil {
		return ""
	}
	rest := text[loc[1]:]
	if next := sectionBodyHeadingRe.FindStringIndex(rest); next != nil {
		return strings.TrimSpace(rest[:next[0]])
	}
	return strings.TrimSpace(rest)
}

var concreteBulletRe = regexp.MustCompile(`^\s*-\s+\S`)

// ContentFindings is the opt-in content lint (`validate --content`): warning-only
// signals that a layer is still a scaffold rather than real context — placeholder
// text, a generic boot identity, thin domain/system categories. Never errors and
// never affects a conformance level; this is guidance toward a layer worth reading.
func ContentFindings(root string, m *manifest.Manifest) []findings.Finding {
	var out []findings.Finding
	bootRel := m.BootProfilePath
	if fsx.IsFile(filepath.Join(root, bootRel)) {
		boot, _ := fsx.ReadText(filepath.Join(root, bootRel))
		if placeholderRe.MatchString(boot) {
			out = append(out, findings.New("content-placeholder", findings.Warning,
				"boot profile still contains placeholder text (TODO: or <…>)", bootRel))
		}
		identity := sectionBody(boot, "identity")
		if identity == "" || strings.Contains(identity, genericIdentity) || placeholderRe.MatchString(identity) {
			out = append(out, findings.New("content-identity", findings.Warning,
				"boot profile Identity is empty or generic; say what this repository is, who it serves, and its stage", bootRel))
		}
		if unconfirmedRe.MatchString(boot) {
			out = append(out, findings.New("content-unconfirmed", findings.Warning,
				"boot profile has inferences awaiting owner confirmation", bootRel))
		}
	}
	for _, cat := range []string{"domain", "system", "practice", "governance"} {
		mapping, ok := m.Categories[cat]
		if !ok {
			continue
		}
		concrete := 0
		for _, declared := range mapping.Paths {
			for _, rel := range fsx.WalkMd(root, declared) {
				text, _ := fsx.ReadText(filepath.Join(root, rel))
				if placeholderRe.MatchString(text) {
					out = append(out, findings.New("content-placeholder", findings.Warning,
						cat+" document still contains placeholder text", rel))
				}
				if unconfirmedRe.MatchString(text) {
					out = append(out, findings.New("content-unconfirmed", findings.Warning,
						cat+" document has inferences awaiting owner confirmation", rel))
				}
				for _, line := range strings.Split(text, "\n") {
					if concreteBulletRe.MatchString(line) && !placeholderRe.MatchString(line) {
						concrete++
					}
				}
			}
		}
		if (cat == "domain" || cat == "system") && concrete < 3 {
			bullets := "bullets"
			if concrete == 1 {
				bullets = "bullet"
			}
			where := ""
			if len(mapping.Paths) > 0 {
				where = mapping.Paths[0]
			}
			out = append(out, findings.New("content-thin", findings.Warning,
				fmt.Sprintf("%s has %d concrete %s; aim for at least 3 repository-specific ones", cat, concrete, bullets), where))
		}
	}
	// Decisions an agent proposed but the owner has not yet accepted.
	for _, d := range layer.ScanDecisionRecords(root, m) {
		if d.Frontmatter == nil || d.Frontmatter["status"] != "proposed" {
			continue
		}
		idText := "?"
		if id, ok := d.Frontmatter["id"].(string); ok && id != "" {
			idText = id
		}
		out = append(out, findings.New("content-unconfirmed", findings.Warning,
			fmt.Sprintf("decision %q is proposed; awaiting owner confirmation", idText), d.RelPath))
	}
	return out
}

// ValidateLayer runs the full layer validation. With content, appends the
// warning-only content lint.
func ValidateLayer(root string, content bool) Result {
	load := manifest.LoadManifest(root)
	m := load.Manifest
	fs := load.Findings
	if m == nil {
		return Result{Findings: findings.Sort(fs), Manifest: nil}
	}

	level := manifest.ClaimedLevel(m)

	// Git is required at core conformance and above (context-layer.md, Requirements):
	// history, checkout currency, and append-only integrity all derive from it. A
	// non-git working copy is a degraded read, not a canonical layer; warn rather
	// than pass it silently.
	if _, ok := git.Toplevel(root); !ok {
		fs = append(fs, findings.New("git-required", findings.Warning,
			"context layer is not in a git repository; core conformance requires git (a degraded, no-git copy cannot claim conformance)",
			"leji.json"))
	}

	checkBootProfile(root, m, &fs)
	checkCategories(root, m, &fs)
	checkVendorAdapters(root, m, &fs)
	checkOwners(m, &fs)
	checkAgentsMap(root, m, &fs)
	checkFederationMounts(root, m, &fs)
	checkProfilesAndDecisions(root, m, &fs)

	indexRel := manifest.EffectiveIndexPath(m)
	indexExists := fsx.IsFile(filepath.Join(root, indexRel))
	if manifest.LevelAtLeast(level, "indexed") || indexExists {
		if !manifest.LevelAtLeast(level, "indexed") && indexExists {
			data, pf := layer.ReadJSONArtifact(root, indexRel)
			if pf != nil {
				fs = append(fs, *pf)
			} else {
				for _, e := range schemas.SchemaErrors("context-index", data) {
					fs = append(fs, findings.New("artifact-schema", findings.Error, e, indexRel))
				}
				checkSchemaVersion(indexRel, data, &fs)
			}
		} else {
			fs = append(fs, indexgen.CheckIndex(root, m).Findings...)
		}
	}

	changelogRel := manifest.EffectiveChangelogPath(m)
	changelogExists := fsx.IsFile(filepath.Join(root, changelogRel))
	if manifest.LevelAtLeast(level, "indexed") && !changelogExists {
		fs = append(fs, findings.New("changelog-required", findings.Error,
			"changelog "+changelogRel+" does not exist", changelogRel))
	} else if changelogExists {
		fs = append(fs, CheckChangelogAppendOnly(root, changelogRel, false).Findings...)
	}

	if manifest.LevelAtLeast(level, "governed") {
		profiles := layer.ScanAgentProfiles(root, m)
		valid := 0
		for _, p := range profiles {
			if len(p.Findings) == 0 {
				valid++
			}
		}
		if valid == 0 {
			fs = append(fs, findings.New("profile-required", findings.Error,
				"governed conformance requires at least one valid agent profile",
				manifest.EffectiveAgentProfilesPath(m)))
		}
	}

	if content {
		fs = append(fs, ContentFindings(root, m)...)
	}

	return Result{Findings: findings.Sort(fs), Manifest: m}
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// plural returns the changelog entry noun for a count.
func plural(n int) string {
	if n == 1 {
		return "entry"
	}
	return "entries"
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}
