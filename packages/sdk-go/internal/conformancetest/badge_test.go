package conformancetest

// Two halves of one contract, mirroring packages/sdk/test/badge.test.ts. First the
// constants: every level rendered and byte-compared against `fixtures/badge/`, the
// sole oracle, plus the `--out` acceptance table, the existing-file rule and the
// containment matrix over committed working copies. Then the shared fixtures'
// `badge` blocks, driven through the real CLI.

import (
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/badge"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

// committedFixture is a committed working copy of a shared fixture: the level a
// badge states needs a git baseline, since the `indexed` changelog item is
// `unknown` until the changelog is in HEAD (`fixtures/README.md` -> "The `badge`
// block").
//
// The copy lives under a SHORT temp name of its own rather than t.TempDir(), whose
// test-named path is long enough to exceed the platform's `sun_path` limit — and a
// socket bound at the badge target is one of the standing entries the containment
// matrix below has to plant. Resolved, like every root the guard judges.
func committedFixture(t *testing.T, name string) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "leji-badge-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	cp := exec.Command("cp", "-r", filepath.Join(fixturesDir(t), name)+"/.", dir)
	if out, err := cp.CombinedOutput(); err != nil {
		t.Fatalf("cp: %v: %s", err, out)
	}
	gitCommitAll(t, dir)
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}

func goldenBadge(t *testing.T, rel string) []byte {
	t.Helper()
	body, err := os.ReadFile(filepath.Join(fixturesDir(t), filepath.FromSlash(rel)))
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func mustRun(t *testing.T, root, out string) badge.Result {
	t.Helper()
	r, err := badge.Run(root, out)
	if err != nil {
		t.Fatalf("badge.Run(%s, %s): %v", root, out, err)
	}
	return r
}

// --- the canonical bytes ------------------------------------------------------

func TestBadgeRendersEveryLevelByteForByte(t *testing.T) {
	for _, level := range manifest.ConformanceLevels {
		if got, want := badge.Render(level), string(goldenBadge(t, "badge/"+level+".svg")); got != want {
			t.Fatalf("%s.svg differs from the golden", level)
		}
		if got, want := badge.Markdown(level, badge.DefaultOut), string(goldenBadge(t, "badge/"+level+".md")); got != want {
			t.Fatalf("%s.md differs from the golden:\n got=%q\nwant=%q", level, got, want)
		}
	}
}

// drawnText is every `<text>` body in an SVG, in document order: what a renderer
// actually paints, as opposed to what the accessible name says.
var drawnText = regexp.MustCompile(`<text\b[^>]*>([^<]*)</text>`)

func TestBadgeClaimIsStructuralNotDrawn(t *testing.T) {
	for _, level := range manifest.ConformanceLevels {
		claim := "Leji 1.0 · " + level + " · self-attested"
		// The markdown fixture — the alt text an adopter pastes into a README — carries
		// the whole claim, which is what lets the face drop it.
		md := string(goldenBadge(t, "badge/"+level+".md"))
		if !strings.Contains(md, "[!["+claim+"]") {
			t.Errorf("%s.md must carry the full alt claim, got %q", level, md)
		}

		svg := string(goldenBadge(t, "badge/"+level+".svg"))
		if !strings.Contains(svg, "<title>"+claim+"</title>") {
			t.Errorf("%s.svg <title> must carry the claim", level)
		}
		if !strings.Contains(svg, `aria-label="`+claim+`"`) {
			t.Errorf("%s.svg aria-label must carry the claim", level)
		}

		// The visible segment is the level alone: the two `<text>` bodies are the
		// wordmark and the level, and `self-attested` appears nowhere a renderer draws.
		var drawn []string
		for _, m := range drawnText.FindAllStringSubmatch(svg, -1) {
			drawn = append(drawn, m[1])
		}
		if want := []string{"Leji 1.0", level}; !reflect.DeepEqual(drawn, want) {
			t.Errorf("%s.svg draws %q, want %q", level, drawn, want)
		}
	}
}

func TestBadgeMarkdownCarriesTheCanonicalOutNotTheDefault(t *testing.T) {
	want := "[![Leji 1.0 · governed · self-attested](docs/badge.svg)](https://leji.org/agent-ready/)\n"
	if got := badge.Markdown("governed", "docs/badge.svg"); got != want {
		t.Fatalf("markdown %q, want %q", got, want)
	}
}

// --- the `--out` acceptance rule ----------------------------------------------

func TestBadgeOutAcceptsRepositoryRelativeSvgAndRejectsEverythingElse(t *testing.T) {
	dir := committedFixture(t, "valid-badge-governed")
	// Accepted, with the canonical POSIX form echoed back: a `.` segment is dropped,
	// and a nested target has its parent directories created.
	for _, c := range []struct{ given, canonical string }{
		{"leji-badge.svg", "leji-badge.svg"},
		{"./badge.svg", "badge.svg"},
		{"docs/badge.svg", "docs/badge.svg"},
		{"a/b/c-1_2.svg", "a/b/c-1_2.svg"},
	} {
		r := mustRun(t, dir, c.given)
		if r.UsageError != "" {
			t.Fatalf("%s must be accepted: %s", c.given, r.UsageError)
		}
		if r.Out != c.canonical {
			t.Fatalf("%s canonicalizes to %q, got %q", c.given, c.canonical, r.Out)
		}
		if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(c.canonical))); err != nil {
			t.Fatalf("%s was not written: %v", c.canonical, err)
		}
	}
	// Rejected at argument parsing, before conformance runs: no level is reported at
	// all, and nothing is written.
	for _, bad := range []string{
		"/abs.svg", "../x.svg", "docs/../x.svg", `a\b.svg`, "x.png", "x.svg ",
		"a//b.svg", "doc s/x.svg", "x.svg#frag", ".leji/x.svg", ".leji/dist/x.svg", ".leji/a/b/x.svg",
	} {
		r := mustRun(t, dir, bad)
		if r.UsageError == "" {
			t.Fatalf("%s must be rejected", bad)
		}
		if r.Out != "" || r.Level != "" || r.ClaimedLevel != "" || r.VerifiedLevel != "" {
			t.Fatalf("%s must report no level at all: %+v", bad, r)
		}
	}
	// A directory at the target is a rejection too, and the directory survives it.
	if err := os.Mkdir(filepath.Join(dir, "adir.svg"), 0o755); err != nil {
		t.Fatal(err)
	}
	if mustRun(t, dir, "adir.svg").UsageError == "" {
		t.Fatal("a directory is never a badge target")
	}
	if info, err := os.Stat(filepath.Join(dir, "adir.svg")); err != nil || !info.IsDir() {
		t.Fatal("the directory must survive the rejection")
	}
}

// --- the existing-file rule ---------------------------------------------------

func TestBadgeTargetFileDecidesTheActionByItsBytesAndNothingElse(t *testing.T) {
	dir := committedFixture(t, "valid-badge-governed")
	target := filepath.Join(dir, badge.DefaultOut)

	// Absent: written.
	if got := mustRun(t, dir, badge.DefaultOut).Action; got != badge.Wrote {
		t.Fatalf("an absent target is written, got %q", got)
	}
	body, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != badge.Render("governed") {
		t.Fatal("the written bytes are the canonical governed badge")
	}

	// These exact bytes: unchanged, and not rewritten (the mtime stands).
	before, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if got := mustRun(t, dir, badge.DefaultOut).Action; got != badge.Unchanged {
		t.Fatalf("identical bytes are unchanged, got %q", got)
	}
	after, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if !after.ModTime().Equal(before.ModTime()) {
		t.Fatal("an unchanged target is never rewritten")
	}

	// Another canonical badge of this contract: overwritten, which is how a level
	// change regenerates. All three of the others, not just the neighbouring one.
	for _, level := range manifest.ConformanceLevels {
		if level == "governed" {
			continue
		}
		if err := os.WriteFile(target, []byte(badge.Render(level)), 0o644); err != nil {
			t.Fatal(err)
		}
		if got := mustRun(t, dir, badge.DefaultOut).Action; got != badge.Overwrote {
			t.Fatalf("a stale %s badge regenerates, got %q", level, got)
		}
		body, err := os.ReadFile(target)
		if err != nil {
			t.Fatal(err)
		}
		if string(body) != badge.Render("governed") {
			t.Fatalf("a stale %s badge is replaced by the verified level's bytes", level)
		}
	}

	// Anything else: refused, exit 2's message, the file untouched and never
	// truncated. The levels are still reported, the rule running after conformance.
	foreign := "<svg><!-- somebody elses file --></svg>\n"
	if err := os.WriteFile(target, []byte(foreign), 0o644); err != nil {
		t.Fatal(err)
	}
	r := mustRun(t, dir, badge.DefaultOut)
	if r.Refusal != "leji-badge.svg exists and is not a leji badge; remove or rename it" {
		t.Fatalf("refusal %q", r.Refusal)
	}
	if r.Out != "" || r.Action != "" {
		t.Fatalf("a refusal writes nothing: %+v", r)
	}
	if r.ClaimedLevel != "governed" || r.VerifiedLevel != "governed" {
		t.Fatalf("a refusal still reports both levels: %+v", r)
	}
	body, err = os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != foreign {
		t.Fatal("a refusal never edits and never truncates")
	}
}

func TestBadgeNestedOutCreatesParentsOnlyWhenTheWriteHappens(t *testing.T) {
	dir := committedFixture(t, "valid-records") // claims core, verifies core
	if err := os.WriteFile(filepath.Join(dir, badge.DefaultOut), []byte("not a badge\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if mustRun(t, dir, "docs/nested/badge.svg").Out == "" {
		t.Fatal("a nested target is written")
	}
	if _, err := os.Stat(filepath.Join(dir, "docs", "nested", "badge.svg")); err != nil {
		t.Fatalf("the nested target: %v", err)
	}
	// The refusal path writes nothing, so it establishes no directory either.
	if mustRun(t, dir, badge.DefaultOut).Refusal == "" {
		t.Fatal("the foreign file is refused")
	}
}

func TestBadgeRunThatWritesNothingEstablishesNoDirectory(t *testing.T) {
	// Exit 1 (a claim this run refutes): the nested target and its parent are both
	// absent afterwards, so the directory is a consequence of the write and not of
	// the attempt.
	failing := committedFixture(t, "invalid-governed-no-profile")
	r := mustRun(t, failing, "pub/x/badge.svg")
	if r.Out != "" || r.Action != "" {
		t.Fatalf("a refuted claim writes nothing: %+v", r)
	}
	if !hasErrorFinding(r) {
		t.Fatal("a refuted claim reports an error finding")
	}
	for _, rel := range []string{"pub/x/badge.svg", "pub/x", "pub"} {
		if _, err := os.Lstat(filepath.Join(failing, filepath.FromSlash(rel))); err == nil {
			t.Fatalf("%s was created by a run that wrote nothing", rel)
		}
	}

	// Exit 2 (a foreign file at a nested target whose parent already exists): the
	// parent is left exactly as it was and the target's bytes are untouched.
	dir := committedFixture(t, "valid-badge-governed")
	parent := filepath.Join(dir, "pub")
	if err := os.Mkdir(parent, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(parent, "sibling.txt"), []byte("untouched\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	foreign := "not a badge\n"
	if err := os.WriteFile(filepath.Join(parent, "badge.svg"), []byte(foreign), 0o644); err != nil {
		t.Fatal(err)
	}
	before := snapshotTree(t, dir, dir)
	if got := mustRun(t, dir, "pub/badge.svg").Refusal; got != "pub/badge.svg exists and is not a leji badge; remove or rename it" {
		t.Fatalf("refusal %q", got)
	}
	body, err := os.ReadFile(filepath.Join(parent, "badge.svg"))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != foreign {
		t.Fatal("the target is byte-untouched")
	}
	if !equalStrings(snapshotTree(t, dir, dir), before) {
		t.Fatal("the tree is untouched")
	}
}

func hasErrorFinding(r badge.Result) bool {
	for _, f := range r.Findings {
		if f.Severity == "error" {
			return true
		}
	}
	return false
}

// --- containment: the resolved path decides, in both directions -----------------

func TestBadgeRefusesAParentResolvingOutsideTheRepository(t *testing.T) {
	outside := t.TempDir()
	dir := committedFixture(t, "valid-badge-governed")
	// A file already standing at the escaped location: the run must neither read it
	// (it is not the target the check cleared) nor replace it.
	planted := "somebody elses file\n"
	if err := os.WriteFile(filepath.Join(outside, "x.svg"), []byte(planted), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "pub")); err != nil {
		t.Fatal(err)
	}
	before := snapshotTree(t, dir, dir)

	r := mustRun(t, dir, "pub/x.svg")
	if r.UsageError == "" && r.Refusal == "" {
		t.Fatalf("the escape is refused: %+v", r)
	}
	if r.Out != "" || r.Action != "" {
		t.Fatalf("nothing is reported written: %+v", r)
	}
	body, err := os.ReadFile(filepath.Join(outside, "x.svg"))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != planted {
		t.Fatal("the outside file is untouched")
	}
	entries, err := os.ReadDir(outside)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "x.svg" {
		t.Fatal("nothing was created outside the repository")
	}
	if !equalStrings(snapshotTree(t, dir, dir), before) {
		t.Fatal("and nothing inside it")
	}
}

func TestBadgeRefusesAParentResolvingIntoLejiAtAnyDepth(t *testing.T) {
	dir := committedFixture(t, "valid-badge-governed")
	dist := filepath.Join(dir, ".leji", "dist")
	if err := os.MkdirAll(dist, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(dist, filepath.Join(dir, "pub")); err != nil {
		t.Fatal(err)
	}
	r := mustRun(t, dir, "pub/x.svg")
	if r.UsageError == "" && r.Refusal == "" {
		t.Fatalf(".leji/ is never a badge target: %+v", r)
	}
	if r.Out != "" {
		t.Fatalf("nothing is reported written: %+v", r)
	}
	entries, err := os.ReadDir(dist)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatal("the private role stays empty")
	}
}

func TestBadgeRefusesATargetSymlinkedOutOfTheRepository(t *testing.T) {
	outside := t.TempDir()
	dir := committedFixture(t, "valid-badge-governed")
	planted := "somebody elses file\n"
	escaped := filepath.Join(outside, "foreign.svg")
	if err := os.WriteFile(escaped, []byte(planted), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(escaped, filepath.Join(dir, badge.DefaultOut)); err != nil {
		t.Fatal(err)
	}

	r := mustRun(t, dir, badge.DefaultOut)
	if r.UsageError == "" && r.Refusal == "" {
		t.Fatalf("a link out of the repository is refused: %+v", r)
	}
	if r.Out != "" || r.Action != "" {
		t.Fatalf("nothing is reported written: %+v", r)
	}
	body, err := os.ReadFile(escaped)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != planted {
		t.Fatal("the link target is byte-untouched")
	}
	info, err := os.Lstat(filepath.Join(dir, badge.DefaultOut))
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("the link itself is left alone")
	}
}

func TestBadgeRefusesADanglingTargetInsideTheRepository(t *testing.T) {
	dir := committedFixture(t, "valid-badge-governed")
	// The link resolves to a missing file INSIDE the repository, so the resolved
	// destination is absent while the entry at the target path is not. A write would
	// follow the link and create the destination; a standing entry that could not be
	// verified as a badge is a refusal instead.
	if err := os.Symlink("missing-file.svg", filepath.Join(dir, badge.DefaultOut)); err != nil {
		t.Fatal(err)
	}
	before := snapshotTree(t, dir, dir)

	r := mustRun(t, dir, badge.DefaultOut)
	assertTargetRefusal(t, r, badge.DefaultOut)
	info, err := os.Lstat(filepath.Join(dir, badge.DefaultOut))
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("the link itself is left alone")
	}
	if _, err := os.Lstat(filepath.Join(dir, "missing-file.svg")); err == nil {
		t.Fatal("the link destination was never created")
	}
	if !equalStrings(snapshotTree(t, dir, dir), before) {
		t.Fatal("the tree is untouched")
	}
}

// listenUnix binds a unix socket, or skips: binding one is not portable, and the
// path length limit is the platform's, so a platform that cannot is skipped rather
// than failed (as the reference test is).
func listenUnix(t *testing.T, abs string) net.Listener {
	t.Helper()
	l, err := net.Listen("unix", abs)
	if err != nil {
		t.Skipf("this platform cannot bind a unix socket at %s: %v", abs, err)
	}
	t.Cleanup(func() { _ = l.Close() })
	return l
}

func TestBadgeRefusesAUnixSocketTargetAsADocumentNotACrash(t *testing.T) {
	dir := committedFixture(t, "valid-badge-governed")
	target := filepath.Join(dir, badge.DefaultOut)
	// A socket is the non-regular entry that no earlier check rejects: it is not a
	// directory, and opening it fails with something other than ENOENT.
	listenUnix(t, target)
	info, err := os.Lstat(target)
	if err != nil || info.Mode()&os.ModeSocket == 0 {
		t.Fatal("the target is a socket")
	}
	before := snapshotTree(t, dir, dir)

	assertTargetRefusal(t, mustRun(t, dir, badge.DefaultOut), badge.DefaultOut)
	info, err = os.Lstat(target)
	if err != nil || info.Mode()&os.ModeSocket == 0 {
		t.Fatal("the socket itself is left alone")
	}
	if !equalStrings(snapshotTree(t, dir, dir), before) {
		t.Fatal("the tree is untouched")
	}

	// Through the real CLI: the refusal is the ordinary badge document at exit 2,
	// which is exactly what an escaping error would deny this case.
	code, out := runCLI(t, []string{"badge", "--root", dir, "--json"})
	if code != 2 {
		t.Fatalf("the refusal exits 2, got %d", code)
	}
	assertRefusalDocument(t, out, badge.DefaultOut, "badge-target-refused")
}

func TestBadgeRefusesASymlinkToAUnixSocketAsADocumentToo(t *testing.T) {
	dir := committedFixture(t, "valid-badge-governed")
	sock := filepath.Join(dir, "sock")
	target := filepath.Join(dir, badge.DefaultOut)
	// The link passes an entry-kind check that stops at the link itself, and the
	// verified open then follows it to the socket. So the kind that decides is the
	// one at the END of the link.
	listenUnix(t, sock)
	if err := os.Symlink("sock", target); err != nil {
		t.Fatal(err)
	}
	before := snapshotTree(t, dir, dir)

	assertTargetRefusal(t, mustRun(t, dir, badge.DefaultOut), badge.DefaultOut)
	info, err := os.Lstat(target)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("the link itself is left alone")
	}
	info, err = os.Lstat(sock)
	if err != nil || info.Mode()&os.ModeSocket == 0 {
		t.Fatal("and so is the socket it points at")
	}
	if !equalStrings(snapshotTree(t, dir, dir), before) {
		t.Fatal("the tree is untouched")
	}

	code, out := runCLI(t, []string{"badge", "--root", dir, "--json"})
	if code != 2 {
		t.Fatalf("the refusal exits 2, got %d", code)
	}
	assertRefusalDocument(t, out, badge.DefaultOut, "badge-target-refused")
}

// assertTargetRefusal is the one standing-entry refusal, in the same words for
// every entry kind that is not a regular file this run may act through.
func assertTargetRefusal(t *testing.T, r badge.Result, rel string) {
	t.Helper()
	want := rel + " does not resolve to a regular file inside the repository; nothing was written"
	if r.Refusal != want {
		t.Fatalf("refusal %q, want %q", r.Refusal, want)
	}
	if r.Out != "" || r.Action != "" {
		t.Fatalf("a refusal writes nothing: %+v", r)
	}
	if got := findingKeys(r); len(got) != 1 || got[0] != "badge-target-refused|error|"+rel {
		t.Fatalf("findings %v", got)
	}
}

func findingKeys(r badge.Result) []string {
	var out []string
	for _, f := range r.Findings {
		out = append(out, f.Rule+"|"+f.Severity+"|"+f.Path)
	}
	return out
}

// --- the `--json` document ----------------------------------------------------

// documentKeys is exactly the keys `--json` emits, under every outcome: a consumer
// parses one document whether the run wrote a badge, refuted a claim, or refused a
// file.
var documentKeys = []string{
	"command", "ok", "findings", "summary", "out", "level",
	"claimedLevel", "verifiedLevel", "markdown", "action",
}

type badgeDocument struct {
	Command  string `json:"command"`
	OK       bool   `json:"ok"`
	Findings []struct {
		Rule     string `json:"rule"`
		Severity string `json:"severity"`
		Path     string `json:"path"`
	} `json:"findings"`
	Summary struct {
		Errors   int `json:"errors"`
		Warnings int `json:"warnings"`
	} `json:"summary"`
	Out           *string `json:"out"`
	Level         *string `json:"level"`
	ClaimedLevel  *string `json:"claimedLevel"`
	VerifiedLevel *string `json:"verifiedLevel"`
	Markdown      *string `json:"markdown"`
	Action        *string `json:"action"`
}

func parseDocument(t *testing.T, stdout, where string) badgeDocument {
	t.Helper()
	var keyed map[string]json.RawMessage
	if err := json.Unmarshal([]byte(stdout), &keyed); err != nil {
		t.Fatalf("%s: not a JSON document: %v\n%s", where, err, stdout)
	}
	var got []string
	for k := range keyed {
		got = append(got, k)
	}
	sort.Strings(got)
	want := append([]string{}, documentKeys...)
	sort.Strings(want)
	if !equalStrings(got, want) {
		t.Fatalf("%s: the exact JSON key set, got %v want %v", where, got, want)
	}
	var doc badgeDocument
	if err := json.Unmarshal([]byte(stdout), &doc); err != nil {
		t.Fatalf("%s: %v", where, err)
	}
	return doc
}

func docFindingKeys(doc badgeDocument) []string {
	var out []string
	for _, f := range doc.Findings {
		out = append(out, f.Rule+"|"+f.Severity+"|"+f.Path)
	}
	return out
}

// assertRefusalDocument is the standing-entry refusal as a `--json` consumer reads
// it: the ordinary badge document, `ok:false`, every written field null.
func assertRefusalDocument(t *testing.T, stdout, rel, rule string) {
	t.Helper()
	doc := parseDocument(t, stdout, "refusal")
	if doc.Command != "badge" || doc.OK {
		t.Fatalf("command %q ok %v", doc.Command, doc.OK)
	}
	if doc.Out != nil || doc.Level != nil || doc.Markdown != nil || doc.Action != nil {
		t.Fatalf("a refusal reports nothing written: %+v", doc)
	}
	if got := docFindingKeys(doc); len(got) != 1 || got[0] != rule+"|error|"+rel {
		t.Fatalf("findings %v", got)
	}
	if doc.Summary.Errors != 1 || doc.Summary.Warnings != 0 {
		t.Fatalf("summary %+v", doc.Summary)
	}
}

func TestBadgeOutUsageErrorExitsTwoAndEmitsNoDocumentAtAll(t *testing.T) {
	dir := committedFixture(t, "valid-badge-governed")
	for _, bad := range []string{"x.png", "../x.svg", "/abs.svg", ".leji/x.svg"} {
		code, out := runCLI(t, []string{"badge", "--root", dir, "--json", "--out", bad})
		if code != 2 {
			t.Fatalf("%s is a usage error, got %d", bad, code)
		}
		if strings.TrimSpace(out) != "" {
			t.Fatalf("%s writes nothing to stdout, so no level is reported: %q", bad, out)
		}
	}
	if _, err := os.Lstat(filepath.Join(dir, badge.DefaultOut)); err == nil {
		t.Fatal("and nothing was written")
	}
}

// --- the shared fixtures' `badge` blocks --------------------------------------

type badgePreseed struct {
	Path  string `json:"path"`
	From  string `json:"from"`
	Bytes string `json:"bytes"`
}

type badgeBlock struct {
	Args          []string      `json:"args"`
	Exit          int           `json:"exit"`
	Out           *string       `json:"out"`
	Level         *string       `json:"level"`
	ClaimedLevel  *string       `json:"claimedLevel"`
	VerifiedLevel *string       `json:"verifiedLevel"`
	Golden        *string       `json:"golden"`
	Action        *string       `json:"action"`
	Written       *bool         `json:"written"`
	Preseed       *badgePreseed `json:"preseed"`
	Rerun         *struct {
		Action        string `json:"action"`
		ByteIdentical bool   `json:"byteIdentical"`
	} `json:"rerun"`
}

func loadBadgeBlock(t *testing.T, dir string) *badgeBlock {
	t.Helper()
	body, err := os.ReadFile(filepath.Join(dir, "expected.json"))
	if err != nil {
		t.Fatal(err)
	}
	var wrapper struct {
		Badge *badgeBlock `json:"badge"`
	}
	if err := json.Unmarshal(body, &wrapper); err != nil {
		t.Fatal(err)
	}
	return wrapper.Badge
}

// expectedFindings are the findings and the summary a `badge` block PINS — fixed by
// the block alone, never read off the document being judged, so a different rule, an
// extra finding or a missing one fails. Three outcomes exhaust the block: a success
// reports nothing; an exit-2 refusal names the foreign file it would not overwrite;
// an exit-1 run reports the conformance error that left nothing honest to state —
// the claim gate when this run verified a level below the claim, `badge-unverified`
// when it verified no level at all.
func expectedFindings(block *badgeBlock, targetRel string) ([]string, int) {
	if block.Exit == 0 {
		return nil, 0
	}
	if block.Exit == 2 {
		return []string{"badge-target-foreign|error|" + targetRel}, 1
	}
	rule := "conformance-claim"
	if block.VerifiedLevel == nil {
		rule = "badge-unverified"
	}
	return []string{rule + "|error|leji.json"}, 1
}

// assertBadgeDocument compares the whole `--json` document against the block: the
// exact key set, and every value the block fixes — including the findings and the
// summary, pinned rather than derived from the document, which is what makes a wrong
// rule or a stray finding fail here.
func assertBadgeDocument(t *testing.T, stdout string, block *badgeBlock, targetRel, where string) {
	t.Helper()
	doc := parseDocument(t, stdout, where)
	if doc.Command != "badge" {
		t.Fatalf("%s: command %q", where, doc.Command)
	}
	for _, f := range []struct {
		name      string
		got, want *string
	}{
		{"out", doc.Out, block.Out},
		{"level", doc.Level, block.Level},
		{"claimedLevel", doc.ClaimedLevel, block.ClaimedLevel},
		{"verifiedLevel", doc.VerifiedLevel, block.VerifiedLevel},
		{"action", doc.Action, block.Action},
	} {
		if !sameNullable(f.got, f.want) {
			t.Fatalf("%s: %s %s, want %s", where, f.name, showNullable(f.got), showNullable(f.want))
		}
	}
	var wantMarkdown *string
	if block.Level != nil && block.Out != nil {
		md := badge.Markdown(*block.Level, *block.Out)
		wantMarkdown = &md
	}
	if !sameNullable(doc.Markdown, wantMarkdown) {
		t.Fatalf("%s: markdown %s, want %s", where, showNullable(doc.Markdown), showNullable(wantMarkdown))
	}
	if doc.OK != (block.Exit == 0) {
		t.Fatalf("%s: ok %v tracks the exit code %d", where, doc.OK, block.Exit)
	}
	wantFindings, wantErrors := expectedFindings(block, targetRel)
	if !equalStrings(docFindingKeys(doc), wantFindings) {
		t.Fatalf("%s: findings %v, want %v", where, docFindingKeys(doc), wantFindings)
	}
	if doc.Summary.Errors != wantErrors || doc.Summary.Warnings != 0 {
		t.Fatalf("%s: summary %+v, want {%d 0}", where, doc.Summary, wantErrors)
	}
}

func sameNullable(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func showNullable(p *string) string {
	if p == nil {
		return "null"
	}
	return `"` + *p + `"`
}

func TestFixtureBadgeBlocks(t *testing.T) {
	fd := fixturesDir(t)
	for _, name := range fixtureNames(t) {
		block := loadBadgeBlock(t, filepath.Join(fd, name))
		if block == nil {
			continue
		}
		t.Run(name, func(t *testing.T) {
			dir := committedFixture(t, name)
			targetRel := badge.DefaultOut
			switch {
			case block.Preseed != nil:
				targetRel = block.Preseed.Path
			case block.Out != nil:
				targetRel = *block.Out
			}
			target := filepath.Join(dir, filepath.FromSlash(targetRel))
			var planted []byte
			if block.Preseed != nil {
				body := []byte(block.Preseed.Bytes)
				if block.Preseed.From != "" {
					body = goldenBadge(t, block.Preseed.From)
				}
				if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(target, body, 0o644); err != nil {
					t.Fatal(err)
				}
				planted = body
			}

			args := block.Args
			if args == nil {
				args = []string{"badge"}
			}
			code, stdout := runCLI(t, append(append([]string{}, args...), "--root", dir, "--json"))
			if code != block.Exit {
				t.Fatalf("exit code: got %d want %d\n%s", code, block.Exit, stdout)
			}
			// The document carries every outcome, refusals included: `ok:false` and the
			// rule that refused, at the target path, are pinned inside it.
			assertBadgeDocument(t, stdout, block, targetRel, name+" (first run)")

			if block.Golden != nil {
				got, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(*block.Out)))
				if err != nil {
					t.Fatal(err)
				}
				if string(got) != string(goldenBadge(t, *block.Golden)) {
					t.Fatalf("the written bytes differ from %s", *block.Golden)
				}
			}
			// `written: false` is two claims in one: the target does not exist after the
			// run, or — when `preseed` planted it — its planted bytes are still there.
			if block.Written != nil && !*block.Written {
				if planted == nil {
					if _, err := os.Lstat(target); err == nil {
						t.Fatalf("%s was never created", targetRel)
					}
				} else {
					got, err := os.ReadFile(target)
					if err != nil {
						t.Fatal(err)
					}
					if string(got) != string(planted) {
						t.Fatalf("%s is byte-untouched", targetRel)
					}
				}
			}

			if block.Rerun != nil {
				afterFirst := snapshotTree(t, dir, dir)
				code, stdout := runCLI(t, append(append([]string{}, args...), "--root", dir, "--json"))
				if code != 0 {
					t.Fatalf("the steady state exits 0, got %d\n%s", code, stdout)
				}
				// The whole document again, not just `action`: the steady state is the
				// same run reported the same way, with the write already done.
				steady := *block
				steady.Action = &block.Rerun.Action
				steady.Preseed = nil
				assertBadgeDocument(t, stdout, &steady, targetRel, name+" (rerun)")
				if block.Rerun.ByteIdentical && !equalStrings(snapshotTree(t, dir, dir), afterFirst) {
					t.Fatal("a second run is a byte-level no-op across the whole working tree")
				}
			}
		})
	}
}
