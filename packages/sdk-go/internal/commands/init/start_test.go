package initcmd

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/detect"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

var errExit = errors.New("exit status 1")

const bootPromptStr = "Read ./docs/boot-profile.md, follow it, and tell me when you're ready."

// bootLayer creates a minimal real layer dir with a boot profile, for EnterLayer's
// existence check, and the matching manifest.
func bootLayer(t *testing.T) (string, *manifest.Manifest) {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "docs"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "docs", "boot-profile.md"), []byte("# boot\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	return dir, &manifest.Manifest{RootPath: "docs/", BootProfilePath: "docs/boot-profile.md"}
}

func TestEnterLayerSingleHostLaunchesDirectly(t *testing.T) {
	dir, m := bootLayer(t)
	hio, launches, cwds := fakeIOWithCwd("", cleanExit)
	out := &strings.Builder{}
	outcome, err := EnterLayer(StartOptions{Root: dir, Manifest: m, Detected: []detect.DetectedHost{claudeHost}, Interactive: true}, hio, out)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if outcome != StartLaunched {
		t.Fatalf("outcome = %q, want launched", outcome)
	}
	// A single host launches without asking.
	if strings.Contains(out.String(), "Detected coding agents") {
		t.Fatalf("single host should not prompt, out: %q", out.String())
	}
	if len(*launches) != 1 || (*launches)[0] != "claude "+bootPromptStr {
		t.Fatalf("launches = %v", *launches)
	}
	wantCwd, _ := filepath.Abs(dir)
	if (*cwds)[0] != wantCwd {
		t.Fatalf("cwd = %q, want layer root %q", (*cwds)[0], wantCwd)
	}
}

func TestEnterLayerMultipleHostsAsksThenLaunches(t *testing.T) {
	dir, m := bootLayer(t)
	hio, launches := fakeIO("2", cleanExit)
	outcome, err := EnterLayer(StartOptions{Root: dir, Manifest: m, Detected: []detect.DetectedHost{claudeHost, codexHost}, Interactive: true}, hio, &strings.Builder{})
	if err != nil || outcome != StartLaunched {
		t.Fatalf("outcome=%q err=%v", outcome, err)
	}
	if len(*launches) != 1 || (*launches)[0] != "codex "+bootPromptStr {
		t.Fatalf("launches = %v", *launches)
	}
}

func TestEnterLayerFallsBack(t *testing.T) {
	dir, m := bootLayer(t)
	cases := []struct {
		name        string
		detected    []detect.DetectedHost
		interactive bool
		answer      string
	}{
		{"directory-only host", []detect.DetectedHost{cursorHost}, true, "y"},
		{"single host non-interactive", []detect.DetectedHost{claudeHost}, false, "y"},
		{"multiple hosts non-interactive", []detect.DetectedHost{claudeHost, codexHost}, false, "2"},
		{"no host", nil, true, "y"},
	}
	for _, tc := range cases {
		hio, launches := fakeIO(tc.answer, cleanExit)
		outcome, err := EnterLayer(StartOptions{Root: dir, Manifest: m, Detected: tc.detected, Interactive: tc.interactive}, hio, &strings.Builder{})
		if err != nil || outcome != StartFallback {
			t.Fatalf("%s: outcome=%q err=%v", tc.name, outcome, err)
		}
		if len(*launches) != 0 {
			t.Fatalf("%s: should not launch, got %v", tc.name, *launches)
		}
	}
}

func TestEnterLayerBootMissing(t *testing.T) {
	dir := t.TempDir() // no docs/boot-profile.md
	m := &manifest.Manifest{RootPath: "docs/", BootProfilePath: "docs/boot-profile.md"}
	hio, _ := fakeIO("y", cleanExit)
	outcome, err := EnterLayer(StartOptions{Root: dir, Manifest: m, Detected: []detect.DetectedHost{claudeHost}, Interactive: true}, hio, &strings.Builder{})
	if err != nil || outcome != StartBootMissing {
		t.Fatalf("outcome=%q err=%v, want boot-missing", outcome, err)
	}
}

func TestEnterLayerBootUnsafePath(t *testing.T) {
	dir, _ := bootLayer(t)
	m := &manifest.Manifest{RootPath: "docs/", BootProfilePath: "../escape.md"}
	hio, _ := fakeIO("y", cleanExit)
	outcome, _ := EnterLayer(StartOptions{Root: dir, Manifest: m, Detected: []detect.DetectedHost{claudeHost}, Interactive: true}, hio, &strings.Builder{})
	if outcome != StartBootMissing {
		t.Fatalf("unsafe boot path should be boot-missing, got %q", outcome)
	}
}

func TestEnterLayerAgentForcesLaunchableHost(t *testing.T) {
	dir, m := bootLayer(t)
	hio, launches := fakeIO("y", cleanExit)
	// No detected hosts: --agent forces codex regardless.
	outcome, err := EnterLayer(StartOptions{Root: dir, Manifest: m, Detected: nil, Agent: "codex", Interactive: true}, hio, &strings.Builder{})
	if err != nil || outcome != StartLaunched {
		t.Fatalf("outcome=%q err=%v", outcome, err)
	}
	if len(*launches) != 1 || (*launches)[0] != "codex "+bootPromptStr {
		t.Fatalf("launches = %v", *launches)
	}
}

func TestEnterLayerAgentRejectsNonLaunchable(t *testing.T) {
	dir, m := bootLayer(t)
	hio, _ := fakeIO("y", cleanExit)
	_, err := EnterLayer(StartOptions{Root: dir, Manifest: m, Detected: nil, Agent: "gemini", Interactive: true}, hio, &strings.Builder{})
	if err == nil || !strings.Contains(err.Error(), "launchable host") {
		t.Fatalf("expected launchable-host usage error, got %v", err)
	}
	// An unknown agent is likewise a usage error.
	if _, err := EnterLayer(StartOptions{Root: dir, Manifest: m, Agent: "nope", Interactive: true}, hio, &strings.Builder{}); err == nil {
		t.Fatal("unknown agent should error")
	}
}

func TestEnterLayerLaunchFailureFallsBack(t *testing.T) {
	dir, m := bootLayer(t)
	hio, launches := fakeIO("", LaunchResult{Started: true, Err: errExit})
	outcome, err := EnterLayer(StartOptions{Root: dir, Manifest: m, Detected: []detect.DetectedHost{claudeHost}, Interactive: true}, hio, &strings.Builder{})
	if err != nil || outcome != StartFallback {
		t.Fatalf("outcome=%q err=%v, want fallback", outcome, err)
	}
	if len(*launches) != 1 {
		t.Fatalf("a launch should have been attempted, got %v", *launches)
	}
}
