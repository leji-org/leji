package schemas

import (
	"strings"
	"testing"
)

func TestLoadCliSpec(t *testing.T) {
	spec, err := LoadCliSpec()
	if err != nil {
		t.Fatalf("LoadCliSpec: %v", err)
	}
	if spec.Name == "" {
		t.Fatalf("cli spec name empty")
	}
	if len(spec.Commands) == 0 {
		t.Fatalf("expected at least one command in cli spec")
	}
}

func TestSchemaErrorsValidManifest(t *testing.T) {
	data := map[string]any{
		"leji":            "1.0",
		"name":            "x",
		"rootPath":        "docs/",
		"bootProfilePath": "docs/boot-profile.md",
		"categories":      map[string]any{"domain": map[string]any{"paths": []any{"docs/domain/"}}},
		"owners":          map[string]any{"primary": map[string]any{"name": "Jo"}},
	}
	if errs := SchemaErrors("context-manifest", data); len(errs) != 0 {
		t.Fatalf("valid manifest should have no errors, got %v", errs)
	}
}

func TestSchemaErrorsReportsViolations(t *testing.T) {
	// Missing required fields should produce one error per real violation.
	data := map[string]any{"leji": "1.0"}
	errs := SchemaErrors("context-manifest", data)
	if len(errs) == 0 {
		t.Fatalf("expected schema errors for incomplete manifest")
	}
	// Errors are sorted deterministically by instance path then message.
	for i := 1; i < len(errs); i++ {
		if errs[i] < errs[i-1] {
			t.Fatalf("errors not deterministically ordered: %v", errs)
		}
	}
}

func TestSchemaErrorsUnknownSchema(t *testing.T) {
	errs := SchemaErrors("does-not-exist", map[string]any{})
	if len(errs) != 1 || !strings.Contains(errs[0], "schema unavailable") {
		t.Fatalf("expected schema-unavailable error, got %v", errs)
	}
}

func TestSchemaErrorsECMARegexPattern(t *testing.T) {
	// rootPath uses an ECMAScript lookahead pattern that Go's RE2 cannot
	// compile; this exercises the dlclark/regexp2 engine path. A leading-slash
	// or "./" path must be rejected.
	bad := map[string]any{
		"leji":            "1.0",
		"name":            "x",
		"rootPath":        "/absolute/path",
		"bootProfilePath": "docs/boot-profile.md",
		"categories":      map[string]any{"domain": map[string]any{"paths": []any{"docs/"}}},
		"owners":          map[string]any{"primary": map[string]any{"name": "Jo"}},
	}
	errs := SchemaErrors("context-manifest", bad)
	if len(errs) == 0 {
		t.Fatalf("expected pattern violation for absolute rootPath")
	}
	found := false
	for _, e := range errs {
		if strings.Contains(e, "/rootPath") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a /rootPath violation, got %v", errs)
	}
}

func TestECMARegexpMatchString(t *testing.T) {
	re, err := ecmaCompile("^a(?!b).$")
	if err != nil {
		t.Fatalf("ecmaCompile: %v", err)
	}
	if !re.MatchString("ac") {
		t.Fatalf("expected 'ac' to match negative lookahead pattern")
	}
	if re.MatchString("ab") {
		t.Fatalf("expected 'ab' to fail negative lookahead pattern")
	}
	if re.String() != "^a(?!b).$" {
		t.Fatalf("String() = %q", re.String())
	}
}

func TestECMACompileInvalidPattern(t *testing.T) {
	if _, err := ecmaCompile("(["); err == nil {
		t.Fatalf("expected error compiling malformed pattern")
	}
}

func TestGetValidatorCachesAndErrors(t *testing.T) {
	s1, err := getValidator("context-manifest")
	if err != nil {
		t.Fatalf("getValidator: %v", err)
	}
	s2, err := getValidator("context-manifest")
	if err != nil {
		t.Fatalf("getValidator second call: %v", err)
	}
	if s1 != s2 {
		t.Fatalf("expected cached validator instance to be reused")
	}
	if _, err := getValidator("nope-not-a-schema"); err == nil {
		t.Fatalf("expected error for missing schema file")
	}
}
