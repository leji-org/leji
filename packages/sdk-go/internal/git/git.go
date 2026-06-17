// Package git shells to the git binary for the changelog append-only baseline
// and index lastModified dates, mirroring git.ts / gitutil.py. Every helper
// degrades to a zero value outside a git repository.
package git

import (
	"context"
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
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}
	return string(out), true
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
	resolvedFile, err := filepath.EvalSymlinks(filepath.Join(root, relPath))
	if err != nil {
		resolvedFile = filepath.Join(root, relPath)
	}
	rel, err := filepath.Rel(resolvedTop, resolvedFile)
	if err != nil {
		return "", false
	}
	fromTop := fsx.ToPosix(rel)
	return run(root, "show", "HEAD:"+fromTop)
}
