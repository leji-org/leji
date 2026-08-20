// Package sourceaudit is the acceptance check for the write boundary: no production
// source file of this SDK reaches a raw filesystem mutation, or a subprocess that
// could perform one, except at a symbol named below. Every other write goes through
// internal/fsx — the chokepoint and its guarded conveniences — so a new write site is
// contained by construction rather than by remembering to contain it, and a reviewer
// can read the exceptions instead of re-deriving them. docs/practice/trust-boundary.md
// mirrors both lists.
//
// The scan is TYPE-RESOLVED: every package is parsed and type-checked, and the
// QUALIFIER of each selector is resolved to the object it actually names, so a
// mutator is recognized by the package it belongs to rather than by how the call was
// spelled. `import stdos "os"` and `w := os.Rename` are caught; a local variable or
// field named `os`, or a method named `Rename` on this SDK's own types, is not. A dot
// import of a watched package is banned outright — it would put a mutator's bare name
// in scope, which no type check can then attribute. The raw syscall gate is watched
// the same way, so an assembled call cannot slip past the named surface.
//
// The recorded residual, for a regression audit rather than a sandbox: a mutator
// handed across a package boundary as a func VALUE (this SDK passes none), reached
// through `go:linkname` or cgo, or executed by a program a subprocess allowance
// starts. The first is not data flow this scan follows; the last two are the reason
// subprocesses carry their own named list.
package sourceaudit

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// The filesystem mutation surface, by the package that declares it. These are
// package-level functions: a method on an *os.File the caller already holds is not
// listed, because obtaining that file is itself an allowance decision (os.OpenFile,
// os.Create) — copying into a descriptor OpenWriteGuarded returned is the whole point
// of the guarded open.
var mutators = map[string]map[string]bool{
	"os": setOf(
		"Chmod", "Chown", "Chtimes", "Create", "CreateTemp", "Lchown", "Link", "Mkdir",
		"MkdirAll", "MkdirTemp", "NewFile", "OpenFile", "Remove", "RemoveAll", "Rename",
		"Symlink", "Truncate", "WriteFile",
	),
	"io/ioutil": setOf("TempDir", "TempFile", "WriteFile"),
	"syscall": setOf(
		"Chmod", "Chown", "Ftruncate", "Link", "Mkdir", "Mkdirat", "Openat", "Rename",
		"Renameat", "Rmdir", "Symlink", "Truncate", "Unlink", "Unlinkat", "Write",
		// The raw gate: a syscall assembled by number can be any of the above, and
		// nothing below this line can tell which. Each caller is named and reasoned.
		"Syscall", "Syscall6", "SyscallN", "RawSyscall", "RawSyscall6",
	),
}

// Anything that hands work to another program, which can then write whatever it
// likes.
var subprocess = map[string]map[string]bool{
	"os/exec": setOf("Command", "CommandContext"),
	"syscall": setOf("Exec", "ForkExec", "StartProcess"),
	"os":      setOf("StartProcess"),
}

// Dot-importing any of these would put a bare mutator name in scope, which no type
// check can then attribute to its package. Not a style this SDK uses, so it is
// refused rather than analyzed.
var bannedImports = setOf("os", "os/exec", "io/ioutil", "syscall")

// The write allow-list, by `file#symbol` — never by whole file, so a future raw
// mutation elsewhere in an allowed file still fails. An entry that matches nothing
// fails too: a stale exception is an exception nobody is checking.
var allowedWrites = map[string]string{
	"internal/fsx/fsx.go#WriteFileGuarded":        "the chokepoint itself: the guarded write, judged before it acts",
	"internal/fsx/fsx.go#MkdirpGuarded":           "the chokepoint itself: the guarded directory establishment",
	"internal/fsx/fsx.go#RmGuarded":               "the chokepoint itself: the guarded clear",
	"internal/fsx/fsx.go#RenameGuarded":           "the chokepoint itself: the guarded rename, both ends judged",
	"internal/fsx/fsx.go#ChmodGuarded":            "the chokepoint itself: the guarded mode change",
	"internal/fsx/fsx.go#OpenWriteGuarded":        "the chokepoint itself: the guarded destination descriptor",
	"internal/fsx/fsx.go#WriteFileAtomicGuarded":  "the chokepoint itself: temp sibling plus rename, both ends judged",
	"internal/mounts/mounts.go#ExtractProjection": "mounts per-entry protocol, under a store root the chokepoint established",
	"internal/mounts/mounts.go#publishCacheEntry": "mounts per-entry protocol: sidecar, marker, publish-by-rename, staging clear",
	"internal/mounts/mounts.go#HydrateMounts":     "mounts per-entry protocol: clears its own established staging directory",
	"internal/mounts/mounts.go#VerifyProjection":  "verification staging under the OS temp directory, outside the repository",
	"internal/commands/init/init.go#InitLayer":    "root bootstrap: creates the selected root before any repository root exists",
	"internal/commands/init/init.go#AdoptLayer":   "root bootstrap: creates the selected root before any repository root exists",
	"internal/cli/tty_darwin.go#fdIsTTY":          "the raw syscall gate, for one read-only terminal ioctl (TIOCGETA); writes nothing",
	"internal/cli/tty_linux.go#fdIsTTY":           "the raw syscall gate, for one read-only terminal ioctl (TCGETS); writes nothing",
}

// The subprocess allow-list. A child process is outside every guard this SDK can
// enforce, so each caller is named with what it runs and what it may write.
var allowedSubprocesses = map[string]string{
	"internal/git/git.go#run":                                  "read-only git queries (log, ls-files, status) in the host repository",
	"internal/mounts/mounts.go#runGitLimited":                  "the federation resolver: git init/fetch write ONLY into a store or cache root the chokepoint established, plus read-only queries",
	"internal/commands/init/init.go#gitConfig":                 "read-only `git config --get`",
	"internal/commands/init/init.go#hooksPathConfig":           "read-only `git -C root config core.hooksPath`",
	"internal/commands/init/init.go#gitHooksDir":               "read-only `git rev-parse --git-path hooks`",
	"internal/commands/init/init.go#gitDirs":                   "read-only `git rev-parse --git-dir --git-common-dir`",
	"internal/commands/init/init.go#DefaultHandoffIO":          "the handoff IO: launches the agent host the user chose, or runs the command it declares; its writes are that program's, not this SDK's",
	"internal/commands/init/init.go#captureRun":                "the handoff IO's bounded probe: asks for a version with argv only, cwd-pinned to the repository root, stdin closed, stderr discarded, output and wall time capped while the child runs (passing the cap cancels the run, which terminates the child promptly), and an environment built from empty that REPLACES this process's rather than extending it; it never invokes a package manager's script runner, and it writes nothing",
	"internal/commands/init/dependency.go#DefaultDependencyIO": "the declaration offer: runs the repository's OWN package manager add command, argv only and never a shell, and only after the user says yes at init/adopt; its writes are that manager's (manifest and lockfile), not this SDK's",
	"internal/commands/serve/serve.go#OpenBrowser":             "opens the preview URL in the desktop browser; writes nothing",
}

func setOf(names ...string) map[string]bool {
	out := make(map[string]bool, len(names))
	for _, n := range names {
		out[n] = true
	}
	return out
}

// hit is one flagged call: where it is (`file#symbol`), on what line, and the name it
// resolved to.
type hit struct {
	key  string
	line int
	name string
}

type result struct {
	writes       []hit
	subprocesses []hit
}

// stubImporter satisfies the type checker without reading a single dependency from
// disk: every import becomes an empty package under its own path, which is all the
// audit needs, since it asks what a QUALIFIER names, never what the member is. It
// also makes the audit hermetic — no GOROOT parse, no build cache, no network.
type stubImporter struct{}

func (stubImporter) Import(importPath string) (*types.Package, error) {
	pkg := types.NewPackage(importPath, path.Base(importPath))
	pkg.MarkComplete()
	return pkg, nil
}

// scan type-checks one directory's production files and returns every flagged call in
// them, keyed by the module-relative file and the nearest enclosing named function.
func scan(t *testing.T, moduleRoot, dir string, files map[string]string) result {
	t.Helper()
	fset := token.NewFileSet()
	var parsed []*ast.File
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		file, err := parser.ParseFile(fset, name, files[name], parser.SkipObjectResolution)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		parsed = append(parsed, file)
	}
	conf := types.Config{Importer: stubImporter{}, Error: func(error) {}}
	info := &types.Info{Uses: map[*ast.Ident]types.Object{}}
	// The check reports errors for every member of a stubbed package; they are
	// expected and ignored, and the qualifier resolution the audit reads is recorded
	// regardless.
	_, _ = conf.Check(dir, fset, parsed, info)

	var out result
	for _, file := range parsed {
		rel, err := filepath.Rel(moduleRoot, fset.Position(file.Package).Filename)
		if err != nil {
			t.Fatal(err)
		}
		rel = filepath.ToSlash(rel)
		record := func(into *[]hit, node ast.Node, name string) {
			*into = append(*into, hit{key: rel + "#" + enclosingSymbol(file, node), line: fset.Position(node.Pos()).Line, name: name})
		}
		// A dot import, or `unsafe`, is refused by its import statement: neither can be
		// attributed by the type check that follows.
		for _, imp := range file.Imports {
			importPath, err := strconv.Unquote(imp.Path.Value)
			if err != nil {
				continue
			}
			dotted := imp.Name != nil && imp.Name.Name == "."
			if bannedImports[importPath] && (dotted || importPath == "unsafe") {
				record(&out.writes, imp, "import of "+importPath)
			}
		}
		// The one mutator that is also the ordinary read — os.OpenFile with a literally
		// read-only flag — is settled first, on the call, since the exemption is in the
		// arguments. Every other appearance of the name, call or function value alike,
		// is a hit.
		exempt := map[*ast.SelectorExpr]bool{}
		ast.Inspect(file, func(n ast.Node) bool {
			if call, ok := n.(*ast.CallExpr); ok {
				if sel := readOnlyOpen(call, info); sel != nil {
					exempt[sel] = true
				}
			}
			return true
		})
		ast.Inspect(file, func(n ast.Node) bool {
			sel, ok := n.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			qualifier, ok := sel.X.(*ast.Ident)
			if !ok {
				return true
			}
			pkgName, ok := info.Uses[qualifier].(*types.PkgName)
			if !ok {
				return true // a value, a field, a shadowing local: not the package
			}
			importPath := pkgName.Imported().Path()
			if mutators[importPath][sel.Sel.Name] && !exempt[sel] {
				record(&out.writes, sel, importPath+"."+sel.Sel.Name)
			}
			if subprocess[importPath][sel.Sel.Name] {
				record(&out.subprocesses, sel, importPath+"."+sel.Sel.Name)
			}
			return true
		})
	}
	return out
}

// readOnlyOpen is the callee of an `os.OpenFile(path, os.O_RDONLY, …)` call, else
// nil: the one mutator that is also the ordinary read. Anything else creates or
// truncates, and a flag assembled elsewhere cannot be proven read-only. The flag is
// resolved the same type-resolved way the callee is — a constant merely NAMED
// O_RDONLY, on any package or value of the author's making, exempts nothing.
func readOnlyOpen(call *ast.CallExpr, info *types.Info) *ast.SelectorExpr {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != "OpenFile" || len(call.Args) < 2 {
		return nil
	}
	flag, ok := call.Args[1].(*ast.SelectorExpr)
	if !ok || flag.Sel.Name != "O_RDONLY" {
		return nil
	}
	qualifier, ok := flag.X.(*ast.Ident)
	if !ok {
		return nil
	}
	pkgName, ok := info.Uses[qualifier].(*types.PkgName)
	if !ok || pkgName.Imported().Path() != "os" {
		return nil
	}
	return sel
}

// enclosingSymbol is the nearest named FUNCTION containing node: the declaration or
// method a reader would cite when arguing the exception. A function literal is
// transparent — a raw primitive inside a closure belongs to the function that owns
// it, so naming a closure cannot launder one past the allow-list.
func enclosingSymbol(file *ast.File, node ast.Node) string {
	name := "(top level)"
	ast.Inspect(file, func(n ast.Node) bool {
		decl, ok := n.(*ast.FuncDecl)
		if !ok {
			return true
		}
		if decl.Pos() <= node.Pos() && node.End() <= decl.End() {
			name = decl.Name.Name
		}
		return true
	})
	return name
}

// productionPackages is every directory of this module holding production Go files,
// as `dir -> {file: source}`; tests and testdata are excluded explicitly.
func productionPackages(t *testing.T, moduleRoot string) map[string]map[string]string {
	t.Helper()
	pkgs := map[string]map[string]string{}
	err := filepath.WalkDir(moduleRoot, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "testdata" || d.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".go") || strings.HasSuffix(d.Name(), "_test.go") {
			return nil
		}
		body, rerr := os.ReadFile(p)
		if rerr != nil {
			return rerr
		}
		dir := filepath.Dir(p)
		if pkgs[dir] == nil {
			pkgs[dir] = map[string]string{}
		}
		pkgs[dir][p] = string(body)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return pkgs
}

func moduleRoot(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate the audit's own source file")
	}
	return filepath.Dir(filepath.Dir(filepath.Dir(thisFile)))
}

func audit(t *testing.T) result {
	t.Helper()
	root := moduleRoot(t)
	pkgs := productionPackages(t, root)
	if len(pkgs) == 0 {
		t.Fatal("the audit loaded no source files")
	}
	dirs := make([]string, 0, len(pkgs))
	for dir := range pkgs {
		dirs = append(dirs, dir)
	}
	sort.Strings(dirs)
	var all result
	for _, dir := range dirs {
		found := scan(t, root, dir, pkgs[dir])
		all.writes = append(all.writes, found.writes...)
		all.subprocesses = append(all.subprocesses, found.subprocesses...)
	}
	return all
}

func unexpected(hits []hit, allowed map[string]string) []string {
	var out []string
	for _, h := range hits {
		if _, ok := allowed[h.key]; !ok {
			out = append(out, fmt.Sprintf("%s (%s) at line %d", h.key, h.name, h.line))
		}
	}
	sort.Strings(out)
	return out
}

func stale(hits []hit, allowed map[string]string) []string {
	matched := map[string]bool{}
	for _, h := range hits {
		matched[h.key] = true
	}
	var out []string
	for key := range allowed {
		if !matched[key] {
			out = append(out, key)
		}
	}
	sort.Strings(out)
	return out
}

func TestNoProductionSourceReachesARawFilesystemMutation(t *testing.T) {
	found := audit(t)
	if outside := unexpected(found.writes, allowedWrites); len(outside) > 0 {
		t.Fatalf("raw filesystem mutations outside the chokepoint:\n  %s\n"+
			"Route the write through internal/fsx (WriteFileGuarded, MkdirpGuarded, RmGuarded, "+
			"RenameGuarded, ChmodGuarded, OpenWriteGuarded, WriteFileAtomicGuarded), or argue the "+
			"exception into the allow-list.", strings.Join(outside, "\n  "))
	}
	if dead := stale(found.writes, allowedWrites); len(dead) > 0 {
		t.Fatalf("write allow-list entries matching no symbol (delete them): %s", strings.Join(dead, ", "))
	}
}

func TestEverySubprocessCallIsANamedReasonedException(t *testing.T) {
	found := audit(t)
	if outside := unexpected(found.subprocesses, allowedSubprocesses); len(outside) > 0 {
		t.Fatalf("subprocess calls outside the allow-list:\n  %s\n"+
			"A child process writes wherever it likes; name the caller and say what it runs and "+
			"what it may write.", strings.Join(outside, "\n  "))
	}
	if dead := stale(found.subprocesses, allowedSubprocesses); len(dead) > 0 {
		t.Fatalf("subprocess allow-list entries matching no symbol (delete them): %s", strings.Join(dead, ", "))
	}
}

// The laundering corpus, permanent. Each probe below is a way of reaching a mutator
// that a name-matching scanner misses; they are analyzed by the same code the
// production scan runs, so the audit's reach is asserted rather than assumed. The
// last two are the controls: ordinary calls that share their names with the watched
// surface and must never be flagged.
var probes = []struct {
	name    string
	source  string
	writes  bool
	spawns  bool
	symbol  string // when set, the symbol the hit must be attributed to
	comment string
}{
	{
		name: "closure.go",
		source: `package probe
import "os"
func launderClosure(p string) error {
	clear := func() error { return os.RemoveAll(p) }
	return clear()
}
`,
		writes:  true,
		symbol:  "launderClosure",
		comment: "naming a closure does not move the primitive out of the function that owns it",
	},
	{
		name: "aliased_import.go",
		source: `package probe
import stdos "os"
func launderAlias(p string) error { return stdos.Rename(p, p+".bak") }
`,
		writes:  true,
		comment: "the import name is not the package name",
	},
	{
		name: "function_value.go",
		source: `package probe
import "os"
func launderValue(p string) error {
	mv := os.Rename
	return mv(p, p+".bak")
}
`,
		writes:  true,
		comment: "the mutator is bound to a variable and called through it",
	},
	{
		name: "dot_import.go",
		source: `package probe
import . "os"
func launderDotImport(p string) error { return Rename(p, p+".bak") }
`,
		writes:  true,
		comment: "a dot import puts the bare mutator name in scope",
	},
	{
		name: "struct_field.go",
		source: `package probe
import "os"
type writer struct{ mv func(string, string) error }
func launderField(p string) error {
	w := writer{mv: os.Rename}
	return w.mv(p, p+".bak")
}
`,
		writes:  true,
		comment: "the mutator is stashed in a struct field",
	},
	{
		name: "subprocess.go",
		source: `package probe
import "os/exec"
func launderSpawn() error { return exec.Command("sh", "-c", "echo hi > /tmp/x").Run() }
`,
		spawns:  true,
		comment: "a child process writes whatever it likes",
	},
	{
		name: "fake_readonly_flag.go",
		source: `package probe
import "os"
type flags struct{ O_RDONLY int }
func launderFlag(p string) (*os.File, error) {
	fake := flags{O_RDONLY: os.O_WRONLY | os.O_CREATE}
	return os.OpenFile(p, fake.O_RDONLY, 0o644)
}
`,
		writes:  true,
		symbol:  "launderFlag",
		comment: "a constant merely named O_RDONLY does not make an open read-only",
	},
	{
		name: "negative_shadow.go",
		source: `package probe
type fakeOS struct{}
func (fakeOS) Rename(a, b string) error { return nil }
func (fakeOS) Command(a string) string  { return a }
func notAMutation(a, b string) error {
	os := fakeOS{}
	exec := fakeOS{}
	_ = exec.Command(a)
	return os.Rename(a, b)
}
`,
		comment: "a local value named os or exec is not the package",
	},
	{
		name: "negative_read.go",
		source: `package probe
import (
	"io"
	"os"
)
func readOnly(p string) ([]byte, error) {
	f, err := os.OpenFile(p, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	return io.ReadAll(f)
}
`,
		comment: "a read-only open, and a read helper, are not mutations",
	},
}

func TestTheAnalyzerSeesThroughEveryKnownLaundering(t *testing.T) {
	root := moduleRoot(t)
	dir := filepath.Join(root, "internal", "sourceaudit", "__probe")
	for _, probe := range probes {
		files := map[string]string{filepath.Join(dir, probe.name): probe.source}
		found := scan(t, root, dir, files)
		gotWrites := len(found.writes) > 0
		gotSpawns := len(found.subprocesses) > 0
		if gotWrites != probe.writes {
			t.Fatalf("%s (%s): writes flagged = %v, want %v (%v)", probe.name, probe.comment, gotWrites, probe.writes, found.writes)
		}
		if gotSpawns != probe.spawns {
			t.Fatalf("%s (%s): subprocess flagged = %v, want %v (%v)", probe.name, probe.comment, gotSpawns, probe.spawns, found.subprocesses)
		}
		if probe.symbol != "" && !strings.HasSuffix(found.writes[0].key, "#"+probe.symbol) {
			t.Fatalf("%s (%s): attributed to %q, want the enclosing %q", probe.name, probe.comment, found.writes[0].key, probe.symbol)
		}
	}
}
