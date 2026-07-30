// The `leji-mounts` block grammar. Mirrors packages/sdk/test/mountblock.test.ts.
package mountblock_test

import (
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/mountblock"
)

func block(lines ...string) string {
	return "# Boot\n\n```leji-mounts\n" + strings.Join(lines, "\n") + "\n```\n"
}

func TestParseAcceptsFieldsInAnyOrderAndConcatenatesBlocks(t *testing.T) {
	text := block(
		"- mount: alpha",
		"  read-when: a task touches alpha",
		"  owner: Alpha team",
		"  carries: alpha language",
	) + "\nProse between blocks.\n\n" + "```leji-mounts\n" +
		"- mount: beta\n  owner: Beta team\n  carries: beta language\n  read-when: a task touches beta\n```\n"
	parsed := mountblock.Parse(text)
	if len(parsed.Errors) != 0 {
		t.Fatalf("errors = %+v", parsed.Errors)
	}
	if !parsed.SawBlock || len(parsed.Entries) != 2 {
		t.Fatalf("entries = %+v", parsed.Entries)
	}
	if parsed.Entries[0].Mount != "alpha" || parsed.Entries[0].ReadWhen != "a task touches alpha" {
		t.Fatalf("first entry = %+v", parsed.Entries[0])
	}
	if parsed.Entries[1].Mount != "beta" || parsed.Entries[1].Owner != "Beta team" {
		t.Fatalf("second entry = %+v", parsed.Entries[1])
	}
}

func TestParseReportsGrammarDefectsInSourceLineOrder(t *testing.T) {
	cases := []struct {
		what string
		text string
		want string
	}{
		{
			what: "an info string carrying anything after the tag",
			text: "```leji-mounts extra token\n```\n",
			want: `the leji-mounts info string carries nothing after the tag, but this fence declares "extra token"`,
		},
		{
			what: "a missing field",
			text: block("- mount: alpha", "  owner: Alpha team", "  carries: alpha language"),
			want: `mount "alpha" is missing the "read-when" field`,
		},
		{
			what: "a duplicate field",
			text: block("- mount: alpha", "  owner: A", "  owner: B", "  carries: c", "  read-when: w"),
			want: `mount "alpha" declares the "owner" field twice`,
		},
		{
			what: "an unknown field",
			text: block("- mount: alpha", "  owner: A", "  carries: c", "  read-when: w", "  extra: x"),
			want: `mount "alpha" carries the unknown field "extra"`,
		},
		{
			what: "a misindented field line",
			text: block("- mount: alpha", "    owner: A"),
			want: `a field line must be indented exactly two spaces, as "  <key>: <value>"`,
		},
		{
			what: "a padded value",
			text: block("- mount: alpha", "  owner: A ", "  carries: c", "  read-when: w"),
			want: `mount "alpha" field "owner" is unusable: the value has leading or trailing whitespace`,
		},
		{
			what: "a value carrying a line separator",
			text: block("- mount: alpha", "  owner: A B", "  carries: c", "  read-when: w"),
			want: `mount "alpha" field "owner" is unusable: the value carries a control or line-separator character`,
		},
		{
			what: "a field before any record",
			text: block("  owner: A"),
			want: `field "owner" appears before any "- mount:" record`,
		},
		{
			what: "an unterminated block",
			text: "# Boot\n\n```leji-mounts\n- mount: alpha\n",
			want: "unterminated leji-mounts block (no closing fence)",
		},
	}
	for _, c := range cases {
		parsed := mountblock.Parse(c.text)
		found := false
		for _, e := range parsed.Errors {
			if e.Message == c.want {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s: errors = %+v", c.what, parsed.Errors)
		}
		if len(parsed.Errors) > 1 {
			for i := 1; i < len(parsed.Errors); i++ {
				if parsed.Errors[i-1].Line > parsed.Errors[i].Line {
					t.Fatalf("%s: errors are not in source-line order: %+v", c.what, parsed.Errors)
				}
			}
		}
	}
}

// The fence-whitespace alphabet is ASCII space and tab and nothing else: a
// runtime whitespace class would disagree between the three SDKs on U+00A0.
func TestParseFenceWhitespaceAlphabetIsASCIIOnly(t *testing.T) {
	if parsed := mountblock.Parse(" ```leji-mounts\n```\n"); parsed.SawBlock {
		t.Fatalf("U+00A0 indent must not open a fence")
	}
	if parsed := mountblock.Parse("\t```leji-mounts\t\n```\n"); !parsed.SawBlock {
		t.Fatalf("a tab indent opens a fence")
	}
	// The tag boundary holds: a longer tag names a different grammar.
	if parsed := mountblock.Parse("```leji-mountsx\n```\n"); parsed.SawBlock {
		t.Fatalf("leji-mountsx opened a leji-mounts block")
	}
}

func TestValueRepresentationErrorNamesWhatABlockCannotCarry(t *testing.T) {
	cases := map[string]string{
		"":          "the value is empty",
		" padded":   "the value has leading or trailing whitespace",
		"two\nline": "the value carries a control or line-separator character",
		"fine":      "",
	}
	for value, want := range cases {
		if got := mountblock.ValueRepresentationError(value); got != want {
			t.Fatalf("ValueRepresentationError(%q) = %q; want %q", value, got, want)
		}
	}
}
