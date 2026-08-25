// Mirrors packages/sdk/test/mounts.test.ts.
package mounts_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/conformance"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/validate"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
	"github.com/leji-org/leji/packages/sdk-go/internal/mounts"
)

func repoRoot(t *testing.T) string {
	t.Helper()
	wd, _ := os.Getwd()
	return filepath.Join(wd, "..", "..", "..", "..")
}

// git runs git in cwd with GIT_DIR cleared (the tests may run inside a repo).
func git(t *testing.T, cwd string, args ...string) string {
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
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func copyDir(t *testing.T, src, dst string) {
	t.Helper()
	if err := os.MkdirAll(dst, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dst, err)
	}
	if err := os.CopyFS(dst, os.DirFS(src)); err != nil {
		t.Fatalf("copy %s -> %s: %v", src, dst, err)
	}
}

// setPin swaps the mount pin in the host manifest by raw-text replacement
// (never a parse -> mutate -> serialize round-trip, which would reorder keys).
func setPin(t *testing.T, host, from, to string) {
	t.Helper()
	mp := filepath.Join(host, "leji.json")
	raw, err := os.ReadFile(mp)
	if err != nil {
		t.Fatalf("read %s: %v", mp, err)
	}
	if !strings.Contains(string(raw), from) {
		t.Fatalf("pin %s not found in %s", from, mp)
	}
	next := strings.Replace(string(raw), from, to, 1)
	if err := os.WriteFile(mp, []byte(next), 0o644); err != nil {
		t.Fatalf("write %s: %v", mp, err)
	}
}

const fixturePin = "7d3f2a19c4e8b6a0d5f1c2e9b8a7f6d5c4b3a2e1"

// acmeSource is the mount locator the multi-repo example host declares.
const acmeSource = "https://github.com/acme/product-context"

// mountedPair builds a committed sibling repo (from the multi-repo example)
// plus a host with a pinned mount and a machine-local hint pointing at the
// sibling checkout. The example host manifest already declares
// trackingRef refs/heads/main.
func mountedPair(t *testing.T) (host, sibling, pin string) {
	t.Helper()
	dir := t.TempDir()
	sibling = filepath.Join(dir, "sibling")
	host = filepath.Join(dir, "host")
	copyDir(t, filepath.Join(repoRoot(t), "examples", "multi-repo", "product-context"), sibling)
	git(t, sibling, "init", "-q", "-b", "main")
	git(t, sibling, "add", "-A")
	git(t, sibling, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "seed")
	pin = git(t, sibling, "rev-parse", "HEAD")
	copyDir(t, filepath.Join(repoRoot(t), "examples", "multi-repo", "core-context"), host)
	setPin(t, host, fixturePin, pin)
	if err := os.MkdirAll(filepath.Join(host, ".leji"), 0o755); err != nil {
		t.Fatalf("mkdir .leji: %v", err)
	}
	hint := `{"mounts":{"acme-product-context":{"repo":"../sibling"}}}` + "\n"
	if err := os.WriteFile(filepath.Join(host, ".leji", "mounts.local.json"), []byte(hint), 0o644); err != nil {
		t.Fatalf("write hint: %v", err)
	}
	return host, sibling, pin
}

func loadHost(t *testing.T, host string) *manifest.Manifest {
	t.Helper()
	load := manifest.LoadManifest(host)
	if load.Manifest == nil {
		t.Fatalf("host manifest failed to load: %v", load.Findings)
	}
	return load.Manifest
}

func firstMount(t *testing.T, m *manifest.Manifest) mounts.MountDecl {
	t.Helper()
	if m.Federation == nil || len(m.Federation.Mounts) == 0 {
		t.Fatalf("host declares no mounts")
	}
	mt := m.Federation.Mounts[0]
	return mounts.MountDecl{Name: mt.Name, Source: mt.Source, Pin: mt.Pin, TrackingRef: mt.TrackingRef}
}

func TestMountsSourceNormalizationIsCanonicalAndCredentialFree(t *testing.T) {
	cases := []struct {
		raw  string
		want string
		ok   bool
	}{
		{"https://GitHub.com/Acme/Repo.git/", "https://github.com/Acme/Repo", true},
		{"https://github.com/acme/repo.git", "https://github.com/acme/repo", true},
		{"git@github.com:acme/repo.git", "ssh://git@github.com/acme/repo", true},
		{"https://user:token@github.com/acme/repo", "https://github.com/acme/repo", true},
		{"ssh://git@github.com/acme/repo/", "ssh://git@github.com/acme/repo", true},
		{"/Users/someone/local/checkout", "", false},
		{"file:///x/y", "", false},
		{"", "", false},
	}
	for _, c := range cases {
		got, ok := mounts.NormalizeSource(c.raw)
		if ok != c.ok || got != c.want {
			t.Fatalf("NormalizeSource(%q) = %q, %v; want %q, %v", c.raw, got, ok, c.want, c.ok)
		}
	}
}

func TestMountsHydrateViaHintMaterializesVerifiedProjectionAndClearsWarning(t *testing.T) {
	host, _, pin := mountedPair(t)
	m := loadHost(t, host)
	r, err := mounts.HydrateMounts(host, m, mounts.HydrateOptions{})
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	if r.Fatal != "" {
		t.Fatalf("unexpected fatal: %s", r.Fatal)
	}
	if len(r.Outcomes) != 1 || r.Outcomes[0].Name != "acme-product-context" || r.Outcomes[0].Status != "hydrated" {
		t.Fatalf("outcomes = %+v", r.Outcomes)
	}
	// The entry is published at the key derived from source and pin, and nothing
	// records that mapping: the declaration is the only thing that knows it.
	identity, ok := mounts.NormalizeSource("https://github.com/acme/product-context")
	if !ok {
		t.Fatalf("identity failed to normalize")
	}
	entry := filepath.Join(host, ".leji", "mounts", "cache", mounts.CacheKeyFor(identity, pin), "projection")
	if _, err := os.Stat(filepath.Join(entry, "complete")); err != nil {
		t.Fatalf("the published entry carries no marker: %v", err)
	}
	if _, err := os.Stat(filepath.Join(host, ".leji", "mounts", "state.json")); !os.IsNotExist(err) {
		t.Fatalf("a state file was written")
	}
	// locate reports present + verified with the projection path.
	loc, err := mounts.LocateMount(host, m, "acme-product-context")
	if err != nil {
		t.Fatalf("locate: %v", err)
	}
	if !loc.Present || !loc.Verified {
		t.Fatalf("locate = %+v", loc)
	}
	if loc.Path == nil {
		t.Fatalf("locate path is nil")
	}
	if _, err := os.Stat(filepath.Join(*loc.Path, "leji.json")); err != nil {
		t.Fatalf("projection missing leji.json: %v", err)
	}
	// The sibling's own layer content is inside; nothing else of the repo is.
	if _, err := os.Stat(filepath.Join(*loc.Path, "boot-profile.md")); err != nil {
		t.Fatalf("projection missing boot-profile.md: %v", err)
	}
	// validate no longer reports mount-unavailable.
	v := validateLayer(t, host, false)
	for _, f := range v.Findings {
		if f.Rule == "mount-unavailable" {
			t.Fatalf("validate still reports mount-unavailable: %+v", f)
		}
	}
	// A second hydrate is a cache hit.
	again, err := mounts.HydrateMounts(host, m, mounts.HydrateOptions{})
	if err != nil {
		t.Fatalf("second hydrate: %v", err)
	}
	if len(again.Outcomes) != 1 || again.Outcomes[0].Status != "cached" {
		t.Fatalf("second outcomes = %+v", again.Outcomes)
	}
}

func TestMountsStatusReportsUpToDateThenBehindWithCounts(t *testing.T) {
	host, sibling, _ := mountedPair(t)
	m := loadHost(t, host)
	if _, err := mounts.HydrateMounts(host, m, mounts.HydrateOptions{}); err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	rows, err := mounts.MountStatus(host, m, mounts.StatusOptions{})
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if rows[0].PinReport.State != "up-to-date" {
		t.Fatalf("state = %s", rows[0].PinReport.State)
	}
	if rows[0].PinReport.ComparedRef == nil || *rows[0].PinReport.ComparedRef != "refs/heads/main" {
		t.Fatalf("comparedRef = %v", rows[0].PinReport.ComparedRef)
	}
	if !rows[0].PinReport.AncestryComplete {
		t.Fatalf("ancestryComplete = false")
	}
	// The sibling moves on; the pin is now behind its witness.
	if err := os.WriteFile(filepath.Join(sibling, "new-doc.md"), []byte("# New\n"), 0o644); err != nil {
		t.Fatalf("write new-doc: %v", err)
	}
	git(t, sibling, "add", "-A")
	git(t, sibling, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "later")
	rows, err = mounts.MountStatus(host, m, mounts.StatusOptions{})
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if rows[0].PinReport.State != "behind" {
		t.Fatalf("state = %s", rows[0].PinReport.State)
	}
	if rows[0].PinReport.Behind == nil || *rows[0].PinReport.Behind != 1 {
		t.Fatalf("behind = %v", rows[0].PinReport.Behind)
	}
	if !rows[0].Present {
		t.Fatalf("present = false")
	}
}

func TestMountsStatusIsUnknownWithoutStoreAndWitness(t *testing.T) {
	host, _, _ := mountedPair(t)
	m := loadHost(t, host)
	// Remove the hint: no store, no submodule -> unknown, never a guess.
	if err := os.Remove(filepath.Join(host, ".leji", "mounts.local.json")); err != nil {
		t.Fatalf("remove hint: %v", err)
	}
	rows, err := mounts.MountStatus(host, m, mounts.StatusOptions{})
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if rows[0].PinReport.State != "unknown" {
		t.Fatalf("state = %s", rows[0].PinReport.State)
	}
	if rows[0].Present {
		t.Fatalf("present = true")
	}
}

func TestMountsCheckIntegrityDetectsTamperAndNilWhenUnverifiable(t *testing.T) {
	host, _, _ := mountedPair(t)
	m := loadHost(t, host)
	if _, err := mounts.HydrateMounts(host, m, mounts.HydrateOptions{}); err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	loc, err := mounts.LocateMount(host, m, "acme-product-context")
	if err != nil {
		t.Fatalf("locate: %v", err)
	}
	if loc.Path == nil {
		t.Fatalf("locate path is nil")
	}
	fd, err := os.OpenFile(filepath.Join(*loc.Path, "boot-profile.md"), os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("open projection file: %v", err)
	}
	if _, err := fd.WriteString("tampered\n"); err != nil {
		t.Fatalf("tamper: %v", err)
	}
	fd.Close()
	rows, err := mounts.MountStatus(host, m, mounts.StatusOptions{CheckIntegrity: true})
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if rows[0].Verified == nil || *rows[0].Verified {
		t.Fatalf("verified = %v", rows[0].Verified)
	}
	// With the object store gone, verification is unverifiable (nil), not a pass.
	if err := os.Remove(filepath.Join(host, ".leji", "mounts.local.json")); err != nil {
		t.Fatalf("remove hint: %v", err)
	}
	v, err := mounts.VerifyProjection(host, firstMount(t, m))
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if v != nil {
		t.Fatalf("verify = %v, want nil", *v)
	}
}

func TestMountsHydrateRefusesWhileCacheFilesAreGitTracked(t *testing.T) {
	host, _, _ := mountedPair(t)
	git(t, host, "init", "-q")
	if err := os.MkdirAll(filepath.Join(host, ".leji", "mounts"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(host, ".leji", "mounts", "poison.txt"), []byte("x\n"), 0o644); err != nil {
		t.Fatalf("write poison: %v", err)
	}
	git(t, host, "add", "-f", ".leji/mounts/poison.txt")
	m := loadHost(t, host)
	r, err := mounts.HydrateMounts(host, m, mounts.HydrateOptions{})
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	if r.Fatal == "" || !strings.Contains(r.Fatal, "never committed") {
		t.Fatalf("fatal = %q", r.Fatal)
	}
	if len(r.Outcomes) != 0 {
		t.Fatalf("outcomes = %+v", r.Outcomes)
	}
}

func TestMountsEscapingSymlinkFailsHydrationAsError(t *testing.T) {
	host, sibling, pin := mountedPair(t)
	// Add an escaping symlink inside the sibling's rootPath and re-pin to it.
	if err := os.Symlink("../../outside.md", filepath.Join(sibling, "context", "escape.md")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	git(t, sibling, "add", "-A")
	git(t, sibling, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "escape")
	newPin := git(t, sibling, "rev-parse", "HEAD")
	setPin(t, host, pin, newPin)
	m := loadHost(t, host)
	r, err := mounts.HydrateMounts(host, m, mounts.HydrateOptions{})
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	if len(r.Outcomes) == 0 || r.Outcomes[0].Status != "error" {
		t.Fatalf("outcomes = %+v", r.Outcomes)
	}
	if !strings.Contains(r.Outcomes[0].Detail, "escapes the projection") {
		t.Fatalf("detail = %q", r.Outcomes[0].Detail)
	}
	// Nothing landed in the cache.
	loc, err := mounts.LocateMount(host, m, "acme-product-context")
	if err != nil {
		t.Fatalf("locate: %v", err)
	}
	if loc.Present {
		t.Fatalf("projection present after failed hydrate")
	}
}

func TestMountsHydrateFetchPullsPinIntoManagedStore(t *testing.T) {
	host, sibling, pin := mountedPair(t)
	// Point source at the sibling as a file-less URL is invalid by design; use the
	// hint-free path with a fetchable local bare mirror served via its path as the
	// fetch remote. normalizeSource rejects local paths for identity, so the
	// declared https source stays the identity while git fetches from it only in
	// real deployments. Here we emulate by seeding the store from the hint first.
	if err := os.Remove(filepath.Join(host, ".leji", "mounts.local.json")); err != nil {
		t.Fatalf("remove hint: %v", err)
	}
	identity, ok := mounts.NormalizeSource("https://github.com/acme/product-context")
	if !ok {
		t.Fatalf("identity failed to normalize")
	}
	m := loadHost(t, host)
	// Unavailable offline with no hint/store/submodule…
	r, err := mounts.HydrateMounts(host, m, mounts.HydrateOptions{})
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	if len(r.Outcomes) == 0 || r.Outcomes[0].Status != "unavailable" {
		t.Fatalf("outcomes = %+v", r.Outcomes)
	}
	// …but once the store holds the objects (as a --fetch would leave it), hydrate succeeds.
	storeDir := filepath.Join(host, ".leji", "mounts", "store")
	if err := os.MkdirAll(storeDir, 0o755); err != nil {
		t.Fatalf("mkdir store: %v", err)
	}
	sum := sha256.Sum256([]byte(identity))
	key := hex.EncodeToString(sum[:])
	git(t, host, "clone", "-q", "--bare", sibling, filepath.Join(storeDir, key))
	r, err = mounts.HydrateMounts(host, m, mounts.HydrateOptions{})
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	if len(r.Outcomes) == 0 || r.Outcomes[0].Status != "hydrated" {
		t.Fatalf("outcomes = %+v", r.Outcomes)
	}
	if r.Outcomes[0].ObjectSource != "store" {
		t.Fatalf("objectSource = %q", r.Outcomes[0].ObjectSource)
	}
	loc, err := mounts.LocateMount(host, m, "acme-product-context")
	if err != nil {
		t.Fatalf("locate: %v", err)
	}
	if loc.Pin == nil || *loc.Pin != pin {
		t.Fatalf("locate pin = %v, want %s", loc.Pin, pin)
	}
}

// TestMountsFetchRetainsThePinAndWritesNoFetchHead mirrors the TS reference's
// `mounts: --fetch retains the pin by a resolver-owned ref, and writes no
// FETCH_HEAD at all`.
func TestMountsFetchRetainsThePinAndWritesNoFetchHead(t *testing.T) {
	host, sibling, pin := mountedPair(t)
	// Fetching a commit by id is how the resolver retains a pin, so the sibling must
	// serve one the way a real host does.
	git(t, sibling, "config", "uploadpack.allowAnySHA1InWant", "true")
	identity, ok := mounts.NormalizeSource(acmeSource)
	if !ok {
		t.Fatal("identity failed to normalize")
	}
	m := loadHost(t, host)
	// main moves past the pin, so neither fetch may leave the version of record to
	// FETCH_HEAD: only a ref of our own retains it.
	if err := os.WriteFile(filepath.Join(sibling, "b.md"), []byte("# b\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, sibling, "add", "-A")
	git(t, sibling, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "later")
	hydrate := func() {
		t.Helper()
		withSourceRewrite(t, sibling, func() mounts.ReachabilityResult {
			if _, err := mounts.HydrateMounts(host, m, mounts.HydrateOptions{Fetch: true}); err != nil {
				t.Fatalf("hydrate: %v", err)
			}
			return mounts.ReachabilityResult{}
		})
	}
	hydrate()
	sum := sha256.Sum256([]byte(identity))
	store := filepath.Join(host, ".leji", "mounts", "store", hex.EncodeToString(sum[:]))
	if got := git(t, store, "rev-parse", mounts.PinRefFor(identity, pin)); got != pin {
		t.Fatalf("the pin ref retains the version of record: got %s want %s", got, pin)
	}
	// Both fetches pass --no-write-fetch-head, so the managed store carries no
	// per-run record of where the objects came from.
	if _, err := os.Stat(filepath.Join(store, "FETCH_HEAD")); !os.IsNotExist(err) {
		t.Fatal("no FETCH_HEAD in the managed store")
	}
	// And a second --fetch, which refreshes the witness over an existing store, does
	// not create one either.
	if err := os.WriteFile(filepath.Join(sibling, "c.md"), []byte("# c\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, sibling, "add", "-A")
	git(t, sibling, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "later2")
	hydrate()
	if _, err := os.Stat(filepath.Join(store, "FETCH_HEAD")); !os.IsNotExist(err) {
		t.Fatal("still none after a witness refresh")
	}
}

// withSourceRewrite routes git's network protocols at the declared source URL to
// a local repo, so the "networked" reachability probe runs hermetically (env
// flows into RunGit).
func withSourceRewrite(t *testing.T, sibling string, fn func() mounts.ReachabilityResult) mounts.ReachabilityResult {
	t.Helper()
	keys := []string{"GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"}
	prev := map[string]*string{}
	for _, k := range keys {
		if v, ok := os.LookupEnv(k); ok {
			vv := v
			prev[k] = &vv
		} else {
			prev[k] = nil
		}
	}
	os.Setenv("GIT_CONFIG_COUNT", "1")
	os.Setenv("GIT_CONFIG_KEY_0", "url."+sibling+".insteadOf")
	os.Setenv("GIT_CONFIG_VALUE_0", "https://github.com/acme/product-context")
	defer func() {
		for _, k := range keys {
			if prev[k] == nil {
				os.Unsetenv(k)
			} else {
				os.Setenv(k, *prev[k])
			}
		}
	}()
	return fn()
}

// witnessTransactionHook installs a `reference-transaction` hook in the managed
// store, firing only on the canonical witness ref. "abort" fails the swap the way
// a lock, a permission error or a full disk does. "publish" writes oid into the ref
// and then fails, which is the state a run finds when another writer published
// between its read of <oldvalue> and its own swap; the interleaving itself is not
// reachable in a single process, so the fixture reproduces what it leaves behind.
func witnessTransactionHook(t *testing.T, store, witnessRef, mode, oid string) {
	t.Helper()
	hooks := filepath.Join(store, "hooks")
	if err := os.MkdirAll(hooks, 0o755); err != nil {
		t.Fatal(err)
	}
	publish := ""
	if mode == "publish" {
		publish = fmt.Sprintf("mkdir -p \"$(dirname \"%s/%s\")\"\nprintf '%%s\\n' '%s' > \"%s/%s\"\n",
			store, witnessRef, oid, store, witnessRef)
	}
	// Each stdin line is "<old> <new> <ref>"; every other ref (the fetched temporary,
	// the pin ref) passes through untouched.
	script := fmt.Sprintf("#!/bin/sh\n[ \"$1\" = prepared ] || exit 0\ngrep -q \" %s$\" || exit 0\n%sexit 1\n",
		witnessRef, publish)
	if err := os.WriteFile(filepath.Join(hooks, "reference-transaction"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

// TestMountsLostCompareAndSwapIsAConfirmedMismatch mirrors the TS reference's
// reference-transaction test. It is also the only reachable path to the witness
// act's SECOND frozen failure class: a tracking ref that arrived and a canonical
// ref that would not take it, whose reason travels into `Reasons` and from there
// into the finding's `detail`.
func TestMountsLostCompareAndSwapIsAConfirmedMismatch(t *testing.T) {
	host, sibling, pin := mountedPair(t)
	git(t, sibling, "config", "uploadpack.allowAnySHA1InWant", "true")
	m := loadHost(t, host)
	identity, ok := mounts.NormalizeSource(acmeSource)
	if !ok {
		t.Fatal("identity failed to normalize")
	}
	sum := sha256.Sum256([]byte(identity))
	store := filepath.Join(host, ".leji", "mounts", "store", hex.EncodeToString(sum[:]))
	witnessRef := mounts.WitnessRefFor(identity, "refs/heads/main")
	// The witness ref does not exist yet, so this run swaps against "must not exist",
	// and finds another writer's commit there instead. That is a race it lost, not
	// a failure: the published witness stands and nothing is reported.
	if err := os.MkdirAll(store, 0o755); err != nil {
		t.Fatal(err)
	}
	git(t, host, "init", "--bare", "-q", store)
	witnessTransactionHook(t, store, witnessRef, "publish", pin)
	var r mounts.HydrateResult
	hydrate := func() {
		t.Helper()
		withSourceRewrite(t, sibling, func() mounts.ReachabilityResult {
			var err error
			if r, err = mounts.HydrateMounts(host, m, mounts.HydrateOptions{Fetch: true}); err != nil {
				t.Fatalf("hydrate: %v", err)
			}
			return mounts.ReachabilityResult{}
		})
	}
	hydrate()
	if r.Outcomes[0].WitnessRefreshFailed {
		t.Fatal("another writer publishing is a valid outcome")
	}
	if got := git(t, store, "rev-parse", witnessRef); got != pin {
		t.Fatalf("the other writer's witness stands, got %s", got)
	}
	if reason, carried := r.Reasons["acme-product-context"]; carried {
		t.Fatalf("a valid outcome names no failed act, got %q", reason)
	}
	// The same failed swap, with the ref holding exactly what this run expected: no
	// one published, so this is the disk, the permissions or a lock, and it may not
	// pass as a refresh that happened.
	witnessTransactionHook(t, store, witnessRef, "abort", "")
	hydrate()
	if r.Outcomes[0].StoreFetched == nil || !*r.Outcomes[0].StoreFetched {
		t.Fatal("the store was established; only the swap failed")
	}
	if !r.Outcomes[0].WitnessRefreshFailed {
		t.Fatal("an operational failure never reads as success")
	}
	if got := git(t, store, "rev-parse", witnessRef); got != pin {
		t.Fatalf("the previous witness stays in place, got %s", got)
	}
	// The witness act's second failure class, which is not the first one: a ref that
	// arrived and would not publish, never a ref that never arrived.
	if got := r.Reasons["acme-product-context"]; got != "the witness ref could not be published" {
		t.Fatalf("reason = %q", got)
	}
}

func TestMountsPinReachabilityReachableUnreachableOffHistoryUnknownOffline(t *testing.T) {
	host, sibling, pin := mountedPair(t)
	mount := mounts.MountDecl{
		Name:        "acme-product-context",
		Source:      "https://github.com/acme/product-context",
		Pin:         pin,
		TrackingRef: "refs/heads/main",
	}
	probe := func(m mounts.MountDecl) func() mounts.ReachabilityResult {
		return func() mounts.ReachabilityResult {
			r, err := mounts.CheckPinReachability(host, m)
			if err != nil {
				t.Fatalf("reachability: %v", err)
			}
			return r
		}
	}
	// Offline (no rewrite): the fake source is unreachable -> unknown, never a guess.
	offline := probe(mount)()
	if offline.State != "unknown" {
		t.Fatalf("offline state = %q", offline.State)
	}
	// With the source reachable: the pin is the witness tip -> reachable.
	on := withSourceRewrite(t, sibling, probe(mount))
	if on.State != "reachable" {
		t.Fatalf("state = %q (detail %q)", on.State, on.Detail)
	}
	if on.WitnessRef == nil || *on.WitnessRef != "refs/heads/main" {
		t.Fatalf("witnessRef = %v", on.WitnessRef)
	}
	// A commit on an unadvertised side branch is not reachable from the witness.
	git(t, sibling, "checkout", "-q", "-b", "side")
	if err := os.WriteFile(filepath.Join(sibling, "side.md"), []byte("# side\n"), 0o644); err != nil {
		t.Fatalf("write side.md: %v", err)
	}
	git(t, sibling, "add", "-A")
	git(t, sibling, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "side")
	sidePin := git(t, sibling, "rev-parse", "HEAD")
	git(t, sibling, "checkout", "-q", "main")
	sideMount := mount
	sideMount.Pin = sidePin
	off := withSourceRewrite(t, sibling, probe(sideMount))
	if off.State != "unreachable" {
		t.Fatalf("side state = %q", off.State)
	}
	// Absent TrackingRef, the witness resolves from the source's advertised HEAD.
	head := withSourceRewrite(t, sibling, probe(mounts.MountDecl{Name: mount.Name, Source: mount.Source, Pin: pin}))
	if head.State != "reachable" {
		t.Fatalf("head state = %q (detail %q)", head.State, head.Detail)
	}
	if head.WitnessRef == nil || *head.WitnessRef != "refs/heads/main" {
		t.Fatalf("head witnessRef = %v", head.WitnessRef)
	}
}

func TestMountsConformancePinReachableUnknownOfflineNeverAwardsFederated(t *testing.T) {
	host, _, _ := mountedPair(t)
	m := loadHost(t, host)
	if _, err := mounts.HydrateMounts(host, m, mounts.HydrateOptions{}); err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	report, err := conformance.Report(host, false)
	if err != nil {
		t.Fatalf("conformance: %v", err)
	}
	var item *conformance.ChecklistItem
	for i := range report.Items {
		if report.Items[i].ID == "pin-reachable" {
			item = &report.Items[i]
			break
		}
	}
	if item == nil || item.Status != "unknown" {
		t.Fatalf("pin-reachable item = %+v", item)
	}
	if report.VerifiedLevel == "federated" {
		t.Fatalf("verifiedLevel = federated despite unknown evidence")
	}
}

func TestMountsFederationEnforcementFailsUnhydratedOrUnverifiablePassesVerified(t *testing.T) {
	host, _, _ := mountedPair(t)
	m := loadHost(t, host)
	// available: unhydrated -> error.
	fs, err := mounts.FederationEnforcement(host, m, "available", nil)
	if err != nil {
		t.Fatalf("enforcement: %v", err)
	}
	if len(fs) != 1 || !strings.Contains(fs[0].Message, "not hydrated") {
		t.Fatalf("findings = %+v", fs)
	}
	// Hydrated + verifiable via the hint -> clean.
	if _, err := mounts.HydrateMounts(host, m, mounts.HydrateOptions{}); err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	fs, err = mounts.FederationEnforcement(host, m, "available", nil)
	if err != nil {
		t.Fatalf("enforcement: %v", err)
	}
	if len(fs) != 0 {
		t.Fatalf("findings = %+v", fs)
	}
	// required: only task-routed mounts are enforced.
	fs, err = mounts.FederationEnforcement(host, m, "required", map[string]bool{})
	if err != nil {
		t.Fatalf("enforcement: %v", err)
	}
	if len(fs) != 0 {
		t.Fatalf("findings = %+v", fs)
	}
	// With the hint gone the cache is unverifiable, which enforcement rejects.
	if err := os.Remove(filepath.Join(host, ".leji", "mounts.local.json")); err != nil {
		t.Fatalf("remove hint: %v", err)
	}
	fs, err = mounts.FederationEnforcement(host, m, "required", map[string]bool{"acme-product-context": true})
	if err != nil {
		t.Fatalf("enforcement: %v", err)
	}
	if len(fs) != 1 || !strings.Contains(fs[0].Message, "cannot be verified") {
		t.Fatalf("findings = %+v", fs)
	}
}

// The tracking-ref table and the ref-name builders are the port's regex- and
// hash-sensitive surface: a divergence here picks a different witness ref or
// accepts a manifest the reference rejects, which no parity scenario would see.
func TestMountsWitnessRefSchemeAndTrackingRefValidation(t *testing.T) {
	for _, ref := range []string{"refs/heads/main", "refs/tags/v1.2.3", "refs/heads/release/1.x"} {
		if !mounts.ValidTrackingRef(ref) {
			t.Fatalf("ValidTrackingRef(%q) = false; want true", ref)
		}
	}
	bad := []string{
		"main",
		"refs/remotes/origin/main",
		"refs/heads/*",
		"refs/heads/a b",
		"refs/heads/x^{}",
		"refs/heads/a..b",
		"refs/heads/a@{0}",
		"refs/heads//b",
		"refs/heads/b/",
		"refs/heads/b.",
		"refs/heads/.hidden",
		"refs/heads/a/.hidden",
		"refs/heads/b.lock",
		"refs/heads/a.lock/b",
		`refs/heads/a\b`,
		"refs/heads/a\tb",
		"refs/heads/a\x00b",
		"refs/heads/",
	}
	for _, ref := range bad {
		if mounts.ValidTrackingRef(ref) {
			t.Fatalf("ValidTrackingRef(%q) = true; want false", ref)
		}
	}
	identity := "https://github.com/acme/product-context"
	ref := mounts.WitnessRefFor(identity, "refs/heads/main")
	want := "refs/leji-witness/v1/" + mounts.Sha256Hex(identity) + "/" + mounts.Sha256Hex("refs/heads/main")
	if ref != want {
		t.Fatalf("WitnessRefFor = %q; want %q", ref, want)
	}
	if long := mounts.WitnessRefFor(identity, "refs/heads/"+strings.Repeat("x", 2000)); len(long) != len(ref) {
		t.Fatalf("witness ref length %d != %d; both components must be fixed-length hex", len(long), len(ref))
	}
	if ref == mounts.WitnessRefFor(identity, "refs/heads/Main") {
		t.Fatalf("a case fold must not collide two witness refs")
	}
	oid := strings.Repeat("a", 40)
	if got, want := mounts.PinRefFor(identity, oid), "refs/leji-pin/v1/"+mounts.Sha256Hex(identity)+"/"+oid; got != want {
		t.Fatalf("PinRefFor = %q; want %q", got, want)
	}
}

// --- the publication protocol ------------------------------------------------
//
// There is no lock: every producer for a key stages byte-identical content, and
// `rename` alone decides which one publishes.

func TestMountsConcurrentPublishersPublishExactlyOnceAndLeaveNoStaging(t *testing.T) {
	host, _, pin := mountedPair(t)
	m := loadHost(t, host)
	results := make([]mounts.HydrateResult, 4)
	errs := make([]error, 4)
	var wg sync.WaitGroup
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = mounts.HydrateMounts(host, m, mounts.HydrateOptions{})
		}(i)
	}
	wg.Wait()
	hydrated, cached := 0, 0
	for i, r := range results {
		if errs[i] != nil {
			t.Fatalf("hydrate %d: %v", i, errs[i])
		}
		switch r.Outcomes[0].Status {
		case "hydrated":
			hydrated++
		case "cached":
			cached++
		default:
			t.Fatalf("outcome %d = %+v", i, r.Outcomes[0])
		}
	}
	if hydrated != 1 || cached != 3 {
		t.Fatalf("hydrated = %d, cached = %d; exactly one rename wins", hydrated, cached)
	}
	identity, _ := mounts.NormalizeSource("https://github.com/acme/product-context")
	entry := filepath.Join(host, ".leji", "mounts", "cache", mounts.CacheKeyFor(identity, pin))
	if _, err := os.Stat(filepath.Join(entry, "projection", "complete")); err != nil {
		t.Fatalf("the winner published no marker: %v", err)
	}
	names, err := os.ReadDir(entry)
	if err != nil {
		t.Fatalf("read entry: %v", err)
	}
	if len(names) != 1 || names[0].Name() != "projection" {
		t.Fatalf("a staging directory survived: %v", names)
	}
}

func TestMountsPublishingOntoAMarkedEntryIsCachedAndTouchesNothing(t *testing.T) {
	host, _, pin := mountedPair(t)
	m := loadHost(t, host)
	if r, err := mounts.HydrateMounts(host, m, mounts.HydrateOptions{}); err != nil || r.Outcomes[0].Status != "hydrated" {
		t.Fatalf("first hydrate = %+v, %v", r, err)
	}
	identity, _ := mounts.NormalizeSource("https://github.com/acme/product-context")
	projection := filepath.Join(host, ".leji", "mounts", "cache", mounts.CacheKeyFor(identity, pin), "projection")
	// The sidecar carries this run's hydratedAt, so identical bytes prove the
	// published entry was left exactly as the first producer wrote it.
	before, err := os.ReadFile(filepath.Join(projection, "metadata.json"))
	if err != nil {
		t.Fatalf("read sidecar: %v", err)
	}
	again, err := mounts.HydrateMounts(host, m, mounts.HydrateOptions{})
	if err != nil {
		t.Fatalf("second hydrate: %v", err)
	}
	if again.Outcomes[0].Status != "cached" || again.Outcomes[0].ObjectSource != "" {
		t.Fatalf("second outcome = %+v; a cache hit projects nothing", again.Outcomes[0])
	}
	after, err := os.ReadFile(filepath.Join(projection, "metadata.json"))
	if err != nil {
		t.Fatalf("re-read sidecar: %v", err)
	}
	if string(before) != string(after) {
		t.Fatalf("the published entry was rewritten")
	}
}

func TestMountsProjectionWithoutMarkerIsPoisonAndIsNeverRepaired(t *testing.T) {
	host, _, pin := mountedPair(t)
	m := loadHost(t, host)
	identity, _ := mounts.NormalizeSource("https://github.com/acme/product-context")
	entry := filepath.Join(host, ".leji", "mounts", "cache", mounts.CacheKeyFor(identity, pin))
	projection := filepath.Join(entry, "projection")
	if err := os.MkdirAll(projection, 0o755); err != nil {
		t.Fatalf("mkdir projection: %v", err)
	}
	if err := os.WriteFile(filepath.Join(projection, "leji.json"), []byte("half a projection\n"), 0o644); err != nil {
		t.Fatalf("write poison: %v", err)
	}
	const want = "the cache entry is incomplete and is not repaired automatically"
	first, err := mounts.HydrateMounts(host, m, mounts.HydrateOptions{})
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	if first.Outcomes[0].Status != "error" || first.Outcomes[0].Detail != want {
		t.Fatalf("outcome = %+v", first.Outcomes[0])
	}
	// Nothing under the key counts as hydrated, because the marker is what counts.
	loc, err := mounts.LocateMount(host, m, "acme-product-context")
	if err != nil {
		t.Fatalf("locate: %v", err)
	}
	if loc.Present {
		t.Fatalf("poison reads as present")
	}
	// A second run says the same thing rather than deciding, from outside, that no
	// other producer is mid-publish.
	second, err := mounts.HydrateMounts(host, m, mounts.HydrateOptions{})
	if err != nil {
		t.Fatalf("second hydrate: %v", err)
	}
	if second.Outcomes[0] != first.Outcomes[0] {
		t.Fatalf("second outcome = %+v; want %+v", second.Outcomes[0], first.Outcomes[0])
	}
	body, err := os.ReadFile(filepath.Join(projection, "leji.json"))
	if err != nil || string(body) != "half a projection\n" {
		t.Fatalf("the poison was rewritten: %q, %v", body, err)
	}
	names, err := os.ReadDir(entry)
	if err != nil {
		t.Fatalf("read entry: %v", err)
	}
	if len(names) != 1 || names[0].Name() != "projection" {
		t.Fatalf("the refusal left staging behind: %v", names)
	}
}

func TestMountsEmptyRootPathTreeStillPublishesNonEmptyProjection(t *testing.T) {
	host, _, pin := mountedPair(t)
	// A sibling that declares a rootPath holding nothing at the pin: the projection
	// is the manifest and the resolver's own two files, and nothing else.
	empty := filepath.Join(filepath.Dir(host), "empty-sibling")
	if err := os.MkdirAll(empty, 0o755); err != nil {
		t.Fatalf("mkdir sibling: %v", err)
	}
	// Schema-valid, and with its category index outside the rootPath tree too, so
	// "empty" stays this fixture's point.
	body := "{\n  \"leji\": \"1.0\",\n  \"name\": \"acme-product-context\",\n  \"rootPath\": \"docs/\",\n  \"bootProfilePath\": \"boot.md\",\n  \"owners\": { \"primary\": { \"name\": \"Sibling Owner\" } },\n  \"categories\": { \"domain\": { \"indexes\": [\"index/domain.md\"] } }\n}\n"
	if err := os.WriteFile(filepath.Join(empty, "leji.json"), []byte(body), 0o644); err != nil {
		t.Fatalf("write sibling manifest: %v", err)
	}
	// The boot profile sits outside the (empty) rootPath tree: the closure carries
	// it anyway, which is the relocated-entrypoint case the closure rule exists for.
	if err := os.WriteFile(filepath.Join(empty, "boot.md"), []byte("# Boot\n"), 0o644); err != nil {
		t.Fatalf("write sibling boot profile: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(empty, "index"), 0o755); err != nil {
		t.Fatalf("mkdir sibling index dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(empty, "index", "domain.md"), []byte("# Domain index\n"), 0o644); err != nil {
		t.Fatalf("write sibling index file: %v", err)
	}
	git(t, empty, "init", "-q", "-b", "main")
	git(t, empty, "add", "-A")
	git(t, empty, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "seed")
	emptyPin := git(t, empty, "rev-parse", "HEAD")
	setPin(t, host, pin, emptyPin)
	hint := `{"mounts":{"acme-product-context":{"repo":"../empty-sibling"}}}` + "\n"
	if err := os.WriteFile(filepath.Join(host, ".leji", "mounts.local.json"), []byte(hint), 0o644); err != nil {
		t.Fatalf("write hint: %v", err)
	}
	m := loadHost(t, host)
	r, err := mounts.HydrateMounts(host, m, mounts.HydrateOptions{})
	if err != nil || r.Outcomes[0].Status != "hydrated" {
		t.Fatalf("hydrate = %+v, %v", r, err)
	}
	identity, _ := mounts.NormalizeSource("https://github.com/acme/product-context")
	projection := filepath.Join(host, ".leji", "mounts", "cache", mounts.CacheKeyFor(identity, emptyPin), "projection")
	entries, err := os.ReadDir(projection)
	if err != nil {
		t.Fatalf("read projection: %v", err)
	}
	var got []string
	for _, e := range entries {
		got = append(got, e.Name())
	}
	if strings.Join(got, ",") != "boot.md,complete,index,leji.json,metadata.json" {
		t.Fatalf("projection = %v", got)
	}
	// Publishing the marker inside the staged tree is what makes the rename
	// exclusive: POSIX replaces an empty destination directory, and a published
	// entry is never empty.
	decoy := filepath.Join(host, ".leji", "mounts", "decoy")
	if err := os.MkdirAll(decoy, 0o755); err != nil {
		t.Fatalf("mkdir decoy: %v", err)
	}
	if err := os.Rename(decoy, projection); err == nil {
		t.Fatalf("an ordinary rename replaced a published entry")
	}
	again, err := mounts.HydrateMounts(host, m, mounts.HydrateOptions{})
	if err != nil || again.Outcomes[0].Status != "cached" {
		t.Fatalf("second hydrate = %+v, %v", again, err)
	}
}

func TestMountsTwoMatchingSubmodulesAreAmbiguousEvenWithAResolvingCandidate(t *testing.T) {
	// Ambiguity is about the submodules alone: a candidate that resolves the pin
	// does not make two matching submodules unambiguous, because those repositories
	// were never consulted either way. With no candidate resolving the witness ref,
	// `mounts status` must report `mount-source-ambiguous` (what Node reports), not
	// the `mount-witness-unavailable` a candidates-first flag reaches.
	host, sibling, pin := mountedPair(t)
	// The hint repository still holds the pin, but no longer resolves the declared
	// trackingRef: the pin is available, the witness is not.
	git(t, sibling, "branch", "-m", "main", "other")
	modules := ""
	for _, name := range []string{"one", "two"} {
		repo := filepath.Join(host, "vendor", name)
		if err := os.MkdirAll(repo, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", repo, err)
		}
		git(t, host, "init", "-q", "-b", "main", repo)
		modules += "[submodule \"" + name + "\"]\n\tpath = vendor/" + name + "\n\turl = " + acmeSource + "\n"
	}
	if err := os.WriteFile(filepath.Join(host, ".gitmodules"), []byte(modules), 0o644); err != nil {
		t.Fatalf("write .gitmodules: %v", err)
	}
	m := loadHost(t, host)
	identity, ok := mounts.NormalizeSource(acmeSource)
	if !ok {
		t.Fatalf("source did not normalize")
	}
	mount := mounts.MountDecl{Name: "acme-product-context", Source: acmeSource, Pin: pin, TrackingRef: "refs/heads/main"}
	candidates, ambiguous := mounts.ObjectSourceCandidates(host, mount, identity)
	if len(candidates) == 0 {
		t.Fatalf("the hint no longer resolves the pin")
	}
	if !ambiguous {
		t.Fatalf("two matching submodules are ambiguous whatever else resolves")
	}
	rows, err := mounts.MountStatus(host, m, mounts.StatusOptions{})
	if err != nil {
		t.Fatalf("mount status: %v", err)
	}
	if len(rows) != 1 || rows[0].PinReport.State != "unknown" || rows[0].PinReport.Reason != "mount-source-ambiguous" {
		t.Fatalf("pinReport = %+v", rows[0].PinReport)
	}
	// Hydration is unaffected: it takes the first candidate and never reads the flag
	// unless there is none, exactly as the reference does.
	if src := mounts.FindObjectSource(host, mount, identity); src.Kind != "hint" || src.Ambiguous {
		t.Fatalf("findObjectSource = %+v", src)
	}
}

// patchMount rewrites one field on the host's single declared mount and returns
// what ordinary validation then says about the layer.
func patchMount(t *testing.T, key, value string) []findings.Finding {
	t.Helper()
	host, _, _ := mountedPair(t)
	mp := filepath.Join(host, "leji.json")
	raw, err := os.ReadFile(mp)
	if err != nil {
		t.Fatalf("read host manifest: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse host manifest: %v", err)
	}
	mount := doc["federation"].(map[string]any)["mounts"].([]any)[0].(map[string]any)
	mount[key] = value
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		t.Fatalf("encode host manifest: %v", err)
	}
	if err := os.WriteFile(mp, append(out, '\n'), 0o644); err != nil {
		t.Fatalf("write host manifest: %v", err)
	}
	return validateLayer(t, host, false).Findings
}

func hasRule(fs []findings.Finding, rule, severity string) bool {
	for _, f := range fs {
		if f.Rule == rule && (severity == "" || f.Severity == severity) {
			return true
		}
	}
	return false
}

func TestMountsMalformedSourceOrTrackingRefIsAManifestError(t *testing.T) {
	// distribution.md calls a malformed `source` or `pin` a manifest error. Ordinary
	// validation turned an unnormalizable source into `mount-unavailable`, a warning
	// that reads as "not hydrated here"; the schema's tracking-ref pattern accepted
	// anything under refs/heads/ or refs/tags/, including refs the resolver refuses.
	badSource := patchMount(t, "source", "file:///srv/product-context")
	if !hasRule(badSource, "mount-source", "error") {
		t.Fatalf("findings = %+v", badSource)
	}
	// Availability is not reported for a mount whose declaration is already a lie.
	if hasRule(badSource, "mount-unavailable", "") {
		t.Fatalf("availability reported for a lying declaration: %+v", badSource)
	}
	// Schema-legal (refs/heads/ + something), resolver-illegal (`..`, `@{`, `.lock`).
	for _, ref := range []string{"refs/heads/../evil", "refs/heads/main@{1}", "refs/heads/main.lock"} {
		if !hasRule(patchMount(t, "trackingRef", ref), "mount-tracking-ref", "error") {
			t.Fatalf("%s was accepted", ref)
		}
	}
	if hasRule(patchMount(t, "trackingRef", "refs/tags/v1.0.0"), "mount-tracking-ref", "") {
		t.Fatalf("a valid tag ref was rejected")
	}
}

func TestConformanceSiblingMountsTestsTheNormalizedSourceItClaims(t *testing.T) {
	// The item said "a normalized source and a full commit pin" and tested that the
	// source was a nonempty string: a `file://` locator no resolver can normalize
	// passed the federated checklist.
	host, _, _ := mountedPair(t)
	mp := filepath.Join(host, "leji.json")
	raw, _ := os.ReadFile(mp)
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse host manifest: %v", err)
	}
	doc["federation"].(map[string]any)["mounts"].([]any)[0].(map[string]any)["source"] = "file:///srv/product-context"
	out, _ := json.MarshalIndent(doc, "", "  ")
	if err := os.WriteFile(mp, append(out, '\n'), 0o644); err != nil {
		t.Fatalf("write host manifest: %v", err)
	}
	report, err := conformance.Report(host, false)
	if err != nil {
		t.Fatalf("conformance: %v", err)
	}
	for _, item := range report.Items {
		if item.ID != "sibling-mounts" {
			continue
		}
		if item.Status != conformance.Fail ||
			item.Detail != `mount "acme-product-context" declares a source that is not a normalizable locator` {
			t.Fatalf("item = %+v", item)
		}
		return
	}
	t.Fatalf("no sibling-mounts item")
}

func TestConformanceReportsAllFourMountItemsWhenNoneAreDeclared(t *testing.T) {
	// Two of the four used to be dropped, so the checklist read as though pin
	// reachability and routing metadata had simply not been considered. `n/a` is not
	// scored either way, so this changes the report, not the level.
	root := t.TempDir()
	copyDir(t, filepath.Join(repoRoot(t), "fixtures", "valid-minimal-core"), root)
	report, err := conformance.Report(root, false)
	if err != nil {
		t.Fatalf("conformance: %v", err)
	}
	var got []string
	for _, item := range report.Items {
		if item.Level == "federated" {
			got = append(got, item.ID+"="+item.Status)
		}
	}
	want := "consumed-externally=manual,stale-pin-reporting=manual,sibling-mounts=not-applicable," +
		"pin-reachable=not-applicable,mount-routing=not-applicable,mount-discovery=not-applicable"
	if strings.Join(got, ",") != want {
		t.Fatalf("federated items = %v", got)
	}
}

// --- verification is read-only: it may not stage inside the tree it verifies ---

// denyWrites strips write permission from every directory in the tree; returns
// the undo. On POSIX this is a real denial for a non-root user. The Windows
// equivalent is a DENY ACE rather than a mode, which is a named verify-at-build
// obligation for the cross-platform runner, not something these mode bits stand
// in for.
func denyWrites(t *testing.T, dir string) func() {
	t.Helper()
	type saved struct {
		path string
		mode os.FileMode
	}
	var dirs []saved
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		dirs = append(dirs, saved{p, info.Mode().Perm()})
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", dir, err)
	}
	for _, s := range dirs {
		if err := os.Chmod(s.path, 0o555); err != nil {
			t.Fatalf("chmod %s: %v", s.path, err)
		}
	}
	return func() {
		for _, s := range dirs {
			os.Chmod(s.path, s.mode)
		}
	}
}

// writeDenied asserts the denial rather than assuming it: a mode that a
// root-owned or ACL-governed run ignores would make every "did not write"
// assertion below vacuous.
func writeDenied(dir string) bool {
	probe := filepath.Join(dir, ".write-probe")
	if err := os.WriteFile(probe, []byte("x"), 0o644); err != nil {
		return true
	}
	os.Remove(probe)
	return false
}

// treeSnapshot records paths, types, modes, symlink targets, content and
// directory mtimes: the whole of what "the tree is byte-for-byte what it was"
// has to mean here. Content alone would miss a staging directory created and
// removed between the two reads — its parent's mtime is the only trace that
// survives.
func treeSnapshot(t *testing.T, dir, prefix string) []string {
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
	var out []string
	for _, name := range names {
		abs := filepath.Join(dir, name)
		rel := name
		if prefix != "" {
			rel = prefix + "/" + name
		}
		st, err := os.Lstat(abs)
		if err != nil {
			t.Fatalf("lstat %s: %v", abs, err)
		}
		mode := fmt.Sprintf("%o", st.Mode().Perm())
		switch {
		case st.Mode()&os.ModeSymlink != 0:
			target, err := os.Readlink(abs)
			if err != nil {
				t.Fatalf("readlink %s: %v", abs, err)
			}
			out = append(out, fmt.Sprintf("L %s %s %s", rel, mode, target))
		case st.IsDir():
			out = append(out, fmt.Sprintf("D %s %s %d", rel, mode, st.ModTime().UnixNano()))
			out = append(out, treeSnapshot(t, abs, rel)...)
		default:
			data, err := os.ReadFile(abs)
			if err != nil {
				t.Fatalf("read %s: %v", abs, err)
			}
			sum := sha256.Sum256(data)
			out = append(out, fmt.Sprintf("F %s %s %d %s", rel, mode, st.Size(), hex.EncodeToString(sum[:])))
		}
	}
	return out
}

// verifyResidue lists staging directories left behind in the OS temp dir.
// Compared as a delta, since the suite's other tests run against the same temp
// dir.
func verifyResidue(t *testing.T) map[string]bool {
	t.Helper()
	entries, err := os.ReadDir(os.TempDir())
	if err != nil {
		t.Fatalf("read temp dir: %v", err)
	}
	out := map[string]bool{}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "leji-verify-") {
			out[e.Name()] = true
		}
	}
	return out
}

func newVerifyResidue(t *testing.T, before map[string]bool) []string {
	t.Helper()
	var out []string
	for name := range verifyResidue(t) {
		if !before[name] {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

func TestMountsCheckIntegrityVerifiesAWriteDeniedHostTreeTwiceWithoutTouchingIt(t *testing.T) {
	// `mounts status --check-integrity` staged its comparison tree inside the
	// host's own .leji/mounts/, so the read-only diagnostic wrote into the tree it
	// was diagnosing — and could not run at all where that tree is not writable.
	host, _, _ := mountedPair(t)
	m := loadHost(t, host)
	if _, err := mounts.HydrateMounts(host, m, mounts.HydrateOptions{}); err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	restore := denyWrites(t, host)
	defer restore()
	if !writeDenied(filepath.Join(host, ".leji", "mounts")) {
		t.Fatalf("the mounts dir must really be write-denied")
	}
	if !writeDenied(host) {
		t.Fatalf("the host root must really be write-denied")
	}
	before := treeSnapshot(t, host, "")
	residueBefore := verifyResidue(t)
	// Twice: once proves it runs, twice proves the second run is not consuming
	// residue the first left behind.
	for i := range 2 {
		rows, err := mounts.MountStatus(host, m, mounts.StatusOptions{CheckIntegrity: true})
		if err != nil {
			t.Fatalf("status %d: %v", i, err)
		}
		if rows[0].Verified == nil || !*rows[0].Verified {
			t.Fatalf("status %d verified = %v", i, rows[0].Verified)
		}
	}
	// The other two callers of the same verification, on the same denied tree.
	loc, err := mounts.LocateMount(host, m, "acme-product-context")
	if err != nil {
		t.Fatalf("locate: %v", err)
	}
	if !loc.Present || !loc.Verified {
		t.Fatalf("locate = %+v", loc)
	}
	findings, err := mounts.FederationEnforcement(host, m, "available", nil)
	if err != nil {
		t.Fatalf("enforcement: %v", err)
	}
	if len(findings) != 0 {
		t.Fatalf("findings = %+v", findings)
	}
	if !slices.Equal(treeSnapshot(t, host, ""), before) {
		t.Fatalf("verification wrote into the host tree")
	}
	if extra := newVerifyResidue(t, residueBefore); len(extra) != 0 {
		t.Fatalf("staging outlived the verification that allocated it: %v", extra)
	}
}

// rendezvous returns a two-party barrier: each call blocks until both parties
// have called it, and it is reusable round after round.
func rendezvous() func() {
	gate := make(chan struct{})
	return func() {
		select {
		case gate <- struct{}{}:
		case <-gate:
		}
	}
}

func TestMountsTwoVerificationsAtOnceInOneProcessDoNotCollide(t *testing.T) {
	// Two goroutines running `rounds` verifications of the host's only mount, every
	// round entered through a two-goroutine rendezvous, with the lagging goroutine
	// then held back to about half of its last round.
	//
	// Both halves earn their place. Without the rendezvous the goroutines drift into
	// taking turns and never overlap; with the rendezvous alone they run identical
	// work in lockstep, and two of them staging the same content into one shared
	// directory at the same instant still agree — the interleaving that a shared
	// staging directory cannot survive is one goroutine starting while the other is
	// mid-verification. One process, so a staging name derived from the pid is one
	// name for both of them.
	host, _, _ := mountedPair(t)
	m := loadHost(t, host)
	if _, err := mounts.HydrateMounts(host, m, mounts.HydrateOptions{}); err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	mount := firstMount(t, m)
	residueBefore := verifyResidue(t)
	const rounds = 8
	meet := rendezvous()
	results := make([][]string, 2)
	var wg sync.WaitGroup
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			lag := i == 1
			lastRound := 40 * time.Millisecond
			out := make([]string, 0, rounds)
			for range rounds {
				meet()
				if lag {
					time.Sleep(max(lastRound/2, 5*time.Millisecond))
				}
				startedAt := time.Now()
				v, err := mounts.VerifyProjection(host, mount)
				lastRound = time.Since(startedAt)
				switch {
				case err != nil:
					out = append(out, "error "+err.Error())
				case v == nil:
					out = append(out, "unverifiable")
				default:
					out = append(out, fmt.Sprintf("%t", *v))
				}
			}
			results[i] = out
		}(i)
	}
	wg.Wait()
	// Every one of them verified: a shared staging path has one goroutine deleting
	// or half-writing the tree the other is comparing, which surfaces as ENOENT,
	// ENOTEMPTY, or a false verdict on content nobody tampered with.
	want := make([]string, rounds)
	for i := range want {
		want[i] = "true"
	}
	for i, got := range results {
		if !slices.Equal(got, want) {
			t.Fatalf("goroutine %d = %v", i, got)
		}
	}
	if extra := newVerifyResidue(t, residueBefore); len(extra) != 0 {
		t.Fatalf("staging outlived the verifications that allocated it: %v", extra)
	}
}

func TestMountsAnUnusableTempDirMakesVerificationUnverifiableNeverInTree(t *testing.T) {
	host, _, _ := mountedPair(t)
	m := loadHost(t, host)
	if _, err := mounts.HydrateMounts(host, m, mounts.HydrateOptions{}); err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	noTmp := filepath.Join(t.TempDir(), "notmp")
	if err := os.Mkdir(noTmp, 0o755); err != nil {
		t.Fatalf("mkdir notmp: %v", err)
	}
	if err := os.Chmod(noTmp, 0o555); err != nil {
		t.Fatalf("chmod notmp: %v", err)
	}
	defer os.Chmod(noTmp, 0o755)
	t.Setenv("TMPDIR", noTmp)
	if os.TempDir() != noTmp {
		t.Fatalf("the runtime must honor TMPDIR for this to force the failure")
	}
	if !writeDenied(noTmp) {
		t.Fatalf("the temp dir must really be write-denied")
	}
	before := treeSnapshot(t, host, "")
	// Unknown: no staging area is a missing prerequisite, exactly like no reachable
	// object store. It is never a pass, never a failure, and never a reason to fall
	// back into the host tree.
	rows, err := mounts.MountStatus(host, m, mounts.StatusOptions{CheckIntegrity: true})
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !rows[0].Present || rows[0].Verified != nil {
		t.Fatalf("status row = %+v", rows[0])
	}
	loc, err := mounts.LocateMount(host, m, "acme-product-context")
	if err != nil {
		t.Fatalf("locate: %v", err)
	}
	if !loc.Present || loc.Verified {
		t.Fatalf("locate = %+v", loc)
	}
	if !strings.Contains(loc.Detail, "present but not verified") ||
		!strings.Contains(loc.Detail, "verification prerequisites are unavailable") {
		t.Fatalf("locate detail = %q", loc.Detail)
	}
	// The diagnostic names the prerequisite that was actually missing rather than
	// blaming the object store, which is reachable here: a reader told to check
	// their hint would be reading the wrong end of the failure.
	findings, err := mounts.FederationEnforcement(host, m, "available", nil)
	if err != nil {
		t.Fatalf("enforcement: %v", err)
	}
	if len(findings) != 1 ||
		!strings.Contains(findings[0].Message, "cannot be verified") ||
		!strings.Contains(findings[0].Message, "verification prerequisites unavailable") ||
		!strings.Contains(findings[0].Message, "no writable temp dir") {
		t.Fatalf("findings = %+v", findings)
	}
	if !slices.Equal(treeSnapshot(t, host, ""), before) {
		t.Fatalf("verification fell back into the host tree")
	}
	staged, err := os.ReadDir(noTmp)
	if err != nil {
		t.Fatalf("read notmp: %v", err)
	}
	if len(staged) != 0 {
		t.Fatalf("nothing was staged in the unusable temp dir: %v", staged)
	}
}

func TestMountsAReachableStoreWithoutThePinIsUnverifiableAndNamesThePrerequisite(t *testing.T) {
	host, _, _ := mountedPair(t)
	m := loadHost(t, host)
	if _, err := mounts.HydrateMounts(host, m, mounts.HydrateOptions{}); err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	// A real repository, reachable, that simply does not contain this pin. The
	// published projection stays published — its cache key comes from the
	// declaration, not from whichever store happens to be reachable — so the only
	// missing prerequisite is the commit the comparison would be made against.
	other := filepath.Join(filepath.Dir(host), "other")
	if err := os.MkdirAll(other, 0o755); err != nil {
		t.Fatalf("mkdir other: %v", err)
	}
	git(t, other, "init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(other, "unrelated.md"), []byte("# unrelated\n"), 0o644); err != nil {
		t.Fatalf("write unrelated: %v", err)
	}
	git(t, other, "add", "-A")
	git(t, other, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "unrelated")
	hint := `{"mounts":{"acme-product-context":{"repo":"../other"}}}` + "\n"
	if err := os.WriteFile(filepath.Join(host, ".leji", "mounts.local.json"), []byte(hint), 0o644); err != nil {
		t.Fatalf("write hint: %v", err)
	}
	v, err := mounts.VerifyProjection(host, firstMount(t, m))
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if v != nil {
		t.Fatalf("verify = %v, want nil", *v)
	}
	rows, err := mounts.MountStatus(host, m, mounts.StatusOptions{CheckIntegrity: true})
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !rows[0].Present || rows[0].Verified != nil {
		t.Fatalf("status row = %+v", rows[0])
	}
	loc, err := mounts.LocateMount(host, m, "acme-product-context")
	if err != nil {
		t.Fatalf("locate: %v", err)
	}
	if !loc.Present || loc.Verified {
		t.Fatalf("locate = %+v", loc)
	}
	// The parenthetical is the whole of what makes a projection unverifiable. An
	// exhaustive-looking list that omits this branch tells the reader their object
	// store is unreachable when it is reachable and their pin is what is missing.
	findings, err := mounts.FederationEnforcement(host, m, "available", nil)
	if err != nil {
		t.Fatalf("enforcement: %v", err)
	}
	want := `mount "acme-product-context" projection cannot be verified (verification prerequisites unavailable: no reachable object store, unresolvable pin, or no writable temp dir); an unverified cache is not evidence`
	if len(findings) != 1 || findings[0].Message != want {
		t.Fatalf("findings = %+v", findings)
	}
}

func TestMountsHydrateRefusesAStoreDestinationPlantedOutOfTheRepository(t *testing.T) {
	// `.leji/mounts` was a lexical join, so a planted symlink redirected every
	// per-entry write of the federation protocol — into another private role, or clean
	// out of the repository. The store, cache entry and staging destinations are
	// established through the write chokepoint now, and every inner act works from the
	// RESOLVED root it returned. Mutation that reddens: mkdir the destination directly
	// again — the projection materializes through the link.
	for _, c := range []struct {
		name   string
		plant  func(t *testing.T, host string) string
		detail string
	}{
		{"out of the repository", func(t *testing.T, host string) string {
			away := t.TempDir()
			if err := os.Symlink(away, filepath.Join(host, ".leji", "mounts")); err != nil {
				t.Fatal(err)
			}
			return away
		}, "the cache entry destination could not be established"},
		{"into another private role", func(t *testing.T, host string) string {
			target := filepath.Join(host, ".leji", "work", "planted")
			if err := os.MkdirAll(target, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(filepath.Join("work", "planted"), filepath.Join(host, ".leji", "mounts")); err != nil {
				t.Fatal(err)
			}
			return target
		}, "the cache entry destination could not be established"},
	} {
		host, _, _ := mountedPair(t)
		if err := os.RemoveAll(filepath.Join(host, ".leji", "mounts")); err != nil {
			t.Fatal(err)
		}
		landing := c.plant(t, host)
		m := loadHost(t, host)

		r, err := mounts.HydrateMounts(host, m, mounts.HydrateOptions{})
		if err != nil {
			t.Fatalf("%s: hydrate: %v", c.name, err)
		}
		if len(r.Outcomes) != 1 || r.Outcomes[0].Status != "error" || r.Outcomes[0].Detail != c.detail {
			t.Fatalf("%s: outcomes = %+v", c.name, r.Outcomes)
		}
		entries, rerr := os.ReadDir(landing)
		if rerr != nil {
			t.Fatal(rerr)
		}
		if len(entries) != 0 {
			t.Fatalf("%s: nothing may be materialized through the planted link, got %v", c.name, entries)
		}
	}
}

// --- gate helpers -------------------------------------------------------------
// These commands now carry an error channel, because an operational read failure on
// an allowed path propagates instead of being swallowed (the reference throws it).
// A test that does not construct such a failure asserts there is none.

func validateLayer(t *testing.T, root string, content bool) validate.Result {
	t.Helper()
	res, err := validate.ValidateLayer(root, content)
	if err != nil {
		t.Fatalf("ValidateLayer(%s): %v", root, err)
	}
	return res
}
