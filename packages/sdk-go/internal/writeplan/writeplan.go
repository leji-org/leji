// Package writeplan classifies and renders the files an operation intends to
// write, mirroring lib/writeplan.ts. Leji writes only the files it owns and
// never overwrites; the plan makes that contract visible before a single byte is
// written (the preview / --dry-run surface).
package writeplan

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// PlanStatus is the disposition of a single path in a planned operation.
type PlanStatus string

const (
	// Create marks a path that is absent and will be written.
	Create PlanStatus = "create"
	// SkipExists marks a path already present that Leji refuses to overwrite.
	SkipExists PlanStatus = "skip-exists"
	// WontModify marks a foreign file Leji detects but will never touch.
	WontModify PlanStatus = "wont-modify"
	// Overwrite marks a path the user has explicitly consented to overwrite
	// (e.g. converting a vendor entrypoint to a redirect after migrating its
	// content).
	Overwrite PlanStatus = "overwrite"
)

// PlannedWrite is a file Leji intends to write, with its content.
type PlannedWrite struct {
	Rel     string
	Content string
}

// PlanEntry is one classified path in a write plan.
type PlanEntry struct {
	Rel    string
	Status PlanStatus
	Note   string
}

// Build classifies each intended write against the filesystem (Create when
// absent, SkipExists when a path is already there and Leji refuses to
// overwrite), records foreign files Leji explicitly will not touch
// (WontModify), and marks the few paths the user has explicitly consented to
// overwrite (Overwrite, e.g. converting a vendor entrypoint to a redirect after
// migrating its content).
func Build(rootAbs string, writes []PlannedWrite, wontModify, overwrite []string) []PlanEntry {
	allowOverwrite := map[string]bool{}
	for _, rel := range overwrite {
		allowOverwrite[rel] = true
	}
	entries := make([]PlanEntry, 0, len(writes)+len(wontModify))
	for _, w := range writes {
		exists := false
		if _, err := os.Stat(filepath.Join(rootAbs, w.Rel)); err == nil {
			exists = true
		}
		if exists && allowOverwrite[w.Rel] {
			entries = append(entries, PlanEntry{
				Rel:    w.Rel,
				Status: Overwrite,
				Note:   "convert to a boot-profile redirect (content migrated first)",
			})
			continue
		}
		status := Create
		if exists {
			status = SkipExists
		}
		entries = append(entries, PlanEntry{Rel: w.Rel, Status: status})
	}
	for _, rel := range wontModify {
		entries = append(entries, PlanEntry{
			Rel:    rel,
			Status: WontModify,
			Note:   "existing file, read-only input — Leji will not modify it",
		})
	}
	return entries
}

var label = map[PlanStatus]string{
	Create:     "create     ",
	SkipExists: "skip       ",
	WontModify: "leave as-is",
	Overwrite:  "overwrite  ",
}

// Render produces a human-readable preview block, byte-compatible with
// renderWritePlan in writeplan.ts.
func Render(entries []PlanEntry) string {
	creates, skips, overwrites := 0, 0, 0
	var untouched []PlanEntry
	for _, e := range entries {
		switch e.Status {
		case Create:
			creates++
		case SkipExists:
			skips++
		case Overwrite:
			overwrites++
		case WontModify:
			untouched = append(untouched, e)
		}
	}
	lines := []string{"Plan:"}
	for _, e := range entries {
		if e.Status == WontModify {
			continue
		}
		lines = append(lines, "   "+label[e.Status]+" "+e.Rel)
	}
	if len(untouched) > 0 {
		lines = append(lines, "", "Will NOT modify (existing files Leji learns from, never rewrites):")
		for _, e := range untouched {
			lines = append(lines, "   "+label[e.Status]+" "+e.Rel)
		}
	}
	overwritePart := ""
	if overwrites > 0 {
		overwritePart = ", " + strconv.Itoa(overwrites) + " to convert (with your consent)"
	}
	lines = append(lines, "",
		"Summary: "+strconv.Itoa(creates)+" to create, "+strconv.Itoa(skips)+" already present (left untouched)"+overwritePart+".")
	return strings.Join(lines, "\n")
}
