// Package indexgen generates the context index from the tree, checks the stored
// index for currency, and serializes it deterministically.
package indexgen

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/git"
	"github.com/leji-org/leji/packages/sdk-go/internal/layer"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
	"github.com/leji-org/leji/packages/sdk-go/internal/schemas"
)

// IndexEntry mirrors the Node IndexEntry. Optional fields use pointers / nil
// slices so they are omitted exactly as Node/Python omit undefined fields.
type IndexEntry struct {
	ID           string
	Path         string
	Title        string
	Category     string
	Summary      string
	Tags         []string
	Owners       []string
	LastModified string
	ContentHash  string
	Freshness    *Freshness
	Links        []string
}

type Freshness struct {
	ReviewAfter string
}

type ContextIndex struct {
	Schema        string
	SchemaVersion string
	GeneratedAt   string
	Generator     *Generator
	RootPath      string
	Entries       []IndexEntry
}

type Generator struct {
	Name    string
	Version string
}

type Result struct {
	Index    *ContextIndex
	Findings []findings.Finding
	// Stale is set by CheckIndex: nil means "not a check"; callers default true.
	Stale *bool
}

var idPattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
var nonAlnum = regexp.MustCompile(`[^a-z0-9]+`)
var trimDash = regexp.MustCompile(`^-+|-+$`)
var headingRe = regexp.MustCompile(`(?m)^#\s+(.+)$`)

func slugify(stem string) string {
	s := strings.ToLower(stem)
	s = nonAlnum.ReplaceAllString(s, "-")
	s = trimDash.ReplaceAllString(s, "")
	return s
}

func firstHeading(body string) string {
	m := headingRe.FindStringSubmatch(body)
	if m == nil {
		return ""
	}
	return strings.TrimSpace(m[1])
}

func contentHash(root, relPath string) (string, error) {
	b, err := os.ReadFile(filepath.Join(root, relPath))
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])[:16], nil
}

func str(v any) string {
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return ""
}

func strArray(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	var out []string
	for _, x := range arr {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func DeclaredIndexPath(m *manifest.Manifest) string {
	if m.Machine == nil {
		return ""
	}
	return m.Machine.IndexPath
}

// LoadStoredIndex reads and parses the stored index as a generic map.
func LoadStoredIndex(root string, m *manifest.Manifest) map[string]any {
	rel := DeclaredIndexPath(m)
	abs := filepath.Join(root, rel)
	if rel == "" || !fsx.IsFile(abs) || !fsx.ResolvesUnder(root, abs) {
		return nil
	}
	data, _ := layer.ReadJSONArtifact(root, rel)
	obj, ok := data.(map[string]any)
	if !ok {
		return nil
	}
	return obj
}

func storedEntries(stored map[string]any) []map[string]any {
	if stored == nil {
		return nil
	}
	raw, ok := stored["entries"].([]any)
	if !ok {
		return nil
	}
	var out []map[string]any
	for _, e := range raw {
		if m, ok := e.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// GenerateIndex builds the context index from the tree.
func GenerateIndex(root string, m *manifest.Manifest) Result {
	var fs []findings.Finding
	docs := layer.ScanCategories(root, m)
	stored := LoadStoredIndex(root, m)
	storedByPath := map[string]map[string]any{}
	storedByHash := map[string]map[string]any{}
	for _, entry := range storedEntries(stored) {
		if p, ok := entry["path"].(string); ok {
			storedByPath[p] = entry
		}
		if h, ok := entry["contentHash"].(string); ok && h != "" {
			storedByHash[h] = entry
		}
	}

	_, inGit := git.Toplevel(root)
	today := time.Now().UTC().Format("2006-01-02")
	used := map[string]string{}
	var entries []IndexEntry

	for _, doc := range docs {
		fm := doc.Frontmatter
		if fm == nil {
			fm = map[string]any{}
		}
		hash, err := contentHash(root, doc.RelPath)
		if err != nil {
			fs = append(fs, findings.New("artifact-parse", findings.Error,
				"could not read document for hashing: "+err.Error(), doc.RelPath))
			continue
		}
		carried := storedByPath[doc.RelPath]
		if carried == nil {
			carried = storedByHash[hash]
		}

		id := str(fm["id"])
		if id == "" && carried != nil {
			if cid, ok := carried["id"].(string); ok {
				id = cid
			}
		}
		if id == "" {
			stem := strings.TrimSuffix(path.Base(doc.RelPath), ".md")
			id = slugify(stem)
			if _, taken := used[id]; taken {
				parent := slugify(path.Base(path.Dir(doc.RelPath)))
				if parent != "" {
					id = parent + "-" + id
				}
			}
			candidate := id
			n := 2
			for {
				if _, taken := used[candidate]; !taken {
					break
				}
				candidate = fmt.Sprintf("%s-%d", id, n)
				n++
			}
			id = candidate
		}
		if !idPattern.MatchString(id) {
			fs = append(fs, findings.New("id-pattern", findings.Error,
				fmt.Sprintf("derived id %q is not lowercase-hyphen", id), doc.RelPath))
		}
		if prev, taken := used[id]; taken {
			fs = append(fs, findings.New("id-duplicate", findings.Error,
				fmt.Sprintf("index id %q already used by %s", id, prev), doc.RelPath))
		}
		used[id] = doc.RelPath

		title := str(fm["title"])
		if title == "" {
			title = firstHeading(doc.Body)
		}
		if title == "" {
			title = strings.TrimSuffix(path.Base(doc.RelPath), ".md")
		}
		entry := IndexEntry{ID: id, Path: doc.RelPath, Title: title, Category: doc.Category}

		summary := str(fm["summary"])
		if summary == "" && carried != nil {
			if cs, ok := carried["summary"].(string); ok {
				summary = cs
			}
		}
		entry.Summary = summary
		entry.Tags = strArray(fm["tags"])
		entry.Owners = strArray(fm["owners"])
		if inGit {
			if d, ok := git.LastModified(root, doc.RelPath); ok {
				entry.LastModified = d
			}
		}
		if entry.LastModified == "" {
			entry.LastModified = today
		}
		entry.ContentHash = hash
		if fresh, ok := fm["freshness"].(map[string]any); ok {
			if ra := str(fresh["reviewAfter"]); ra != "" {
				entry.Freshness = &Freshness{ReviewAfter: ra}
			}
		}
		entry.Links = strArray(fm["links"])
		entries = append(entries, entry)
	}

	index := &ContextIndex{
		Schema:        "https://leji.org/schemas/v1.0/context-index.schema.json",
		SchemaVersion: "1.0",
		GeneratedAt:   time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00"),
		Generator:     &Generator{Name: "leji", Version: schemas.SDKVersion},
		RootPath:      m.RootPath,
		Entries:       entries,
	}
	return Result{Index: index, Findings: fs}
}

// entryComparable builds the currency-comparison view of a generated entry
// (lastModified excluded), as an ordered map serialized via stableStringify.
func entryComparable(e IndexEntry) map[string]any {
	out := map[string]any{
		"id":          e.ID,
		"path":        e.Path,
		"title":       e.Title,
		"category":    e.Category,
		"contentHash": e.ContentHash,
	}
	if e.Summary != "" {
		out["summary"] = e.Summary
	}
	if e.Tags != nil {
		out["tags"] = toAnySlice(e.Tags)
	}
	if e.Owners != nil {
		out["owners"] = toAnySlice(e.Owners)
	}
	if e.Freshness != nil {
		out["freshness"] = map[string]any{"reviewAfter": e.Freshness.ReviewAfter}
	}
	if e.Links != nil {
		out["links"] = toAnySlice(e.Links)
	}
	return out
}

func toAnySlice(in []string) []any {
	out := make([]any, len(in))
	for i, v := range in {
		out[i] = v
	}
	return out
}

// storedComparable strips lastModified from a stored entry map.
func storedComparable(e map[string]any) map[string]any {
	out := make(map[string]any, len(e))
	for k, v := range e {
		if k == "lastModified" {
			continue
		}
		out[k] = v
	}
	return out
}

// StableStringify is a key-order-insensitive, numeric-spelling-insensitive
// serialization mirrored across the SDKs (1.0 collapses to 1, like JS JSON).
func StableStringify(value any) string {
	var sb strings.Builder
	stableWrite(&sb, value)
	return sb.String()
}

func stableWrite(sb *strings.Builder, value any) {
	switch v := value.(type) {
	case []any:
		sb.WriteByte('[')
		for i, x := range v {
			if i > 0 {
				sb.WriteByte(',')
			}
			stableWrite(sb, x)
		}
		sb.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		sb.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				sb.WriteByte(',')
			}
			kb, _ := json.Marshal(k)
			sb.Write(kb)
			sb.WriteByte(':')
			stableWrite(sb, v[k])
		}
		sb.WriteByte('}')
	default:
		b, _ := json.Marshal(v)
		sb.Write(b)
	}
}

// CheckIndex compares the stored index against a regeneration.
func CheckIndex(root string, m *manifest.Manifest) Result {
	rel := DeclaredIndexPath(m)
	var fs []findings.Finding
	staleTrue := true
	if rel == "" || !fsx.IsFile(filepath.Join(root, rel)) {
		msg := "no machine.indexPath declared in leji.json"
		where := "leji.json"
		if rel != "" {
			msg = "declared index " + rel + " does not exist; run `leji index`"
			where = rel
		}
		fs = append(fs, findings.New("index-required", findings.Error, msg, where))
		return Result{Index: nil, Findings: fs, Stale: &staleTrue}
	}

	stored := LoadStoredIndex(root, m)
	if stored == nil {
		fs = append(fs, findings.New("artifact-parse", findings.Error, "stored index is not valid JSON", rel))
		return Result{Index: nil, Findings: fs, Stale: &staleTrue}
	}
	for _, e := range schemas.SchemaErrors("context-index", stored) {
		fs = append(fs, findings.New("artifact-schema", findings.Error, e, rel))
	}
	if sv, ok := stored["schemaVersion"].(string); ok && !contains(schemas.SupportedLines, sv) {
		fs = append(fs, findings.New("schema-version", findings.Error,
			fmt.Sprintf("schemaVersion %q is not supported by this SDK", sv), rel))
	}
	if len(fs) > 0 {
		return Result{Index: nil, Findings: fs, Stale: &staleTrue}
	}

	regen := GenerateIndex(root, m)
	wantEntries := make([]any, 0, len(regen.Index.Entries))
	for _, e := range regen.Index.Entries {
		wantEntries = append(wantEntries, entryComparable(e))
	}
	want := StableStringify(map[string]any{
		"rootPath": regen.Index.RootPath,
		"entries":  wantEntries,
	})

	stEntries := storedEntries(stored)
	sortedStored := make([]map[string]any, len(stEntries))
	copy(sortedStored, stEntries)
	sort.SliceStable(sortedStored, func(i, j int) bool {
		pi, _ := sortedStored[i]["path"].(string)
		pj, _ := sortedStored[j]["path"].(string)
		return pi < pj
	})
	gotEntries := make([]any, 0, len(sortedStored))
	for _, e := range sortedStored {
		gotEntries = append(gotEntries, storedComparable(e))
	}
	var gotRoot any
	if rp, ok := stored["rootPath"]; ok {
		gotRoot = rp
	}
	got := StableStringify(map[string]any{
		"rootPath": gotRoot,
		"entries":  gotEntries,
	})

	if want != got {
		wantPaths := map[string]bool{}
		for _, e := range regen.Index.Entries {
			wantPaths[e.Path] = true
		}
		gotPaths := map[string]bool{}
		for _, e := range stEntries {
			if p, ok := e["path"].(string); ok {
				gotPaths[p] = true
			}
		}
		missing, extra := 0, 0
		for p := range wantPaths {
			if !gotPaths[p] {
				missing++
			}
		}
		for p := range gotPaths {
			if !wantPaths[p] {
				extra++
			}
		}
		detail := " (entry content drifted)"
		if missing > 0 || extra > 0 {
			detail = fmt.Sprintf(" (missing: %d, removed: %d)", missing, extra)
		}
		fs = append(fs, findings.New("index-stale", findings.Error,
			"index no longer matches the tree"+detail+"; run `leji index`", rel))
		return Result{Index: nil, Findings: fs, Stale: &staleTrue}
	}

	var items []layer.IDItem
	for _, e := range stEntries {
		p, _ := e["path"].(string)
		items = append(items, layer.IDItem{ID: e["id"], RelPath: p})
	}
	staleFalse := false
	return Result{Index: nil, Findings: layer.DuplicateIDFindings(items, "index"), Stale: &staleFalse}
}

var entryKeyOrder = []string{
	"id", "path", "title", "category", "summary", "tags", "owners",
	"lastModified", "contentHash", "freshness", "links",
}

// SerializeIndex emits the index with stable key order, 2-space indent, and a
// trailing newline, matching JSON.stringify(_, null, 2)+"\n".
func SerializeIndex(index *ContextIndex) string {
	entries := make([]json.RawMessage, 0, len(index.Entries))
	for _, e := range index.Entries {
		entries = append(entries, orderedEntryJSON(e))
	}
	out := newOrdered()
	out.set("$schema", index.Schema)
	out.set("schemaVersion", index.SchemaVersion)
	out.set("generatedAt", index.GeneratedAt)
	if index.Generator != nil {
		gen := newOrdered()
		gen.set("name", index.Generator.Name)
		gen.set("version", index.Generator.Version)
		out.set("generator", gen)
	} else {
		out.set("generator", nil)
	}
	out.set("rootPath", index.RootPath)
	out.set("entries", entries)
	var buf bytes.Buffer
	out.encodeIndent(&buf, "", "  ")
	buf.WriteByte('\n')
	return buf.String()
}

func orderedEntryJSON(e IndexEntry) json.RawMessage {
	o := newOrdered()
	for _, key := range entryKeyOrder {
		switch key {
		case "id":
			o.set("id", e.ID)
		case "path":
			o.set("path", e.Path)
		case "title":
			o.set("title", e.Title)
		case "category":
			o.set("category", e.Category)
		case "summary":
			if e.Summary != "" {
				o.set("summary", e.Summary)
			}
		case "tags":
			if e.Tags != nil {
				o.set("tags", e.Tags)
			}
		case "owners":
			if e.Owners != nil {
				o.set("owners", e.Owners)
			}
		case "lastModified":
			if e.LastModified != "" {
				o.set("lastModified", e.LastModified)
			}
		case "contentHash":
			if e.ContentHash != "" {
				o.set("contentHash", e.ContentHash)
			}
		case "freshness":
			if e.Freshness != nil {
				fr := newOrdered()
				fr.set("reviewAfter", e.Freshness.ReviewAfter)
				o.set("freshness", fr)
			}
		case "links":
			if e.Links != nil {
				o.set("links", e.Links)
			}
		}
	}
	var buf bytes.Buffer
	o.encodeIndent(&buf, "", "  ")
	return json.RawMessage(buf.Bytes())
}

// WriteIndex generates and writes the index to the declared path.
func WriteIndex(root string, m *manifest.Manifest) (Result, error) {
	rel := DeclaredIndexPath(m)
	if rel == "" {
		return Result{Index: nil, Findings: []findings.Finding{
			findings.New("index-required", findings.Error, "no machine.indexPath declared in leji.json", "leji.json"),
		}}, nil
	}
	result := GenerateIndex(root, m)
	if result.Index != nil {
		abs := filepath.Join(root, rel)
		if !fsx.ResolvesUnder(root, abs) {
			return result, fmt.Errorf("index artifact %q resolves outside the layer root", rel)
		}
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return result, err
		}
		if err := os.WriteFile(abs, []byte(SerializeIndex(result.Index)), 0o644); err != nil {
			return result, err
		}
	}
	return result, nil
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}
