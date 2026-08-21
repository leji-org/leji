// `leji mounts update-pin`, mirroring packages/sdk/test/update-pin.test.ts: the two
// factorings out of internal/mounts checked against the callers they came from, the
// shared fixtures' `updatePin` block driven through the real CLI, the two branches
// no fixture can construct, and the command surface. The pin-span scanner has its
// own byte fixtures in internal/manifest.
package cli

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/updatepin"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
	"github.com/leji-org/leji/packages/sdk-go/internal/mounts"
)

// The declaration rewrites a case applies before the run: the pin it starts from,
// and whether the tracking ref is declared at all.
var (
	pinRe         = regexp.MustCompile(`("pin": ")[0-9a-f]{40}(")`)
	trackingRefRe = regexp.MustCompile(`\s*"trackingRef": "[^"]*",\n`)
)

// --- the acme-sibling scaffold ------------------------------------------------

// The recipe's fixed commit ids (fixtures/README.md -> "The `acme-sibling`
// recipe"). Every field a commit hashes is pinned by the recipe, so these are
// constants, not observations.
const (
	oidA = "6b06fe51a323212156bb267842bf10187ed4c20e"
	oidB = "3ff2a04361ca9d601180037bdfbc8b6c0a0a8723"
	oidS = "50305153f1a107c6871ab3b3047cb4c225603b0c"
	oidO = "0cb1fb59e73d78ff04cf41de7f177ea0fb940002"
)

const acmeSource = "https://github.com/acme/product-context"

func acmeIdentity(t *testing.T) string {
	t.Helper()
	identity, ok := mounts.NormalizeSource(acmeSource)
	if !ok {
		t.Fatal("the acme source must normalize")
	}
	return identity
}

// recipeGit runs git with author, committer, date, signing and autocrlf all fixed,
// so every commit id the recipe produces is a constant an expected.json can carry.
func recipeGit(t *testing.T, cwd string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"}, args...)...)
	cmd.Dir = cwd
	env := make([]string, 0, len(os.Environ()))
	for _, e := range os.Environ() {
		if !strings.HasPrefix(e, "GIT_DIR=") {
			env = append(env, e)
		}
	}
	cmd.Env = append(env,
		"GIT_AUTHOR_NAME=Leji Fixtures",
		"GIT_AUTHOR_EMAIL=fixtures@leji.org",
		"GIT_COMMITTER_NAME=Leji Fixtures",
		"GIT_COMMITTER_EMAIL=fixtures@leji.org",
		"GIT_AUTHOR_DATE=2026-01-01T00:00:00 +0000",
		"GIT_COMMITTER_DATE=2026-01-01T00:00:00 +0000",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v in %s: %v\n%s", args, cwd, err, out)
	}
	return strings.TrimSpace(string(out))
}

func recipeCommit(t *testing.T, repo, file string) string {
	t.Helper()
	stem := strings.TrimSuffix(file, ".md")
	if err := os.WriteFile(filepath.Join(repo, file), []byte("# "+stem+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	recipeGit(t, repo, "add", "-A")
	recipeGit(t, repo, "commit", "-q", "-m", stem)
	return recipeGit(t, repo, "rev-parse", "HEAD")
}

// buildAcmeSibling builds the `acme-sibling` recipe, normative in
// fixtures/README.md: a -> b on main, a side branch off `a`, and an unrelated
// orphan branch.
func buildAcmeSibling(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	recipeGit(t, dir, "init", "-q", "-b", "main", ".")
	for _, step := range []struct{ file, oid string }{{"a.md", oidA}, {"b.md", oidB}} {
		if got := recipeCommit(t, dir, step.file); got != step.oid {
			t.Fatalf("recipe commit %s = %s, want %s", step.file, got, step.oid)
		}
	}
	recipeGit(t, dir, "checkout", "-q", "-b", "side", oidA)
	if got := recipeCommit(t, dir, "s.md"); got != oidS {
		t.Fatalf("recipe commit s.md = %s, want %s", got, oidS)
	}
	recipeGit(t, dir, "checkout", "-q", "--orphan", "other")
	recipeGit(t, dir, "rm", "-q", "-rf", ".")
	if got := recipeCommit(t, dir, "o.md"); got != oidO {
		t.Fatalf("recipe commit o.md = %s, want %s", got, oidO)
	}
	recipeGit(t, dir, "checkout", "-q", "main")
	// Fetching a commit by id is how the resolver retains a pin, so the recipe's
	// repository must serve one the way a real host does.
	recipeGit(t, dir, "config", "uploadpack.allowAnySHA1InWant", "true")
}

// storeSpec mirrors the `store` field of one `updatePin` case.
type storeSpec struct {
	Pin        *string `json:"pin"`
	WitnessRef *string `json:"witnessRef"`
	WitnessOid *string `json:"witnessOid"`
	Depth      *int    `json:"depth"`
}

func storePath(t *testing.T, host string) string {
	t.Helper()
	sum := sha256.Sum256([]byte(acmeIdentity(t)))
	return filepath.Join(host, ".leji", "mounts", "store", hex.EncodeToString(sum[:]))
}

// buildStore builds the managed store exactly as a successful --fetch leaves it.
func buildStore(t *testing.T, host, sibling string, spec storeSpec) {
	t.Helper()
	identity := acmeIdentity(t)
	store := storePath(t, host)
	if err := os.MkdirAll(store, 0o755); err != nil {
		t.Fatal(err)
	}
	recipeGit(t, host, "init", "--bare", "-q", store)
	var depth []string
	if spec.Depth != nil {
		depth = []string{"--depth", itoa(*spec.Depth)}
	}
	if spec.Pin != nil {
		recipeGit(t, store, append(append([]string{"fetch", "-q"}, depth...), sibling, *spec.Pin)...)
		recipeGit(t, store, "update-ref", mounts.PinRefFor(identity, *spec.Pin), *spec.Pin)
	}
	if spec.WitnessRef != nil && spec.WitnessOid != nil {
		refspec := "+" + *spec.WitnessOid + ":" + mounts.WitnessRefFor(identity, *spec.WitnessRef)
		recipeGit(t, store, append(append([]string{"fetch", "-q"}, depth...), sibling, refspec)...)
	}
	// FETCH_HEAD records a per-harness path and is not part of any contract.
	if err := os.Remove(filepath.Join(store, "FETCH_HEAD")); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// repin applies a case's declaration rewrite: the pin it starts from, and whether
// the tracking ref is declared at all. A raw-text splice, as the fixture's own
// contract requires — the harness never reserializes a manifest either.
func repin(t *testing.T, host, pin string, dropTrackingRef bool) {
	t.Helper()
	mp := filepath.Join(host, "leji.json")
	raw, err := os.ReadFile(mp)
	if err != nil {
		t.Fatal(err)
	}
	text := pinRe.ReplaceAllString(string(raw), "${1}"+pin+"${2}")
	if dropTrackingRef {
		text = trackingRefRe.ReplaceAllString(text, "\n")
	}
	if err := os.WriteFile(mp, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func copyFixture(t *testing.T, name, dst string) {
	t.Helper()
	if err := os.CopyFS(dst, os.DirFS(fixture(t, name))); err != nil {
		t.Fatal(err)
	}
}

// withSourceRoutedTo routes the declared source at git's own level, for the run fn
// makes: the locator is one no test may actually reach.
func withSourceRoutedTo(t *testing.T, routed string, fn func()) {
	t.Helper()
	keys := []string{"GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"}
	prev := map[string]*string{}
	for _, k := range keys {
		if v, ok := os.LookupEnv(k); ok {
			vv := v
			prev[k] = &vv
		}
	}
	defer func() {
		for _, k := range keys {
			if v, ok := prev[k]; ok {
				os.Setenv(k, *v)
			} else {
				os.Unsetenv(k)
			}
		}
	}()
	if routed == "" {
		for _, k := range keys {
			os.Unsetenv(k)
		}
	} else {
		os.Setenv("GIT_CONFIG_COUNT", "1")
		os.Setenv("GIT_CONFIG_KEY_0", "url."+routed+".insteadOf")
		os.Setenv("GIT_CONFIG_VALUE_0", acmeSource)
	}
	fn()
}

// --- the two factorings, against the callers they came out of -----------------

func TestUpdatePinSelectComparisonAnswersWhatMountStatusReports(t *testing.T) {
	dir := t.TempDir()
	sibling := filepath.Join(dir, "sibling")
	buildAcmeSibling(t, sibling)
	for _, c := range []struct{ pin, want string }{
		{oidA, "behind"},
		{oidB, "up-to-date"},
		{oidS, "diverged"},
		{oidO, "unrelated"},
	} {
		host := filepath.Join(dir, "host-"+c.pin[:6])
		copyFixture(t, "warn-update-pin", host)
		repin(t, host, c.pin, false)
		witnessRef, witnessOid := "refs/heads/main", oidB
		buildStore(t, host, sibling, storeSpec{Pin: &c.pin, WitnessRef: &witnessRef, WitnessOid: &witnessOid})
		load := manifest.LoadManifest(host)
		if load.Manifest == nil {
			t.Fatalf("manifest: %v", load.Findings)
		}
		rows, err := mounts.MountStatus(host, load.Manifest, mounts.StatusOptions{})
		if err != nil {
			t.Fatal(err)
		}
		row := rows[0]
		if row.PinReport.State != c.want {
			t.Fatalf("status says %s, got %s", c.want, row.PinReport.State)
		}
		decl := mounts.MountDecl{Name: "product-context", Source: acmeSource, Pin: c.pin, TrackingRef: witnessRef}
		selection := mounts.SelectComparison(host, decl, witnessRef)
		if selection.Reason != "" {
			t.Fatalf("the matrix selected nothing: %s", selection.Reason)
		}
		// The helper reports the same repository, provenance and ref status does…
		if selection.ComparisonRepository != strOr(row.PinReport.ComparisonRepository, "") ||
			selection.WitnessProvenance != strOr(row.PinReport.WitnessProvenance, "") ||
			selection.ComparedRef != strOr(row.PinReport.ComparedRef, "") {
			t.Fatalf("selection %+v disagrees with %+v", selection, row.PinReport)
		}
		if selection.TipOid != oidB {
			t.Fatalf("the single witness snapshot = %s", selection.TipOid)
		}
		// …and comparing against that one snapshot reproduces the report exactly.
		cmp := mounts.ComparePins(selection.Repo, c.pin, selection.TipOid)
		if cmp.Reason != "" {
			t.Fatalf("comparison: %s", cmp.Reason)
		}
		if cmp.State != row.PinReport.State || cmp.Behind != *row.PinReport.Behind ||
			cmp.Ahead != *row.PinReport.Ahead || cmp.AncestryComplete != row.PinReport.AncestryComplete {
			t.Fatalf("comparison %+v disagrees with %+v", cmp, row.PinReport)
		}
	}
}

func TestUpdatePinSelectComparisonReportsDegradedReasonsWithoutSelecting(t *testing.T) {
	dir := t.TempDir()
	decl := mounts.MountDecl{Name: "product-context", Source: acmeSource, Pin: oidA, TrackingRef: "refs/heads/main"}
	// Nothing holds the pin.
	if got := mounts.SelectComparison(dir, decl, "refs/heads/main"); got.Reason != "mount-pin-unavailable" {
		t.Fatalf("reason = %q", got.Reason)
	}
	// A locator no resolver can normalize, and a ref the resolver refuses.
	unnormalizable := decl
	unnormalizable.Source = "file:///srv/x"
	if got := mounts.SelectComparison(dir, unnormalizable, "refs/heads/main"); got.Reason != "mount-source-unnormalizable" {
		t.Fatalf("reason = %q", got.Reason)
	}
	if got := mounts.SelectComparison(dir, decl, "refs/heads/main@{1}"); got.Reason != "mount-tracking-ref-invalid" {
		t.Fatalf("reason = %q", got.Reason)
	}
}

func TestUpdatePinRetainPinInStoreRetainsOneCommitWithoutTouchingTheWitness(t *testing.T) {
	dir := t.TempDir()
	sibling := filepath.Join(dir, "sibling")
	host := filepath.Join(dir, "host")
	buildAcmeSibling(t, sibling)
	if err := os.MkdirAll(host, 0o755); err != nil {
		t.Fatal(err)
	}
	identity := acmeIdentity(t)
	decl := mounts.MountDecl{Name: "product-context", Source: sibling, Pin: oidA, TrackingRef: "refs/heads/main"}
	store, errMsg, err := mounts.RetainPinInStore(host, decl, identity, oidA)
	if err != nil || store == "" {
		t.Fatalf("retain: %v %s", err, errMsg)
	}
	if got := recipeGit(t, store, "rev-parse", mounts.PinRefFor(identity, oidA)); got != oidA {
		t.Fatalf("pin ref = %s", got)
	}
	// The witness namespace belongs to the refresh, which this primitive is not.
	if got := recipeGit(t, store, "for-each-ref", "--format=%(refname)", "refs/leji-witness"); got != "" {
		t.Fatalf("witness refs = %q", got)
	}
	// A second commit is retained beside the first, not instead of it.
	store2, errMsg, err := mounts.RetainPinInStore(host, decl, identity, oidB)
	if err != nil || store2 == "" {
		t.Fatalf("retain b: %v %s", err, errMsg)
	}
	if got := recipeGit(t, store2, "rev-parse", mounts.PinRefFor(identity, oidA)); got != oidA {
		t.Fatalf("pin ref a = %s", got)
	}
	if got := recipeGit(t, store2, "rev-parse", mounts.PinRefFor(identity, oidB)); got != oidB {
		t.Fatalf("pin ref b = %s", got)
	}
	// A source that serves nothing is a stated failure, never a partial success.
	gone := decl
	gone.Source = filepath.Join(dir, "gone")
	repo, errMsg, err := mounts.RetainPinInStore(host, gone, identity, oidS)
	if err != nil || repo != "" {
		t.Fatalf("a missing source must fail: %v %q", err, repo)
	}
	if errMsg != "the pin could not be fetched from the source" {
		t.Fatalf("errMsg = %q", errMsg)
	}
}

// --- the shared fixtures' `updatePin` block -----------------------------------

type updatePinCase struct {
	ID                   string     `json:"id"`
	Note                 string     `json:"note"`
	Pin                  string     `json:"pin"`
	TrackingRef          *string    `json:"trackingRef"`
	HasTrackingRef       bool       `json:"-"`
	Store                *storeSpec `json:"store"`
	Hint                 bool       `json:"hint"`
	Source               string     `json:"source"`
	Args                 []string   `json:"args"`
	Exit                 int        `json:"exit"`
	Action               *string    `json:"action"`
	From                 *string    `json:"from"`
	To                   *string    `json:"to"`
	Reason               *string    `json:"reason"`
	Override             bool       `json:"override"`
	ComparisonRepository *string    `json:"comparisonRepository"`
	ComparedRef          *string    `json:"comparedRef"`
	ManifestGolden       *string    `json:"manifestGolden"`
	Written              bool       `json:"written"`
}

type updatePinBlock struct {
	Sibling string          `json:"sibling"`
	Mount   string          `json:"mount"`
	Cases   []updatePinCase `json:"cases"`
}

type updatePinDocument struct {
	Command  string `json:"command"`
	OK       bool   `json:"ok"`
	Findings []struct {
		Rule     string `json:"rule"`
		Severity string `json:"severity"`
		Path     string `json:"path"`
		Message  string `json:"message"`
	} `json:"findings"`
	Summary struct {
		Errors   int `json:"errors"`
		Warnings int `json:"warnings"`
	} `json:"summary"`
	Mount struct {
		Name           string  `json:"name"`
		SourceIdentity *string `json:"sourceIdentity"`
		TrackingRef    *string `json:"trackingRef"`
		From           *string `json:"from"`
		To             *string `json:"to"`
	} `json:"mount"`
	PinReport map[string]any `json:"pinReport"`
	Action    string         `json:"action"`
	Override  bool           `json:"override"`
	Reason    *string        `json:"reason"`
}

// documentKeys is exactly the key set --json emits, under every outcome that emits
// a document.
var documentKeys = []string{"command", "ok", "findings", "summary", "mount", "pinReport", "action", "override"}

func TestFixtureUpdatePinBlock(t *testing.T) {
	fixturesDir := filepath.Join(repoRoot(t), "fixtures")
	entries, err := os.ReadDir(fixturesDir)
	if err != nil {
		t.Fatal(err)
	}
	ran := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(fixturesDir, e.Name(), "expected.json"))
		if err != nil {
			continue
		}
		var wrapper struct {
			UpdatePin *updatePinBlock `json:"updatePin"`
		}
		if err := json.Unmarshal(raw, &wrapper); err != nil {
			t.Fatalf("%s: expected.json: %v", e.Name(), err)
		}
		if wrapper.UpdatePin == nil {
			continue
		}
		// `trackingRef: null` removes the declared ref; an absent key leaves the
		// fixture's own, which the typed decode above cannot tell apart.
		var rawCases struct {
			UpdatePin struct {
				Cases []map[string]json.RawMessage `json:"cases"`
			} `json:"updatePin"`
		}
		if err := json.Unmarshal(raw, &rawCases); err != nil {
			t.Fatal(err)
		}
		for i := range wrapper.UpdatePin.Cases {
			_, present := rawCases.UpdatePin.Cases[i]["trackingRef"]
			wrapper.UpdatePin.Cases[i].HasTrackingRef = present
		}
		for _, c := range wrapper.UpdatePin.Cases {
			ran++
			t.Run(e.Name()+"/"+c.ID, func(t *testing.T) {
				runUpdatePinCase(t, e.Name(), *wrapper.UpdatePin, c)
			})
		}
	}
	if ran == 0 {
		t.Fatal("no updatePin block found in fixtures")
	}
}

func runUpdatePinCase(t *testing.T, fixtureName string, block updatePinBlock, c updatePinCase) {
	t.Helper()
	dir := t.TempDir()
	sibling := filepath.Join(dir, "sibling")
	host := filepath.Join(dir, "host")
	buildAcmeSibling(t, sibling)
	copyFixture(t, fixtureName, host)
	repin(t, host, c.Pin, c.HasTrackingRef && c.TrackingRef == nil)
	if c.Store != nil {
		buildStore(t, host, sibling, *c.Store)
	}
	if c.Hint {
		if err := os.MkdirAll(filepath.Join(host, ".leji"), 0o755); err != nil {
			t.Fatal(err)
		}
		hint, _ := json.Marshal(map[string]any{"mounts": map[string]any{block.Mount: map[string]string{"repo": sibling}}})
		if err := os.WriteFile(filepath.Join(host, ".leji", "mounts.local.json"), append(hint, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// The declared source is a locator no test may actually reach, so it is routed
	// at git's own level: to the recipe repository for a run that must succeed, and
	// to a path that does not exist for one that must fail.
	routed := ""
	switch c.Source {
	case "local":
		routed = sibling
	case "unreachable":
		routed = filepath.Join(dir, "never-created")
	}

	manifestPath := filepath.Join(host, "leji.json")
	before, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var code int
	var stdout string
	withSourceRoutedTo(t, routed, func() {
		code, stdout, _ = captureRun(t, append(append([]string{}, c.Args...), "--root", host, "--json"))
	})
	if code != c.Exit {
		t.Fatalf("%s: exit %d, want %d (%s)", c.ID, code, c.Exit, stdout)
	}

	after, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if c.Action == nil {
		// A usage error reports no outcome at all, and touches nothing.
		if strings.TrimSpace(stdout) != "" {
			t.Fatalf("%s: no document, got %q", c.ID, stdout)
		}
		if string(after) != string(before) {
			t.Fatalf("%s: nothing written", c.ID)
		}
		return
	}
	var keyed map[string]json.RawMessage
	if err := json.Unmarshal([]byte(stdout), &keyed); err != nil {
		t.Fatalf("%s: %v (%s)", c.ID, err, stdout)
	}
	wantKeys := append([]string{}, documentKeys...)
	if c.Reason != nil {
		wantKeys = append(wantKeys, "reason")
	}
	sort.Strings(wantKeys)
	gotKeys := make([]string, 0, len(keyed))
	for k := range keyed {
		gotKeys = append(gotKeys, k)
	}
	sort.Strings(gotKeys)
	if strings.Join(gotKeys, ",") != strings.Join(wantKeys, ",") {
		t.Fatalf("%s: the exact JSON key set: got %v want %v", c.ID, gotKeys, wantKeys)
	}
	var doc updatePinDocument
	if err := json.Unmarshal([]byte(stdout), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Command != "mounts update-pin" {
		t.Fatalf("%s: command = %q", c.ID, doc.Command)
	}
	if doc.Action != *c.Action {
		t.Fatalf("%s: action = %q, want %q", c.ID, doc.Action, *c.Action)
	}
	if doc.Override != c.Override {
		t.Fatalf("%s: override = %v", c.ID, doc.Override)
	}
	if strOr(doc.Reason, "") != strOr(c.Reason, "") {
		t.Fatalf("%s: reason = %v, want %v", c.ID, doc.Reason, c.Reason)
	}
	if strOr(doc.Mount.From, "") != strOr(c.From, "") {
		t.Fatalf("%s: from = %v, want %v", c.ID, doc.Mount.From, c.From)
	}
	if strOr(doc.Mount.To, "") != strOr(c.To, "") {
		t.Fatalf("%s: to = %v, want %v", c.ID, doc.Mount.To, c.To)
	}
	if doc.OK != (c.Reason == nil) {
		t.Fatalf("%s: ok tracks the refusal", c.ID)
	}
	wantErrors, wantWarnings := 0, 0
	if c.Reason != nil {
		wantErrors = 1
	}
	if c.Override {
		wantWarnings = 1
	}
	if doc.Summary.Errors != wantErrors || doc.Summary.Warnings != wantWarnings {
		t.Fatalf("%s: summary = %+v", c.ID, doc.Summary)
	}
	// The findings are what the block pins, never read off the document: a refusal
	// names its reason code, an override warns under its own.
	type triple struct{ rule, severity, path string }
	var want []triple
	if c.Reason != nil {
		want = append(want, triple{*c.Reason, "error", doc.Mount.Name})
	}
	if c.Override {
		want = append(want, triple{"mount-pin-non-fast-forward-override", "warning", doc.Mount.Name})
	}
	sort.Slice(want, func(i, j int) bool { return want[i].rule < want[j].rule })
	var got []triple
	for _, f := range doc.Findings {
		got = append(got, triple{f.Rule, f.Severity, f.Path})
	}
	if len(got) != len(want) {
		t.Fatalf("%s: findings = %+v, want %+v", c.ID, got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%s: findings = %+v, want %+v", c.ID, got, want)
		}
	}
	if c.ComparisonRepository != nil && doc.PinReport["comparisonRepository"] != *c.ComparisonRepository {
		t.Fatalf("%s: comparisonRepository = %v", c.ID, doc.PinReport["comparisonRepository"])
	}
	if c.ComparedRef != nil && doc.PinReport["comparedRef"] != *c.ComparedRef {
		t.Fatalf("%s: comparedRef = %v", c.ID, doc.PinReport["comparedRef"])
	}

	if c.ManifestGolden != nil {
		golden, err := os.ReadFile(filepath.Join(repoRoot(t), "fixtures", filepath.FromSlash(*c.ManifestGolden)))
		if err != nil {
			t.Fatal(err)
		}
		if string(after) != string(golden) {
			t.Fatalf("%s: the written manifest bytes\n got=%q\nwant=%q", c.ID, after, golden)
		}
	}
	// `written: false` is one claim: the manifest is byte-identical to the manifest
	// this run started from.
	if !c.Written && string(after) != string(before) {
		t.Fatalf("%s: leji.json is byte-untouched", c.ID)
	}
	// A --fetch run does the store acts it was asked for even when the rewrite is
	// suppressed: dry-run withholds the manifest, not the fetch.
	if c.ID == "dry-run-fetch" {
		store := storePath(t, host)
		if _, err := os.Stat(store); err != nil {
			t.Fatalf("%s: the managed store was established: %v", c.ID, err)
		}
		if got := recipeGit(t, store, "rev-parse", mounts.PinRefFor(acmeIdentity(t), oidA)); got != oidA {
			t.Fatalf("%s: the pin was retained, got %s", c.ID, got)
		}
	}
	// Every fetch this command makes passes --no-write-fetch-head, so a run that
	// reached the source leaves no per-run record inside the store.
	if c.Source == "local" {
		if _, err := os.Stat(filepath.Join(storePath(t, host), "FETCH_HEAD")); !os.IsNotExist(err) {
			t.Fatalf("%s: no FETCH_HEAD", c.ID)
		}
	}
}

// --- the branches no fixture can construct ------------------------------------

func TestUpdatePinDeclarationChangedUnderTheRunIsRefused(t *testing.T) {
	dir := t.TempDir()
	sibling := filepath.Join(dir, "sibling")
	host := filepath.Join(dir, "host")
	buildAcmeSibling(t, sibling)
	copyFixture(t, "warn-update-pin", host)
	repin(t, host, oidA, false)
	pin, witnessRef, witnessOid := oidA, "refs/heads/main", oidB
	buildStore(t, host, sibling, storeSpec{Pin: &pin, WitnessRef: &witnessRef, WitnessOid: &witnessOid})
	load := manifest.LoadManifest(host)
	if load.Manifest == nil {
		t.Fatalf("manifest: %v", load.Findings)
	}
	// The comparison runs against the manifest object in hand; the file changes its
	// `source` before the verified read the rewrite makes.
	mp := filepath.Join(host, "leji.json")
	original, err := os.ReadFile(mp)
	if err != nil {
		t.Fatal(err)
	}
	moved := strings.Replace(string(original), acmeSource, "https://github.com/acme/moved-context", 1)
	if err := os.WriteFile(mp, []byte(moved), 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := updatepin.Run(host, load.Manifest, updatepin.Options{Name: "product-context"})
	if err != nil {
		t.Fatal(err)
	}
	if r.Action != "refused" || r.Reason != "mount-declaration-changed" {
		t.Fatalf("action=%q reason=%q", r.Action, r.Reason)
	}
	now, err := os.ReadFile(mp)
	if err != nil {
		t.Fatal(err)
	}
	if string(now) != moved {
		t.Fatal("the manifest was rewritten under a changed declaration")
	}
}

// TestUpdatePinTrackingRefPresenceIsPartOfTheDeclaration pins the half of the
// freshness gate a Go string cannot hold on its own: an ABSENT `trackingRef` that
// reappears — as `null`, as `""`, or as a real ref — is a changed declaration, and
// so is a declared one that disappears. Splicing the pin into any of them would
// write a mount the schema no longer accepts, or one compared against a ref it
// never spelled.
func TestUpdatePinTrackingRefPresenceIsPartOfTheDeclaration(t *testing.T) {
	dir := t.TempDir()
	sibling := filepath.Join(dir, "sibling")
	buildAcmeSibling(t, sibling)

	// Absent at load, present on the verified reread: three spellings, all refused.
	// The run needs --fetch, because an absent ref is what the advertised default is
	// resolved for — which is the only way this branch is reachable at all.
	for _, spelling := range []string{"null", `""`, `"refs/heads/main"`} {
		t.Run("absent then "+spelling, func(t *testing.T) {
			host := filepath.Join(dir, "reappears-"+strings.Map(func(r rune) rune {
				if r == '"' || r == '/' {
					return -1
				}
				return r
			}, spelling))
			copyFixture(t, "warn-update-pin", host)
			repin(t, host, oidA, true)
			if err := os.MkdirAll(filepath.Join(host, ".leji"), 0o755); err != nil {
				t.Fatal(err)
			}
			hint, _ := json.Marshal(map[string]any{"mounts": map[string]any{"product-context": map[string]string{"repo": sibling}}})
			if err := os.WriteFile(filepath.Join(host, ".leji", "mounts.local.json"), append(hint, '\n'), 0o644); err != nil {
				t.Fatal(err)
			}
			load := manifest.LoadManifest(host)
			if load.Manifest == nil {
				t.Fatalf("manifest: %v", load.Findings)
			}
			// The member reappears between the comparison and the verified read.
			mp := filepath.Join(host, "leji.json")
			original, err := os.ReadFile(mp)
			if err != nil {
				t.Fatal(err)
			}
			anchor := `"pin": "` + oidA + `",`
			changed := strings.Replace(string(original), anchor, anchor+"\n        \"trackingRef\": "+spelling+",", 1)
			if changed == string(original) {
				t.Fatal("the pin anchor must be there to splice against")
			}
			if err := os.WriteFile(mp, []byte(changed), 0o644); err != nil {
				t.Fatal(err)
			}
			var r updatepin.Result
			var rerr error
			withSourceRoutedTo(t, sibling, func() {
				r, rerr = updatepin.Run(host, load.Manifest, updatepin.Options{Name: "product-context", Fetch: true})
			})
			if rerr != nil {
				t.Fatal(rerr)
			}
			if r.Action != "refused" || r.Reason != "mount-declaration-changed" {
				t.Fatalf("action=%q reason=%q", r.Action, r.Reason)
			}
			now, err := os.ReadFile(mp)
			if err != nil {
				t.Fatal(err)
			}
			if string(now) != changed {
				t.Fatal("the manifest was rewritten under a changed declaration")
			}
		})
	}

	// And the other direction: declared at load, gone on the verified reread.
	t.Run("declared then absent", func(t *testing.T) {
		host := filepath.Join(dir, "disappears")
		copyFixture(t, "warn-update-pin", host)
		repin(t, host, oidA, false)
		pin, witnessRef, witnessOid := oidA, "refs/heads/main", oidB
		buildStore(t, host, sibling, storeSpec{Pin: &pin, WitnessRef: &witnessRef, WitnessOid: &witnessOid})
		load := manifest.LoadManifest(host)
		if load.Manifest == nil {
			t.Fatalf("manifest: %v", load.Findings)
		}
		mp := filepath.Join(host, "leji.json")
		original, err := os.ReadFile(mp)
		if err != nil {
			t.Fatal(err)
		}
		dropped := trackingRefRe.ReplaceAllString(string(original), "\n")
		if dropped == string(original) {
			t.Fatal("the declared trackingRef must be there to drop")
		}
		if err := os.WriteFile(mp, []byte(dropped), 0o644); err != nil {
			t.Fatal(err)
		}
		r, rerr := updatepin.Run(host, load.Manifest, updatepin.Options{Name: "product-context"})
		if rerr != nil {
			t.Fatal(rerr)
		}
		if r.Action != "refused" || r.Reason != "mount-declaration-changed" {
			t.Fatalf("action=%q reason=%q", r.Action, r.Reason)
		}
		now, err := os.ReadFile(mp)
		if err != nil {
			t.Fatal(err)
		}
		if string(now) != dropped {
			t.Fatal("the manifest was rewritten under a changed declaration")
		}
	})
}

func TestUpdatePinTargetRetentionFailureRefusesWithTheManifestUntouched(t *testing.T) {
	dir := t.TempDir()
	sibling := filepath.Join(dir, "sibling")
	host := filepath.Join(dir, "host")
	buildAcmeSibling(t, sibling)
	copyFixture(t, "warn-update-pin", host)
	repin(t, host, oidA, false)
	if err := os.MkdirAll(filepath.Join(host, ".leji"), 0o755); err != nil {
		t.Fatal(err)
	}
	hint, _ := json.Marshal(map[string]any{"mounts": map[string]any{"product-context": map[string]string{"repo": sibling}}})
	if err := os.WriteFile(filepath.Join(host, ".leji", "mounts.local.json"), append(hint, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	mp := filepath.Join(host, "leji.json")
	before, err := os.ReadFile(mp)
	if err != nil {
		t.Fatal(err)
	}
	// By the time the TARGET is retained the store already holds it, so the fetch
	// never runs and only the ref update can fail: the injection is the branch's one
	// reachable path. It names the TARGET, so retaining the current pin — the act
	// before the gate — still succeeds and the refusal is unambiguous.
	t.Setenv("LEJI_TEST_FAIL_PIN_REF", oidB)
	var code int
	var stdout string
	withSourceRoutedTo(t, sibling, func() {
		code, stdout, _ = captureRun(t, []string{"mounts", "update-pin", "product-context", "--fetch", "--root", host, "--json"})
	})
	if code != 1 {
		t.Fatalf("exit %d (%s)", code, stdout)
	}
	var doc updatePinDocument
	if err := json.Unmarshal([]byte(stdout), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Action != "refused" || strOr(doc.Reason, "") != "mount-store-fetch-failed" {
		t.Fatalf("action=%q reason=%v", doc.Action, doc.Reason)
	}
	if strOr(doc.Mount.To, "") != oidB {
		t.Fatalf("the target it declined to retain is still reported: %v", doc.Mount.To)
	}
	if len(doc.Findings) != 1 || doc.Findings[0].Rule != "mount-store-fetch-failed" {
		t.Fatalf("findings = %+v", doc.Findings)
	}
	after, err := os.ReadFile(mp)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatal("leji.json is byte-untouched")
	}
	// The refusal leaves the CURRENT pin retained: fetched objects and refs stay,
	// which is exactly what the help text says a failed --fetch may leave behind.
	if got := recipeGit(t, storePath(t, host), "rev-parse", mounts.PinRefFor(acmeIdentity(t), oidA)); got != oidA {
		t.Fatalf("the current pin is still retained, got %s", got)
	}
}

func TestUpdatePinScannerRefusalReachesTheCLIAtExitTwo(t *testing.T) {
	dir := t.TempDir()
	sibling := filepath.Join(dir, "sibling")
	host := filepath.Join(dir, "host")
	buildAcmeSibling(t, sibling)
	copyFixture(t, "warn-update-pin", host)
	repin(t, host, oidA, false)
	pin, witnessRef, witnessOid := oidA, "refs/heads/main", oidB
	buildStore(t, host, sibling, storeSpec{Pin: &pin, WitnessRef: &witnessRef, WitnessOid: &witnessOid})
	// The declaration check fires first, so the scanner's own refusal needs the name
	// to still match while the pin does not.
	text, err := os.ReadFile(filepath.Join(host, "leji.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := manifest.ReplaceMountPinInManifestText(string(text), "product-context", oidS, oidB); err == nil ||
		!strings.Contains(err.Error(), `pin of mount "product-context" is not`) {
		t.Fatalf("the scanner must refuse a span that does not hold `from`: %v", err)
	}
	// And a malformed --to never reaches the scanner at all.
	code, stdout, _ := captureRun(t, []string{
		"mounts", "update-pin", "product-context", "--to", strings.Repeat("z", 40), "--root", host, "--json",
	})
	if code != 2 || strings.TrimSpace(stdout) != "" {
		t.Fatalf("exit %d, stdout %q", code, stdout)
	}
}

// --- the CLI surface ----------------------------------------------------------

func TestUpdatePinMountsSubGuardAcceptsUpdatePinAndRejectsEverythingElse(t *testing.T) {
	dir := t.TempDir()
	host := filepath.Join(dir, "host")
	copyFixture(t, "warn-update-pin", host)
	// Accepted spellings reach their command (never the sub-guard's exit 2)…
	for _, sub := range []string{"hydrate", "status", "locate", "update-pin"} {
		argv := []string{"mounts", sub}
		if sub == "locate" || sub == "update-pin" {
			argv = append(argv, "product-context")
		}
		argv = append(argv, "--root", host)
		if code, _, _ := captureRun(t, argv); code == 2 {
			t.Fatalf("%s must reach its command", strings.Join(argv, " "))
		}
	}
	// …and every other spelling, including a bare `mounts`, is the guard.
	for _, sub := range [][]string{{}, {"nope"}, {"update"}, {"updatepin"}, {"update-pins"}, {"Update-Pin"}} {
		argv := append(append([]string{"mounts"}, sub...), "--root", host)
		if code, _, _ := captureRun(t, argv); code != 2 {
			t.Fatalf("mounts %s must be refused", strings.Join(sub, " "))
		}
	}
}

func TestUpdatePinTakesOnePositionalAndOnlyItsDeclaredFlags(t *testing.T) {
	dir := t.TempDir()
	host := filepath.Join(dir, "host")
	copyFixture(t, "warn-update-pin", host)
	up := []string{"mounts", "update-pin", "product-context"}
	// The positional budget gains this command's one name, as `mounts locate` has.
	if code, _, _ := captureRun(t, append(append([]string{}, up...), "--root", host)); code == 2 {
		t.Fatal("one positional is this command's budget")
	}
	for _, argv := range [][]string{
		append(append([]string{}, up...), "surplus"),
		{"mounts", "update-pin"},
		append(append([]string{}, up...), "--check-integrity"),
		append(append([]string{}, up...), "--strict"),
		append(append([]string{}, up...), "--endpoint", "x"),
		{"mounts", "status", "--to", oidB},
		{"mounts", "status", "--allow-non-fast-forward"},
		// The override is meaningless without a named target, and says so.
		append(append([]string{}, up...), "--allow-non-fast-forward"),
	} {
		if code, _, _ := captureRun(t, append(append([]string{}, argv...), "--root", host)); code != 2 {
			t.Fatalf("%s must be a usage error", strings.Join(argv, " "))
		}
	}
	// Flags declared on this command are accepted.
	if code, _, _ := captureRun(t, append(append([]string{}, up...), "--dry-run", "--fetch", "--root", host)); code == 2 {
		t.Fatal("--dry-run --fetch are this command's own flags")
	}
	// `--to` takes a full lowercase hex commit id in either spelling, and nothing else.
	for _, good := range [][]string{{"--to=" + oidB}, {"--to", strings.Repeat("0", 64)}} {
		argv := append(append(append([]string{}, up...), good...), "--root", host)
		if code, _, _ := captureRun(t, argv); code == 2 {
			t.Fatalf("--to %v must be accepted", good)
		}
	}
	for _, bad := range []string{"xyz", oidB[:12], strings.ToUpper(oidB), strings.Repeat("0", 41), strings.Repeat("0", 63), "", "--json"} {
		argv := append(append([]string{}, up...), "--to", bad, "--root", host)
		if code, _, _ := captureRun(t, argv); code != 2 {
			t.Fatalf("--to %q must be a usage error", bad)
		}
	}
}

func TestUpdatePinHelpExitsZeroAndNamesNoNetworkDestination(t *testing.T) {
	code, out, _ := captureRun(t, []string{"mounts", "update-pin", "--help"})
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	if !strings.Contains(out, "leji mounts update-pin") {
		t.Fatalf("help must name the command: %s", out)
	}
	// The only network vocabulary this command may carry is what `mounts hydrate`
	// already documents: the declared source, and nothing addressable by the caller.
	lower := strings.ToLower(out)
	for _, banned := range []string{"endpoint", "token", "upload", "registry", "api.", "http://", "account"} {
		if strings.Contains(lower, banned) {
			t.Fatalf("help must not mention %q", banned)
		}
	}
}
