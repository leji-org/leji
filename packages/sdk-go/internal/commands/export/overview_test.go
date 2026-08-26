package export

// --- the exported overview carries the map; the lint reads the source ---
// The layer map is substituted into the exported COPY of the overview homepage, after
// the lint has judged the source bytes and without the source being touched. Pinned
// against the frozen TypeScript contract.

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/viewer"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
	"github.com/leji-org/leji/packages/sdk-go/internal/renderlint"
)

func TestExportedOverviewCarriesTheRenderedMapAndTheLintJudgesTheSource(t *testing.T) {
	dir := exampleCopy(t)
	// An author's page: prose around the markers, and inside them a stale hand-edit
	// carrying an out-of-subset construct. The construct's line number is what proves
	// which bytes the lint read, since the substitution below changes every line after
	// the markers.
	source := "# The layer\n\nIntro prose.\n\n<!-- leji:generated-map:start -->\n" +
		"A raw <span>element</span> left inside the markers.\n" +
		"<!-- leji:generated-map:end -->\n\nClosing prose.\n"
	writeUnder(t, dir, "docs/"+viewer.OverviewRel, source)
	m := manifest.LoadManifest(dir).Manifest
	if m == nil {
		t.Fatal("the example manifest must load")
	}
	r, err := BuildViewer(dir, m, "out", Options{})
	if err != nil {
		t.Fatalf("BuildViewer: %v", err)
	}
	linted := false
	for _, f := range r.Findings {
		if f.Rule == renderlint.RenderUnsupportedRule && f.Path == "docs/overview.md" && f.Line == 6 {
			linted = true
		}
	}
	if !linted {
		t.Fatalf("the lint must report the construct at its line in the SOURCE: %v", r.Findings)
	}

	// The source is the author's file: untouched by an export that renders from it.
	onDisk, err := os.ReadFile(filepath.Join(dir, "docs", viewer.OverviewRel))
	if err != nil {
		t.Fatalf("read overview: %v", err)
	}
	if string(onDisk) != source {
		t.Fatal("the export must never write the page it renders from")
	}
	exported, err := os.ReadFile(filepath.Join(dir, "out", "content", viewer.OverviewRel))
	if err != nil {
		t.Fatalf("read the exported overview: %v", err)
	}
	gen, err := viewer.GenerateViewer(dir, m)
	if err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	rendered, markersFound := viewer.RenderOverview(source, m, gen.IndexEntries)
	if !markersFound {
		t.Fatal("the authored page carries the markers")
	}
	if string(exported) != rendered {
		t.Fatalf("expected the exported copy to be the source with the marked span substituted, got:\n%s", exported)
	}
	if !strings.Contains(string(exported), "```mermaid\nflowchart LR") {
		t.Fatal("the map is the map")
	}
	if !strings.Contains(string(exported), "# The layer") {
		t.Fatal("the prose around the markers rides along")
	}
	if !strings.Contains(string(exported), "Closing prose.") {
		t.Fatal("including what follows them")
	}
	if strings.Contains(string(exported), "<span>") {
		t.Fatal("and the stale hand-edit between them is gone")
	}
}

func TestExportedOverviewWithoutMarkersIsTheSourceByteForByte(t *testing.T) {
	dir := exampleCopy(t)
	source := "# Fully custom\n\nNo markers here at all.\n"
	writeUnder(t, dir, "docs/"+viewer.OverviewRel, source)
	m := manifest.LoadManifest(dir).Manifest
	if m == nil {
		t.Fatal("the example manifest must load")
	}
	if _, err := BuildViewer(dir, m, "out", Options{}); err != nil {
		t.Fatalf("BuildViewer: %v", err)
	}
	onDisk, err := os.ReadFile(filepath.Join(dir, "docs", viewer.OverviewRel))
	if err != nil {
		t.Fatalf("read overview: %v", err)
	}
	if string(onDisk) != source {
		t.Fatal("the source is untouched")
	}
	exported, err := os.ReadFile(filepath.Join(dir, "out", "content", viewer.OverviewRel))
	if err != nil {
		t.Fatalf("read the exported overview: %v", err)
	}
	if string(exported) != source {
		t.Fatalf("with nowhere to render the map, the exported copy is the source, got:\n%s", exported)
	}
}

func TestExportedOverviewDecodesInvalidUTF8LikeTheReference(t *testing.T) {
	// An authored page carrying invalid UTF-8 OUTSIDE the marker span. The exported copy
	// is rendered, so it is decoded first, and it must be decoded the way Node decodes:
	// the expectation below is the reference SDK's own output for these prose bytes.
	dir := exampleCopy(t)
	source := append([]byte("# T"), 0xFF)
	source = append(source, "tle\n\nIntro.\n\n<!-- leji:generated-map:start -->\nstale\n<!-- leji:generated-map:end -->\n\nTa"...)
	source = append(source, 0xC0, 0x80)
	source = append(source, "il\n"...)
	abs := filepath.Join(dir, "docs", viewer.OverviewRel)
	if err := os.WriteFile(abs, source, 0o644); err != nil {
		t.Fatalf("write overview: %v", err)
	}
	m := manifest.LoadManifest(dir).Manifest
	if m == nil {
		t.Fatal("the example manifest must load")
	}
	if _, err := BuildViewer(dir, m, "out", Options{}); err != nil {
		t.Fatalf("BuildViewer: %v", err)
	}
	onDisk, err := os.ReadFile(abs)
	if err != nil {
		t.Fatalf("read overview: %v", err)
	}
	if !bytes.Equal(onDisk, source) {
		t.Fatal("the source is untouched, invalid bytes included")
	}
	exported, err := os.ReadFile(filepath.Join(dir, "out", "content", viewer.OverviewRel))
	if err != nil {
		t.Fatalf("read the exported overview: %v", err)
	}
	// Byte-identity with the reference: the render is DecodeUTF8 then the substitution,
	// and DecodeUTF8 is pinned against Node's own output in the viewer package.
	gen, err := viewer.GenerateViewer(dir, m)
	if err != nil {
		t.Fatalf("GenerateViewer: %v", err)
	}
	want, markersFound := viewer.RenderOverview(viewer.DecodeUTF8(source), m, gen.IndexEntries)
	if !markersFound {
		t.Fatal("the authored page carries the marker pair")
	}
	if string(exported) != want {
		t.Fatalf("the exported copy is not the reference rendering:\n got: %q\nwant: %q", exported, want)
	}
	// The prose either side of the span carries the reference's replacements, and no raw
	// invalid byte survived into the export.
	if !strings.Contains(string(exported), "# T�tle") ||
		!strings.Contains(string(exported), "Ta��il") {
		t.Fatalf("the replacements are not where the reference puts them:\n%s", exported)
	}
	if bytes.ContainsRune(exported, 0xFF) || bytes.Contains(exported, []byte{0xC0, 0x80}) {
		t.Fatal("no raw invalid byte may reach the export of a rendered page")
	}
}

func TestExportedMarkerlessOverviewKeepsItsRawBytes(t *testing.T) {
	// The other half of the same rule: with no markers there is nothing to render, so
	// the export copies the snapshot it linted. Nothing is decoded, and an invalid byte
	// survives verbatim, in every SDK.
	dir := exampleCopy(t)
	source := append([]byte("# Fully custom\n\nNo markers, and a raw "), 0xFF)
	source = append(source, " byte.\n"...)
	abs := filepath.Join(dir, "docs", viewer.OverviewRel)
	if err := os.WriteFile(abs, source, 0o644); err != nil {
		t.Fatalf("write overview: %v", err)
	}
	m := manifest.LoadManifest(dir).Manifest
	if m == nil {
		t.Fatal("the example manifest must load")
	}
	if _, err := BuildViewer(dir, m, "out", Options{}); err != nil {
		t.Fatalf("BuildViewer: %v", err)
	}
	exported, err := os.ReadFile(filepath.Join(dir, "out", "content", viewer.OverviewRel))
	if err != nil {
		t.Fatalf("read the exported overview: %v", err)
	}
	if !bytes.Equal(exported, source) {
		t.Fatalf("a markerless page exports as its raw bytes:\n got: %q\nwant: %q", exported, source)
	}
}
