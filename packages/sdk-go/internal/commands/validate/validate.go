// Package validate performs full layer validation: manifest, level-aware artifact
// requirements, schema checks, frontmatter contracts, and lint rules.
package validate

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/indexgen"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/frontmatter"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/git"
	"github.com/leji-org/leji/packages/sdk-go/internal/layer"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
	"github.com/leji-org/leji/packages/sdk-go/internal/mountblock"
	"github.com/leji-org/leji/packages/sdk-go/internal/mounts"
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
	bootAbs := filepath.Join(root, rel)
	if !fsx.ResolvedWithinRoot(root, bootAbs) {
		*fs = append(*fs, findings.New("path-escapes-root", findings.Error, "boot profile resolves outside the layer root", rel))
		return
	}
	text, _ := fsx.ReadText(bootAbs)
	var headings []string
	for _, mm := range headingsRe.FindAllStringSubmatch(text, -1) {
		headings = append(headings, strings.ToLower(mm[1]))
	}
	// %q is safe on `section` and only on values like it: the three names are Go
	// literals, so no authored byte reaches the verb. Everywhere a diagnostic
	// interpolates authored text, this file uses raw text between literal quotes,
	// because Go's %q escapes a backslash or a non-ASCII rune that Node and Python
	// carry through unchanged.
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
		for _, indexRel := range m.Categories[category].Indexes {
			if !fsx.IsFile(filepath.Join(root, indexRel)) {
				*fs = append(*fs, findings.New("category-index-missing", findings.Error,
					category+" index file does not exist", indexRel))
			} else if !fsx.UnderPath(indexRel, m.RootPath) {
				*fs = append(*fs, findings.New("paths-outside-root", findings.Warning,
					fmt.Sprintf("%s index file falls outside rootPath %s", category, m.RootPath), indexRel))
			}
		}
	}
	// Surface index-file parse, resolution, and cross-category-conflict findings,
	// and enforce that every mapped category resolves to at least one governed
	// document (an empty leji-index block, or one that resolves to nothing, is not
	// a populated category).
	scan := layer.ScanCategories(root, m)
	*fs = append(*fs, scan.Findings...)
	populated := map[string]bool{}
	for _, d := range scan.Docs {
		populated[d.Category] = true
	}
	for _, category := range mapped {
		if !populated[category] {
			*fs = append(*fs, findings.New("category-empty", findings.Error,
				category+" resolves to no governed documents; map index entries that exist, or remove the category",
				m.Categories[category].Indexes[0]))
		}
	}
	// The domain/system minimum needs at least one intent document: a layer of
	// records alone preserves history but carries no operating context.
	minimumPopulated := (hasMapped("domain") && populated["domain"]) || (hasMapped("system") && populated["system"])
	hasIntentMinimum := false
	for _, d := range scan.Docs {
		if (d.Category == "domain" || d.Category == "system") && d.Kind == "intent" {
			hasIntentMinimum = true
			break
		}
	}
	if minimumPopulated && !hasIntentMinimum {
		*fs = append(*fs, findings.New("categories-intent-minimum", findings.Error,
			"domain/system must include at least one intent document; records alone carry no operating context", "leji.json"))
	}
	// Freshness horizons are an intent mechanism; on a record they promise a
	// currency the document cannot have.
	for _, doc := range scan.Docs {
		if doc.Kind != "record" {
			continue
		}
		if fresh, ok := doc.Frontmatter["freshness"].(map[string]any); ok {
			if _, has := fresh["reviewAfter"]; has {
				*fs = append(*fs, findings.New("freshness-on-record", findings.Error,
					"a record carries no review horizon (its date is its currency); remove freshness.reviewAfter or reclassify the document as intent",
					doc.RelPath))
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
		// A vendor entrypoint that is a symlink resolving outside the layer root is
		// not read (matches adopt, which treats such files as absent).
		if !fsx.ResolvedWithinRoot(root, abs) {
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

// checkActors covers what the manifest schema cannot express: the cross-field
// relation between an actor's declared roles and its per-role commands, and the
// collision between an actor-role command and a bound profile's own invocation. Both
// are structural contradictions, not policy: nothing here judges how many actors a
// role should have or whether it needs a profile.
// %q is safe on every value this function interpolates, and only because
// ValidateLayer returns early when the manifest failed schema validation: actor ids
// are keys under the actors patternProperties, and every role is a roleId. Both are
// `^[a-z0-9]+(-[a-z0-9]+)*$`, which cannot carry a quote, a backslash, or a
// non-ASCII rune, so %q and literal quotes emit the same bytes here.
func checkActors(root string, m *manifest.Manifest, fs *[]findings.Finding) {
	if len(m.Actors) == 0 {
		return
	}
	actorBacked := map[string]bool{}
	actorIDs := make([]string, 0, len(m.Actors))
	for id := range m.Actors {
		actorIDs = append(actorIDs, id)
	}
	sort.Strings(actorIDs)
	for _, actorID := range actorIDs {
		actor := m.Actors[actorID]
		declared := map[string]bool{}
		for _, role := range actor.Roles {
			declared[role] = true
			actorBacked[role] = true
		}
		for _, role := range actor.Roles {
			if _, ok := actor.Commands[role]; !ok {
				*fs = append(*fs, findings.New("actor-command-missing", findings.Error,
					fmt.Sprintf("actor %q declares role %q with no command for it", actorID, role), "leji.json"))
			}
		}
		commandRoles := make([]string, 0, len(actor.Commands))
		for role := range actor.Commands {
			commandRoles = append(commandRoles, role)
		}
		sort.Strings(commandRoles)
		for _, role := range commandRoles {
			if !declared[role] {
				*fs = append(*fs, findings.New("actor-command-unclaimed", findings.Error,
					fmt.Sprintf("actor %q has a command for role %q, which it does not declare in roles", actorID, role), "leji.json"))
			}
		}
	}
	for _, role := range sortedKeys(m.Agents) {
		if !actorBacked[role] {
			continue
		}
		rel := m.Agents[role]
		abs := filepath.Join(root, rel)
		if !fsx.IsFile(abs) {
			continue
		}
		// Containment-checked like the other two implementations: a profile symlink
		// escaping the layer root must not be read, or a hostile link changes which
		// actor-conflict findings appear.
		if !fsx.ResolvedWithinRoot(root, abs) {
			continue
		}
		text, _ := fsx.ReadText(abs)
		fm := frontmatter.Parse(text)
		if fm.Data == nil {
			continue
		}
		if _, has := fm.Data["invocation"]; has {
			*fs = append(*fs, findings.New("actor-profile-invocation", findings.Error,
				fmt.Sprintf("role %q is actor-backed, but its profile also declares invocation; declare the command in one place", role), rel))
		}
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
		agentAbs := filepath.Join(root, rel)
		if !fsx.ResolvedWithinRoot(root, agentAbs) {
			*fs = append(*fs, findings.New("path-escapes-root", findings.Error,
				fmt.Sprintf("agents.%s profile resolves outside the layer root", role), rel))
			continue
		}
		text, _ := fsx.ReadText(agentAbs)
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

// checkBootAgentsDefault warns when agents.default is bound AND the boot profile
// references that profile's declared path. Binding a profile at the "default" key
// never causes it to load (only the boot profile's own instructions do), so a boot
// profile that unconditionally loads it is indirection, not routing: the two should
// be one canonical boot document.
func checkBootAgentsDefault(root string, m *manifest.Manifest, fs *[]findings.Finding) {
	defaultRel, ok := m.Agents["default"]
	if !ok || defaultRel == "" {
		return
	}
	bootAbs := filepath.Join(root, m.BootProfilePath)
	if !fsx.IsFile(bootAbs) || !fsx.ResolvedWithinRoot(root, bootAbs) {
		return
	}
	boot, _ := fsx.ReadText(bootAbs)
	if !strings.Contains(boot, defaultRel) {
		return
	}
	*fs = append(*fs, findings.New("boot-agents-default", findings.Warning,
		"agents.default is bound but never auto-loaded; a boot profile that unconditionally loads it should be one canonical boot document (fold the default profile in)",
		"leji.json"))
}

func checkFederationMounts(root string, m *manifest.Manifest, fs *[]findings.Finding) {
	if m.Federation == nil {
		return
	}
	declared := m.Federation.Mounts
	// Three separated concerns (distribution.md pattern 3): declaration validity is
	// an error (the manifest lies); local availability is a warning (degraded
	// knowledge, never the build); materialization integrity belongs to
	// `mounts status`, not ordinary validation. Schema requiredness already
	// guarantees name/source/pin on every declared mount.
	seenNames := map[string]bool{}
	badNames := map[string]bool{}
	for _, mount := range declared {
		if seenNames[mount.Name] {
			// Plain quotes, never %q: Go's quoting escapes a private-use or
			// non-printable rune the reference SDKs carry through as raw UTF-8.
			*fs = append(*fs, findings.New("mount-duplicate", findings.Error,
				"two mounts declare the same name \""+mount.Name+"\"", mount.Name))
			badNames[mount.Name] = true
		} else {
			seenNames[mount.Name] = true
		}
		if mount.Name == m.Name {
			*fs = append(*fs, findings.New("mount-self", findings.Error,
				"mount \""+mount.Name+"\" reuses the host layer's own name", mount.Name))
			badNames[mount.Name] = true
		}
		// The resolver's own predicates, not a second reading of them: a source the
		// resolver cannot normalize and a trackingRef it will not follow are exactly
		// the "malformed source or pin" distribution.md calls a manifest error. Left as
		// availability, an unnormalizable source read as a mount that merely is not
		// hydrated here, which is a warning, and the lie went out as degraded weather.
		if _, ok := mounts.NormalizeSource(mount.Source); !ok {
			*fs = append(*fs, findings.New("mount-source", findings.Error,
				"mount \""+mount.Name+"\" declares a source that is not a normalizable locator; use an https://, ssh://, or SCP-style remote URL", mount.Name))
			badNames[mount.Name] = true
		}
		// An absent trackingRef is the empty string here; the schema's pattern makes an
		// explicitly empty one unrepresentable, so the two cannot be confused.
		if mount.TrackingRef != "" && !mounts.ValidTrackingRef(mount.TrackingRef) {
			*fs = append(*fs, findings.New("mount-tracking-ref", findings.Error,
				"mount \""+mount.Name+"\" declares a trackingRef that is not a fully qualified branch or tag (refs/heads/... or refs/tags/...)", mount.Name))
			badNames[mount.Name] = true
		}
	}
	// Availability is reported only for cleanly declared mounts (never for a name
	// the manifest lies about), once per name.
	warned := map[string]bool{}
	for _, mount := range declared {
		if badNames[mount.Name] || warned[mount.Name] {
			continue
		}
		warned[mount.Name] = true
		if MountProjectionDir(root, mount.Source, mount.Pin) == "" {
			*fs = append(*fs, findings.New("mount-unavailable", findings.Warning,
				"mount \""+mount.Name+"\" is not hydrated here; sibling knowledge is degraded, never the build. Run `leji mounts hydrate`.", mount.Name))
		}
	}
}

// MountSurfacingFindings checks mount surfacing (boot-profile.md requirement 9):
// a host that declares `federation.mounts` surfaces each sibling in its boot
// profile through a `leji-mounts` block, so an agent discovers siblings in the
// task-language entrypoint without reading the manifest. Every condition below is
// an error, and findings accumulate; nothing stops at the first.
//
//	| Condition | Code |
//	|---|---|
//	| mounts declared, boot profile carries no `leji-mounts` block | `mount-surfacing-block` |
//	| no mounts declared, any `leji-mounts` block (an empty one included) | `mount-surfacing-block` |
//	| malformed line, unknown/duplicate/missing field, empty or padded value | `mount-surfacing-syntax` |
//	| an entry naming a mount the manifest does not declare | `mount-surfacing-unknown` |
//	| more than one entry for one declared mount | `mount-surfacing-duplicate` |
//	| a declared mount with no entry | `mount-surfacing-missing` |
//	| an entry whose `owner` differs from the declared `owner.name` | `mount-surfacing-owner` |
//	| a declared `name` no block value could carry | `mount-name-line` |
//	| a declared `owner.name` no block value could carry | `mount-owner-name-line` |
//
// Order is deterministic and independent of the finding sort applied downstream:
// the block finding, then syntax findings in document order, then entry findings
// in document order, then missing/owner findings in declared-mount order, then the
// manifest-side identity findings in declared-mount order, `mount-name-line`
// before `mount-owner-name-line` for the same mount. `conformance` reports the
// first of them.
//
// What is deliberately not checked: whether `carries` and `read-when` faithfully
// describe the sibling. That is authored task language; presence is machine-checked
// and fidelity is the team's to attest.
func MountSurfacingFindings(root string, m *manifest.Manifest) []findings.Finding {
	var mounts []manifest.Mount
	if m.Federation != nil {
		mounts = m.Federation.Mounts
	}
	rel := m.BootProfilePath
	var fs []findings.Finding
	rootAbs, _ := filepath.Abs(root)
	abs := filepath.Join(root, rel)
	text := ""
	readable := fsx.IsFile(abs) && fsx.ResolvedWithinRoot(rootAbs, abs)
	if readable {
		var err error
		text, err = fsx.ReadText(abs)
		readable = err == nil
	}
	if !readable {
		// The structural pass already reports the missing or escaping boot profile;
		// with mounts declared it is also a surfacing failure, which conformance reads.
		if len(mounts) > 0 {
			fs = append(fs, findings.New("mount-surfacing-block", findings.Error,
				"boot profile is missing or unreadable, so it surfaces none of the declared mounts", rel))
		}
		return fs
	}

	parsed := mountblock.Parse(text)
	if len(mounts) == 0 {
		if parsed.SawBlock {
			fs = append(fs, findings.New("mount-surfacing-block", findings.Error,
				"this layer declares no federation.mounts; remove the leji-mounts block", rel))
		}
		return fs
	}

	// Declared order, first occurrence per name: a repeated name is `mount-duplicate`
	// in the manifest check, and must not also cascade through surfacing.
	var declared []manifest.Mount
	declaredNames := map[string]bool{}
	for _, mount := range mounts {
		if declaredNames[mount.Name] {
			continue
		}
		declaredNames[mount.Name] = true
		declared = append(declared, mount)
	}

	if !parsed.SawBlock {
		fs = append(fs, findings.New("mount-surfacing-block", findings.Error,
			fmt.Sprintf("%d mount(s) declared but the boot profile carries no leji-mounts block; surface each sibling there", len(declared)), rel))
	}
	for _, err := range parsed.Errors {
		fs = append(fs, findings.New("mount-surfacing-syntax", findings.Error,
			fmt.Sprintf("line %d: %s", err.Line, err.Message), rel))
	}

	surfaced := map[string]string{} // mount name -> the owner its first entry names
	for _, entry := range parsed.Entries {
		if !declaredNames[entry.Mount] {
			fs = append(fs, findings.New("mount-surfacing-unknown", findings.Error,
				fmt.Sprintf("line %d: entry names \"%s\", which this layer does not declare as a mount", entry.Line, entry.Mount), rel))
			continue
		}
		if _, seen := surfaced[entry.Mount]; seen {
			fs = append(fs, findings.New("mount-surfacing-duplicate", findings.Error,
				fmt.Sprintf("line %d: mount \"%s\" is surfaced more than once; each declared mount gets exactly one entry", entry.Line, entry.Mount), rel))
			continue
		}
		surfaced[entry.Mount] = entry.Owner
	}

	for _, mount := range declared {
		owner, ok := surfaced[mount.Name]
		if !ok {
			if parsed.SawBlock {
				fs = append(fs, findings.New("mount-surfacing-missing", findings.Error,
					"declared mount \""+mount.Name+"\" has no entry in the leji-mounts block", rel))
			}
		} else if owner != mount.Owner.Name {
			fs = append(fs, findings.New("mount-surfacing-owner", findings.Error,
				"mount \""+mount.Name+"\" is surfaced with owner \""+owner+"\" but is declared with owner \""+mount.Owner.Name+"\"", rel))
		}
	}

	// An identity the block could never carry: the declaration itself is at fault, so
	// the finding points at the manifest rather than at the boot profile. Both
	// identity fields are free strings in the schema (`name` and `owner.name` carry
	// only minLength), so both are checked, name first for the same mount.
	for _, mount := range declared {
		if bad := mountblock.ValueRepresentationError(mount.Name); bad != "" {
			fs = append(fs, findings.New("mount-name-line", findings.Error,
				"mount \""+mount.Name+"\" declares a name no leji-mounts entry could carry: "+bad, "leji.json"))
		}
		if bad := mountblock.ValueRepresentationError(mount.Owner.Name); bad != "" {
			fs = append(fs, findings.New("mount-owner-name-line", findings.Error,
				"mount \""+mount.Name+"\" declares an owner name no leji-mounts entry could carry: "+bad, "leji.json"))
		}
	}
	return fs
}

// MountProjectionDir resolves a mount's hydrated projection directory, or "" when
// the mount is not materialized here. The single implementation lives in the
// mounts resolver package; this wrapper keeps the established validate API.
func MountProjectionDir(root, source, pin string) string {
	return mounts.ProjectionDir(root, source, pin)
}

func checkProfilesAndDecisions(root string, m *manifest.Manifest, fs *[]findings.Finding) {
	profiles := layer.ScanAgentProfiles(root, m)
	var ids []layer.IDItem
	for _, p := range profiles {
		*fs = append(*fs, p.Findings...)
		var id any
		if p.Frontmatter != nil {
			id = p.Frontmatter["id"]
		}
		ids = append(ids, layer.IDItem{ID: id, RelPath: p.RelPath})
	}
	*fs = append(*fs, layer.DuplicateIDFindings(ids, "agent profile")...)
	// Authored frontmatter validates against the schema above; `inherits` is
	// operative, so every profile that declares one is also resolved, and a
	// resolution that cannot complete is an error (the derived file alone is not
	// the profile). Resolved against the whole roster, bound out-of-directory
	// profiles included.
	*fs = append(*fs, layer.ProfileInheritanceFindings(layer.ScanProfileSet(root, m))...)

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
	checkSupersession(decisions, fs)

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

type supersedeRec struct {
	id              string
	status          string
	supersedes      string
	supersededBy    string
	relPath         string
	hasSupersedes   bool
	hasSupersededBy bool
}

// checkSupersession enforces the across-record half of decision supersession
// (decisions.md): the schema enforces the within-record half (a superseded record
// carries supersededBy). For "B supersedes A": A must exist, be superseded, and point
// supersededBy back at B. For a superseded record with supersededBy: B, B must exist
// and declare supersedes back. supersededBy on a non-superseded record is rejected, and
// supersession cycles are reported. Without this both A and B can route as live.
func checkSupersession(decisions []layer.ScannedProfile, fs *[]findings.Finding) {
	var recs []supersedeRec
	byID := map[string]supersedeRec{}
	for _, d := range decisions {
		if d.Frontmatter == nil {
			continue
		}
		id, ok := d.Frontmatter["id"].(string)
		if !ok {
			continue
		}
		rec := supersedeRec{id: id, relPath: d.RelPath}
		if s, ok := d.Frontmatter["status"].(string); ok {
			rec.status = s
		}
		if s, ok := d.Frontmatter["supersedes"].(string); ok {
			rec.supersedes = s
			rec.hasSupersedes = true
		}
		if s, ok := d.Frontmatter["supersededBy"].(string); ok {
			rec.supersededBy = s
			rec.hasSupersededBy = true
		}
		recs = append(recs, rec)
		if _, seen := byID[id]; !seen {
			byID[id] = rec
		}
	}
	emit := func(msg, relPath string) {
		*fs = append(*fs, findings.New("decision-supersession", findings.Error, msg, relPath))
	}
	statusOr := func(s string) string {
		if s == "" {
			return "unset"
		}
		return s
	}
	for _, r := range recs {
		if r.hasSupersededBy && r.status != "superseded" {
			emit("supersededBy is set but status is \""+statusOr(r.status)+"\", not \"superseded\"", r.relPath)
		}
		if r.hasSupersedes {
			target, ok := byID[r.supersedes]
			if !ok {
				emit("supersedes \""+r.supersedes+"\" but no decision record has that id", r.relPath)
			} else {
				if target.status != "superseded" {
					emit("is superseded by \""+r.id+"\", so its status must be \"superseded\" but is \""+statusOr(target.status)+"\"", target.relPath)
				}
				if target.supersededBy != r.id {
					emit("is superseded by \""+r.id+"\", but its supersededBy does not point back to \""+r.id+"\"", target.relPath)
				}
			}
		}
		if r.hasSupersededBy {
			successor, ok := byID[r.supersededBy]
			if !ok {
				emit("supersededBy \""+r.supersededBy+"\" but no decision record has that id", r.relPath)
			} else if successor.supersedes != r.id {
				emit("supersededBy \""+r.supersededBy+"\", but that record does not declare supersedes \""+r.id+"\"", r.relPath)
			}
		}
	}
	// Cycle detection over supersedes edges (id -> the id it supersedes).
	color := map[string]int{} // 0 unvisited, 1 in-progress, 2 done
	onCycle := map[string]bool{}
	var visit func(id string, stack []string)
	visit = func(id string, stack []string) {
		switch color[id] {
		case 2:
			return
		case 1:
			for i := len(stack) - 1; i >= 0; i-- {
				onCycle[stack[i]] = true
				if stack[i] == id {
					break
				}
			}
			return
		}
		color[id] = 1
		next := append(append([]string{}, stack...), id)
		if r, ok := byID[id]; ok && r.hasSupersedes {
			if _, exists := byID[r.supersedes]; exists {
				visit(r.supersedes, next)
			}
		}
		color[id] = 2
	}
	for _, r := range recs {
		visit(r.id, nil)
	}
	for _, r := range recs {
		if onCycle[r.id] {
			emit("decision \""+r.id+"\" is part of a supersession cycle", r.relPath)
		}
	}
}

func checkSchemaVersion(rel string, data any, fs *[]findings.Finding) {
	if obj, ok := data.(map[string]any); ok {
		if v, ok := obj["schemaVersion"].(string); ok && !contains(schemas.SupportedLines, v) {
			*fs = append(*fs, findings.New("schema-version", findings.Error,
				"schemaVersion \""+v+"\" is not supported by this SDK", rel))
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
		// No committed state to compare against: an unborn repository, or a changelog
		// not yet in HEAD. Append-only discipline is unverifiable here, not satisfied.
		return ChangelogCheckResult{Findings: fs, Verified: false}
	}
	var headData any
	if err := json.Unmarshal([]byte(headText), &headData); err != nil {
		// The HEAD blob is unparseable, so it yields no baseline to compare against.
		return ChangelogCheckResult{Findings: fs, Verified: false}
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
					"entry \""+idText+"\" modified since HEAD; surviving entries are immutable", rel))
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
		var appendedCompactions []changelogEntry
		for _, e := range entries {
			if _, inHead := headByID[entryIDStr(e)]; inHead {
				continue
			}
			if t, ok := e["type"].(string); ok && t == "compaction" {
				appendedCompactions = append(appendedCompactions, e)
			}
		}
		n := len(droppedIDs)
		switch {
		case len(appendedCompactions) == 0:
			fs = append(fs, findings.New("changelog-append-only", findings.Error,
				fmt.Sprintf("%d %s removed since HEAD without a compaction entry recording the drop", n, plural(n)), rel))
		case len(appendedCompactions) > 1:
			fs = append(fs, findings.New("changelog-append-only", findings.Error,
				fmt.Sprintf("%d compaction entries were appended for one drop; a drop records exactly one", len(appendedCompactions)), rel))
		default:
			// The single appended compaction must accurately record the dropped run.
			cEntries, cFirst, cLast := "?", "?", "?"
			if c, ok := appendedCompactions[0]["compacted"].(map[string]any); ok {
				if v, ok := c["entries"].(float64); ok {
					cEntries = strconv.Itoa(int(v))
				}
				if v, ok := c["firstId"].(string); ok {
					cFirst = v
				}
				if v, ok := c["lastId"].(string); ok {
					cLast = v
				}
			}
			firstDropped, lastDropped := droppedIDs[0], droppedIDs[n-1]
			if cEntries != strconv.Itoa(n) || cFirst != firstDropped || cLast != lastDropped {
				fs = append(fs, findings.New("changelog-append-only", findings.Error,
					fmt.Sprintf("compaction entry records %s entries (%s..%s) but %d were dropped (%s..%s)",
						cEntries, cFirst, cLast, n, firstDropped, lastDropped), rel))
			}
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

// unconfirmedRe matches unconfirmed high-stakes inferences: `TODO(confirm-…)`
// markers or `UNCONFIRMED:` lines. The `TODO(confirm-…)` form deliberately does
// not match placeholderRe's `TODO:`.
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
// signals that a layer is still a scaffold (placeholder text, generic boot identity,
// thin domain/system categories). Never errors, never affects a conformance level.
func ContentFindings(root string, m *manifest.Manifest) []findings.Finding {
	var out []findings.Finding
	bootRel := m.BootProfilePath
	// Confine the read: a symlinked boot profile escaping root is skipped (the
	// structural pass already flags it). Content lint is advisory.
	bootAbs := filepath.Join(root, bootRel)
	if fsx.IsFile(bootAbs) && fsx.ResolvedWithinRoot(root, bootAbs) {
		boot, _ := fsx.ReadText(bootAbs)
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
	type catDoc struct {
		relPath string
		text    string
	}
	docsByCat := map[string][]catDoc{}
	for _, doc := range layer.ScanCategories(root, m).Docs {
		text, _ := fsx.ReadText(filepath.Join(root, doc.RelPath))
		docsByCat[doc.Category] = append(docsByCat[doc.Category], catDoc{relPath: doc.RelPath, text: text})
	}
	for _, cat := range []string{"domain", "system", "practice", "governance"} {
		mapping, ok := m.Categories[cat]
		if !ok {
			continue
		}
		concrete := 0
		for _, d := range docsByCat[cat] {
			if placeholderRe.MatchString(d.text) {
				out = append(out, findings.New("content-placeholder", findings.Warning,
					cat+" document still contains placeholder text", d.relPath))
			}
			if unconfirmedRe.MatchString(d.text) {
				out = append(out, findings.New("content-unconfirmed", findings.Warning,
					cat+" document has inferences awaiting owner confirmation", d.relPath))
			}
			for _, line := range strings.Split(d.text, "\n") {
				if concreteBulletRe.MatchString(line) && !placeholderRe.MatchString(line) {
					concrete++
				}
			}
		}
		if (cat == "domain" || cat == "system") && concrete < 3 {
			bullets := "bullets"
			if concrete == 1 {
				bullets = "bullet"
			}
			where := ""
			if len(mapping.Indexes) > 0 {
				where = mapping.Indexes[0]
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
			"decision \""+idText+"\" is proposed; awaiting owner confirmation", d.RelPath))
	}
	return out
}

// ValidateLayer runs the full layer validation; with content, appends the content lint.
func ValidateLayer(root string, content bool) (Result, error) {
	load := manifest.LoadManifest(root)
	m := load.Manifest
	fs := load.Findings
	if m == nil {
		return Result{Findings: findings.Sort(fs), Manifest: nil}, nil
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
	checkActors(root, m, &fs)
	checkBootAgentsDefault(root, m, &fs)
	checkFederationMounts(root, m, &fs)
	fs = append(fs, MountSurfacingFindings(root, m)...)
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
			// CheckIndex covers schema, schemaVersion, and currency. It re-runs the
			// category scan to generate the expected index, so every parse, conflict and
			// resolution finding the scan above already contributed comes back a second
			// time; one bad index-file line was reported twice. Deduplicated by the same
			// identity relation resolution uses, because two findings with the same rule,
			// severity, message and path are the same finding to every reader.
			alreadyReported := map[string]bool{}
			for _, f := range fs {
				alreadyReported[layer.FindingKey(f)] = true
			}
			checked, cerr := indexgen.CheckIndex(root, m)
			if cerr != nil {
				return Result{}, cerr
			}
			for _, f := range checked.Findings {
				if !alreadyReported[layer.FindingKey(f)] {
					fs = append(fs, f)
				}
			}
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

	return Result{Findings: findings.Sort(fs), Manifest: m}, nil
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

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
