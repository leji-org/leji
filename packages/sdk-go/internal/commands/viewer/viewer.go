// Package viewer projects the context index into a static Docsify viewer and can
// serve the repository locally on 127.0.0.1.
package viewer

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode"

	"github.com/leji-org/leji/packages/sdk-go/internal/assets"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/indexgen"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/frontmatter"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/jsonenc"
	"github.com/leji-org/leji/packages/sdk-go/internal/layer"
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

// defaultThemeColor is the default accent (Leji brand blue) when no
// viewer.theme.primary is set; defaultLogo is the vendored Leji mark.
const (
	defaultThemeColor = "#223F93"
	defaultLogo       = "/assets/leji-logo.svg"
)

// mermaidAssets are loaded only when mermaid is enabled.
var mermaidAssets = map[string]bool{
	"mermaid.min.js":     true,
	"docsify-mermaid.js": true,
}

// safeCSSColor matches a CSS color safe to hand to the page: a hex color or a
// bare color keyword. The accent reaches a stylesheet as a custom-property
// value, so anything with punctuation in it is a CSS-injection sink, not a color.
var safeCSSColor = regexp.MustCompile(`^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)$`)

// resolveThemeColor returns the viewer accent: viewer.theme.primary when it is a
// plain CSS color, else the Leji default with a warning. Never the authored value
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
		`viewer.theme.primary "`+configured+`" is not a plain CSS color (hex or keyword); using `+defaultThemeColor))
	return defaultThemeColor
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
	if stripped, ok := relativeToRoot(clean, rootPath); ok && fsx.IsFile(filepath.Join(root, clean)) {
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
func resolveLogo(root, rootPath, logo string) string {
	if logo == "" {
		return defaultLogo
	}
	if strings.HasPrefix(logo, "/") || httpURLRe.MatchString(logo) {
		return logo
	}
	if rel, ok := resolveViewerRel(root, rootPath, logo); ok {
		return "/content/" + rel
	}
	return "/content/" + fsx.StripSlash(logo)
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

func relativeToRoot(relPath, rootPath string) (string, bool) {
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

func mdLinkDest(s string) string {
	return mdLinkDestRe.ReplaceAllString(s, `\$0`)
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
	if boot, ok := relativeToRoot(m.BootProfilePath, m.RootPath); ok && !bootPinned {
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
				rel, ok := relativeToRoot(relPath, m.RootPath)
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
		rel, ok := relativeToRoot(p.RelPath, m.RootPath)
		if !ok {
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

// referenceTree is the browse zone: every markdown file under rootPath that is NOT
// governed (in the index) and NOT viewer/layer chrome (boot profile, agent
// profiles, category index files, overview.md, the generated _sidebar.md). The
// `.leji` viewer dir is skipped by the walk itself. Returned as rootPath-relative
// nodes.
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
	overviewRel := "overview.md"
	sidebarRel := "_sidebar.md"
	manifestPageRel := "_manifest.md"
	if rootDirRel != "." {
		overviewRel = rootDirRel + "/overview.md"
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
		r, ok := relativeToRoot(rel, m.RootPath)
		if !ok {
			continue
		}
		nodes = append(nodes, TreeNode{Rel: r, Title: sidebarLabel(root, rel, r)})
	}
	return nodes
}

// The overview homepage is seeded once then user-owned. The layer map lives
// between these markers; `leji viewer` regenerates only the marked block.
const (
	mapStart = "<!-- leji:generated-map:start -->"
	mapEnd   = "<!-- leji:generated-map:end -->"
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

// buildOverviewSeed is the starter home page: a short owner-editable explainer
// plus the generated layer map inside the regen markers.
func buildOverviewSeed(m *manifest.Manifest, entries []indexgen.IndexEntry) string {
	return "# " + m.Name + `

This is the **Leji context layer** for ` + "`" + m.Name + "`" + `: the shared, validated context
people and coding agents read before working in this repository. Start with the boot
profile, then browse the categories in the sidebar.

This page is yours to edit. The map below is regenerated by ` + "`leji viewer`" + ` between the
markers; the prose around it is left untouched.

` + mapBlock(m, entries) + `

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
		"# " + esc(title) + " — Manifest",
		"",
		"A human-readable view of this layer's `leji.json`.",
		"",
		"> **Declared** values come straight from the manifest. **Observed** values (mount availability and drift) are read from local projections and Git objects — no network fetch is performed.",
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
		lines = append(lines, "| Conformance | claims `"+esc(claimed)+"` — run `leji conformance` to verify |")
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
		lines = append(lines, "", "> `not hydrated` / `unknown` are normal degraded reads — ordinary validation never fails just because a mount is unavailable (opt-in federation enforcement is separate). Run `leji mounts hydrate`, then regenerate the viewer to refresh.")
		var roled []manifest.Mount
		for _, d := range mountList {
			if d.Role != "" {
				roled = append(roled, d)
			}
		}
		if len(roled) > 0 {
			lines = append(lines, "", "**Roles**", "")
			for _, d := range roled {
				lines = append(lines, "- **"+esc(d.Name)+"** — "+esc(d.Role))
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

// unresolvedProfilePage is the page for an agent profile that declares `inherits`
// and does not resolve: there is no effective profile to show, and presenting the
// derived file as if there were would be the error the finding names.
func unresolvedProfilePage(relPath string, fnds []findings.Finding) string {
	lines := []string{
		"# " + esc(relPath) + " — unresolved profile",
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
		return unresolvedProfilePage(derived.RelPath, resolved.Findings)
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
		"# " + esc(title) + " — resolved profile",
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
			lines = append(lines, "- **"+esc(key)+"** — "+profileValue(value))
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
			lines = append(lines, "   - "+profileValue(entry)+" — from `"+esc(source)+"`")
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

// declaresInherits reports whether the file at repoRel declares `inherits`, so it
// is one half of a profile and must never reach a reader as the effective one.
// Manifest-free and total, so the serve path can still classify when nothing else
// is readable.
func declaresInherits(root, repoRel string) bool {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	abs := filepath.Join(root, repoRel)
	if !fsx.IsFile(abs) || !fsx.ResolvesUnder(rootAbs, abs) {
		return false
	}
	text, err := fsx.ReadText(abs)
	if err != nil {
		return false
	}
	_, ok := frontmatter.Parse(text).Data["inherits"].(string)
	return ok
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
	if !declaresInherits(root, repoRel) {
		return "", false
	}
	profiles := layer.ScanProfileSet(root, m)
	for _, p := range profiles {
		if p.RelPath == repoRel {
			return renderResolvedProfile(profiles, p), true
		}
	}
	return unresolvedProfilePage(repoRel, []findings.Finding{
		findings.New("artifact-parse", findings.Error, "the profile scan did not reach this file", repoRel),
	}), true
}

// resolvedProfilePage is one inheriting profile's rootPath-relative viewer path
// and resolved page.
type resolvedPage struct {
	rel  string
	page string
}

// resolvedProfilePages is every inheriting profile as its rootPath-relative viewer
// path and resolved page, so a static export carries what the local server renders.
func resolvedProfilePages(root string, m *manifest.Manifest) []resolvedPage {
	profiles := layer.ScanProfileSet(root, m)
	var out []resolvedPage
	for _, p := range profiles {
		if _, ok := p.Frontmatter["inherits"].(string); !ok {
			continue
		}
		rel, ok := relativeToRoot(p.RelPath, m.RootPath)
		if !ok {
			continue // outside the context root: not servable
		}
		out = append(out, resolvedPage{rel: rel, page: renderResolvedProfile(profiles, p)})
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
func docsifyConfigJSON(root string, m *manifest.Manifest, nameHTML string, fnds *[]findings.Finding) (string, error) {
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
	// Hash navigation for the logo/title link: #/ re-routes to the homepage
	// inside the SPA instead of a full page reload.
	b.WriteString(`,"nameLink":"#/"`)
	// Per-page classification badge (top-right chip): the boot script resolves
	// the current route against the served index using these.
	idxRel, idxOK := relativeToRoot(manifest.EffectiveIndexPath(m), m.RootPath)
	b.WriteString(`,"lejiIndexRel":`)
	if err := writeNullable(idxRel, idxOK); err != nil {
		return "", err
	}
	bootRel, bootOK := relativeToRoot(m.BootProfilePath, m.RootPath)
	b.WriteString(`,"lejiBootPath":`)
	if err := writeNullable(bootRel, bootOK); err != nil {
		return "", err
	}
	agentsRel, agentsOK := relativeToRoot(manifest.EffectiveAgentProfilesPath(m), m.RootPath)
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
	// Read by the boot script's powered-by plugin; false removes the mark.
	powered := !(m.Viewer != nil && m.Viewer.PoweredBy != nil && !*m.Viewer.PoweredBy)
	b.WriteString(`,"lejiPoweredBy":`)
	b.WriteString(strconv.FormatBool(powered))
	b.WriteString("}")
	return scriptSafeJSON(b.Bytes()), nil
}

// assembleSidebar assembles the current sidebar for a layer entirely in memory:
// pins (with boot-pin replacement), pin-filtered groups, and the
// homepage-excluded reference tree. Used by generation and by the serve path,
// which rebuilds it per fetch so a long-running viewer never shows a deleted or
// moved document.
func assembleSidebar(root string, m *manifest.Manifest, entries []indexgen.IndexEntry, fnds *[]findings.Finding) string {
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
			rel, ok := relativeToRoot(pinPath, m.RootPath)
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

// GenerateViewer writes index.html, _sidebar.md, and the vendored assets into the
// context root: a Docsify `index.html` and a `_sidebar.md` projected from the
// index. Presentation is non-normative; this is the reference projection of
// context-index.json into a browsable surface.
func GenerateViewer(root string, m *manifest.Manifest) (Result, error) {
	result := indexgen.GenerateIndex(root, m)
	// Don't project a viewer from a tree that can't be indexed cleanly: surface the
	// errors and write nothing, the same refusal WriteIndex makes.
	for _, f := range result.Findings {
		if f.Severity == findings.Error {
			return Result{Written: nil, Findings: result.Findings, Entries: 0}, nil
		}
	}
	var entries []indexgen.IndexEntry
	if result.Index != nil {
		entries = result.Index.Entries
	}
	var findingsEarly []findings.Finding

	htmlBytes, err := assets.FS.ReadFile("templates/viewer/index.html")
	if err != nil {
		return Result{}, err
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
	logoURL := htmlEscape(resolveLogo(root, m.RootPath, logo))
	var nameHTML string
	if logo != "" {
		nameHTML = `<img src="` + logoURL + `" alt="` + htmlEscape(displayTitle) + `" style="max-width:180px;margin:10px auto;display:block;" />`
	} else {
		nameHTML = `<img src="` + logoURL + `" alt="" style="height:1.7rem;vertical-align:middle;margin-right:0.45rem" />` + htmlEscape(displayTitle)
	}
	// Favicon: a configured path is served from the content mount; unset falls back
	// to the vendored Leji mark.
	faviconURL := htmlEscape(defaultLogo)
	if favicon != "" {
		rel, ok := resolveViewerRel(root, m.RootPath, favicon)
		if !ok {
			rel = fsx.StripSlash(favicon)
		}
		faviconURL = htmlEscape("/content/" + rel)
	}
	config, err := docsifyConfigJSON(root, m, nameHTML, &findingsEarly)
	if err != nil {
		return Result{}, err
	}
	// Mermaid is on unless explicitly disabled. When off, the scripts are omitted
	// and their assets not copied (~3MB smaller viewer).
	mermaidEnabled := m.Viewer == nil || m.Viewer.Mermaid == nil || *m.Viewer.Mermaid
	mermaidScripts := ""
	if mermaidEnabled {
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
	page := placeholderRe.ReplaceAllStringFunc(string(htmlBytes), func(whole string) string {
		if v, ok := substitutions[whole[2:len(whole)-2]]; ok {
			return v
		}
		return whole
	})
	sidebar := assembleSidebar(root, m, entries, &findingsEarly)

	rootDir := fsx.StripSlash(m.RootPath)
	if rootDir == "" {
		rootDir = "."
	}

	// The viewer is contained under rootPath/.leji/viewer/ (gitignored) so it never
	// collides with the user's own files in the context root.
	viewerDir := ".leji/viewer"
	if rootDir != "." {
		viewerDir = rootDir + "/.leji/viewer"
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
		if !mermaidEnabled && mermaidAssets[e.Name()] {
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
	// Refuse to write through a symlink that escapes the layer root. ResolvesUnder
	// resolves the nearest existing ancestor, so a not-yet-existing target under a
	// symlinked directory is caught before mkdir/write can escape. An escaping target
	// is skipped with an error finding rather than aborting, mirroring Node's writeWithin.
	for _, f := range files {
		rel := viewerDir + "/" + f.name
		abs := filepath.Join(root, rel)
		if !fsx.ResolvesUnder(root, abs) {
			findingList = append(findingList, findings.New("artifact-parse", findings.Error,
				"viewer path "+rel+" resolves outside the layer root", rel))
			continue
		}
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return Result{}, err
		}
		if err := os.WriteFile(abs, f.content, 0o644); err != nil {
			return Result{}, err
		}
		written = append(written, rel)
	}

	// The overview/home page is user-owned content (not chrome): seeded once, never
	// overwritten. On regen only the marked map block is refreshed; if the owner
	// removed the markers, the page is left alone.
	overviewRel := "overview.md"
	if rootDir != "." {
		overviewRel = rootDir + "/overview.md"
	}
	overviewAbs := filepath.Join(root, overviewRel)
	if !fsx.IsFile(overviewAbs) {
		if !fsx.ResolvesUnder(root, overviewAbs) {
			findingList = append(findingList, findings.New("artifact-parse", findings.Error,
				"viewer path "+overviewRel+" resolves outside the layer root", overviewRel))
		} else {
			if err := os.MkdirAll(filepath.Dir(overviewAbs), 0o755); err != nil {
				return Result{}, err
			}
			if err := os.WriteFile(overviewAbs, []byte(buildOverviewSeed(m, entries)), 0o644); err != nil {
				return Result{}, err
			}
			written = append(written, overviewRel)
		}
	} else if fsx.ResolvesUnder(root, overviewAbs) {
		existing, err := fsx.ReadText(overviewAbs)
		if err != nil {
			return Result{}, err
		}
		start := strings.Index(existing, mapStart)
		end := strings.Index(existing, mapEnd)
		if start >= 0 && end > start {
			updated := existing[:start] + mapBlock(m, entries) + existing[end+len(mapEnd):]
			if updated != existing {
				if err := os.WriteFile(overviewAbs, []byte(updated), 0o644); err != nil {
					return Result{}, err
				}
			}
		} else {
			findingList = append(findingList, findings.New("overview-markers-missing", findings.Warning,
				"overview.md has no generated-map markers; left as-is (map not refreshed)", overviewRel))
		}
	}

	// The Manifest page: generated chrome, exactly like _sidebar.md. Written into the
	// gitignored viewer dir under a reserved underscore name (collision-free with the
	// user's own files) and served via a dedicated content route (never a committed
	// file at the context root, so no diff churn). Regenerated every run; pinned.
	manifestStatuses, _ := mounts.MountStatus(root, m, mounts.StatusOptions{})
	manifestRel := viewerDir + "/_manifest.md"
	manifestAbs := filepath.Join(root, manifestRel)
	if !fsx.ResolvesUnder(root, manifestAbs) {
		findingList = append(findingList, findings.New("artifact-parse", findings.Error,
			"viewer path "+manifestRel+" resolves outside the layer root", manifestRel))
	} else {
		if err := os.MkdirAll(filepath.Dir(manifestAbs), 0o755); err != nil {
			return Result{}, err
		}
		if err := os.WriteFile(manifestAbs, []byte(buildManifestPage(m, manifestStatuses)), 0o644); err != nil {
			return Result{}, err
		}
		written = append(written, manifestRel)
	}

	return Result{Written: written, Findings: findingList, Entries: len(entries)}, nil
}

// ProtectWarning is the protect-your-context warning surfaced by `leji viewer
// build` (stdout and a comment in the exported index.html).
const ProtectWarning = "This is your context layer (identity, invariants, decisions, sometimes sensitive internal knowledge). Host the exported folder behind internal authentication, not a public or shared bucket where it could be indexed or leaked. Active file types (.htm, .html, .js, .mjs, .xhtml) are left out of the exported content: a static host would serve them as same-origin documents that execute with no policy."

// exportMarker is the first bytes `viewer build` writes into an exported
// index.html. A target directory carrying this marker is a previous export and
// may be cleared; any other non-empty directory is somebody's content.
const exportMarker = "<!--\n  Leji viewer (leji viewer build).\n"

// clearableExport reports whether the export may clear dir: it is absent, an
// empty directory, or a previous export. Anything else (a file, a populated
// directory the exporter did not write) is content the tool must not delete.
func clearableExport(dir string) bool {
	info, err := os.Stat(dir)
	if err != nil {
		return true // absent
	}
	if !info.IsDir() {
		return false
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	if len(entries) == 0 {
		return true
	}
	index := filepath.Join(dir, "index.html")
	if !fsx.IsFile(index) {
		return false
	}
	body, err := os.ReadFile(index)
	if err != nil {
		return false
	}
	return strings.HasPrefix(string(body), exportMarker)
}

// BuildResult is the result of BuildViewer: the relative output dir and the
// findings carried over from regeneration.
type BuildResult struct {
	Out      string
	Findings []findings.Finding
}

// copyOptions tunes copyTree for the two trees the export writes: the layer's
// content (dotfiles, active types, and the export dir itself all excluded) and
// the viewer's own vendored assets (copied whole, .js and .svg included).
type copyOptions struct {
	skipDotfiles bool   // dot-prefixed entries at every level (.git, .leji, .secret.md)
	skipActive   bool   // extensions a static host would serve as active documents
	skipPath     string // an absolute path never descended into (the export itself)
}

// copyTree recursively copies src to dst, preserving file modes; mirrors Node's
// copyContent.
func copyTree(src, dst string, opts copyOptions) error {
	return filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		if rel == "." {
			return os.MkdirAll(dst, 0o755)
		}
		if opts.skipDotfiles && strings.HasPrefix(filepath.Base(rel), ".") {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		// Second line of defense behind the --out containment in BuildViewer: the
		// export never walks into itself, whatever the output path turns out to be.
		if opts.skipPath != "" && p == opts.skipPath {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		// Skip symlinks: reading through one would copy content from outside the layer
		// into the self-contained export.
		if info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		// Active types never ride along: the export is meant to be hosted, and a
		// static host would serve them as same-origin documents with no policy.
		if opts.skipActive && activeExtensions[strings.ToLower(path.Ext(rel))] {
			return nil
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		return os.WriteFile(target, data, info.Mode().Perm())
	})
}

// copyFile copies a single file, preserving its mode.
func copyFile(src, dst string) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	return os.WriteFile(dst, data, info.Mode().Perm())
}

// BuildViewer exports a self-contained static viewer into outRel with the same URL
// contract the local server uses (chrome at the web root, markdown under
// /content/), so any static host serves it as-is. Regenerates first, then copies
// chrome and content docs into a clean output dir. The exported index.html carries
// the protect-your-context warning as a comment.
func BuildViewer(root string, m *manifest.Manifest, outRel string) (BuildResult, error) {
	gen, err := GenerateViewer(root, m)
	if err != nil {
		return BuildResult{}, err
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return BuildResult{}, err
	}
	rootDir := fsx.StripSlash(m.RootPath)
	if rootDir == "" {
		rootDir = "."
	}
	contentAbs := rootAbs
	if rootDir != "." {
		contentAbs = filepath.Join(rootAbs, rootDir)
	}
	var outAbs string
	switch {
	case outRel == "":
		outAbs = filepath.Join(contentAbs, ".leji", "viewer-dist")
	case filepath.IsAbs(outRel):
		outAbs = outRel
	default:
		outAbs = filepath.Join(rootAbs, outRel)
	}
	outDisplay, err := filepath.Rel(rootAbs, outAbs)
	if err != nil {
		return BuildResult{}, err
	}

	// Never run the destructive export when generation failed (e.g. a symlinked
	// rootPath escaping the layer): the removal below could delete an escaped path.
	for _, fnd := range gen.Findings {
		if fnd.Severity == findings.Error {
			return BuildResult{Out: outDisplay, Findings: gen.Findings}, nil
		}
	}
	// Contain the output before the removal: it must stay inside the repo and clear
	// of the context root in BOTH directions. Exporting into governed content deletes
	// it, and exporting into a directory that holds the context root deletes the layer
	// itself. The default output lives under the dot-dir the walk skips, so only a
	// caller-supplied --out is measured against the context root.
	sep := string(filepath.Separator)
	collides := outRel != "" &&
		(strings.HasPrefix(outAbs, contentAbs+sep) || strings.HasPrefix(contentAbs, outAbs+sep))
	ref := outRel
	if ref == "" {
		ref = outDisplay
	}
	if outAbs == rootAbs || outAbs == contentAbs || !fsx.ResolvesUnder(rootAbs, outAbs) || collides {
		return BuildResult{}, errors.New(`refusing to build the viewer into "` + ref + `": --out must be a path inside the repository, and must not be the repository root, the context root, inside the context root, or a directory containing the context root`)
	}
	// Never remove a directory this command did not write: the export clears a
	// previous export, and refuses anything else that is already occupied.
	if !clearableExport(outAbs) {
		return BuildResult{}, errors.New(`refusing to build the viewer into "` + ref + `": the target exists and is neither empty nor a previous viewer export; remove it or pick another --out`)
	}
	viewerAbs := filepath.Join(contentAbs, ".leji", "viewer")
	outContent := filepath.Join(outAbs, "content")

	// Clean rebuild so a removed source file never lingers in the export.
	if err := os.RemoveAll(outAbs); err != nil {
		return BuildResult{}, err
	}
	if err := os.MkdirAll(outContent, 0o755); err != nil {
		return BuildResult{}, err
	}

	// Content docs under /content/ (everything except the regenerable .leji/ dir).
	if err := copyTree(contentAbs, outContent, copyOptions{skipDotfiles: true, skipActive: true, skipPath: outAbs}); err != nil {
		return BuildResult{}, err
	}
	// An inheriting agent profile exports resolved, exactly as the local server
	// renders it: the copied file is only its own half of the profile.
	for _, rp := range resolvedProfilePages(rootAbs, m) {
		target := filepath.Join(outContent, filepath.FromSlash(rp.rel))
		if !fsx.ResolvesUnder(outContent, target) {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return BuildResult{}, err
		}
		if err := os.WriteFile(target, []byte(rp.page), 0o644); err != nil {
			return BuildResult{}, err
		}
	}
	// The generated sidebar is served as if at the content root.
	if err := copyFile(filepath.Join(viewerAbs, "_sidebar.md"), filepath.Join(outContent, "_sidebar.md")); err != nil {
		return BuildResult{}, err
	}
	// The generated Manifest page, likewise served as if at the content root.
	if err := copyFile(filepath.Join(viewerAbs, "_manifest.md"), filepath.Join(outContent, "_manifest.md")); err != nil {
		return BuildResult{}, err
	}
	// The viewer assets at the web root: vendored chrome, copied whole (its own
	// scripts and the Leji mark are exactly the active types the content walk drops).
	if err := copyTree(filepath.Join(viewerAbs, "assets"), filepath.Join(outAbs, "assets"), copyOptions{}); err != nil {
		return BuildResult{}, err
	}
	// index.html at the web root, with the protect-your-context warning prepended.
	indexHTML, err := os.ReadFile(filepath.Join(viewerAbs, "index.html"))
	if err != nil {
		return BuildResult{}, err
	}
	prepended := "<!--\n  Leji viewer (leji viewer build).\n  " + ProtectWarning + "\n-->\n" + string(indexHTML)
	if err := os.WriteFile(filepath.Join(outAbs, "index.html"), []byte(prepended), 0o644); err != nil {
		return BuildResult{}, err
	}

	return BuildResult{Out: outDisplay, Findings: gen.Findings}, nil
}

// activeExtensions are the extensions a browser would run as an active,
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
var activeExtensions = map[string]bool{
	".html":  true,
	".htm":   true,
	".js":    true,
	".mjs":   true,
	".xhtml": true,
}

const (
	// cspChrome is the SPA shell's policy, sent as a response header on every
	// chrome response so it holds for documents reached outside the shell too.
	// Mirrors the meta in templates/viewer/index.html; keep the two in step.
	cspChrome = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; frame-src 'none'"
	// cspContent is the policy for everything served out of the layer itself.
	// `sandbox` with no tokens puts a /content/ document in an opaque origin with
	// scripting off, so a governed file framed or opened directly is inert rather
	// than same-origin code.
	cspContent = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox"
)

// loopbackHosts are the host names the local preview answers to.
var loopbackHosts = map[string]bool{"localhost": true, "127.0.0.1": true, "[::1]": true}

// loopbackHost reports whether the Host header names the loopback interface:
// hostname only, since the port a request arrives on is already fixed by the
// loopback bind. A missing Host is accepted (an HTTP/1.0 client omits it).
func loopbackHost(host string) bool {
	if host == "" {
		return true
	}
	name := host
	if strings.HasPrefix(host, "[") {
		name = host[:strings.Index(host, "]")+1]
	} else if i := strings.Index(host, ":"); i >= 0 {
		name = host[:i]
	}
	return loopbackHosts[strings.ToLower(name)]
}

var contentTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".md":    "text/markdown; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json; charset=utf-8",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".jpg":   "image/jpeg",
	".jpeg":  "image/jpeg",
	".gif":   "image/gif",
	".ico":   "image/x-icon",
	".txt":   "text/plain; charset=utf-8",
	".woff":  "font/woff",
	".woff2": "font/woff2",
}

// serveFrom serves `sub` (clean relative path; "" -> index.html) from mountRoot.
// Lexically contains the target, follows a dir to index.html, then realpath-checks
// so a symlink can't escape. Mirrors Node: 200 ok, 403 containment violation, 404
// on any stat/read failure. `inert` marks the layer's own content mount, whose
// files are never given an active content type however they are named.
func serveFrom(w http.ResponseWriter, mountRoot, sub string, inert bool) {
	var abs string
	if sub == "" {
		abs = filepath.Join(mountRoot, "index.html")
	} else {
		abs = filepath.Join(mountRoot, sub)
	}
	if abs != mountRoot && !strings.HasPrefix(abs, mountRoot+string(filepath.Separator)) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte("forbidden"))
		return
	}
	if info, err := os.Stat(abs); err == nil && info.IsDir() {
		abs = filepath.Join(abs, "index.html")
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("not found"))
		return
	}
	if real != mountRoot && !strings.HasPrefix(real, mountRoot+string(filepath.Separator)) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte("forbidden"))
		return
	}
	body, err := os.ReadFile(abs)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("not found"))
		return
	}
	ext := strings.ToLower(path.Ext(abs))
	ct := contentTypes[ext]
	if ct == "" {
		ct = "application/octet-stream"
	}
	if inert && activeExtensions[ext] {
		ct = "text/plain; charset=utf-8"
	}
	w.Header().Set("content-type", ct)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// sidebarCache is the live-sidebar cache entry: the tree fingerprint it was built
// from, the assembled sidebar, and (when the index generated cleanly) the
// serialized context index served live for the classification chip.
type sidebarCache struct {
	key       string
	body      string
	indexJSON string
	hasIndex  bool
}

// statusWriter records the status code written so the access log can report it.
type statusWriter struct {
	http.ResponseWriter
	code int
}

func (w *statusWriter) WriteHeader(code int) {
	w.code = code
	w.ResponseWriter.WriteHeader(code)
}

// newHandler builds the virtual-mount handler: viewer chrome
// (rootPath/.leji/viewer/) at "/", the layer's markdown (rootPath/) under
// "/content/". The internal .leji path is reachable only through these mounts.
// The generated sidebar and the stored context index are served live from the
// tree (fingerprint-cached), so a long-running viewer never shows a deleted or
// moved document. logf, when set, receives one terse access-log line per request.
func newHandler(rootAbs, base, contentAbs, viewerAbs string, logf func(string)) http.Handler {
	// Live-sidebar cache, invalidated by a tree fingerprint: one stat pass over
	// leji.json + every markdown file under the content root (paths, mtimes,
	// sizes — no content reads). The common unchanged-tree reload serves the
	// cached string at stat cost; any create, delete, or edit still lands on the
	// very next fetch. WalkTree skips dotdirs, so the viewer's own artifacts
	// never invalidate the cache.
	var mu sync.Mutex
	var cache *sidebarCache
	treeFingerprint := func() string {
		var parts []string
		add := func(rel string) {
			st, err := os.Stat(filepath.Join(rootAbs, rel))
			if err != nil {
				parts = append(parts, rel+"\x00gone")
				return
			}
			parts = append(parts, fmt.Sprintf("%s\x00%d\x00%d", rel, st.ModTime().UnixNano(), st.Size()))
		}
		add("leji.json")
		walkBase := base
		if walkBase == "" {
			walkBase = "."
		}
		for _, rel := range fsx.WalkTree(rootAbs, walkBase) {
			add(rel)
		}
		return strings.Join(parts, "\n")
	}
	// refresh rebuilds the cache for key from the live tree; returns nil when the
	// manifest is missing or the tree will not index cleanly (callers then fall
	// back to the generated artifact).
	refresh := func(key string) *sidebarCache {
		load := manifest.LoadManifest(rootAbs)
		if load.Manifest == nil {
			return nil
		}
		idx := indexgen.GenerateIndex(rootAbs, load.Manifest)
		for _, f := range idx.Findings {
			if f.Severity == findings.Error {
				return nil
			}
		}
		var entries []indexgen.IndexEntry
		if idx.Index != nil {
			entries = idx.Index.Entries
		}
		var discard []findings.Finding
		c := &sidebarCache{key: key, body: assembleSidebar(rootAbs, load.Manifest, entries, &discard)}
		if idx.Index != nil {
			c.indexJSON = indexgen.SerializeIndex(idx.Index)
			c.hasIndex = true
		}
		cache = c
		return c
	}
	serveText := func(w http.ResponseWriter, contentType, body string) {
		w.Header().Set("content-type", contentType)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(body))
	}
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Policy headers ride every response, not just the SPA shell: a document
		// served straight out of /content/ is same-origin and would otherwise run
		// with no policy at all. Set before any write; the content mount downgrades
		// to the inert policy once the route is known.
		w.Header().Set("x-content-type-options", "nosniff")
		w.Header().Set("content-security-policy", cspChrome)
		// Loopback binding alone does not stop DNS rebinding: a hostile page whose
		// name resolves to 127.0.0.1 reaches this server with its own Host. Only the
		// loopback names the viewer is actually addressed by are answered. The port is
		// deliberately not part of the test: a rebound request carries the right port
		// anyway, so matching it adds nothing. Don't "fix" this by checking it.
		if !loopbackHost(r.Host) {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte("forbidden"))
			return
		}
		// A malformed percent-encoding leaves RawPath set but Path empty/wrong;
		// detect a decode error and answer 400 rather than crash.
		urlPath, err := decodePath(r.URL)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte("bad request"))
			return
		}
		rel := urlPathToRel(urlPath)
		if rel == "content" || strings.HasPrefix(rel, "content/") {
			w.Header().Set("content-security-policy", cspContent)
		}
		// Refuse any dotfile or VCS-internal segment in the request path: the .leji
		// viewer dir is reached only through the mounts below.
		for _, seg := range strings.Split(rel, "/") {
			if seg == ".git" || (strings.HasPrefix(seg, ".") && seg != "." && seg != "") {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte("not found"))
				return
			}
		}
		// The generated sidebar lives in the viewer dir but is served as if at the
		// content root, so Docsify's basePath /content/ + _sidebar alias resolve it.
		// Docsify fetches it once per page load, so it is rebuilt from the live tree
		// on every request: a long-running server never shows a deleted or moved
		// document. When the tree is mid-edit and will not index cleanly, fall back
		// to the last generated artifact rather than failing the dashboard.
		if rel == "content/_sidebar.md" {
			mu.Lock()
			key := treeFingerprint()
			c := cache
			if c == nil || c.key != key {
				c = refresh(key)
			}
			mu.Unlock()
			if c != nil {
				serveText(w, "text/markdown; charset=utf-8", c.body)
				return
			}
			serveFrom(w, viewerAbs, "_sidebar.md", false)
			return
		}
		// The stored context index is served live (same fingerprint cache as the
		// sidebar), so per-page classification badges never disagree with the tree.
		if strings.HasPrefix(rel, "content/") {
			load := manifest.LoadManifest(rootAbs)
			if load.Manifest != nil {
				if idxRel, ok := relativeToRoot(manifest.EffectiveIndexPath(load.Manifest), load.Manifest.RootPath); ok && rel == "content/"+idxRel {
					mu.Lock()
					key := treeFingerprint()
					c := cache
					if c == nil || c.key != key {
						c = refresh(key)
					}
					mu.Unlock()
					if c != nil && c.key == key && c.hasIndex {
						serveText(w, "application/json; charset=utf-8", c.indexJSON)
						return
					}
				}
			}
		}
		// The generated Manifest page lives in the viewer dir (gitignored chrome) but
		// is linked from the sidebar and fetched under the content root, like
		// _sidebar.md. Reserved underscore name; served from the last generation.
		if rel == "content/_manifest.md" {
			serveFrom(w, viewerAbs, "_manifest.md", false)
			return
		}
		if rel == "content" || strings.HasPrefix(rel, "content/") {
			sub := ""
			if rel != "content" {
				sub = rel[len("content/"):]
			}
			// An agent profile that declares `inherits` is served resolved: the file
			// on disk is one half, and presenting it as the effective profile is the
			// thing a consumer must not do. So this branch fails closed. If anything
			// at all goes wrong, a file that declares `inherits` still gets a findings
			// page; only a file that is not half a profile falls through to disk.
			if strings.HasSuffix(sub, ".md") {
				repoRel := sub
				if base != "" && base != "." {
					repoRel = base + "/" + sub
				}
				page, served := "", false
				load := manifest.LoadManifest(rootAbs)
				if load.Manifest != nil {
					page, served = ResolvedProfilePage(rootAbs, load.Manifest, repoRel)
				} else if declaresInherits(rootAbs, repoRel) {
					page = unresolvedProfilePage(repoRel, []findings.Finding{
						findings.New("artifact-parse", findings.Error, "the layer manifest could not be read", "leji.json"),
					})
					served = true
				}
				if served {
					serveText(w, "text/markdown; charset=utf-8", page)
					return
				}
			}
			serveFrom(w, contentAbs, sub, true)
			return
		}
		// Everything else (`/`, /index.html, /assets/*) is viewer chrome.
		serveFrom(w, viewerAbs, rel, false)
	})
	if logf == nil {
		return inner
	}
	// Access log: one terse line per request, after the status is known.
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sw := &statusWriter{ResponseWriter: w, code: http.StatusOK}
		inner.ServeHTTP(sw, r)
		logf(r.Method + " " + r.URL.RequestURI() + " " + strconv.Itoa(sw.code))
	})
}

// decodePath returns the percent-decoded request path, or an error when the
// encoding is malformed (mirrors Node's decodeURIComponent throwing -> 400).
func decodePath(u *url.URL) (string, error) {
	if u.RawPath != "" {
		return url.PathUnescape(u.RawPath)
	}
	return u.Path, nil
}

// resolveRoot resolves symlinks in root, falling back to its absolute path.
func resolveRoot(root string) string {
	rootAbs, err := filepath.EvalSymlinks(root)
	if err != nil {
		rootAbs, _ = filepath.Abs(root)
	}
	return rootAbs
}

// urlPathToRel turns a request URL path into a clean relative route key.
// Separators fold to "/" and the path is cleaned against a root, so one request
// has one route key on any platform — filepath.Clean follows the host and
// answered differently on Windows, missing every "content/" route test.
// Canonicalization only; serveFrom enforces containment.
func urlPathToRel(urlPath string) string {
	return strings.TrimLeft(path.Clean("/"+strings.ReplaceAll(urlPath, "\\", "/")), "/")
}

// Serve serves the viewer at the web root on 127.0.0.1, returning the listener and
// http.Server. Port 0 picks a free port. rootRel is the context root (e.g. "docs");
// the viewer is served at "/" and content docs under "/content/". logf, when set,
// receives one access-log line per request.
func Serve(root string, port int, rootRel string, logf func(string)) (net.Listener, *http.Server, error) {
	rootAbs := resolveRoot(root)
	base := fsx.StripSlash(rootRel)
	contentAbs := rootAbs
	if base != "" && base != "." {
		contentAbs = filepath.Join(rootAbs, base)
	}
	// A direct SDK caller could pass an escaping rootRel (e.g. ".."); refuse to mount
	// content outside the layer root.
	if !fsx.ResolvesUnder(rootAbs, contentAbs) {
		return nil, nil, fmt.Errorf("viewer root %q escapes the layer root", rootRel)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		return nil, nil, err
	}
	viewerAbs := filepath.Join(contentAbs, ".leji", "viewer")
	srv := &http.Server{Handler: newHandler(rootAbs, base, contentAbs, viewerAbs, logf)}
	return ln, srv, nil
}

// OpenBrowser best-effort opens url in the default browser. Never blocks or fails
// the caller: a missing opener is a silent no-op.
func OpenBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	// Start (don't Wait): spawn detached and ignore any error.
	_ = cmd.Start()
}
