package detect

import (
	"os"
	"path/filepath"
	"testing"
)

// Ranks confirmed > project-present > installed-likely via injected probes for determinism.
func TestDetectHostsRanking(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte("codex config\n"), 0o644); err != nil {
		t.Fatal(err) // codex: project-present
	}
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".gemini"), 0o755); err != nil {
		t.Fatal(err) // gemini: installed-likely
	}
	hosts := DetectHosts(Options{
		Root:      dir,
		Homedir:   home,
		Platform:  "linux",
		HasBinary: func(b string) bool { return b == "claude" }, // claude: confirmed
	})
	ids := make([]string, len(hosts))
	for i, h := range hosts {
		ids[i] = h.ID
	}
	want := []string{"claude-code", "codex", "gemini"}
	if len(ids) != len(want) {
		t.Fatalf("got ids %v, want %v", ids, want)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("got ids %v, want %v", ids, want)
		}
	}
	if hosts[0].Strength != Confirmed {
		t.Fatalf("top host strength = %q, want confirmed", hosts[0].Strength)
	}
	byID := map[string]DetectedHost{}
	for _, h := range hosts {
		byID[h.ID] = h
	}
	if byID["codex"].Strength != ProjectPresent {
		t.Fatalf("codex strength = %q, want project-present", byID["codex"].Strength)
	}
	if byID["gemini"].Strength != InstalledLikely {
		t.Fatalf("gemini strength = %q, want installed-likely", byID["gemini"].Strength)
	}
}

// On POSIX, "confirmed" requires the executable bit: a same-named plain file is not confirmed.
func TestDetectHostsRequiresExecutableBitOnPOSIX(t *testing.T) {
	root := t.TempDir()
	binDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(binDir, "claude"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(binDir, "codex"), []byte("plain text\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	hosts := DetectHosts(Options{
		Root:     root,
		Env:      map[string]string{"PATH": binDir},
		HasEnv:   true,
		Homedir:  home,
		Platform: "linux",
	})
	byID := map[string]DetectedHost{}
	for _, h := range hosts {
		byID[h.ID] = h
	}
	claude, ok := byID["claude-code"]
	if !ok || !claude.OnPath {
		t.Fatalf("executable claude should be confirmed on PATH; got %+v (present=%v)", claude, ok)
	}
	if _, ok := byID["codex"]; ok {
		t.Fatalf("a non-executable file named codex is not a confirmed host; got %+v", byID["codex"])
	}
}
