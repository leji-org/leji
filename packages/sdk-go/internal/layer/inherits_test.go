// Single-level profile inheritance. Mirrors packages/sdk/test/inherits.test.ts.
package layer_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/layer"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
	"github.com/leji-org/leji/packages/sdk-go/internal/schemas"
)

// profileLayer seeds the smallest layer that carries agent profiles: a manifest
// declaring an agents dir, plus the given profile files under it.
func profileLayer(t *testing.T, profiles map[string]string) (string, *manifest.Manifest) {
	t.Helper()
	dir := t.TempDir()
	write := func(rel, body string) {
		abs := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", rel, err)
		}
		if err := os.WriteFile(abs, []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}
	write("leji.json", `{
  "leji": "1.0",
  "name": "demo",
  "rootPath": "docs/",
  "bootProfilePath": "docs/boot-profile.md",
  "categories": {
    "domain": {
      "indexes": [
        "docs/context/domain.md"
      ]
    }
  },
  "machine": {
    "agentProfilesPath": "docs/agents/"
  },
  "owners": {
    "primary": {
      "name": "Owner"
    }
  }
}
`)
	write("docs/boot-profile.md", "# Boot\n")
	write("docs/context/domain.md", "# Domain\n\n```leji-index\n- path: docs/domain/overview.md\n```\n")
	write("docs/domain/overview.md", "# Overview\n")
	for rel, body := range profiles {
		write(rel, body)
	}
	load := manifest.LoadManifest(dir)
	if load.Manifest == nil {
		t.Fatalf("manifest failed to load: %v", load.Findings)
	}
	return dir, load.Manifest
}

const coreProfile = `---
id: core
name: Agent Core
role: core
requiredRead:
  - docs/boot-profile.md
mustAskWhen:
  - the change reverses a recorded decision
---

# Core

Shared posture.
`

// The conditional-required rule is a schema `if`/`then`: a profile that declares
// `inherits` may omit requiredRead and mustAskWhen. The Go validator must read the
// same conditional as ajv does, so the fixture proves both branches.
func TestAgentProfileSchemaConditionalRequired(t *testing.T) {
	inheriting := map[string]any{"id": "reviewer", "name": "Reviewer", "role": "reviewer", "inherits": "core"}
	if errs := schemas.SchemaErrors("agent-profile", inheriting); len(errs) != 0 {
		t.Fatalf("an inheriting profile may omit the posture arrays; got %v", errs)
	}
	standalone := map[string]any{"id": "reviewer", "name": "Reviewer", "role": "reviewer"}
	if errs := schemas.SchemaErrors("agent-profile", standalone); len(errs) == 0 {
		t.Fatalf("a standalone profile must still declare requiredRead and mustAskWhen")
	}
}

func TestResolveAgentProfileComposesPostureBaseFirstAndBothBodies(t *testing.T) {
	dir, m := profileLayer(t, map[string]string{
		"docs/agents/core.md": coreProfile,
		"docs/agents/reviewer.md": `---
id: reviewer
name: Reviewer
role: reviewer
inherits: core
requiredRead:
  - docs/boot-profile.md
  - docs/system/invariants.md
mustAskWhen:
  - the change touches settlement math
---

# Reviewer

Narrow posture.
`,
	})
	profiles := layer.ScanProfileSet(dir, m)
	var derived layer.ScannedProfile
	for _, p := range profiles {
		if p.RelPath == "docs/agents/reviewer.md" {
			derived = p
		}
	}
	resolved := layer.ResolveAgentProfile(derived, profiles)
	if resolved.Body == nil || len(resolved.Findings) != 0 {
		t.Fatalf("resolution refused: %+v", resolved.Findings)
	}
	// Base entries in authored order, then the derived entries the base does not
	// already carry: the shared boot profile collapses to one.
	required, _ := resolved.Frontmatter["requiredRead"].([]any)
	if len(required) != 2 || required[0] != "docs/boot-profile.md" || required[1] != "docs/system/invariants.md" {
		t.Fatalf("requiredRead = %v", required)
	}
	ask, _ := resolved.Frontmatter["mustAskWhen"].([]any)
	if len(ask) != 2 || ask[0] != "the change reverses a recorded decision" {
		t.Fatalf("mustAskWhen = %v", ask)
	}
	if _, present := resolved.Frontmatter["inherits"]; present {
		t.Fatalf("inherits is a resolution directive, never effective frontmatter")
	}
	want := "<!-- inherited from: core -->\n\n# Core\n\nShared posture.\n\n<!-- reviewer -->\n\n# Reviewer\n\nNarrow posture.\n"
	if *resolved.Body != want {
		t.Fatalf("body = %q", *resolved.Body)
	}
	if strings.Join(resolved.SourceIDs, ",") != "core,reviewer" {
		t.Fatalf("sourceIds = %v", resolved.SourceIDs)
	}
}

func TestProfileInheritanceFindingsReportEachUnresolvableEdgeOnce(t *testing.T) {
	cases := []struct {
		what     string
		profiles map[string]string
		rule     string
	}{
		{
			what:     "an unknown target is an error, not a warning",
			profiles: map[string]string{"docs/agents/reviewer.md": "---\nid: reviewer\nname: Reviewer\nrole: reviewer\ninherits: missing\n---\n\n# R\n"},
			rule:     "inherits-unknown",
		},
		{
			what: "a base that is not core",
			profiles: map[string]string{
				"docs/agents/core.md":     coreProfile,
				"docs/agents/other.md":    "---\nid: other\nname: Other\nrole: other\nrequiredRead:\n  - docs/boot-profile.md\nmustAskWhen:\n  - x\n---\n\n# O\n",
				"docs/agents/reviewer.md": "---\nid: reviewer\nname: Reviewer\nrole: reviewer\ninherits: other\n---\n\n# R\n",
			},
			rule: "inherits-target-not-core",
		},
		{
			what: "a core profile that itself inherits",
			profiles: map[string]string{
				"docs/agents/core.md": "---\nid: core\nname: Core\nrole: core\ninherits: base\nrequiredRead:\n  - docs/boot-profile.md\nmustAskWhen:\n  - x\n---\n\n# C\n",
			},
			rule: "inherits-on-core",
		},
		{
			what: "an ambiguous target",
			profiles: map[string]string{
				"docs/agents/core.md":     coreProfile,
				"docs/agents/core-2.md":   coreProfile,
				"docs/agents/reviewer.md": "---\nid: reviewer\nname: Reviewer\nrole: reviewer\ninherits: core\n---\n\n# R\n",
			},
			rule: "inherits-ambiguous-target",
		},
	}
	for _, c := range cases {
		dir, m := profileLayer(t, c.profiles)
		fs := layer.ProfileInheritanceFindings(layer.ScanProfileSet(dir, m))
		found := false
		for _, f := range fs {
			if f.Rule == c.rule && f.Severity == "error" {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s: findings = %+v", c.what, fs)
		}
	}
}
