// Mirrors packages/sdk/test/mounts.test.ts.
package mounts_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

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
	v := validate.ValidateLayer(host, false)
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
	return validate.ValidateLayer(host, false).Findings
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
