package sourceaudit

// The declared exception to the ROLE rule, pinned the way the write allow-list is
// pinned: the role rule allows exactly one target that belongs to no role (the
// self-managed `.leji/.gitignore`), and exactly one symbol may say so, by putting the
// MetadataFile field on a layout.TargetVerdict. docs/practice/trust-boundary.md mirrors
// this list. The write allow-list says which symbols may touch the filesystem raw; this
// one says which may declare a target writable that the role rule refuses, and it
// exists for the same reason: an exception nobody can find is an exception nobody is
// checking.
//
// Mirrors packages/sdk/test/source-audit.test.ts (the role-exception pin) and
// packages/sdk-py/tests/test_source_audit_role.py.

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// allowedRoleExceptions is the exception list, by `file#symbol`: the one place a
// MetadataFile verdict may be constructed.
var allowedRoleExceptions = map[string]string{
	"internal/fsx/fsx.go#metadataFileVerdict": "the self-managed .leji/.gitignore: judged on the requested entry, with a real .leji directory and a non-symlink entry, refused otherwise",
}

// roleExceptionField is the field that carries the exception.
const roleExceptionField = "MetadataFile"

// roleVerdictType is the type the field lives on. An UNKEYED composite literal sets
// every field by ORDER and spells no field name at all, so a name-based reader cannot
// see it: any positional literal of this type is therefore a constructor site, whatever
// its arity. Go has no keyword-only struct literal, so the audit is the whole of the
// prevention here, which is why the rule counts positions rather than arguments: the
// sixth is the exception today, and an audit tied to that number would be one field
// away from being wrong.
const roleVerdictType = "TargetVerdict"

// reflectiveSetters are the members that put a field on a value from a NAME given as an
// argument rather than from a field written into a composite literal: the shape
// nothing else in this scan would see. They belong to no other API this repository
// uses, so the member name alone counts and an aliased or embedded receiver is caught
// with it.
var reflectiveSetters = map[string]bool{"FieldByName": true, "FieldByNameFunc": true}

// literalString is the value of a string literal, or "" and false for anything else.
// A name assembled at runtime is the residual stated below, not something to guess at.
func literalString(node ast.Expr) (string, bool) {
	lit, ok := node.(*ast.BasicLit)
	if !ok || lit.Kind != token.STRING {
		return "", false
	}
	value, err := strconv.Unquote(lit.Value)
	if err != nil {
		return "", false
	}
	return value, true
}

// jsonSpellsField reports whether a string is a JSON DOCUMENT carrying the field as a
// key, at any depth. The text is parsed rather than substring-matched, deliberately: a
// literal that merely NAMES the field (an error message, a comment, this audit's own
// constant) creates nothing and must not be flagged, while `{"MetadataFile":true}`
// handed to a decoder creates exactly the thing this pin is about.
func jsonSpellsField(text string) bool {
	var parsed any
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		return false
	}
	var walk func(any) bool
	walk = func(value any) bool {
		switch v := value.(type) {
		case map[string]any:
			if _, ok := v[roleExceptionField]; ok {
				return true
			}
			for _, member := range v {
				if walk(member) {
					return true
				}
			}
		case []any:
			for _, member := range v {
				if walk(member) {
					return true
				}
			}
		}
		return false
	}
	return walk(parsed)
}

// roleExceptions is every CONSTRUCTION of the metadata-file verdict in one file, keyed
// `file#symbol`.
//
// A field can be put on a value in a bounded number of statically named ways, and all
// of them count: written into a composite literal as a keyed field; assigned onto a
// value afterwards by selector, in any form of assignment; spelled as a map literal's
// key; handed to a reflective setter as a field NAME; or carried as a key inside a JSON
// document literal a decoder is given.
//
// And one way that spells no name at all: an UNKEYED composite literal of the verdict
// type, `layout.TargetVerdict{true, "", false, false, false, true}`, which sets fields
// by ORDER. Go offers no keyword-only struct, so this audit is the whole of the
// prevention: EVERY positional literal of the type is recorded as a constructor site,
// whatever its arity and whatever the sixth element happens to be. That is deliberately
// blunt (the alternative, reading the element at the exception's index, would silently
// stop working the day a field is inserted above it), and it costs nothing, because a
// keyed literal is the only form this SDK writes.
//
// The NAME is what decides for the keyed forms, never the value's type: a verdict built
// through an `any`, or on a shape no type check can relate to layout.TargetVerdict, must
// fail this audit rather than slip through it. Reflective forms compile where a direct
// assignment would not (an unexported or shadowed field), which is exactly why they are
// audited here rather than left to the compiler.
//
// READING the field is not constructing it, so a plain `verdict.MetadataFile` test is
// deliberately not a hit; only positions that create it are.
//
// THE RESIDUAL, stated exactly. One class remains outside, and only one: a field name
// ASSEMBLED AT RUNTIME, so that no single string can be read for it statically: a
// concatenation ("Metadata" + "File"), a formatted string, a variable this reader
// cannot narrow to one literal, a value read from data. Every such site is invisible to
// any static audit, this one included; its closure is human, through
// docs/practice/trust-boundary.md and the diff review. Positional construction was once
// in this list and is not any more: the unkeyed-literal rule below flags it.
func roleExceptions(rel string, file *ast.File, fset *token.FileSet) []hit {
	var hits []hit
	seen := map[token.Pos]bool{}
	record := func(node ast.Node, spelling string) {
		if seen[node.Pos()] {
			return
		}
		seen[node.Pos()] = true
		hits = append(hits, hit{
			key:  rel + "#" + enclosingSymbol(file, node),
			line: fset.Position(node.Pos()).Line,
			name: spelling,
		})
	}
	ast.Inspect(file, func(n ast.Node) bool {
		switch node := n.(type) {
		// Written into a composite literal: `TargetVerdict{MetadataFile: true}`, or
		// spelled as a map literal's key: `{"MetadataFile": true}`.
		case *ast.KeyValueExpr:
			if ident, ok := node.Key.(*ast.Ident); ok && ident.Name == roleExceptionField {
				record(node, "field")
			}
			if text, ok := literalString(node.Key); ok && text == roleExceptionField {
				record(node, "map key")
			}
		// Assigned onto a value afterwards, in every form of assignment operator.
		case *ast.AssignStmt:
			for _, target := range node.Lhs {
				sel, ok := target.(*ast.SelectorExpr)
				if ok && sel.Sel.Name == roleExceptionField {
					record(node, "assignment")
				}
			}
		// Handed to a reflective setter as a field NAME, or carried as a key inside a
		// JSON document literal.
		case *ast.CallExpr:
			if sel, ok := node.Fun.(*ast.SelectorExpr); ok && reflectiveSetters[sel.Sel.Name] {
				if len(node.Args) > 0 {
					if text, ok := literalString(node.Args[0]); ok && text == roleExceptionField {
						record(node, "reflect."+sel.Sel.Name)
					}
				}
			}
		case *ast.BasicLit:
			if text, ok := literalString(node); ok && jsonSpellsField(text) {
				record(node, "JSON document")
			}
		// Built positionally, with no field name anywhere: an unkeyed literal of the
		// verdict type. An empty `TargetVerdict{}` names nothing and sets nothing, so it
		// is not one; anything with an element that is not a key/value pair is. Inside a
		// container of verdicts the element literals may elide their type entirely
		// (`[]layout.TargetVerdict{{…}}`), so the container hands its element type down.
		case *ast.CompositeLit:
			if structLitName(node.Type) == roleVerdictType && positional(node) {
				record(node, "positional literal")
			}
			if elementTypeName(node.Type) == roleVerdictType {
				for _, element := range node.Elts {
					if keyed, ok := element.(*ast.KeyValueExpr); ok {
						element = keyed.Value
					}
					elided, ok := element.(*ast.CompositeLit)
					if ok && elided.Type == nil && positional(elided) {
						record(elided, "positional literal")
					}
				}
			}
		}
		return true
	})
	return hits
}

// positional reports whether a composite literal sets any field by ORDER rather than by
// name. An empty literal sets nothing and is not positional.
func positional(node *ast.CompositeLit) bool {
	for _, element := range node.Elts {
		if _, keyed := element.(*ast.KeyValueExpr); !keyed {
			return true
		}
	}
	return false
}

// structLitName is the STRUCT type a literal names: `TargetVerdict` for both the bare
// and the qualified `layout.TargetVerdict` spelling (`&T{…}` reaches here too, since the
// address-of wraps the literal rather than its type). "" for a nil type or a container.
func structLitName(expr ast.Expr) string {
	switch typed := expr.(type) {
	case *ast.Ident:
		return typed.Name
	case *ast.SelectorExpr:
		return typed.Sel.Name
	}
	return ""
}

// elementTypeName is the struct type a CONTAINER literal holds (the element of a slice
// or array, the value of a map, through a pointer element), so a literal that elides its
// own type can still be attributed to it. "" when the type is not a container of structs.
func elementTypeName(expr ast.Expr) string {
	switch typed := expr.(type) {
	case *ast.ArrayType:
		return elementOrStruct(typed.Elt)
	case *ast.MapType:
		return elementOrStruct(typed.Value)
	}
	return ""
}

func elementOrStruct(expr ast.Expr) string {
	if star, ok := expr.(*ast.StarExpr); ok {
		return structLitName(star.X)
	}
	return structLitName(expr)
}

// roleScan parses one directory's files and returns every metadata-file construction in
// them. No type check: unlike the write surface, which is about which PACKAGE a call
// belongs to, this one is about a field NAME, and a name is what the syntax already
// carries.
func roleScan(t *testing.T, moduleRoot string, files map[string]string) []hit {
	t.Helper()
	fset := token.NewFileSet()
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	var hits []hit
	for _, name := range names {
		file, err := parser.ParseFile(fset, name, files[name], parser.SkipObjectResolution)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		rel, rerr := filepath.Rel(moduleRoot, fset.Position(file.Package).Filename)
		if rerr != nil {
			t.Fatal(rerr)
		}
		hits = append(hits, roleExceptions(filepath.ToSlash(rel), file, fset)...)
	}
	return hits
}

func roleAudit(t *testing.T) []hit {
	t.Helper()
	root := moduleRoot(t)
	pkgs := productionPackages(t, root)
	if len(pkgs) == 0 {
		t.Fatal("the role audit loaded no source files")
	}
	dirs := make([]string, 0, len(pkgs))
	for dir := range pkgs {
		dirs = append(dirs, dir)
	}
	sort.Strings(dirs)
	var all []hit
	for _, dir := range dirs {
		all = append(all, roleScan(t, root, pkgs[dir])...)
	}
	return all
}

func TestSourceAuditMetadataFileVerdictHasOneConstructorSite(t *testing.T) {
	hits := roleAudit(t)
	if outside := unexpected(hits, allowedRoleExceptions); len(outside) > 0 {
		t.Fatalf("a metadata-file verdict is constructed outside the declared exception:\n  %s\n"+
			"The role rule allows one target that belongs to no role; argue any other into the "+
			"list, or route the write through its own role.", strings.Join(outside, "\n  "))
	}
	if dead := stale(hits, allowedRoleExceptions); len(dead) > 0 {
		t.Fatalf("role-exception entries matching no symbol (delete them): %s", strings.Join(dead, ", "))
	}
	if len(hits) != len(allowedRoleExceptions) {
		t.Fatalf("one construction, not several at one site: %d hits for %d entries", len(hits), len(allowedRoleExceptions))
	}
}

// The role-exception laundering corpus, permanent. Each probe is another way of putting
// MetadataFile on a verdict, and each must be flagged: the promise the single-constructor
// pin makes is that a SECOND exception cannot be added quietly, so every spelling a
// second one could take is asserted here rather than assumed. The last probe is the
// control: a longer, unrelated field that merely starts with the same letters, together
// with an ordinary READ of the field, which must never be flagged.
var roleProbes = []struct {
	name    string
	source  string
	flagged bool
	symbol  string // when set, the symbol the hit must be attributed to
	comment string
}{
	{
		name: "composite_literal.go",
		source: `package probe
import "github.com/leji-org/leji/packages/sdk-go/internal/layout"
func launderCompositeLiteral() layout.TargetVerdict {
	return layout.TargetVerdict{OK: true, MetadataFile: true}
}
`,
		flagged: true,
		symbol:  "launderCompositeLiteral",
		comment: "the field written straight into the struct literal",
	},
	{
		name: "positional_literal.go",
		source: `package probe
import "github.com/leji-org/leji/packages/sdk-go/internal/layout"
func launderPositional() layout.TargetVerdict {
	return layout.TargetVerdict{true, "", false, false, false, true}
}
`,
		flagged: true,
		symbol:  "launderPositional",
		comment: "the review's own probe: every field set by order, the exception's name spelled nowhere",
	},
	{
		name: "positional_literal_addressed.go",
		source: `package probe
import "github.com/leji-org/leji/packages/sdk-go/internal/layout"
func launderPositionalPointer() *layout.TargetVerdict {
	return &layout.TargetVerdict{true, "", false, false, false, true}
}
`,
		flagged: true,
		symbol:  "launderPositionalPointer",
		comment: "the same literal behind an address-of",
	},
	{
		name: "positional_literal_elided.go",
		source: `package probe
import "github.com/leji-org/leji/packages/sdk-go/internal/layout"
func launderPositionalElided() layout.TargetVerdict {
	all := []layout.TargetVerdict{{true, "", false, false, false, true}}
	return all[0]
}
`,
		flagged: true,
		symbol:  "launderPositionalElided",
		comment: "an element literal inside a container of verdicts, eliding its own type",
	},
	{
		name: "closure_literal.go",
		source: `package probe
import "github.com/leji-org/leji/packages/sdk-go/internal/layout"
func launderClosure() layout.TargetVerdict {
	build := func() layout.TargetVerdict { return layout.TargetVerdict{MetadataFile: true} }
	return build()
}
`,
		flagged: true,
		symbol:  "launderClosure",
		comment: "naming a closure does not move the construction out of the function that owns it",
	},
	{
		name: "assignment.go",
		source: `package probe
import "github.com/leji-org/leji/packages/sdk-go/internal/layout"
func launderAssignment() layout.TargetVerdict {
	v := layout.TargetVerdict{OK: true}
	v.MetadataFile = true
	return v
}
`,
		flagged: true,
		symbol:  "launderAssignment",
		comment: "the field assigned onto the value afterwards",
	},
	{
		name: "pointer_assignment.go",
		source: `package probe
import "github.com/leji-org/leji/packages/sdk-go/internal/layout"
func launderPointer(v *layout.TargetVerdict) {
	v.MetadataFile = true
}
`,
		flagged: true,
		symbol:  "launderPointer",
		comment: "the same assignment through a pointer receiver",
	},
	{
		name: "map_key.go",
		source: `package probe
func launderMapKey() map[string]bool {
	return map[string]bool{"OK": true, "MetadataFile": true}
}
`,
		flagged: true,
		symbol:  "launderMapKey",
		comment: "the field spelled as a map literal's key, for a decoder to apply",
	},
	{
		name: "reflect_set.go",
		source: `package probe
import (
	"reflect"

	"github.com/leji-org/leji/packages/sdk-go/internal/layout"
)
func launderReflect() layout.TargetVerdict {
	v := layout.TargetVerdict{OK: true}
	reflect.ValueOf(&v).Elem().FieldByName("MetadataFile").SetBool(true)
	return v
}
`,
		flagged: true,
		symbol:  "launderReflect",
		comment: "the field set reflectively, from a name no compiler check sees",
	},
	{
		name: "json_document.go",
		source: `package probe
import (
	"encoding/json"

	"github.com/leji-org/leji/packages/sdk-go/internal/layout"
)
func launderJSON() layout.TargetVerdict {
	var v layout.TargetVerdict
	_ = json.Unmarshal([]byte("{\"OK\":true,\"MetadataFile\":true}"), &v)
	return v
}
`,
		flagged: true,
		symbol:  "launderJSON",
		comment: "the field carried as a key inside a JSON document literal",
	},
	{
		name: "negative.go",
		source: `package probe
import "github.com/leji-org/leji/packages/sdk-go/internal/layout"
type unrelated struct{ MetadataFileName string }
func notTheException(v layout.TargetVerdict) unrelated {
	other := unrelated{MetadataFileName: "x"}
	other.MetadataFileName = "y"
	if v.MetadataFile {
		other.MetadataFileName = "read"
	}
	message := "MetadataFile is the one exception the role rule allows"
	if len(message) == 0 {
		other.MetadataFileName = message
	}
	return other
}
`,
		flagged: false,
		comment: "a longer, unrelated field name, and an ordinary READ of the field, are not constructions",
	},
	{
		name: "negative_keyed_and_empty.go",
		source: `package probe
import "github.com/leji-org/leji/packages/sdk-go/internal/layout"
type other struct{ A, B bool }
func ordinary() (layout.TargetVerdict, layout.TargetVerdict, other) {
	return layout.TargetVerdict{OK: true}, layout.TargetVerdict{}, other{true, false}
}
`,
		flagged: false,
		comment: "keyed and empty verdict literals, and a positional literal of some OTHER type, are not constructions",
	},
}

func TestSourceAuditMetadataFilePinSeesThroughEverySpelling(t *testing.T) {
	root := moduleRoot(t)
	dir := filepath.Join(root, "internal", "sourceaudit", "__role_probe")
	for _, probe := range roleProbes {
		hits := roleScan(t, root, map[string]string{filepath.Join(dir, probe.name): probe.source})
		got := len(hits) > 0
		if got != probe.flagged {
			t.Fatalf("%s (%s): flagged = %v, want %v (%v)", probe.name, probe.comment, got, probe.flagged, hits)
		}
		if probe.symbol != "" && !strings.HasSuffix(hits[0].key, "#"+probe.symbol) {
			t.Fatalf("%s (%s): attributed to %q, want the enclosing %q",
				probe.name, probe.comment, hits[0].key, probe.symbol)
		}
	}
}
