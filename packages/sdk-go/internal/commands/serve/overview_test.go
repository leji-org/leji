package serve

// --- the overview map is served, never stored ---
// The layer map used to be written into the committed overview.md on every run that
// changed a document count. It is now substituted between the author's markers when
// the page is read: these pin the served half against the frozen TypeScript contract
// (the exported half is in the export package).

import (
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/viewer"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

// overviewLayer is the example layer with its viewer generated, at its resolved path
// (symlink targets and mount comparisons below are about real locations).
func overviewLayer(t *testing.T) (string, *manifest.Manifest) {
	t.Helper()
	dir := exampleCopy(t)
	if resolved, err := filepath.EvalSymlinks(dir); err == nil {
		dir = resolved
	}
	m := manifest.LoadManifest(dir).Manifest
	if m == nil {
		t.Fatal("the example manifest must load")
	}
	if _, err := viewer.GenerateViewer(dir, m); err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	return dir, m
}

func TestServeRendersTheLayerMapIntoTheOverviewPage(t *testing.T) {
	dir, m := overviewLayer(t)
	overview := filepath.Join(dir, m.RootPath, viewer.OverviewRel)
	// A document added after the seed: the served map counts the tree of right now.
	writeUnder(t, dir, "docs/domain/pricing.md", "# Pricing\n\nHow we price.\n")
	before, err := os.ReadFile(overview)
	if err != nil {
		t.Fatalf("read overview: %v", err)
	}
	base := serveOnFreePort(t, dir, m.RootPath)

	code, raw := fetch(t, base+"/content/overview.md")
	body := string(raw)
	if code != http.StatusOK {
		t.Fatalf("GET /content/overview.md: status %d, want 200", code)
	}
	res, err := viewer.GenerateViewer(dir, m)
	if err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	if !strings.Contains(body, "```mermaid\nflowchart LR") {
		t.Fatalf("expected the served page to carry the map, got: %s", body)
	}
	if !strings.Contains(body, "cat_domain[\"📖 Domain · 2 docs\"]") {
		t.Fatal("expected the document added after the seed to be counted")
	}
	rendered, _ := viewer.RenderOverview(string(before), m, res.IndexEntries)
	if body != rendered {
		t.Fatal("expected the served page to be the source with the marked span substituted")
	}
	after, err := os.ReadFile(overview)
	if err != nil {
		t.Fatalf("read overview: %v", err)
	}
	if string(after) != string(before) {
		t.Fatal("serving the page must never write it")
	}
}

func TestServeRendersTheOverviewFromARelativeRoot(t *testing.T) {
	// What the CLI actually passes: `--root .` survives EvalSymlinks as ".", so the
	// route's guards see a relative root and an absolutized resolved source. Judging
	// one against the other reads as "outside the repository" and refuses every page,
	// which no absolute-path test can catch. Mutation that reddens: judge the resolved
	// source against rootAbs rather than against its resolved form.
	dir, m := overviewLayer(t)
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	t.Cleanup(func() { _ = os.Chdir(wd) })
	base := serveOnFreePort(t, ".", m.RootPath)

	code, raw := fetch(t, base+"/content/overview.md")
	if code != http.StatusOK {
		t.Fatalf("GET /content/overview.md from a relative root: status %d, want 200", code)
	}
	if !strings.Contains(string(raw), "```mermaid\nflowchart LR") {
		t.Fatalf("expected the map rendered into the served page, got: %s", raw)
	}
}

func TestServeKeepsTheLastGoodMapWhenTheLayerStopsIndexing(t *testing.T) {
	dir, m := overviewLayer(t)
	overview := filepath.Join(dir, m.RootPath, viewer.OverviewRel)
	source, err := os.ReadFile(overview)
	if err != nil {
		t.Fatalf("read overview: %v", err)
	}
	base := serveOnFreePort(t, dir, m.RootPath)
	overviewText := func() string {
		code, raw := fetch(t, base+"/content/overview.md")
		body := string(raw)
		if code != http.StatusOK {
			t.Fatalf("GET /content/overview.md: status %d, want 200", code)
		}
		return body
	}

	good := overviewText()
	if !strings.Contains(good, "```mermaid\nflowchart LR") {
		t.Fatal("expected a healthy tree to render the fresh map")
	}
	// A genuine generation failure: the manifest no longer parses, so this fetch has
	// no index at all. The page keeps the map it last had rather than losing it.
	manifestAbs := filepath.Join(dir, "leji.json")
	manifestText, err := os.ReadFile(manifestAbs)
	if err != nil {
		t.Fatalf("read leji.json: %v", err)
	}
	if err := os.WriteFile(manifestAbs, []byte("{ not json"), 0o644); err != nil {
		t.Fatalf("write leji.json: %v", err)
	}
	if overviewText() != good {
		t.Fatal("expected the last good map while the tree cannot be indexed")
	}
	// Repaired, with the tree moved on: the map is the one the tree has now.
	if err := os.WriteFile(manifestAbs, manifestText, 0o644); err != nil {
		t.Fatalf("restore leji.json: %v", err)
	}
	writeUnder(t, dir, "docs/domain/pricing.md", "# Pricing\n\nHow we price.\n")
	if !strings.Contains(overviewText(), "cat_domain[\"📖 Domain · 2 docs\"]") {
		t.Fatal("expected the repaired tree to render afresh")
	}
	after, err := os.ReadFile(overview)
	if err != nil {
		t.Fatalf("read overview: %v", err)
	}
	if string(after) != string(source) {
		t.Fatal("none of it may write the source file")
	}
}

func TestServeRefusesAnOverviewOutsideTheContentRoot(t *testing.T) {
	dir, m := overviewLayer(t)
	overview := filepath.Join(dir, m.RootPath, viewer.OverviewRel)
	// An ordinary file elsewhere in the repository: the route is a content route
	// first, and a content route serves nothing from outside its own mount.
	writeUnder(t, dir, "elsewhere.md", "# Elsewhere\n")
	if err := os.Remove(overview); err != nil {
		t.Fatalf("remove overview: %v", err)
	}
	if err := os.Symlink(filepath.Join(dir, "elsewhere.md"), overview); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	base := serveOnFreePort(t, dir, m.RootPath)

	code, raw := fetch(t, base+"/content/overview.md")
	body := string(raw)
	if code != http.StatusForbidden {
		t.Fatalf("a target outside the content mount must be refused: status %d, want 403", code)
	}
	if strings.Contains(body, "Elsewhere") {
		t.Fatal("and nothing of it may be served")
	}
}

func TestServeRefusesAnOverviewSymlinkedIntoAPrivateRole(t *testing.T) {
	// The content root here IS the repository root, so the private role is inside the
	// mount and the servable whitelist is the check that answers: refused as today.
	dir, _ := overviewLayer(t)
	writeUnder(t, dir, ".leji/work/private.md", "# Private notes\n")
	if err := os.Symlink(filepath.Join(dir, ".leji", "work", "private.md"),
		filepath.Join(dir, "overview.md")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	base := serveOnFreePort(t, dir, ".")

	code, raw := fetch(t, base+"/content/overview.md")
	body := string(raw)
	if code != http.StatusNotFound {
		t.Fatalf("a private role is not servable however it is reached: status %d, want 404", code)
	}
	if strings.Contains(body, "Private notes") {
		t.Fatal("and nothing of it may be served")
	}
}

func TestCheckBeforeActOverviewSwappedBetweenAuthorizationAndReadIsRefused(t *testing.T) {
	// The window the overview route's binding exists for: the link is retargeted AFTER
	// the resolution that authorizes the source and BEFORE the bytes are taken, at a
	// target inside the repository but outside the content mount, where the
	// private-role and containment guards alone say yes. Deterministic, not a race: the
	// hook performs the swap inline, so the window is exercised on every run (the idiom
	// the export canaries use).
	//
	// Mutation that reddens: give the route the pre-review shape, a ResolvedPath that
	// authorizes the path followed by a read that resolves the path again
	// (fsx.VerifiedTargetRead), and the swapped-in file's bytes are served with a 200.
	dir, m := overviewLayer(t)
	overview := filepath.Join(dir, m.RootPath, viewer.OverviewRel)
	// The legitimate target is a real page inside the content root; overview.md is the
	// link, so the swap changes only where it points.
	inside := filepath.Join(dir, m.RootPath, "home.md")
	if err := os.Rename(overview, inside); err != nil {
		t.Fatalf("move the seeded page aside: %v", err)
	}
	outside := filepath.Join(dir, "outside.md")
	const secret = "SECRET-OUTSIDE-THE-CONTENT-ROOT"
	writeUnder(t, dir, "outside.md", "# Outside\n\n"+secret+"\n")
	if err := os.Symlink(inside, overview); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	base := serveOnFreePort(t, dir, m.RootPath)

	// Armed for the one request, and swaps once: the route has just authorized the
	// resolved source, and the entry it came from is retargeted before the open.
	swapped := false
	testHookAfterAuthorize = func() {
		if swapped {
			return
		}
		swapped = true
		if err := os.Remove(overview); err != nil {
			t.Errorf("remove the link: %v", err)
			return
		}
		if err := os.Symlink(outside, overview); err != nil {
			t.Errorf("retarget the link: %v", err)
		}
	}
	code, raw := fetch(t, base+"/content/overview.md")
	body := string(raw)
	testHookAfterAuthorize = nil

	if !swapped {
		t.Fatal("the link must have been retargeted inside the route, after the authorizing resolution")
	}
	if target, err := os.Readlink(overview); err != nil || target != outside {
		t.Fatalf("the link must still point outside the content mount: %q, %v", target, err)
	}
	if strings.Contains(body, secret) {
		t.Fatalf("no byte from outside the content mount may be served: %q", body)
	}
	// The mapping the ordinary content route uses: the source resolves outside the
	// mount, so the mount answers, and it answers before anything is read.
	if code != http.StatusForbidden {
		t.Fatalf("the swapped-in target must be refused: status %d, want 403", code)
	}
}

func TestServeDecodesInvalidUTF8LikeTheReference(t *testing.T) {
	// The served half of the decode rule: a rendered page is decoded the way Node
	// decodes, and a markerless one is served as its raw bytes.
	dir, m := overviewLayer(t)
	overview := filepath.Join(dir, m.RootPath, viewer.OverviewRel)
	rendered := append([]byte("# T"), 0xFF)
	rendered = append(rendered, "tle\n\n<!-- leji:generated-map:start -->\nstale\n<!-- leji:generated-map:end -->\n\nTa"...)
	rendered = append(rendered, 0xC0, 0x80)
	rendered = append(rendered, "il\n"...)
	if err := os.WriteFile(overview, rendered, 0o644); err != nil {
		t.Fatalf("write overview: %v", err)
	}
	base := serveOnFreePort(t, dir, m.RootPath)

	code, raw := fetch(t, base+"/content/overview.md")
	if code != http.StatusOK {
		t.Fatalf("GET /content/overview.md: status %d, want 200", code)
	}
	gen, err := viewer.GenerateViewer(dir, m)
	if err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	want, markersFound := viewer.RenderOverview(viewer.DecodeUTF8(rendered), m, gen.IndexEntries)
	if !markersFound {
		t.Fatal("the authored page carries the marker pair")
	}
	if string(raw) != want {
		t.Fatalf("the served page is not the reference rendering:\n got: %q\nwant: %q", raw, want)
	}
	if !strings.Contains(string(raw), "# T�tle") || !strings.Contains(string(raw), "Ta��il") {
		t.Fatalf("the replacements are not where the reference puts them:\n%s", raw)
	}
	if bytes.ContainsRune(raw, 0xFF) {
		t.Fatal("no raw invalid byte may be served from a rendered page")
	}
	// Markerless: nothing to render, so the source bytes go out exactly as they stand.
	markerless := append([]byte("# Custom\n\nA raw "), 0xFF)
	markerless = append(markerless, " byte.\n"...)
	if err := os.WriteFile(overview, markerless, 0o644); err != nil {
		t.Fatalf("write overview: %v", err)
	}
	code, raw = fetch(t, base+"/content/overview.md")
	if code != http.StatusOK {
		t.Fatalf("GET /content/overview.md: status %d, want 200", code)
	}
	if !bytes.Equal(raw, markerless) {
		t.Fatalf("a markerless page is served as its raw bytes:\n got: %q\nwant: %q", raw, markerless)
	}
}

func TestServeZeroEntrySnapshotSuppressesTheStartupGeneration(t *testing.T) {
	// A successful generation over a layer that governs nothing projects ZERO entries,
	// not "no snapshot". If that answer reaches Serve as a nil slice it reads as absent
	// and the server generates the index a second time at startup, which the caller had
	// just done. Mutation that reddens: return a nil IndexEntries from a successful
	// zero-entry generation, or treat an empty snapshot as absent here.
	dir := exampleCopy(t)
	if resolved, err := filepath.EvalSymlinks(dir); err == nil {
		dir = resolved
	}
	// The example layer with every category pointed at an empty directory: a valid
	// manifest whose categories govern nothing, so generation succeeds and projects zero
	// entries. The stored index goes too, so nothing reports a vanished id.
	writeUnder(t, dir, "docs/empty/notes.txt", "not a governed document\n")
	for _, rel := range []string{"docs/context/domain.md", "docs/context/system.md", "docs/context/decisions.md"} {
		writeUnder(t, dir, rel, "# Category\n```leji-index\n- path: docs/empty/\n```\n")
	}
	if err := os.Remove(filepath.Join(dir, "docs", "context-index.json")); err != nil {
		t.Fatalf("remove the stored index: %v", err)
	}
	m := manifest.LoadManifest(dir).Manifest
	if m == nil {
		t.Fatal("the example manifest must load")
	}
	gen, err := viewer.GenerateViewer(dir, m)
	if err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	for _, f := range gen.Findings {
		if f.Severity == findings.Error {
			t.Fatalf("the empty layer must generate cleanly, got: %v", gen.Findings)
		}
	}
	if gen.Entries != 0 {
		t.Fatalf("this layer governs nothing, got %d entries", gen.Entries)
	}
	if gen.IndexEntries == nil {
		t.Fatal("a successful generation carries a snapshot, empty or not, never nil")
	}

	generations := 0
	testHookIndexGenerated = func() { generations++ }
	defer func() { testHookIndexGenerated = nil }()
	ln, srv, err := Serve(dir, 0, m.RootPath, nil, Options{Entries: gen.IndexEntries})
	if err != nil {
		t.Fatalf("Serve: %v", err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	if generations != 0 {
		t.Fatalf("the supplied snapshot must suppress the startup generation, saw %d", generations)
	}
	// And the snapshot really is the map the first fetch renders from: no generation has
	// run, so an empty map is what a reader gets.
	go func() { _ = srv.Serve(ln) }()
	code, raw := fetch(t, "http://"+ln.Addr().String()+"/content/overview.md")
	if code != http.StatusOK {
		t.Fatalf("GET /content/overview.md: status %d, want 200", code)
	}
	if !strings.Contains(string(raw), "```mermaid\nflowchart LR") {
		t.Fatalf("expected the (empty) map rendered into the page, got:\n%s", raw)
	}
	if strings.Contains(string(raw), "cat_") {
		t.Fatalf("a layer that governs nothing has no category nodes:\n%s", raw)
	}
}
