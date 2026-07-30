// Direct unit coverage for the `leji-index` block parser, mirroring
// packages/sdk/test/indexfile.test.ts. The shared fixtures exercise it end to end;
// what is pinned here is the whitespace alphabet, which is the porting contract and
// the one thing three runtimes cannot be trusted to agree on by themselves.
package indexfile

import "testing"

func entryPaths(p Parsed) []string {
	out := make([]string, 0, len(p.Entries))
	for _, e := range p.Entries {
		out = append(out, e.Path)
	}
	return out
}

func TestParseLeadingBOMDoesNotDecideWhetherTheFenceExists(t *testing.T) {
	// Reproduced divergence: the BOM survived into the first line, and each runtime's
	// own trim disagreed about whether it was whitespace, so the same file parsed in
	// Node and failed with `index-file-parse` here and in Python.
	parsed := Parse("\ufeff```leji-index\n- path: docs/a.md\n```\n")
	if len(parsed.Errors) != 0 {
		t.Fatalf("errors = %v", parsed.Errors)
	}
	if got := entryPaths(parsed); len(got) != 1 || got[0] != "docs/a.md" {
		t.Fatalf("entries = %v", got)
	}
}

func TestParseWhitespaceIsASCIISpaceAndTabOnly(t *testing.T) {
	// Reproduced divergence: an NBSP before a trailing `#` opened a comment under
	// JavaScript's and Python's `\s` but not Go's, so one entry named two different
	// paths depending on which SDK read it. Under the ASCII alphabet all three keep
	// the `#` in the path, and the layer reports it missing rather than inventing one.
	nbsp := Parse("```leji-index\n- path: docs/a.md\u00a0# note\n```\n")
	if len(nbsp.Errors) != 0 {
		t.Fatalf("errors = %v", nbsp.Errors)
	}
	if got := entryPaths(nbsp); len(got) != 1 || got[0] != "docs/a.md\u00a0# note" {
		t.Fatalf("entries = %q", got)
	}
	// A space-preceded `#` is still a comment, and padding is still stripped.
	ascii := Parse("```leji-index\n   - path: docs/a.md \t# note\t \n```\n")
	if got := entryPaths(ascii); len(got) != 1 || got[0] != "docs/a.md" {
		t.Fatalf("ascii entries = %q, errors = %v", got, ascii.Errors)
	}
	// Non-ASCII padding around an entry is not padding: the line does not parse.
	padded := Parse("```leji-index\n\u00a0- path: docs/a.md\n```\n")
	if len(padded.Entries) != 0 || len(padded.Errors) != 1 {
		t.Fatalf("padded = %+v", padded)
	}
	// A fence line padded with U+00A0 is not a fence line either, in any SDK.
	noFence := Parse("\u00a0```leji-index\n- path: docs/a.md\n```\n")
	if len(noFence.Errors) != 1 || noFence.Errors[0] != "no leji-index block found in this index file" {
		t.Fatalf("noFence = %+v", noFence)
	}
}

func TestParseFenceCarryingJunkIsAReportableBlock(t *testing.T) {
	// The `leji-mounts` behavior, now shared: the fence opens and the grammar rejects
	// what follows, instead of the whole block vanishing from the scan.
	parsed := Parse("```leji-index record extra\n- path: docs/a.md\n```\n")
	want := `line 1: unknown leji-index block kind "record extra" (expected intent or record)`
	if len(parsed.Errors) != 1 || parsed.Errors[0] != want {
		t.Fatalf("errors = %v", parsed.Errors)
	}
	if got := entryPaths(parsed); len(got) != 1 || parsed.Entries[0].Kind != KindIntent {
		t.Fatalf("entries = %v kind = %q", got, parsed.Entries[0].Kind)
	}
}
