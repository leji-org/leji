// Package changelog implements `leji changelog compact`: folding the oldest
// changelog entries into a single compaction entry. It mirrors the Node SDK's
// commands/changelog.ts, including canonical (date, id) ordering, the fold
// predicates, the compaction entry shape, and deterministic serialization.
package changelog

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"time"

	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/layer"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

// CompactOptions controls which entries fold. Keep/Before are active only when
// their Has* flag is set, mirroring the optional fields in the Node options.
type CompactOptions struct {
	Keep    int
	HasKeep bool
	// Before is a YYYY-MM-DD cutoff: entries dated strictly before it fold.
	Before    string
	HasBefore bool
}

// CompactResult reports the outcome of a compaction.
type CompactResult struct {
	Findings []findings.Finding
	// Folded is the number of entries folded into the compaction entry (0 = no-op).
	Folded int
	// Kept is the number of surviving non-compaction entries plus the new one.
	Kept int
	// Path is the effective changelog path operated on.
	Path string
}

type entry = map[string]any

func entryDate(e entry) string {
	if d, ok := e["date"].(string); ok {
		return d
	}
	return ""
}

func entryID(e entry) string {
	if s, ok := e["id"].(string); ok {
		return s
	}
	return ""
}

// compareByDateID is the canonical changelog order (machine-readable-surface.md
// req 3): ascending by date, then id as the tiebreak. date is UTC, so a lexical
// compare is chronological; id is unique, so the pair is a total order.
func compareByDateID(a, b entry) int {
	ad, bd := entryDate(a), entryDate(b)
	if ad != bd {
		if ad < bd {
			return -1
		}
		return 1
	}
	ai, bi := entryID(a), entryID(b)
	if ai < bi {
		return -1
	}
	if ai > bi {
		return 1
	}
	return 0
}

// today returns today's date as YYYY-MM-DD (UTC).
func today() string {
	return time.Now().UTC().Format("2006-01-02")
}

// SeedChangelogIfMissing seeds the machine changelog if the layer claims indexed
// (or higher) and the file is missing. The changelog is an indexed-level surface,
// so `leji init` only writes it at that level; this lets `leji index` complete the
// indexed surface for a layer that claimed indexed after the fact (e.g. an upgrade
// from core). Returns the seeded path, or "" when nothing was written (not
// indexed, already present, or a symlink would escape the root). Never overwrites.
func SeedChangelogIfMissing(root string, m *manifest.Manifest) (string, error) {
	if !manifest.LevelAtLeast(manifest.ClaimedLevel(m), "indexed") {
		return "", nil
	}
	rel := manifest.EffectiveChangelogPath(m)
	abs := filepath.Join(root, rel)
	if fsx.IsFile(abs) || !fsx.ResolvesUnder(root, abs) {
		return "", nil
	}
	log := map[string]any{
		"$schema":       "https://leji.org/schemas/v1.0/context-changelog.schema.json",
		"schemaVersion": "1.0",
		"entries": []entry{
			{
				"id":         "seed-changelog",
				"date":       today(),
				"type":       "added",
				"summary":    "Started the machine changelog for the indexed level.",
				"paths":      []any{rel},
				"proposedBy": "leji index",
				"approvedBy": m.Owners.Primary.Name,
			},
		},
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(abs, []byte(serializeChangelog(log)), 0o644); err != nil {
		return "", err
	}
	return rel, nil
}

// beforeDateRe matches a YYYY-MM-DD `before` cutoff, mirroring the Node SDK's
// compaction API validation.
var beforeDateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// CompactChangelog compacts the oldest entries of the changelog. An entry folds
// iff every active flag marks it foldable: keep ⇒ its canonical index is older
// than the newest keep entries; before ⇒ its date is strictly before before.
// Inactive flags are neutral. Because both predicates select a prefix of the
// canonical (date, id) order, the folded set is always a contiguous run from the
// oldest end. The folded entries are dropped and a single compaction entry is
// appended, recording the count and the id range it removed. Surviving entries
// keep their original array order.
func CompactChangelog(root string, m *manifest.Manifest, opts CompactOptions) CompactResult {
	rel := manifest.EffectiveChangelogPath(m)
	// Validate options at the API level too (the CLI also checks --keep): SDK
	// callers must not be able to fold with keep < 1 or a malformed `before` date.
	if opts.HasKeep && opts.Keep < 1 {
		return CompactResult{
			Findings: []findings.Finding{findings.New("invalid-argument", findings.Error,
				"keep must be a positive integer", rel)},
			Folded: 0, Kept: 0, Path: rel,
		}
	}
	if opts.HasBefore && !beforeDateRe.MatchString(opts.Before) {
		return CompactResult{
			Findings: []findings.Finding{findings.New("invalid-argument", findings.Error,
				"before must be a YYYY-MM-DD date", rel)},
			Folded: 0, Kept: 0, Path: rel,
		}
	}
	data, parseFinding := layer.ReadJSONArtifact(root, rel)
	if parseFinding != nil {
		return CompactResult{Findings: []findings.Finding{*parseFinding}, Path: rel}
	}
	if data == nil {
		return CompactResult{
			Findings: []findings.Finding{findings.New("changelog-required", findings.Error,
				"changelog "+rel+" does not exist", rel)},
			Path: rel,
		}
	}
	log, ok := data.(map[string]any)
	if !ok {
		return CompactResult{
			Findings: []findings.Finding{findings.New("artifact-parse", findings.Error,
				"changelog is not a JSON object", rel)},
			Path: rel,
		}
	}

	var original []entry
	if raw, ok := log["entries"].([]any); ok {
		for _, e := range raw {
			if obj, ok := e.(map[string]any); ok {
				original = append(original, obj)
			}
		}
	}

	// Canonical order decides which entries are "oldest"; the index of each entry
	// in that order drives the keep predicate. The entry maps are reference types
	// shared between original and canonical, so identity is tracked by the map's
	// underlying pointer (mirroring the Set<ChangelogEntry> in the Node SDK).
	canonical := make([]entry, len(original))
	copy(canonical, original)
	sort.SliceStable(canonical, func(i, j int) bool {
		return compareByDateID(canonical[i], canonical[j]) < 0
	})

	// An entry folds iff both active predicates accept it; canonical position
	// (0 = oldest) drives the keep predicate. Both predicates select a prefix of
	// the canonical order, so the folded set is a contiguous run from the oldest.
	foldedSet := map[uintptr]bool{}
	var folded []entry
	for pos, e := range canonical {
		foldByKeep := !opts.HasKeep || pos < len(canonical)-opts.Keep
		foldByBefore := !opts.HasBefore || entryDate(e) < opts.Before
		if foldByKeep && foldByBefore {
			folded = append(folded, e)
			foldedSet[entryPtr(e)] = true
		}
	}

	if len(folded) == 0 {
		return CompactResult{Findings: nil, Folded: 0, Kept: len(original), Path: rel}
	}

	// Survivors keep their original array order.
	var survivors []entry
	for _, e := range original {
		if !foldedSet[entryPtr(e)] {
			survivors = append(survivors, e)
		}
	}

	oldest := folded[0]
	newest := folded[len(folded)-1]

	pathSet := map[string]bool{}
	for _, e := range folded {
		if ps, ok := e["paths"].([]any); ok {
			for _, p := range ps {
				if s, ok := p.(string); ok {
					pathSet[s] = true
				}
			}
		}
	}
	pathsUnion := make([]string, 0, len(pathSet))
	for p := range pathSet {
		pathsUnion = append(pathsUnion, p)
	}
	sort.Strings(pathsUnion)

	// De-dupe the compaction id against existing ids (-2, -3, …).
	existingIDs := map[string]bool{}
	for _, e := range original {
		existingIDs[entryID(e)] = true
	}
	id := "compaction-" + today()
	if existingIDs[id] {
		base := id
		n := 2
		for existingIDs[fmt.Sprintf("%s-%d", base, n)] {
			n++
		}
		id = fmt.Sprintf("%s-%d", base, n)
	}

	noun := "entries"
	if len(folded) == 1 {
		noun = "entry"
	}
	summary := fmt.Sprintf("Compacted %d %s (%s through %s).", len(folded), noun, entryDate(oldest), entryDate(newest))

	pathsValue := make([]any, 0, len(pathsUnion))
	for _, p := range pathsUnion {
		pathsValue = append(pathsValue, p)
	}
	if len(pathsValue) == 0 {
		pathsValue = []any{rel}
	}

	compaction := entry{
		"id":      id,
		"date":    today(),
		"type":    "compaction",
		"summary": summary,
		"paths":   pathsValue,
		"compacted": map[string]any{
			"entries": len(folded),
			"firstId": entryID(oldest),
			"lastId":  entryID(newest),
		},
	}

	nextEntries := make([]entry, 0, len(survivors)+1)
	nextEntries = append(nextEntries, survivors...)
	nextEntries = append(nextEntries, compaction)

	next := map[string]any{}
	for k, v := range log {
		next[k] = v
	}
	next["entries"] = nextEntries

	abs := filepath.Join(root, rel)
	if !fsx.ResolvesUnder(root, abs) {
		return CompactResult{
			Findings: []findings.Finding{findings.New("artifact-parse", findings.Error,
				"changelog path "+rel+" resolves outside the layer root", rel)},
			Folded: 0, Kept: len(original), Path: rel,
		}
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return CompactResult{
			Findings: []findings.Finding{findings.New("artifact-parse", findings.Error, err.Error(), rel)},
			Folded:   0, Kept: len(original), Path: rel,
		}
	}
	if err := os.WriteFile(abs, []byte(serializeChangelog(next)), 0o644); err != nil {
		return CompactResult{
			Findings: []findings.Finding{findings.New("artifact-parse", findings.Error, err.Error(), rel)},
			Folded:   0, Kept: len(original), Path: rel,
		}
	}

	return CompactResult{Findings: nil, Folded: len(folded), Kept: len(nextEntries), Path: rel}
}

// entryPtr returns a stable identity for an entry map. Go maps are reference
// types but not comparable; reflect exposes the underlying pointer, which is
// stable for the lifetime of the map, so it serves as a set key the way object
// identity does for the Node SDK's Set<ChangelogEntry>.
func entryPtr(e entry) uintptr {
	return reflect.ValueOf(e).Pointer()
}
