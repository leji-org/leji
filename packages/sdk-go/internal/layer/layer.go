// Package layer holds shared layer scanning: category docs, agent profiles,
// decision records, duplicate-id detection, and JSON artifact reads.
package layer

import (
	"encoding/json"
	"fmt"
	"math"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/frontmatter"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/indexfile"
	"github.com/leji-org/leji/packages/sdk-go/internal/jsonenc"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
	"github.com/leji-org/leji/packages/sdk-go/internal/schemas"
)

type ScannedDoc struct {
	RelPath  string
	Category string
	// Kind is the document's resolved kind (winning selector, then
	// frontmatter override; decision-category documents are inherently records).
	Kind        string
	Frontmatter map[string]any
	Body        string
}

type ScannedProfile struct {
	RelPath     string
	Frontmatter map[string]any
	// Keys is the frontmatter's authored key order (a Go map has none); the
	// effective profile inheritance composes is presented in that order.
	Keys []string
	// Body is the document body after the frontmatter block; inheritance composes it.
	Body     string
	Findings []findings.Finding
}

// excludedFromCategories returns a predicate for files that must not be treated
// as category content (layer chrome). READMEs are NOT chrome: a directory
// expansion skips them (repo furniture by default), but an explicit file
// selector governs one deliberately, because in real repositories section
// READMEs are often the section's landing document.
func excludedFromCategories(m *manifest.Manifest) func(string) bool {
	profilesDir := manifest.EffectiveAgentProfilesPath(m)
	return func(relPath string) bool {
		if relPath == m.BootProfilePath {
			return true
		}
		if fsx.UnderPath(relPath, profilesDir) {
			return true
		}
		return false
	}
}

// CategoryScan is the governed document set plus the resolution findings.
type CategoryScan struct {
	Docs     []ScannedDoc
	Findings []findings.Finding
}

// selector is an index entry as a selector: what it covers, and what the covered
// documents are assigned (category from the manifest's index-file binding, kind
// from the entry's block). Specificity: a direct file selector beats any
// directory selector; between directory selectors, deeper beats shallower.
type selector struct {
	path           string
	category       string
	kind           string
	indexRel       string
	isFileSelector bool
	depth          int
	// covered holds the markdown paths this selector resolves to.
	covered []string
}

// rank is the ordered specificity rank; higher wins. File selectors outrank
// every directory selector regardless of depth.
func rank(s *selector) int {
	if s.isFileSelector {
		return math.MaxInt
	}
	return s.depth
}

// expandEntry expands one parsed entry to its markdown paths, with per-entry
// diagnostics (a typo, a non-markdown file, and an empty directory each get a
// distinct finding instead of collapsing to one warning). Returns ok=false when
// the entry does not resolve.
func expandEntry(root, indexRel, entryPath string, fs *[]findings.Finding) (covered []string, isFileSelector bool, skippedReadmes []string, ok bool) {
	abs := filepath.Join(root, entryPath)
	if !fsx.Exists(abs) {
		*fs = append(*fs, findings.New("index-entry-missing", findings.Error,
			// Plain quotes, never %q: an index entry is arbitrary authored text, and
			// Go's quoting escapes a backslash or a non-ASCII rune (U+00A0 became
			// `\u00a0`) that Node and Python interpolate raw, so the same defect read as
			// two different paths depending on which SDK reported it.
			"entry \""+entryPath+"\" does not exist", indexRel))
		return nil, false, nil, false
	}
	if fsx.IsFile(abs) {
		if !strings.HasSuffix(entryPath, ".md") {
			*fs = append(*fs, findings.New("index-entry-not-markdown", findings.Error,
				"entry \""+entryPath+"\" is not a markdown file", indexRel))
			return nil, false, nil, false
		}
		md := fsx.WalkMd(root, entryPath) // [entryPath] unless a symlink escapes root
		if len(md) == 0 {
			*fs = append(*fs, findings.New("index-entry-missing", findings.Error,
				"entry \""+entryPath+"\" escapes the layer root", indexRel))
			return nil, false, nil, false
		}
		return md, true, nil, true
	}
	if fsx.IsDir(abs) {
		// Directory expansion skips READMEs (repo furniture by default); an
		// explicit file selector includes one deliberately. The skips are reported
		// so the carve-out is never silent (leji status surfaces them).
		all := fsx.WalkMd(root, entryPath)
		var md, skipped []string
		for _, p := range all {
			if strings.ToLower(path.Base(p)) == "readme.md" {
				skipped = append(skipped, p)
			} else {
				md = append(md, p)
			}
		}
		if len(md) == 0 {
			*fs = append(*fs, findings.New("index-entry-empty", findings.Warning,
				"directory entry \""+entryPath+"\" contains no markdown", indexRel))
		}
		return md, false, skipped, true
	}
	*fs = append(*fs, findings.New("index-entry-missing", findings.Error,
		"entry \""+entryPath+"\" is neither a file nor a directory", indexRel))
	return nil, false, nil, false
}

// collectSelectors collects every selector across every mapped category, with
// parse/expansion findings. Category order (manifest.CategoryIDs) and entry
// order are preserved so diagnostics are deterministic across the three SDKs.
func collectSelectors(root string, m *manifest.Manifest) ([]*selector, []findings.Finding, []ShadowedSelector) {
	var selectors []*selector
	var fs []findings.Finding
	var skippedReadmes []ShadowedSelector
	rootAbs, _ := filepath.Abs(root)
	for _, category := range manifest.CategoryIDs {
		mapping, ok := m.Categories[category]
		if !ok {
			continue
		}
		for _, indexRel := range mapping.Indexes {
			abs := filepath.Join(root, indexRel)
			text := ""
			readable := fsx.IsFile(abs) && fsx.ResolvedWithinRoot(rootAbs, abs)
			if readable {
				var err error
				text, err = fsx.ReadText(abs)
				readable = err == nil
			}
			if !readable {
				fs = append(fs, findings.New("index-file-missing", findings.Error,
					category+" index file is missing or escapes the layer root", indexRel))
				continue
			}
			parsed := indexfile.Parse(text)
			for _, e := range parsed.Errors {
				fs = append(fs, findings.New("index-file-parse", findings.Error, e, indexRel))
			}
			for _, entry := range parsed.Entries {
				covered, isFile, skipped, ok := expandEntry(root, indexRel, entry.Path, &fs)
				if !ok {
					continue
				}
				selectors = append(selectors, &selector{
					path:           entry.Path,
					category:       category,
					kind:           entry.Kind,
					indexRel:       indexRel,
					isFileSelector: isFile,
					depth:          len(strings.Split(strings.TrimRight(entry.Path, "/"), "/")),
					covered:        covered,
				})
				for _, rel := range skipped {
					skippedReadmes = append(skippedReadmes, ShadowedSelector{IndexRel: indexRel, Path: rel})
				}
			}
		}
	}
	return selectors, fs, skippedReadmes
}

// ResolveCategoryPaths resolves one category's index files to the repo-relative
// markdown paths they include, honoring selector specificity: a document covered
// by this category's selectors but won by a more-specific selector of another
// category is excluded. Problems surface as findings, never panics.
func ResolveCategoryPaths(root string, m *manifest.Manifest, category string) ([]string, []findings.Finding) {
	res := ResolveCategoryAssignments(root, m, true)
	keys := make([]string, 0, len(res.Assignments))
	for k := range res.Assignments {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var paths []string
	for _, relPath := range keys {
		if res.Assignments[relPath].Category == category {
			paths = append(paths, relPath)
		}
	}
	return paths, res.Findings
}

// Assignment is a document's resolved assignment: its single category, the
// winning selector's kind (before any frontmatter override), and the index file
// that declared the winning selector (the viewer groups by it).
type Assignment struct {
	Category string
	Kind     string
	IndexRel string
}

// ShadowedSelector is a broad selector fully displaced by more-specific ones.
type ShadowedSelector struct {
	IndexRel string
	Path     string
}

// AssignmentResolution is the governed set resolved without reading document
// frontmatter.
type AssignmentResolution struct {
	Assignments map[string]Assignment
	Findings    []findings.Finding
	Shadowed    []ShadowedSelector
	// SkippedReadmes are READMEs inside listed directories that expansion
	// skipped and no explicit selector governs.
	SkippedReadmes []ShadowedSelector
}

// ResolveCategoryAssignments resolves the governed set without reading document
// frontmatter: each governed path mapped to its single category and block kind by
// the most-specific selector (file beats directory, deeper directory beats
// ancestor). Selectors of equal specificity that disagree on category or kind are
// hard errors; identical assignments resolve once. Broad selectors fully
// displaced by more-specific ones are reported as Shadowed (informational; `leji
// status` surfaces them). ScanCategories adds frontmatter on top.
func ResolveCategoryAssignments(root string, m *manifest.Manifest, includeExcluded bool) AssignmentResolution {
	excluded := excludedFromCategories(m)
	selectors, fs, rawSkips := collectSelectors(root, m)

	// Group candidate selectors per document.
	byDoc := map[string][]*selector{}
	for _, s := range selectors {
		for _, relPath := range s.covered {
			if !includeExcluded && excluded(relPath) {
				continue
			}
			byDoc[relPath] = append(byDoc[relPath], s)
		}
	}
	docPaths := make([]string, 0, len(byDoc))
	for p := range byDoc {
		docPaths = append(docPaths, p)
	}
	sort.Strings(docPaths)

	assignments := map[string]Assignment{}
	winners := map[*selector]bool{}
	for _, relPath := range docPaths {
		cands := byDoc[relPath]
		top := rank(cands[0])
		for _, s := range cands[1:] {
			if r := rank(s); r > top {
				top = r
			}
		}
		var best []*selector
		for _, s := range cands {
			if rank(s) == top {
				best = append(best, s)
			}
		}
		first := best[0]
		var other *selector
		for _, s := range best {
			if s.category != first.category || s.kind != first.kind {
				other = s
				break
			}
		}
		if other != nil {
			// Deterministic message: name the two clashing assignments in category order.
			fs = append(fs, findings.New("category-conflict", findings.Error,
				fmt.Sprintf("%s is selected with equal specificity as %s/%s (%s) and %s/%s (%s); a document resolves to exactly one category and kind",
					relPath, first.category, first.kind, first.indexRel, other.category, other.kind, other.indexRel),
				relPath))
			continue
		}
		for _, s := range best {
			winners[s] = true
		}
		assignments[relPath] = Assignment{Category: first.category, Kind: first.kind, IndexRel: first.indexRel}
	}

	// A selector that covered documents but won none is fully shadowed by
	// more-specific selectors: dead weight worth surfacing, never an error.
	var shadowed []ShadowedSelector
	for _, s := range selectors {
		coveredGoverned := 0
		for _, p := range s.covered {
			if includeExcluded || !excluded(p) {
				coveredGoverned++
			}
		}
		if coveredGoverned == 0 {
			continue
		}
		if !winners[s] {
			shadowed = append(shadowed, ShadowedSelector{IndexRel: s.indexRel, Path: s.path})
		}
	}

	// A README skipped by directory expansion is only reportable while it stays
	// ungoverned: an explicit file selector elsewhere resolves the carve-out.
	seenSkip := map[string]bool{}
	var skippedReadmes []ShadowedSelector
	for _, sk := range rawSkips {
		if _, governed := assignments[sk.Path]; governed {
			continue
		}
		key := sk.IndexRel + "\x00" + sk.Path
		if seenSkip[key] {
			continue
		}
		seenSkip[key] = true
		skippedReadmes = append(skippedReadmes, sk)
	}

	return AssignmentResolution{Assignments: assignments, Findings: fs, Shadowed: shadowed, SkippedReadmes: skippedReadmes}
}

// docKinds are the valid frontmatter kinds; anything else present is a hard error.
var docKinds = []string{indexfile.KindIntent, indexfile.KindRecord}

// ScanCategories collects governed category documents, sorted by relPath, each
// carrying its resolved kind.
func ScanCategories(root string, m *manifest.Manifest) CategoryScan {
	res := ResolveCategoryAssignments(root, m, false)
	fs := res.Findings
	keys := make([]string, 0, len(res.Assignments))
	for k := range res.Assignments {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	docs := make([]ScannedDoc, 0, len(keys))
	for _, relPath := range keys {
		a := res.Assignments[relPath]
		text, _ := fsx.ReadText(filepath.Join(root, relPath))
		fm := frontmatter.Parse(text)
		// Decision-category documents are inherently records; their (closed)
		// schema rejects an explicit `kind`, so no override applies.
		kind := a.Kind
		if a.Category == "decisions" {
			kind = indexfile.KindRecord
		}
		var fmKind any
		hasFmKind := false
		if fm.Data != nil {
			fmKind, hasFmKind = fm.Data["kind"]
		}
		if hasFmKind && a.Category != "decisions" {
			if s, ok := fmKind.(string); ok && containsStr(docKinds, s) {
				// Frontmatter overrides the block kind, never the category.
				kind = s
			} else {
				encoded, _ := jsonenc.Marshal(fmKind)
				fs = append(fs, findings.New("kind-invalid", findings.Error,
					fmt.Sprintf("frontmatter kind must be intent or record; got %s", encoded), relPath))
			}
		}
		docs = append(docs, ScannedDoc{
			RelPath:     relPath,
			Category:    a.Category,
			Kind:        kind,
			Frontmatter: fm.Data,
			Body:        fm.Body,
		})
	}
	return CategoryScan{Docs: docs, Findings: fs}
}

func containsStr(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// scanFrontmatterArtifact parses and validates one frontmatter artifact's text:
// an unparseable block, a missing block, and every schema violation, each under
// the caller's rule name. The single per-file path, so every scan that produces a
// ScannedProfile produces the same findings for the same bytes and no caller can
// hand back an artifact whose validity was never established.
func scanFrontmatterArtifact(text, relPath, schemaName, rule string) ScannedProfile {
	fm := frontmatter.Parse(text)
	var fs []findings.Finding
	switch {
	case fm.Error != "":
		fs = append(fs, findings.New(rule, findings.Error, fm.Error, relPath))
	case fm.Data == nil:
		fs = append(fs, findings.New(rule, findings.Error, "missing YAML frontmatter", relPath))
	default:
		for _, e := range schemas.SchemaErrors(schemaName, fm.Data) {
			fs = append(fs, findings.New(rule, findings.Error, e, relPath))
		}
	}
	return ScannedProfile{RelPath: relPath, Frontmatter: fm.Data, Keys: fm.Keys, Body: fm.Body, Findings: fs}
}

// ArtifactReader is how a scan gets one artifact's bytes, and whether it may have
// them at all. The default reads by path; a caller composing something it will serve
// or export passes a reader that binds the check to the read (check-before-act), and returns false
// for a source it refuses — missing, not a regular file, or resolving somewhere it
// may not be read from. A refused artifact is dropped from the scan, exactly as the
// whitelist filter it replaces dropped it, so validation (which passes no reader) is
// unaffected.
type ArtifactReader func(relPath string) (string, bool)

func scanFrontmatterArtifacts(root, dir, schemaName, rule string, read ArtifactReader) []ScannedProfile {
	var out []ScannedProfile
	for _, relPath := range fsx.WalkMd(root, dir) {
		if strings.ToLower(path.Base(relPath)) == "readme.md" {
			continue
		}
		var text string
		if read == nil {
			text, _ = fsx.ReadText(filepath.Join(root, relPath))
		} else {
			var ok bool
			if text, ok = read(relPath); !ok {
				continue
			}
		}
		out = append(out, scanFrontmatterArtifact(text, relPath, schemaName, rule))
	}
	return out
}

func ScanAgentProfiles(root string, m *manifest.Manifest) []ScannedProfile {
	dir := manifest.EffectiveAgentProfilesPath(m)
	return scanFrontmatterArtifacts(root, dir, "agent-profile", "profile-frontmatter", nil)
}

// ScanProfileSet is the profile set inheritance resolves against: the
// agentProfilesPath scan plus any `agents`-bound profile living outside that
// directory (a bound profile is part of the layer's roster wherever it sits, so it
// can be an inheritance target and it counts toward target ambiguity). Sorted by
// path so ambiguity messages and finding order are deterministic.
//
// Out-of-directory entries are validated here, by the same per-file path the
// directory scan uses, so every profile in the set carries its own findings. A
// profile whose validity was never established is exactly the one a resolver
// would compose into an effective profile and a viewer would render as governing
// posture. The agents-map check validates these files too and emits byte-identical
// findings, so ProfileInheritanceFindings collapses the pair rather than
// reporting either twice.
func ScanProfileSet(root string, m *manifest.Manifest) []ScannedProfile {
	return ScanProfileSetWith(root, m, nil)
}

// ScanProfileSetWith is the same scan through a caller's reader — the seam a viewer
// or export needs and nobody else does. A nil reader is ScanProfileSet's own
// read-by-path behavior.
func ScanProfileSetWith(root string, m *manifest.Manifest, read ArtifactReader) []ScannedProfile {
	dir := manifest.EffectiveAgentProfilesPath(m)
	profiles := scanFrontmatterArtifacts(root, dir, "agent-profile", "profile-frontmatter", read)
	seen := map[string]bool{}
	for _, p := range profiles {
		seen[p.RelPath] = true
	}
	rootAbs, _ := filepath.Abs(root)
	for _, rel := range sortedValues(m.Agents) {
		if seen[rel] || fsx.UnderPath(rel, dir) {
			continue
		}
		var text string
		if read == nil {
			abs := filepath.Join(root, rel)
			if !fsx.IsFile(abs) || !fsx.ResolvedWithinRoot(rootAbs, abs) {
				continue // missing or escaping: the agents-map check owns that
			}
			var err error
			if text, err = fsx.ReadText(abs); err != nil {
				continue
			}
		} else {
			var ok bool
			if text, ok = read(rel); !ok {
				continue
			}
		}
		seen[rel] = true
		profiles = append(profiles, scanFrontmatterArtifact(text, rel, "agent-profile", "profile-frontmatter"))
	}
	// Go's string comparison is UTF-8 byte order: the byteCompare the TS scan sorts by.
	sort.SliceStable(profiles, func(i, j int) bool { return profiles[i].RelPath < profiles[j].RelPath })
	return profiles
}

// sortedValues iterates an agents map deterministically. Object.values() follows
// insertion order in Node; a Go map iterates at random, and the set is sorted
// immediately afterwards, so key order is the stable stand-in.
func sortedValues(agents map[string]string) []string {
	roles := make([]string, 0, len(agents))
	for role := range agents {
		roles = append(roles, role)
	}
	sort.Strings(roles)
	out := make([]string, 0, len(roles))
	for _, role := range roles {
		out = append(out, agents[role])
	}
	return out
}

// PostureKeys are the frontmatter arrays that compose across an inheritance edge.
// Every other field is the derived profile's own; none of them is ever inherited.
var PostureKeys = []string{"requiredRead", "defaultContext", "mustAskWhen", "mustRefuseWhen"}

// ResolvedProfile is the effective profile after single-level inheritance
// resolution. On a resolution error Frontmatter and Body are nil: there is no
// partial effective profile to apply, only findings.
type ResolvedProfile struct {
	Frontmatter map[string]any
	// Keys is the effective frontmatter's presentation order.
	Keys []string
	Body *string
	// SourceIDs is [baseId, derivedId] when inheritance resolved, [id] when the
	// profile stands alone, empty on a resolution error.
	SourceIDs []string
	Findings  []findings.Finding
}

// bodyHalf is one body as the effective profile carries it. Both bodies are
// normative, so only two things are canonicalized: line endings become LF, and the
// boundary blank lines (the newline the frontmatter fence leaves in front, any run
// of newlines at the end) collapse to one trailing newline. Nothing else is
// touched: no whitespace is stripped from a line, so a leading indented code block
// and a trailing hard break both survive resolution byte for byte.
func bodyHalf(raw string) string {
	s := strings.ReplaceAll(raw, "\r\n", "\n")
	return strings.TrimRight(strings.TrimLeft(s, "\n"), "\n") + "\n"
}

// profileIDRe is a profile id as the schema patterns it. Resolution interpolates
// ids into the effective body's comment markers, so an id that is not
// identifier-shaped is refused before interpolation rather than allowed to close
// or forge a marker.
var profileIDRe = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// findingKeySep is U+001F (ASCII UNIT SEPARATOR), written as an escape so every
// source file stays plain ASCII text: three literal NUL bytes used to sit in the
// Node reference here, which made every `grep` treat the whole file as binary and
// skip it without saying so. It is also why the relation has to be spelled the same
// in all three SDKs, where a space stood in for it. A control character cannot
// appear in a governed path, a rule id, or a severity, so unlike any graphic
// character it cannot make two different findings key alike.
const findingKeySep = "\u001f"

// FindingKey is a finding's identity, so resolution never re-reports one a scan
// already carries.
func FindingKey(f findings.Finding) string {
	return f.Path + findingKeySep + f.Rule + findingKeySep + f.Severity + findingKeySep + f.Message
}

// postureKey is a posture entry's identity for duplicate removal: the decoded
// string compared by its UTF-8 encoding (Go string equality is the same relation
// for scalar strings). Non-string entries are schema violations; key them
// structurally so resolution stays total rather than failing on an invalid profile.
func postureKey(value any) string {
	if s, ok := value.(string); ok {
		return "s" + s
	}
	encoded, err := jsonenc.Marshal(value)
	if err != nil {
		return "jundefined"
	}
	return "j" + string(encoded)
}

// composePosture puts base entries in their authored order, then the derived
// entries that the base does not already carry, in theirs. No sorting: authored
// order is loading intent. A derived value that is not an array is a schema
// violation the authored-frontmatter check already reports; it contributes nothing
// here rather than replacing the base.
func composePosture(baseValue, derivedValue any) any {
	derived, derivedIsArray := derivedValue.([]any)
	base, baseIsArray := baseValue.([]any)
	if !derivedIsArray {
		if baseIsArray {
			return append([]any{}, base...)
		}
		return derivedValue
	}
	if !baseIsArray {
		return derivedValue
	}
	inBase := map[string]bool{}
	for _, v := range base {
		inBase[postureKey(v)] = true
	}
	out := append([]any{}, base...)
	for _, v := range derived {
		if !inBase[postureKey(v)] {
			out = append(out, v)
		}
	}
	return out
}

// ResolveAgentProfile resolves one agent profile's `inherits` against the layer's
// profile set: single level, to exactly one `role: core` base that itself inherits
// nothing. Posture arrays union base-first with exact duplicates dropped; every
// other field, `inherits` included, is the derived profile's own; both bodies are
// operative, base first, each behind a marker naming its source. A profile that
// declares no `inherits` resolves to itself.
//
// Resolution is all-or-nothing. A source profile carrying an error finding, an
// inheritance that does not satisfy the single-level rules, or an effective
// profile that would still lack `requiredRead` or `mustAskWhen` all come back as
// findings with Frontmatter and Body nil: there is no half-resolved profile for a
// caller to apply. Never fails.
func ResolveAgentProfile(derived ScannedProfile, profiles []ScannedProfile) ResolvedProfile {
	fm := derived.Frontmatter
	derivedID, _ := fm["id"].(string)
	refuse := func(fs []findings.Finding) ResolvedProfile {
		return ResolvedProfile{Findings: fs}
	}
	unresolvedAt := func(rule, message, at string) ResolvedProfile {
		return refuse([]findings.Finding{findings.New(rule, findings.Error, message, at)})
	}
	unresolved := func(rule, message string) ResolvedProfile {
		return unresolvedAt(rule, message, derived.RelPath)
	}
	// A source the scan already found invalid is not resolvable material: its
	// findings carry forward rather than being restated in resolution's own words.
	errorsOn := func(p ScannedProfile) []findings.Finding {
		var out []findings.Finding
		for _, f := range p.Findings {
			if f.Severity == findings.Error {
				out = append(out, f)
			}
		}
		return out
	}

	if fm == nil {
		return refuse(errorsOn(derived))
	}
	inherits, inheritsIsString := fm["inherits"].(string)
	if !inheritsIsString {
		if own := errorsOn(derived); len(own) > 0 {
			return refuse(own)
		}
		body := bodyHalf(derived.Body)
		return ResolvedProfile{Frontmatter: fm, Keys: derived.Keys, Body: &body, SourceIDs: []string{derivedID}}
	}
	if derivedErrors := errorsOn(derived); len(derivedErrors) > 0 {
		return refuse(derivedErrors)
	}

	// A core profile is the base of the single level, so it inherits nothing. This
	// also covers a core profile naming itself.
	if role, _ := fm["role"].(string); role == "core" {
		return unresolved("inherits-on-core",
			"role is core but inherits \""+inherits+"\"; a core profile is the base of the single inheritance level and inherits nothing")
	}
	var targets []ScannedProfile
	for _, p := range profiles {
		if id, ok := p.Frontmatter["id"].(string); ok && id == inherits {
			targets = append(targets, p)
		}
	}
	if len(targets) == 0 {
		return unresolved("inherits-unknown", "inherits \""+inherits+"\" but no profile declares that id")
	}
	if len(targets) > 1 {
		rels := make([]string, 0, len(targets))
		for _, t := range targets {
			rels = append(rels, t.RelPath)
		}
		return unresolved("inherits-ambiguous-target",
			fmt.Sprintf("inherits \"%s\" but %d profiles declare that id (%s); the target must be unique",
				inherits, len(targets), strings.Join(rels, ", ")))
	}
	base := targets[0]
	// Covers a non-core profile naming itself: its own role is not core.
	if role, ok := base.Frontmatter["role"].(string); !ok || role != "core" {
		encoded, _ := jsonenc.Marshal(base.Frontmatter["role"])
		return unresolved("inherits-target-not-core",
			"inherits \""+inherits+"\" ("+base.RelPath+"), whose role is "+string(encoded)+", not \"core\"; a profile may only extend a core profile")
	}
	// The base must be a leaf of the single level. Without this, a derived profile
	// would resolve through an inheriting core and get an effective profile that the
	// single-level rule says cannot exist. The base carries its own
	// `inherits-on-core` from its own resolution; this one says why the derived
	// profile is unusable, so both files are flagged.
	if baseInherits, ok := base.Frontmatter["inherits"].(string); ok {
		return unresolved("inherits-on-core",
			"inherits \""+inherits+"\" ("+base.RelPath+"), which itself declares inherits \""+baseInherits+
				"\"; resolution is single level, so the base of an inheritance declares none")
	}
	if baseErrors := errorsOn(base); len(baseErrors) > 0 {
		return refuse(baseErrors)
	}
	for _, p := range []ScannedProfile{base, derived} {
		id, ok := p.Frontmatter["id"].(string)
		if !ok || !profileIDRe.MatchString(id) {
			encoded, _ := jsonenc.Marshal(p.Frontmatter["id"])
			return unresolvedAt("profile-frontmatter",
				"id "+string(encoded)+" is not a valid profile identifier; the resolved profile interpolates ids into its body's source markers",
				p.RelPath)
		}
	}

	baseFm := base.Frontmatter
	effective := map[string]any{}
	var keys []string
	for _, key := range derived.Keys {
		if key == "inherits" {
			continue // a resolution directive, never effective frontmatter
		}
		value := fm[key]
		if containsStr(PostureKeys, key) {
			effective[key] = composePosture(baseFm[key], value)
		} else {
			effective[key] = value
		}
		keys = append(keys, key)
	}
	// Posture the derived profile omits entirely still comes from the base.
	for _, key := range PostureKeys {
		if _, present := effective[key]; present {
			continue
		}
		baseArray, ok := baseFm[key].([]any)
		if !ok {
			continue
		}
		effective[key] = append([]any{}, baseArray...)
		keys = append(keys, key)
	}
	// The resolved profile is what the spec's requirement binds, so it is checked
	// here too: a base that supplies neither leaves the role without the two fields
	// every profile must carry, and half a posture is worse than a refusal.
	for _, key := range []string{"requiredRead", "mustAskWhen"} {
		value, ok := effective[key].([]any)
		if !ok || len(value) == 0 {
			return unresolved("profile-frontmatter",
				"the resolved profile has no "+key+": this profile omits it and its base "+base.RelPath+" does not supply it")
		}
	}
	body := "<!-- inherited from: " + inherits + " -->\n\n" + bodyHalf(base.Body) +
		"\n<!-- " + derivedID + " -->\n\n" + bodyHalf(derived.Body)
	return ResolvedProfile{
		Frontmatter: effective,
		Keys:        keys,
		Body:        &body,
		SourceIDs:   []string{inherits, derivedID},
	}
}

// ProfileInheritanceFindings are the resolution findings for every profile in the
// set that declares `inherits`. Findings the scan already carries are dropped:
// resolution propagates a source's errors to its own callers, but a validator has
// reported those from the scan.
func ProfileInheritanceFindings(profiles []ScannedProfile) []findings.Finding {
	alreadyReported := map[string]bool{}
	for _, p := range profiles {
		for _, f := range p.Findings {
			alreadyReported[FindingKey(f)] = true
		}
	}
	var out []findings.Finding
	for _, p := range profiles {
		if _, ok := p.Frontmatter["inherits"].(string); !ok {
			continue
		}
		for _, f := range ResolveAgentProfile(p, profiles).Findings {
			if !alreadyReported[FindingKey(f)] {
				out = append(out, f)
			}
		}
	}
	return out
}

func ScanDecisionRecords(root string, m *manifest.Manifest) []ScannedProfile {
	// Decision records are scanned from the declared records path and from the
	// decisions category's resolved index entries; a layer may use either or both.
	relPaths := map[string]bool{}
	for _, rel := range fsx.WalkMd(root, manifest.EffectiveDecisionRecordsPath(m)) {
		relPaths[rel] = true
	}
	resolved, _ := ResolveCategoryPaths(root, m, "decisions")
	for _, rel := range resolved {
		relPaths[rel] = true
	}
	keys := make([]string, 0, len(relPaths))
	for k := range relPaths {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var out []ScannedProfile
	for _, relPath := range keys {
		if strings.ToLower(path.Base(relPath)) == "readme.md" {
			continue
		}
		text, _ := fsx.ReadText(filepath.Join(root, relPath))
		fm := frontmatter.Parse(text)
		var fs []findings.Finding
		switch {
		case fm.Error != "":
			fs = append(fs, findings.New("decision-frontmatter", findings.Error, fm.Error, relPath))
		case fm.Data == nil:
			fs = append(fs, findings.New("decision-frontmatter", findings.Error, "missing YAML frontmatter", relPath))
		default:
			for _, e := range schemas.SchemaErrors("decision-record", fm.Data) {
				fs = append(fs, findings.New("decision-frontmatter", findings.Error, e, relPath))
			}
		}
		out = append(out, ScannedProfile{RelPath: relPath, Frontmatter: fm.Data, Keys: fm.Keys, Body: fm.Body, Findings: fs})
	}
	return out
}

// IDItem is an (id, relPath) pair; id is any so non-string ids are skipped.
type IDItem struct {
	ID      any
	RelPath string
}

// DuplicateIDFindings reports duplicate ids across artifacts that carry an id.
func DuplicateIDFindings(items []IDItem, scope string) []findings.Finding {
	seen := map[string]string{}
	var fs []findings.Finding
	for _, it := range items {
		id, ok := it.ID.(string)
		if !ok || id == "" {
			continue
		}
		first, exists := seen[id]
		if exists && first != it.RelPath {
			fs = append(fs, findings.New("id-duplicate", findings.Error,
				scope+" id \""+id+"\" already used by "+first, it.RelPath))
		} else if !exists {
			seen[id] = it.RelPath
		}
	}
	return fs
}

// ReadJSONArtifact reads a declared JSON artifact: returns parsed value or a
// finding. Missing file yields (nil, no finding).
func ReadJSONArtifact(root, relPath string) (any, *findings.Finding) {
	abs := filepath.Join(root, relPath)
	if !fsx.IsFile(abs) {
		return nil, nil
	}
	if !fsx.ResolvedWithinRoot(root, abs) {
		f := findings.New("artifact-parse", findings.Error,
			fmt.Sprintf("artifact %s resolves outside the layer root", relPath), relPath)
		return nil, &f
	}
	text, err := fsx.ReadText(abs)
	if err != nil {
		f := findings.New("artifact-parse", findings.Error, "invalid JSON: "+err.Error(), relPath)
		return nil, &f
	}
	var data any
	if err := json.Unmarshal([]byte(text), &data); err != nil {
		f := findings.New("artifact-parse", findings.Error, "invalid JSON: "+err.Error(), relPath)
		return nil, &f
	}
	return data, nil
}
