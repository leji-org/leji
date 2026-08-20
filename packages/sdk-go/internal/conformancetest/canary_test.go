package conformancetest

// The trust-domain boundary, driven from the shared fixtures: nothing under
// `.leji/` except `viewer/` is servable, and no export carries a byte of it. The
// fixtures own the request corpus (`trustCanary`) and the layout claims
// (`export.layout`), so all three SDKs answer identical requests against identical
// bytes.
//
// Scope: the four F8 layout fixtures — their layout roles, their golden export
// bytes, and their canary corpus. The general `export`-block harness (findings,
// `--strict` variants) takes every other fixture.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/export"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/serve"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/viewer"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

var layoutFixtures = []string{
	"valid-unified-leji-fresh",
	"valid-unified-leji-stale-tree",
	"valid-trust-canary-nested-root",
	"valid-trust-canary-dot-root",
}

// token is the planted byte string. Spelled in each harness and deliberately in no
// `expected.json`: under `rootPath: "."` a fixture's own metadata is exported like
// any other file, so a token literal there would count as a leak.
const token = "LEJI-TRUST-CANARY"

type seed struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type expectedLayout struct {
	Roles     map[string]string `json:"roles"`
	Present   []string          `json:"present"`
	Absent    []string          `json:"absent"`
	Preserved []string          `json:"preserved"`
}

type expectedExport struct {
	Exit   int            `json:"exit"`
	Out    string         `json:"out"`
	Layout expectedLayout `json:"layout"`
	Rerun  struct {
		ByteIdentical bool `json:"byteIdentical"`
	} `json:"rerun"`
	GoldenTree goldenTree `json:"goldenTree"`
}

type canaryRequest struct {
	Path   string `json:"path"`
	Status int    `json:"status"`
	Note   string `json:"note"`
}

type expectedCanary struct {
	Topology     string   `json:"topology"`
	PlantedPaths []string `json:"plantedPaths"`
	Serve        struct {
		Requests  []canaryRequest `json:"requests"`
		RouteScan *struct {
			AssertNoTokenIn200Bodies *bool `json:"assertNoTokenIn200Bodies"`
		} `json:"routeScan"`
	} `json:"serve"`
	ExportScan struct {
		Root        string `json:"root"`
		Occurrences int    `json:"occurrences"`
	} `json:"exportScan"`
}

type layoutExpectation struct {
	Seeds       []seed          `json:"seeds"`
	Export      *expectedExport `json:"export"`
	TrustCanary *expectedCanary `json:"trustCanary"`
}

// fixtureRel checks a fixture-declared path as the README fixes it:
// repository-root-relative POSIX, normalized, no `..` segment, never absolute. A
// violation is a harness error — the fixture is the contract, so a malformed one
// fails loudly rather than being repaired here.
func fixtureRel(t *testing.T, value, what string) string {
	t.Helper()
	if path.IsAbs(value) {
		t.Fatalf("%s must be relative: %s", what, value)
	}
	trimmed := strings.TrimRight(value, "/")
	if normalized := path.Clean(value); normalized != trimmed {
		t.Fatalf("%s must be normalized: %s", what, value)
	}
	for _, seg := range strings.Split(trimmed, "/") {
		if seg == ".." {
			t.Fatalf("%s must not escape the fixture: %s", what, value)
		}
	}
	return trimmed
}

// fixtureAbs joins a fixture-declared POSIX path onto a working copy.
func fixtureAbs(dir, rel string) string {
	return filepath.Join(dir, filepath.FromSlash(rel))
}

// copySeed copies a committed seed's CONTENTS into `to`, which the harness creates.
// Regular files and directories only: a symlink anywhere inside a seed is a harness
// error, and no seed file is ever executed, so modes stay the platform's default.
func copySeed(t *testing.T, from, to string) {
	t.Helper()
	if err := os.MkdirAll(to, 0o755); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(from)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		src := filepath.Join(from, e.Name())
		dest := filepath.Join(to, e.Name())
		if e.Type()&os.ModeSymlink != 0 {
			t.Fatalf("seed carries a symlink: %s", src)
		}
		if e.IsDir() {
			if e.Name() == ".leji" || e.Name() == "dist" {
				t.Fatalf("seed path component %q is gitignored at any depth; spell it under the seed name", e.Name())
			}
			copySeed(t, src, dest)
			continue
		}
		if !e.Type().IsRegular() {
			t.Fatalf("seed carries a non-regular file: %s", src)
		}
		body, err := os.ReadFile(src)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(dest, body, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// materialize is a pristine working copy of the fixture with every declared seed
// materialized.
func materialize(t *testing.T, name string, seeds []seed) string {
	t.Helper()
	dir := t.TempDir()
	cpTree(t, filepath.Join(fixturesDir(t), name), dir)
	var targets []string
	for _, s := range seeds {
		from := fixtureRel(t, s.From, "seed.from")
		to := fixtureRel(t, s.To, "seed.to")
		toAbs := fixtureAbs(dir, to)
		// A pre-existing target means the working copy is not what the harness thinks
		// it is; overlapping targets are a fixture-authoring error, not something to
		// resolve by ordering.
		if _, err := os.Lstat(toAbs); err == nil {
			t.Fatalf("seed target already exists: %s", to)
		}
		for _, other := range targets {
			if to == other || strings.HasPrefix(to, other+"/") {
				t.Fatalf("seed targets overlap: %s and %s", to, other)
			}
		}
		targets = append(targets, to)
		copySeed(t, fixtureAbs(dir, from), toAbs)
	}
	return dir
}

// cpTree copies src's contents into dst (which must exist); plain files and
// directories, the shape every fixture ships.
func cpTree(t *testing.T, src, dst string) {
	t.Helper()
	entries, err := os.ReadDir(src)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		from := filepath.Join(src, e.Name())
		to := filepath.Join(dst, e.Name())
		if e.IsDir() {
			if err := os.MkdirAll(to, 0o755); err != nil {
				t.Fatal(err)
			}
			cpTree(t, from, to)
			continue
		}
		body, err := os.ReadFile(from)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(to, body, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// snapshot is every path under dir as `rel -> content digest` (directories as
// `rel/` -> ""), so a comparison covers appearance and disappearance as well as
// content.
//
// A `.git/` at the ROOT is the harness's own scaffolding and is excluded: no run
// under test can touch it, and git can. Background maintenance on a hosted runner
// rewrites a repository's object store on its own schedule, which reaches a
// comparison like this one two ways — a transient it opens and git removes
// mid-walk (`open .git/objects/maintenance.lock: no such file or directory`), and a
// pack that is simply not the pack the first snapshot saw. Both are the runner's
// git, never the subject, and both were seen on one rc run. Only the root is
// skipped: a `.git` deeper inside a fixture is content that fixture ships, and the
// TS and Python siblings of this helper draw the line in the same place.
func snapshot(t *testing.T, dir string) []string {
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
			if rel == "" && e.Name() == ".git" {
				continue
			}
			childRel := e.Name()
			if rel != "" {
				childRel = rel + "/" + e.Name()
			}
			switch {
			case e.IsDir():
				out = append(out, childRel+"/\x00")
				walk(childRel)
			case e.Type().IsRegular():
				body, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(childRel)))
				if err != nil {
					t.Fatal(err)
				}
				sum := sha256.Sum256(body)
				out = append(out, childRel+"\x00"+hex.EncodeToString(sum[:]))
			default:
				out = append(out, childRel+"\x00non-regular")
			}
		}
	}
	walk("")
	sort.Strings(out)
	return out
}

// countToken counts recursive occurrences of the token under dir (an absent dir
// counts as zero, which is what a run that wrote no tree leaves behind).
func countToken(t *testing.T, dir string) (int, []string) {
	t.Helper()
	if _, err := os.Stat(dir); err != nil {
		return 0, nil
	}
	count := 0
	var where []string
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
			if !e.Type().IsRegular() {
				continue
			}
			body, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(childRel)))
			if err != nil {
				t.Fatal(err)
			}
			if hits := strings.Count(string(body), token); hits > 0 {
				count += hits
				where = append(where, childRel)
			}
		}
	}
	walk("")
	return count, where
}

// serveLayer starts the viewer over dir and returns its base URL plus a stop func.
func serveLayer(t *testing.T, dir string, m *manifest.Manifest) (string, func()) {
	t.Helper()
	ln, srv, err := serve.Serve(dir, 0, m.RootPath, nil)
	if err != nil {
		t.Fatalf("serve: %v", err)
	}
	go func() { _ = srv.Serve(ln) }()
	return "http://" + ln.Addr().String(), func() { _ = srv.Close() }
}

// requestRaw issues one request with the corpus's path EXACTLY as written — no URL
// parsing on this side, or the encoded and malformed variants would be
// canonicalized before the server ever saw them.
func requestRaw(t *testing.T, addr, urlPath string) (int, string) {
	t.Helper()
	host := strings.TrimPrefix(addr, "http://")
	conn, err := net.Dial("tcp", host)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close() }()
	if _, err := fmt.Fprintf(conn, "GET %s HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n", urlPath); err != nil {
		t.Fatalf("write request: %v", err)
	}
	raw, err := io.ReadAll(conn)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	text := string(raw)
	var status int
	if _, err := fmt.Sscanf(text, "HTTP/1.0 %d", &status); err != nil {
		if _, err := fmt.Sscanf(text, "HTTP/1.1 %d", &status); err != nil {
			t.Fatalf("unparsable status line: %q", text)
		}
	}
	body := ""
	if i := strings.Index(text, "\r\n\r\n"); i >= 0 {
		body = text[i+4:]
	}
	return status, body
}

func loadLayoutExpectation(t *testing.T, name string) layoutExpectation {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(fixturesDir(t), name, "expected.json"))
	if err != nil {
		t.Fatal(err)
	}
	var exp layoutExpectation
	if err := json.Unmarshal(b, &exp); err != nil {
		t.Fatal(err)
	}
	return exp
}

func TestLayoutFixturesCanaryAndIdempotency(t *testing.T) {
	for _, name := range layoutFixtures {
		t.Run(name, func(t *testing.T) {
			exp := loadLayoutExpectation(t, name)
			if exp.Export == nil {
				t.Fatalf("%s must declare an export block", name)
			}
			canary := exp.TrustCanary
			dir := materialize(t, name, exp.Seeds)
			m := manifest.LoadManifest(dir).Manifest
			if m == nil {
				t.Fatal("the fixture manifest must load")
			}

			// The planted bytes are really planted: without this the scans below could
			// pass over a fixture that plants nothing.
			plantedBefore := map[string]string{}
			if canary != nil {
				for _, rel := range canary.PlantedPaths {
					body, err := os.ReadFile(fixtureAbs(dir, fixtureRel(t, rel, "plantedPaths entry")))
					if err != nil {
						t.Fatal(err)
					}
					if !strings.Contains(string(body), token) {
						t.Fatalf("%s must carry the canary token", rel)
					}
					plantedBefore[rel] = string(body)
				}
			}
			// Every path the fixture says must survive the run, as it stands before it.
			preservedBefore := map[string]string{}
			for _, rel := range exp.Export.Layout.Preserved {
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

			// --- the run ---------------------------------------------------------
			first, err := export.BuildViewer(dir, m, "", export.Options{})
			if err != nil {
				t.Fatalf("BuildViewer: %v", err)
			}
			exit := 0
			for _, f := range first.Findings {
				if f.Severity == findings.Error {
					exit = 1
				}
			}
			if exit != exp.Export.Exit {
				t.Fatalf("exit code %d, want %d (findings: %v)", exit, exp.Export.Exit, first.Findings)
			}
			if got := filepath.ToSlash(first.Out); got != exp.Export.Out {
				t.Fatalf("output directory %q, want %q", got, exp.Export.Out)
			}

			// --- layout ----------------------------------------------------------
			for role, roleDir := range exp.Export.Layout.Roles {
				abs := fixtureAbs(dir, fixtureRel(t, roleDir, "role "+role))
				if info, err := os.Stat(abs); err != nil || !info.IsDir() {
					t.Fatalf("role %s must be established at %s", role, roleDir)
				}
			}
			for _, rel := range exp.Export.Layout.Present {
				if _, err := os.Stat(fixtureAbs(dir, fixtureRel(t, rel, "present entry"))); err != nil {
					t.Fatalf("must be present after the run: %s", rel)
				}
			}
			for _, rel := range exp.Export.Layout.Absent {
				if _, err := os.Stat(fixtureAbs(dir, fixtureRel(t, rel, "absent entry"))); err == nil {
					t.Fatalf("must never be created: %s", rel)
				}
			}
			for rel, before := range preservedBefore {
				body, err := os.ReadFile(fixtureAbs(dir, rel))
				if err != nil {
					t.Fatalf("must still be present after the run: %s", rel)
				}
				if string(body) != before {
					t.Fatalf("must be byte-identical after the run: %s", rel)
				}
			}

			// --- the golden tree ---------------------------------------------------
			assertGoldenTree(t, filepath.Join(fixturesDir(t), name),
				fixtureAbs(dir, fixtureRel(t, exp.Export.Out, "export out")), exp.Export.GoldenTree)

			// --- the export-side scan --------------------------------------------
			if canary != nil {
				scanRoot := fixtureAbs(dir, fixtureRel(t, canary.ExportScan.Root, "exportScan.root"))
				count, where := countToken(t, scanRoot)
				if count != canary.ExportScan.Occurrences {
					t.Fatalf("canary occurrences in %s: %d, want %d (%v)",
						canary.ExportScan.Root, count, canary.ExportScan.Occurrences, where)
				}
			}

			// --- the serve corpus -------------------------------------------------
			if canary != nil {
				addr, stop := serveLayer(t, dir, m)
				scanBodies := canary.Serve.RouteScan == nil || canary.Serve.RouteScan.AssertNoTokenIn200Bodies == nil ||
					*canary.Serve.RouteScan.AssertNoTokenIn200Bodies
				for _, want := range canary.Serve.Requests {
					status, body := requestRaw(t, addr, want.Path)
					if status != want.Status {
						t.Fatalf("%s: status %d, want %d%s", want.Path, status, want.Status, noteOf(want))
					}
					if status == 200 && scanBodies && strings.Contains(body, token) {
						t.Fatalf("canary byte in the 200 body of %s", want.Path)
					}
				}
				stop()
			}

			// --- idempotency -------------------------------------------------------
			if exp.Export.Rerun.ByteIdentical {
				afterFirst := snapshot(t, dir)
				if _, err := export.BuildViewer(dir, m, "", export.Options{}); err != nil {
					t.Fatalf("second BuildViewer: %v", err)
				}
				afterSecond := snapshot(t, dir)
				if !equalStrings(afterFirst, afterSecond) {
					t.Fatalf("a second run must be a byte-level no-op across the whole working tree\nfirst=%v\nsecond=%v",
						diffStrings(afterFirst, afterSecond), diffStrings(afterSecond, afterFirst))
				}
			}

			// The planted bytes are still exactly as planted: the tool never read them
			// into anything, and never rewrote them either.
			for rel, before := range plantedBefore {
				body, err := os.ReadFile(fixtureAbs(dir, rel))
				if err != nil || string(body) != before {
					t.Fatalf("must be untouched: %s", rel)
				}
			}
		})
	}
}

func noteOf(r canaryRequest) string {
	if r.Note == "" {
		return ""
	}
	return " — " + r.Note
}

// diffStrings is the entries of a not present in b (sorted slices).
func diffStrings(a, b []string) []string {
	set := map[string]bool{}
	for _, s := range b {
		set[s] = true
	}
	var out []string
	for _, s := range a {
		if !set[s] {
			out = append(out, s)
		}
	}
	return out
}

// canaryLayer is the dot-root canary layer with its seed materialized: the topology
// where the trust domain sits inside the content mount, so a symlink into it
// resolves inside every containment check and only the by-name whitelist refuses it.
func canaryLayer(t *testing.T) string {
	t.Helper()
	return materialize(t, "valid-trust-canary-dot-root", []seed{{From: ".leji-seed", To: ".leji"}})
}

func mustLoad(t *testing.T, dir string) *manifest.Manifest {
	t.Helper()
	m := manifest.LoadManifest(dir).Manifest
	if m == nil {
		t.Fatal("the fixture manifest must load")
	}
	return m
}

// The one boundary a fixture cannot plant (a seed carries no symlinks) and the one
// the dot convention cannot hold: under `rootPath: "."` the trust domain really is
// inside the content mount, so a symlink there resolves INSIDE the mount root and
// passes every containment check. Only the by-name whitelist refuses it — remove the
// ServablePath calls in the serve path and this test serves the canary.
func TestWhitelistRefusesContentSymlinkIntoPrivateRole(t *testing.T) {
	dir := canaryLayer(t)
	if err := os.Symlink(filepath.Join(".leji", "work", "proposal.md"), filepath.Join(dir, "leak.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(".leji", "work"), filepath.Join(dir, "leakdir")); err != nil {
		t.Fatal(err)
	}
	m := mustLoad(t, dir)
	// Generate the chrome (and an export) with the symlinks already planted, so the
	// serve legs run against a complete layer and the export legs see the bait.
	if _, err := export.BuildViewer(dir, m, "", export.Options{}); err != nil {
		t.Fatalf("BuildViewer: %v", err)
	}
	addr, stop := serveLayer(t, dir, m)
	defer stop()
	for _, route := range []string{"/content/leak.md", "/content/leakdir/proposal.md"} {
		status, body := requestRaw(t, addr, route)
		if status != http.StatusNotFound {
			t.Fatalf("%s must be denied by name whatever it resolves to, got %d", route, status)
		}
		if strings.Contains(body, token) {
			t.Fatalf("canary byte in the response to %s", route)
		}
	}
	// The servable role still serves through its own mount: the whitelist denies the
	// other roles, not the chrome.
	if status, _ := requestRaw(t, addr, "/index.html"); status != http.StatusOK {
		t.Fatalf("the chrome must still serve, got %d", status)
	}
	// And the export never followed it either (symlinks are skipped, and the target is
	// outside the enumerated roots).
	if count, where := countToken(t, filepath.Join(dir, ".leji", "dist")); count != 0 {
		t.Fatalf("canary bytes in the export: %v", where)
	}
	if _, err := os.Stat(filepath.Join(dir, ".leji", "dist", "content", "leak.md")); err == nil {
		t.Fatal("the symlink must not be exported")
	}
}

// The vectors below share the reason the test above lives here rather than in a
// fixture: they need a symlink (a seed carries none by contract — copySeed refuses
// one) or a hostile manifest, which is a per-SDK hazard rather than a shared contract
// the fixtures publish. So they are constructed at runtime, over a fixture's own
// layer and its own planted bytes.

func TestWhitelistRefusesBoundProfileInPrivateRole(t *testing.T) {
	dir := canaryLayer(t)
	// A profile pair the resolver really composes: an ordinary base under the layer's
	// agents directory, and a derived half planted in the onboarding workspace, bound
	// into the roster by a symlink at the content root. Without the whitelist on the
	// profile sources, the resolved page renders the planted half verbatim — the
	// overlay answers before the content mount ever judges the path.
	if err := os.MkdirAll(filepath.Join(dir, "agents"), 0o755); err != nil {
		t.Fatal(err)
	}
	base := strings.Join([]string{
		"---", "id: core", "name: Core", "role: core",
		"requiredRead:", "  - boot-profile.md",
		"mustAskWhen:", "  - anything is unclear", "---", "", "Base body.", "",
	}, "\n")
	if err := os.WriteFile(filepath.Join(dir, "agents", "core.md"), []byte(base), 0o644); err != nil {
		t.Fatal(err)
	}
	derived := strings.Join([]string{
		"---", "id: leak", "name: Leak", "role: leak", "inherits: core", "---", "", "Planted: " + token, "",
	}, "\n")
	if err := os.WriteFile(filepath.Join(dir, ".leji", "work", "leak-profile.md"), []byte(derived), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(".leji", "work", "leak-profile.md"), filepath.Join(dir, "leak.md")); err != nil {
		t.Fatal(err)
	}
	patchManifest(t, dir, func(declared map[string]any) {
		declared["agents"] = map[string]any{"leak": "leak.md"}
	})

	m := mustLoad(t, dir)
	if _, err := export.BuildViewer(dir, m, "", export.Options{}); err != nil {
		t.Fatalf("BuildViewer: %v", err)
	}
	addr, stop := serveLayer(t, dir, m)
	defer stop()
	status, body := requestRaw(t, addr, "/content/leak.md")
	if status != http.StatusNotFound {
		t.Fatalf("the profile overlay must refuse a source it may not read, got %d", status)
	}
	if strings.Contains(body, token) {
		t.Fatal("canary byte in the response")
	}
	// The overlay still resolves the profiles it may read.
	if status, _ := requestRaw(t, addr, "/content/agents/core.md"); status != http.StatusOK {
		t.Fatalf("a servable profile must still resolve, got %d", status)
	}
	if count, where := countToken(t, filepath.Join(dir, ".leji", "dist")); count != 0 {
		t.Fatalf("canary bytes in the export: %v", where)
	}
	if _, err := os.Stat(filepath.Join(dir, ".leji", "dist", "content", "leak.md")); err == nil {
		t.Fatal("no page must be written for it")
	}
}

func TestSidebarLiftsNoLabelOutOfAPrivateProfilesDir(t *testing.T) {
	dir := canaryLayer(t)
	// The same scan, reached the other way: a declared `agentProfilesPath` naming a
	// private role needs no symlink at all. The page itself was always refused, but the
	// sidebar built its label from the file's frontmatter — bytes of a private file,
	// served in a 200 body and copied into the export.
	planted := strings.Join([]string{
		"---", "id: planted", "name: " + token, "role: planted",
		"requiredRead:", "  - boot-profile.md",
		"mustAskWhen:", "  - anything is unclear", "---", "", "Body.", "",
	}, "\n")
	if err := os.WriteFile(filepath.Join(dir, ".leji", "work", "p.md"), []byte(planted), 0o644); err != nil {
		t.Fatal(err)
	}
	patchManifest(t, dir, func(declared map[string]any) {
		declared["machine"] = map[string]any{"agentProfilesPath": ".leji/work/"}
	})
	m := mustLoad(t, dir)
	if _, err := export.BuildViewer(dir, m, "", export.Options{}); err != nil {
		t.Fatalf("BuildViewer: %v", err)
	}
	if count, where := countToken(t, filepath.Join(dir, ".leji", "dist")); count != 0 {
		t.Fatalf("canary bytes in the export: %v", where)
	}
	addr, stop := serveLayer(t, dir, m)
	defer stop()
	status, body := requestRaw(t, addr, "/content/_sidebar.md")
	if status != http.StatusOK {
		t.Fatalf("the live sidebar must still build, got %d", status)
	}
	if strings.Contains(body, token) {
		t.Fatal("the sidebar must carry no byte of the planted profile")
	}
}

// --- The check-before-act invariant on WRITE/CLEAR targets ----------------------------------
// One structural rule: every location the tool writes into or clears is realpath-
// resolved and validated against its role BEFORE the operation — never after, never
// conditionally. These pin the two write-side vectors two review rounds left open.

func TestCheckBeforeActGenerationRefusesViewerAliasedIntoPrivateRole(t *testing.T) {
	dir := canaryLayer(t)
	// Point the servable role at another private role, bytes of its own already there.
	// Before the check-before-act rule, generation wrote the chrome THROUGH the link
	// into the trust domain and only the export's later identity check noticed — after
	// the mutation. The aliased directory is snapshotted WHOLE, so any pre-refusal write
	// (not just an overwrite of one planted file) is caught.
	aliased := filepath.Join(dir, ".leji", "work", "chrome")
	if err := os.MkdirAll(filepath.Join(aliased, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(aliased, "assets", "planted.txt"), []byte(token+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("work", "chrome"), filepath.Join(dir, ".leji", "viewer")); err != nil {
		t.Fatal(err)
	}
	m := mustLoad(t, dir)
	before := snapshot(t, aliased)

	gen, err := viewer.GenerateViewer(dir, m)
	if err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	if !hasRefusal(gen.Findings) {
		t.Fatalf("generation must refuse with a hard error, got %v", gen.Findings)
	}
	if len(gen.Written) != 0 {
		t.Fatalf("generation must write nothing, got %v", gen.Written)
	}
	if !equalStrings(before, snapshot(t, aliased)) {
		t.Fatal("the aliased private role must be byte-identical")
	}

	// BuildViewer regenerates first, so it inherits the refusal and never reaches the
	// destructive clean/copy: no export is produced either.
	built, err := export.BuildViewer(dir, m, "", export.Options{})
	if err != nil {
		t.Fatalf("BuildViewer: %v", err)
	}
	if !hasRefusal(built.Findings) {
		t.Fatalf("the export must inherit the refusal, got %v", built.Findings)
	}
	if !equalStrings(before, snapshot(t, aliased)) {
		t.Fatal("still untouched after BuildViewer")
	}
	if _, err := os.Stat(filepath.Join(dir, ".leji", "dist")); err == nil {
		t.Fatal("no export must be written")
	}
}

func TestCheckBeforeActDefaultOutputRefusesDistIntoPrivateRole(t *testing.T) {
	dir := canaryLayer(t)
	// The surviving default-bypass vector: the reservation used to be conditioned on a
	// caller --out, so a default .leji/dist redirected into the trust domain slipped
	// through. Now the default is validated identically — before any clear or write.
	planted := filepath.Join(dir, ".leji", "mounts", "store", "x")
	if err := os.MkdirAll(planted, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(planted, "planted"), []byte(token+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("mounts", "store", "x"), filepath.Join(dir, ".leji", "dist")); err != nil {
		t.Fatal(err)
	}
	m := mustLoad(t, dir)
	before := snapshot(t, filepath.Join(dir, ".leji", "mounts"))
	_, err := export.BuildViewer(dir, m, "", export.Options{})
	if err == nil || !strings.Contains(err.Error(), "reserved for the tool's own roles") {
		t.Fatalf("the default output must be refused, got %v", err)
	}
	if !equalStrings(before, snapshot(t, filepath.Join(dir, ".leji", "mounts"))) {
		t.Fatal("nothing must be cleared or written in the private role")
	}
	body, rerr := os.ReadFile(filepath.Join(planted, "planted"))
	if rerr != nil || string(body) != token+"\n" {
		t.Fatal("the planted bytes must be intact")
	}
}

func TestCheckBeforeActOutOfRepositoryViewerOrDistAliasIsRefused(t *testing.T) {
	// Containment is absolute: every write this tool makes lands inside the repository
	// it was pointed at. A `.leji/viewer` or `.leji/dist` symlinked to a real, empty
	// destination outside the tree — once a supported relocate/publish alias — is a
	// hard refusal now, with nothing written through it. A user who wants the export
	// elsewhere copies the finished folder there.
	chromeHome := t.TempDir()
	relocated := canaryLayer(t)
	if err := os.Symlink(chromeHome, filepath.Join(relocated, ".leji", "viewer")); err != nil {
		t.Fatal(err)
	}
	m := mustLoad(t, relocated)
	built, err := export.BuildViewer(relocated, m, "", export.Options{})
	if err != nil {
		t.Fatalf("the relocated viewer role must be a finding, not a failure: %v", err)
	}
	if !hasRefusal(built.Findings) {
		t.Fatalf("the relocated viewer role must be refused, got %v", built.Findings)
	}
	if built.Wrote {
		t.Fatal("the export must not run")
	}
	if entries, rerr := os.ReadDir(chromeHome); rerr != nil || len(entries) != 0 {
		t.Fatalf("nothing may be written into the out-of-tree viewer home, got %v (%v)", entries, rerr)
	}

	publish := t.TempDir()
	published := canaryLayer(t)
	if err := os.Symlink(publish, filepath.Join(published, ".leji", "dist")); err != nil {
		t.Fatal(err)
	}
	pm := mustLoad(t, published)
	_, berr := export.BuildViewer(published, pm, "", export.Options{})
	if berr == nil || !strings.Contains(berr.Error(), "resolves outside the repository") {
		t.Fatalf("the out-of-tree publish target must be refused, got %v", berr)
	}
	if entries, rerr := os.ReadDir(publish); rerr != nil || len(entries) != 0 {
		t.Fatalf("nothing may be written into the out-of-tree publish root, got %v (%v)", entries, rerr)
	}
}

func TestCheckBeforeActBoundarySkipWarnsOnceAndCleanBuildIsSilent(t *testing.T) {
	// A servable-looking source (an .md at the content root) whose resolved path lands
	// in a private role: withheld from serve and export, and — unlike an ordinary skip —
	// it says why, exactly once, on stderr (never stdout, never --json).
	dir := canaryLayer(t)
	if err := os.Symlink(filepath.Join(".leji", "work", "proposal.md"), filepath.Join(dir, "leak.md")); err != nil {
		t.Fatal(err)
	}
	m := mustLoad(t, dir)
	stderr := captureStderr(t, func() {
		if _, err := export.BuildViewer(dir, m, "", export.Options{}); err != nil {
			t.Fatalf("BuildViewer: %v", err)
		}
	})
	var warnings []string
	for _, line := range strings.Split(stderr, "\n") {
		if strings.HasPrefix(line, "skipped leak.md:") {
			warnings = append(warnings, line)
		}
	}
	if len(warnings) != 1 {
		t.Fatalf("the withheld source must be named exactly once: %q", stderr)
	}
	if !strings.Contains(warnings[0], "resolves into .leji/work (private); not served or exported") {
		t.Fatalf("boundary-skip wording: %q", warnings[0])
	}
	if count, _ := countToken(t, filepath.Join(dir, ".leji", "dist")); count != 0 {
		t.Fatal("no canary byte must reach the export")
	}

	// A clean layer (no cross-role source) says nothing on stderr.
	clean := canaryLayer(t)
	m2 := mustLoad(t, clean)
	quiet := captureStderr(t, func() {
		if _, err := export.BuildViewer(clean, m2, "", export.Options{}); err != nil {
			t.Fatalf("BuildViewer: %v", err)
		}
	})
	for _, line := range strings.Split(quiet, "\n") {
		if strings.HasPrefix(line, "skipped ") {
			t.Fatalf("a clean build must emit no boundary-skip warning: %q", quiet)
		}
	}
}

func TestExportRefusesOutThatResolvesIntoPrivateRole(t *testing.T) {
	// The nested topology, deliberately: with the content root a subdirectory, an --out
	// at the repository root is a legitimate destination, so the reservation is the only
	// rule standing between a redirected path and the private domain.
	dir := materialize(t, "valid-trust-canary-nested-root", []seed{{From: ".leji-seed", To: ".leji"}})
	m := mustLoad(t, dir)
	// Proof the destination is otherwise open: an ordinary sibling path exports.
	if _, err := export.BuildViewer(dir, m, "plain-out", export.Options{}); err != nil {
		t.Fatalf("an ordinary --out at the root must export: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "plain-out", "index.html")); err != nil {
		t.Fatalf("expected the ordinary export: %v", err)
	}
	// The same path, redirected: the reservation judges where the write would land, so
	// the private role is refused however the destination is spelled.
	if err := os.Symlink(filepath.Join(".leji", "mounts"), filepath.Join(dir, "redirect")); err != nil {
		t.Fatal(err)
	}
	_, err := export.BuildViewer(dir, m, "redirect/export", export.Options{})
	if err == nil || !strings.Contains(err.Error(), "reserved for the tool's own roles") {
		t.Fatalf("a redirected --out must be refused, got %v", err)
	}
	if _, serr := os.Stat(filepath.Join(dir, ".leji", "mounts", "export")); serr == nil {
		t.Fatal("nothing must be written into the private role")
	}
	// The refusal is not destructive either: the planted bytes are as planted.
	body, rerr := os.ReadFile(filepath.Join(dir, ".leji", "mounts", "store", "x", "planted"))
	if rerr != nil || !strings.Contains(string(body), token) {
		t.Fatal("the private role must be intact")
	}
}

// --- Check-before-act completeness: the overview.md write sites and the resolver's dangling paths.
// These pin the write sites two review rounds after the first left them: overview.md
// (seed AND refresh) is a content write that used to be guarded by containment only,
// and a nested/chained/unresolvable `--out` whose real destination the resolver used
// to rebuild lexically. Each hard-refusal case names, in its comment, the mutation
// that reddens it.

func TestCheckBeforeActOverviewSeedRefusedIntoPrivateRole(t *testing.T) {
	// rootPath ".", so overview.md is seeded at the repository root. A symlink there
	// into a private role is contained (inside the repo) yet crosses the trust boundary:
	// containment-only was the gap. The target dangles, so the seed WOULD create it
	// inside the role. Mutation that reddens: revert the overview guard to
	// ResolvedWithinRoot-only (no WritableTarget) — the seed writes through and
	// .leji/work/new.md appears.
	for _, role := range []string{"work", "mounts"} {
		dir := canaryLayer(t)
		roleDir := filepath.Join(dir, ".leji", role)
		if err := os.MkdirAll(roleDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join(".leji", role, "new.md"), filepath.Join(dir, "overview.md")); err != nil {
			t.Fatal(err)
		}
		m := mustLoad(t, dir)
		before := snapshot(t, roleDir)

		gen, err := viewer.GenerateViewer(dir, m)
		if err != nil {
			t.Fatalf("GenerateViewer: %v", err)
		}
		found := false
		for _, f := range gen.Findings {
			if f.Rule == "viewer-target-refused" && f.Severity == findings.Error &&
				strings.Contains(f.Message, "overview.md") &&
				strings.Contains(f.Message, ".leji/"+role+" (private)") {
				found = true
			}
		}
		if !found {
			t.Fatalf("generation must refuse the overview.md seed into .leji/%s, got %v", role, gen.Findings)
		}
		for _, w := range gen.Written {
			if w == "overview.md" {
				t.Fatal("overview.md must not be reported written")
			}
		}
		if _, err := os.Stat(filepath.Join(roleDir, "new.md")); err == nil {
			t.Fatal("nothing must be written through the alias")
		}
		if !equalStrings(before, snapshot(t, roleDir)) {
			t.Fatalf("the aliased .leji/%s must be byte-identical", role)
		}
	}

	// Generation-side case variant: a `.LEJI/` spelling of a role folds to the role on a
	// case-insensitive volume, so the resolved target is judged, not the spelling.
	dir := canaryLayer(t)
	if !foldsCase(t, dir) {
		return
	}
	if err := os.MkdirAll(filepath.Join(dir, ".leji", "work"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(".LEJI", "work", "case.md"), filepath.Join(dir, "overview.md")); err != nil {
		t.Fatal(err)
	}
	m := mustLoad(t, dir)
	gen, err := viewer.GenerateViewer(dir, m)
	if err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	found := false
	for _, f := range gen.Findings {
		if f.Rule == "viewer-target-refused" && strings.Contains(f.Message, "overview.md") {
			found = true
		}
	}
	if !found {
		t.Fatalf("a case-variant overview.md alias must be refused as the role it folds to, got %v", gen.Findings)
	}
	if _, err := os.Stat(filepath.Join(dir, ".leji", "work", "case.md")); err == nil {
		t.Fatal("nothing must be written through the case variant")
	}
}

func TestCheckBeforeActOverviewStandingAsANonRegularEntryIsRefused(t *testing.T) {
	// The map is neither seeded through a standing entry this run cannot verify nor
	// refreshed from bytes read by pathname: a dangling link resolves nowhere while
	// still standing, and a directory is not a page. Both are the verified read's
	// refusal, reported as a finding with nothing written. Mutation that reddens:
	// decide the seed with a stat again — the dangling case writes the link's
	// destination.
	for _, c := range []struct {
		name  string
		plant func(t *testing.T, dir string)
	}{
		{"a dangling link", func(t *testing.T, dir string) {
			if err := os.Symlink("never-created.md", filepath.Join(dir, "overview.md")); err != nil {
				t.Fatal(err)
			}
		}},
		{"a directory", func(t *testing.T, dir string) {
			if err := os.Mkdir(filepath.Join(dir, "overview.md"), 0o755); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		dir := canaryLayer(t)
		c.plant(t, dir)
		m := mustLoad(t, dir)

		gen, err := viewer.GenerateViewer(dir, m)
		if err != nil {
			t.Fatalf("%s: GenerateViewer: %v", c.name, err)
		}
		found := false
		for _, f := range gen.Findings {
			if f.Rule == "viewer-target-refused" && f.Severity == findings.Error &&
				strings.Contains(f.Message, "overview.md") &&
				strings.Contains(f.Message, "does not resolve to a regular file inside the repository") {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s: the overview must be refused, got %v", c.name, gen.Findings)
		}
		for _, w := range gen.Written {
			if w == "overview.md" {
				t.Fatalf("%s: overview.md must not be reported written", c.name)
			}
		}
		if _, err := os.Lstat(filepath.Join(dir, "never-created.md")); err == nil {
			t.Fatalf("%s: the dangling link's destination must never be created", c.name)
		}
	}
}

func TestCheckBeforeActOverviewRefreshRefusesAliasIntoPrivateRole(t *testing.T) {
	// overview.md is a symlink to an EXISTING private file carrying the generated-map
	// markers: the refresh branch (isFile true) used to containment-check, read it, and
	// rewrite the map block THROUGH the link. The check now runs on the resolved path
	// before the read. Mutation that reddens: revert to ResolvedWithinRoot-only — the private
	// file is read and its map block rewritten.
	dir := canaryLayer(t)
	target := filepath.Join(dir, ".leji", "mounts", "existing.md")
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	original := "# private " + token + "\n<!-- leji:generated-map:start -->STALE<!-- leji:generated-map:end -->\n"
	if err := os.WriteFile(target, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(".leji", "mounts", "existing.md"), filepath.Join(dir, "overview.md")); err != nil {
		t.Fatal(err)
	}
	m := mustLoad(t, dir)

	gen, err := viewer.GenerateViewer(dir, m)
	if err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	found := false
	for _, f := range gen.Findings {
		if f.Rule == "viewer-target-refused" && f.Severity == findings.Error &&
			strings.Contains(f.Message, "overview.md") && strings.Contains(f.Message, ".leji/mounts (private)") {
			found = true
		}
	}
	if !found {
		t.Fatalf("the refresh must refuse the alias with a hard error, got %v", gen.Findings)
	}
	body, rerr := os.ReadFile(target)
	if rerr != nil || string(body) != original {
		t.Fatal("the private file must be neither read-then-rewritten nor touched")
	}
}

func TestExportRefusesNestedDanglingOutIntoPrivateRole(t *testing.T) {
	// `redirect/export` where `redirect` is a DANGLING symlink into a private role: a
	// write would follow it, but the resolver used to climb past the dangling component
	// and rebuild `redirect/export` lexically (outside .leji/), so the check passed and a
	// target created afterward raced the write into the role. The resolver now follows
	// the dangling intermediate link. Mutation that reddens: revert ResolvedPath's
	// intermediate-symlink follow (climb-past) — outAbs reads as outside .leji/ and the
	// build is not refused.
	dir := materialize(t, "valid-trust-canary-nested-root", []seed{{From: ".leji-seed", To: ".leji"}})
	m := mustLoad(t, dir)
	// redirect -> .leji/mounts/ghost, and ghost does NOT exist: a dangling intermediate.
	if err := os.Symlink(filepath.Join(".leji", "mounts", "ghost"), filepath.Join(dir, "redirect")); err != nil {
		t.Fatal(err)
	}
	mountsBefore := snapshot(t, filepath.Join(dir, ".leji", "mounts"))
	_, err := export.BuildViewer(dir, m, "redirect/export", export.Options{})
	if err == nil || !strings.Contains(err.Error(), "reserved for the tool's own roles") {
		t.Fatalf("a nested dangling --out into a private role must be refused, got %v", err)
	}
	if _, serr := os.Stat(filepath.Join(dir, ".leji", "mounts", "ghost")); serr == nil {
		t.Fatal("the dangling target must not be created by the build")
	}
	if !equalStrings(mountsBefore, snapshot(t, filepath.Join(dir, ".leji", "mounts"))) {
		t.Fatal("nothing must be cleared or written in the private role")
	}

	// The created-after-validation race, closed: even once the target exists, the same
	// resolved path is judged, so the build still refuses (never a one-time dangling
	// fluke that a real directory would slip past).
	if err := os.MkdirAll(filepath.Join(dir, ".leji", "mounts", "ghost"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := export.BuildViewer(dir, m, "redirect/export", export.Options{}); err == nil ||
		!strings.Contains(err.Error(), "reserved for the tool's own roles") {
		t.Fatalf("must be refused again once the target is a real directory, got %v", err)
	}
}

func TestExportRefusesChainedDanglingOutIntoPrivateRole(t *testing.T) {
	// redirect -> hop -> .leji/work/ghost, every hop dangling: the resolver follows the
	// chain of intermediate dangling links to the real destination. Mutation that
	// reddens: revert ResolvedPath's intermediate-symlink follow — the chain is rebuilt
	// lexically as outside .leji/ and the build is not refused.
	dir := materialize(t, "valid-trust-canary-nested-root", []seed{{From: ".leji-seed", To: ".leji"}})
	m := mustLoad(t, dir)
	if err := os.Symlink("hop", filepath.Join(dir, "redirect")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(".leji", "work", "ghost"), filepath.Join(dir, "hop")); err != nil {
		t.Fatal(err)
	}
	workBefore := snapshot(t, filepath.Join(dir, ".leji", "work"))
	_, err := export.BuildViewer(dir, m, "redirect/export", export.Options{})
	if err == nil || !strings.Contains(err.Error(), "reserved for the tool's own roles") {
		t.Fatalf("a chained dangling --out into a private role must be refused, got %v", err)
	}
	if !equalStrings(workBefore, snapshot(t, filepath.Join(dir, ".leji", "work"))) {
		t.Fatal("nothing must be cleared or written in the private role")
	}
}

func TestExportTreatsUnresolvableOutAsFailure(t *testing.T) {
	// A non-ENOENT resolution failure (here an unreadable intermediate directory) must
	// FAIL the check, never be rebuilt lexically as a not-yet-created target. Mutation
	// that reddens: make ResolvedPath return the lexical path on a non-ENOENT error —
	// the build proceeds instead of refusing. Skipped as root, which bypasses the mode.
	if os.Geteuid() == 0 {
		t.Skip("running as root bypasses directory permissions; the EACCES cannot be constructed")
	}
	dir := materialize(t, "valid-trust-canary-nested-root", []seed{{From: ".leji-seed", To: ".leji"}})
	m := mustLoad(t, dir)
	noperm := filepath.Join(dir, "noperm")
	if err := os.MkdirAll(filepath.Join(noperm, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(noperm, 0o000); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chmod(noperm, 0o755) }()
	_, err := export.BuildViewer(dir, m, "noperm/sub/export", export.Options{})
	if err == nil || !strings.Contains(err.Error(), "cannot be resolved (permission or I/O error)") {
		t.Fatalf("an unresolvable --out must be refused, not treated as absent, got %v", err)
	}
}

func TestExportRefusesADanglingOutputEntry(t *testing.T) {
	// A dangling symlink is a standing entry under both forms — never written through,
	// never read as absent. The output used to be resolved before anything judged it,
	// so `.leji/dist -> site` with `site` missing BECAME its own destination: the stat
	// reported absence, "clearable" followed, and the export created and filled the
	// link's target. The original entry is judged first now. Mutation that reddens:
	// drop the lstat on the original entry — the build writes through the link.
	dir := materialize(t, "valid-trust-canary-nested-root", []seed{{From: ".leji-seed", To: ".leji"}})
	m := mustLoad(t, dir)
	// Settle the internal chrome first: every build regenerates it, so the comparison
	// below measures the export's destructive half and nothing else.
	if _, err := viewer.GenerateViewer(dir, m); err != nil {
		t.Fatal(err)
	}

	if err := os.Symlink(filepath.Join("..", "site"), filepath.Join(dir, ".leji", "dist")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("elsewhere", filepath.Join(dir, "published")); err != nil {
		t.Fatal(err)
	}
	before := snapshot(t, dir)

	if _, err := export.BuildViewer(dir, m, "", export.Options{}); err == nil ||
		!strings.Contains(err.Error(), "it is a dangling symlink") {
		t.Fatalf("the default output must be refused before it is resolved, got %v", err)
	}
	if _, err := export.BuildViewer(dir, m, "published", export.Options{}); err == nil ||
		!strings.Contains(err.Error(), "it is a dangling symlink") {
		t.Fatalf("a caller --out that dangles must be refused too, got %v", err)
	}

	for _, link := range []string{filepath.Join(dir, ".leji", "dist"), filepath.Join(dir, "published")} {
		st, err := os.Lstat(link)
		if err != nil || st.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("the planted link %s must be left in place (%v)", link, err)
		}
	}
	for _, gone := range []string{filepath.Join(dir, "site"), filepath.Join(dir, "elsewhere")} {
		if _, err := os.Lstat(gone); err == nil {
			t.Fatalf("the link destination %s was created", gone)
		}
	}
	if !equalStrings(before, snapshot(t, dir)) {
		t.Fatal("the tree must be byte-identical")
	}
}

func TestCheckBeforeActRefusesCaseVariantAliasThroughNonEnumerableDirectory(t *testing.T) {
	// The composition the separate case-fold and unresolvable cases left open: a
	// `.LEJI/` spelling of the role tree reached through a directory that is
	// traversable and writable but NOT enumerable. The canonical spelling is read back
	// from the directory, so denying enumeration denies case recovery — and falling
	// back to the caller's spelling made the resolved target compare as outside
	// `.leji/`, so the write and the clear were permitted straight into a private role.
	// An enumeration failure now makes the path unresolvable, which refuses both.
	// Mutation that reddens: return the given name from realName on a ReadDir error —
	// generation writes the chrome into .leji/work and the export clears and writes
	// into .leji/mounts.
	if os.Geteuid() == 0 {
		t.Skip("running as root bypasses directory permissions; the mode cannot be constructed")
	}

	// Write side: `.leji/viewer` aliased to `../.LEJI/work/chrome`.
	dir := canaryLayer(t)
	if !foldsCase(t, dir) {
		t.Skip("this volume tells .leji from .LEJI; the case-alias vector cannot be constructed")
	}
	aliased := filepath.Join(dir, ".leji", "work", "chrome")
	if err := os.MkdirAll(filepath.Join(aliased, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(aliased, "assets", "planted.txt"), []byte(token+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("..", ".LEJI", "work", "chrome"), filepath.Join(dir, ".leji", "viewer")); err != nil {
		t.Fatal(err)
	}
	m := mustLoad(t, dir)
	before := snapshot(t, aliased)
	// Searchable and writable, but unlistable: the repository directory is the one that
	// holds the canonical spelling of `.leji`.
	if err := os.Chmod(dir, 0o311); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chmod(dir, 0o755) }()

	gen, err := viewer.GenerateViewer(dir, m)
	if err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	if !hasRefusal(gen.Findings) {
		t.Fatalf("generation must refuse an unresolvable viewer target, got %v", gen.Findings)
	}
	if len(gen.Written) != 0 {
		t.Fatalf("generation must write nothing, got %v", gen.Written)
	}
	if !equalStrings(before, snapshot(t, aliased)) {
		t.Fatal("the aliased private role must be byte-identical")
	}
	_ = os.Chmod(dir, 0o755)

	// Clear side: the default output aliased to an EMPTY directory in a private role,
	// so the clearable-export rule cannot be what refuses it.
	other := canaryLayer(t)
	empty := filepath.Join(other, ".leji", "mounts", "store", "empty")
	if err := os.MkdirAll(empty, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("..", ".LEJI", "mounts", "store", "empty"), filepath.Join(other, ".leji", "dist")); err != nil {
		t.Fatal(err)
	}
	om := mustLoad(t, other)
	mountsBefore := snapshot(t, filepath.Join(other, ".leji", "mounts"))
	if err := os.Chmod(other, 0o311); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chmod(other, 0o755) }()
	_, berr := export.BuildViewer(other, om, "", export.Options{})
	if berr == nil || !strings.Contains(berr.Error(), "cannot be resolved (permission or I/O error)") {
		t.Fatalf("the default output must be refused as unresolvable, got %v", berr)
	}
	_ = os.Chmod(other, 0o755)
	if !equalStrings(mountsBefore, snapshot(t, filepath.Join(other, ".leji", "mounts"))) {
		t.Fatal("nothing must be cleared or written in the private role")
	}
}

// --- helpers ------------------------------------------------------------------

func hasRefusal(fs []findings.Finding) bool {
	for _, f := range fs {
		if f.Rule == "viewer-target-refused" && f.Severity == findings.Error {
			return true
		}
	}
	return false
}

func patchManifest(t *testing.T, dir string, mutate func(map[string]any)) {
	t.Helper()
	abs := filepath.Join(dir, "leji.json")
	raw, err := os.ReadFile(abs)
	if err != nil {
		t.Fatal(err)
	}
	var declared map[string]any
	if err := json.Unmarshal(raw, &declared); err != nil {
		t.Fatal(err)
	}
	mutate(declared)
	out, err := json.MarshalIndent(declared, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, append(out, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

// foldsCase reports whether this directory sits on a filesystem that cannot tell
// `.leji` from `.LEJI` — asked of the volume, so a case-variant assertion runs only
// where the fold is real.
func foldsCase(t *testing.T, dir string) bool {
	t.Helper()
	probe := filepath.Join(dir, "leji-case-probe")
	if err := os.MkdirAll(probe, 0o755); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.RemoveAll(probe) }()
	_, err := os.Stat(filepath.Join(dir, "LEJI-CASE-PROBE"))
	return err == nil
}

// captureStderr runs fn with os.Stderr redirected to a pipe and returns what it
// wrote. The boundary-skip warning is a stderr contract, so it is read from the file
// the process actually writes to.
func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	orig := os.Stderr
	os.Stderr = w
	done := make(chan string, 1)
	go func() {
		body, _ := io.ReadAll(r)
		done <- string(body)
	}()
	fn()
	os.Stderr = orig
	_ = w.Close()
	out := <-done
	_ = r.Close()
	return out
}
