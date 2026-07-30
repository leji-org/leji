package layer

import (
	"errors"
	"regexp"
	"sort"
	"strings"

	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/jsonenc"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

// quoteJSON renders s exactly as Node's JSON.stringify(s) would, so a message
// interpolating a caller-supplied string is byte-identical across the SDKs.
func quoteJSON(s string) string {
	b, _ := jsonenc.Marshal(s)
	return string(b)
}

// LiveStatuses are the decision-record statuses that bind as routable current
// guidance: `accepted` is current, `deprecated` binds with a stale posture.
// `superseded`, `proposed`, and `rejected` never bind (Task routing, status filter).
var LiveStatuses = []string{"accepted", "deprecated"}

// RouteInput is a task's scope: the repo-relative POSIX paths it reads or changes,
// any categories and topics it explicitly names, and the reference date for the
// Expired flag.
type RouteInput struct {
	// Paths are normalized on the way in (NormalizeTaskPath); one with no
	// root-relative form is an input error, never a silent non-match.
	Paths      []string
	Categories []string
	// Topics the task explicitly names. Caller-supplied routing signals, never
	// derived here from paths, categories, prose, or content. Matched against a
	// mount's declared `topics` by exact string equality; duplicates collapse to
	// one signal, and an invalid entry is an error rather than being dropped.
	Topics []string
	AsOf   string
}

// RoutedDecision is a live decision record routed for a task, with why it matched
// ("unscoped", "path", or "category"). Decisions carry no review horizon (their
// schema forbids freshness), so ReviewAfter is always nil and Expired always false.
type RoutedDecision struct {
	ID          string
	Path        string
	Status      string
	MatchedBy   string
	ReviewAfter *string
	Expired     bool
}

// RoutedDocument is a governed category document whose category a task selects,
// stamped with its review horizon and whether it has expired as of the input date.
type RoutedDocument struct {
	Path        string
	Category    string
	ReviewAfter *string
	Expired     bool
}

// RoutedRecord is a governed record routed as a dated candidate, never as
// current intent. A record is Required only when the task's path scope selects
// it directly; being a category match (or the newest by date) never makes it
// required.
type RoutedRecord struct {
	Path     string
	Category string
	// Date is the record's frontmatter date, or nil when it declares none.
	Date     *string
	Required bool
}

// recordDateRe is the only shape a record's routed date may take; it comes from
// explicit frontmatter `date`, never scraped from prose or filenames.
var recordDateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z)?$`)

// freshnessOf reads a document's freshness.reviewAfter and whether it has passed asOf.
func freshnessOf(fm map[string]any, asOf string) (*string, bool) {
	fr, ok := fm["freshness"].(map[string]any)
	if !ok {
		return nil, false
	}
	ra, ok := fr["reviewAfter"].(string)
	if !ok {
		return nil, false
	}
	expired := asOf != "" && ra < asOf
	return &ra, expired
}

// RoutedMount is a federated sibling matched by the supplied category or topic
// signals. Both are machine-decidable: categories by the signalled set, `topics`
// by exact string equality against the topics the task names. `requiredWhen`
// stays free-text the agent judges, so absence here does not prove a mount
// irrelevant or not required.
type RoutedMount struct {
	Name string
	Pin  string
}

// HasLoneSurrogate reports whether s carries a UTF-16 surrogate code point. A Go
// string is UTF-8 bytes, so a surrogate arrives as its three-byte WTF-8 encoding
// (ED A0 80 .. ED BF BF), which is invalid UTF-8 and which utf8.DecodeRune
// refuses byte by byte. The TS test is `/\p{Surrogate}/u`, and under the `u` flag
// a matched pair is one astral scalar value, so only a lone surrogate matches.
func HasLoneSurrogate(s string) bool {
	for i := 0; i+2 < len(s); i++ {
		if s[i] == 0xED && s[i+1] >= 0xA0 && s[i+1] <= 0xBF && s[i+2] >= 0x80 && s[i+2] <= 0xBF {
			return true
		}
	}
	return false
}

// topicDefect is why a value is not a valid topic, or "" when it is one. A topic
// is a non-empty string of Unicode scalar values, so an unpaired surrogate (which
// has no UTF-8 encoding) is as invalid as an empty string. The TS reference also
// classifies `not a string`; Go's manifest and argv are typed []string, so that
// class has no representable value here.
func topicDefect(t string) string {
	if t == "" {
		return "empty string"
	}
	if HasLoneSurrogate(t) {
		return "lone surrogate"
	}
	return ""
}

// taskTopicSet is the effective task topic set, after validating BOTH sides of
// the comparison (spec: Task routing, Topic match). An invalid topic is an input
// error on either side, never a silent filter: dropping one would return a
// plausible empty match the caller cannot tell from a real one, and dropping the
// same lone surrogate from both sides would let two invalid values appear to
// match. The set dedupes by exact equality, which for valid topics is equality of
// their UTF-8 encodings.
func taskTopicSet(input RouteInput, m *manifest.Manifest) (map[string]bool, error) {
	for _, t := range input.Topics {
		if d := topicDefect(t); d != "" {
			return nil, errors.New("invalid task topic: " + d)
		}
	}
	if m.Federation != nil {
		for _, mt := range m.Federation.Mounts {
			for _, t := range mt.Topics {
				if d := topicDefect(t); d != "" {
					return nil, errors.New("invalid mount topic on \"" + mt.Name + "\": " + d)
				}
			}
		}
	}
	set := map[string]bool{}
	for _, t := range input.Topics {
		set[t] = true
	}
	return set, nil
}

// RouteResult is the slice of governed context a task's scope selects.
// Documents holds governed INTENT documents only (the required context);
// Records holds the selected categories' governed records: dated candidates the
// agent loads by judgment (decision records route via Decisions, never here).
// Both are sorted by path.
type RouteResult struct {
	PathScoped      bool
	Categories      []string
	CategorySignals []string
	Documents       []RoutedDocument
	Records         []RoutedRecord
	Decisions       []RoutedDecision
	Mounts          []RoutedMount
}

// pathsOverlap is overlap-aware, bidirectional path containment: a and b match
// when equal or one is an ancestor directory of the other.
func pathsOverlap(a, b string) bool {
	return fsx.UnderPath(a, b) || fsx.UnderPath(b, a)
}

// NormalizeTaskPath normalizes one task-scope path (spec: Requirement 6 and Task
// routing items 1-2): POSIX-style, root-relative, no leading `./`, any trailing
// `/` removed, and `.` and `..` segments resolved lexically. Never consults the
// filesystem. The repository root normalizes to ".", which the containment
// relation treats as matching everything.
//
// The second result is false for a path with no root-relative form: an absolute
// path, or one whose `..` segments climb above the root. Callers reject those
// rather than pass them through — an unnormalized task path silently fails to
// match the declared side, which is how `--federation=required` used to pass open
// on `./docs/x.md` and on `docs/x.md/` while failing correctly on `docs/x.md`.
//
// Deliberately not path.Clean: Clean maps an escaping "../x" to "../x" and an
// absolute path to itself, so it cannot report the rejection this owes its caller.
func NormalizeTaskPath(p string) (string, bool) {
	if strings.HasPrefix(p, "/") {
		return "", false
	}
	out := []string{}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." {
			continue
		}
		if seg == ".." {
			if len(out) == 0 {
				return "", false
			}
			out = out[:len(out)-1]
			continue
		}
		out = append(out, seg)
	}
	if len(out) == 0 {
		return ".", true
	}
	return strings.Join(out, "/"), true
}

func asStringSlice(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, e := range arr {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func contains(slice []string, x string) bool {
	for _, s := range slice {
		if s == x {
			return true
		}
	}
	return false
}

// Route computes the routed slice for a task's scope (Task routing,
// spec/machine-readable-surface.md). It composes the category-assignment and
// decision-record scans. It errors on an unnormalizable task path, and on an
// invalid topic on either side of the comparison: a caller topic or a declared
// mount topic that is not a
// non-empty string of Unicode scalar values is an input error. Everything else is
// tolerant as before (malformed records simply do not bind). Topics are matched
// as exact strings: no case conversion, no Unicode normalization, no locale, no
// trimming.
func Route(root string, m *manifest.Manifest, input RouteInput) (RouteResult, error) {
	// Both sides of the comparison normalize, or the matching is not the spec's.
	// An unnormalizable path is an input error, never a silent non-match: the
	// caller cannot tell a scope that routes nothing from one it spelled wrongly,
	// and a federation gate reading the second as the first fails open.
	taskPaths := make([]string, 0, len(input.Paths))
	for _, p := range input.Paths {
		if p == "" {
			continue
		}
		normalized, ok := NormalizeTaskPath(p)
		if !ok {
			return RouteResult{}, errors.New("invalid task path " + quoteJSON(p) +
				`: must be repository-root-relative POSIX (no leading "/", no ".." above the root)`)
		}
		taskPaths = append(taskPaths, normalized)
	}
	pathScoped := len(taskPaths) > 0
	taskTopics, err := taskTopicSet(input, m)
	if err != nil {
		return RouteResult{}, err
	}

	scan := ScanCategories(root, m)
	assignments := map[string]string{}
	kindByPath := map[string]string{}
	fmByPath := map[string]map[string]any{}
	for _, d := range scan.Docs {
		assignments[d.RelPath] = d.Category
		kindByPath[d.RelPath] = d.Kind
		fmByPath[d.RelPath] = d.Frontmatter
	}

	// Two category sets (spec: Task routing, item 3). A category the task NAMES is
	// expanded: it loads its intent documents and record candidates. A task path that
	// is itself a governed document contributes its category to signalled only — a
	// matching signal for decisions and mounts that loads nothing. The governed-document
	// test is exact equality, never containment: an ancestor directory of a governed
	// document is not itself governed, and inferring from one would reopen the corpus
	// fan-out this split exists to close.
	expanded := map[string]bool{}
	for _, c := range input.Categories {
		if contains(manifest.CategoryIDs, c) {
			expanded[c] = true
		}
	}
	signalled := map[string]bool{}
	for c := range expanded {
		signalled[c] = true
	}
	for _, p := range taskPaths {
		if cat, ok := assignments[p]; ok {
			signalled[cat] = true
		}
	}

	// Routing separation: intent documents are the required context; records are
	// returned separately as dated candidates. A record is required only when the
	// task's paths select it directly.
	// A record or document is DIRECTLY selected when a task path contains it under the
	// lexical rule — collected independently of category, because a path scope selects
	// no category at all and the entry would otherwise be dropped here.
	directlySelected := func(p string) bool {
		for _, tp := range taskPaths {
			if pathsOverlap(tp, p) {
				return true
			}
		}
		return false
	}
	docPaths := make([]string, 0, len(assignments))
	for p := range assignments {
		if expanded[assignments[p]] || directlySelected(p) {
			docPaths = append(docPaths, p)
		}
	}
	sort.Strings(docPaths)
	documents := make([]RoutedDocument, 0, len(docPaths))
	records := []RoutedRecord{}
	for _, p := range docPaths {
		category := assignments[p]
		if kindByPath[p] == "record" {
			// Decision records route via Decisions, never as generic records.
			if category == "decisions" {
				continue
			}
			var date *string
			if fm := fmByPath[p]; fm != nil {
				if d, ok := fm["date"].(string); ok && recordDateRe.MatchString(d) {
					date = &d
				}
			}
			required := directlySelected(p)
			records = append(records, RoutedRecord{Path: p, Category: category, Date: date, Required: required})
			continue
		}
		ra, expired := freshnessOf(fmByPath[p], input.AsOf)
		documents = append(documents, RoutedDocument{Path: p, Category: category, ReviewAfter: ra, Expired: expired})
	}

	decisions := []RoutedDecision{}
	for _, rec := range ScanDecisionRecords(root, m) {
		fm := rec.Frontmatter
		if fm == nil {
			continue
		}
		status, _ := fm["status"].(string)
		if !contains(LiveStatuses, status) {
			continue
		}
		affectedPaths := asStringSlice(fm["affectedPaths"])
		affectedCategories := asStringSlice(fm["affectedCategories"])
		id, _ := fm["id"].(string)

		matchedBy := ""
		switch {
		case len(affectedPaths) == 0 && len(affectedCategories) == 0:
			matchedBy = "unscoped"
		case pathMatches(taskPaths, affectedPaths):
			matchedBy = "path"
		case categoryMatches(affectedCategories, signalled):
			matchedBy = "category"
		}
		if matchedBy != "" {
			decisions = append(decisions, RoutedDecision{ID: id, Path: rec.RelPath, Status: status, MatchedBy: matchedBy, ReviewAfter: nil, Expired: false})
		}
	}

	categories := []string{}
	for _, c := range manifest.CategoryIDs {
		if expanded[c] {
			categories = append(categories, c)
		}
	}

	categorySignals := []string{}
	for _, c := range manifest.CategoryIDs {
		if signalled[c] {
			categorySignals = append(categorySignals, c)
		}
	}

	// Mounts matched by the supplied signals: a sibling whose declared categories
	// overlap the SIGNALLED set, or whose declared topics contain one the task
	// named. Signals match without expanding, so a path-scoped task still sees its
	// mounts, and a topic match selects the mount and nothing else: it never enters
	// the category sets, loads no document or record, and routes no decision. The
	// agent still applies the mount's free-text requiredWhen.
	mounts := []RoutedMount{}
	if m.Federation != nil {
		for _, mt := range m.Federation.Mounts {
			matched := false
			for _, c := range mt.Categories {
				if signalled[c] {
					matched = true
					break
				}
			}
			if !matched {
				for _, t := range mt.Topics {
					if taskTopics[t] {
						matched = true
						break
					}
				}
			}
			if matched {
				mounts = append(mounts, RoutedMount{Name: mt.Name, Pin: mt.Pin})
			}
		}
		sort.Slice(mounts, func(i, j int) bool { return mounts[i].Name < mounts[j].Name })
	}

	sort.Slice(decisions, func(i, j int) bool { return decisions[i].Path < decisions[j].Path })

	return RouteResult{PathScoped: pathScoped, Categories: categories, CategorySignals: categorySignals, Documents: documents, Records: records, Decisions: decisions, Mounts: mounts}, nil
}

func pathMatches(taskPaths, affectedPaths []string) bool {
	for _, tp := range taskPaths {
		for _, ap := range affectedPaths {
			if pathsOverlap(tp, ap) {
				return true
			}
		}
	}
	return false
}

func categoryMatches(affectedCategories []string, selected map[string]bool) bool {
	for _, c := range affectedCategories {
		if selected[c] {
			return true
		}
	}
	return false
}
