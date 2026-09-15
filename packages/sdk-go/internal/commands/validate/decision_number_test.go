package validate

// The decision-number rule's cross-SDK edge cases. The shared fixture cannot carry
// these: a file name holding a control character is not portably committable, so the
// rule's helpers are exercised directly, which is also why this file is in the
// package rather than beside the external validate_test files.

import (
	"sort"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/layer"
)

// record is a decision record reduced to what the number rule reads.
func record(relPath string) layer.ScannedProfile {
	return layer.ScannedProfile{RelPath: relPath}
}

// A file name may legally carry a CR, and the three SDKs must agree on whether it
// carries a decision number: ECMAScript's `.` rejects CR (and U+2028/U+2029) where
// Go's and Python's accept it, so the pattern spells the class out instead.
func TestDecisionNumberKeyCarriageReturnAndNewline(t *testing.T) {
	if key, ok := decisionNumberKey("docs/decisions/2-a\rb.md"); !ok || key != "2" {
		t.Fatalf("carriage return: got (%q, %v), want (\"2\", true)", key, ok)
	}
	if key, ok := decisionNumberKey("docs/decisions/2-a\nb.md"); ok {
		t.Fatalf("newline: got (%q, true), want no key", key)
	}
}

// U+E000 sorts before U+10000 by bytes and after it by UTF-16 code units. Byte order
// is the contract: Go compares strings bytewise, Python by code point, which equals it,
// and the Node SDK sorts its scan bytewise to reach the same sequence. All three name
// the U+10000 record as the later one.
func TestCheckDecisionNumbersNamesTheByteOrderFirstRecord(t *testing.T) {
	pua := "docs/decisions/2-\ue000.md"
	astral := "docs/decisions/2-\U00010000.md"
	paths := []string{pua, astral}
	sort.Strings(paths)
	if paths[0] != pua {
		t.Fatalf("scan order: got %q first, want the U+E000 path", paths[0])
	}

	var fs []findings.Finding
	checkDecisionNumbers([]layer.ScannedProfile{record(paths[0]), record(paths[1])}, &fs)

	if len(fs) != 1 {
		t.Fatalf("got %d findings, want 1", len(fs))
	}
	if fs[0].Rule != "decision-number-duplicate" || fs[0].Severity != findings.Error {
		t.Fatalf("got (%q, %v), want (decision-number-duplicate, error)", fs[0].Rule, fs[0].Severity)
	}
	if fs[0].Path != astral {
		t.Fatalf("got path %q, want %q", fs[0].Path, astral)
	}
	want := "decision number \"2\" already used by " + pua
	if fs[0].Message != want {
		t.Fatalf("got message %q, want %q", fs[0].Message, want)
	}
}
