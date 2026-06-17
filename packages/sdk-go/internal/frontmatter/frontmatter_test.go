package frontmatter

import "testing"

func TestNoFrontmatterPassesThrough(t *testing.T) {
	fm := Parse("# Title\n\nBody.\n")
	if fm.Data != nil {
		t.Fatalf("expected nil data, got %v", fm.Data)
	}
	if fm.Error != "" {
		t.Fatalf("expected no error, got %q", fm.Error)
	}
}

func TestUnterminatedBlockIsError(t *testing.T) {
	fm := Parse("---\nid: x\n# never closed\n")
	if fm.Error == "" || !contains(fm.Error, "unterminated") {
		t.Fatalf("expected unterminated error, got %q", fm.Error)
	}
}

func TestNonMappingFrontmatterIsError(t *testing.T) {
	fm := Parse("---\n- just\n- a list\n---\n\nBody.\n")
	if fm.Data != nil {
		t.Fatalf("expected nil data")
	}
	if !contains(fm.Error, "not a YAML mapping") {
		t.Fatalf("expected mapping error, got %q", fm.Error)
	}
}

func TestInvalidYAMLIsErrorBodyRecovered(t *testing.T) {
	fm := Parse("---\nid: [unclosed\n---\n\nBody.\n")
	if fm.Data != nil {
		t.Fatalf("expected nil data")
	}
	if !contains(fm.Error, "invalid YAML") {
		t.Fatalf("expected invalid YAML, got %q", fm.Error)
	}
	if !contains(fm.Body, "Body") {
		t.Fatalf("body not recovered: %q", fm.Body)
	}
}

func TestYAML12Semantics(t *testing.T) {
	fm := Parse("---\ndate: 2026-06-12\nflag: no\nok: true\n---\n\nbody\n")
	if fm.Data == nil {
		t.Fatal("expected data")
	}
	if d, ok := fm.Data["date"].(string); !ok || d != "2026-06-12" {
		t.Fatalf("date should stay string, got %#v", fm.Data["date"])
	}
	if f, ok := fm.Data["flag"].(string); !ok || f != "no" {
		t.Fatalf("flag 'no' should stay string, got %#v", fm.Data["flag"])
	}
	if b, ok := fm.Data["ok"].(bool); !ok || !b {
		t.Fatalf("ok 'true' should be bool true, got %#v", fm.Data["ok"])
	}
}

func TestDuplicateKeyIsError(t *testing.T) {
	fm := Parse("---\nid: a\nid: b\n---\n\nbody\n")
	if fm.Error == "" {
		t.Fatalf("expected error for duplicate key, got data %v", fm.Data)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
