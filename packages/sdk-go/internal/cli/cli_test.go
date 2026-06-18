package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/schemas"
)

func repoRoot(t *testing.T) string {
	t.Helper()
	wd, _ := os.Getwd()
	return filepath.Join(wd, "..", "..", "..", "..")
}

func fixture(t *testing.T, name string) string {
	return filepath.Join(repoRoot(t), "fixtures", name)
}

// captureRun runs the CLI capturing stdout/stderr by swapping os.Stdout/Stderr.
func captureRun(t *testing.T, argv []string) (int, string, string) {
	t.Helper()
	origOut, origErr := os.Stdout, os.Stderr
	rOut, wOut, _ := os.Pipe()
	rErr, wErr, _ := os.Pipe()
	os.Stdout, os.Stderr = wOut, wErr
	code := Run(argv)
	wOut.Close()
	wErr.Close()
	os.Stdout, os.Stderr = origOut, origErr
	out := drain(rOut)
	errs := drain(rErr)
	return code, out, errs
}

func drain(r *os.File) string {
	var sb strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			sb.Write(buf[:n])
		}
		if err != nil {
			break
		}
	}
	r.Close()
	return sb.String()
}

func TestCLIVersion(t *testing.T) {
	code, out, _ := captureRun(t, []string{"--version"})
	if code != 0 {
		t.Fatalf("version exit %d", code)
	}
	if strings.TrimSpace(out) != schemas.SDKVersion {
		t.Fatalf("version output %q", out)
	}
}

func TestCLINoCommandExits2(t *testing.T) {
	code, out, _ := captureRun(t, []string{})
	if code != 2 {
		t.Fatalf("no-command exit %d", code)
	}
	if !strings.Contains(out, "Usage: leji") {
		t.Fatalf("expected usage, got %q", out)
	}
}

func TestCLIHelpExits0(t *testing.T) {
	code, out, _ := captureRun(t, []string{"help"})
	if code != 0 {
		t.Fatalf("help exit %d", code)
	}
	if !strings.Contains(out, "leji.org/cli") {
		t.Fatalf("help missing reference link")
	}
}

func TestCLIUnknownCommandExits2(t *testing.T) {
	code, _, errs := captureRun(t, []string{"frobnicate"})
	if code != 2 {
		t.Fatalf("unknown command exit %d", code)
	}
	if !strings.Contains(errs, "unknown command") {
		t.Fatalf("expected unknown command, got %q", errs)
	}
}

func TestCLIUnknownFlagExits2(t *testing.T) {
	code, _, errs := captureRun(t, []string{"validate", "--frobnicate"})
	if code != 2 {
		t.Fatalf("unknown flag exit %d", code)
	}
	if !strings.Contains(errs, "unknown option") {
		t.Fatalf("expected unknown option, got %q", errs)
	}
}

func TestCLIBadFlagValuesExit2(t *testing.T) {
	cases := [][]string{
		{"validate", "--root"},
		{"init", "--level", "galactic"},
		{"changelog", "frobnicate"},
	}
	for _, argv := range cases {
		code, _, _ := captureRun(t, argv)
		if code != 2 {
			t.Fatalf("%v expected exit 2, got %d", argv, code)
		}
	}
}

func TestCLIValidateJSONFailingFixture(t *testing.T) {
	code, out, _ := captureRun(t, []string{"validate", "--root", fixture(t, "invalid-bad-decision"), "--json"})
	if code != 1 {
		t.Fatalf("expected exit 1, got %d", code)
	}
	if !strings.Contains(out, `"command": "validate"`) || !strings.Contains(out, `"errors": 2`) {
		t.Fatalf("unexpected json: %s", out)
	}
}

func TestCLIIndexCheckJSONStale(t *testing.T) {
	code, out, _ := captureRun(t, []string{"index", "--check", "--root", fixture(t, "invalid-stale-index"), "--json"})
	if code != 1 {
		t.Fatalf("expected exit 1, got %d", code)
	}
	if !strings.Contains(out, `"stale": true`) {
		t.Fatalf("expected stale true, got %s", out)
	}
}

func TestCLIValidateValidFixture(t *testing.T) {
	code, _, _ := captureRun(t, []string{"validate", "--root", fixture(t, "valid-minimal-core")})
	if code != 0 {
		t.Fatalf("expected exit 0, got %d", code)
	}
}

func TestCLIChangelogWithoutSubcommandExits2(t *testing.T) {
	code, _, _ := captureRun(t, []string{"changelog"})
	if code != 2 {
		t.Fatalf("expected exit 2, got %d", code)
	}
}

func TestCLIHelpListsAllCommands(t *testing.T) {
	_, out, _ := captureRun(t, []string{"--help"})
	spec, err := schemas.LoadCliSpec()
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range spec.Commands {
		if !strings.Contains(out, c.Name) {
			t.Fatalf("help missing command %q", c.Name)
		}
	}
}

func TestCLIDocumentedCommandsAreKnown(t *testing.T) {
	spec, _ := schemas.LoadCliSpec()
	for _, c := range spec.Commands {
		argv := strings.Split(c.Name, " ")
		dir := t.TempDir()
		full := append(argv, "--root", dir)
		if c.Name == "init" {
			full = append(full, "--yes")
		}
		if c.Name == "changelog compact" {
			full = append(full, "--keep", "1")
		}
		code, _, errs := captureRun(t, full)
		if strings.Contains(errs, "unknown command") {
			t.Fatalf("%q should be known", c.Name)
		}
		if code == 2 {
			t.Fatalf("%q should not be a usage error", c.Name)
		}
	}
}
