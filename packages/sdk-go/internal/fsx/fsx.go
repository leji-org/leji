// Package fsx holds filesystem helpers; all returned repo-relative paths are
// POSIX (forward-slash), matching the Node and Python SDKs.
package fsx

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ToPosix converts an OS path to forward-slash form.
func ToPosix(p string) string {
	return filepath.ToSlash(p)
}

// ResolvesUnder reports whether abs, after resolving symlinks, stays under root
// (also resolved). A target that does not yet exist is judged by its nearest
// existing ancestor, so a brand-new file under a real root is allowed while a
// path reached through a symlink that escapes root is rejected.
func ResolvesUnder(root, abs string) bool {
	// Resolve both operands to absolute first, mirroring the Node reference
	// (fs.realpathSync always yields absolute paths). EvalSymlinks of a relative
	// path returns a relative path, so without this an absolute realRoot would
	// never prefix-match a relative target and every file would be excluded.
	if a, err := filepath.Abs(root); err == nil {
		root = a
	}
	if a, err := filepath.Abs(abs); err == nil {
		abs = a
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		realRoot, _ = filepath.Abs(root)
	}
	target := abs
	for {
		resolved, err := filepath.EvalSymlinks(target)
		if err == nil {
			target = resolved
			break
		}
		parent := filepath.Dir(target)
		if parent == target {
			// Reached the filesystem root without resolving; fall back to abs.
			target, _ = filepath.Abs(abs)
			break
		}
		target = parent
	}
	if target == realRoot {
		return true
	}
	return strings.HasPrefix(target, realRoot+string(filepath.Separator))
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

// WalkMd recursively collects markdown files under a declared path (file or
// directory), returned as repository-root-relative POSIX paths, sorted.
func WalkMd(root, relPath string) []string {
	abs := filepath.Join(root, relPath)
	if IsFile(abs) {
		// A declared path that is itself a symlinked file must not escape the
		// tree, mirroring the per-entry guard in the directory walk below.
		if strings.HasSuffix(relPath, ".md") && ResolvesUnder(root, abs) {
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
			if !ResolvesUnder(root, full) {
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

// StripSlash drops a single trailing slash.
func StripSlash(p string) string {
	return strings.TrimSuffix(p, "/")
}

// UnderPath is true when relPath is the declared path itself or falls under it.
func UnderPath(relPath, declared string) bool {
	base := StripSlash(declared)
	if base == "" || base == "." {
		return true
	}
	return relPath == base || strings.HasPrefix(relPath, base+"/")
}
