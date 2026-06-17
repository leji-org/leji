package frontmatter

import "testing"

func TestScalarTypeResolution(t *testing.T) {
	// One mapping exercising the YAML 1.2 core scalar rules end to end.
	text := "---\n" +
		"str: hello\n" +
		"quoted: \"123\"\n" +
		"singleq: '0xff'\n" +
		"intval: 42\n" +
		"negint: -7\n" +
		"octval: 0o17\n" +
		"hexval: 0xff\n" +
		"floatval: 3.14\n" +
		"expval: 1e3\n" +
		"yes: yes\n" +
		"truthy: TRUE\n" +
		"falsy: False\n" +
		"nullval: null\n" +
		"tilde: ~\n" +
		"empty:\n" +
		"---\n\nbody\n"
	fm := Parse(text)
	if fm.Error != "" {
		t.Fatalf("unexpected error: %q", fm.Error)
	}
	d := fm.Data
	if d["str"] != "hello" {
		t.Fatalf("str = %#v", d["str"])
	}
	if d["quoted"] != "123" {
		t.Fatalf("quoted numeric string should stay string, got %#v", d["quoted"])
	}
	if d["singleq"] != "0xff" {
		t.Fatalf("single-quoted should stay string, got %#v", d["singleq"])
	}
	if v, ok := d["intval"].(int64); !ok || v != 42 {
		t.Fatalf("intval = %#v", d["intval"])
	}
	if v, ok := d["negint"].(int64); !ok || v != -7 {
		t.Fatalf("negint = %#v", d["negint"])
	}
	if v, ok := d["octval"].(int64); !ok || v != 15 {
		t.Fatalf("octval 0o17 should be 15, got %#v", d["octval"])
	}
	if v, ok := d["hexval"].(int64); !ok || v != 255 {
		t.Fatalf("hexval 0xff should be 255, got %#v", d["hexval"])
	}
	if v, ok := d["floatval"].(float64); !ok || v != 3.14 {
		t.Fatalf("floatval = %#v", d["floatval"])
	}
	if v, ok := d["expval"].(float64); !ok || v != 1000 {
		t.Fatalf("expval 1e3 should be 1000.0, got %#v", d["expval"])
	}
	if d["yes"] != "yes" {
		t.Fatalf("YAML 1.2: 'yes' stays a string, got %#v", d["yes"])
	}
	if v, ok := d["truthy"].(bool); !ok || !v {
		t.Fatalf("TRUE should be bool true, got %#v", d["truthy"])
	}
	if v, ok := d["falsy"].(bool); !ok || v {
		t.Fatalf("False should be bool false, got %#v", d["falsy"])
	}
	if d["nullval"] != nil {
		t.Fatalf("null should be nil, got %#v", d["nullval"])
	}
	if d["tilde"] != nil {
		t.Fatalf("~ should be nil, got %#v", d["tilde"])
	}
	if d["empty"] != nil {
		t.Fatalf("empty value should be nil, got %#v", d["empty"])
	}
}

func TestNestedSequenceAndMapping(t *testing.T) {
	text := "---\n" +
		"paths:\n" +
		"  - docs/a.md\n" +
		"  - docs/b.md\n" +
		"owner:\n" +
		"  name: Jo\n" +
		"  active: true\n" +
		"---\n\nbody\n"
	fm := Parse(text)
	if fm.Error != "" {
		t.Fatalf("unexpected error: %q", fm.Error)
	}
	seq, ok := fm.Data["paths"].([]any)
	if !ok || len(seq) != 2 || seq[0] != "docs/a.md" {
		t.Fatalf("paths sequence wrong: %#v", fm.Data["paths"])
	}
	owner, ok := fm.Data["owner"].(map[string]any)
	if !ok || owner["name"] != "Jo" || owner["active"] != true {
		t.Fatalf("owner mapping wrong: %#v", fm.Data["owner"])
	}
}

func TestNonStringKeyCoercion(t *testing.T) {
	// Integer and boolean mapping keys are coerced to their string form, so a
	// numeric key and its string twin collide as a duplicate.
	fm := Parse("---\n1: a\ntrue: b\n---\n\nbody\n")
	if fm.Error != "" {
		t.Fatalf("unexpected error: %q", fm.Error)
	}
	if fm.Data["1"] != "a" {
		t.Fatalf("integer key should become \"1\", got %#v", fm.Data)
	}
	if fm.Data["true"] != "b" {
		t.Fatalf("bool key should become \"true\", got %#v", fm.Data)
	}
}

func TestAnchorAliasResolved(t *testing.T) {
	text := "---\n" +
		"base: &a hello\n" +
		"ref: *a\n" +
		"---\n\nbody\n"
	fm := Parse(text)
	if fm.Error != "" {
		t.Fatalf("unexpected error: %q", fm.Error)
	}
	if fm.Data["ref"] != "hello" {
		t.Fatalf("alias should resolve to hello, got %#v", fm.Data["ref"])
	}
}

func TestBodyPreservedAfterFrontmatter(t *testing.T) {
	fm := Parse("---\nid: x\n---\n\n# Heading\n\nText.\n")
	if fm.Error != "" {
		t.Fatalf("unexpected error: %q", fm.Error)
	}
	if fm.Body != "\n# Heading\n\nText.\n" {
		t.Fatalf("body not preserved: %q", fm.Body)
	}
}
