// Package freshness reports review horizons across category documents and agent
// profiles. Report-only by default; --strict raises expired horizons to errors.
package freshness

import (
	"regexp"
	"sort"
	"time"

	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/layer"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

type Item struct {
	Path        string
	ReviewAfter string
}

type Report struct {
	Expired  []Item
	Upcoming []Item
	Declared int
	Findings []findings.Finding
}

var dateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func reviewAfterOf(fm map[string]any) string {
	if fm == nil {
		return ""
	}
	fresh, ok := fm["freshness"].(map[string]any)
	if !ok {
		return ""
	}
	v, ok := fresh["reviewAfter"].(string)
	if ok && dateRe.MatchString(v) {
		return v
	}
	return ""
}

// FreshnessReport scans category docs and agent profiles for review horizons.
func FreshnessReport(root string, m *manifest.Manifest, strict bool) Report {
	today := time.Now().UTC().Format("2006-01-02")
	horizon := time.Now().UTC().Add(30 * 24 * time.Hour).Format("2006-01-02")

	var items []Item
	for _, doc := range layer.ScanCategories(root, m) {
		if ra := reviewAfterOf(doc.Frontmatter); ra != "" {
			items = append(items, Item{Path: doc.RelPath, ReviewAfter: ra})
		}
	}
	for _, p := range layer.ScanAgentProfiles(root, m) {
		if ra := reviewAfterOf(p.Frontmatter); ra != "" {
			items = append(items, Item{Path: p.RelPath, ReviewAfter: ra})
		}
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].ReviewAfter != items[j].ReviewAfter {
			return items[i].ReviewAfter < items[j].ReviewAfter
		}
		return items[i].Path < items[j].Path
	})

	var expired, upcoming []Item
	for _, it := range items {
		if it.ReviewAfter < today {
			expired = append(expired, it)
		} else if it.ReviewAfter >= today && it.ReviewAfter <= horizon {
			upcoming = append(upcoming, it)
		}
	}
	var fs []findings.Finding
	for _, it := range expired {
		sev := findings.Warning
		if strict {
			sev = findings.Error
		}
		fs = append(fs, findings.New("freshness-expired", sev,
			"review horizon "+it.ReviewAfter+" has passed", it.Path))
	}
	return Report{Expired: expired, Upcoming: upcoming, Declared: len(items), Findings: findings.Sort(fs)}
}
