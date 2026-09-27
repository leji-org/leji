package validate_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/validate"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
)

// A .leji/ under the context root is one legacy-leji-dir warning, never the root tree.
func TestLegacyLejiDirIsOneWarningNeverTheRootTree(t *testing.T) {
	legacy := []findings.Finding{findings.New("legacy-leji-dir", findings.Warning,
		"`docs/.leji` is the tool tree's location before Leji 1.4.0; the current tooling keeps its state under the root `.leji/` and writes nothing here. Delete it (run `git rm -r --cached docs/.leji` first if it is tracked).",
		"docs/.leji")}
	all := func(dir string) []findings.Finding {
		t.Helper()
		res, err := validate.ValidateLayer(dir, false)
		if err != nil {
			t.Fatal(err)
		}
		return res.Findings
	}
	legacyOf := func(dir string) []findings.Finding {
		t.Helper()
		var out []findings.Finding
		for _, f := range all(dir) {
			if f.Rule == "legacy-leji-dir" {
				out = append(out, f)
			}
		}
		return out
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}

	dir := gitSeedExample(t) // rootPath docs/, validates with no findings
	oldTree := filepath.Join(dir, "docs", ".leji")
	rootTree := filepath.Join(dir, ".leji")
	// The copy is of the working tree, so a local docs/.leji must not decide the start.
	must(os.RemoveAll(oldTree))
	if got := all(dir); len(got) != 0 {
		t.Fatalf("baseline: want no findings, got %v", got)
	}
	must(os.MkdirAll(oldTree, 0o755))
	must(os.WriteFile(filepath.Join(oldTree, "x"), nil, 0o644))
	// The migration case: the old tree present, the root tree not yet created.
	if got := all(dir); !reflect.DeepEqual(got, legacy) {
		t.Fatalf("root .leji/ absent: got %v", got)
	}
	// An unresolvable root side is a different tree, never a failure: a dangling
	// symlink, and a symlink loop the resolver refuses.
	must(os.Symlink("gone", rootTree))
	if got := all(dir); !reflect.DeepEqual(got, legacy) {
		t.Fatalf("root .leji a dangling symlink: got %v", got)
	}
	must(os.Remove(rootTree))
	must(os.Symlink(".leji", rootTree))
	if got := all(dir); !reflect.DeepEqual(got, legacy) {
		t.Fatalf("root .leji a symlink loop: got %v", got)
	}
	must(os.Remove(rootTree))
	must(os.Mkdir(rootTree, 0o755))
	if got := all(dir); !reflect.DeepEqual(got, legacy) {
		t.Fatalf("root .leji/ present: got %v", got)
	}
	must(os.RemoveAll(oldTree))
	if got := legacyOf(dir); len(got) != 0 {
		t.Fatalf("removed: got %v", got)
	}
	// A symlink to the root tree is the live tree, not a leftover.
	must(os.Symlink(filepath.Join("..", ".leji"), oldTree))
	if got := legacyOf(dir); len(got) != 0 {
		t.Fatalf("symlink to the root .leji/: got %v", got)
	}
	// A repository-root context: the root .leji/ is the live tree.
	must(os.Remove(oldTree))
	manifestPath := filepath.Join(dir, "leji.json")
	b, err := os.ReadFile(manifestPath)
	must(err)
	var m map[string]any
	must(json.Unmarshal(b, &m))
	m["rootPath"] = "."
	b, _ = json.MarshalIndent(m, "", "  ")
	must(os.WriteFile(manifestPath, append(b, '\n'), 0o644))
	if got := legacyOf(dir); len(got) != 0 {
		t.Fatalf("rootPath '.': got %v", got)
	}
}
