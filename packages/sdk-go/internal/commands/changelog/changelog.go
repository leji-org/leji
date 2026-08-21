// Package changelog implements `leji changelog compact`: folding the oldest
// entries into a single compaction entry.
package changelog

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"time"

	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

// CompactOptions controls which entries fold. Keep/Before are active only when
// their Has* flag is set.
type CompactOptions struct {
	Keep    int
	HasKeep bool
	// Before is a YYYY-MM-DD cutoff: entries dated strictly before it fold.
	Before    string
	HasBefore bool
}

type CompactResult struct {
	Findings []findings.Finding
	Folded   int // entries folded (0 = no-op)
	Kept     int // surviving entries plus the new compaction entry
	Path     string
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
// compare is chronological.
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

func today() string {
	return time.Now().UTC().Format("2006-01-02")
}

// SeedChangelogIfMissing seeds the machine changelog when the layer claims
// indexed (or higher) and the file is missing; this lets `leji index` complete
// the indexed surface for a layer upgraded from core. Returns the seeded path,
// or "" when nothing was written (not indexed, already present, or a symlink would
// escape the root). Never overwrites.
//
// "Missing" is decided by the exclusive create itself rather than by a pathname
// check, because a stat follows symlinks: a dangling link at the changelog name
// reads as absent and the seed would be created at the link's destination. The
// exclusive create judges the ORIGINAL entry, so any standing entry is the same
// already-present no-op an existing changelog is.
func SeedChangelogIfMissing(root string, m *manifest.Manifest) (string, error) {
	if !manifest.LevelAtLeast(manifest.ClaimedLevel(m), "indexed") {
		return "", nil
	}
	rel := manifest.EffectiveChangelogPath(m)
	abs := filepath.Join(root, rel)
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
	verdict, err := fsx.WriteFileGuarded(fsx.GuardRoot(root), abs, "",
		[]byte(serializeChangelog(log)), fsx.WriteOptions{Exclusive: true})
	if err != nil {
		return "", err
	}
	if !verdict.OK {
		return "", nil
	}
	return rel, nil
}

var beforeDateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// CompactChangelog compacts the oldest entries of the changelog. An entry folds
// iff every active flag marks it foldable: keep ⇒ its canonical index is older
// than the newest keep entries; before ⇒ its date is strictly before before.
// Both predicates select a prefix of the canonical (date, id) order, so the
// folded set is always a contiguous run from the oldest end. Folded entries are
// dropped and a single compaction entry recording the removed count and id range
// is appended. Survivors keep their original array order.
func CompactChangelog(root string, m *manifest.Manifest, opts CompactOptions) (CompactResult, error) {
	rel := manifest.EffectiveChangelogPath(m)
	// Validate at the API level too: SDK callers must not fold with keep < 1 or a
	// malformed `before` date.
	if opts.HasKeep && opts.Keep < 1 {
		return CompactResult{
			Findings: []findings.Finding{findings.New("invalid-argument", findings.Error,
				"keep must be a positive integer", rel)},
			Folded: 0, Kept: 0, Path: rel,
		}, nil
	}
	if opts.HasBefore && !beforeDateRe.MatchString(opts.Before) {
		return CompactResult{
			Findings: []findings.Finding{findings.New("invalid-argument", findings.Error,
				"before must be a YYYY-MM-DD date", rel)},
			Folded: 0, Kept: 0, Path: rel,
		}, nil
	}
	// Compaction rewrites the file it just read, so the bytes it folds come from the
	// verified read rather than from a pathname read once and written again: a refusal
	// (outside the layer root, a private role, an entry that is not a regular file) is
	// reported exactly as an unreadable artifact, and nothing is written.
	rootReal := fsx.GuardRoot(root)
	// An operational read failure on an allowed path is the filesystem failing rather
	// than the boundary refusing, so it travels out as an error and the command reports
	// it, exactly as the reference lets it throw. Only containment, entry kind and
	// verification become findings.
	read, err := fsx.VerifiedTargetRead(rootReal, filepath.Join(root, rel), "")
	if err != nil {
		return CompactResult{}, err
	}
	if read.Status == fsx.ReadRefused {
		return CompactResult{
			Findings: []findings.Finding{findings.New("artifact-parse", findings.Error,
				"artifact "+rel+" resolves outside the layer root", rel)},
			Path: rel,
		}, nil
	}
	if read.Status == fsx.ReadAbsent {
		return CompactResult{
			Findings: []findings.Finding{findings.New("changelog-required", findings.Error,
				"changelog "+rel+" does not exist", rel)},
			Path: rel,
		}, nil
	}
	var data any
	if err := json.Unmarshal(read.Bytes, &data); err != nil {
		return CompactResult{
			Findings: []findings.Finding{findings.New("artifact-parse", findings.Error,
				"invalid JSON: "+err.Error(), rel)},
			Path: rel,
		}, nil
	}
	log, ok := data.(map[string]any)
	if !ok {
		return CompactResult{
			Findings: []findings.Finding{findings.New("artifact-parse", findings.Error,
				"changelog is not a JSON object", rel)},
			Path: rel,
		}, nil
	}

	var original []entry
	if raw, ok := log["entries"].([]any); ok {
		for _, e := range raw {
			if obj, ok := e.(map[string]any); ok {
				original = append(original, obj)
			}
		}
	}

	// Canonical order decides which entries are "oldest"; entry identity is tracked
	// by the map's underlying pointer (see entryPtr) since maps aren't comparable.
	canonical := make([]entry, len(original))
	copy(canonical, original)
	sort.SliceStable(canonical, func(i, j int) bool {
		return compareByDateID(canonical[i], canonical[j]) < 0
	})

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
		return CompactResult{Findings: nil, Folded: 0, Kept: len(original), Path: rel}, nil
	}

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
	verdict, err := fsx.WriteFileGuarded(rootReal, abs, "", []byte(serializeChangelog(next)), fsx.WriteOptions{})
	if err != nil {
		return CompactResult{
			Findings: []findings.Finding{findings.New("artifact-parse", findings.Error, err.Error(), rel)},
			Folded:   0, Kept: len(original), Path: rel,
		}, nil
	}
	if !verdict.OK {
		return CompactResult{
			Findings: []findings.Finding{findings.New("artifact-parse", findings.Error,
				"changelog path "+rel+" resolves outside the layer root", rel)},
			Folded: 0, Kept: len(original), Path: rel,
		}, nil
	}

	return CompactResult{Findings: nil, Folded: len(folded), Kept: len(nextEntries), Path: rel}, nil
}

// entryPtr returns a stable identity for an entry map (maps aren't comparable):
// the underlying pointer, stable for the map's lifetime, used as a set key.
func entryPtr(e entry) uintptr {
	return reflect.ValueOf(e).Pointer()
}
