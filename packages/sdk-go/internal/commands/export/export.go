// Package export is `leji export` (and `leji viewer build`, its co-equal name for
// the same operation): the static export pipeline, in its own package so its
// transitive import set can be checked. Nothing here — and nothing it imports —
// pulls in `net`, `net/http`, `net/url` or any other network package; the local
// preview server keeps all of that in `commands/serve`. The only subprocess the
// pipeline reaches is `git`, through the mount status the manifest page renders,
// with lazy fetch disabled. A `go list -deps` test pins the first claim.
package export

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/viewer"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/layout"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
	"github.com/leji-org/leji/packages/sdk-go/internal/renderlint"
)

// ProtectWarning is the protect-your-context warning surfaced by `leji export`
// (stdout and a comment in the exported index.html).
const ProtectWarning = "This is your context layer (identity, invariants, decisions, sometimes sensitive internal knowledge). Host the exported folder behind internal authentication, not a public or shared bucket where it could be indexed or leaked. Active file types (.htm, .html, .js, .mjs, .xhtml) are left out of the exported content: a static host would serve them as same-origin documents that execute with no policy."

// exportMarker is the first bytes an export writes into its index.html, under
// either of the command's names. A target directory carrying this marker is a
// previous export and may be cleared; any other non-empty directory is somebody's
// content and is never removed. The marker is a byte contract shared with the Node
// and Python SDKs, so it reads as it has always read: an export written by any of
// the three, under either name, is clearable by any of the three.
const exportMarker = "<!--\n  Leji viewer (leji viewer build).\n"

// StrictLintRules are the lint-class rules `--strict` promotes to a failed run. The
// gate is rule-scoped rather than "any finding": ordinary viewer warnings (an
// unresolved `viewer.homepage`, say) stay warnings under `--strict`, and error
// findings fail the run with or without it. The rendering lint's `render-unsupported`
// is the class the flag exists for; a later lint rule joins it here.
var StrictLintRules = map[string]bool{renderlint.RenderUnsupportedRule: true}

// clearableExport reports whether the export may clear dir: it is absent, an empty
// directory, or a previous export. Anything else (a file, a populated directory the
// exporter did not write) is content the tool must not delete.
//
// The marker decides a recursive delete, so it is read through the verified read: the
// bytes that authorize clearing the tree come from the descriptor the rule cleared,
// never from a pathname that a planted index.html link could point elsewhere. A
// marker file that cannot be verified is simply not a previous export, while an
// operational read failure on an allowed path is the filesystem failing rather than
// the boundary refusing: it travels out as an error, exactly as the reference lets it
// throw, rather than authorizing or denying a recursive delete on a guess.
func clearableExport(rootAbs, dir string) (bool, error) {
	info, err := os.Stat(dir)
	if err != nil {
		return true, nil // absent
	}
	if !info.IsDir() {
		return false, nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false, nil
	}
	if len(entries) == 0 {
		return true, nil
	}
	marker, err := fsx.VerifiedTargetRead(rootAbs, filepath.Join(dir, "index.html"), layout.DistRel)
	if err != nil {
		return false, err
	}
	if marker.Status != fsx.ReadRegular {
		return false, nil
	}
	return strings.HasPrefix(string(marker.Bytes), exportMarker), nil
}

// BuildResult is the result of BuildViewer: the relative output dir, the findings
// the run reports, and whether the tree was written. Wrote is false when a pre-write
// check stopped the run (an error finding, or a lint finding under `--strict`), in
// which case a pre-existing target is byte-untouched. A refusal never returns: it is
// an error.
type BuildResult struct {
	Out      string
	Findings []findings.Finding
	Wrote    bool
}

// Options is how one export run is driven. Strict is the gate: a lint finding fails
// the run before the target is cleared, mirroring `status --strict`.
type Options struct {
	Strict bool
}

// carriedItem is one entry the content walk enumerated: a rootPath-relative POSIX
// path, and whether it is a directory.
type carriedItem struct {
	rel string
	dir bool
}

// testHookAfterEnumerate, when set by a test in this package, runs once the content
// walk has enumerated the carried set and before any of it is used. It exists for
// the one canary that cannot be planted statically: an ancestor directory swapped to
// a symlink in exactly that window, which is what binds each source's check to the
// descriptor its bytes come from. Nil in every shipped path.
var testHookAfterEnumerate func()

// BuildViewer exports a self-contained static viewer into outRel with the same URL
// contract the local server serves (chrome at the web root, layer markdown under
// /content/), so any static host serves it as-is. The pipeline is fixed: regenerate
// the chrome (server flavor, always), run the pre-write checks, and only on a clean
// result clear and write the target — so a failing check leaves a pre-existing export
// byte-untouched. The exported index.html carries the protect-your-context warning as
// a comment.
func BuildViewer(root string, m *manifest.Manifest, outRel string, opts Options) (BuildResult, error) {
	gen, err := viewer.GenerateViewer(root, m)
	if err != nil {
		return BuildResult{}, err
	}
	// Every path below is resolved, root included, so the path a check judges is the
	// path the write lands on: a symlinked component — or a case-variant spelling of a
	// reserved role on a case-insensitive filesystem — resolves to its real name here,
	// before the reservation and containment rules are applied to it.
	abs, err := filepath.Abs(root)
	if err != nil {
		return BuildResult{}, err
	}
	rootAbs := abs
	if resolved, ok := fsx.ResolvedPath(abs); ok {
		rootAbs = resolved
	}
	rootDir := fsx.StripSlash(m.RootPath)
	if rootDir == "" {
		rootDir = "."
	}
	contentAbs := rootAbs
	if rootDir != "." {
		contentAbs = filepath.Join(rootAbs, rootDir)
	}
	distAbs := layout.Abs(rootAbs, layout.DistRel)
	var requestedOut string
	switch {
	case outRel == "":
		requestedOut = distAbs
	case filepath.IsAbs(outRel):
		requestedOut = filepath.Clean(outRel)
	default:
		requestedOut = filepath.Join(rootAbs, outRel)
	}
	ref := outRel
	if ref == "" {
		ref = layout.DistRel
	}
	// The ORIGINAL entry is judged before resolution, because a dangling symlink is a
	// standing entry and never an absence: resolved first, `.leji/dist -> missing` hands
	// every check below the link's MISSING destination, which reads as an unoccupied
	// target the export then clears and creates — a write through the link. An lstat or
	// stat that fails for any other reason (permission, I/O, a symlink loop) is not an
	// absence either; that path is refused by the resolution check just below.
	if st, lerr := os.Lstat(requestedOut); lerr == nil && st.Mode()&os.ModeSymlink != 0 {
		if _, serr := os.Stat(requestedOut); serr != nil && os.IsNotExist(serr) {
			return BuildResult{}, errors.New(`refusing to build the viewer into "` + ref +
				`": it is a dangling symlink; remove the symlink or pass --out`)
		}
	}
	// Check-before-act: resolve the output target with the native resolver BEFORE judging or writing
	// it. An unresolvable path (permission/I/O error, not mere absence) fails the check
	// rather than being rebuilt lexically and written to.
	outAbs, resolvable := fsx.ResolvedPathUnder(rootAbs, requestedOut)
	if !resolvable {
		return BuildResult{}, errors.New(`refusing to build the viewer into "` + ref +
			`": the output path cannot be resolved (permission or I/O error)`)
	}
	outDisplay, err := filepath.Rel(rootAbs, outAbs)
	if err != nil {
		return BuildResult{}, err
	}
	displayRef := ref
	if outRel == "" {
		displayRef = outDisplay
	}

	// Never run the destructive export when generation failed (e.g. a symlinked
	// rootPath escaping the layer): the removal below could delete an escaped path.
	if findings.HasErrors(gen.Findings) {
		return BuildResult{Out: outDisplay, Findings: gen.Findings}, nil
	}
	// Check-before-act: the output target is validated against the write rule
	// BEFORE any clean or write, UNCONDITIONALLY — the default `.leji/dist` and a
	// caller `--out` alike, with no empty-outRel fast path around it. It must resolve
	// INSIDE the repository (a `.leji/dist` symlinked out of the tree is refused, not
	// followed: the export folder is yours to copy wherever your host reads it from),
	// and either to its own role (`.leji/dist/`) or clear of `.leji/` altogether; a
	// DIFFERENT private role (`mounts`, `work`, `viewer`, a future one) is refused.
	// Resolved-vs-resolved, so neither a redirecting symlink nor a `.LEJI/` spelling
	// reaches a private role by looking like something else.
	sep := string(filepath.Separator)
	if outVerdict := layout.WritableTarget(rootAbs, outAbs, layout.DistRel); !outVerdict.OK {
		if outVerdict.OutsideRoot {
			return BuildResult{}, errors.New(`refusing to build the viewer into "` + ref +
				`": it resolves outside the repository; every write stays inside the repository root, ` +
				`so copy the exported folder to your host instead`)
		}
		return BuildResult{}, errors.New(`refusing to build the viewer into "` + ref + `": it resolves into ` +
			layout.LejiDir + "/" + outVerdict.Role +
			` (private), reserved for the tool's own roles; remove the symlink or pass --out`)
	}
	// The role reservation is EXACT for a caller-supplied `--out`: `.leji/dist` is the
	// one reserved name it may resolve to, never a path underneath it. (The check-before-act check
	// above allows a target anywhere inside its own role, which is what a generation
	// target needs; an export target is the single directory the role names.)
	if outRel != "" && strings.HasPrefix(outAbs, distAbs+sep) {
		return BuildResult{}, errors.New(`refusing to build the viewer into "` + outRel + `": ` +
			layout.DistRel + ` is the reserved export target itself, never a path inside it`)
	}
	// These collision checks measure a caller-supplied `--out` only: the default
	// `.leji/dist` is answered by the role reservation above, and repository containment
	// is answered for both by the write rule. A `--out` must additionally stay clear of
	// the context root in BOTH directions, so an export never deletes governed content
	// or the layer that contains it, and it says so as a usage error before work starts.
	collides := strings.HasPrefix(outAbs, contentAbs+sep) || strings.HasPrefix(contentAbs, outAbs+sep)
	if outRel != "" && (outAbs == rootAbs || outAbs == contentAbs || !fsx.ResolvedWithinRoot(rootAbs, outAbs) || collides) {
		return BuildResult{}, errors.New(`refusing to build the viewer into "` + outRel + `": --out must be a path inside the repository, and must not be the repository root, the context root, inside the context root, or a directory containing the context root`)
	}
	// Never remove a directory this command did not write: the export clears a previous
	// export, and refuses anything else that is already occupied.
	clearable, cerr := clearableExport(rootAbs, outAbs)
	if cerr != nil {
		return BuildResult{}, cerr
	}
	if !clearable {
		return BuildResult{}, errors.New(`refusing to build the viewer into "` + displayRef + `": the target exists and is neither empty nor a previous viewer export; remove it or pick another --out`)
	}
	// The export reads the chrome by name; each file is realpath-checked against the
	// servable whitelist in copyChrome below, and the generation pass above already
	// refused a `.leji/viewer/` that does not resolve inside its own role — so the two
	// vectors a separate identity check guarded are closed at their operations.
	viewerAbs := layout.Abs(rootAbs, layout.ViewerRel)
	outContent := filepath.Join(outAbs, "content")

	// Every destination act below goes through the write chokepoint with the export's
	// own role, one resolved check per act rather than one verdict inherited by a whole
	// tree: a descendant of the output directory swapped to a symlink after the target
	// was judged is caught at the file it would have redirected. A refusal is a hard
	// stop mid-run, since it can only mean the tree moved under the export.
	refusedDest := func(destAbs string, verdict layout.TargetVerdict) error {
		var why string
		switch {
		case verdict.Unresolvable:
			why = "cannot be resolved (permission or I/O error)"
		case verdict.OutsideRoot:
			why = "resolves outside the repository"
		default:
			why = "resolves into " + layout.LejiDir + "/" + verdict.Role + " (private)"
		}
		rel, relErr := filepath.Rel(rootAbs, destAbs)
		if relErr != nil {
			rel = destAbs
		}
		return errors.New(`refusing to write "` + rel + `": it ` + why + `; the export is incomplete`)
	}
	mkdirDest := func(destAbs string) error {
		verdict, _, err := fsx.MkdirpGuarded(rootAbs, destAbs, layout.DistRel)
		if err != nil {
			return err
		}
		if !verdict.OK {
			return refusedDest(destAbs, verdict)
		}
		return nil
	}
	writeDest := func(destAbs string, bytes []byte) error {
		verdict, err := fsx.WriteFileGuarded(rootAbs, destAbs, layout.DistRel, bytes, fsx.WriteOptions{})
		if err != nil {
			return err
		}
		if !verdict.OK {
			return refusedDest(destAbs, verdict)
		}
		return nil
	}

	// Check-before-act level-2 (boundary skip): a real, otherwise-servable read source withheld
	// because its RESOLVED path lands in a private role says why exactly once — on
	// stderr, never on stdout, never in the `--json` object — so the boundary answers
	// the "why isn't my doc showing?" question instead of dropping silently. A routine
	// dot-entry or ordinary symlink stays silent (a clean build has dozens of those);
	// this speaks only when the whitelist actually withheld something servable-looking.
	boundarySkipped := map[string]bool{}
	boundarySkip := func(childRel, real string) {
		if boundarySkipped[childRel] {
			return
		}
		boundarySkipped[childRel] = true
		fmt.Fprintf(os.Stderr, "skipped %s: resolves into %s/%s (private); not served or exported\n",
			childRel, layout.LejiDir, layout.LejiRole(rootAbs, real))
	}
	// Enumerate the content root — every file and directory /content will carry —
	// skipping ALL dotfiles/dot-dirs and symlinks: an export is a self-contained
	// snapshot, and a symlink or dot-path (.git, .secret.md) must never leak into it.
	// Explicit walk, not a blanket tree copy, so the default output dir under the
	// content root isn't copied into itself. Enumerating BEFORE the clean below is what
	// lets the rendering lint read exactly the set the export will carry while the
	// target is still untouched; the copy then replays this list.
	var carried []carriedItem
	var walkContent func(rel string) error
	walkContent = func(rel string) error {
		srcDir := contentAbs
		if rel != "" {
			srcDir = filepath.Join(contentAbs, filepath.FromSlash(rel))
		}
		entries, err := os.ReadDir(srcDir)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			name := entry.Name()
			if strings.HasPrefix(name, ".") {
				continue
			}
			childRel := name
			if rel != "" {
				childRel = rel + "/" + name
			}
			childAbs := filepath.Join(contentAbs, filepath.FromSlash(childRel))
			// A symlink is never exported (snapshot semantics). An ordinary one is a
			// routine, silent exclusion; one resolving into a private role is a boundary
			// skip — a servable-looking source withheld, named once on stderr.
			if entry.Type()&os.ModeSymlink != 0 {
				if real, ok := fsx.ResolvedPathUnder(rootAbs, childAbs); ok && !layout.ServablePath(rootAbs, real) {
					boundarySkip(childRel, real)
				}
				continue
			}
			// Second line of defense behind the --out containment above: the export never
			// walks into itself, whatever the output path turns out to be.
			if childAbs == outAbs {
				continue
			}
			// The servable-roots whitelist, mirrored on the export side: the only
			// `.leji/` content an export may read is `viewer/`, and it reads that by name
			// below. Independent of the dot-skip above, which also covers it; a withheld
			// servable-looking source is named once, exactly as a boundary skip.
			if !layout.ServablePath(rootAbs, childAbs) {
				if real, ok := fsx.ResolvedPathUnder(rootAbs, childAbs); ok && !layout.ServablePath(rootAbs, real) {
					boundarySkip(childRel, real)
				}
				continue
			}
			if entry.IsDir() {
				carried = append(carried, carriedItem{rel: childRel, dir: true})
				if err := walkContent(childRel); err != nil {
					return err
				}
				continue
			}
			if !entry.Type().IsRegular() {
				continue
			}
			// Active types never ride along: the export is meant to be hosted, and a
			// static host would serve them as same-origin documents with no policy.
			if viewer.ActiveExtensions[strings.ToLower(path.Ext(name))] {
				continue
			}
			carried = append(carried, carriedItem{rel: childRel, dir: false})
		}
		return nil
	}
	if err := walkContent(""); err != nil {
		return BuildResult{}, err
	}
	if testHookAfterEnumerate != nil {
		testHookAfterEnumerate()
	}

	// A carried source is BOUND to its bytes at the moment it is used, not trusted from
	// the walk: between enumeration and use, the file — or any directory above it — can
	// become a symlink, and a read or copy by path then follows it past every check the
	// walk made. So each source is resolved natively, the RESOLVED path is judged
	// against the content root and the servable whitelist, and its bytes come from the
	// descriptor fstat proved a regular file: check and use hold the same inode. A
	// source that fails is dropped from the export with the same check-before-act semantics the walk
	// applies — silent for an ordinary redirect or a vanished file, named once on stderr
	// when it resolves into a private role.
	contentReal := contentAbs
	if resolved, ok := fsx.ResolvedPath(contentAbs); ok {
		contentReal = resolved
	}
	carriedSource := func(real string) bool {
		return layout.ServablePath(rootAbs, real) &&
			(real == contentReal || strings.HasPrefix(real, contentReal+sep))
	}
	openCarried := func(childRel string) (*os.File, error) {
		src, err := fsx.OpenVerifiedSource(filepath.Join(contentAbs, filepath.FromSlash(childRel)), carriedSource)
		if err != nil {
			return nil, err
		}
		if src.File == nil && src.Resolved && !layout.ServablePath(rootAbs, src.Real) {
			boundarySkip(childRel, src.Real)
		}
		return src.File, nil
	}

	// The rendering lint (`adoption/rendering.md`): every markdown document the export
	// will carry under content/, governed and reference alike, since anything served
	// can diverge across renderers. It reads the layer's own files — the author's bytes
	// at the author's line numbers, which is what a finding must point at — never the
	// generated chrome pages, which no one edits and every run rewrites. Each document
	// is read EXACTLY ONCE, and the bytes read are the bytes exported below: the lint's
	// verdict and the exported file are then the same document, with no window in which
	// one is judged and the other written. Only markdown is held (the set the lint
	// reads); every other file streams straight through the copy.
	var lint []findings.Finding
	linted := map[string][]byte{}
	for _, item := range carried {
		if item.dir || strings.ToLower(path.Ext(item.rel)) != ".md" {
			continue
		}
		f, err := openCarried(item.rel)
		if err != nil {
			return BuildResult{}, err
		}
		if f == nil {
			continue
		}
		bytes, rerr := io.ReadAll(f)
		_ = f.Close()
		if rerr != nil {
			return BuildResult{}, rerr
		}
		linted[item.rel] = bytes
		repoRel := item.rel
		if rootDir != "." {
			repoRel = rootDir + "/" + item.rel
		}
		lint = append(lint, renderlint.Findings(repoRel, string(bytes))...)
	}
	// Canonical order for the whole result: (path, line, rule, construct). The walk is
	// directory order, so the sort is what makes two runs — and three SDKs — report the
	// same sequence.
	all := findings.Sort(append(append([]findings.Finding{}, gen.Findings...), lint...))

	// The `--strict` gate, and the last thing before the first byte moves: the refusals
	// above are about the destination (exit 2, whatever the flags say), while strict is
	// about the layer — a lint finding fails the run, and because the gate sits ahead of
	// the clean below, a pre-existing export is left exactly as it was. The pipeline is
	// regenerate -> check -> clear-and-write, in that order, so the promise holds for
	// every check that lands in it later.
	if opts.Strict {
		for _, f := range all {
			if StrictLintRules[f.Rule] {
				return BuildResult{Out: outDisplay, Findings: all}, nil
			}
		}
	}

	// Clean rebuild so a removed source file never lingers in the export.
	cleared, err := fsx.RmGuarded(rootAbs, outAbs, layout.DistRel)
	if err != nil {
		return BuildResult{}, err
	}
	if !cleared.OK {
		return BuildResult{}, refusedDest(outAbs, cleared)
	}
	if err := mkdirDest(outContent); err != nil {
		return BuildResult{}, err
	}
	for _, item := range carried {
		dest := filepath.Join(outContent, filepath.FromSlash(item.rel))
		if item.dir {
			if err := mkdirDest(dest); err != nil {
				return BuildResult{}, err
			}
			continue
		}
		// Markdown was read once already: the exported file is that snapshot, so what
		// the lint judged is what the export carries. A document the re-check dropped
		// has no snapshot and is not exported.
		if strings.ToLower(path.Ext(item.rel)) == ".md" {
			if bytes, ok := linted[item.rel]; ok {
				if err := writeDest(dest, bytes); err != nil {
					return BuildResult{}, err
				}
			}
			continue
		}
		f, err := openCarried(item.rel)
		if err != nil {
			return BuildResult{}, err
		}
		if f == nil {
			continue
		}
		cerr := copyFromDescriptor(rootAbs, f, dest, refusedDest)
		_ = f.Close()
		if cerr != nil {
			return BuildResult{}, cerr
		}
	}
	// An inheriting agent profile exports resolved, exactly as the local server renders
	// it: the copied file is only its own half of the profile.
	for _, rp := range viewer.ResolvedProfilePages(rootAbs, m) {
		target := filepath.Join(outContent, filepath.FromSlash(rp.Rel))
		if !fsx.ResolvedWithinRoot(outContent, target) {
			continue
		}
		if err := writeDest(target, []byte(rp.Page)); err != nil {
			return BuildResult{}, err
		}
	}
	// One generated chrome file into the export. A symlink is not a generated file:
	// lstat refuses it without following it, and the bytes come from the same guarded
	// open the content copy uses — the resolved path judged by the whitelist, the
	// descriptor proved to be that file — so nothing planted inside the chrome tree can
	// pull a private role's bytes along, and no copy reopens a checked path.
	copyChrome := func(srcAbs, destAbs string) error {
		refuse := func() error {
			rel, relErr := filepath.Rel(rootAbs, srcAbs)
			if relErr != nil {
				rel = srcAbs
			}
			return errors.New(`refusing to export "` + fsx.ToPosix(rel) +
				`": the export carries only generated files from ` + layout.ViewerRel + "/")
		}
		st, lerr := os.Lstat(srcAbs)
		if lerr != nil || !st.Mode().IsRegular() {
			return refuse()
		}
		src, err := fsx.OpenVerifiedSource(srcAbs, func(real string) bool { return layout.ServablePath(rootAbs, real) })
		if err != nil {
			return err
		}
		if src.File == nil {
			return refuse()
		}
		cerr := copyFromDescriptor(rootAbs, src.File, destAbs, refusedDest)
		_ = src.File.Close()
		return cerr
	}
	// The chrome asset tree, entry by entry rather than a blanket tree copy: dot-entries
	// and symlinks are skipped exactly as the content walk skips them.
	var copyChromeTree func(srcAbs, destAbs string) error
	copyChromeTree = func(srcAbs, destAbs string) error {
		if err := mkdirDest(destAbs); err != nil {
			return err
		}
		entries, err := os.ReadDir(srcAbs)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".") || entry.Type()&os.ModeSymlink != 0 {
				continue
			}
			childSrc := filepath.Join(srcAbs, entry.Name())
			childDest := filepath.Join(destAbs, entry.Name())
			if entry.IsDir() {
				if err := copyChromeTree(childSrc, childDest); err != nil {
					return err
				}
			} else if entry.Type().IsRegular() {
				if err := copyChrome(childSrc, childDest); err != nil {
					return err
				}
			}
		}
		return nil
	}
	// The generated sidebar and Manifest page are served as if at the content root.
	if err := copyChrome(filepath.Join(viewerAbs, "_sidebar.md"), filepath.Join(outContent, "_sidebar.md")); err != nil {
		return BuildResult{}, err
	}
	if err := copyChrome(filepath.Join(viewerAbs, "_manifest.md"), filepath.Join(outContent, "_manifest.md")); err != nil {
		return BuildResult{}, err
	}
	// The viewer assets at the web root.
	if err := copyChromeTree(filepath.Join(viewerAbs, "assets"), filepath.Join(outAbs, "assets")); err != nil {
		return BuildResult{}, err
	}
	// index.html at the web root, with the protect-your-context warning prepended. The
	// export flavor is GENERATED here, by the same code path that wrote the served one,
	// with the base that lets the tree host under a subpath: the servable area never
	// holds export-flavored bytes, and no emitted HTML is rewritten after the fact. Its
	// resolution warnings were reported by the generation run above, so this pass
	// discards them.
	var discard []findings.Finding
	indexHTML, err := viewer.BuildIndexHTML(root, m, viewer.ExportBase, &discard)
	if err != nil {
		return BuildResult{}, err
	}
	prepended := "<!--\n  Leji viewer (leji viewer build).\n  " + ProtectWarning + "\n-->\n" + indexHTML
	if err := writeDest(filepath.Join(outAbs, "index.html"), []byte(prepended)); err != nil {
		return BuildResult{}, err
	}

	return BuildResult{Out: outDisplay, Findings: all, Wrote: true}, nil
}

// copyFromDescriptor streams a source's bytes from the descriptor a check already
// judged, rather than reopening its path: only the linted markdown is held in
// memory, and the bytes still come from the checked inode. The destination is judged
// and opened by the chokepoint, so the copy can never reopen — or redirect to — a
// path. io.Copy writes each chunk to completion, so a short write on an unusual
// destination cannot truncate the file (the reference implementation loops its
// writeSync for the same reason).
func copyFromDescriptor(rootAbs string, f *os.File, dest string, refused func(string, layout.TargetVerdict) error) error {
	info, err := f.Stat()
	if err != nil {
		return err
	}
	opened, err := fsx.OpenWriteGuarded(rootAbs, dest, layout.DistRel, info.Mode().Perm())
	if err != nil {
		return err
	}
	if opened.File == nil {
		return refused(dest, opened.Verdict)
	}
	if _, err := io.Copy(opened.File, f); err != nil {
		_ = opened.File.Close()
		return err
	}
	return opened.File.Close()
}
