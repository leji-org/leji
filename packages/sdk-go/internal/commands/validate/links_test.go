package validate

// The link gate's read guard, exercised in the package because checkLinks is
// unexported and the observable is which governed documents it read at all.

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/links"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

func writeLinkDoc(t *testing.T, root, rel, content string) {
	t.Helper()
	abs := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// Containment is judged first and existence second, the order the link resolver
// already uses; both checks must pass either way, so what the order has to leave
// unchanged is which governed documents get read. The boot profile is governed
// unconditionally, so it is the one that can be made to resolve out of the root: it
// contributes nothing, while a record inside the root is read and link-checked.
func TestCheckLinksReadsInsideRootAndRefusesAnEscapingDocument(t *testing.T) {
	root := t.TempDir()
	away := t.TempDir()

	const dangling = "# Doc\n\n[gone](missing.md)\n"
	writeLinkDoc(t, root, "docs/decisions/0001-inside.md", dangling)
	if err := os.WriteFile(filepath.Join(away, "outside.md"), []byte(dangling), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	boot := filepath.Join(root, "docs", "boot-profile.md")
	if err := os.Symlink(filepath.Join(away, "outside.md"), boot); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	m := &manifest.Manifest{
		RootPath:        "docs/",
		BootProfilePath: "docs/boot-profile.md",
		Machine:         &manifest.Machine{DecisionRecordsPath: "docs/decisions/"},
	}

	var fs []findings.Finding
	checkLinks(root, m, &fs)

	got := map[string]int{}
	for _, f := range fs {
		if f.Rule == links.UnresolvedRule {
			got[f.Path]++
		}
	}
	if got["docs/decisions/0001-inside.md"] != 1 {
		t.Fatalf("a document inside the root must be read and link-checked: %v", got)
	}
	if got["docs/boot-profile.md"] != 0 {
		t.Fatalf("a governed document resolving out of the root must not be read: %v", got)
	}
}
