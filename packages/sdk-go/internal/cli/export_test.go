package cli

// `leji export` and `leji viewer build`: one operation, two permanently supported
// names. What this file pins is the part of that operation the other suites cannot
// see: that the two names really are one code path, that no destination flag exists,
// that `--strict` is scoped to the lint class, and that a failed run leaves an
// existing export byte-untouched.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/schemas"
)

// exampleLayerCopy is a scratch copy of the example layer.
func exampleLayerCopy(t *testing.T) string {
	t.Helper()
	dst := t.TempDir()
	if err := os.CopyFS(dst, os.DirFS(filepath.Join(repoRoot(t), "examples", "monorepo"))); err != nil {
		t.Fatalf("copy example: %v", err)
	}
	return dst
}

// fixtureCopy is a scratch copy of a shared fixture.
func fixtureCopy(t *testing.T, name string) string {
	t.Helper()
	dst := t.TempDir()
	if err := os.CopyFS(dst, os.DirFS(fixture(t, name))); err != nil {
		t.Fatalf("copy fixture %s: %v", name, err)
	}
	return dst
}

// treeSnapshot is every path under dir as `rel -> content digest` (directories as
// `rel/`), so a comparison covers appearance and disappearance as well as content.
func treeSnapshot(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	if _, err := os.Stat(dir); err != nil {
		return out
	}
	err := filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, rerr := filepath.Rel(dir, p)
		if rerr != nil || rel == "." {
			return rerr
		}
		rel = filepath.ToSlash(rel)
		switch {
		case d.IsDir():
			out = append(out, rel+"/\x00")
		case d.Type().IsRegular():
			body, rerr := os.ReadFile(p)
			if rerr != nil {
				return rerr
			}
			sum := sha256.Sum256(body)
			out = append(out, rel+"\x00"+hex.EncodeToString(sum[:]))
		default:
			out = append(out, rel+"\x00non-regular")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(out)
	return out
}

func sameTree(a, b []string) bool {
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

// jsonKeys is the top-level key order of a JSON object, as emitted.
func jsonKeys(t *testing.T, doc string) []string {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(doc))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		t.Fatalf("not a JSON object: %q", doc)
	}
	var keys []string
	depth := 0
	for dec.More() || depth > 0 {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		switch v := tok.(type) {
		case json.Delim:
			if v == '{' || v == '[' {
				depth++
			} else {
				depth--
			}
		case string:
			if depth == 0 {
				keys = append(keys, v)
				// Skip this key's value.
				var discard any
				if err := dec.Decode(&discard); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	return keys
}

func TestExportTakesNoDestinationFlagAndItsHelpNamesNoNetwork(t *testing.T) {
	dir := exampleLayerCopy(t)
	for _, argv := range [][]string{
		{"export", "--endpoint", "x"},
		{"export", "--url", "https://example.invalid"},
		{"export", "--host", "example.invalid"},
		{"export", "--token", "secret"},
		{"export", "--port", "8080"},
		{"viewer", "build", "--endpoint", "x"},
	} {
		code, _, _ := captureRun(t, append(append([]string{}, argv...), "--root", dir))
		if code != 2 {
			t.Fatalf("%v must be a usage error, got %d", argv, code)
		}
	}
	// The accept side of the same guarantee, under BOTH names: the allow-list the
	// rejection above consults is exactly the globals plus --out and --strict. Read
	// from cli.json, which is what the CLI itself rejects against — so a destination
	// flag cannot reach the surface without failing here.
	spec, err := schemas.LoadCliSpec()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--help", "--json", "--out", "--root", "--strict", "--version", "-h", "-v"}
	for _, name := range []string{"export", "viewer build"} {
		var cmd *schemas.CliCommand
		for i := range spec.Commands {
			if spec.Commands[i].Name == name {
				cmd = &spec.Commands[i]
				break
			}
		}
		if cmd == nil {
			t.Fatalf("%s must be a documented command", name)
		}
		var allowed []string
		for _, o := range append(append([]schemas.CliOption{}, spec.GlobalOptions...), cmd.Options...) {
			allowed = append(allowed, flagTokens(o.Flags)...)
		}
		sort.Strings(allowed)
		if !sameTree(allowed, want) {
			t.Fatalf("%s accepts %v, want %v", name, allowed, want)
		}
		// And the help bytes a person reads describe no network operation: this command
		// writes files from files. The whole banned class against the real bytes, not a
		// selected few of them. The flag surface itself is the cli.json assertion above,
		// which holds whatever the help layout does; help only has to document it.
		help, ok := BuildCommandHelp(name)
		if !ok {
			t.Fatalf("%s must render help", name)
		}
		for _, o := range cmd.Options {
			if !strings.Contains(help, "   "+o.Flags) {
				t.Fatalf("%s help does not document %s", name, o.Flags)
			}
		}
		if !strings.Contains(help, "\nGlobal options: see leji --help.\n") {
			t.Fatalf("%s help does not point at the globals", name)
		}
		lower := strings.ToLower(help)
		for _, word := range []string{"endpoint", "token", "upload", "api key", "s3://", "host", "url",
			"server", "network", "browser", "publish", "remote"} {
			if strings.Contains(lower, word) {
				t.Fatalf("the %s help text carries %q", name, word)
			}
		}
	}
}

func TestExportAndViewerBuildWriteByteIdenticalTrees(t *testing.T) {
	a := exampleLayerCopy(t)
	b := exampleLayerCopy(t)
	codeA, outA, _ := captureRun(t, []string{"export", "--root", a, "--json"})
	codeB, outB, _ := captureRun(t, []string{"viewer", "build", "--root", b, "--json"})
	if codeA != 0 || codeB != 0 {
		t.Fatalf("exits %d/%d: %s%s", codeA, codeB, outA, outB)
	}
	// The same JSON document under both names, `command` included: the second name is
	// the same operation, not a second command that resembles it.
	var docA, docB map[string]any
	if err := json.Unmarshal([]byte(outA), &docA); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(outB), &docB); err != nil {
		t.Fatal(err)
	}
	if docA["command"] != "export" {
		t.Fatalf("command = %v", docA["command"])
	}
	if outA != outB {
		t.Fatalf("the two names must emit the same document:\n%s\n%s", outA, outB)
	}
	if docA["out"] != filepath.Join(".leji", "dist") {
		t.Fatalf("out = %v", docA["out"])
	}
	if !sameTree(treeSnapshot(t, a), treeSnapshot(t, b)) {
		t.Fatal("the two names must leave identical working trees")
	}
}

func TestExportEmitsItsCanonicalDocumentOnEveryPath(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "leji.json"), []byte("{ this is not a manifest\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	first, firstOut, _ := captureRun(t, []string{"export", "--root", dir, "--json"})
	second, secondOut, _ := captureRun(t, []string{"viewer", "build", "--root", dir, "--json"})
	if first != 1 || second != 1 {
		t.Fatalf("exits %d/%d", first, second)
	}
	// One document shape for every outcome of this command: the pre-pipeline failure is
	// NOT reported in the generic {command, ok, findings, summary} envelope.
	keys := jsonKeys(t, firstOut)
	if !sameTree(keys, []string{"command", "ok", "out", "findings", "warning"}) {
		t.Fatalf("document keys = %v", keys)
	}
	var doc struct {
		Command  string `json:"command"`
		OK       bool   `json:"ok"`
		Out      string `json:"out"`
		Findings []struct {
			Severity string `json:"severity"`
		} `json:"findings"`
		Warning string `json:"warning"`
	}
	if err := json.Unmarshal([]byte(firstOut), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Command != "export" || doc.OK || doc.Out != ".leji/dist" {
		t.Fatalf("document = %+v", doc)
	}
	errs := 0
	for _, f := range doc.Findings {
		if f.Severity == "error" {
			errs++
		}
	}
	if errs == 0 {
		t.Fatalf("the unreadable manifest must be reported: %s", firstOut)
	}
	if !strings.HasPrefix(doc.Warning, "This is your context layer") {
		t.Fatalf("warning = %q", doc.Warning)
	}
	if firstOut != secondOut {
		t.Fatal("byte-identical under both names")
	}
	// A caller `--out` is reported as the caller wrote it, on the same shape.
	code, out, _ := captureRun(t, []string{"export", "--root", dir, "--out", "site", "--json"})
	if code != 1 {
		t.Fatalf("exit %d", code)
	}
	var withOut struct {
		Out string `json:"out"`
	}
	if err := json.Unmarshal([]byte(out), &withOut); err != nil {
		t.Fatal(err)
	}
	if withOut.Out != "site" {
		t.Fatalf("out = %q", withOut.Out)
	}
}

func TestExportStrictIsScopedToTheLintClassAndLeavesTheTargetUntouched(t *testing.T) {
	// A layer that reports a finding without failing generation: a viewer.homepage that
	// resolves to nothing is a warning, exported anyway.
	dir := fixtureCopy(t, "valid-unified-leji-fresh")
	manifestPath := filepath.Join(dir, "leji.json")
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var declared map[string]any
	if err := json.Unmarshal(raw, &declared); err != nil {
		t.Fatal(err)
	}
	declared["viewer"] = map[string]any{"homepage": "no-such-page.md"}
	patched, err := json.MarshalIndent(declared, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifestPath, append(patched, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}

	code, out, _ := captureRun(t, []string{"export", "--root", dir, "--json"})
	if code != 0 {
		t.Fatalf("plain run exit %d: %s", code, out)
	}
	if !strings.Contains(out, "viewer-path-missing") {
		t.Fatalf("the layer must report a finding: %s", out)
	}
	// `--strict` is scoped to the lint class, not to any finding: an ordinary viewer
	// warning stays a warning, and the export is still written.
	strictCode, strictOut, _ := captureRun(t, []string{"export", "--root", dir, "--strict", "--json"})
	if strictCode != 0 {
		t.Fatalf("an ordinary warning must not be promoted by --strict: %s", strictOut)
	}
	if strictOut != out {
		t.Fatalf("the same findings, and still written:\n%s\n%s", out, strictOut)
	}

	distDir := filepath.Join(dir, ".leji", "dist")
	before := treeSnapshot(t, distDir)
	if len(before) == 0 {
		t.Fatal("an export must exist to be protected")
	}

	// An error finding fails the run through the same pre-clean gate: overview.md,
	// seeded by the runs above, redirected into a private role. Generation reaches it
	// after the chrome is written, so this run proves both halves of the pipeline
	// promise at once — the internal chrome IS regenerated, the target is not touched.
	if err := os.MkdirAll(filepath.Join(dir, ".leji", "mounts"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".leji", "mounts", "stolen.md"), []byte("private\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	overview := filepath.Join(dir, "docs", "overview.md")
	if _, err := os.Stat(overview); err != nil {
		t.Fatal("the seeded overview page must be there to redirect")
	}
	if err := os.Remove(overview); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(dir, ".leji", "mounts", "stolen.md"), overview); err != nil {
		t.Fatal(err)
	}
	viewerDir := filepath.Join(dir, ".leji", "viewer")
	if err := os.RemoveAll(viewerDir); err != nil {
		t.Fatal(err)
	}

	failed, failedOut, _ := captureRun(t, []string{"export", "--root", dir, "--json"})
	if failed != 1 {
		t.Fatalf("an error finding must fail the run: %s", failedOut)
	}
	if !strings.Contains(failedOut, `"ok": false`) || !strings.Contains(failedOut, `"severity": "error"`) {
		t.Fatalf("the run must report an error finding: %s", failedOut)
	}
	if !sameTree(treeSnapshot(t, distDir), before) {
		t.Fatal("the existing export must be byte-untouched")
	}
	if _, err := os.Stat(filepath.Join(viewerDir, "index.html")); err != nil {
		t.Fatal("the internal chrome must be regenerated regardless")
	}
	if _, err := os.Stat(filepath.Join(viewerDir, "assets")); err != nil {
		t.Fatal("the internal chrome must carry its assets")
	}

	// The same holds under the other name, and for a target that does not exist yet.
	if err := os.RemoveAll(distDir); err != nil {
		t.Fatal(err)
	}
	other, _, _ := captureRun(t, []string{"viewer", "build", "--root", dir, "--strict"})
	if other != 1 {
		t.Fatalf("the other name must answer the same: %d", other)
	}
	if _, err := os.Stat(distDir); err == nil {
		t.Fatal("nothing must be written at all")
	}
}

func TestExportStrictGateIsDrivenByARealLintFinding(t *testing.T) {
	dir := fixtureCopy(t, "valid-unified-leji-fresh")
	// A real unsupported construct in one of the layer's own documents: the rendering
	// lint reads the source the export carries, so the exit codes below are the gate's
	// answer to a finding the shipped pipeline produced and not to a planted one.
	doc := filepath.Join(dir, "docs", "domain", "overview.md")
	body, err := os.ReadFile(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(doc, append(body, []byte("\nA raw <span>element</span> in the prose.\n")...), 0o644); err != nil {
		t.Fatal(err)
	}

	// Default run: the lint finding is reported and the export is written anyway — the
	// layer's build never breaks on prose.
	code, out, _ := captureRun(t, []string{"export", "--root", dir, "--json"})
	if code != 0 {
		t.Fatalf("an ordinary run must export despite the lint finding: %s", out)
	}
	var plain struct {
		OK       bool `json:"ok"`
		Findings []struct {
			Rule      string `json:"rule"`
			Severity  string `json:"severity"`
			Path      string `json:"path"`
			Line      int    `json:"line"`
			Construct string `json:"construct"`
		} `json:"findings"`
	}
	if err := json.Unmarshal([]byte(out), &plain); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, f := range plain.Findings {
		if f.Rule == "render-unsupported" && f.Severity == "warning" &&
			f.Path == "docs/domain/overview.md" && f.Line == 5 && f.Construct == "raw-html" {
			found = true
		}
	}
	if !plain.OK || !found {
		t.Fatalf("the lint finding must reach the pipeline: %s", out)
	}
	distDir := filepath.Join(dir, ".leji", "dist")
	before := treeSnapshot(t, distDir)
	if len(before) == 0 {
		t.Fatal("an export must exist to be protected")
	}

	// Same layer, same finding, `--strict`: the run fails and the export it would have
	// replaced is left exactly as it was. The chrome is removed first, so the assertion
	// that it was regenerated can actually fail: after the default run above it exists
	// already, and a strict gate moved ahead of regeneration would pass unnoticed.
	viewerDir := filepath.Join(dir, ".leji", "viewer")
	if err := os.RemoveAll(viewerDir); err != nil {
		t.Fatal(err)
	}
	strictCode, strictOut, _ := captureRun(t, []string{"export", "--root", dir, "--strict", "--json"})
	if strictCode != 1 {
		t.Fatalf("the lint class must fail a strict run: %s", strictOut)
	}
	if !strings.Contains(strictOut, `"ok": false`) || !strings.Contains(strictOut, "render-unsupported") {
		t.Fatalf("strict document: %s", strictOut)
	}
	if !sameTree(treeSnapshot(t, distDir), before) {
		t.Fatal("the existing export must be byte-untouched")
	}
	// The internal chrome is regenerated regardless: the no-write promise is the
	// target's, per the pipeline order.
	if _, err := os.Stat(filepath.Join(viewerDir, "index.html")); err != nil {
		t.Fatal("the chrome must be regenerated")
	}
	if _, err := os.Stat(filepath.Join(viewerDir, "assets")); err != nil {
		t.Fatal("the internal chrome must carry its assets")
	}

	// One operation, two names: the gate answers the same under `viewer build`.
	other, otherOut, _ := captureRun(t, []string{"viewer", "build", "--root", dir, "--strict", "--json"})
	if other != 1 {
		t.Fatalf("the gate must hold under the other name: %s", otherOut)
	}
	if !sameTree(treeSnapshot(t, distDir), before) {
		t.Fatal("and still byte-untouched")
	}
}
