package conformancetest

// The shared render fixtures, driven through the real command: their pinned
// findings, their layout, their golden export bytes, and their idempotency. The
// detector's own families live with the detector (internal/renderlint); what this
// file asserts is the contract the three SDKs share — the findings a `--json`
// consumer reads, in the canonical order, and the exported tree byte for byte
// against the committed goldens.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/cli"
)

// canaryDriven fixtures are asserted by canary_test.go, which takes their trust
// corpus alongside the same export block; this harness takes the rest.
var canaryDriven = map[string]bool{
	"valid-unified-leji-fresh":       true,
	"valid-unified-leji-stale-tree":  true,
	"valid-trust-canary-nested-root": true,
	"valid-trust-canary-dot-root":    true,
}

type renderFinding struct {
	Rule      string `json:"rule"`
	Severity  string `json:"severity"`
	Path      string `json:"path"`
	Line      int    `json:"line"`
	Construct string `json:"construct"`
}

type goldenTree struct {
	Status     string `json:"status"`
	ContentDir string `json:"contentDir"`
	Manifest   string `json:"manifest"`
}

type renderExportBlock struct {
	Args     []string        `json:"args"`
	Exit     int             `json:"exit"`
	Findings []renderFinding `json:"findings"`
	Out      string          `json:"out"`
	Layout   expectedLayout  `json:"layout"`
	Rerun    struct {
		ByteIdentical bool `json:"byteIdentical"`
	} `json:"rerun"`
	GoldenTree goldenTree `json:"goldenTree"`
}

type renderExpectation struct {
	Export *renderExportBlock `json:"export"`
}

// exportDoc is the command's canonical JSON document, as a `--json` consumer reads it.
type exportDoc struct {
	Command  string          `json:"command"`
	OK       bool            `json:"ok"`
	Out      string          `json:"out"`
	Findings []renderFinding `json:"findings"`
	Warning  string          `json:"warning"`
}

// runCLI runs the CLI with stdout captured, the way a consumer invokes it.
func runCLI(t *testing.T, argv []string) (int, string) {
	t.Helper()
	orig := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	done := make(chan string, 1)
	go func() {
		var sb strings.Builder
		buf := make([]byte, 4096)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				sb.Write(buf[:n])
			}
			if err != nil {
				break
			}
		}
		done <- sb.String()
	}()
	code := cli.Run(argv)
	os.Stdout = orig
	_ = w.Close()
	out := <-done
	_ = r.Close()
	return code, out
}

// filesUnder is every file under dir, as export-root-relative POSIX paths, sorted.
func filesUnder(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	var walk func(rel string)
	walk = func(rel string) {
		abs := dir
		if rel != "" {
			abs = filepath.Join(dir, filepath.FromSlash(rel))
		}
		entries, err := os.ReadDir(abs)
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range entries {
			childRel := e.Name()
			if rel != "" {
				childRel = rel + "/" + e.Name()
			}
			if e.IsDir() {
				walk(childRel)
				continue
			}
			out = append(out, childRel)
		}
	}
	walk("")
	sort.Strings(out)
	return out
}

// goldenPath is a golden artifact at its declared name, or at the dot-prefixed name
// beside it: a `rootPath: "."` fixture exports its own root, so a plainly named
// golden would be exported into the next bake of itself. The dot form is skipped by
// the content walk, which is what makes it committable there (fixtures/README.md).
func goldenPath(fixtureRoot, declared string) string {
	segments := strings.SplitN(declared, "/", 2)
	plain := filepath.Join(fixtureRoot, filepath.FromSlash(declared))
	if _, err := os.Stat(plain); err == nil {
		return plain
	}
	segments[0] = "." + segments[0]
	return filepath.Join(fixtureRoot, filepath.FromSlash(strings.Join(segments, "/")))
}

// assertGoldenTree compares a written export tree against a fixture's committed
// goldens: the content tree as bytes, everything else by digest and size. The two
// sets are disjoint by construction and exhaustive by this comparison. A `baked`
// golden is the only one with bytes to compare.
func assertGoldenTree(t *testing.T, fixtureRoot, out string, golden goldenTree) {
	t.Helper()
	if golden.Status != "baked" {
		return
	}
	contentDir := goldenPath(fixtureRoot, golden.ContentDir)
	manifestFile := goldenPath(fixtureRoot, golden.Manifest)
	written := filesUnder(t, out)
	var inContent, outside []string
	for _, f := range written {
		if strings.HasPrefix(f, "content/") {
			inContent = append(inContent, strings.TrimPrefix(f, "content/"))
		} else {
			outside = append(outside, f)
		}
	}
	// The committed bytes ARE the export's content tree: same paths, same bytes, in
	// both directions, so a file that appears or disappears fails here.
	goldenFiles := filesUnder(t, contentDir)
	if !equalStrings(inContent, goldenFiles) {
		t.Fatalf("the golden content tree lists exactly what the export wrote\nextra=%v\nmissing=%v",
			diffStrings(inContent, goldenFiles), diffStrings(goldenFiles, inContent))
	}
	for _, rel := range goldenFiles {
		got, err := os.ReadFile(filepath.Join(out, "content", filepath.FromSlash(rel)))
		if err != nil {
			t.Fatal(err)
		}
		want, err := os.ReadFile(filepath.Join(contentDir, filepath.FromSlash(rel)))
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != string(want) {
			t.Fatalf("exported bytes differ from the golden for content/%s", rel)
		}
	}

	// Everything else — chrome, vendored assets, fonts — by digest and size.
	manRaw, err := os.ReadFile(manifestFile)
	if err != nil {
		t.Fatal(err)
	}
	var man struct {
		Version int `json:"version"`
		Files   map[string]struct {
			SHA256 string `json:"sha256"`
			Size   int    `json:"size"`
		} `json:"files"`
	}
	if err := json.Unmarshal(manRaw, &man); err != nil {
		t.Fatal(err)
	}
	if man.Version != 1 {
		t.Fatalf("the manifest states its version: %d", man.Version)
	}
	var pinned []string
	for rel := range man.Files {
		pinned = append(pinned, rel)
	}
	sort.Strings(pinned)
	if !equalStrings(pinned, outside) {
		t.Fatalf("the manifest pins every file outside content/\nextra=%v\nmissing=%v",
			diffStrings(outside, pinned), diffStrings(pinned, outside))
	}
	for _, rel := range outside {
		body, err := os.ReadFile(filepath.Join(out, filepath.FromSlash(rel)))
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(body)
		if hex.EncodeToString(sum[:]) != man.Files[rel].SHA256 || len(body) != man.Files[rel].Size {
			t.Fatalf("%s differs from the manifest's pin", rel)
		}
	}
}

func TestRenderFixtureExportBlocks(t *testing.T) {
	fd := fixturesDir(t)
	for _, name := range fixtureNames(t) {
		if canaryDriven[name] {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(fd, name, "expected.json"))
		if err != nil {
			t.Fatal(err)
		}
		var exp renderExpectation
		if err := json.Unmarshal(raw, &exp); err != nil {
			t.Fatal(err)
		}
		if exp.Export == nil {
			continue
		}
		block := exp.Export
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			cpTree(t, filepath.Join(fd, name), dir)

			preservedBefore := map[string]string{}
			for _, rel := range block.Layout.Preserved {
				abs := fixtureAbs(dir, fixtureRel(t, rel, "preserved entry"))
				info, err := os.Stat(abs)
				if err != nil {
					t.Fatalf("preserved path must exist before the run: %s", rel)
				}
				if info.Mode().IsRegular() {
					body, err := os.ReadFile(abs)
					if err != nil {
						t.Fatal(err)
					}
					preservedBefore[rel] = string(body)
				}
			}

			// The whole command, under the fixture's own argv: the exit code is the
			// process's, and the findings are the ones a `--json` consumer reads.
			args := block.Args
			if len(args) == 0 {
				args = []string{"export"}
			}
			argv := append(append([]string{}, args...), "--root", dir, "--json")
			code, stdout := runCLI(t, argv)
			if code != block.Exit {
				t.Fatalf("exit code %d, want %d: %s", code, block.Exit, stdout)
			}
			var doc exportDoc
			if err := json.Unmarshal([]byte(stdout), &doc); err != nil {
				t.Fatalf("the command must emit its canonical document: %v (%s)", err, stdout)
			}
			if got := filepath.ToSlash(doc.Out); got != block.Out {
				t.Fatalf("declared output directory %q, want %q", got, block.Out)
			}
			// Matched on (rule, severity, path, line, construct) IN ORDER — message text
			// is never compared, and the order is the canonical one the three SDKs share.
			if len(doc.Findings) != len(block.Findings) {
				t.Fatalf("findings: got %d, want %d (%v)", len(doc.Findings), len(block.Findings), doc.Findings)
			}
			for i, want := range block.Findings {
				if doc.Findings[i] != want {
					t.Fatalf("finding %d: got %+v, want %+v", i, doc.Findings[i], want)
				}
			}

			// `roles` is the layout's role map — which directory each role NAMES — and
			// present/absent say which of them a given run establishes: a `--strict` run
			// names the export role and deliberately writes nothing at it.
			absent := map[string]bool{}
			for _, rel := range block.Layout.Absent {
				absent[fixtureRel(t, rel, "absent entry")] = true
			}
			for role, roleDir := range block.Layout.Roles {
				rel := fixtureRel(t, roleDir, "role "+role)
				if absent[rel] {
					continue
				}
				if info, err := os.Stat(fixtureAbs(dir, rel)); err != nil || !info.IsDir() {
					t.Fatalf("role %s must be established at %s", role, roleDir)
				}
			}
			for _, rel := range block.Layout.Present {
				if _, err := os.Stat(fixtureAbs(dir, fixtureRel(t, rel, "present entry"))); err != nil {
					t.Fatalf("must be present after the run: %s", rel)
				}
			}
			for rel := range absent {
				if _, err := os.Stat(fixtureAbs(dir, rel)); err == nil {
					t.Fatalf("must never be created: %s", rel)
				}
			}
			for rel, before := range preservedBefore {
				body, err := os.ReadFile(fixtureAbs(dir, rel))
				if err != nil || string(body) != before {
					t.Fatalf("must be byte-identical after the run: %s", rel)
				}
			}

			// --- the golden tree ---------------------------------------------------
			out := fixtureAbs(dir, block.Out)
			if block.GoldenTree.Status == "none" {
				if _, err := os.Stat(out); err == nil {
					t.Fatal("a run that writes no export tree has nothing to bake")
				}
			}
			assertGoldenTree(t, filepath.Join(fd, name), out, block.GoldenTree)

			// --- idempotency ---------------------------------------------------------
			if block.Rerun.ByteIdentical {
				afterFirst := snapshot(t, dir)
				if code, stdout := runCLI(t, argv); code != block.Exit {
					t.Fatalf("second run exit %d, want %d: %s", code, block.Exit, stdout)
				}
				if afterSecond := snapshot(t, dir); !equalStrings(afterFirst, afterSecond) {
					t.Fatalf("a second run must be a byte-level no-op across the whole working tree\nfirst=%v\nsecond=%v",
						diffStrings(afterFirst, afterSecond), diffStrings(afterSecond, afterFirst))
				}
			}
		})
	}
}
