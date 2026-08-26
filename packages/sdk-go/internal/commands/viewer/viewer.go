// Package viewer projects the context index into a static Docsify viewer: the
// chrome generation and the layer helpers both of its consumers share. The two
// consumers live in their own packages, so what each one drags in is visible in the
// import graph rather than buried in one file: `commands/serve` keeps the local
// preview server and every network import with it, and `commands/export` writes the
// static site — its transitive import set carries no network package at all, which
// is the structural half of the export's no-network guarantee and is asserted as
// such.
package viewer

import (
	"bytes"
	"io"
	"math"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/leji-org/leji/packages/sdk-go/internal/assets"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/indexgen"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/frontmatter"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/jsonenc"
	"github.com/leji-org/leji/packages/sdk-go/internal/layer"
	"github.com/leji-org/leji/packages/sdk-go/internal/layout"
	"github.com/leji-org/leji/packages/sdk-go/internal/lejiignore"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
	"github.com/leji-org/leji/packages/sdk-go/internal/mounts"
)

// ResolveViewerPort: explicit flag, then manifest viewer.port, then 5354.
func ResolveViewerPort(m *manifest.Manifest, flagPort *int) int {
	if flagPort != nil {
		return *flagPort
	}
	if m.Viewer != nil && m.Viewer.Port != nil {
		return *m.Viewer.Port
	}
	return 5354
}

type Result struct {
	Written  []string
	Findings []findings.Finding
	Entries  int
	// IndexEntries is never nil after GenerateViewer returns, empty run included: it is
	// the snapshot a caller hands the local server, and there nil means "no snapshot"
	// (the reference's `undefined`) rather than "no entries".
	//
	// IndexEntries are the index entries this run projected, so a caller that renders
	// from the same generation (the export's overview map) reads one snapshot rather
	// than making a second one. Empty when the run refused to project anything.
	IndexEntries []indexgen.IndexEntry
}

// categoryLabels label the layer-map (mermaid) category nodes; the sidebar
// groups by index-file H1 instead.
var categoryLabels = map[string]string{
	"domain":     "Domain",
	"system":     "System",
	"practice":   "Practice",
	"governance": "Governance",
	"decisions":  "Decisions",
}

// bootEmoji is the boot profile's emoji, matching the emoji'd category groups
// below it.
const bootEmoji = "🤖"

// defaultAgentsLabel labels the derived agents sidebar group unless
// viewer.agentsLabel curates it.
const defaultAgentsLabel = "🤖 Agents"

// categoryEmoji is the default per-category sidebar emoji, overridable via
// manifest viewer.categoryEmojis. Baked identically into every SDK so the
// generated sidebar stays byte-identical.
var categoryEmoji = map[string]string{
	"domain":     "📖",
	"system":     "⚙️",
	"practice":   "🛠️",
	"governance": "🛡️",
	"decisions":  "🧭",
}

// defaultThemeColor is the default accent (Leji brand green) when no
// viewer.theme.primary is set.
const defaultThemeColor = "#009F71"

// The base every URL the generated chrome emits is written against: "/" for the
// local server (the app root, the served flavor's unchanged contract) and "" for
// an export, whose references then resolve against the page itself so the tree
// hosts correctly under a subpath. It is a generation parameter, never a post-hoc
// rewrite of emitted HTML: one code path, two invocations. index.html is the only
// artifact that exists in two flavors — everything else under the chrome is
// flavor-neutral.
const (
	servedBase = "/"
	ExportBase = ""
)

// defaultLogo is the vendored Leji mark, as the given base addresses it.
func defaultLogo(base string) string { return base + "assets/leji-logo.svg" }

// mermaidAssets are loaded only when mermaid is enabled.
var mermaidAssets = map[string]bool{
	"mermaid.min.js":     true,
	"docsify-mermaid.js": true,
}

// safeCSSColor matches the one accent format the viewer accepts: a hex color at a
// length CSS actually defines (#RGB, #RGBA, #RRGGBB, #RRGGBBAA). The accent reaches
// a stylesheet as a custom-property value, so anything with punctuation in it is a
// CSS-injection sink, not a color; hex-only also keeps one canonical form across the
// three SDKs and the schema. `$` here is end of text — Go's default, no multiline
// flag — so a trailing newline does not slip a hex through.
var safeCSSColor = regexp.MustCompile(`^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$`)

// resolveThemeColor returns the viewer accent: viewer.theme.primary when it is a
// hex color, else the Leji default with a warning. Never the authored value
// unchecked. Mirrors the Node SDK's resolveThemeColor, warning included.
func resolveThemeColor(m *manifest.Manifest, fnds *[]findings.Finding) string {
	if m.Viewer == nil || m.Viewer.Theme == nil || m.Viewer.Theme.Primary == "" {
		return defaultThemeColor
	}
	configured := m.Viewer.Theme.Primary
	if safeCSSColor.MatchString(configured) {
		return configured
	}
	*fnds = append(*fnds, findings.NewNoPath("viewer-theme-invalid", findings.Warning,
		`viewer.theme.primary "`+configured+`" is not a hex color (#RGB, #RGBA, #RRGGBB, or #RRGGBBAA); using `+defaultThemeColor))
	return defaultThemeColor
}

// hexDigits matches the bare hex an accent reduces to once the leading `#` is out
// of the way; the length check follows.
var hexDigits = regexp.MustCompile(`^[0-9a-f]+$`)

// srgb is an opaque sRGB triple: the form an accent resolves to once any alpha it
// carried has been composited away.
type srgb struct{ r, g, b int }

// parseAccentColor resolves the accent to opaque sRGB channels, reporting false for
// a value that names no color the generator can resolve — a keyword, `currentColor`,
// a malformed hex. Accepts 3/4/6/8-digit hex, the only form the accent can take; an
// accent carrying alpha is composited over white, the viewer's content background,
// which is the only backdrop knowable at generation time (the accent itself keeps
// its authored alpha everywhere it is used — this composite decides text color,
// nothing that renders).
func parseAccentColor(value string) (srgb, bool) {
	raw := strings.ToLower(strings.TrimSpace(value))
	hex, ok := strings.CutPrefix(raw, "#")
	if !ok || !hexDigits.MatchString(hex) {
		return srgb{}, false
	}
	var full string
	switch len(hex) {
	case 3, 4:
		var doubled strings.Builder
		for _, c := range hex {
			doubled.WriteRune(c)
			doubled.WriteRune(c)
		}
		full = doubled.String()
	case 6, 8:
		full = hex
	default:
		return srgb{}, false
	}
	channel := func(i int) int {
		v, _ := strconv.ParseUint(full[i*2:i*2+2], 16, 16)
		return int(v)
	}
	alpha := 1.0
	if len(full) == 8 {
		alpha = float64(channel(3)) / 255
	}
	over := func(c int) int {
		return int(math.Round(float64(c)*alpha + 255*(1-alpha)))
	}
	return srgb{over(channel(0)), over(channel(1)), over(channel(2))}, true
}

// relativeLuminance is the WCAG relative luminance: linearized sRGB channels, weighted.
func relativeLuminance(c srgb) float64 {
	linear := func(v int) float64 {
		s := float64(v) / 255
		if s <= 0.03928 {
			return s / 12.92
		}
		return math.Pow((s+0.055)/1.055, 2.4)
	}
	return 0.2126*linear(c.r) + 0.7152*linear(c.g) + 0.0722*linear(c.b)
}

// contrastRatio is the WCAG contrast ratio between two relative luminances.
func contrastRatio(a, b float64) float64 {
	return (math.Max(a, b) + 0.05) / (math.Min(a, b) + 0.05)
}

// mermaidTextColor is the mermaid node-text color for an accent, computed here
// rather than in the browser: the viewer's boot script sees only what the config
// block carries, while this side can resolve every color form viewer.theme.primary
// accepts. Whichever of #1a1a1a and #ffffff contrasts more with the accent, or
// #000000 when neither clears WCAG AA (4.5:1) — a mid-gray accent, where the extra
// half-stop of black is the best text color available. An accent this cannot
// resolve keeps the dark default, which is also the boot script's fallback.
// Mirrors the Node SDK's mermaidTextColor.
func mermaidTextColor(themeColor string) string {
	c, ok := parseAccentColor(themeColor)
	if !ok {
		return "#1a1a1a"
	}
	accent := relativeLuminance(c)
	onDark := contrastRatio(relativeLuminance(srgb{0x1a, 0x1a, 0x1a}), accent)
	onLight := contrastRatio(1, accent)
	if onDark < 4.5 && onLight < 4.5 {
		return "#000000"
	}
	if onDark >= onLight {
		return "#1a1a1a"
	}
	return "#ffffff"
}

var httpURLRe = regexp.MustCompile(`^https?://`)

// placeholderRe matches the template's `{{NAME}}` substitution sites.
var placeholderRe = regexp.MustCompile(`\{\{([A-Z_]+)\}\}`)

// resolveViewerRel resolves a viewer-configured file path to a rootPath-relative
// rel. The canonical form is rootPath-relative, but a repository-root-relative
// path under the context root is accepted too (`docs/README.md` for `README.md`):
// the manifest's pins are repo-relative, so authors mix the forms. Returns
// ok=false when neither form names an existing file.
func resolveViewerRel(root, rootPath, value string) (string, bool) {
	clean := strings.TrimPrefix(fsx.StripSlash(value), "./")
	base := fsx.StripSlash(rootPath)
	joined := filepath.Join(root, clean)
	if base != "" && base != "." {
		joined = filepath.Join(root, base, clean)
	}
	if fsx.IsFile(joined) {
		return clean, true
	}
	if stripped, ok := RelativeToRoot(clean, rootPath); ok && fsx.IsFile(filepath.Join(root, clean)) {
		return stripped, true
	}
	return "", false
}

// effectiveHomepage is the homepage rel served by the viewer: viewer.homepage in
// either path form, defaulting to the seeded overview. An unresolvable configured
// value is kept as authored (Docsify will 404 it) and reported as a warning.
func effectiveHomepage(root string, m *manifest.Manifest, fnds *[]findings.Finding) string {
	configured := ""
	if m.Viewer != nil {
		configured = m.Viewer.Homepage
	}
	if configured == "" {
		return "overview.md"
	}
	if rel, ok := resolveViewerRel(root, m.RootPath, configured); ok {
		return rel
	}
	*fnds = append(*fnds, findings.New("viewer-path-missing", findings.Warning,
		`viewer.homepage "`+configured+`" does not resolve to a file under the context root`, configured))
	return fsx.StripSlash(configured)
}

// resolveLogo resolves the viewer logo URL: a configured path is served from the
// content mount (or used as-is when absolute); unset falls back to the vendored mark.
func resolveLogo(root, rootPath, logo, base string) string {
	if logo == "" {
		return defaultLogo(base)
	}
	if strings.HasPrefix(logo, "/") || httpURLRe.MatchString(logo) {
		return logo
	}
	if rel, ok := resolveViewerRel(root, rootPath, logo); ok {
		return base + "content/" + rel
	}
	return base + "content/" + fsx.StripSlash(logo)
}

// htmlEscape escapes text for HTML element/attribute content, matching the Node
// SDK byte-for-byte (& < > " '). Can't use html.EscapeString: it emits &#34; for
// the double quote where Node emits &quot;.
func htmlEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, "\"", "&quot;")
	s = strings.ReplaceAll(s, "'", "&#39;")
	return s
}

func RelativeToRoot(relPath, rootPath string) (string, bool) {
	base := fsx.StripSlash(rootPath)
	if base == "" || base == "." {
		return relPath, true
	}
	if strings.HasPrefix(relPath, base+"/") {
		return relPath[len(base)+1:], true
	}
	return "", false
}

// mdLinkText escapes Markdown link text (`[...]`: backslash, brackets, and the
// angle brackets that would otherwise land as live HTML, since a manifest label
// or a frontmatter title reaches the generated sidebar verbatim); mdLinkDest
// escapes a link destination (`(...)`: backslash, parens). Both mirror the Node
// SDK so the sidebar is byte-identical.
var (
	mdLinkTextRe = regexp.MustCompile(`[\\\[\]<>]`)
	mdLinkDestRe = regexp.MustCompile(`[\\()]`)
)

func mdLinkText(s string) string {
	return mdLinkTextRe.ReplaceAllString(s, `\$0`)
}

// Destinations are emitted app-root absolute (leading slash): with the viewer's
// relativePath routing, a bare rootPath-relative destination would re-resolve
// against whatever nested route is current and double-prefix; leading-slash links
// are exempt from relative resolution by Docsify's contract. Idempotent: leading
// slashes are trimmed first, so an already-absolute destination never becomes
// `//…`, which Docsify routes as an external protocol-relative URL. Empty input
// stays empty, never a bare `/`.
func mdLinkDest(s string) string {
	escaped := mdLinkDestRe.ReplaceAllString(strings.TrimLeft(s, "/"), `\$0`)
	if escaped == "" {
		return ""
	}
	return "/" + escaped
}

// TreeNode is a reference doc in the browse zone: rootPath-relative path and title.
type TreeNode struct {
	Rel   string
	Title string
}

var dirSepRe = regexp.MustCompile(`[-_]+`)

// prettifyDirName turns a directory segment into a non-link label: separators to
// spaces, title-cased so derived labels read like curated ones. Mirrors Node's
// `\b\p{Ll}` upper-casing: the boundary uses JS word chars ([A-Za-z0-9_]) while
// the cased char is any Unicode lowercase letter.
func prettifyDirName(name string) string {
	s := strings.TrimSpace(dirSepRe.ReplaceAllString(name, " "))
	isWord := func(r rune) bool {
		return r == '_' || (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
	}
	runes := []rune(s)
	var b strings.Builder
	for i, r := range runes {
		boundary := false
		if i == 0 {
			boundary = isWord(r)
		} else {
			boundary = isWord(runes[i-1]) != isWord(r)
		}
		if boundary && unicode.Is(unicode.Ll, r) {
			b.WriteString(strings.ToUpper(string(r)))
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

type dirTree struct {
	dirs  map[string]*dirTree
	order []string // child dir names in first-insertion order
	files []TreeNode
}

func newDirTree() *dirTree { return &dirTree{dirs: map[string]*dirTree{}} }

// buildTreeSection renders reference docs as a nested list mirroring the directory
// tree: folders are bold non-link labels, files are links; sorted by name within
// each directory. Single-child folder chains are path-compressed ("Wood Badge /
// Ticket"), so a lone reference file never sits under a stack of single-child
// bold labels.
func buildTreeSection(nodes []TreeNode) []string {
	sorted := append([]TreeNode{}, nodes...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Rel < sorted[j].Rel })
	root := newDirTree()
	for _, node := range sorted {
		parts := strings.Split(node.Rel, "/")
		cur := root
		for i := 0; i < len(parts)-1; i++ {
			seg := parts[i]
			child, ok := cur.dirs[seg]
			if !ok {
				child = newDirTree()
				cur.dirs[seg] = child
				cur.order = append(cur.order, seg)
			}
			cur = child
		}
		cur.files = append(cur.files, node)
	}
	var lines []string
	type merged struct {
		name string
		dir  *dirTree
		file *TreeNode
	}
	var render func(node *dirTree, depth int)
	render = func(node *dirTree, depth int) {
		indent := strings.Repeat("  ", depth)
		var items []merged
		for _, name := range node.order {
			items = append(items, merged{name: name, dir: node.dirs[name]})
		}
		for i := range node.files {
			f := node.files[i]
			items = append(items, merged{name: lastSeg(f.Rel), file: &f})
		}
		sort.SliceStable(items, func(i, j int) bool { return items[i].name < items[j].name })
		for _, e := range items {
			if e.dir != nil {
				// Path-compress single-child chains: a folder holding nothing but
				// one subfolder merges its label.
				names := []string{e.name}
				dir := e.dir
				for len(dir.files) == 0 && len(dir.order) == 1 {
					childName := dir.order[0]
					names = append(names, childName)
					dir = dir.dirs[childName]
				}
				pretty := make([]string, 0, len(names))
				for _, n := range names {
					pretty = append(pretty, prettifyDirName(n))
				}
				lines = append(lines, indent+"- **"+strings.Join(pretty, " / ")+"**")
				render(dir, depth+1)
			} else if e.file != nil {
				lines = append(lines, indent+"- ["+mdLinkText(e.file.Title)+"]("+mdLinkDest(e.file.Rel)+")")
			}
		}
	}
	render(root, 0)
	return lines
}

func lastSeg(rel string) string {
	parts := strings.Split(rel, "/")
	return parts[len(parts)-1]
}

// SidebarEntry is a sidebar link: rootPath-relative target and display title.
// A document's kind and record date are page-level metadata (the classification
// chip), not sidebar decoration.
type SidebarEntry struct {
	Rel   string
	Title string
}

// SidebarGroup is a spine group: one curated index file's winners, labeled by
// its H1.
type SidebarGroup struct {
	Label   string
	Entries []SidebarEntry
}

// entryLine renders one sidebar link line.
func entryLine(indent string, e SidebarEntry) string {
	return indent + "- [" + mdLinkText(e.Title) + "](" + mdLinkDest(e.Rel) + ")"
}

// BuildSidebar projects a deterministic Docsify sidebar, two zones: the governed
// spine on top (boot profile, then any pinned pages, then one group per curated
// index file, labeled by the index file's own H1 in manifest order), and below a
// divider the reference-docs directory tree (browse zone). Membership follows
// selector resolution: a document appears in the group of the index file whose
// selector won it. Paths relative to rootPath.
func BuildSidebar(m *manifest.Manifest, groups []SidebarGroup, tree []TreeNode, pins []SidebarEntry, bootPinned bool) string {
	// Boot profile and pins above a divider, then index-file groups, then the tree.
	var topLines []string
	// Emoji inside the link text so the label stays on one line (links render as
	// block elements; an emoji outside would wrap above). A pinned boot profile
	// replaces this default line with the team's own label and position.
	if boot, ok := RelativeToRoot(m.BootProfilePath, m.RootPath); ok && !bootPinned {
		topLines = append(topLines, "- ["+bootEmoji+" Boot profile]("+mdLinkDest(boot)+")")
	}
	for _, pin := range pins {
		topLines = append(topLines, entryLine("", pin))
	}
	var groupLines []string
	for _, group := range groups {
		if len(group.Entries) == 0 {
			continue
		}
		// Bold labels: the sidebar-collapse plugin treats a strong label with a
		// nested list as a collapsible folder, matching hand-built sidebars.
		groupLines = append(groupLines, "- **"+mdLinkText(group.Label)+"**")
		groupLines = append(groupLines, buildGroupTree(group.Entries, group.Label)...)
	}
	// The browse zone renders as one collapsed "Reference" folder, not a bare
	// spill of links: a curated layer reads as pins + governed groups, with the
	// ungoverned tier behind a single, deliberately-named drawer.
	rawTree := buildTreeSection(tree)
	var treeLines []string
	if len(rawTree) > 0 {
		treeLines = append(treeLines, "- **Reference**")
		for _, l := range rawTree {
			treeLines = append(treeLines, "  "+l)
		}
	}
	var sections []string
	for _, s := range [][]string{topLines, groupLines, treeLines} {
		if len(s) > 0 {
			sections = append(sections, strings.Join(s, "\n"))
		}
	}
	return strings.Join(sections, "\n\n---\n\n") + "\n"
}

// groupLabel is an index file's group label: its first H1 (frontmatter title
// wins), else a prettified filename. The author's H1 carries any emoji or phrasing.
func groupLabel(root, indexRel string) string {
	return docTitle(root, indexRel)
}

var labelKeyRe = regexp.MustCompile(`[^\p{L}\p{N} ]`)

type groupDir struct {
	dirs  map[string]*groupDir
	order []string
	files []SidebarEntry
}

func newGroupDir() *groupDir { return &groupDir{dirs: map[string]*groupDir{}} }

// buildGroupTree renders a group's members as a nested tree mirroring their real
// directory structure: the members' longest common directory prefix is stripped
// (so a group whose content lives under one directory doesn't repeat it), deeper
// directories become bold sub-labels, and files render as links. Real
// repositories are not flat; the sidebar shouldn't be.
func buildGroupTree(entries []SidebarEntry, label string) []string {
	// Longest common directory prefix across all members.
	dirOf := func(rel string) []string {
		parts := strings.Split(rel, "/")
		return parts[:len(parts)-1]
	}
	prefix := dirOf(entries[0].Rel)
	for _, e := range entries[1:] {
		d := dirOf(e.Rel)
		i := 0
		for i < len(prefix) && i < len(d) && prefix[i] == d[i] {
			i++
		}
		prefix = prefix[:i]
	}
	strip := len(prefix)

	rootNode := newGroupDir()
	sorted := append([]SidebarEntry{}, entries...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Rel < sorted[j].Rel })
	for _, e := range sorted {
		parts := strings.Split(e.Rel, "/")[strip:]
		cur := rootNode
		for i := 0; i < len(parts)-1; i++ {
			seg := parts[i]
			child, ok := cur.dirs[seg]
			if !ok {
				child = newGroupDir()
				cur.dirs[seg] = child
				cur.order = append(cur.order, seg)
			}
			cur = child
		}
		cur.files = append(cur.files, e)
	}
	// Hoist a top-level directory whose name matches the group's own label (the
	// emoji-stripped comparison), so "💼 Business" never wraps a redundant
	// "Business" level while outlier members stay as siblings.
	labelKey := strings.ToLower(strings.TrimSpace(labelKeyRe.ReplaceAllString(label, "")))
	var mergeInto func(target, src *groupDir)
	mergeInto = func(target, src *groupDir) {
		target.files = append(target.files, src.files...)
		for _, name := range src.order {
			dir := src.dirs[name]
			if existing, ok := target.dirs[name]; ok {
				mergeInto(existing, dir)
			} else {
				target.dirs[name] = dir
				target.order = append(target.order, name)
			}
		}
	}
	for _, name := range append([]string{}, rootNode.order...) {
		if labelKey != "" && strings.ToLower(prettifyDirName(name)) == labelKey {
			dir := rootNode.dirs[name]
			delete(rootNode.dirs, name)
			for i, n := range rootNode.order {
				if n == name {
					rootNode.order = append(rootNode.order[:i], rootNode.order[i+1:]...)
					break
				}
			}
			mergeInto(rootNode, dir)
		}
	}

	var lines []string
	type merged struct {
		name string
		dir  *groupDir
		file *SidebarEntry
	}
	var render func(node *groupDir, depth int)
	render = func(node *groupDir, depth int) {
		indent := strings.Repeat("  ", depth+1)
		var items []merged
		for _, name := range node.order {
			items = append(items, merged{name: name, dir: node.dirs[name]})
		}
		for i := range node.files {
			f := node.files[i]
			items = append(items, merged{name: lastSeg(f.Rel), file: &f})
		}
		sort.SliceStable(items, func(i, j int) bool { return items[i].name < items[j].name })
		for _, e := range items {
			if e.dir != nil {
				lines = append(lines, indent+"- **"+mdLinkText(prettifyDirName(e.name))+"**")
				render(e.dir, depth+1)
			} else if e.file != nil {
				lines = append(lines, entryLine(indent, *e.file))
			}
		}
	}
	render(rootNode, 0)
	return lines
}

// BuildSidebarGroups computes the spine groups: one per curated index file, in
// manifest order (categories in canonical order, index files in their declared
// array order), containing the governed documents whose winning selector that
// file declared. Index files that share the same H1 label MERGE into one group:
// a topical group (a product area, a program) spans categories by splitting into
// per-category index files under one shared label. Documents outside rootPath
// are not servable and are skipped.
func BuildSidebarGroups(root string, m *manifest.Manifest, entries []indexgen.IndexEntry) []SidebarGroup {
	res := layer.ResolveCategoryAssignments(root, m, false)
	byPath := map[string]bool{}
	for _, e := range entries {
		byPath[e.Path] = true
	}
	paths := make([]string, 0, len(res.Assignments))
	for p := range res.Assignments {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	var groups []SidebarGroup
	seen := map[string]bool{}
	for _, category := range manifest.CategoryIDs {
		mapping, ok := m.Categories[category]
		if !ok {
			continue
		}
		for _, indexRel := range mapping.Indexes {
			if seen[indexRel] {
				continue
			}
			seen[indexRel] = true
			var members []SidebarEntry
			for _, relPath := range paths {
				if res.Assignments[relPath].IndexRel != indexRel {
					continue
				}
				if !byPath[relPath] {
					continue
				}
				rel, ok := RelativeToRoot(relPath, m.RootPath)
				if !ok {
					continue
				}
				members = append(members, SidebarEntry{Rel: rel, Title: sidebarLabel(root, relPath, rel)})
			}
			if len(members) == 0 {
				continue
			}
			groups = append(groups, SidebarGroup{Label: groupLabel(root, indexRel), Entries: members})
		}
	}
	// Agent profiles are artifacts outside category content, so the sidebar
	// surfaces them from the profile scan as their own group (label curated via
	// viewer.agentsLabel; first in derived order, reorderable by groupOrder).
	var agentMembers []SidebarEntry
	for _, p := range layer.ScanAgentProfiles(root, m) {
		rel, ok := RelativeToRoot(p.RelPath, m.RootPath)
		if !ok {
			continue
		}
		// A declared profiles directory can name a private role; its files are not
		// servable, so neither is the label lifted out of one. The route would 404
		// anyway — this keeps the bytes out of the sidebar that links it.
		if !servableSource(root, p.RelPath) {
			continue
		}
		title := ""
		if p.Frontmatter != nil {
			if n, isStr := p.Frontmatter["name"].(string); isStr && strings.TrimSpace(n) != "" {
				title = strings.TrimSpace(n)
			}
		}
		if title == "" {
			title = sidebarLabel(root, p.RelPath, rel)
		}
		agentMembers = append(agentMembers, SidebarEntry{Rel: rel, Title: title})
	}
	if len(agentMembers) > 0 {
		label := defaultAgentsLabel
		if m.Viewer != nil && m.Viewer.AgentsLabel != "" {
			label = m.Viewer.AgentsLabel
		}
		groups = append([]SidebarGroup{{Label: label, Entries: agentMembers}}, groups...)
	}
	// Merge same-labeled groups, keeping first-occurrence order.
	var mergedGroups []*SidebarGroup
	byLabel := map[string]*SidebarGroup{}
	for i := range groups {
		g := groups[i]
		if existing, ok := byLabel[g.Label]; ok {
			existing.Entries = append(existing.Entries, g.Entries...)
		} else {
			copied := g
			byLabel[g.Label] = &copied
			mergedGroups = append(mergedGroups, &copied)
		}
	}
	for _, g := range mergedGroups {
		entriesCopy := g.Entries
		sort.SliceStable(entriesCopy, func(i, j int) bool { return entriesCopy[i].Rel < entriesCopy[j].Rel })
	}
	// viewer.groupOrder curates group sequence by exact label: listed groups come
	// first in the given order; unlisted groups follow in derived order.
	var order []string
	if m.Viewer != nil {
		order = m.Viewer.GroupOrder
	}
	if len(order) > 0 {
		rank := make([]int, len(mergedGroups))
		for i, g := range mergedGroups {
			idx := -1
			for j, label := range order {
				if label == g.Label {
					idx = j
					break
				}
			}
			if idx == -1 {
				rank[i] = len(order) + i
			} else {
				rank[i] = idx
			}
		}
		type ranked struct {
			g *SidebarGroup
			r int
		}
		rankedGroups := make([]ranked, len(mergedGroups))
		for i, g := range mergedGroups {
			rankedGroups[i] = ranked{g, rank[i]}
		}
		sort.SliceStable(rankedGroups, func(i, j int) bool { return rankedGroups[i].r < rankedGroups[j].r })
		for i, rg := range rankedGroups {
			mergedGroups[i] = rg.g
		}
	}
	out := make([]SidebarGroup, 0, len(mergedGroups))
	for _, g := range mergedGroups {
		out = append(out, *g)
	}
	return out
}

// docTitle is a reference doc's title: frontmatter title, else first body heading,
// else a prettified filename.
func docTitle(root, relPath string) string {
	text, _ := fsx.ReadText(filepath.Join(root, relPath))
	fm := frontmatter.Parse(text)
	if fm.Data != nil {
		if t, ok := fm.Data["title"].(string); ok && strings.TrimSpace(t) != "" {
			return strings.TrimSpace(t)
		}
	}
	if m := firstBodyHeadingRe.FindStringSubmatch(fm.Body); m != nil {
		return strings.TrimSpace(m[1])
	}
	base := strings.TrimSuffix(path.Base(relPath), ".md")
	return strings.TrimSpace(dirSepRe.ReplaceAllString(base, " "))
}

var firstBodyHeadingRe = regexp.MustCompile(`(?m)^#\s+(.+)$`)

var allCapsStemRe = regexp.MustCompile(`^[A-Z0-9]+([-_][A-Z0-9]+)*$`)
var hasUpperRe = regexp.MustCompile(`[A-Z]`)
var mdExtRe = regexp.MustCompile(`(?i)\.md$`)

// filenameLabel is a filename-derived sidebar label: all-caps stems stay as-is
// (TODO, ICP), a root README reads "Home", a nested README reads "Overview",
// everything else prettifies to title case.
func filenameLabel(rootRel string) string {
	stem := mdExtRe.ReplaceAllString(path.Base(rootRel), "")
	if strings.ToLower(stem) == "readme" {
		if strings.Contains(rootRel, "/") {
			return "Overview"
		}
		return "Home"
	}
	if allCapsStemRe.MatchString(stem) && hasUpperRe.MatchString(stem) {
		return dirSepRe.ReplaceAllString(stem, " ")
	}
	return prettifyDirName(stem)
}

// sidebarLabel is the sidebar label for a document: the declared frontmatter
// `title` wins; otherwise the filename, cleaned up. Deliberately NOT the H1:
// hand-built sidebars use short curated labels, and filenames are the curated
// short name a repository already has. The H1 stays the document's title
// everywhere else (page, index).
func sidebarLabel(root, relPath, rootRel string) string {
	text, _ := fsx.ReadText(filepath.Join(root, relPath))
	fm := frontmatter.Parse(text)
	if fm.Data != nil {
		if t, ok := fm.Data["title"].(string); ok && strings.TrimSpace(t) != "" {
			return strings.TrimSpace(t)
		}
	}
	return filenameLabel(rootRel)
}

// OverviewRel is the overview homepage, named relative to the context root: the one
// content path the tool seeds, and the one whose read renders the layer map into it.
// Shared by generation, the local server's route, and the export's copy.
const OverviewRel = "overview.md"

// referenceTree is the browse zone: every markdown file under rootPath that is NOT
// governed (in the index) and NOT viewer/layer chrome (boot profile, agent
// profiles, category index files, overview.md, the generated _sidebar.md).
// Generated artifacts live in the root `.leji/`, which the walk skips as a dot-dir
// even when rootPath is ".". Returned as rootPath-relative nodes.
func referenceTree(root string, m *manifest.Manifest, governedPaths map[string]bool) []TreeNode {
	rootDirRel := fsx.StripSlash(m.RootPath)
	if rootDirRel == "" {
		rootDirRel = "."
	}
	profilesDir := manifest.EffectiveAgentProfilesPath(m)
	indexFiles := map[string]bool{}
	for _, cat := range manifest.CategoryIDs {
		if mapping, ok := m.Categories[cat]; ok {
			for _, f := range mapping.Indexes {
				indexFiles[f] = true
			}
		}
	}
	overviewRel := OverviewRel
	sidebarRel := "_sidebar.md"
	manifestPageRel := "_manifest.md"
	if rootDirRel != "." {
		overviewRel = rootDirRel + "/" + OverviewRel
		sidebarRel = rootDirRel + "/_sidebar.md"
		manifestPageRel = rootDirRel + "/_manifest.md"
	}
	var nodes []TreeNode
	for _, rel := range fsx.WalkTree(root, rootDirRel) {
		if governedPaths[rel] {
			continue
		}
		if rel == m.BootProfilePath {
			continue
		}
		if fsx.UnderPath(rel, profilesDir) {
			continue
		}
		if indexFiles[rel] {
			continue
		}
		if rel == overviewRel || rel == sidebarRel || rel == manifestPageRel {
			continue
		}
		r, ok := RelativeToRoot(rel, m.RootPath)
		if !ok {
			continue
		}
		nodes = append(nodes, TreeNode{Rel: r, Title: sidebarLabel(root, rel, r)})
	}
	return nodes
}

// The overview homepage is seeded once then user-owned. The markers are the author's
// placement mark for the layer map: the map is substituted between them at render
// time, by the viewer and by `leji export`, and the file itself is never rewritten.
const (
	mapStart = "<!-- leji:generated-map:start -->"
	mapEnd   = "<!-- leji:generated-map:end -->"
	// mapPlaceholder is the line the seed leaves between the markers, so a reader of
	// the source file knows why the span is empty. Whatever an author leaves there is
	// ignored at render, this line included.
	mapPlaceholder = "<!-- the layer map is rendered here by the viewer and by leji export -->"
)

// buildLayerMap renders a deterministic mermaid map of the layer: boot profile ->
// populated categories with document counts. Deliberately category-altitude:
// per-document nodes turn unreadable past a handful of docs, so the map never
// lists documents (the sidebar already does that legibly).
func buildLayerMap(m *manifest.Manifest, entries []indexgen.IndexEntry) string {
	lines := []string{"flowchart LR", "  boot[\"" + bootEmoji + " Boot profile\"]"}
	for _, category := range manifest.CategoryIDs {
		count := 0
		for _, e := range entries {
			if e.Category == category {
				count++
			}
		}
		if count == 0 {
			continue
		}
		emoji := categoryEmoji[category]
		if m.Viewer != nil {
			if e, ok := m.Viewer.CategoryEmojis[category]; ok {
				emoji = e
			}
		}
		catID := "cat_" + category
		docs := strconv.Itoa(count) + " docs"
		if count == 1 {
			docs = "1 doc"
		}
		lines = append(lines, "  "+catID+"[\""+emoji+" "+categoryLabels[category]+" · "+docs+"\"]")
		lines = append(lines, "  boot --> "+catID)
	}
	return strings.Join(lines, "\n")
}

// mapBlock wraps the layer map in the regen markers and a mermaid fence.
func mapBlock(m *manifest.Manifest, entries []indexgen.IndexEntry) string {
	return mapStart + "\n```mermaid\n" + buildLayerMap(m, entries) + "\n```\n" + mapEnd
}

// DecodeUTF8 is Node's `Buffer.toString('utf8')`, which is what the reference SDK hands
// RenderOverview: valid UTF-8 passes through untouched, and every invalid sequence
// becomes U+FFFD, one replacement per MAXIMAL SUBPART: the WHATWG substitution rule V8
// implements (`E2 82` at the end of the input is one replacement, `C0 80` is two).
//
// Go's own conversions answer differently: `string(b)` keeps the invalid bytes verbatim,
// and a utf8.DecodeRune loop emits one replacement per BYTE. Either would make a rendered
// overview carry different bytes from the reference's for the same source, so the decode
// is spelled out here rather than borrowed. Only the RENDERED path decodes: a page whose
// markers are missing is served and exported as its raw bytes in all three SDKs.
func DecodeUTF8(b []byte) string {
	// Already valid: the bytes are their own decoding, and the common case pays one scan.
	if utf8.Valid(b) {
		return string(b)
	}
	var out strings.Builder
	out.Grow(len(b))
	var (
		codepoint   rune
		bytesNeeded int
		bytesSeen   int
		lower       byte = 0x80
		upper       byte = 0xBF
	)
	for i := 0; i < len(b); i++ {
		c := b[i]
		if bytesNeeded == 0 {
			switch {
			case c <= 0x7F:
				out.WriteByte(c)
			case c >= 0xC2 && c <= 0xDF:
				bytesNeeded, codepoint = 1, rune(c&0x1F)
			case c >= 0xE0 && c <= 0xEF:
				if c == 0xE0 {
					lower = 0xA0 // no overlong three-byte form
				}
				if c == 0xED {
					upper = 0x9F // no surrogate
				}
				bytesNeeded, codepoint = 2, rune(c&0x0F)
			case c >= 0xF0 && c <= 0xF4:
				if c == 0xF0 {
					lower = 0x90 // no overlong four-byte form
				}
				if c == 0xF4 {
					upper = 0x8F // nothing past U+10FFFF
				}
				bytesNeeded, codepoint = 3, rune(c&0x07)
			default:
				out.WriteRune(utf8.RuneError)
			}
			continue
		}
		if c < lower || c > upper {
			// The maximal subpart ends before this byte: one replacement for what was
			// consumed, and the byte is reprocessed from a clean state rather than
			// swallowed, which is why `C2 41` decodes to U+FFFD followed by "A".
			codepoint, bytesNeeded, bytesSeen = 0, 0, 0
			lower, upper = 0x80, 0xBF
			out.WriteRune(utf8.RuneError)
			i--
			continue
		}
		lower, upper = 0x80, 0xBF
		codepoint = codepoint<<6 | rune(c&0x3F)
		bytesSeen++
		if bytesSeen == bytesNeeded {
			out.WriteRune(codepoint)
			codepoint, bytesNeeded, bytesSeen = 0, 0, 0
		}
	}
	if bytesNeeded != 0 {
		out.WriteRune(utf8.RuneError) // a sequence the end of the input cut short
	}
	return out.String()
}

// RenderOverview is the overview homepage as it is READ, never as it is stored: the
// source bytes with the marked span replaced by the map this index projects. The one
// function behind both consumers (the local server renders it per fetch, the export
// renders the copy it writes), so the served and the exported page carry the same
// bytes.
//
// Whatever stands between the markers in source is ignored: the map is derived from
// the index, so the file is never rewritten to hold it. Without the marker pair there
// is nowhere to put the map, and the source is returned unchanged (markersFound
// false) for the caller to warn about.
func RenderOverview(source string, m *manifest.Manifest, entries []indexgen.IndexEntry) (text string, markersFound bool) {
	start := strings.Index(source, mapStart)
	end := strings.Index(source, mapEnd)
	if start < 0 || end <= start {
		return source, false
	}
	return source[:start] + mapBlock(m, entries) + source[end+len(mapEnd):], true
}

// buildOverviewSeed is the starter home page: a short owner-editable explainer plus
// the empty marker pair the layer map is rendered into. Written once, when no
// overview.md stands at the content root, and never rewritten after that.
func buildOverviewSeed(m *manifest.Manifest) string {
	return "# " + m.Name + `

This is the **Leji context layer** for ` + "`" + m.Name + "`" + `: the shared, validated context
people and coding agents read before working in this repository. Start with the boot
profile, then browse the categories in the sidebar.

This page is yours to edit. The map below is rendered between the markers by the viewer
and by ` + "`leji export`" + `; this file is never rewritten.

` + mapStart + `
` + mapPlaceholder + `
` + mapEnd + `

- Write a ` + "```mermaid" + ` code block in any document and it renders as a diagram here.
- Run ` + "`leji conformance`" + ` to see the level this layer claims and verifies.
`
}

// manifestCtrlRe matches runs of C0/C1/DEL control characters; manifestWsRe matches
// runs of ASCII whitespace. Both mirror the Node SDK's esc/codeSpan/mermaidLabel
// normalization so the three SDKs emit identical bytes.
var (
	manifestCtrlRe  = regexp.MustCompile(`[\x{0000}-\x{001F}\x{007F}-\x{009F}]+`)
	manifestWsRe    = regexp.MustCompile("[ \t\n\r\f\x0b]+")
	manifestPipeRe  = regexp.MustCompile(`\|`)
	manifestMermRe  = regexp.MustCompile("[\\[\\]{}()<>|`]")
	manifestSpaceRe = regexp.MustCompile(` +`)
	shortPinRe      = regexp.MustCompile(`^[0-9a-fA-F]{7,}$`)
)

// jsIsSpace reports whether r is stripped by JS String.prototype.trim (WhiteSpace +
// LineTerminator). Matched exactly so the trimming stays byte-identical with Node.
func jsIsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// jsTrim mirrors JS .trim().
func jsTrim(s string) string { return strings.TrimFunc(s, jsIsSpace) }

// manifestNormalize collapses control chars and whitespace to single spaces, then
// trims — the shared prefix of esc, codeSpan, and mermaidLabel.
func manifestNormalize(s string) string {
	s = manifestCtrlRe.ReplaceAllString(s, " ")
	s = manifestWsRe.ReplaceAllString(s, " ")
	return jsTrim(s)
}

// esc normalizes a value to one safe markdown-inline token: strip control chars,
// collapse whitespace, trim, then neutralize the characters that could break
// markdown structure or inject HTML (backslash, backtick, pipe, angle brackets),
// in that order. Mirrors the Node SDK's esc.
func esc(s string) string {
	s = manifestNormalize(s)
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, "`", "\\`")
	s = strings.ReplaceAll(s, "|", `\|`)
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	return s
}

// codeSpan renders a value as a code span when safe (no backtick after control
// normalization), escaping the pipe so it survives a table cell; otherwise it falls
// back to plain escaped text so a stray backtick can never corrupt the row.
func codeSpan(s string) string {
	norm := manifestNormalize(s)
	if strings.Contains(norm, "`") {
		return esc(s)
	}
	return "`" + manifestPipeRe.ReplaceAllString(norm, `\|`) + "`"
}

// shortPin shows a hex commit pin short; any other locator verbatim.
func shortPin(pin string) string {
	if shortPinRe.MatchString(pin) {
		return pin[:12]
	}
	return pin
}

// pinDriftLabel is a human-readable pin drift, from git-derived counts only (never a
// wall-clock value) so the page stays byte-deterministic across the three SDKs.
func pinDriftLabel(r mounts.PinReport) string {
	numOr := func(p *int) string {
		if p == nil {
			return "?"
		}
		return strconv.Itoa(*p)
	}
	switch r.State {
	case "up-to-date":
		return "up-to-date"
	case "ahead":
		return "ahead " + numOr(r.Ahead)
	case "behind":
		return "behind " + numOr(r.Behind)
	case "diverged":
		return "diverged (ahead " + numOr(r.Ahead) + ", behind " + numOr(r.Behind) + ")"
	case "unrelated":
		return "unrelated"
	default:
		return "unknown"
	}
}

// mermaidLabel escapes a string for a quoted mermaid node label `["..."]`: collapse
// control/whitespace, map `"` to the mermaid entity, and replace the structural
// characters that break mermaid parsing. Empty maps to `?`.
func mermaidLabel(s string) string {
	t := manifestNormalize(s)
	t = strings.ReplaceAll(t, `"`, "#quot;")
	t = manifestMermRe.ReplaceAllString(t, " ")
	t = manifestSpaceRe.ReplaceAllString(t, " ")
	t = jsTrim(t)
	if t == "" {
		return "?"
	}
	return t
}

// buildManifestPage renders the generated "Manifest" page: a human-friendly view of
// leji.json plus the local federation diagnostics (hydration + pin drift). Written as
// generated chrome to the gitignored .leji/viewer/, regenerated every run, never
// committed. Declaration-driven (the manifest is truth; mount status is joined by
// name). Deterministic by construction — declared values plus git-derived (never
// wall-clock, never networked) state — so the three SDKs emit identical bytes.
func buildManifestPage(m *manifest.Manifest, statuses []mounts.StatusResult) string {
	title := m.Name
	if m.Viewer != nil && m.Viewer.Title != "" {
		title = m.Viewer.Title
	}
	lines := []string{
		"# " + esc(title) + ": Manifest",
		"",
		"A human-readable view of this layer's `leji.json`.",
		"",
		"> **Declared** values come straight from the manifest. **Observed** values (mount availability and drift) are read from local projections and Git objects; no network fetch is performed.",
		"",
		"## Identity",
		"",
		"| Field | Declared |",
		"| --- | --- |",
		"| Name | " + codeSpan(m.Name) + " |",
	}
	if m.Description != "" {
		lines = append(lines, "| Description | "+esc(m.Description)+" |")
	}
	lines = append(lines, "| Spec line | "+codeSpan(m.Leji)+" |")
	owner := m.Owners.Primary
	ownerLine := "| Owner | " + esc(owner.Name)
	if owner.Contact != "" {
		ownerLine += " (" + codeSpan(owner.Contact) + ")"
	}
	ownerLine += " |"
	lines = append(lines, ownerLine)
	claimed := ""
	if m.Conformance != nil {
		claimed = m.Conformance.ClaimedLevel
	}
	if claimed != "" {
		lines = append(lines, "| Conformance | claims `"+esc(claimed)+"` (run `leji conformance` to verify) |")
	} else {
		lines = append(lines, "| Conformance | no level claimed |")
	}

	lines = append(lines, "", "## Entrypoints", "", "| Purpose | Path |", "| --- | --- |")
	lines = append(lines, "| Boot profile | "+codeSpan(m.BootProfilePath)+" |")
	lines = append(lines, "| Context root | "+codeSpan(m.RootPath)+" |")
	if m.Machine != nil {
		if m.Machine.IndexPath != "" {
			lines = append(lines, "| Context index | "+codeSpan(m.Machine.IndexPath)+" |")
		}
		if m.Machine.ChangelogPath != "" {
			lines = append(lines, "| Changelog | "+codeSpan(m.Machine.ChangelogPath)+" |")
		}
		if m.Machine.AgentProfilesPath != "" {
			lines = append(lines, "| Agent profiles | "+codeSpan(m.Machine.AgentProfilesPath)+" |")
		}
		if m.Machine.DecisionRecordsPath != "" {
			lines = append(lines, "| Decision records | "+codeSpan(m.Machine.DecisionRecordsPath)+" |")
		}
	}

	// Categories: a count summary of the declared index files. The documents
	// themselves are enumerated by the sidebar (grouped by category), so listing
	// their paths here would only duplicate that; the fact worth surfacing is shape.
	var populated []string
	for _, c := range manifest.CategoryIDs {
		if mapping, ok := m.Categories[c]; ok && len(mapping.Indexes) > 0 {
			populated = append(populated, c)
		}
	}
	if len(populated) > 0 {
		parts := make([]string, 0, len(populated))
		for _, c := range populated {
			parts = append(parts, categoryLabels[c]+" "+strconv.Itoa(len(m.Categories[c].Indexes)))
		}
		summary := strings.Join(parts, " · ")
		lines = append(lines, "", "## Categories", "", "**Declared index files:** "+summary+". The documents themselves are in the sidebar, grouped by category.")
	}

	roles := make([]string, 0, len(m.Agents))
	for role := range m.Agents {
		roles = append(roles, role)
	}
	sort.Slice(roles, func(i, j int) bool { return roles[i] < roles[j] })
	if len(roles) > 0 {
		lines = append(lines, "", "## Agents", "", "| Role | Profile |", "| --- | --- |")
		for _, role := range roles {
			lines = append(lines, "| "+codeSpan(role)+" | "+codeSpan(m.Agents[role])+" |")
		}
	}

	// Actors, when declared: this page renders the manifest, so a declared top-level
	// key that it silently omitted would make the page wrong for the layers using it.
	// One row per (actor, role), because the command is keyed by the pair.
	actorIDs := make([]string, 0, len(m.Actors))
	for id := range m.Actors {
		actorIDs = append(actorIDs, id)
	}
	sort.Slice(actorIDs, func(i, j int) bool { return actorIDs[i] < actorIDs[j] })
	if len(actorIDs) > 0 {
		lines = append(lines, "", "## Actors", "", "| Actor | Role | Command |", "| --- | --- | --- |")
		for _, id := range actorIDs {
			actor := m.Actors[id]
			roleList := append([]string{}, actor.Roles...)
			sort.Slice(roleList, func(i, j int) bool { return roleList[i] < roleList[j] })
			for _, role := range roleList {
				command := "—"
				if c, ok := actor.Commands[role]; ok {
					command = codeSpan(c)
				}
				lines = append(lines, "| "+codeSpan(id)+" | "+codeSpan(role)+" | "+command+" |")
			}
		}
	}

	// Federation gets the visual weight: it is the operational view unique to this
	// page. Graph first (composition at a glance), then an observed-state summary,
	// then the evidence table. Declaration-driven and byte-sorted by name; a mount
	// with no matching status is `unknown`, an absent optional field an em dash.
	var mountList []manifest.Mount
	if m.Federation != nil {
		mountList = append(mountList, m.Federation.Mounts...)
	}
	sort.SliceStable(mountList, func(i, j int) bool { return mountList[i].Name < mountList[j].Name })
	lines = append(lines, "", "## Federation", "")
	if len(mountList) == 0 {
		lines = append(lines, "No federated mounts are declared for this layer.")
	} else {
		statusByName := make(map[string]mounts.StatusResult, len(statuses))
		for _, s := range statuses {
			statusByName[s.Name] = s
		}
		mermaidEnabled := m.Viewer == nil || m.Viewer.Mermaid == nil || *m.Viewer.Mermaid
		if mermaidEnabled {
			graph := []string{"```mermaid", "flowchart LR", `   host["` + mermaidLabel(title) + `"]`}
			for i, d := range mountList {
				graph = append(graph, "   m"+strconv.Itoa(i)+`["`+mermaidLabel(d.Name)+`"]`)
				graph = append(graph, "   host --> m"+strconv.Itoa(i))
			}
			graph = append(graph, "```", "")
			lines = append(lines, graph...)
		}
		hydrated := 0
		drifting := 0
		for _, d := range mountList {
			s, ok := statusByName[d.Name]
			if ok && s.Present {
				hydrated++
			}
			// Drift = any known non-current relationship to the pin (ahead/behind/
			// diverged/unrelated); only `unknown` (uncomputable locally) is left out.
			if ok {
				st := s.PinReport.State
				if st == "ahead" || st == "behind" || st == "diverged" || st == "unrelated" {
					drifting++
				}
			}
		}
		summary := "**Observed:** " + strconv.Itoa(hydrated) + "/" + strconv.Itoa(len(mountList)) + " mounts hydrated locally · " + strconv.Itoa(drifting) + " drifting from pin."
		lines = append(lines, summary, "")
		// The table stays operational (status + provenance); the descriptive Role is a
		// sentence per mount, so it reads as a list below rather than widening a cell.
		lines = append(lines, "| Mount | Availability | Drift | Owner | Pin | Source |")
		lines = append(lines, "| --- | --- | --- | --- | --- | --- |")
		for _, d := range mountList {
			s, ok := statusByName[d.Name]
			availability := "unknown"
			drift := "unknown"
			if ok {
				if s.Present {
					availability = "hydrated"
				} else {
					availability = "not hydrated"
				}
				drift = pinDriftLabel(s.PinReport)
			}
			ownerCell := "—"
			if d.Owner.Name != "" {
				ownerCell = esc(d.Owner.Name)
			}
			sourceCell := "—"
			if d.Source != "" {
				sourceCell = codeSpan(d.Source)
			}
			pinCell := "—"
			if d.Pin != "" {
				pinCell = codeSpan(shortPin(d.Pin))
				if d.TrackingRef != "" {
					pinCell += " @ " + codeSpan(d.TrackingRef)
				}
			}
			lines = append(lines, "| "+esc(d.Name)+" | "+availability+" | "+drift+" | "+ownerCell+" | "+pinCell+" | "+sourceCell+" |")
		}
		lines = append(lines, "", "> `not hydrated` / `unknown` are normal degraded reads; ordinary validation never fails just because a mount is unavailable (opt-in federation enforcement is separate). Run `leji mounts hydrate`, then regenerate the viewer to refresh.")
		var roled []manifest.Mount
		for _, d := range mountList {
			if d.Role != "" {
				roled = append(roled, d)
			}
		}
		if len(roled) > 0 {
			lines = append(lines, "", "**Roles**", "")
			for _, d := range roled {
				lines = append(lines, "- **"+esc(d.Name)+"**: "+esc(d.Role))
			}
		}
	}
	lines = append(lines, "")
	return strings.Join(lines, "\n")
}

// profileValue renders one frontmatter scalar as a markdown-safe inline value.
// Node's String() and JSON.stringify agree on every non-string scalar YAML core
// resolution can produce, so one encoder covers both branches of the TS reference.
func profileValue(value any) string {
	if s, ok := value.(string); ok {
		return codeSpan(s)
	}
	if value == nil {
		return "—"
	}
	encoded, err := jsonenc.Marshal(value)
	if err != nil {
		return "—"
	}
	return codeSpan(string(encoded))
}

// UnresolvedProfilePage is the page for an agent profile that declares `inherits`
// and does not resolve: there is no effective profile to show, and presenting the
// derived file as if there were would be the error the finding names.
func UnresolvedProfilePage(relPath string, fnds []findings.Finding) string {
	lines := []string{
		"# " + esc(relPath) + ": unresolved profile",
		"",
		"> **This profile does not resolve.** " + codeSpan(relPath) + " declares `inherits`, and the inheritance cannot be resolved, so the layer has no effective profile for this role. The file on disk is only its own half and is not shown here: a consumer that cannot resolve an inherited profile must not apply the derived file alone.",
		"",
		"| Rule | Where | Problem |",
		"| --- | --- | --- |",
	}
	for _, f := range fnds {
		where := "—"
		if f.HasPath {
			where = codeSpan(f.Path)
		}
		lines = append(lines, "| "+codeSpan(f.Rule)+" | "+where+" | "+esc(f.Message)+" |")
	}
	if len(fnds) == 0 {
		lines = append(lines, "| — | "+codeSpan(relPath)+" | the profile could not be resolved |")
	}
	lines = append(lines, "")
	return strings.Join(lines, "\n")
}

// renderResolvedProfile is the page for an agent profile that declares
// `inherits`: the effective profile after resolution, never the authored file,
// which is only its own half. Sources are named, each posture entry is labelled
// with the profile that supplied it, and the composite body keeps the resolver's
// source markers.
func renderResolvedProfile(profiles []layer.ScannedProfile, derived layer.ScannedProfile) string {
	fm := derived.Frontmatter
	derivedID := derived.RelPath
	if id, ok := fm["id"].(string); ok {
		derivedID = id
	}
	resolved := layer.ResolveAgentProfile(derived, profiles)
	if resolved.Frontmatter == nil || resolved.Body == nil {
		return UnresolvedProfilePage(derived.RelPath, resolved.Findings)
	}

	baseID := ""
	if len(resolved.SourceIDs) > 0 {
		baseID = resolved.SourceIDs[0]
	}
	baseRel := baseID
	baseFm := map[string]any{}
	for _, p := range profiles {
		if id, ok := p.Frontmatter["id"].(string); ok && id == baseID {
			baseRel = p.RelPath
			baseFm = p.Frontmatter
			break
		}
	}
	effective := resolved.Frontmatter
	title := derivedID
	if name, ok := effective["name"].(string); ok {
		title = name
	}
	lines := []string{
		"# " + esc(title) + ": resolved profile",
		"",
		"> **Resolved profile.** " + codeSpan(derived.RelPath) + " declares `inherits: " + esc(baseID) + "`, so this page is the effective profile: posture from " + codeSpan(baseRel) + " first, then this profile's own, with exact duplicates dropped. Every other field is this profile's own; both bodies are operative, base first. The file on disk carries only its own half.",
		"",
		"**Sources**, base first: " + codeSpan(baseRel) + " (`" + esc(baseID) + "`), then " + codeSpan(derived.RelPath) + " (`" + esc(derivedID) + "`).",
		"",
		"## Effective frontmatter",
		"",
	}
	for _, key := range resolved.Keys {
		value := effective[key]
		entries, isArray := value.([]any)
		if !isArray {
			lines = append(lines, "- **"+esc(key)+"**: "+profileValue(value))
			continue
		}
		// Composed posture: label every entry with the profile that supplied it.
		fromBase := map[string]bool{}
		if baseEntries, ok := baseFm[key].([]any); ok {
			for _, v := range baseEntries {
				fromBase[stringifyEntry(v)] = true
			}
		}
		lines = append(lines, "- **"+esc(key)+"**")
		if len(entries) == 0 {
			lines = append(lines, "   - (empty)")
		}
		for _, entry := range entries {
			source := derivedID
			if fromBase[stringifyEntry(entry)] {
				source = baseID
			}
			lines = append(lines, "   - "+profileValue(entry)+" (from `"+esc(source)+"`)")
		}
	}
	lines = append(lines, "", "## Effective body", "")
	// The resolver's markers stay in the page (they are what a consumer reads);
	// each gets a visible line beside it so the rendered view names its source too.
	baseMarker := "<!-- inherited from: " + baseID + " -->"
	derivedMarker := "<!-- " + derivedID + " -->"
	labelled := strings.Replace(*resolved.Body, baseMarker,
		baseMarker+"\n\n*Inherited from "+codeSpan(baseRel)+".*", 1)
	labelled = strings.Replace(labelled, derivedMarker,
		derivedMarker+"\n\n*From "+codeSpan(derived.RelPath)+".*", 1)
	lines = append(lines, labelled)
	return strings.Join(lines, "\n")
}

// stringifyEntry keys a posture entry by its JSON encoding, matching the TS
// reference's JSON.stringify identity for the from-base labelling.
func stringifyEntry(v any) string {
	encoded, err := jsonenc.Marshal(v)
	if err != nil {
		return ""
	}
	return string(encoded)
}

// DeclaresInherits reports whether the file at repoRel declares `inherits`, so it
// is one half of a profile and must never reach a reader as the effective one.
// Manifest-free and total, so the serve path can still classify when nothing else
// is readable.
func DeclaresInherits(root, repoRel string) bool {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	abs := filepath.Join(root, repoRel)
	if !fsx.IsFile(abs) || !fsx.ResolvedWithinRoot(rootAbs, abs) {
		return false
	}
	text, err := fsx.ReadText(abs)
	if err != nil {
		return false
	}
	_, ok := frontmatter.Parse(text).Data["inherits"].(string)
	return ok
}

// servableSource reports whether the layer file at repoRel may be read into
// something served or exported: judged by the servable-roots whitelist as requested
// AND after symlink resolution, the same pair of checks serveFrom makes on a
// response. A path that resolves into a private `.leji/` role fails, however it was
// spelled.
func servableSource(root, repoRel string) bool {
	abs, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	rootAbs, ok := fsx.ResolvedPath(abs)
	if !ok {
		return false
	}
	target := filepath.Join(rootAbs, filepath.FromSlash(repoRel))
	if !layout.ServablePath(rootAbs, target) {
		return false
	}
	real, ok := fsx.ResolvedPathUnder(rootAbs, target)
	return ok && layout.ServablePath(rootAbs, real)
}

// servableProfileText is a profile source read the way check-before-act requires: the requested
// path is judged, its RESOLVED path is judged, and the bytes come from the descriptor
// opened on that resolved path and proved a regular file — so nothing swapped between
// the check and the read (a file, or any directory above it, becoming a symlink)
// changes what is composed into a served or exported page. ok is false for anything
// refused.
func servableProfileText(rootAbs, repoRel string) (string, bool) {
	abs := filepath.Join(rootAbs, filepath.FromSlash(repoRel))
	if !layout.ServablePath(rootAbs, abs) {
		return "", false
	}
	src, err := fsx.OpenVerifiedSource(abs, func(real string) bool {
		return layout.ServablePath(rootAbs, real) &&
			(real == rootAbs || strings.HasPrefix(real, rootAbs+string(filepath.Separator)))
	})
	if err != nil || src.File == nil {
		return "", false
	}
	defer func() { _ = src.File.Close() }()
	body, rerr := io.ReadAll(src.File)
	if rerr != nil {
		return "", false
	}
	return string(body), true
}

// servableProfileSet is the profile set as the viewer may render it: every source
// read through servableProfileText, so no profile living in — or symlinked into — a
// private `.leji/` role is composed into a served page or an exported one, and the
// bytes composed are the bytes that passed the check. Dropped silently, exactly as
// the content walk drops unservable content; the scan itself stays total, so
// validation still reports on those files.
func servableProfileSet(root string, m *manifest.Manifest) []layer.ScannedProfile {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil
	}
	rootAbs, ok := fsx.ResolvedPath(abs)
	if !ok {
		return nil
	}
	return layer.ScanProfileSetWith(root, m, func(relPath string) (string, bool) {
		return servableProfileText(rootAbs, relPath)
	})
}

// ResolvedProfilePage is the page for repoRel when it is an agent profile that
// declares `inherits`, else ok=false (every other document is served from disk as
// authored).
//
// Fails closed. Once the file is known to be an inheriting profile, this function
// owns the response: any failure below that point returns a findings page, never
// ok=false, because falling through hands the caller back to the raw derived file,
// and serving half a profile as if it were the whole one is the exact outcome the
// spec forbids.
func ResolvedProfilePage(root string, m *manifest.Manifest, repoRel string) (string, bool) {
	// Cheap rejects before the profile scan: the viewer calls this per markdown
	// fetch. Path first (an ordinary document is never a profile), then the file's
	// own frontmatter (a profile that inherits nothing is served as-is).
	bound := false
	for _, rel := range m.Agents {
		if rel == repoRel {
			bound = true
			break
		}
	}
	if !bound && !fsx.UnderPath(repoRel, manifest.EffectiveAgentProfilesPath(m)) {
		return "", false
	}
	// The whitelist, judged before this file is read into a page: a profile that
	// resolves into a private `.leji/` role is not the viewer's to render. Falling
	// through hands the request back to the content walk, which refuses it the same
	// way it refuses any unservable file — this branch never becomes the way in.
	if !servableSource(root, repoRel) {
		return "", false
	}
	if !DeclaresInherits(root, repoRel) {
		return "", false
	}
	profiles := servableProfileSet(root, m)
	for _, p := range profiles {
		if p.RelPath == repoRel {
			return renderResolvedProfile(profiles, p), true
		}
	}
	return UnresolvedProfilePage(repoRel, []findings.Finding{
		findings.New("artifact-parse", findings.Error, "the profile scan did not reach this file", repoRel),
	}), true
}

// ResolvedPage is one inheriting profile's rootPath-relative viewer path and
// resolved page.
type ResolvedPage struct {
	Rel  string
	Page string
}

// ResolvedProfilePages is every inheriting profile as its rootPath-relative viewer
// path and resolved page, so a static export carries what the local server renders.
func ResolvedProfilePages(root string, m *manifest.Manifest) []ResolvedPage {
	profiles := servableProfileSet(root, m)
	var out []ResolvedPage
	for _, p := range profiles {
		if _, ok := p.Frontmatter["inherits"].(string); !ok {
			continue
		}
		rel, ok := RelativeToRoot(p.RelPath, m.RootPath)
		if !ok {
			continue // outside the context root: not servable
		}
		out = append(out, ResolvedPage{Rel: rel, Page: renderResolvedProfile(profiles, p)})
	}
	return out
}

// scriptSafeJSON makes a JSON blob safe inside an HTML <script> by neutralizing a
// closing tag and the JS line terminators U+2028/U+2029. Input is jsonenc.Marshal
// output (no HTML escaping), matching the Node SDK's jsonForScript.
func scriptSafeJSON(b []byte) string {
	s := string(b)
	s = strings.ReplaceAll(s, "<", "\\u003c")
	s = strings.ReplaceAll(s, ">", "\\u003e")
	s = strings.ReplaceAll(s, "&", "\\u0026")
	s = strings.ReplaceAll(s, " ", "\\u2028")
	s = strings.ReplaceAll(s, " ", "\\u2029")
	return s
}

// docsifyConfigJSON serializes the Docsify config blob in the Node SDK's exact
// key order (JSON.stringify of the object literal), then script-escapes it.
// Appends the homepage viewer-path-missing warning to fnds when the configured
// homepage does not resolve.
func docsifyConfigJSON(root string, m *manifest.Manifest, nameHTML, base string, fnds *[]findings.Finding) (string, error) {
	var b bytes.Buffer
	writeStr := func(s string) error {
		enc, err := jsonenc.Marshal(s)
		if err != nil {
			return err
		}
		b.Write(enc)
		return nil
	}
	writeNullable := func(v string, ok bool) error {
		if ok {
			return writeStr(v)
		}
		b.WriteString("null")
		return nil
	}
	b.WriteString(`{"name":`)
	if err := writeStr(nameHTML); err != nil {
		return "", err
	}
	// Where the layer's markdown is mounted. Docsify's own key, so the boot script
	// configures the router from it rather than hardcoding a root: '/content/'
	// served, 'content/' exported (resolved against the page, so the tree hosts
	// under any subpath).
	b.WriteString(`,"basePath":`)
	if err := writeStr(base + "content/"); err != nil {
		return "", err
	}
	// Hash navigation for the logo/title link: #/ re-routes to the homepage
	// inside the SPA instead of a full page reload.
	b.WriteString(`,"nameLink":"#/"`)
	// Per-page classification badge (top-right chip): the boot script resolves
	// the current route against the served index using these.
	idxRel, idxOK := RelativeToRoot(manifest.EffectiveIndexPath(m), m.RootPath)
	b.WriteString(`,"lejiIndexRel":`)
	if err := writeNullable(idxRel, idxOK); err != nil {
		return "", err
	}
	bootRel, bootOK := RelativeToRoot(m.BootProfilePath, m.RootPath)
	b.WriteString(`,"lejiBootPath":`)
	if err := writeNullable(bootRel, bootOK); err != nil {
		return "", err
	}
	agentsRel, agentsOK := RelativeToRoot(manifest.EffectiveAgentProfilesPath(m), m.RootPath)
	b.WriteString(`,"lejiAgentsPrefix":`)
	if err := writeNullable(agentsRel, agentsOK); err != nil {
		return "", err
	}
	agentsLabel := defaultAgentsLabel
	if m.Viewer != nil && m.Viewer.AgentsLabel != "" {
		agentsLabel = m.Viewer.AgentsLabel
	}
	b.WriteString(`,"lejiAgentsLabel":`)
	if err := writeStr(agentsLabel); err != nil {
		return "", err
	}
	b.WriteString(`,"lejiCategories":{`)
	for i, c := range manifest.CategoryIDs {
		if i > 0 {
			b.WriteString(",")
		}
		if err := writeStr(c); err != nil {
			return "", err
		}
		b.WriteString(":")
		emoji := categoryEmoji[c]
		if m.Viewer != nil {
			if e, ok := m.Viewer.CategoryEmojis[c]; ok {
				emoji = e
			}
		}
		if err := writeStr(emoji + " " + categoryLabels[c]); err != nil {
			return "", err
		}
	}
	b.WriteString("}")
	// The homepage is rootPath-relative; teams whose layer has a real landing
	// page point at it instead of the seeded overview.
	b.WriteString(`,"homepage":`)
	if err := writeStr(effectiveHomepage(root, m, fnds)); err != nil {
		return "", err
	}
	// After the homepage above, so the two warnings land in the Node SDK's order.
	theme := resolveThemeColor(m, fnds)
	b.WriteString(`,"themeColor":`)
	if err := writeStr(theme); err != nil {
		return "", err
	}
	// Mermaid node text, readable against the accent. Computed here because this
	// side resolves every accepted color form; the boot script's own hex-only
	// fallback covers viewer trees generated before this field. Leji's own key,
	// not one Docsify reads, hence the prefix.
	b.WriteString(`,"lejiMermaidTextColor":`)
	if err := writeStr(mermaidTextColor(theme)); err != nil {
		return "", err
	}
	// Read by the boot script's powered-by plugin; false removes the mark.
	powered := !(m.Viewer != nil && m.Viewer.PoweredBy != nil && !*m.Viewer.PoweredBy)
	b.WriteString(`,"lejiPoweredBy":`)
	b.WriteString(strconv.FormatBool(powered))
	b.WriteString("}")
	return scriptSafeJSON(b.Bytes()), nil
}

// AssembleSidebar assembles the current sidebar for a layer entirely in memory:
// pins (with boot-pin replacement), pin-filtered groups, and the
// homepage-excluded reference tree. Used by generation and by the serve path,
// which rebuilds it per fetch so a long-running viewer never shows a deleted or
// moved document.
func AssembleSidebar(root string, m *manifest.Manifest, entries []indexgen.IndexEntry, fnds *[]findings.Finding) string {
	governedPaths := map[string]bool{}
	for _, e := range entries {
		governedPaths[e.Path] = true
	}

	// Pinned pages: resolved to servable rels. A pin is a path string (label
	// derived) or `{ path, label }` (a curated label, emoji welcome). Missing or
	// out-of-root pins are surfaced, never silently dropped. Pinning the boot
	// profile replaces its default line, so its label is the team's to curate.
	var pins []SidebarEntry
	pinnedRootRel := map[string]bool{}
	bootPinned := false
	if m.Viewer != nil {
		for _, pin := range m.Viewer.Pins {
			pinPath := pin.Path
			// Pins are repo-relative canonically; a rootPath-relative pin under the
			// context root is accepted too (same tolerance as homepage/logo/favicon).
			// repoRel tracks where the file actually lives for reads and comparisons.
			rel, ok := RelativeToRoot(pinPath, m.RootPath)
			repoRel := pinPath
			if !ok || !fsx.IsFile(filepath.Join(root, pinPath)) {
				base := fsx.StripSlash(m.RootPath)
				alt := strings.TrimPrefix(fsx.StripSlash(pinPath), "./")
				altRepo := alt
				if base != "" && base != "." {
					altRepo = base + "/" + alt
				}
				if fsx.IsFile(filepath.Join(root, altRepo)) {
					rel = alt
					ok = true
					repoRel = altRepo
				} else {
					ok = false
				}
			}
			if !ok {
				*fnds = append(*fnds, findings.New("viewer-pin-missing", findings.Warning,
					`viewer.pins entry "`+pinPath+`" does not resolve to a markdown file under rootPath`, pinPath))
				continue
			}
			if repoRel == m.BootProfilePath {
				bootPinned = true
			}
			pinnedRootRel[rel] = true
			title := pin.Label
			if title == "" {
				title = sidebarLabel(root, repoRel, rel)
			}
			pins = append(pins, SidebarEntry{Rel: rel, Title: title})
		}
	}

	// The generated Manifest page is always pinned as system chrome, ahead of the
	// user's own pins. Served via a dedicated route from the viewer dir under a
	// reserved underscore name (see newHandler / BuildViewer), so its rel is the
	// literal "_manifest.md" and it needs no on-disk existence check under the root.
	if !pinnedRootRel["_manifest.md"] {
		pins = append([]SidebarEntry{{Rel: "_manifest.md", Title: "📄 Manifest"}}, pins...)
		pinnedRootRel["_manifest.md"] = true
	}

	// A pin replaces the doc's default sidebar position: pinned docs render in
	// the top zone only, dropped from their group listing like the tree below.
	groups := BuildSidebarGroups(root, m, entries)
	for i := range groups {
		var kept []SidebarEntry
		for _, e := range groups[i].Entries {
			if !pinnedRootRel[e.Rel] {
				kept = append(kept, e)
			}
		}
		groups[i].Entries = kept
	}
	// The homepage already has a fixed entry point (the sidebar title links to it),
	// so like a pin it never re-lists in the reference tree.
	var discard []findings.Finding
	homepageRel := effectiveHomepage(root, m, &discard)
	var tree []TreeNode
	for _, n := range referenceTree(root, m, governedPaths) {
		if !pinnedRootRel[n.Rel] && n.Rel != homepageRel {
			tree = append(tree, n)
		}
	}
	return BuildSidebar(m, groups, tree, pins, bootPinned)
}

// BuildIndexHTML is the SPA shell for one flavor of the chrome: the template with
// this layer's config baked in, every URL it emits written against base. The served
// flavor ("/") and the export flavor ("") come from this one function, so the export
// never gets its HTML rewritten after the fact. fnds collects the two resolution
// warnings (homepage, accent) in their established order; the export invocation
// discards them, having already reported the generation run's.
func BuildIndexHTML(root string, m *manifest.Manifest, base string, fnds *[]findings.Finding) (string, error) {
	htmlBytes, err := assets.FS.ReadFile("templates/viewer/index.html")
	if err != nil {
		return "", err
	}
	// Display title: viewer.title override, else the context layer name.
	displayTitle := m.Name
	if m.Viewer != nil && m.Viewer.Title != "" {
		displayTitle = m.Viewer.Title
	}
	// The sidebar header. A configured brand logo renders as a centered block (the
	// wordmark IS the title, the way hand-built dashboards do it); the default Leji
	// mark renders small and inline beside the title text. Raw <img> HTML inside
	// `name` rather than Docsify's `logo` option (which prepends basePath /content/
	// and 404s). Title is HTML-escaped; the strict CSP (script-src 'self') kills handlers.
	var logo, favicon string
	if m.Viewer != nil {
		logo = m.Viewer.Logo
		favicon = m.Viewer.Favicon
	}
	logoURL := htmlEscape(resolveLogo(root, m.RootPath, logo, base))
	var nameHTML string
	if logo != "" {
		nameHTML = `<img src="` + logoURL + `" alt="` + htmlEscape(displayTitle) + `" style="max-width:180px;margin:10px auto;display:block;" />`
	} else {
		nameHTML = `<img src="` + logoURL + `" alt="" style="height:1.7rem;vertical-align:middle;margin-right:0.45rem" />` + htmlEscape(displayTitle)
	}
	// Favicon: a configured path is served from the content mount; unset falls back
	// to the vendored Leji mark.
	faviconURL := htmlEscape(defaultLogo(base))
	if favicon != "" {
		rel, ok := resolveViewerRel(root, m.RootPath, favicon)
		if !ok {
			rel = fsx.StripSlash(favicon)
		}
		faviconURL = htmlEscape(base + "content/" + rel)
	}
	config, err := docsifyConfigJSON(root, m, nameHTML, base, fnds)
	if err != nil {
		return "", err
	}
	// Mermaid is on unless explicitly disabled. When off, the scripts are omitted
	// and their assets not copied (~3MB smaller viewer).
	mermaidScripts := ""
	if mermaidEnabled(m) {
		mermaidScripts = "\n      <script src=\"assets/mermaid.min.js\"></script>" +
			"\n      <script src=\"assets/docsify-mermaid.js\"></script>"
	}
	// One pass over the template with a resolver map, never four sequential
	// replaces: a sequential pass re-scans what the previous one substituted, so a
	// manifest string like "{{DOCSIFY_CONFIG}}" in viewer.title or viewer.favicon
	// would be expanded a second time and break out of the element it landed in.
	substitutions := map[string]string{
		"LEJI_NAME_HTML":  htmlEscape(displayTitle),
		"FAVICON_URL":     faviconURL,
		"DOCSIFY_CONFIG":  config,
		"MERMAID_SCRIPTS": mermaidScripts,
	}
	return placeholderRe.ReplaceAllStringFunc(string(htmlBytes), func(whole string) string {
		if v, ok := substitutions[whole[2:len(whole)-2]]; ok {
			return v
		}
		return whole
	}), nil
}

// mermaidEnabled reports whether the layer keeps mermaid on (the default).
func mermaidEnabled(m *manifest.Manifest) bool {
	return m.Viewer == nil || m.Viewer.Mermaid == nil || *m.Viewer.Mermaid
}

// GenerateViewer writes index.html, _sidebar.md, and the vendored assets into the
// root `.leji/viewer/` role: a Docsify `index.html` and a `_sidebar.md` projected
// from the index. Presentation is non-normative; this is the reference projection
// of context-index.json into a browsable surface.
//
// ignoreContext is the invocation's notice state for the self-managed
// `.leji/.gitignore` (this run creates a role, so it ensures that file): a caller
// that has one passes it through, and a direct SDK call that passes none notices at
// most once for that call.
func GenerateViewer(root string, m *manifest.Manifest, ignoreContext ...*lejiignore.Context) (Result, error) {
	result, err := indexgen.GenerateIndex(root, m)
	if err != nil {
		return Result{}, err
	}
	// Don't project a viewer from a tree that can't be indexed cleanly: surface the
	// errors and write nothing, the same refusal WriteIndex makes.
	for _, f := range result.Findings {
		if f.Severity == findings.Error {
			return Result{Written: nil, Findings: result.Findings, Entries: 0,
				IndexEntries: []indexgen.IndexEntry{}}, nil
		}
	}
	// Non-nil even when the layer governs nothing: this slice is also the snapshot a
	// caller hands the local server, where nil is the "I have no snapshot" signal (the
	// reference's `undefined`). A successful generation over an empty layer projected an
	// answer, and that answer is zero entries, not the absence of one.
	entries := []indexgen.IndexEntry{}
	if result.Index != nil && result.Index.Entries != nil {
		entries = result.Index.Entries
	}
	var findingsEarly []findings.Finding

	// The served flavor: the chrome under `.leji/viewer/` is never export-flavored.
	page, err := BuildIndexHTML(root, m, servedBase, &findingsEarly)
	if err != nil {
		return Result{}, err
	}
	sidebar := AssembleSidebar(root, m, entries, &findingsEarly)

	rootDir := fsx.StripSlash(m.RootPath)
	if rootDir == "" {
		rootDir = "."
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return Result{}, err
	}

	var written []string
	files := []struct {
		name    string
		content []byte
	}{
		{"index.html", []byte(page)},
		{"_sidebar.md", []byte(sidebar)},
	}

	// Copy every vendored asset so nothing loads from a remote CDN. The provenance
	// note is documentation, never shipped.
	assetEntries, err := assets.FS.ReadDir("templates/viewer/assets")
	if err != nil {
		return Result{}, err
	}
	for _, e := range assetEntries {
		if e.IsDir() || e.Name() == "PROVENANCE.txt" || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		// Mermaid off omits its two scripts from the page and their assets here (~3MB).
		if !mermaidEnabled(m) && mermaidAssets[e.Name()] {
			continue
		}
		content, err := assets.FS.ReadFile("templates/viewer/assets/" + e.Name())
		if err != nil {
			return Result{}, err
		}
		files = append(files, struct {
			name    string
			content []byte
		}{"assets/" + e.Name(), content})
	}
	findingList := append([]findings.Finding{}, result.Findings...)
	findingList = append(findingList, findingsEarly...)

	// Check-before-act: the generation target — the `.leji/viewer/` role — is
	// realpath-resolved and validated BEFORE a single byte is written. A `.leji/viewer`
	// that resolves into a DIFFERENT private role (`.leji/work/`, `.leji/mounts/`, a
	// future role), or out of the repository altogether, is refused here, so a symlinked
	// viewer can never be written through into the trust domain or out of the tree; only
	// its own directory passes. Unresolvable (permission/I/O error, not mere absence)
	// fails the check rather than being rebuilt lexically.
	resolvedRoot, ok := fsx.ResolvedPath(rootAbs)
	if !ok {
		resolvedRoot = rootAbs
	}
	viewerTarget, resolvable := fsx.ResolvedPathUnder(resolvedRoot, layout.Abs(resolvedRoot, layout.ViewerRel))
	verdict := layout.TargetVerdict{Unresolvable: true}
	if resolvable {
		verdict = layout.WritableTarget(resolvedRoot, viewerTarget, layout.ViewerRel)
	}
	if !verdict.OK {
		message := "refusing to generate the viewer: " + layout.ViewerRel + "/ resolves into " +
			layout.LejiDir + "/" + verdict.Role + " (private); remove the symlink"
		switch {
		case verdict.Unresolvable:
			message = "refusing to generate the viewer: " + layout.ViewerRel +
				"/ cannot be resolved (permission or I/O error); remove the symlink"
		case verdict.OutsideRoot:
			message = "refusing to generate the viewer: " + layout.ViewerRel +
				"/ resolves outside the repository; remove the symlink"
		}
		findingList = append(findingList, findings.New("viewer-target-refused", findings.Error, message, layout.ViewerRel))
		return Result{Written: written, Findings: findingList, Entries: 0,
			IndexEntries: []indexgen.IndexEntry{}}, nil
	}

	// The chrome's role in the unified root `.leji/` (gitignored): outside the context
	// root whatever rootPath is, so it never collides with the user's own files and
	// never rides a content walk. Every write goes back through the chokepoint with the
	// viewer's own role, so each file is judged on its RESOLVED path immediately before
	// it is written and lands there: the role was validated as a whole above, and this
	// keeps a symlink planted inside the tree from redirecting a single file elsewhere.
	viewerDir := layout.ViewerRel
	writeViewerFile := func(rel string, content []byte) error {
		abs := filepath.Join(root, filepath.FromSlash(rel))
		verdict, err := fsx.WriteFileGuarded(resolvedRoot, abs, layout.ViewerRel, content, fsx.WriteOptions{})
		if err != nil {
			return err
		}
		if !verdict.OK {
			findingList = append(findingList, findings.New("artifact-parse", findings.Error,
				"viewer path "+rel+" resolves outside "+layout.ViewerRel+"/", rel))
			return nil
		}
		written = append(written, rel)
		return nil
	}
	for _, f := range files {
		if err := writeViewerFile(viewerDir+"/"+f.name, f.content); err != nil {
			return Result{}, err
		}
	}

	// The role now exists, so the tool ignores its own tree from inside: a layer
	// whose root .gitignore never carried the `.leji/` line is clean after this run.
	// A refusal is an error finding like any other refused write here.
	ignored, err := lejiignore.EnsureFile(resolvedRoot, lejiignore.From(ignoreContext...))
	if err != nil {
		return Result{}, err
	}
	if ignored == lejiignore.Refused {
		findingList = append(findingList, findings.New("viewer-target-refused", findings.Error,
			"refusing to write "+layout.LejiIgnoreRel+": it does not resolve to a regular file inside "+
				layout.LejiDir+"/; remove the symlink", layout.LejiIgnoreRel))
	}

	// The overview/home page is user-owned content (not chrome): seeded once, never
	// written again. The layer map is rendered between its markers when the page is
	// read (by the local server and by the export), so a reindex that changes the
	// document counts leaves this file exactly as its author last saved it. If the
	// markers are gone there is nowhere to render the map, which is a warning.
	//
	// Check-before-act: overview.md is content — its target must resolve WITHIN
	// the layer root AND never into a private `.leji/` role. It is judged on the
	// RESOLVED path (no `.leji/` role of its own) BEFORE anything is read or written,
	// so an overview.md symlinked into `.leji/work/` or `.leji/mounts/` is refused
	// before the seed writes through it or the page is read, and the seed itself then
	// lands via the guarded-write chokepoint on that path.
	overviewRel := OverviewRel
	if rootDir != "." {
		overviewRel = rootDir + "/" + OverviewRel
	}
	overviewAbs := filepath.Join(root, overviewRel)
	overviewResolved, overviewResolvable := fsx.ResolvedPathUnder(resolvedRoot, overviewAbs)
	overviewVerdict := layout.TargetVerdict{}
	contained := overviewResolvable && fsx.ResolvedWithinRoot(rootAbs, overviewAbs)
	if contained {
		overviewVerdict = layout.WritableTarget(resolvedRoot, overviewResolved, "")
	}
	overviewRead, err := fsx.VerifiedTargetRead(resolvedRoot, overviewAbs, "")
	if err != nil {
		return Result{}, err
	}
	switch {
	case !contained:
		findingList = append(findingList, findings.New("artifact-parse", findings.Error,
			"overview.md resolves outside the layer root", overviewRel))
	case !overviewVerdict.OK:
		findingList = append(findingList, findings.New("viewer-target-refused", findings.Error,
			"refusing to write overview.md: it resolves into "+layout.LejiDir+"/"+overviewVerdict.Role+
				" (private); remove the symlink", overviewRel))
	case overviewRead.Status == fsx.ReadRefused:
		// A standing entry that cannot be verified as a regular file inside the layer:
		// the page is neither seeded through it nor read from a path that could redirect.
		findingList = append(findingList, findings.New("viewer-target-refused", findings.Error,
			"refusing to write overview.md: it does not resolve to a regular file inside the repository; "+
				"remove the symlink", overviewRel))
	case overviewRead.Status == fsx.ReadAbsent:
		seeded, err := fsx.WriteFileGuarded(resolvedRoot, overviewAbs, "",
			[]byte(buildOverviewSeed(m)), fsx.WriteOptions{})
		if err != nil {
			return Result{}, err
		}
		if seeded.OK {
			written = append(written, overviewRel)
		}
	default:
		// A standing page is READ and not written: the only thing generation decides
		// here is whether the map has a place to be rendered into. The bytes come from
		// the verified descriptor rather than from a second read by pathname, so the
		// page the guards judged is the page the answer is about.
		if _, markersFound := RenderOverview(DecodeUTF8(overviewRead.Bytes), m, entries); !markersFound {
			findingList = append(findingList, findings.New("overview-markers-missing", findings.Warning,
				"overview.md has no generated-map markers; the map is not rendered", overviewRel))
		}
	}

	// The Manifest page: generated chrome, exactly like _sidebar.md. Written into the
	// gitignored viewer dir under a reserved underscore name (collision-free with the
	// user's own files) and served via a dedicated content route (never a committed
	// file at the context root, so no diff churn). Regenerated every run; pinned.
	manifestStatuses, _ := mounts.MountStatus(root, m, mounts.StatusOptions{})
	if err := writeViewerFile(viewerDir+"/_manifest.md", []byte(buildManifestPage(m, manifestStatuses))); err != nil {
		return Result{}, err
	}

	return Result{Written: written, Findings: findingList, Entries: len(entries), IndexEntries: entries}, nil
}

// ActiveExtensions are the extensions a browser would run as an active,
// same-origin document. Under `/content/` they are served as text/plain instead
// of their active type, and they are left out of the static export entirely:
// everything under the content mount is layer material, and layer material is
// read, never executed.
//
// `.svg` is deliberately NOT here. It stays a first-class asset (viewer.logo and
// viewer.favicon may point at one under the context root) because the inertness
// comes from the policy, not the content type: every /content/ response carries
// the cspContent sandbox below, so an SVG navigated to or framed lands in an
// opaque origin with scripting off, and an SVG loaded as an <img> never runs
// script whatever its type.
var ActiveExtensions = map[string]bool{
	".html":  true,
	".htm":   true,
	".js":    true,
	".mjs":   true,
	".xhtml": true,
}
