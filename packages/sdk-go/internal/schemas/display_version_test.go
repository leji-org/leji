package schemas

import (
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The build marker, mirroring packages/sdk/test/version-marker.test.ts and
// packages/sdk-py/tests/test_version_marker.py: `--version` prints
// X.Y.Z+dev.<sha7> from a source checkout and the bare X.Y.Z from a build that
// carries no revision (a proxy install, or the release path).
//
// For Go the toolchain's own VCS stamping is the detection, so neither case can be
// reached from inside a test binary: `go test` stamps no vcs settings, which is why
// the in-process version assertions elsewhere in this module expect the bare string.
// Both cases therefore build the real command and run it.

var sha7 = regexp.MustCompile(`^[0-9a-f]{7}$`)

// releasePkg is the import path the release ldflags stamp through, spelled here the
// way .goreleaser.yaml spells it.
const releasePkg = "github.com/leji-org/leji/packages/sdk-go/internal/schemas"

// moduleRoot is packages/sdk-go: the directory holding go.mod, two levels above this
// package's source.
func moduleRoot(t *testing.T) string {
	t.Helper()
	abs, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("resolving the module root: %v", err)
	}
	return abs
}

// buildBinary builds ./cmd/leji with the given extra flags and returns its path.
func buildBinary(t *testing.T, flags ...string) string {
	t.Helper()
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go toolchain on PATH; the command cannot be built")
	}
	bin := filepath.Join(t.TempDir(), "leji")
	args := append([]string{"build"}, flags...)
	args = append(args, "-o", bin, "./cmd/leji")
	build := exec.Command("go", args...)
	build.Dir = moduleRoot(t)
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return bin
}

// versionOf is what a built binary prints for `--version`.
func versionOf(t *testing.T, bin string) string {
	t.Helper()
	out, err := exec.Command(bin, "--version").Output()
	if err != nil {
		t.Fatalf("running the built CLI: %v", err)
	}
	return strings.TrimSpace(string(out))
}

// carriesRevision reports whether the binary's own build info records a revision.
func carriesRevision(t *testing.T, bin string) bool {
	t.Helper()
	out, err := exec.Command("go", "version", "-m", bin).Output()
	if err != nil {
		t.Fatalf("reading the build info of %s: %v", bin, err)
	}
	return strings.Contains(string(out), "vcs.revision=")
}

// buildCLI builds ./cmd/leji with the given extra flags and returns what the binary
// prints for `--version`.
func buildCLI(t *testing.T, flags ...string) string {
	t.Helper()
	return versionOf(t, buildBinary(t, flags...))
}

func TestVersionCarriesTheMarkerWhenBuiltFromACheckout(t *testing.T) {
	head := exec.Command("git", "-C", moduleRoot(t), "rev-parse", "--short=7", "HEAD")
	out, err := head.Output()
	if err != nil {
		t.Skip("not a git checkout, or git is unavailable: nothing to stamp")
	}
	rev := strings.TrimSpace(string(out))
	if !sha7.MatchString(rev) {
		t.Skipf("HEAD does not abbreviate to seven hex characters: %q", rev)
	}
	if got, want := buildCLI(t), SDKVersion+"+dev."+rev; got != want {
		t.Fatalf("--version = %q, want %q", got, want)
	}
}

func TestVersionIsBareWhenTheReleaseFlagIsStamped(t *testing.T) {
	// The release path builds from a checkout, so the binary DOES carry VCS
	// metadata; what makes it a release is the ldflag goreleaser stamps. This is
	// the case no absence of metadata could prove, and the one the released
	// binaries depend on.
	bin := buildBinary(t, "-ldflags", "-X "+releasePkg+".ReleaseBuild=1")
	if !carriesRevision(t, bin) {
		t.Skip("this build recorded no revision, so a bare version would prove nothing here")
	}
	if got := versionOf(t, bin); got != SDKVersion {
		t.Fatalf("--version = %q, want %q despite the build carrying a revision", got, SDKVersion)
	}
}

func TestVersionIsBareWhenTheBuildCarriesNoRevision(t *testing.T) {
	// -buildvcs=false is what a build with nothing to report looks like: the same
	// state a module fetched through the proxy is in, and what the pre-publish
	// smoke asserts against.
	if got, want := buildCLI(t, "-buildvcs=false"), SDKVersion; got != want {
		t.Fatalf("--version = %q, want %q", got, want)
	}
}
