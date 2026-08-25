// Package fsx holds filesystem helpers; all returned repo-relative paths are
// POSIX (forward-slash), matching the Node and Python SDKs.
package fsx

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"

	"github.com/leji-org/leji/packages/sdk-go/internal/layout"
)

func ToPosix(p string) string {
	return filepath.ToSlash(p)
}

// GuardRoot is the repository root as every guard judges it: absolute and
// realpath-resolved, falling back to the absolute spelling when it cannot be
// resolved at all. Both sides of the containment rule must come through the same
// resolver, or a root reached through a symlinked ancestor (/tmp -> /private/tmp)
// compares unequal to its own children and every write under it reads as an escape.
func GuardRoot(root string) string {
	abs, err := filepath.Abs(root)
	if err != nil {
		abs = root
	}
	if resolved, ok := ResolvedPath(abs); ok {
		return resolved
	}
	return abs
}

// isNoEntry reports the errors a FOLLOWING stat treats as "nothing is there", which
// is what the reference's `statSync(path, {throwIfNoEntry: false})` returns undefined
// for: the entry is missing (ENOENT), or the path runs through something that is not
// a directory (ENOTDIR), so there is no entry to have a kind. Anything else — a
// permission denial, a symlink loop, an I/O error — is the filesystem failing and
// travels out. The reference's lstat of the ORIGINAL entry is deliberately NOT this
// lenient (it throws ENOTDIR), and neither is this port: a target path that runs
// through a file is a failure, while a LINK that points through one is a standing
// entry this run cannot verify.
func isNoEntry(err error) bool {
	return os.IsNotExist(err) || errors.Is(err, syscall.ENOTDIR)
}

// under reports whether abs is dir or sits underneath it.
func under(dir, abs string) bool {
	return abs == dir || strings.HasPrefix(abs, dir+string(filepath.Separator))
}

// ResolvedWithinRoot reports whether abs resolves (following symlinks) within
// rootAbs, even when abs does not yet exist: a non-existent target is checked via
// its nearest existing ancestor, so a symlinked ancestor that escapes root is caught
// before a write creates the file under it. It is the ONE within-root primitive, and
// it fails CLOSED — an unresolvable root or target (permission or I/O error, not
// mere absence) is false, never rebuilt from its spelling and allowed.
//
// Both sides come through the same resolver, or a root resolved one way and a child
// the other would differ in spelling alone and read as an escape. Containment is a
// prefix question and re-spelling components cannot move a path out from under its
// prefix, so the first pass compares the paths as the filesystem's symlinks leave
// them; only when that says "outside" — where a case-variant of the ROOT could still
// be hiding a contained path — are both sides read back component by component. The
// content walks run this check per entry, and the reference's native resolver answers
// it without reading a single directory.
func ResolvedWithinRoot(rootAbs, abs string) bool {
	root, err := filepath.Abs(rootAbs)
	if err != nil {
		return false
	}
	linked, err := filepath.EvalSymlinks(root)
	if err != nil {
		return false
	}
	real, ok := resolvedPath(asGiven, abs)
	if !ok {
		return false
	}
	if under(linked, real) {
		return true
	}
	// Not under the root as the caller spelled it. That is where a spelling can still
	// decide the answer — a link into the tree through a case-variant of the root
	// itself — so both sides are canonicalized before the check refuses.
	canonical, err := canonicalCase("", linked)
	if err != nil {
		return false
	}
	real, ok = ResolvedPathUnder(canonical, abs)
	return ok && under(canonical, real)
}

// realName returns the filesystem's own spelling of name inside dir: name itself
// when the directory holds it verbatim, otherwise the entry that differs from it
// only in case. This is what closes case-variant role aliasing, which Node closes
// with `realpathSync.native`: on a case-insensitive volume `.LEJI/mounts` opens the
// very directory `.leji/mounts` names, yet compares unequal to it as a string, so a
// decision made on the spelling is not a decision about the file. filepath.EvalSymlinks
// hands back the spelling it was given, so the canonical name is read from the
// directory itself. A directory that denies enumeration (permission or I/O) makes the
// canonical spelling unknowable, so the error propagates and the whole path is
// unresolvable: a directory can refuse to be listed while still allowing traversal
// and writes through it, and falling back to the caller's spelling would let a
// `.LEJI/` alias be judged as a location outside the roles it actually opens. Mere
// nonexistence is not a failure — that is the not-yet-created target the caller
// rebuilds lexically.
func realName(dir, name string) (string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return name, nil
		}
		return "", err
	}
	folded := ""
	for _, e := range entries {
		if e.Name() == name {
			return name, nil // the volume holds this exact spelling
		}
		if folded == "" && strings.EqualFold(e.Name(), name) {
			folded = e.Name()
		}
	}
	if folded != "" {
		return folded, nil
	}
	return name, nil
}

// canonicalCase rewrites an existing, symlink-free absolute path with each
// component below `base` spelled as the filesystem holds it. `base` is a prefix
// already known to be canonical — the resolved repository root at every check-before-act call
// site — so the walk stays inside the tree the decision is about instead of reading
// every directory from the filesystem root down. An empty base, or a path outside
// it, canonicalizes from the volume root. The error a component's directory raises
// travels out: a spelling that cannot be read back is not a spelling to decide on.
func canonicalCase(base, abs string) (string, error) {
	cur := base
	rest := ""
	switch {
	case base != "" && abs == base:
		return base, nil
	case base != "" && strings.HasPrefix(abs, base+string(filepath.Separator)):
		rest = abs[len(base)+1:]
	default:
		vol := filepath.VolumeName(abs)
		cur = vol + string(filepath.Separator)
		rest = strings.TrimPrefix(abs[len(vol):], string(filepath.Separator))
	}
	if rest == "" {
		return cur, nil
	}
	for _, seg := range strings.Split(rest, string(filepath.Separator)) {
		if seg == "" {
			continue
		}
		real, err := realName(cur, seg)
		if err != nil {
			return "", err
		}
		cur = filepath.Join(cur, real)
	}
	return cur, nil
}

// spelling is how a resolver spells an existing, symlink-free absolute path: the
// filesystem's own casing (Node's `realpathSync.native`, which every decision about
// a `.leji/` ROLE needs), or the path as given, for the one question whose answer
// cannot depend on a component's spelling.
type spelling func(abs string) (string, error)

// canonicalUnder is the case-canonical spelling below a prefix already known to be
// canonical.
func canonicalUnder(base string) spelling {
	return func(abs string) (string, error) { return canonicalCase(base, abs) }
}

// asGiven is the spelling the caller supplied. Containment is a prefix question, and
// re-spelling components below the prefix cannot move a path out from under it, so
// the containment primitive asks for this one — which also means a directory that
// refuses enumeration does not make every path beneath it unresolvable, matching the
// reference, whose native resolver reads no directory to answer.
func asGiven(abs string) (string, error) { return abs, nil }

// nativeRealpath resolves every symlink in abs AND applies spell to the result, the
// two halves of Node's `realpathSync.native`. Either half failing fails the whole
// resolution.
func nativeRealpath(spell spelling, abs string) (string, error) {
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	return spell(resolved)
}

// ResolvedPath is abs with every symlink in it resolved, and with the filesystem's
// own spelling of each existing component — so a case-variant path on a
// case-insensitive filesystem comes back canonical. A path that does not exist yet
// resolves through its nearest existing ancestor, with the remainder re-appended,
// so a caller can judge a write target before anything is created under it. ok is
// false when even the ancestor cannot be resolved.
//
// Judge with this whenever a decision and the write it guards must be about the
// same path: a lexical comparison answers for the spelling, not for the file.
func ResolvedPath(abs string) (string, bool) {
	return ResolvedPathUnder("", abs)
}

// ResolvedPathUnder is ResolvedPath with a prefix already known to be canonical —
// the resolved repository root, which every check-before-act call site holds — so only the
// components below it are read back from the filesystem. Semantics are identical;
// a path that resolves outside base is canonicalized in full.
func ResolvedPathUnder(base, abs string) (string, bool) {
	return resolvedPath(canonicalUnder(base), abs)
}

// resolvedPath is ResolvedPathUnder over one spelling of the resolved components.
func resolvedPath(spell spelling, abs string) (string, bool) {
	// Node's `realpathSync.native` returns an absolute path whatever it is handed, so
	// the TS resolver absolutizes inherently; filepath.EvalSymlinks hands a relative
	// path back relative, and the canonical-case walk would then re-root it at the
	// volume root (`docs/overview.md` → `/docs/overview.md`) — a decision, and the
	// write it guards, about a location nobody named. Absolutize against the working
	// directory on entry so every caller gets the same contract as TS. An already
	// absolute path is left exactly as given (filepath.Abs would also Clean it); when
	// there is no working directory to resolve against, the path names no location
	// that can be judged, so the check fails rather than guessing.
	if !filepath.IsAbs(abs) {
		a, err := filepath.Abs(abs)
		if err != nil {
			return "", false
		}
		abs = a
	}
	real, err := nativeRealpath(spell, abs)
	if err == nil {
		return real, true // path exists (e.g. overwrite target / vendor file)
	}
	// Only genuine nonexistence is rebuilt lexically from the nearest existing
	// ancestor. A permission or I/O error (EACCES, EIO, ELOOP, ENOTDIR, …) means the
	// path exists but cannot be resolved: it FAILS the check rather than being
	// reconstructed as if it were an absent write target — a resolved decision and
	// the write it guards must be about the same real path.
	if !os.IsNotExist(err) {
		return "", false
	}
	// A dangling symlink at the final component: EvalSymlinks cannot follow it to a
	// missing target, but a write WOULD follow it there, so resolve the link's target
	// rather than treating the link's own name as the location — otherwise a symlink
	// into a private role reads as its own path and slips the boundary. (EvalSymlinks
	// already proved the chain has no loop; a loop is refused as unresolvable above.)
	// A missing final component that is not a symlink falls through to the ancestor
	// walk, the normal not-yet-created write target.
	if st, lerr := os.Lstat(abs); lerr == nil && st.Mode()&os.ModeSymlink != 0 {
		return resolvedPath(spell, resolveLink(abs))
	}
	// Walk to the nearest existing ancestor. A dangling symlink in an INTERMEDIATE
	// component is not "absent": a write would follow it, so follow it here too —
	// resolve the link and re-root the remainder onto its target, rather than climbing
	// past it and rebuilding the link's own name lexically. Otherwise a nested
	// `redirect/export` whose `redirect` dangles into a private role reads as
	// `.../redirect/export` (outside `.leji/`) and a target created after the check
	// lands the write inside the role — the check/use race this closes.
	p := filepath.Dir(abs)
	for !Exists(p) && filepath.Dir(p) != p {
		st, lerr := os.Lstat(p)
		if lerr != nil && !os.IsNotExist(lerr) {
			return "", false // p is present but cannot be lstat'd (permission/I/O)
		}
		if lerr == nil && st.Mode()&os.ModeSymlink != 0 {
			rest, rerr := filepath.Rel(p, abs)
			if rerr != nil {
				return "", false
			}
			return resolvedPath(spell, filepath.Join(resolveLink(p), rest))
		}
		p = filepath.Dir(p)
	}
	ancestor, err := nativeRealpath(spell, p)
	if err != nil {
		return "", false
	}
	rest, err := filepath.Rel(p, abs)
	if err != nil {
		return "", false
	}
	return filepath.Join(ancestor, rest), true
}

// resolveLink reads the symlink at abs and returns its target as an absolute path
// (a relative target resolves against the link's own directory).
func resolveLink(abs string) string {
	target, err := os.Readlink(abs)
	if err != nil {
		return abs
	}
	if filepath.IsAbs(target) {
		return filepath.Clean(target)
	}
	return filepath.Join(filepath.Dir(abs), target)
}

// metadataFileVerdict is the ONE declared exception to the role rule, and the only
// place a MetadataFile verdict is constructed: `<root>/.leji/.gitignore`, the ignore
// file the tool keeps for its own tree. It belongs to no role, so
// layout.WritableTarget refuses it and cannot be the judge here: the rule it needs
// is about the REQUESTED entry, which WritableTarget never sees.
//
// ok false means "not this path": every other target falls through to the rule
// unchanged. Otherwise the verdict is allowed on all three conditions, checked on the
// ORIGINAL directory entries so a link is caught rather than followed:
//
//  1. the requested path is exactly `<root>/.leji/.gitignore`, and it resolves to
//     itself (a `.LEJI/` spelling on a case-insensitive filesystem resolves to the
//     name the filesystem holds and is not this path);
//  2. `<root>/.leji` is a real directory, never a symlink;
//  3. the entry is absent or a regular file, never a symlink or anything else.
//
// When a condition fails the exception REFUSES rather than falling back to an
// allowance: today's verdict stands when it already refuses (a `.leji` symlinked out
// of the repository is OutsideRoot, exactly as it is now), and a redirect that
// happens to land on ordinary content is refused as the requested path's own role,
// never written through. The exception can only narrow, never widen.
func metadataFileVerdict(rootAbs, targetAbs, resolved, ownRoleRel string) (layout.TargetVerdict, bool) {
	expected := layout.Abs(rootAbs, layout.LejiIgnoreRel)
	requested, err := filepath.Abs(targetAbs)
	if err != nil || requested != expected {
		return layout.TargetVerdict{}, false
	}
	dir, derr := os.Lstat(layout.Abs(rootAbs, layout.LejiDir))
	entry, eerr := os.Lstat(expected)
	entryAllowed := (eerr != nil && os.IsNotExist(eerr)) || (eerr == nil && entry.Mode().IsRegular())
	if resolved == expected && derr == nil && dir.IsDir() && entryAllowed {
		return layout.TargetVerdict{OK: true, MetadataFile: true}, true
	}
	verdict := layout.WritableTarget(rootAbs, resolved, ownRoleRel)
	if verdict.OK {
		return layout.TargetVerdict{Role: layout.LejiRole(rootAbs, expected)}, true
	}
	return verdict, true
}

// judgeTarget is one judged target: the verdict the rule returned for the resolved
// path, which is layout.WritableTarget's except at the one declared exception above,
// and that resolved path. resolved is "" (and ok false) only when the path could not
// be resolved at all.
func judgeTarget(rootAbs, targetAbs, ownRoleRel string) (verdict layout.TargetVerdict, resolved string, ok bool) {
	real, ok := ResolvedPathUnder(rootAbs, targetAbs)
	if !ok {
		return layout.TargetVerdict{Unresolvable: true}, "", false
	}
	if exception, isException := metadataFileVerdict(rootAbs, targetAbs, real, ownRoleRel); isException {
		return exception, real, true
	}
	return layout.WritableTarget(rootAbs, real, ownRoleRel), real, true
}

// GuardedWrite is the single guarded-write chokepoint (check-before-act).
// Realpath-resolve targetAbs, run layout.WritableTarget on the resolved path, and
// perform the write or clear — through op, on that resolved path — ONLY when the
// target is allowed to land there, which means all of: it resolves at all; it
// resolves INSIDE the repository root, with no exceptions; and it lands outside root
// `.leji/` or inside the one role ownRoleRel names. On refusal nothing is touched:
// the verdict is returned (unresolvable, outside the repository, or the private
// `.leji/` role the target crossed into) so the caller renders the mandated hard
// refusal in its own channel — a generation finding, or a build error — before any
// byte is written.
//
// rootAbs must already be realpath-resolved (GuardRoot). ownRoleRel names the one
// `.leji/` role this write may legitimately land in, or "" when the target has no
// `.leji/` role at all (user content such as overview.md). One home for every write
// whose target derives from user-influenceable input, so a new write site is guarded
// by construction rather than by remembering to guard it — and the guarded
// conveniences below are how command packages reach it, so no command spells a raw
// write primitive of its own.
func GuardedWrite(rootAbs, targetAbs, ownRoleRel string, op func(resolved string) error) (layout.TargetVerdict, error) {
	verdict, resolved, ok := judgeTarget(rootAbs, targetAbs, ownRoleRel)
	if !verdict.OK || !ok {
		return verdict, nil
	}
	return verdict, op(resolved)
}

// WriteOptions tunes WriteFileGuarded. Mode is the mode set at creation (0 means
// the ordinary 0o644 every written file carries); Exclusive creates with O_EXCL, so
// a target that already exists comes back as the Exists verdict rather than being
// overwritten or followed through a planted symlink.
type WriteOptions struct {
	Mode      fs.FileMode
	Exclusive bool
}

// WriteFileGuarded writes bytes to a guarded target, creating its parent directories
// only when the write itself happens (a refused run establishes nothing).
//
// An exclusive create is decided on the ORIGINAL directory entry before anything is
// resolved: ANY standing entry — a regular file, a directory, a symlink whether it
// dangles or not — is Exists. Resolving first would defeat the point, because a
// dangling symlink resolves to its missing destination, and O_EXCL on that
// destination would happily create the file the link points at. Nothing stands there
// ⇒ the resolved path is judged (its parents included) and O_EXCL still closes the
// race between that judgement and the create.
func WriteFileGuarded(rootAbs, targetAbs, ownRoleRel string, bytes []byte, opts WriteOptions) (layout.TargetVerdict, error) {
	if opts.Exclusive {
		if _, err := os.Lstat(targetAbs); err == nil {
			return layout.TargetVerdict{Exists: true}, nil
		} else if !os.IsNotExist(err) {
			return layout.TargetVerdict{}, err
		}
	}
	mode := opts.Mode
	if mode == 0 {
		mode = 0o644
	}
	exists := false
	verdict, err := GuardedWrite(rootAbs, targetAbs, ownRoleRel, func(resolved string) error {
		if err := os.MkdirAll(filepath.Dir(resolved), 0o755); err != nil {
			return err
		}
		if !opts.Exclusive {
			return os.WriteFile(resolved, bytes, mode)
		}
		f, err := os.OpenFile(resolved, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
		if err != nil {
			if os.IsExist(err) {
				exists = true
				return nil
			}
			return err
		}
		if _, werr := f.Write(bytes); werr != nil {
			_ = f.Close()
			return werr
		}
		return f.Close()
	})
	if exists {
		return layout.TargetVerdict{Exists: true}, nil
	}
	return verdict, err
}

// MkdirpGuarded creates a guarded directory and every missing parent, and hands back
// the RESOLVED path it was created at, so every act that follows works from the path
// the rule judged rather than re-joining its own. real is "" when the verdict refuses.
func MkdirpGuarded(rootAbs, targetAbs, ownRoleRel string) (verdict layout.TargetVerdict, real string, err error) {
	verdict, resolved, ok := judgeTarget(rootAbs, targetAbs, ownRoleRel)
	if !verdict.OK || !ok {
		return verdict, "", nil
	}
	if err := os.MkdirAll(resolved, 0o755); err != nil {
		return verdict, "", err
	}
	return verdict, resolved, nil
}

// RmGuarded clears a guarded target: recursive, and absent is success (the
// clean-rebuild form every generator uses).
func RmGuarded(rootAbs, targetAbs, ownRoleRel string) (layout.TargetVerdict, error) {
	return GuardedWrite(rootAbs, targetAbs, ownRoleRel, func(resolved string) error {
		return os.RemoveAll(resolved)
	})
}

// RenameGuarded renames with BOTH ends judged before either is touched, so neither
// the source nor the destination can be redirected out of the rule by a planted
// symlink.
func RenameGuarded(rootAbs, fromAbs, toAbs, ownRoleRel string) (layout.TargetVerdict, error) {
	fromVerdict, from, ok := judgeTarget(rootAbs, fromAbs, ownRoleRel)
	if !fromVerdict.OK || !ok {
		return fromVerdict, nil
	}
	toVerdict, to, ok := judgeTarget(rootAbs, toAbs, ownRoleRel)
	if !toVerdict.OK || !ok {
		return toVerdict, nil
	}
	return toVerdict, os.Rename(from, to)
}

// ChmodGuarded sets the mode of a guarded target.
func ChmodGuarded(rootAbs, targetAbs, ownRoleRel string, mode fs.FileMode) (layout.TargetVerdict, error) {
	return GuardedWrite(rootAbs, targetAbs, ownRoleRel, func(resolved string) error {
		return os.Chmod(resolved, mode)
	})
}

// GuardedOpen is a guarded destination opened for writing: the file and the resolved
// path it is bound to, or the refusal verdict. The caller writes into File and closes
// it; the bytes then land in the file the rule judged, never in a path reopened
// afterwards. File is nil exactly when Verdict refuses.
type GuardedOpen struct {
	File    *os.File
	Real    string
	Verdict layout.TargetVerdict
}

// OpenWriteGuarded opens a guarded destination for writing (truncating), creating its
// parent directories only when the open actually happens. mode is the creation mode
// (0 means 0o644).
func OpenWriteGuarded(rootAbs, targetAbs, ownRoleRel string, mode fs.FileMode) (GuardedOpen, error) {
	verdict, resolved, ok := judgeTarget(rootAbs, targetAbs, ownRoleRel)
	if !verdict.OK || !ok {
		return GuardedOpen{Verdict: verdict}, nil
	}
	if mode == 0 {
		mode = 0o644
	}
	if err := os.MkdirAll(filepath.Dir(resolved), 0o755); err != nil {
		return GuardedOpen{Verdict: verdict}, err
	}
	f, err := os.OpenFile(resolved, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return GuardedOpen{Verdict: verdict}, err
	}
	return GuardedOpen{File: f, Real: resolved, Verdict: verdict}, nil
}

// WriteFileAtomicGuarded writes a guarded target atomically: a temp sibling in the
// same directory, then a rename onto the destination, so an interrupted write never
// leaves a partial file. Both paths are judged before either is touched — a planted
// `<target>.leji-tmp` symlink would otherwise be written through before the rename —
// and the temp is removed when anything fails, so the whole compound operation lives
// here rather than being re-composed at each call site.
func WriteFileAtomicGuarded(rootAbs, targetAbs, ownRoleRel string, bytes []byte) (layout.TargetVerdict, error) {
	tmpVerdict, tmp, ok := judgeTarget(rootAbs, targetAbs+".leji-tmp", ownRoleRel)
	if !tmpVerdict.OK || !ok {
		return tmpVerdict, nil
	}
	destVerdict, dest, ok := judgeTarget(rootAbs, targetAbs, ownRoleRel)
	if !destVerdict.OK || !ok {
		return destVerdict, nil
	}
	write := func() error {
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(tmp, bytes, 0o644); err != nil {
			return err
		}
		if err := maybeInjectWriteFailure(); err != nil {
			return err
		}
		return os.Rename(tmp, dest)
	}
	if err := write(); err != nil {
		// Best-effort cleanup; the caller reports the original failure.
		_ = os.RemoveAll(tmp)
		return destVerdict, err
	}
	return destVerdict, nil
}

// maybeInjectWriteFailure is test-only fault injection for WriteFileAtomicGuarded:
// with LEJI_TEST_FAIL_RENAME set, fail after the temp file exists but before the
// rename, to exercise the cleanup and the caller's normalized-error path.
func maybeInjectWriteFailure() error {
	if os.Getenv("LEJI_TEST_FAIL_RENAME") != "" {
		return errors.New("injected write failure")
	}
	return nil
}

// VerifiedSource is an opened source: the file when it passed every check (the
// caller closes it), else nil — with the resolved path, when it could be resolved
// at all, so a refusal can name where the source actually landed.
type VerifiedSource struct {
	File *os.File
	Real string
	// Resolved is false when the path could not be resolved at all.
	Resolved bool
}

// OpenVerifiedSource is the guarded-READ counterpart of GuardedWrite
// (check-before-act), for every source whose bytes are about to be served, linted, or
// exported. Resolve abs, judge the RESOLVED path with allow, then open that path and
// prove the DESCRIPTOR is a regular file with fstat — so the file the check judged is
// the file the read gets. A path-based check leaves two windows open: an ancestor
// directory swapped to a symlink after enumeration (an lstat of the final component
// follows it and reports an ordinary file), and the gap between any check and a later
// read or copy by path. Reading from the descriptor closes both: the inode is pinned
// by the open.
//
// The open itself is by path, so one window survives that: a swap landing between the
// resolve above and the open makes the open follow the new link, and fstat sees only an
// ordinary regular file. So the source is resolved ONCE MORE after the open and the
// descriptor is required to be that same location and that same file identity (os.SameFile,
// the portable (dev, ino) comparison) — the bytes about to be read are then provably the
// ones allow judged. What remains is the recorded check-before-act limit
// (docs/practice/trust-boundary.md): an attacker must swap AND revert within the
// open→recheck span to pass both resolutions. The reference
// implementation states the same limit for the same reason, so this port keeps the
// resolve→open→fstat→recheck order rather than reaching for a platform openat: the
// observable behavior is the contract, and it must be identical in all three SDKs.
//
// The caller closes File when it is non-nil, and owns the refusal semantics — a silent
// drop, a boundary warning, or an error — since only it knows which the source deserves.
// A source that vanished between the check and the open is one such refusal; any other
// I/O error on an allowed path is the filesystem failing rather than the boundary
// refusing, so it is returned as an error, as a read by path always has been.
func OpenVerifiedSource(abs string, allow func(resolved string) bool) (VerifiedSource, error) {
	return openVerifiedSourceUnder("", abs, allow)
}

// openVerifiedSourceUnder is OpenVerifiedSource with a prefix already known to be
// canonical — the resolved repository root the write rule is about — so only the
// components below it are read back from the filesystem. Semantics are identical.
func openVerifiedSourceUnder(base, abs string, allow func(resolved string) bool) (VerifiedSource, error) {
	real, ok := ResolvedPathUnder(base, abs)
	if !ok {
		return VerifiedSource{}, nil
	}
	if !allow(real) {
		return VerifiedSource{Real: real, Resolved: true}, nil
	}
	f, err := os.Open(real)
	if err != nil {
		if os.IsNotExist(err) {
			return VerifiedSource{Real: real, Resolved: true}, nil // gone between the check and the open
		}
		return VerifiedSource{Real: real, Resolved: true}, err
	}
	opened, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return VerifiedSource{Real: real, Resolved: true}, nil
	}
	if !opened.Mode().IsRegular() {
		_ = f.Close()
		return VerifiedSource{Real: real, Resolved: true}, nil
	}
	// The recheck. A refusal names where the source resolves NOW, not where it resolved
	// before the swap, so the caller's boundary message points at the role the bytes
	// would actually have come from — but only where that is a place at all. The
	// recheck path is stat'd FIRST, exactly as the reference implementation does: a
	// path that cannot be resolved, or that resolves to a dangling target no stat can
	// reach, names no location for a refusal to carry, so the originally allowed path
	// comes back and the caller drops the source as silently as it drops a redirect.
	// Only a stat that succeeded is compared, on location and on file identity alike.
	recheck, ok := ResolvedPathUnder(base, abs)
	if !ok {
		_ = f.Close()
		return VerifiedSource{Real: real, Resolved: true}, nil
	}
	landed, lerr := os.Stat(recheck)
	if lerr != nil {
		_ = f.Close()
		return VerifiedSource{Real: real, Resolved: true}, nil
	}
	if recheck != real || !os.SameFile(opened, landed) {
		_ = f.Close()
		return VerifiedSource{Real: recheck, Resolved: true}, nil
	}
	return VerifiedSource{File: f, Real: real, Resolved: true}, nil
}

// ReadStatus is which of the three outcomes a TargetRead carries.
type ReadStatus string

const (
	// ReadAbsent is nothing standing at the target: the create path.
	ReadAbsent ReadStatus = "absent"
	// ReadRegular is a verified regular file, its bytes carried along.
	ReadRegular ReadStatus = "regular"
	// ReadRefused is a standing entry this run refuses to act through.
	ReadRefused ReadStatus = "refused"
)

// RefusalReason is why a TargetRead refused: the resolved target left the
// repository, crossed into another `.leji/` role, is not a regular file, or is a
// standing entry this run could not verify.
type RefusalReason string

const (
	// RefusedOutsideRoot is a target resolving outside the repository root.
	RefusedOutsideRoot RefusalReason = "outside-root"
	// RefusedOtherRole is a target resolving into a `.leji/` role this act does not own.
	RefusedOtherRole RefusalReason = "other-role"
	// RefusedNotRegular is a directory, socket, FIFO, device node, or a link to one.
	RefusedNotRegular RefusalReason = "not-regular"
	// RefusedUnverifiable is a standing entry no verified descriptor could be proved for.
	RefusedUnverifiable RefusalReason = "unverifiable"
)

// TargetRead is what stood at a read-then-act target, judged by the same rule the
// write will be: nothing (ReadAbsent), a regular file whose verified bytes are
// carried along (ReadRegular), or a standing entry this run refuses to act through
// (ReadRefused, with the reason and — when it resolved at all, Resolved — where it
// resolved).
type TargetRead struct {
	Status   ReadStatus
	Real     string
	Resolved bool
	Bytes    []byte
	Reason   RefusalReason
}

// VerifiedTargetRead reads a target that is about to be written, under the write rule
// itself: the shape every "look at what is there, then act on it" command needs, so
// none of them re-composes it.
//
// The ORIGINAL directory entry decides the kind first — a socket, a FIFO, a device
// node or a directory standing at the target is refused rather than opened, and a
// symlink is settled on what it resolves TO, because the open would follow it. Then
// OpenVerifiedSource judges the RESOLVED path against layout.WritableTarget for this
// role and proves the descriptor is that same regular file, so the bytes come back
// from the inode the rule cleared.
//
// ReadAbsent is decided on the original entry, never on where it resolves: a dangling
// symlink resolves to a missing destination while the link itself is still standing,
// and a standing entry this run could not verify is ReadRefused/RefusedUnverifiable,
// never a write through it. Operational I/O failures on an allowed path PROPAGATE as
// errors, as a read by path always has; only containment, entry kind, and
// verification become refusals.
func VerifiedTargetRead(rootAbs, targetAbs, ownRoleRel string) (TargetRead, error) {
	refused := func(reason RefusalReason) (TargetRead, error) {
		real, ok := ResolvedPathUnder(rootAbs, targetAbs)
		return TargetRead{Status: ReadRefused, Real: real, Resolved: ok, Reason: reason}, nil
	}
	entry, lerr := os.Lstat(targetAbs)
	if lerr != nil && !os.IsNotExist(lerr) {
		return TargetRead{}, lerr
	}
	if lerr == nil && !entry.Mode().IsRegular() && entry.Mode()&os.ModeSymlink == 0 {
		return refused(RefusedNotRegular)
	}
	if lerr == nil && entry.Mode()&os.ModeSymlink != 0 {
		// A symlink is settled on what it resolves TO, because the open follows it: a
		// link to a socket would raise exactly the escaping error this check prevents.
		// A link that resolves to NO entry — dangling, or through a component that is
		// not a directory — has no kind to settle, so it continues and the resolver
		// below refuses it as unverifiable. Only a genuine operational failure
		// (permission, an I/O error, a symlink loop) travels out.
		followed, serr := os.Stat(targetAbs)
		if serr != nil && !isNoEntry(serr) {
			return TargetRead{}, serr
		}
		if serr == nil && !followed.Mode().IsRegular() {
			return refused(RefusedNotRegular)
		}
	}
	var refusal RefusalReason
	src, err := openVerifiedSourceUnder(rootAbs, targetAbs, func(resolved string) bool {
		// The same rule the write will be judged by, the declared exception included:
		// the read-then-act pair must agree, or the one target that belongs to no role
		// could be read here and refused at the write (or the reverse).
		verdict, isException := metadataFileVerdict(rootAbs, targetAbs, resolved, ownRoleRel)
		if !isException {
			verdict = layout.WritableTarget(rootAbs, resolved, ownRoleRel)
		}
		if verdict.OK {
			return true
		}
		if verdict.OutsideRoot {
			refusal = RefusedOutsideRoot
		} else {
			refusal = RefusedOtherRole
		}
		return false
	})
	if err != nil {
		return TargetRead{}, err
	}
	if src.File != nil {
		bytes, rerr := io.ReadAll(src.File)
		_ = src.File.Close()
		if rerr != nil {
			return TargetRead{}, rerr
		}
		return TargetRead{Status: ReadRegular, Real: src.Real, Resolved: true, Bytes: bytes}, nil
	}
	if refusal != "" {
		return TargetRead{Status: ReadRefused, Real: src.Real, Resolved: src.Resolved, Reason: refusal}, nil
	}
	if !src.Resolved {
		return TargetRead{Status: ReadRefused, Reason: RefusedUnverifiable}, nil
	}
	// Nothing verified was opened, and only ONE thing may follow from that: the target
	// is absent. Anything still standing there is a refusal.
	if _, err := os.Lstat(targetAbs); err != nil {
		if !os.IsNotExist(err) {
			return TargetRead{}, err
		}
		return TargetRead{Status: ReadAbsent, Real: src.Real, Resolved: true}, nil
	}
	return TargetRead{Status: ReadRefused, Real: src.Real, Resolved: true, Reason: RefusedUnverifiable}, nil
}

func Exists(abs string) bool {
	_, err := os.Stat(abs)
	return err == nil
}

func IsDir(abs string) bool {
	info, err := os.Stat(abs)
	return err == nil && info.IsDir()
}

func IsFile(abs string) bool {
	info, err := os.Stat(abs)
	return err == nil && info.Mode().IsRegular()
}

func ReadText(abs string) (string, error) {
	b, err := os.ReadFile(abs)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// WalkMd collects markdown under a declared path (file or directory), as sorted
// repo-relative POSIX paths.
func WalkMd(root, relPath string) []string {
	abs := filepath.Join(root, relPath)
	if IsFile(abs) {
		// A declared path that is itself a symlinked file must not escape the
		// tree, mirroring the per-entry guard in the directory walk below.
		if strings.HasSuffix(relPath, ".md") && ResolvedWithinRoot(root, abs) {
			return []string{ToPosix(relPath)}
		}
		return []string{}
	}
	if !IsDir(abs) {
		return []string{}
	}
	out := []string{}
	stack := []string{abs}
	for len(stack) > 0 {
		dir := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			name := entry.Name()
			if strings.HasPrefix(name, ".") {
				continue
			}
			full := filepath.Join(dir, name)
			// Exclude entries that resolve outside the repository root via a
			// symlink, so a walk cannot follow a link out of the tree.
			if !ResolvedWithinRoot(root, full) {
				continue
			}
			if entry.IsDir() {
				if name == "node_modules" {
					continue
				}
				stack = append(stack, full)
			} else if entry.Type().IsRegular() && strings.HasSuffix(name, ".md") {
				rel, err := filepath.Rel(root, full)
				if err != nil {
					continue
				}
				out = append(out, ToPosix(rel))
			}
		}
	}
	sort.Strings(out)
	return out
}

// WalkTree is the viewer's sidebar browse walk; an alias for WalkMd, so it
// inherits the dotfile/node_modules skip and symlink containment.
func WalkTree(root, relPath string) []string {
	return WalkMd(root, relPath)
}

func StripSlash(p string) string {
	return strings.TrimSuffix(p, "/")
}

// JoinUnderRoot joins sub under a context root (POSIX), treating "." or "" as the
// repository root, so JoinUnderRoot(".", "context/") is "context/", never the
// hidden ".context/" a bare concatenation would produce.
func JoinUnderRoot(rootPath, sub string) string {
	base := StripSlash(rootPath)
	if base == "" || base == "." {
		return sub
	}
	return base + "/" + sub
}

// UnderPath is true when relPath is the declared path itself or falls under it.
func UnderPath(relPath, declared string) bool {
	base := StripSlash(declared)
	if base == "" || base == "." {
		return true
	}
	return relPath == base || strings.HasPrefix(relPath, base+"/")
}
