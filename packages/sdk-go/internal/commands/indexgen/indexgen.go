// Package indexgen generates, checks, and serializes the context index.
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
	"github.com/leji-org/leji/packages/sdk-go/internal/jsonenc"
	"github.com/leji-org/leji/packages/sdk-go/internal/layer"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
	"github.com/leji-org/leji/packages/sdk-go/internal/schemas"
)

// IndexEntry mirrors the Node IndexEntry; optional fields use pointers/nil slices
// so they omit exactly as Node/Python omit undefined fields.
type IndexEntry struct {
	ID       string
	Path     string
	Title    string
	Category string
	// Kind is "intent" or "record". Always emitted; consumers treat an
	// absent value (older indexes) as "intent".
	Kind string
	// Date is a record's date, sourced only from valid frontmatter `date`.
	Date         string
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

// IndexMount is a federated sibling's routing record from federation.mounts.
type IndexMount struct {
	Name         string
	Source       string
	Pin          string
	TrackingRef  string
	Owner        manifest.Owner
	Role         string
	Categories   []string
	Topics       []string
	RequiredWhen []string
}

type ContextIndex struct {
	Schema        string
	SchemaVersion string
	GeneratedAt   string
	Generator     *Generator
	RootPath      string
	Entries       []IndexEntry
	Mounts        []IndexMount
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
var recordDateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
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

// LoadStoredIndex is the stored index, or nil when there is none this run can act
// on. It is read through the verified read, not by pathname: generation carries ids
// out of these bytes into the index it writes back to this same path, so the file
// that was judged must be the file that is read. Absent, unparsable, or a standing
// entry that cannot be verified all mean "no stored index" — nothing is carried, and
// the write chokepoint judges the destination again on its own.
func LoadStoredIndex(root string, m *manifest.Manifest) (map[string]any, error) {
	rel := manifest.EffectiveIndexPath(m)
	abs := filepath.Join(root, rel)
	// An operational read failure on an allowed path is the filesystem failing rather
	// than the boundary refusing, so it travels out as an error, exactly as the
	// reference lets it throw: the run reports it and stops instead of generating an
	// index that silently carries no ids.
	read, err := fsx.VerifiedTargetRead(fsx.GuardRoot(root), abs, "")
	if err != nil {
		return nil, err
	}
	if read.Status != fsx.ReadRegular {
		return nil, nil
	}
	var data any
	if err := json.Unmarshal(read.Bytes, &data); err != nil {
		return nil, nil
	}
	obj, ok := data.(map[string]any)
	if !ok {
		return nil, nil
	}
	return obj, nil
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

func GenerateIndex(root string, m *manifest.Manifest) (Result, error) {
	var fs []findings.Finding
	scan := layer.ScanCategories(root, m)
	fs = append(fs, scan.Findings...)
	docs := scan.Docs
	stored, err := LoadStoredIndex(root, m)
	if err != nil {
		return Result{}, err
	}
	storedByPath := map[string]map[string]any{}
	// Carry an id by content-hash only when that hash maps to exactly one stored
	// entry: two byte-identical documents share a hash, so a hash-carry there would
	// misattribute one document's id to the other on a move.
	hashEntries := map[string][]map[string]any{}
	for _, entry := range storedEntries(stored) {
		if p, ok := entry["path"].(string); ok {
			storedByPath[p] = entry
		}
		if h, ok := entry["contentHash"].(string); ok && h != "" {
			hashEntries[h] = append(hashEntries[h], entry)
		}
	}
	storedByHash := map[string]map[string]any{}
	for h, arr := range hashEntries {
		if len(arr) == 1 {
			storedByHash[h] = arr[0]
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
		entry := IndexEntry{ID: id, Path: doc.RelPath, Title: title, Category: doc.Category, Kind: doc.Kind}
		if doc.Kind == "record" {
			// A record's date comes only from explicit, valid frontmatter; nothing
			// is scraped from prose or filename conventions.
			if d := str(fm["date"]); d != "" && recordDateRe.MatchString(d) {
				entry.Date = d
			}
		}

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

	// Id churn: a stored id whose path is gone and that did not reappear at a new path
	// vanished (a document moved AND edited with no frontmatter id mints a fresh slug).
	// Inbound references to the old id now dangle; warn so it is caught, not silent.
	newIDs := map[string]bool{}
	for _, e := range entries {
		newIDs[e.ID] = true
	}
	currentPaths := map[string]bool{}
	for _, d := range docs {
		currentPaths[d.RelPath] = true
	}
	for _, entry := range storedEntries(stored) {
		p, _ := entry["path"].(string)
		id, _ := entry["id"].(string)
		if !currentPaths[p] && !newIDs[id] {
			fs = append(fs, findings.New("id-vanished", findings.Warning,
				fmt.Sprintf("stored id %q (was %s) did not reappear; references to it now dangle. Declare a frontmatter id to keep ids stable across moves.", id, p), p))
		}
	}

	var mounts []IndexMount
	if m.Federation != nil {
		for _, mt := range m.Federation.Mounts {
			rec := IndexMount{Name: mt.Name, Source: mt.Source, Pin: mt.Pin, TrackingRef: mt.TrackingRef, Owner: mt.Owner, Role: mt.Role}
			if len(mt.Categories) > 0 {
				rec.Categories = mt.Categories
			}
			if len(mt.Topics) > 0 {
				rec.Topics = mt.Topics
			}
			if len(mt.RequiredWhen) > 0 {
				rec.RequiredWhen = mt.RequiredWhen
			}
			mounts = append(mounts, rec)
		}
	}

	index := &ContextIndex{
		Schema:        "https://leji.org/schemas/v1.0/context-index.schema.json",
		SchemaVersion: "1.0",
		GeneratedAt:   time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00"),
		Generator:     &Generator{Name: "leji", Version: schemas.SDKVersion},
		RootPath:      m.RootPath,
		Entries:       entries,
	}
	if len(mounts) > 0 {
		index.Mounts = mounts
	}
	return Result{Index: index, Findings: fs}, nil
}

// entryComparable is the currency-comparison view of an entry (only lastModified
// excluded; kind and date compare like any other field).
func entryComparable(e IndexEntry) map[string]any {
	out := map[string]any{
		"id":          e.ID,
		"path":        e.Path,
		"title":       e.Title,
		"category":    e.Category,
		"kind":        e.Kind,
		"contentHash": e.ContentHash,
	}
	if e.Date != "" {
		out["date"] = e.Date
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

func mountComparables(mounts []IndexMount) []any {
	out := make([]any, 0, len(mounts))
	for _, mt := range mounts {
		mm := map[string]any{"name": mt.Name, "source": mt.Source, "pin": mt.Pin}
		if mt.TrackingRef != "" {
			mm["trackingRef"] = mt.TrackingRef
		}
		ow := map[string]any{"name": mt.Owner.Name}
		if mt.Owner.Contact != "" {
			ow["contact"] = mt.Owner.Contact
		}
		mm["owner"] = ow
		if mt.Role != "" {
			mm["role"] = mt.Role
		}
		if mt.Categories != nil {
			mm["categories"] = toAnySlice(mt.Categories)
		}
		if mt.Topics != nil {
			mm["topics"] = toAnySlice(mt.Topics)
		}
		if mt.RequiredWhen != nil {
			mm["requiredWhen"] = toAnySlice(mt.RequiredWhen)
		}
		out = append(out, mm)
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

// StableStringify is a key-order- and numeric-spelling-insensitive serialization
// mirrored across the SDKs (1.0 collapses to 1, like JS JSON).
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
			kb, _ := jsonenc.Marshal(k)
			sb.Write(kb)
			sb.WriteByte(':')
			stableWrite(sb, v[k])
		}
		sb.WriteByte('}')
	default:
		b, _ := jsonenc.Marshal(v)
		sb.Write(b)
	}
}

// CheckIndex compares the stored index against a regeneration.
func CheckIndex(root string, m *manifest.Manifest) (Result, error) {
	rel := manifest.EffectiveIndexPath(m)
	var fs []findings.Finding
	staleTrue := true
	if !fsx.IsFile(filepath.Join(root, rel)) {
		fs = append(fs, findings.New("index-required", findings.Error,
			"index "+rel+" does not exist; run `leji index`", rel))
		return Result{Index: nil, Findings: fs, Stale: &staleTrue}, nil
	}
	if !fsx.ResolvedWithinRoot(root, filepath.Join(root, rel)) {
		fs = append(fs, findings.New("artifact-parse", findings.Error,
			fmt.Sprintf("artifact %s resolves outside the layer root", rel), rel))
		return Result{Index: nil, Findings: fs, Stale: &staleTrue}, nil
	}

	stored, err := LoadStoredIndex(root, m)
	if err != nil {
		return Result{}, err
	}
	if stored == nil {
		fs = append(fs, findings.New("artifact-parse", findings.Error, "stored index is not valid JSON", rel))
		return Result{Index: nil, Findings: fs, Stale: &staleTrue}, nil
	}
	for _, e := range schemas.SchemaErrors("context-index", stored) {
		fs = append(fs, findings.New("artifact-schema", findings.Error, e, rel))
	}
	if sv, ok := stored["schemaVersion"].(string); ok && !contains(schemas.SupportedLines, sv) {
		fs = append(fs, findings.New("schema-version", findings.Error,
			fmt.Sprintf("schemaVersion %q is not supported by this SDK", sv), rel))
	}
	if len(fs) > 0 {
		return Result{Index: nil, Findings: fs, Stale: &staleTrue}, nil
	}

	regen, err := GenerateIndex(root, m)
	if err != nil {
		return Result{}, err
	}
	// A regeneration that itself errors (missing/malformed index file, a
	// category-conflict, a dangling entry) means the tree cannot be indexed
	// cleanly, so the stored index cannot be current: fail rather than compare a
	// partial regen against it and falsely pass.
	var regenErrors []findings.Finding
	for _, f := range regen.Findings {
		if f.Severity == findings.Error {
			regenErrors = append(regenErrors, f)
		}
	}
	if len(regenErrors) > 0 {
		fs = append(fs, regenErrors...)
		return Result{Index: nil, Findings: fs, Stale: &staleTrue}, nil
	}
	wantEntries := make([]any, 0, len(regen.Index.Entries))
	for _, e := range regen.Index.Entries {
		wantEntries = append(wantEntries, entryComparable(e))
	}
	want := StableStringify(map[string]any{
		"rootPath": regen.Index.RootPath,
		"entries":  wantEntries,
		"mounts":   mountComparables(regen.Index.Mounts),
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
	gotMounts := []any{}
	if sm, ok := stored["mounts"].([]any); ok {
		gotMounts = sm
	}
	got := StableStringify(map[string]any{
		"rootPath": gotRoot,
		"entries":  gotEntries,
		"mounts":   gotMounts,
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
		return Result{Index: nil, Findings: fs, Stale: &staleTrue}, nil
	}

	var items []layer.IDItem
	for _, e := range stEntries {
		p, _ := e["path"].(string)
		items = append(items, layer.IDItem{ID: e["id"], RelPath: p})
	}
	staleFalse := false
	out := append([]findings.Finding{}, regen.Findings...)
	out = append(out, layer.DuplicateIDFindings(items, "index")...)
	return Result{Index: nil, Findings: out, Stale: &staleFalse}, nil
}

var entryKeyOrder = []string{
	"id", "path", "title", "category", "kind", "date", "summary", "tags", "owners",
	"lastModified", "contentHash", "freshness", "links",
}

// SerializeIndex emits the index matching JSON.stringify(_, null, 2)+"\n".
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
	if len(index.Mounts) > 0 {
		mounts := make([]json.RawMessage, 0, len(index.Mounts))
		for _, mt := range index.Mounts {
			mounts = append(mounts, orderedMountJSON(mt))
		}
		out.set("mounts", mounts)
	}
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
		case "kind":
			o.set("kind", e.Kind)
		case "date":
			if e.Date != "" {
				o.set("date", e.Date)
			}
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

var mountKeyOrder = []string{"name", "source", "pin", "trackingRef", "owner", "role", "categories", "topics", "requiredWhen"}

func orderedMountJSON(mt IndexMount) json.RawMessage {
	o := newOrdered()
	for _, key := range mountKeyOrder {
		switch key {
		case "name":
			o.set("name", mt.Name)
		case "source":
			o.set("source", mt.Source)
		case "pin":
			o.set("pin", mt.Pin)
		case "trackingRef":
			if mt.TrackingRef != "" {
				o.set("trackingRef", mt.TrackingRef)
			}
		case "owner":
			ow := newOrdered()
			ow.set("name", mt.Owner.Name)
			if mt.Owner.Contact != "" {
				ow.set("contact", mt.Owner.Contact)
			}
			o.set("owner", ow)
		case "role":
			if mt.Role != "" {
				o.set("role", mt.Role)
			}
		case "categories":
			if mt.Categories != nil {
				o.set("categories", mt.Categories)
			}
		case "topics":
			if mt.Topics != nil {
				o.set("topics", mt.Topics)
			}
		case "requiredWhen":
			if mt.RequiredWhen != nil {
				o.set("requiredWhen", mt.RequiredWhen)
			}
		}
	}
	var buf bytes.Buffer
	o.encodeIndent(&buf, "", "  ")
	return json.RawMessage(buf.Bytes())
}

// WriteIndex generates and writes the index to the effective path.
func WriteIndex(root string, m *manifest.Manifest) (Result, error) {
	rel := manifest.EffectiveIndexPath(m)
	result, err := GenerateIndex(root, m)
	if err != nil {
		return Result{}, err
	}
	// Refuse to write a partial or incorrect index when generation hit a hard
	// error (e.g. category-conflict, index-file-parse, a dangling entry): writing
	// would persist a half-correct artifact that later reads trust.
	for _, f := range result.Findings {
		if f.Severity == findings.Error {
			return result, nil
		}
	}
	if result.Index != nil {
		abs := filepath.Join(root, rel)
		// The write chokepoint judges the RESOLVED destination immediately before the
		// write, catching a symlinked ancestor before anything is created under it.
		verdict, err := fsx.WriteFileGuarded(fsx.GuardRoot(root), abs, "",
			[]byte(SerializeIndex(result.Index)), fsx.WriteOptions{})
		if err != nil {
			return result, err
		}
		if !verdict.OK {
			result.Findings = append(result.Findings, findings.New("artifact-parse", findings.Error,
				fmt.Sprintf("index path %s resolves outside the layer root", rel), rel))
			return result, nil
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
