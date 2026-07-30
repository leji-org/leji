// Package git shells to the git binary for the changelog append-only baseline
// and index lastModified dates, mirroring git.ts / gitutil.py. Every helper
// degrades to a zero value outside a git repository.
package git

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
)

// gitTimeout bounds each git invocation; on timeout the helper degrades to the
// same zero value it returns when git is unavailable.
const gitTimeout = 10 * time.Second

func run(root string, args ...string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()
	full := append([]string{"-C", root}, args...)
	cmd := exec.CommandContext(ctx, "git", full...)
	// `git status` refreshes and can rewrite `.git/index`, and a promisor clone can
	// reach the network from a command documented as offline and non-mutating. The
	// mounts resolver already sets both; these are the same guarantees everywhere else.
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "GIT_NO_LAZY_FETCH=1")
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}
	return string(out), true
}

// OriginURL returns the origin remote URL, or ("", false) when not in git or
// no origin is configured.
func OriginURL(root string) (string, bool) {
	out, ok := run(root, "remote", "get-url", "origin")
	if !ok {
		return "", false
	}
	s := strings.TrimSpace(out)
	if s == "" {
		return "", false
	}
	return s, true
}

// Toplevel returns the absolute path of the git worktree containing root, or
// ("", false) when not in git.
func Toplevel(root string) (string, bool) {
	out, ok := run(root, "rev-parse", "--show-toplevel")
	if !ok {
		return "", false
	}
	s := strings.TrimSpace(out)
	if s == "" {
		return "", false
	}
	return s, true
}

// LastModified returns the last commit date (YYYY-MM-DD) of a file, or ("",
// false) when untracked, modified in the working tree, or outside git.
func LastModified(root, relPath string) (string, bool) {
	status, ok := run(root, "status", "--porcelain", "--", relPath)
	if !ok || strings.TrimSpace(status) != "" {
		return "", false
	}
	out, ok := run(root, "log", "-1", "--format=%cs", "--", relPath)
	if !ok {
		return "", false
	}
	date := strings.TrimSpace(out)
	if date == "" {
		return "", false
	}
	return date, true
}

// TrackedUnder returns the tracked files under a repository-relative path; ok
// is false when root is not in git. Backs the onboarding-workspace preflight:
// `.leji/` must hold no tracked files before private artifacts may land there.
func TrackedUnder(root, rel string) (files []string, ok bool) {
	if _, inGit := Toplevel(root); !inGit {
		return nil, false
	}
	out, ran := run(root, "ls-files", "--", rel)
	if !ran {
		return nil, false
	}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			files = append(files, line)
		}
	}
	return files, true
}

// WorkingTreeClean backs the init/adopt dirty-guard. isRepo is false outside git
// or on failure (no commit-backed undo exists, so the guard does not apply);
// when true, clean reports no uncommitted changes (staged, unstaged, untracked).
func WorkingTreeClean(root string) (clean bool, isRepo bool) {
	top, ok := Toplevel(root)
	if !ok {
		return false, false
	}
	status, ok := run(top, "status", "--porcelain", "--untracked-files=all")
	if !ok {
		return false, false
	}
	return strings.TrimSpace(status) == "", true
}

// ShowHead returns the content of the file at HEAD, or ("", false) for a new
// file, no git, or no HEAD yet.
func ShowHead(root, relPath string) (string, bool) {
	top, ok := Toplevel(root)
	if !ok {
		return "", false
	}
	resolvedTop, err := filepath.EvalSymlinks(top)
	if err != nil {
		resolvedTop = top
	}
	// Absolutize before resolving: Toplevel returns an absolute path, and
	// EvalSymlinks on a relative input returns a relative result, so filepath.Rel
	// below would fail on the default root of ".". That failure was invisible while
	// an unreadable HEAD counted as verified, which meant the append-only check
	// silently never ran with a relative root.
	absRoot, err := filepath.Abs(root)
	if err != nil {
		absRoot = root
	}
	resolvedFile, err := filepath.EvalSymlinks(filepath.Join(absRoot, relPath))
	if err != nil {
		resolvedFile = filepath.Join(absRoot, relPath)
	}
	rel, err := filepath.Rel(resolvedTop, resolvedFile)
	if err != nil {
		return "", false
	}
	fromTop := fsx.ToPosix(rel)
	return run(root, "show", "HEAD:"+fromTop)
}
