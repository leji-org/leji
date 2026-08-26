package conformancetest

// The structural half of the snapshot contract: the badge and canary suites hold one
// tree-snapshot helper between them, and a private walker must not be able to grow back
// beside it. A walker needs a directory-enumeration primitive, so this audit counts
// every reference to one in those two files and compares the counts against the named
// exceptions below. The claim is bounded and mechanical: it prevents a walker built on
// the primitives below, whatever it is named and whether it is a function or a closure.
// It claims nothing about a walker built on anything else; that wider closure is review
// of the call sites, not this scan.
//
// Mirrors packages/sdk/test/snapshot-audit.test.ts, whose shape this keeps: names, an
// exception table carrying a COUNT and a reason per context, and a scan over the parsed
// source, so a primitive named in a comment or in ordinary prose is not a hit (the
// parse takes no comments), and a name reached through a string is (the name has to be
// spelled somewhere for the primitive to be reached, as an identifier or as a string).

import (
	"fmt"
	"go/ast"
	"go/parser"
	gotoken "go/token"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// The names this audit is bounded to: Go's directory-enumeration calls, in every
// spelling: `os.ReadDir`, `filepath.Walk`, `filepath.WalkDir`, `ioutil.ReadDir`, and
// the `os.File` methods `ReadDir`, `Readdir` and `Readdirnames`. A walker built on any
// of them has to spell one of these selectors, whatever it calls itself. A walker built
// on something else (`os/fs.Glob`, a dependency, a shelled-out `find`) spells none of
// them and is outside the mechanical guarantee.
var snapshotAuditPrimitives = map[string]bool{
	"ReadDir":      true,
	"Walk":         true,
	"WalkDir":      true,
	"Readdir":      true,
	"Readdirnames": true,
}

// The shared helper, as the two files must call it (Go has no import to check: the
// helper is package-level in snapshot_test.go, so the call is the whole evidence).
const snapshotAuditHelper = "snapshotTree"

var snapshotAuditFiles = []string{"badge_test.go", "canary_test.go"}

type snapshotAuditException struct {
	count  int
	reason string
}

// The exceptions, by `file#context` with the number of references each context is
// allowed. A count rather than a bare name, so a new reference fails even inside a
// context that already holds one; a context that no longer matches fails too, because a
// stale exception is an exception nobody is checking. `context` is the nearest named
// function, or the name the enclosing closure is bound to.
var snapshotAuditAllowed = map[string]snapshotAuditException{
	"badge_test.go#TestBadgeRefusesAParentResolvingOutsideTheRepository": {
		count:  1,
		reason: "lists an out-of-repository directory to prove nothing was created there; one level, no walk",
	},
	"badge_test.go#TestBadgeRefusesAParentResolvingIntoLejiAtAnyDepth": {
		count:  1,
		reason: "asserts the private role is still empty; one level, no walk",
	},
	"canary_test.go#copySeed": {
		count:  1,
		reason: "the seed materializer: copies a committed seed into its declared target",
	},
	"canary_test.go#cpTree": {
		count:  1,
		reason: "the fixture copier: a working copy of a committed fixture, files and directories only",
	},
	"canary_test.go#walk": {
		count:  1,
		reason: "the canary token scan inside countToken: reads bytes, records no tree",
	},
	"canary_test.go#TestCheckBeforeActOutOfRepositoryViewerOrDistAliasIsRefused": {
		count:  2,
		reason: "asserts two out-of-tree destinations are empty; one level each, no walk",
	},
}

func snapshotAuditParse(t *testing.T, name string) (*gotoken.FileSet, *ast.File) {
	t.Helper()
	fset := gotoken.NewFileSet()
	// Mode 0: comments are not attached, so a primitive named in prose is not a hit.
	file, err := parser.ParseFile(fset, filepath.Join(".", name), nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	return fset, file
}

// snapshotAuditContext is the nearest named function containing the node, or the name
// the enclosing closure is bound to, or the subtest it sits in: what a reviewer would
// cite when arguing the exception. `stack` is the node's ancestors, outermost first.
func snapshotAuditContext(stack []ast.Node) string {
	for i := len(stack) - 1; i >= 0; i-- {
		switch n := stack[i].(type) {
		case *ast.FuncDecl:
			return n.Name.Name
		case *ast.FuncLit:
			if i == 0 {
				continue
			}
			switch parent := stack[i-1].(type) {
			case *ast.AssignStmt:
				for j, rhs := range parent.Rhs {
					if lit, ok := rhs.(*ast.FuncLit); ok && lit == n && j < len(parent.Lhs) {
						if id, ok := parent.Lhs[j].(*ast.Ident); ok {
							return id.Name
						}
					}
				}
			case *ast.ValueSpec:
				for j, value := range parent.Values {
					if lit, ok := value.(*ast.FuncLit); ok && lit == n && j < len(parent.Names) {
						return parent.Names[j].Name
					}
				}
			}
		case *ast.CallExpr:
			// A subtest, named the way `t.Run` names it.
			if sel, ok := n.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "Run" && len(n.Args) > 0 {
				if lit, ok := n.Args[0].(*ast.BasicLit); ok && lit.Kind == gotoken.STRING {
					if title, err := strconv.Unquote(lit.Value); err == nil {
						return "t.Run: " + title
					}
				}
			}
		}
	}
	return "(top level)"
}

// snapshotAuditSpelled is how a node spells a name: an identifier (which is also how a
// selector's `.ReadDir` half arrives) or a string literal.
func snapshotAuditSpelled(n ast.Node) (string, bool) {
	switch node := n.(type) {
	case *ast.Ident:
		return node.Name, true
	case *ast.BasicLit:
		if node.Kind != gotoken.STRING {
			return "", false
		}
		value, err := strconv.Unquote(node.Value)
		if err != nil {
			return "", false
		}
		return value, true
	}
	return "", false
}

// snapshotAuditReferences is every reference to an enumeration primitive in one file, as
// `file#context` keys with their counts, plus the line of each for the failure message.
func snapshotAuditReferences(t *testing.T, name string) (map[string]int, []string) {
	t.Helper()
	fset, file := snapshotAuditParse(t, name)
	counts := map[string]int{}
	var where []string
	var stack []ast.Node
	ast.Inspect(file, func(n ast.Node) bool {
		if n == nil {
			stack = stack[:len(stack)-1]
			return false
		}
		if spelled, ok := snapshotAuditSpelled(n); ok && snapshotAuditPrimitives[spelled] {
			key := name + "#" + snapshotAuditContext(stack)
			counts[key]++
			where = append(where, fmt.Sprintf("%s:%d %s", name, fset.Position(n.Pos()).Line, key))
		}
		stack = append(stack, n)
		return true
	})
	return counts, where
}

func TestNoPrivateTreeWalkerInTheBadgeAndCanarySuites(t *testing.T) {
	counts := map[string]int{}
	var where []string
	for _, name := range snapshotAuditFiles {
		found, foundWhere := snapshotAuditReferences(t, name)
		for key, count := range found {
			counts[key] = count
		}
		where = append(where, foundWhere...)
	}

	var keys []string
	for key := range counts {
		keys = append(keys, key)
	}
	for key := range snapshotAuditAllowed {
		if _, seen := counts[key]; !seen {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)

	var problems []string
	for _, key := range keys {
		allowed := snapshotAuditAllowed[key]
		if counts[key] == allowed.count {
			continue
		}
		reason := allowed.reason
		if reason == "" {
			reason = "no exception names this context"
		}
		problems = append(problems, fmt.Sprintf("  %s: found %d, %d allowed (%s)", key, counts[key], allowed.count, reason))
	}
	if len(problems) > 0 {
		sort.Strings(where)
		t.Fatalf("a directory-enumeration primitive appeared where no exception allows it, "+
			"or an exception no longer matches:\n%s\nEvery reference found:\n%s",
			strings.Join(problems, "\n"), strings.Join(where, "\n"))
	}
}

func TestBadgeAndCanarySuitesTakeTheirSnapshotsFromTheSharedHelper(t *testing.T) {
	for _, name := range snapshotAuditFiles {
		_, file := snapshotAuditParse(t, name)
		calls := 0
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			if id, ok := call.Fun.(*ast.Ident); ok && id.Name == snapshotAuditHelper {
				calls++
			}
			return true
		})
		if calls == 0 {
			t.Fatalf("%s must call %s", name, snapshotAuditHelper)
		}
	}
}
