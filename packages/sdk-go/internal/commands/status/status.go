// Package status reports context-layer health: unindexed reference docs, dangling
// index entries, and stale stored-index paths. Non-failing; the CLI gates with --strict.
package status

import (
	"path"
	"sort"
	"strings"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/indexgen"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/layer"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
	"github.com/leji-org/leji/packages/sdk-go/internal/mounts"
)

// DanglingEntry is an index entry that does not resolve on disk (missing,
// escaping root, or not markdown).
type DanglingEntry struct {
	IndexFile string
	Detail    string
}

// ShadowedSelector is a broad index selector whose every covered document was
// won by more-specific selectors: dead weight in the curated index, surfaced
// but never an error.
type ShadowedSelector struct {
	IndexFile string
	Path      string
}

// Report is an informational health report for a context layer.
type Report struct {
	// Unindexed: markdown under rootPath that no category index lists (reference).
	Unindexed []string
	// Dangling: index entries pointing at a path that does not resolve.
	Dangling []DanglingEntry
	// Stale: paths in the stored index the index files no longer resolve to.
	Stale []string
	// Pending: governed paths not yet in the stored index (or all of them when no
	// stored index exists): the machine contract is behind the tree; run `leji index`.
	Pending []string
	// Shadowed: selectors fully displaced by more-specific selectors.
	Shadowed []ShadowedSelector
	// SkippedReadmes: READMEs inside listed directories that expansion skipped
	// and no explicit selector governs: the carve-out surfaced, never silent.
	SkippedReadmes []ShadowedSelector
	// Projection: would this layer, at HEAD, project completely if a host mounted
	// it? Judged against the object store, so it sees what a host's hydrate would
	// see — including a bound profile that exists on disk but is untracked.
	// Report-only.
	Projection mounts.SelfProjection
}

// isChrome reports files that are never category content, so never "unindexed".
func isChrome(m *manifest.Manifest, rel string) bool {
	profilesDir := manifest.EffectiveAgentProfilesPath(m)
	indexFiles := map[string]bool{}
	for _, c := range manifest.CategoryIDs {
		if mapping, ok := m.Categories[c]; ok {
			for _, f := range mapping.Indexes {
				indexFiles[f] = true
			}
		}
	}
	overviewRel := fsx.JoinUnderRoot(m.RootPath, "overview.md")
	sidebarRel := fsx.JoinUnderRoot(m.RootPath, "_sidebar.md")
	return rel == m.BootProfilePath ||
		fsx.UnderPath(rel, profilesDir) ||
		indexFiles[rel] ||
		rel == overviewRel ||
		rel == sidebarRel ||
		rel == manifest.EffectiveIndexPath(m) ||
		rel == manifest.EffectiveChangelogPath(m) ||
		strings.ToLower(path.Base(rel)) == "readme.md"
}

// StatusReport builds the health report. Pure computation; the CLI renders and decides exit.
func StatusReport(root string, m *manifest.Manifest) Report {
	resolved := layer.ResolveCategoryAssignments(root, m, false)
	governed := map[string]bool{}
	for p := range resolved.Assignments {
		governed[p] = true
	}

	rootDir := fsx.StripSlash(m.RootPath)
	if rootDir == "" {
		rootDir = "."
	}
	var unindexed []string
	for _, rel := range fsx.WalkTree(root, rootDir) {
		if governed[rel] || isChrome(m, rel) {
			continue
		}
		unindexed = append(unindexed, rel)
	}
	sort.Strings(unindexed)

	var dangling []DanglingEntry
	for _, f := range resolved.Findings {
		switch f.Rule {
		case "index-file-missing", "index-entry-missing", "index-entry-not-markdown", "index-file-parse":
			// Parse-level problems include invalid or escaping entry paths
			// (`../x.md`, absolute, backslash); surface them so `status --strict`
			// fails on an entry that would otherwise be flagged nowhere else.
			dangling = append(dangling, DanglingEntry{IndexFile: f.Path, Detail: f.Message})
		}
	}

	stored := indexgen.LoadStoredIndex(root, m)
	var stale []string
	for _, e := range storedEntryPaths(stored) {
		if !governed[e] {
			stale = append(stale, e)
		}
	}
	sort.Strings(stale)

	// The symmetric drift direction: governed on disk, absent from the stored
	// index (all governed paths when the index has never been generated).
	storedPaths := map[string]bool{}
	for _, e := range storedEntryPaths(stored) {
		storedPaths[e] = true
	}
	var pending []string
	for p := range governed {
		if !storedPaths[p] {
			pending = append(pending, p)
		}
	}
	sort.Strings(pending)

	shadowed := make([]ShadowedSelector, 0, len(resolved.Shadowed))
	for _, s := range resolved.Shadowed {
		shadowed = append(shadowed, ShadowedSelector{IndexFile: s.IndexRel, Path: s.Path})
	}
	sort.Slice(shadowed, func(i, j int) bool {
		if shadowed[i].IndexFile != shadowed[j].IndexFile {
			return shadowed[i].IndexFile < shadowed[j].IndexFile
		}
		return shadowed[i].Path < shadowed[j].Path
	})
	if len(shadowed) == 0 {
		shadowed = nil
	}

	skippedReadmes := make([]ShadowedSelector, 0, len(resolved.SkippedReadmes))
	for _, r := range resolved.SkippedReadmes {
		skippedReadmes = append(skippedReadmes, ShadowedSelector{IndexFile: r.IndexRel, Path: r.Path})
	}
	sort.Slice(skippedReadmes, func(i, j int) bool {
		if skippedReadmes[i].IndexFile != skippedReadmes[j].IndexFile {
			return skippedReadmes[i].IndexFile < skippedReadmes[j].IndexFile
		}
		return skippedReadmes[i].Path < skippedReadmes[j].Path
	})
	if len(skippedReadmes) == 0 {
		skippedReadmes = nil
	}

	return Report{Unindexed: unindexed, Dangling: dangling, Stale: stale, Pending: pending, Shadowed: shadowed, SkippedReadmes: skippedReadmes, Projection: mounts.ComputeSelfProjection(root)}
}

func storedEntryPaths(stored map[string]any) []string {
	if stored == nil {
		return nil
	}
	raw, ok := stored["entries"].([]any)
	if !ok {
		return nil
	}
	var out []string
	for _, e := range raw {
		if m, ok := e.(map[string]any); ok {
			if p, ok := m["path"].(string); ok {
				out = append(out, p)
			}
		}
	}
	return out
}
