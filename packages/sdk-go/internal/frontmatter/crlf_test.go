// CRLF line endings. Mirrors the CRLF block in packages/sdk/test/frontmatter.test.ts:
// a Windows contributor or core.autocrlf=true authors every line with \r\n, and the
// block's last line must keep its whole terminator. Go already read these files
// correctly; these tests pin that, so the three SDKs cannot drift apart again.
package frontmatter_test

import (
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/frontmatter"
	"github.com/leji-org/leji/packages/sdk-go/internal/layer"
	"github.com/leji-org/leji/packages/sdk-go/internal/schemas"
)

// crlf joins lines with CRLF terminators, the way a Windows editor writes a file.
func crlf(lines ...string) string {
	var b strings.Builder
	for _, line := range lines {
		b.WriteString(line)
		b.WriteString("\r\n")
	}
	return b.String()
}

// scanned is the scan result a profile's bytes produce, as scanFrontmatterArtifact builds it.
func scanned(relPath, text string) layer.ScannedProfile {
	fm := frontmatter.Parse(text)
	return layer.ScannedProfile{RelPath: relPath, Frontmatter: fm.Data, Keys: fm.Keys, Body: fm.Body}
}

func TestCRLFLastFieldKeepsNoTrailingCarriageReturn(t *testing.T) {
	fm := frontmatter.Parse(crlf("---", "id: reviewer", "role: reviewer", "---", "", "Body."))
	if fm.Error != "" {
		t.Fatalf("unexpected error: %q", fm.Error)
	}
	if role, ok := fm.Data["role"].(string); !ok || role != "reviewer" {
		t.Fatalf("role should be %q, got %#v", "reviewer", fm.Data["role"])
	}
	if fm.Body != "\r\nBody.\r\n" {
		t.Fatalf("body not preserved: %q", fm.Body)
	}
}

func TestCRLFInheritsLastKeyPassesSchemaAndResolves(t *testing.T) {
	base := scanned("docs/agents/core.md", crlf(
		"---", "id: core", "name: Core", "role: core",
		"requiredRead:", "  - docs/boot-profile.md",
		"mustAskWhen:", "  - always",
		"---", "", "# Core"))
	derived := scanned("docs/agents/reviewer.md", crlf(
		"---", "id: reviewer", "name: Reviewer", "role: reviewer", "inherits: core",
		"---", "", "# Reviewer"))
	if errs := schemas.SchemaErrors("agent-profile", derived.Frontmatter); len(errs) != 0 {
		t.Fatalf("a CRLF profile must carry no schema errors; got %v", errs)
	}
	resolved := layer.ResolveAgentProfile(derived, []layer.ScannedProfile{base, derived})
	if len(resolved.Findings) != 0 {
		t.Fatalf("expected the profile to resolve, got findings %v", resolved.Findings)
	}
	if got := strings.Join(resolved.SourceIDs, ","); got != "core,reviewer" {
		t.Fatalf("sourceIds should be [core reviewer], got %v", resolved.SourceIDs)
	}
}

func TestCRLFBlankLineBeforeClosingFenceParses(t *testing.T) {
	fm := frontmatter.Parse(crlf("---", "id: reviewer", "role: reviewer", "", "---", "", "Body."))
	if fm.Error != "" {
		t.Fatalf("unexpected error: %q", fm.Error)
	}
	if role, ok := fm.Data["role"].(string); !ok || role != "reviewer" {
		t.Fatalf("role should be %q, got %#v", "reviewer", fm.Data["role"])
	}
}

func TestCRLFDecisionRecordReportsSchemaDefectNotYAMLError(t *testing.T) {
	fm := frontmatter.Parse(crlf(
		"---", "id: crlf-record", "title: CRLF record", "date: 2026-07-28", "status: maybe",
		"", "---", "", "Body."))
	if fm.Error != "" {
		t.Fatalf("the YAML error must not mask the schema defect; got %q", fm.Error)
	}
	errs := schemas.SchemaErrors("decision-record", fm.Data)
	if len(errs) != 1 || !strings.HasPrefix(errs[0], "/status ") {
		t.Fatalf("expected the /status schema defect, got %v", errs)
	}
}

func TestLFDocumentsParseIdenticallyWithLFTerminators(t *testing.T) {
	fm := frontmatter.Parse("---\nid: reviewer\nrole: reviewer\n---\n\nBody.\n")
	if fm.Error != "" {
		t.Fatalf("unexpected error: %q", fm.Error)
	}
	if role, ok := fm.Data["role"].(string); !ok || role != "reviewer" {
		t.Fatalf("role should be %q, got %#v", "reviewer", fm.Data["role"])
	}
	if fm.Body != "\nBody.\n" {
		t.Fatalf("body not preserved: %q", fm.Body)
	}
}
