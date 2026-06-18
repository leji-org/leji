// Package layer holds shared layer scanning: category docs, agent profiles,
// decision records, duplicate-id detection, and JSON artifact reads.
package layer

import (
	"encoding/json"
	"fmt"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/frontmatter"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
	"github.com/leji-org/leji/packages/sdk-go/internal/schemas"
)

type ScannedDoc struct {
	RelPath     string
	Category    string
	Frontmatter map[string]any
	Body        string
}

type ScannedProfile struct {
	RelPath     string
	Frontmatter map[string]any
	Findings    []findings.Finding
}

// excludedFromCategories returns a predicate for files that must not be treated
// as category content.
func excludedFromCategories(m *manifest.Manifest) func(string) bool {
	profilesDir := manifest.EffectiveAgentProfilesPath(m)
	return func(relPath string) bool {
		if relPath == m.BootProfilePath {
			return true
		}
		if fsx.UnderPath(relPath, profilesDir) {
			return true
		}
		if strings.ToLower(path.Base(relPath)) == "readme.md" {
			return true
		}
		return false
	}
}

// ScanCategories collects category documents. On overlap the longest declared
// path wins, manifest order breaks ties; output is sorted by relPath.
func ScanCategories(root string, m *manifest.Manifest) []ScannedDoc {
	excluded := excludedFromCategories(m)
	type assigned struct {
		category    string
		declaredLen int
	}
	byFile := map[string]assigned{}
	for _, category := range manifest.CategoryIDs {
		mapping, ok := m.Categories[category]
		if !ok {
			continue
		}
		for _, declared := range mapping.Paths {
			for _, relPath := range fsx.WalkMd(root, declared) {
				if excluded(relPath) {
					continue
				}
				prev, seen := byFile[relPath]
				if !seen || len(declared) > prev.declaredLen {
					byFile[relPath] = assigned{category: category, declaredLen: len(declared)}
				}
			}
		}
	}
	keys := make([]string, 0, len(byFile))
	for k := range byFile {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	docs := make([]ScannedDoc, 0, len(keys))
	for _, relPath := range keys {
		text, _ := fsx.ReadText(filepath.Join(root, relPath))
		fm := frontmatter.Parse(text)
		docs = append(docs, ScannedDoc{
			RelPath:     relPath,
			Category:    byFile[relPath].category,
			Frontmatter: fm.Data,
			Body:        fm.Body,
		})
	}
	return docs
}

func scanFrontmatterArtifacts(root, dir, schemaName, rule string) []ScannedProfile {
	var out []ScannedProfile
	for _, relPath := range fsx.WalkMd(root, dir) {
		if strings.ToLower(path.Base(relPath)) == "readme.md" {
			continue
		}
		text, _ := fsx.ReadText(filepath.Join(root, relPath))
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
		out = append(out, ScannedProfile{RelPath: relPath, Frontmatter: fm.Data, Findings: fs})
	}
	return out
}

func ScanAgentProfiles(root string, m *manifest.Manifest) []ScannedProfile {
	dir := manifest.EffectiveAgentProfilesPath(m)
	return scanFrontmatterArtifacts(root, dir, "agent-profile", "profile-frontmatter")
}

func ScanDecisionRecords(root string, m *manifest.Manifest) []ScannedProfile {
	var dirs []string
	add := func(p string) {
		for _, d := range dirs {
			if d == p {
				return
			}
		}
		dirs = append(dirs, p)
	}
	add(manifest.EffectiveDecisionRecordsPath(m))
	if dec, ok := m.Categories["decisions"]; ok {
		for _, p := range dec.Paths {
			add(p)
		}
	}
	seen := map[string]bool{}
	var out []ScannedProfile
	for _, dir := range dirs {
		for _, scanned := range scanFrontmatterArtifacts(root, dir, "decision-record", "decision-frontmatter") {
			if seen[scanned.RelPath] {
				continue
			}
			seen[scanned.RelPath] = true
			out = append(out, scanned)
		}
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
				fmt.Sprintf("%s id %q already used by %s", scope, id, first), it.RelPath))
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
	if !fsx.ResolvesUnder(root, abs) {
		f := findings.New("artifact-parse", findings.Error,
			"artifact path resolves outside the layer root", relPath)
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
