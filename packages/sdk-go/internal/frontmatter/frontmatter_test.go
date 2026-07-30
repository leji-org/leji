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

// Parse slices the raw YAML block to the end of the fence's submatch 1, so that
// submatch must open at the match start and span the whole line terminator ending
// the block's last line. This is asserted on the regex rather than through Parse
// because yaml.v3 normalizes a bare trailing `\r`: no Parse-level assertion can
// fail when this regresses. The Node SDK's parser does not normalize it, and folds
// the orphan CR into the last scalar's value, which is what the shared slicing
// protects against here and in packages/sdk-py.
func TestFenceSubmatchSpansTheWholeLineTerminator(t *testing.T) {
	cases := []struct {
		name  string
		block string
		want  string
	}{
		{"crlf", "\r\nrole: reviewer\r\n---\r\n", "\r\n"},
		{"lf", "\nrole: reviewer\n---\n", "\n"},
	}
	for _, tc := range cases {
		loc := fence.FindStringSubmatchIndex(tc.block)
		if loc == nil {
			t.Fatalf("%s: fence did not match %q", tc.name, tc.block)
		}
		if loc[2] != loc[0] {
			t.Fatalf("%s: submatch 1 must open at the match start; Parse slices to its end", tc.name)
		}
		if got := tc.block[loc[2]:loc[3]]; got != tc.want {
			t.Fatalf("%s: terminator submatch = %q, want %q", tc.name, got, tc.want)
		}
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
