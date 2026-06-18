package validate_test

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	initcmd "github.com/leji-org/leji/packages/sdk-go/internal/commands/init"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/validate"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
)

func initLayer(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if _, err := initcmd.InitLayer(initcmd.Options{Dir: dir, Yes: true, Out: io.Discard}); err != nil {
		t.Fatalf("init core layer: %v", err)
	}
	return dir
}

func writeFile(t *testing.T, dir, rel, body string) {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func hasFinding(res validate.Result, rule, path string) bool {
	for _, f := range res.Findings {
		if f.Rule == rule && f.Path == path {
			return true
		}
	}
	return false
}

// The thin-category lint is precise at its boundary: a domain doc with exactly two
// concrete bullets is still flagged content-thin for docs/domain/, but a third
// concrete bullet clears the threshold. Mirrors the Node SDK boundary test.
func TestContentThinCategoryBoundary(t *testing.T) {
	two := initLayer(t)
	writeFile(t, two, "docs/domain/glossary.md", "# Glossary\n\n- Real term one.\n- Real term two.\n")
	if !hasFinding(validate.ValidateLayer(two, true), "content-thin", "docs/domain/") {
		t.Fatal("two concrete bullets should still be content-thin for docs/domain/")
	}

	three := initLayer(t)
	writeFile(t, three, "docs/domain/glossary.md", "# Glossary\n\n- One.\n- Two.\n- Three.\n")
	if hasFinding(validate.ValidateLayer(three, true), "content-thin", "docs/domain/") {
		t.Fatal("three concrete bullets should clear the content-thin threshold")
	}
}

// The placeholder lint catches angle-bracket stubs, not only TODO: markers. A doc
// whose only suspicious text is `<describe an invariant here>` still yields a
// content-placeholder finding. Mirrors the Node SDK placeholder test.
func TestContentPlaceholderAngleBracket(t *testing.T) {
	dir := initLayer(t)
	writeFile(t, dir, "docs/system/invariants.md", "# Invariants\n\n- <describe an invariant here>\n")
	if !hasFinding(validate.ValidateLayer(dir, true), "content-placeholder", "docs/system/invariants.md") {
		t.Fatal("an angle-bracket placeholder should yield a content-placeholder finding for the doc")
	}
}

// The content lint flags owner-unconfirmed inferences: a TODO(confirm-…) marker in
// a category document and a status: proposed decision both yield content-unconfirmed
// findings, the layer stays warning-only (no errors), and the TODO(confirm-…) marker
// does not also trip content-placeholder. Mirrors the Node SDK test.
func TestContentUnconfirmedInferencesAndProposedDecisions(t *testing.T) {
	dir := initLayer(t)
	// An agent-drafted, owner-unconfirmed invariant marker.
	writeFile(t, dir, "docs/system/invariants.md",
		"# System Invariants\n\n- TODO(confirm-invariant): money is integer minor units\n")
	// An agent-proposed decision, not yet owner-accepted.
	writeFile(t, dir, "docs/decisions/0002-proposed.md",
		"---\nid: use-postgres\ntitle: Use Postgres\nstatus: proposed\ndate: 2026-06-18\n---\n\n# Use Postgres\n\n## Context\nx\n## Decision\ny\n## Consequences\nz\n")

	res := validate.ValidateLayer(dir, true)

	if !hasFinding(res, "content-unconfirmed", "docs/system/invariants.md") {
		t.Fatal("the TODO(confirm-…) marker should yield a content-unconfirmed finding")
	}
	proposed := false
	for _, f := range res.Findings {
		if f.Rule == "content-unconfirmed" && strings.Contains(f.Message, "proposed") {
			proposed = true
			break
		}
	}
	if !proposed {
		t.Fatal("the status: proposed decision should yield a content-unconfirmed finding")
	}
	// Warning-only: an unconfirmed layer is not an error.
	for _, f := range res.Findings {
		if f.Severity == findings.Error {
			t.Fatalf("unconfirmed inferences must be warning-only; got error finding %s: %s", f.Rule, f.Message)
		}
	}
	// The TODO(confirm-…) marker must NOT also trip the plain content-placeholder rule.
	if hasFinding(res, "content-placeholder", "docs/system/invariants.md") {
		t.Fatal("TODO(confirm-…) must not also trip content-placeholder")
	}
}
