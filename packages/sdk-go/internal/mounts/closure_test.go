// The projection closure. Mirrors the closure section of
// packages/sdk/test/mounts.test.ts.
//
// A layer projects as its manifest declares it, not as its directory layout
// happens to look: relocated machine artifacts, governed content outside rootPath
// and bound profiles outside the profiles tree all travel. An absent optional
// selection contributes nothing; an absent referenced file fails the closure with
// a stable code naming the artifact that declared it.
package mounts_test

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/mounts"
)

// customSibling builds a sibling from an explicit manifest text and file set, plus
// the mountedPair() host re-pinned and re-hinted at it. Every closure fixture
// differs only in those two, so the wiring is written once. The manifest is written
// verbatim, for the fixtures whose point is bytes an object cannot express.
func customSibling(t *testing.T, manifestText string, files map[string]string) (host, sibling, pin string) {
	t.Helper()
	host, _, oldPin := mountedPair(t)
	sibling = filepath.Join(filepath.Dir(host), "custom-sibling")
	if err := os.MkdirAll(sibling, 0o755); err != nil {
		t.Fatalf("mkdir sibling: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sibling, "leji.json"), []byte(manifestText), 0o644); err != nil {
		t.Fatalf("write sibling manifest: %v", err)
	}
	for rel, body := range files {
		abs := filepath.Join(sibling, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", rel, err)
		}
		if err := os.WriteFile(abs, []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}
	git(t, sibling, "init", "-q", "-b", "main")
	git(t, sibling, "add", "-A")
	git(t, sibling, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "seed")
	pin = git(t, sibling, "rev-parse", "HEAD")
	setPin(t, host, oldPin, pin)
	hint := `{"mounts":{"acme-product-context":{"repo":"../custom-sibling"}}}` + "\n"
	if err := os.WriteFile(filepath.Join(host, ".leji", "mounts.local.json"), []byte(hint), 0o644); err != nil {
		t.Fatalf("write hint: %v", err)
	}
	return host, sibling, pin
}

// hydrateOne hydrates the single declared mount and returns its outcome plus the
// projection directory the cache key resolves to.
func hydrateOne(t *testing.T, host, pin string) (mounts.HydrateOutcome, string) {
	t.Helper()
	m := loadHost(t, host)
	r, err := mounts.HydrateMounts(host, m, mounts.HydrateOptions{})
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	if len(r.Outcomes) != 1 {
		t.Fatalf("outcomes = %+v", r.Outcomes)
	}
	identity, _ := mounts.NormalizeSource("https://github.com/acme/product-context")
	projection := filepath.Join(host, ".leji", "mounts", "cache", mounts.CacheKeyFor(identity, pin), "projection")
	return r.Outcomes[0], projection
}

func dirNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read %s: %v", dir, err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	return names
}

// gitRaw is raw-bytes git: stdin and stdout stay byte slices. A path with no UTF-8
// form cannot reach git through argv and cannot be written to an APFS filesystem at
// all, so it is built straight into a tree object instead.
func gitRaw(t *testing.T, cwd string, args []string, input []byte) []byte {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	env := make([]string, 0, len(os.Environ()))
	for _, e := range os.Environ() {
		if !strings.HasPrefix(e, "GIT_DIR=") {
			env = append(env, e)
		}
	}
	cmd.Env = env
	if input != nil {
		cmd.Stdin = bytes.NewReader(input)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, stderr.String())
	}
	return stdout.Bytes()
}

// badPathBytes is a filename with no decoding: 0xFF is not a legal UTF-8 lead byte.
var badPathBytes = []byte{0xff, 0x2e, 0x6d, 0x64}

// pinUndecodablePath re-pins the sibling at a commit whose tree carries a path that
// is not valid UTF-8, placed either beside the projection's selections or inside
// `docs/`. `ls-tree -z` emits exactly the record format `mktree -z` consumes, so the
// existing tree is reused verbatim and only the extra entry is authored here.
func pinUndecodablePath(t *testing.T, host, sibling, oldPin, where string) string {
	t.Helper()
	oid := strings.TrimSpace(string(gitRaw(t, sibling, []string{"hash-object", "-w", "--stdin"}, []byte("# Bad\n"))))
	nul := []byte{0}
	badEntry := bytes.Join([][]byte{[]byte("100644 blob " + oid + "\t"), badPathBytes, nul}, nil)
	mktree := func(input []byte) string {
		return strings.TrimSpace(string(gitRaw(t, sibling, []string{"mktree", "-z"}, input)))
	}
	var rootTree string
	if where == "outside" {
		rootTree = mktree(append(gitRaw(t, sibling, []string{"ls-tree", "-z", "HEAD"}, nil), badEntry...))
	} else {
		docs := mktree(append(gitRaw(t, sibling, []string{"ls-tree", "-z", "HEAD:docs"}, nil), badEntry...))
		lejiJSON := git(t, sibling, "rev-parse", "HEAD:leji.json")
		rootTree = mktree(bytes.Join([][]byte{
			[]byte("100644 blob " + lejiJSON + "\tleji.json"), nul,
			[]byte("040000 tree " + docs + "\tdocs"), nul,
		}, nil))
	}
	pin := git(t, sibling, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit-tree", rootTree, "-m", "bad")
	// Neither test means anything unless the bytes really landed in the tree, and a
	// silently-dropped entry would leave both of them passing.
	listing := gitRaw(t, sibling, []string{"ls-tree", "-r", "-z", "--full-tree", pin}, nil)
	if !bytes.Contains(listing, badPathBytes) {
		t.Fatalf("the pinned tree does not carry the undecodable path")
	}
	setPin(t, host, oldPin, pin)
	return pin
}

// closureManifest is a sibling manifest that validates against the canonical
// schema: the closure schema-checks the pinned manifest, so a fixture about the
// tree walk still has to be a real manifest, not the two fields it happens to read.
const closureManifest = `{
  "leji": "1.0",
  "name": "acme-product-context",
  "rootPath": "docs/",
  "bootProfilePath": "docs/boot-profile.md",
  "owners": { "primary": { "name": "Sibling Owner" } },
  "categories": { "domain": { "indexes": ["docs/index/domain.md"] } }
}
`

// closureIndexFile is the one file closureManifest's category index makes
// closure-critical. Inside `docs/`, so the projected top level is unchanged by it.
const closureIndexFile = "docs/index/domain.md"

// storedIndex is a pinned context index as its schema requires one. A closure
// fixture cares only about which governed path the index names; the required
// id/title/category and the header the schema requires are filled in here.
func storedIndex(governedPath string) string {
	return `{
  "schemaVersion": "1.0",
  "generatedAt": "2026-01-01T00:00:00Z",
  "rootPath": "docs/",
  "entries": [
    {
      "id": "fixture-entry-0",
      "path": "` + governedPath + `",
      "title": "Fixture",
      "category": "domain"
    }
  ]
}
`
}

func TestMountsUndecodablePathOutsideEverySelectionIsSkipped(t *testing.T) {
	// The enumeration is the whole repository, so it sees paths the projection never
	// selects. One of them being undecodable is another repository's business.
	host, sibling, pin := customSibling(t, closureManifest, map[string]string{
		"docs/boot-profile.md": "# Boot\n",
		closureIndexFile:       "# Domain index\n",
	})
	pin = pinUndecodablePath(t, host, sibling, pin, "outside")
	outcome, projection := hydrateOne(t, host, pin)
	if outcome.Status != "hydrated" {
		t.Fatalf("outcome = %+v", outcome)
	}
	if got := strings.Join(dirNames(t, projection), ","); got != "complete,docs,leji.json,metadata.json" {
		t.Fatalf("projection = %s", got)
	}
}

func TestMountsUndecodablePathUnderASelectedPrefixStaysASafetyError(t *testing.T) {
	// Inside the projection there is no skipping it: nothing can be materialized
	// under a name that has no UTF-8 form.
	host, sibling, pin := customSibling(t, closureManifest, map[string]string{
		"docs/boot-profile.md": "# Boot\n",
		closureIndexFile:       "# Domain index\n",
	})
	pin = pinUndecodablePath(t, host, sibling, pin, "inside")
	outcome, _ := hydrateOne(t, host, pin)
	if outcome.Status != "error" || !strings.HasPrefix(outcome.Detail, "non-UTF-8 path in the pinned tree: ") {
		t.Fatalf("outcome = %+v", outcome)
	}
}

func TestMountsGovernedPathWithGlobMetacharactersSelectsItself(t *testing.T) {
	// The closure enumerates the tree and selects by name. Handed to git as a
	// pathspec, `src/a[b].md` is a character class matching `src/ab.md`: the decoy
	// would travel and the real file would be reported missing at the pin.
	host, _, pin := customSibling(t, closureManifest, map[string]string{
		"docs/boot-profile.md":    "# Boot\n",
		closureIndexFile:          "# Domain index\n",
		"docs/context-index.json": storedIndex("src/a[b].md"),
		"src/a[b].md":             "# Literal\n",
		"src/ab.md":               "# Decoy\n",
	})
	outcome, projection := hydrateOne(t, host, pin)
	if outcome.Status != "hydrated" {
		t.Fatalf("outcome = %+v", outcome)
	}
	if _, err := os.Stat(filepath.Join(projection, "src", "a[b].md")); err != nil {
		t.Fatalf("the named file did not travel: %v", err)
	}
	if _, err := os.Stat(filepath.Join(projection, "src", "ab.md")); err == nil {
		t.Fatalf("the decoy travelled")
	}
}

func TestMountsMalformedSiblingShapesAreUnavailableNotErrors(t *testing.T) {
	// A present-but-not-a-string machine field would otherwise read as absent and
	// silently default, and a default is not what the sibling declared.
	cases := []struct {
		what     string
		manifest string
		detail   string
	}{
		{
			what:     "machine.indexPath as a number",
			manifest: `{"leji":"1.0","name":"acme-product-context","rootPath":"docs/","bootProfilePath":"docs/boot-profile.md","machine":{"indexPath":3}}` + "\n",
			detail:   "the pinned leji.json machine.indexPath is not a string",
		},
		{
			what:     "machine.agentProfilesPath as an array",
			manifest: `{"leji":"1.0","name":"acme-product-context","rootPath":"docs/","bootProfilePath":"docs/boot-profile.md","machine":{"agentProfilesPath":["docs/agents/"]}}` + "\n",
			detail:   "the pinned leji.json machine.agentProfilesPath is not a string",
		},
		{
			what:     "a null machine path, which would otherwise default silently",
			manifest: `{"leji":"1.0","name":"acme-product-context","rootPath":"docs/","bootProfilePath":"docs/boot-profile.md","machine":{"changelogPath":null}}` + "\n",
			detail:   "the pinned leji.json machine.changelogPath is not a string",
		},
		{
			what:     "a missing closure-critical boot profile",
			manifest: closureManifest,
			detail:   "closure-critical path missing at the pin: bootProfilePath docs/boot-profile.md",
		},
	}
	for _, c := range cases {
		files := map[string]string{"docs/boot-profile.md": "# Boot\n", closureIndexFile: "# Domain index\n"}
		if strings.HasPrefix(c.detail, "closure-critical") {
			files = map[string]string{"docs/other.md": "# Other\n", closureIndexFile: "# Domain index\n"}
		}
		host, _, pin := customSibling(t, c.manifest, files)
		outcome, _ := hydrateOne(t, host, pin)
		if outcome.Status != "unavailable" || outcome.Detail != c.detail || !outcome.ProjectionFailed {
			t.Fatalf("%s: outcome = %+v", c.what, outcome)
		}
	}
}

// --- The canonical-schema gate, and the portability rules the closure holds ---
//
// Every test below pins a rule the three SDKs have to answer identically, and each
// names the divergence it closes: the fixture on its own does not show it.

// pinWithEntries re-pins the sibling at a commit whose tree carries authored
// entries the working tree cannot hold: a mode/content pair per path, staged
// straight into the index. A case-insensitive filesystem cannot hold two names that
// fold together, and no filesystem holds a zero-byte symlink, so these are built
// rather than written.
func pinWithEntries(t *testing.T, host, sibling, oldPin string, entries []authoredEntry) string {
	t.Helper()
	for _, e := range entries {
		// Content stays bytes end to end: a symlink target's point can be bytes that
		// no string round-trips.
		oid := strings.TrimSpace(string(gitRaw(t, sibling, []string{"hash-object", "-w", "--stdin"}, e.content)))
		git(t, sibling, "update-index", "--add", "--cacheinfo", e.mode+","+oid+","+e.relPath)
	}
	tree := git(t, sibling, "write-tree")
	pin := git(t, sibling, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit-tree", tree, "-m", "authored")
	setPin(t, host, oldPin, pin)
	return pin
}

type authoredEntry struct {
	mode    string
	content []byte
	relPath string
}

// closureFiles is the file set every fixture below starts from.
func closureFiles(extra map[string]string) map[string]string {
	files := map[string]string{"docs/boot-profile.md": "# Boot\n", closureIndexFile: "# Domain index\n"}
	for k, v := range extra {
		files[k] = v
	}
	return files
}

func TestMountsPinnedManifestMissingASchemaRequiredFieldIsUnavailable(t *testing.T) {
	// `categories` is schema-required and the closure never dereferences an absent
	// one, so no shape guard could see this: the ad-hoc checks passed a manifest no
	// `leji validate` would accept, and the projection published it.
	manifest := `{
  "leji": "1.0",
  "name": "acme-product-context",
  "rootPath": "docs/",
  "bootProfilePath": "docs/boot-profile.md",
  "owners": { "primary": { "name": "Sibling Owner" } }
}
`
	host, _, pin := customSibling(t, manifest, map[string]string{"docs/boot-profile.md": "# Boot\n"})
	outcome, _ := hydrateOne(t, host, pin)
	if outcome.Status != "unavailable" || outcome.Detail != "the pinned leji.json does not validate against the manifest schema" {
		t.Fatalf("outcome = %+v", outcome)
	}
}

func TestMountsPinnedIndexFailingItsSchemaIsUnavailable(t *testing.T) {
	// Entries carrying a path and nothing else drove the content closure: `id`,
	// `title` and `category` are schema-required on each entry, and the header the
	// schema requires was not checked at all.
	host, _, pin := customSibling(t, closureManifest, closureFiles(map[string]string{
		"docs/context-index.json": "{\n  \"entries\": [\n    {\n      \"path\": \"docs/domain/overview.md\"\n    }\n  ]\n}\n",
		"docs/domain/overview.md": "# Overview\n",
	}))
	outcome, _ := hydrateOne(t, host, pin)
	if outcome.Status != "unavailable" || outcome.Detail != "the pinned context index does not validate against the index schema" {
		t.Fatalf("outcome = %+v", outcome)
	}
}

func TestMountsPinnedChangelogFailingItsSchemaIsUnavailable(t *testing.T) {
	// A born-empty changelog: valid JSON, invalid against its schema (minItems 1).
	host, _, pin := customSibling(t, closureManifest, closureFiles(map[string]string{
		"docs/context-changelog.json": "{\"schemaVersion\": \"1.0\", \"entries\": []}\n",
	}))
	outcome, _ := hydrateOne(t, host, pin)
	if outcome.Status != "unavailable" || outcome.Detail != "the pinned context changelog does not validate against the changelog schema" {
		t.Fatalf("outcome = %+v", outcome)
	}
}

func TestMountsClosureWalksCategoriesInDocumentOrder(t *testing.T) {
	// Declaration order decides which defect is reached first, and these two carry
	// different classes: sorted traversal reaches `domain` (availability, exit 0),
	// the document reaches `system` (safety, exit 1). This SDK sorted and the other
	// two did not, so one pinned tree exited 0 under two SDKs and 1 under the third.
	manifest := `{
  "leji": "1.0",
  "name": "acme-product-context",
  "rootPath": "docs/",
  "bootProfilePath": "docs/boot-profile.md",
  "owners": { "primary": { "name": "Sibling Owner" } },
  "categories": {
    "system": { "indexes": ["../escape.md"] },
    "domain": { "indexes": ["docs/index/missing.md"] }
  }
}
`
	host, _, pin := customSibling(t, manifest, map[string]string{"docs/boot-profile.md": "# Boot\n"})
	outcome, _ := hydrateOne(t, host, pin)
	if outcome.Status != "error" || outcome.Detail != "uncontained categories.system index: ../escape.md" {
		t.Fatalf("outcome = %+v", outcome)
	}
}

func TestMountsProjectionPathLimitIsMeasuredInUTF8Bytes(t *testing.T) {
	// One constant, one unit. len is UTF-8 bytes here, UTF-16 code units in Node and
	// code points in Python, so a path of astral characters crossed the same declared
	// 4096 limit at three different lengths. A declared path reaches the check without
	// ever being written, which is the only way to test a length no filesystem takes.
	at := func(repeats int) string { return "docs/" + strings.Repeat("\U0001F600", repeats) + ".md" }
	manifestWith := func(boot string) string {
		return `{
  "leji": "1.0",
  "name": "acme-product-context",
  "rootPath": "docs/",
  "bootProfilePath": "` + boot + `",
  "owners": { "primary": { "name": "Sibling Owner" } },
  "categories": { "domain": { "indexes": ["docs/index/domain.md"] } }
}
`
	}
	// 4,008 bytes: inside the limit, so the path is contained and merely absent.
	host, _, pin := customSibling(t, manifestWith(at(1000)), map[string]string{closureIndexFile: "# Domain index\n"})
	outcome, _ := hydrateOne(t, host, pin)
	if outcome.Status != "unavailable" || outcome.Detail != "closure-critical path missing at the pin: bootProfilePath "+at(1000) {
		t.Fatalf("under the limit: outcome = %+v", outcome)
	}
	// 4,408 bytes: over the limit in bytes, and only in bytes.
	host2, _, pin2 := customSibling(t, manifestWith(at(1100)), map[string]string{closureIndexFile: "# Domain index\n"})
	outcome2, _ := hydrateOne(t, host2, pin2)
	if outcome2.Status != "error" || outcome2.Detail != "uncontained bootProfilePath: "+at(1100) {
		t.Fatalf("over the limit: outcome = %+v", outcome2)
	}
}

func TestMountsOrdinaryDirectorySymlinkIsInsideTheProjection(t *testing.T) {
	// `ln -s sub/ link` resolves to `docs/sub/`, which is no projected path and no
	// declared prefix, so the trailing slash alone refused a conforming sibling under
	// the Node and Python ports while this one, whose path.Join Cleans it away,
	// hydrated it. The explicit strip is what makes all three answer the same.
	host, sibling, pin := customSibling(t, closureManifest, closureFiles(map[string]string{"docs/sub/page.md": "# Page\n"}))
	pin = pinWithEntries(t, host, sibling, pin, []authoredEntry{{mode: "120000", content: []byte("sub/"), relPath: "docs/link"}})
	outcome, projection := hydrateOne(t, host, pin)
	if outcome.Status != "hydrated" {
		t.Fatalf("outcome = %+v", outcome)
	}
	target, err := os.Readlink(filepath.Join(projection, "docs", "link"))
	if err != nil || target != "sub/" {
		t.Fatalf("target = %q, err = %v", target, err)
	}
	// The containment guard itself is unchanged: an escaping target carrying the
	// same trailing slash is still refused.
	host2, sibling2, pin2 := customSibling(t, closureManifest, closureFiles(nil))
	pin2 = pinWithEntries(t, host2, sibling2, pin2, []authoredEntry{{mode: "120000", content: []byte("../../etc/"), relPath: "docs/link"}})
	bad, _ := hydrateOne(t, host2, pin2)
	if bad.Status != "error" || bad.Detail != "symlink docs/link escapes the projection" {
		t.Fatalf("escaping outcome = %+v", bad)
	}
}

func TestMountsEmptyOrUndecodableSymlinkTargetIsRefused(t *testing.T) {
	cases := []struct {
		content []byte
		detail  string
	}{
		// Zero bytes: no `ln -s` produces it, the system call that would materialize
		// it fails, and resolving it read as the containing directory in Python and as
		// the entry itself in Node and Go.
		{content: []byte{}, detail: "symlink target is empty in docs/link"},
		// Not valid UTF-8: Node and Python substituted U+FFFD and wrote different
		// bytes than this SDK, under the same cache key.
		{content: []byte("sub/\xff"), detail: "symlink target is not valid UTF-8 in docs/link"},
	}
	for _, c := range cases {
		host, sibling, pin := customSibling(t, closureManifest, closureFiles(map[string]string{"docs/sub/page.md": "# Page\n"}))
		pin = pinWithEntries(t, host, sibling, pin, []authoredEntry{{mode: "120000", content: c.content, relPath: "docs/link"}})
		outcome, _ := hydrateOne(t, host, pin)
		if outcome.Status != "error" || outcome.Detail != c.detail {
			t.Fatalf("%q: outcome = %+v", c.content, outcome)
		}
	}
}

func TestMountsCaseCollisionFoldsASCIIOnly(t *testing.T) {
	build := func(names []string) mounts.HydrateOutcome {
		host, sibling, pin := customSibling(t, closureManifest, closureFiles(nil))
		entries := make([]authoredEntry, 0, len(names))
		for _, n := range names {
			entries = append(entries, authoredEntry{mode: "100644", content: []byte("# " + n + "\n"), relPath: n})
		}
		pin = pinWithEntries(t, host, sibling, pin, entries)
		outcome, _ := hydrateOne(t, host, pin)
		return outcome
	}
	// ASCII still collides: this is what the guard is for.
	ascii := build([]string{"docs/Page.md", "docs/page.md"})
	if ascii.Status != "error" || !strings.HasPrefix(ascii.Detail, "case collision in the pinned tree: docs/") {
		t.Fatalf("ascii outcome = %+v", ascii)
	}
	// Non-ASCII does not, in any SDK. The cost is real and deliberate: a
	// case-insensitive filesystem may still fold these together. A shared Unicode
	// table was rejected because table versions differ across runtimes, and three
	// runtime-specific lowercase mappings are not a contract at all.
	if got := build([]string{"docs/Ä.md", "docs/ä.md"}); got.Status != "hydrated" {
		t.Fatalf("non-ascii outcome = %+v", got)
	}
}
