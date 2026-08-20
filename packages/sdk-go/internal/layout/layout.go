// Package layout holds the unified `.leji/` layout: one tree at the repository
// root holding every role the tool owns, whatever `rootPath` the layer declares.
// Roles are repository-root-relative by construction — a generated artifact never
// lives inside the context root, so the content walk and the served content mount
// carry nothing of the tool's own.
//
//   - `mounts/` + `mounts.local.json` — the private federation domain (owned by
//     internal/mounts, which spells the paths inside it; never servable, never
//     exportable).
//   - `viewer/` — generated chrome, the ONE servable role.
//   - `dist/` — the default export output.
//   - `work/` — the transient onboarding workspace.
package layout

import (
	"path/filepath"
	"strings"
)

// LejiDir is the unified tree at the repository root.
const LejiDir = ".leji"

// ViewerRel is the generated viewer chrome (index.html, _sidebar.md,
// _manifest.md, assets/).
const ViewerRel = LejiDir + "/viewer"

// DistRel is the default export output; the only role a caller-supplied `--out`
// may name.
const DistRel = LejiDir + "/dist"

// WorkRel is the transient onboarding workspace (brief, proposal, hooks).
const WorkRel = LejiDir + "/work"

// MountsRel is the private federation domain: managed object stores, projection
// cache, staging.
const MountsRel = LejiDir + "/mounts"

// Abs joins a repository-root-relative role path (POSIX, as the constants above
// spell it) onto an absolute root, in the host's own separator.
func Abs(rootAbs, rel string) string {
	return filepath.Join(rootAbs, filepath.FromSlash(rel))
}

// under reports whether abs is dir or sits underneath it.
func under(dir, abs string) bool {
	return abs == dir || strings.HasPrefix(abs, dir+string(filepath.Separator))
}

// ServablePath is the servable-roots whitelist: a path may be served or exported
// only when it lies outside root `.leji/` entirely, or inside `.leji/viewer/`.
// Every other role under `.leji/` — the private mounts domain, the export output,
// the onboarding workspace, and any role added later — is denied by name, so a
// new role is born unservable and no relaxation of the dot-segment refusal (kept
// as defense in depth) can open the trust domain as a side effect.
//
// rootAbs must be a resolved (realpath'd) repository root, and abs is judged both
// as requested and after symlink resolution: the name is what decides, not how the
// caller spelled it.
func ServablePath(rootAbs, abs string) bool {
	leji := Abs(rootAbs, LejiDir)
	if !under(leji, abs) {
		return true
	}
	return under(Abs(rootAbs, ViewerRel), abs)
}

// LejiRole is the private `.leji/` role a resolved path falls into: the first path
// segment under `.leji/` (`mounts`, `work`, `dist`, `viewer`, or any future role
// name), or "" when the path is `.leji/` itself. Callers establish that abs is
// under `.leji/` before asking; used to name the role in a boundary message.
func LejiRole(rootAbs, abs string) string {
	rest, err := filepath.Rel(Abs(rootAbs, LejiDir), abs)
	if err != nil || rest == "." {
		return ""
	}
	return strings.Split(rest, string(filepath.Separator))[0]
}

// TargetVerdict is the verdict of WritableTarget: whether a tool-owned target may
// be written or cleared, and — when refused — that it landed outside the
// repository, the private role it crossed into, that the path could not be resolved
// at all (permission/I/O, not mere absence), or that an exclusive create found the
// file already there.
type TargetVerdict struct {
	OK           bool
	Role         string
	Unresolvable bool
	OutsideRoot  bool
	Exists       bool
}

// WritableTarget is the check-before-act rule for a WRITE or CLEAR target,
// judged on the RESOLVED path immediately before the act, in this order:
//
//  1. The target must resolve INSIDE the repository root. Every write this tool
//     makes lands in the repository it was pointed at, with no exceptions: a
//     `.leji/` role symlinked out of the tree is refused rather than followed. A
//     user who wants the export somewhere else copies the finished folder there.
//  2. A target under root `.leji/` is refused — that tree is the tool's own trust
//     domain — UNLESS ownRoleRel is given and the target lies under that one role.
//  3. Anything else inside the repository is ordinary content and is allowed.
//
// Both rootAbs and resolvedAbs must be realpath-resolved, so a redirecting symlink
// or a case-variant spelling is judged by where it lands, not by how it was
// written. One home for the rule, called before every write and clear.
//
// ownRoleRel names the ONE `.leji/` role the target may land in, as a lexical path
// under the resolved root; pass "" when the target has no legitimate `.leji/` role
// at all (user content such as overview.md, which lives under the content root,
// never inside `.leji/`) — then any `.leji/` landing is refused.
func WritableTarget(rootAbs, resolvedAbs, ownRoleRel string) TargetVerdict {
	if !under(rootAbs, resolvedAbs) {
		return TargetVerdict{OutsideRoot: true}
	}
	if !under(Abs(rootAbs, LejiDir), resolvedAbs) {
		return TargetVerdict{OK: true} // inside the repository, outside .leji/
	}
	if ownRoleRel != "" && under(Abs(rootAbs, ownRoleRel), resolvedAbs) {
		return TargetVerdict{OK: true} // its own role
	}
	return TargetVerdict{Role: LejiRole(rootAbs, resolvedAbs)}
}
