package layer

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

// routingLayer builds a synthetic indexed layer plus decision records exercising
// every routing match: unscoped, path, category, and non-binding statuses.
func routingLayer(t *testing.T) (string, *manifest.Manifest) {
	t.Helper()
	root := t.TempDir()
	m := &manifest.Manifest{
		RootPath:        "docs/",
		BootProfilePath: "docs/boot-profile.md",
		Categories: map[string]manifest.CategoryMapping{
			"domain":    {Indexes: []string{"docs/context/domain.md"}},
			"system":    {Indexes: []string{"docs/context/system.md"}},
			"decisions": {Indexes: []string{"docs/context/decisions.md"}},
		},
		Machine: &manifest.Machine{AgentProfilesPath: "docs/agents/", DecisionRecordsPath: "docs/decisions/"},
	}
	writeIndexFile(t, root, "docs/context/domain.md", "docs/domain/")
	writeIndexFile(t, root, "docs/context/system.md", "docs/system/")
	writeIndexFile(t, root, "docs/context/decisions.md", "docs/decisions/")
	writeFile(t, root, "docs/domain/glossary.md", "---\nid: g\n---\n\nbody")
	writeFile(t, root, "docs/system/invariants.md", "---\nid: inv\n---\n\nbody")
	rec := func(id, fields string) string {
		return "---\nid: " + id + "\ntitle: " + id + "\ndate: 2026-06-20\n" + fields + "---\n\nbody\n"
	}
	writeFile(t, root, "docs/decisions/dec-unscoped.md", rec("dec-unscoped", "status: accepted\n"))
	writeFile(t, root, "docs/decisions/dec-path.md", rec("dec-path", "status: accepted\naffectedPaths:\n  - src/payments/\n"))
	writeFile(t, root, "docs/decisions/dec-system.md", rec("dec-system", "status: accepted\naffectedCategories:\n  - system\n"))
	writeFile(t, root, "docs/decisions/dec-deprecated.md", rec("dec-deprecated", "status: deprecated\naffectedPaths:\n  - docs/system/\n"))
	writeFile(t, root, "docs/decisions/dec-super.md", rec("dec-super", "status: superseded\nsupersededBy: dec-system\naffectedCategories:\n  - system\n"))
	writeFile(t, root, "docs/decisions/dec-proposed.md", rec("dec-proposed", "status: proposed\naffectedCategories:\n  - system\n"))
	return root, m
}

func matchMap(ds []RoutedDecision) map[string]string {
	out := map[string]string{}
	for _, d := range ds {
		out[d.ID] = d.MatchedBy
	}
	return out
}

func docPathsRouted(ds []RoutedDocument) []string {
	out := make([]string, len(ds))
	for i, d := range ds {
		out[i] = d.Path
	}
	return out
}

func TestRouteFilePathMatchesAncestorScope(t *testing.T) {
	root, m := routingLayer(t)
	r, _ := Route(root, m, RouteInput{Paths: []string{"src/payments/billing.ts"}})
	if !r.PathScoped {
		t.Fatalf("expected PathScoped true")
	}
	if len(r.Categories) != 0 {
		t.Fatalf("an ungoverned source file selects no category, got %v", r.Categories)
	}
	if len(r.Documents) != 0 {
		t.Fatalf("expected no documents, got %v", r.Documents)
	}
	want := map[string]string{"dec-path": "path", "dec-unscoped": "unscoped"}
	if got := matchMap(r.Decisions); !reflect.DeepEqual(got, want) {
		t.Fatalf("decisions = %v, want %v", got, want)
	}
}

func TestRouteGovernedDocSignalsCategoryWithoutExpanding(t *testing.T) {
	root, m := routingLayer(t)
	r, _ := Route(root, m, RouteInput{Paths: []string{"docs/system/invariants.md"}})
	// The path signals `system` for decision and mount matching, but expands nothing:
	// a path scope routes the entries it touches, never the whole category.
	if len(r.Categories) != 0 {
		t.Fatalf("categories = %v, want []", r.Categories)
	}
	if !reflect.DeepEqual(r.CategorySignals, []string{"system"}) {
		t.Fatalf("categorySignals = %v, want [system]", r.CategorySignals)
	}
	if got := docPathsRouted(r.Documents); !reflect.DeepEqual(got, []string{"docs/system/invariants.md"}) {
		t.Fatalf("documents = %v", got)
	}
	want := map[string]string{"dec-deprecated": "path", "dec-system": "category", "dec-unscoped": "unscoped"}
	if got := matchMap(r.Decisions); !reflect.DeepEqual(got, want) {
		t.Fatalf("decisions = %v, want %v", got, want)
	}
}

func TestRouteNamedCategory(t *testing.T) {
	root, m := routingLayer(t)
	r, _ := Route(root, m, RouteInput{Categories: []string{"domain"}})
	if r.PathScoped {
		t.Fatalf("expected PathScoped false")
	}
	if !reflect.DeepEqual(r.Categories, []string{"domain"}) {
		t.Fatalf("categories = %v, want [domain]", r.Categories)
	}
	if got := docPathsRouted(r.Documents); !reflect.DeepEqual(got, []string{"docs/domain/glossary.md"}) {
		t.Fatalf("documents = %v", got)
	}
	if got := matchMap(r.Decisions); !reflect.DeepEqual(got, map[string]string{"dec-unscoped": "unscoped"}) {
		t.Fatalf("decisions = %v", got)
	}
}

func TestRouteEmptyScope(t *testing.T) {
	root, m := routingLayer(t)
	r, _ := Route(root, m, RouteInput{})
	if r.PathScoped {
		t.Fatalf("expected PathScoped false")
	}
	if len(r.Categories) != 0 || len(r.Documents) != 0 {
		t.Fatalf("empty scope selects no category/documents, got %v / %v", r.Categories, r.Documents)
	}
	if got := matchMap(r.Decisions); !reflect.DeepEqual(got, map[string]string{"dec-unscoped": "unscoped"}) {
		t.Fatalf("decisions = %v", got)
	}
}

func TestRouteDirectoryPathBidirectional(t *testing.T) {
	root, m := routingLayer(t)
	r, _ := Route(root, m, RouteInput{Paths: []string{"docs/"}})
	got := ""
	for _, d := range r.Decisions {
		if d.ID == "dec-deprecated" {
			got = d.MatchedBy
		}
	}
	if got != "path" {
		t.Fatalf("dec-deprecated matchedBy = %q, want path", got)
	}
}

func TestRouteFederatedMountRelevance(t *testing.T) {
	repoRoot, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	coreContext := filepath.Join(repoRoot, "examples", "multi-repo", "core-context")
	load := manifest.LoadManifest(coreContext)
	if load.Manifest == nil {
		t.Fatalf("failed to load core-context manifest: %v", load.Findings)
	}
	// The mount declares categories [domain, decisions].
	domain, _ := Route(coreContext, load.Manifest, RouteInput{Categories: []string{"domain"}})
	if len(domain.Mounts) != 1 || domain.Mounts[0].Name != "acme-product-context" {
		t.Fatalf("domain task mounts = %+v, want [acme-product-context]", domain.Mounts)
	}
	system, _ := Route(coreContext, load.Manifest, RouteInput{Categories: []string{"system"}})
	if len(system.Mounts) != 0 {
		t.Fatalf("system task mounts = %+v, want none", system.Mounts)
	}
}

func TestRouteDirectoryPathSelectsEntriesBeneathIt(t *testing.T) {
	root, m := routingLayer(t)
	r, _ := Route(root, m, RouteInput{Paths: []string{"docs/system/"}})
	// Containment is bidirectional and lexical; a directory is not itself a governed
	// document, so it infers no category at all.
	if len(r.Categories) != 0 || len(r.CategorySignals) != 0 {
		t.Fatalf("categories = %v, signals = %v, want both empty", r.Categories, r.CategorySignals)
	}
	found := false
	for _, d := range r.Documents {
		if d.Path == "docs/system/invariants.md" {
			found = true
		}
	}
	if !found {
		t.Fatalf("documents = %v, want the entry beneath the directory", docPathsRouted(r.Documents))
	}
}

func TestRouteTrailingSlashChangesNothing(t *testing.T) {
	root, m := routingLayer(t)
	a, _ := Route(root, m, RouteInput{Paths: []string{"docs/system"}})
	b, _ := Route(root, m, RouteInput{Paths: []string{"docs/system/"}})
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("trailing slash changed the result")
	}
}

// --- Topic routing -----------------------------------------------------------
//
// A topic selects sibling mounts and nothing else: it never enters the category
// sets, loads no document or record, and routes no decision. Matching is exact
// string equality, with no case conversion, normalization, locale, or trimming.

func topicLayer(t *testing.T) (string, *manifest.Manifest) {
	t.Helper()
	root, m := routingLayer(t)
	m.Federation = &manifest.Federation{Mounts: []manifest.Mount{
		{Name: "alpha", Pin: "a1", Topics: []string{"billing", "product surface"}},
		{Name: "beta", Pin: "b1", Categories: []string{"system"}},
	}}
	return root, m
}

func TestRouteTopicSelectsTheMountAndNothingElse(t *testing.T) {
	root, m := topicLayer(t)
	r, err := Route(root, m, RouteInput{Topics: []string{"product surface"}})
	if err != nil {
		t.Fatalf("route: %v", err)
	}
	if len(r.Mounts) != 1 || r.Mounts[0].Name != "alpha" {
		t.Fatalf("mounts = %+v", r.Mounts)
	}
	if len(r.Categories) != 0 || len(r.CategorySignals) != 0 || len(r.Documents) != 0 || len(r.Records) != 0 {
		t.Fatalf("a topic match expanded or signalled something: %+v", r)
	}
	// Exact bytes only: no trimming, no case folding.
	for _, near := range []string{"Product Surface", " product surface", "product"} {
		miss, err := Route(root, m, RouteInput{Topics: []string{near}})
		if err != nil {
			t.Fatalf("route %q: %v", near, err)
		}
		if len(miss.Mounts) != 0 {
			t.Fatalf("%q matched: %+v", near, miss.Mounts)
		}
	}
	// Duplicates collapse to one signal, and a category match still stands.
	both, err := Route(root, m, RouteInput{Categories: []string{"system"}, Topics: []string{"billing", "billing"}})
	if err != nil {
		t.Fatalf("route: %v", err)
	}
	if len(both.Mounts) != 2 || both.Mounts[0].Name != "alpha" || both.Mounts[1].Name != "beta" {
		t.Fatalf("mounts = %+v", both.Mounts)
	}
}

func TestRouteRejectsAnInvalidTopicOnEitherSide(t *testing.T) {
	root, m := topicLayer(t)
	if _, err := Route(root, m, RouteInput{Topics: []string{""}}); err == nil ||
		err.Error() != "invalid task topic: empty string" {
		t.Fatalf("task topic error = %v", err)
	}
	loneSurrogate := string([]byte{0xed, 0xa0, 0x80})
	if _, err := Route(root, m, RouteInput{Topics: []string{loneSurrogate}}); err == nil ||
		err.Error() != "invalid task topic: lone surrogate" {
		t.Fatalf("task topic error = %v", err)
	}
	// The declared side is validated too: dropping it would let a caller read an
	// empty match as a real one.
	m.Federation.Mounts[0].Topics = []string{"billing", ""}
	if _, err := Route(root, m, RouteInput{}); err == nil ||
		err.Error() != `invalid mount topic on "alpha": empty string` {
		t.Fatalf("mount topic error = %v", err)
	}
}

func TestRouteNormalizesTaskPathsBeforeMatching(t *testing.T) {
	root, m := routingLayer(t)
	const governed = "docs/system/invariants.md"
	canonical, err := Route(root, m, RouteInput{Paths: []string{governed}})
	if err != nil {
		t.Fatalf("canonical: %v", err)
	}
	// Every spelling Requirement 6 normalizes away has to route identically. The gap
	// this closes: `--federation=required` passed open on `./x` and `x/` because
	// neither is a key in the governed-document map, so neither signalled its
	// category and neither routed the mounts the task actually touches.
	for _, spelling := range []string{
		"./" + governed,
		governed + "/",
		"docs/./system//invariants.md",
		"docs/x/../system/invariants.md",
	} {
		r, err := Route(root, m, RouteInput{Paths: []string{spelling}})
		if err != nil {
			t.Fatalf("%s: %v", spelling, err)
		}
		if strings.Join(r.CategorySignals, ",") != strings.Join(canonical.CategorySignals, ",") {
			t.Fatalf("%s: signals = %v", spelling, r.CategorySignals)
		}
		if len(r.Documents) != len(canonical.Documents) || len(r.Decisions) != len(canonical.Decisions) {
			t.Fatalf("%s: documents = %v decisions = %v", spelling, r.Documents, r.Decisions)
		}
	}
	// The repository root is a real scope, not an empty one: it contains everything.
	for _, rootSpelling := range []string{".", "./", "docs/.."} {
		r, err := Route(root, m, RouteInput{Paths: []string{rootSpelling}})
		if err != nil || !r.PathScoped {
			t.Fatalf("%s: pathScoped = %v, err = %v", rootSpelling, r.PathScoped, err)
		}
	}
}

func TestRouteRejectsATaskPathWithNoRootRelativeForm(t *testing.T) {
	root, m := routingLayer(t)
	// Never a silent non-match: a federation gate reading "you spelled it wrongly"
	// as "this task touches no mount" is the hole this closes.
	for _, bad := range []string{"/etc/passwd", "../outside.md", "docs/../../outside.md"} {
		_, err := Route(root, m, RouteInput{Paths: []string{bad}})
		want := `invalid task path "` + bad + `": must be repository-root-relative POSIX (no leading "/", no ".." above the root)`
		if err == nil || err.Error() != want {
			t.Fatalf("%s: err = %v", bad, err)
		}
	}
}
