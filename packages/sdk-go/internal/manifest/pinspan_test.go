// The pin-span scanner over its own byte fixtures (`fixtures/manifest-pin-span/`,
// documented in fixtures/README.md). Mirrors the first section of
// packages/sdk/test/update-pin.test.ts; the fixtures are the byte oracle all three
// SDKs answer to.
package manifest_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

type pinSpanCase struct {
	Note    string `json:"note"`
	Mount   string `json:"mount"`
	From    string `json:"from"`
	To      string `json:"to"`
	Outcome string `json:"outcome"`
	Error   string `json:"error"`
}

func pinSpanDir(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(wd, "..", "..", "..", "..", "fixtures", "manifest-pin-span")
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestManifestPinSpanFixtures(t *testing.T) {
	dir := pinSpanDir(t)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	ran := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		caseDir := filepath.Join(dir, name)
		var spec pinSpanCase
		if err := json.Unmarshal([]byte(readFile(t, filepath.Join(caseDir, "case.json"))), &spec); err != nil {
			t.Fatalf("%s: case.json: %v", name, err)
		}
		ran++
		t.Run(name, func(t *testing.T) {
			input := readFile(t, filepath.Join(caseDir, "input.json"))
			if spec.Outcome == "error" {
				_, _, err := manifest.ReplaceMountPinInManifestText(input, spec.Mount, spec.From, spec.To)
				if err == nil {
					t.Fatalf("%s: expected the %s refusal", name, spec.Error)
				}
				want := map[string]string{
					"not-located":   "cannot locate the pin of mount",
					"not-from":      "is not",
					"duplicate-key": "duplicate key",
				}[spec.Error]
				if want == "" || !strings.Contains(err.Error(), want) {
					t.Fatalf("%s: %s refusal, got %q", name, spec.Error, err.Error())
				}
				return
			}
			expected := readFile(t, filepath.Join(caseDir, "expected.json"))
			got, changed, err := manifest.ReplaceMountPinInManifestText(input, spec.Mount, spec.From, spec.To)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			if !changed {
				t.Fatalf("%s: the span moved", name)
			}
			if got != expected {
				t.Fatalf("%s: byte-exact output\n got=%q\nwant=%q", name, got, expected)
			}
			// Every case is a real manifest before and after: the edit never produces
			// something a parser would reject.
			var parsed any
			if err := json.Unmarshal([]byte(got), &parsed); err != nil {
				t.Fatalf("%s: the result must still parse: %v", name, err)
			}
			// And the edit is confined: exactly the pin's own characters differ.
			if len(got) != len(input)+len(spec.To)-len(spec.From) {
				t.Fatalf("%s: the edit is confined to the pin span", name)
			}
		})
	}
	if ran == 0 {
		t.Fatal("no manifest-pin-span fixtures found")
	}
}

func TestManifestPinSpanDuplicateKeyIsRefusedNeverResolved(t *testing.T) {
	// The two readers of this document disagree: a lexical scan takes the FIRST
	// member, a parser keeps the LAST. Rewriting the first span would report a
	// change that every parser of the result still reads as the old pin.
	dir := pinSpanDir(t)
	input := readFile(t, filepath.Join(dir, "error-duplicate-pin", "input.json"))
	var spec pinSpanCase
	if err := json.Unmarshal([]byte(readFile(t, filepath.Join(dir, "error-duplicate-pin", "case.json"))), &spec); err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Federation struct {
			Mounts []struct {
				Pin string `json:"pin"`
			} `json:"mounts"`
		} `json:"federation"`
	}
	if err := json.Unmarshal([]byte(input), &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.Federation.Mounts[0].Pin == spec.From {
		t.Fatal("the parser reads the LAST pin, which is not the span a scan finds first")
	}
	_, _, err := manifest.ReplaceMountPinInManifestText(input, spec.Mount, spec.From, spec.To)
	if err == nil || !strings.Contains(err.Error(), `duplicate key "pin" in mount "product-context"`) {
		t.Fatalf("duplicate pin refusal, got %v", err)
	}
	// Every key the scanner reads on its way to the pin carries the same rule.
	for _, c := range []struct{ fixture, message string }{
		{"error-duplicate-federation", `duplicate key "federation" in the manifest root`},
		{"error-duplicate-mounts", `duplicate key "mounts" in "federation"`},
		{"error-duplicate-name", `duplicate key "name" in a federation mount`},
	} {
		text := readFile(t, filepath.Join(dir, c.fixture, "input.json"))
		_, _, err := manifest.ReplaceMountPinInManifestText(text, "product-context", spec.From, spec.To)
		if err == nil || !strings.Contains(err.Error(), c.message) {
			t.Fatalf("%s: want %q, got %v", c.fixture, c.message, err)
		}
	}
}

func TestManifestPinSpanMovesOnlyTheAddressedMount(t *testing.T) {
	dir := filepath.Join(pinSpanDir(t), "shared-prefix")
	input := readFile(t, filepath.Join(dir, "input.json"))
	var spec pinSpanCase
	if err := json.Unmarshal([]byte(readFile(t, filepath.Join(dir, "case.json"))), &spec); err != nil {
		t.Fatal(err)
	}
	type doc struct {
		Federation struct {
			Mounts []struct {
				Name string `json:"name"`
				Pin  string `json:"pin"`
			} `json:"mounts"`
		} `json:"federation"`
	}
	moved, _, err := manifest.ReplaceMountPinInManifestText(input, spec.Mount, spec.From, spec.To)
	if err != nil {
		t.Fatal(err)
	}
	var before, after doc
	if err := json.Unmarshal([]byte(input), &before); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(moved), &after); err != nil {
		t.Fatal(err)
	}
	// The neighbouring mount's pin is untouched by the move above it.
	if after.Federation.Mounts[0].Pin != before.Federation.Mounts[0].Pin {
		t.Fatal("the neighbouring mount's pin moved")
	}
	if after.Federation.Mounts[1].Pin == before.Federation.Mounts[1].Pin {
		t.Fatal("the addressed mount's pin did not move")
	}
	// `from == to` is a no-op the caller can rely on, not a rewrite of equal bytes.
	same, changed, err := manifest.ReplaceMountPinInManifestText(input, spec.Mount, spec.From, spec.From)
	if err != nil {
		t.Fatal(err)
	}
	if changed || same != input {
		t.Fatal("a no-op move must report changed=false and return the input")
	}
}
