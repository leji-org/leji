package conformancetest

// Shared-fixture conformance: the Go SDK must report exactly what the fixture
// contract (and therefore the Node and Python SDKs) expects. Mirrors
// packages/sdk/test/fixtures.test.ts and packages/sdk-py/tests/test_fixtures.py.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/conformance"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/indexgen"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/validate"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

type expectedFinding struct {
	Rule     string `json:"rule"`
	Severity string `json:"severity"`
	Path     string `json:"path"`
	Message  string `json:"message"`
}

type expected struct {
	Validate struct {
		Exit     int               `json:"exit"`
		Findings []expectedFinding `json:"findings"`
	} `json:"validate"`
	Conformance *struct {
		Exit          int    `json:"exit"`
		ClaimedLevel  string `json:"claimedLevel"`
		VerifiedLevel string `json:"verifiedLevel"`
	} `json:"conformance"`
	IndexCheck *struct {
		Exit  int  `json:"exit"`
		Stale bool `json:"stale"`
	} `json:"indexCheck"`
}

func fixturesDir(t *testing.T) string {
	t.Helper()
	// internal/commands -> sdk-go -> packages -> repo root.
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	repoRoot := filepath.Join(wd, "..", "..", "..", "..")
	return filepath.Join(repoRoot, "fixtures")
}

func tripleFinding(f findings.Finding) string {
	return f.Path + "|" + f.Rule + "|" + f.Severity
}

func tripleExpected(f expectedFinding) string {
	return f.Path + "|" + f.Rule + "|" + f.Severity
}

func loadExpected(t *testing.T, dir string) expected {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "expected.json"))
	if err != nil {
		t.Fatal(err)
	}
	var e expected
	if err := json.Unmarshal(b, &e); err != nil {
		t.Fatal(err)
	}
	return e
}

func fixtureNames(t *testing.T) []string {
	t.Helper()
	fd := fixturesDir(t)
	entries, err := os.ReadDir(fd)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if _, err := os.Stat(filepath.Join(fd, e.Name(), "expected.json")); err == nil {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	return names
}

func TestFixtureValidate(t *testing.T) {
	fd := fixturesDir(t)
	for _, name := range fixtureNames(t) {
		t.Run(name, func(t *testing.T) {
			dir := filepath.Join(fd, name)
			exp := loadExpected(t, dir)
			result := validate.ValidateLayer(dir)

			var got []string
			for _, f := range result.Findings {
				got = append(got, tripleFinding(f))
			}
			sort.Strings(got)
			var want []string
			for _, f := range exp.Validate.Findings {
				want = append(want, tripleExpected(f))
			}
			sort.Strings(want)
			if !equalStrings(got, want) {
				t.Fatalf("findings mismatch for %s:\n got=%v\nwant=%v", name, got, want)
			}

			// When an expected finding carries a message, the actual finding
			// with the same (path, rule, severity) triple must match it too.
			messagesByTriple := map[string][]string{}
			for _, f := range result.Findings {
				k := tripleFinding(f)
				messagesByTriple[k] = append(messagesByTriple[k], f.Message)
			}
			for _, ef := range exp.Validate.Findings {
				if ef.Message == "" {
					continue
				}
				k := tripleExpected(ef)
				found := false
				for _, msg := range messagesByTriple[k] {
					if msg == ef.Message {
						found = true
						break
					}
				}
				if !found {
					t.Fatalf("message mismatch for %s [%s]: want %q, got %v",
						name, k, ef.Message, messagesByTriple[k])
				}
			}
			exit := 0
			if findings.HasErrors(result.Findings) {
				exit = 1
			}
			if exit != exp.Validate.Exit {
				t.Fatalf("exit code mismatch for %s: got %d want %d", name, exit, exp.Validate.Exit)
			}
		})
	}
}

func TestFixtureConformance(t *testing.T) {
	fd := fixturesDir(t)
	for _, name := range fixtureNames(t) {
		exp := loadExpected(t, filepath.Join(fd, name))
		if exp.Conformance == nil {
			continue
		}
		t.Run(name, func(t *testing.T) {
			dir := filepath.Join(fd, name)
			result := conformance.Report(dir)
			claimed := result.ClaimedLevel
			if claimed == "" {
				claimed = "none"
			}
			verified := result.VerifiedLevel
			if verified == "" {
				verified = "none"
			}
			if claimed != exp.Conformance.ClaimedLevel {
				t.Fatalf("claimedLevel for %s: got %q want %q", name, claimed, exp.Conformance.ClaimedLevel)
			}
			if verified != exp.Conformance.VerifiedLevel {
				t.Fatalf("verifiedLevel for %s: got %q want %q", name, verified, exp.Conformance.VerifiedLevel)
			}
			exit := 0
			if findings.HasErrors(result.Findings) {
				exit = 1
			}
			if exit != exp.Conformance.Exit {
				t.Fatalf("conformance exit for %s: got %d want %d", name, exit, exp.Conformance.Exit)
			}
		})
	}
}

func TestFixtureIndexCheck(t *testing.T) {
	fd := fixturesDir(t)
	for _, name := range fixtureNames(t) {
		exp := loadExpected(t, filepath.Join(fd, name))
		if exp.IndexCheck == nil {
			continue
		}
		t.Run(name, func(t *testing.T) {
			dir := filepath.Join(fd, name)
			m := manifest.LoadManifest(dir).Manifest
			if m == nil {
				t.Fatalf("manifest must load for indexCheck fixtures: %s", name)
			}
			result := indexgen.CheckIndex(dir, m)
			stale := true
			if result.Stale != nil {
				stale = *result.Stale
			}
			if stale != exp.IndexCheck.Stale {
				t.Fatalf("stale for %s: got %v want %v", name, stale, exp.IndexCheck.Stale)
			}
			exit := 0
			if findings.HasErrors(result.Findings) {
				exit = 1
			}
			if exit != exp.IndexCheck.Exit {
				t.Fatalf("indexCheck exit for %s: got %d want %d", name, exit, exp.IndexCheck.Exit)
			}
		})
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
