package initcmd

import (
	"errors"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/detect"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

const briefPrompt = "Read ./docs/.leji/onboarding-brief.md and follow it."

func detectedHost(id, name string, onPath bool) detect.DetectedHost {
	strength := detect.ProjectPresent
	if onPath {
		strength = detect.Confirmed
	}
	return detect.DetectedHost{ID: id, Name: name, Strength: strength, OnPath: onPath, InRepo: !onPath}
}

// fakeIO returns a HandoffIO that answers every prompt with `answer` and records
// each launch; `result` is the scripted launch outcome (default clean exit).
func fakeIO(answer string, result LaunchResult) (*HandoffIO, *[]string) {
	launches := []string{}
	hio := &HandoffIO{
		ReadLine: func(_, _ string) string { return answer },
		Launch: func(bin, promptArg, _ string) LaunchResult {
			launches = append(launches, bin+" "+promptArg)
			return result
		},
	}
	return hio, &launches
}

// fakeIOWithCwd is like fakeIO but also records the cwd each launch ran from.
func fakeIOWithCwd(answer string, result LaunchResult) (*HandoffIO, *[]string, *[]string) {
	launches := []string{}
	cwds := []string{}
	hio := &HandoffIO{
		ReadLine: func(_, _ string) string { return answer },
		Launch: func(bin, promptArg, cwd string) LaunchResult {
			launches = append(launches, bin+" "+promptArg)
			cwds = append(cwds, cwd)
			return result
		},
	}
	return hio, &launches, &cwds
}

var (
	claudeHost = detectedHost("claude-code", "Claude Code", true)
	codexHost  = detectedHost("codex", "Codex", true)
	cursorHost = detectedHost("cursor", "Cursor", true) // directory-style: no inline-prompt CLI
	cleanExit  = LaunchResult{Started: true}
)

func mfst() *manifest.Manifest { return &manifest.Manifest{RootPath: "docs/"} }

func TestHandoffOfferNeverFiresNonInteractively(t *testing.T) {
	hio, launches := fakeIO("y", cleanExit)
	ok, err := HandoffOffer(mfst(), []detect.DetectedHost{claudeHost}, false, hio, &strings.Builder{}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Fatal("non-interactive offer should return false")
	}
	if len(*launches) != 0 {
		t.Fatalf("non-interactive should not launch, got %v", *launches)
	}
}

func TestHandoffOfferNoPromptCapableHost(t *testing.T) {
	hio, launches := fakeIO("y", cleanExit)
	// Only a directory-style host on PATH: nothing to launch.
	ok, err := HandoffOffer(mfst(), []detect.DetectedHost{cursorHost}, true, hio, &strings.Builder{}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Fatal("directory-only host should yield no offer")
	}
	// A prompt-capable host present only via repo config (not on PATH) is ignored.
	ok, err = HandoffOffer(mfst(), []detect.DetectedHost{detectedHost("codex", "Codex", false)}, true, hio, &strings.Builder{}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Fatal("host not on PATH should yield no offer")
	}
	if len(*launches) != 0 {
		t.Fatalf("no launch expected, got %v", *launches)
	}
}

func TestHandoffOfferSingleHost(t *testing.T) {
	for _, ans := range []string{"", "y", "yes", "Y"} {
		hio, launches := fakeIO(ans, cleanExit)
		ok, err := HandoffOffer(mfst(), []detect.DetectedHost{claudeHost}, true, hio, &strings.Builder{}, "")
		if err != nil {
			t.Fatalf("answer %q: unexpected error: %v", ans, err)
		}
		if !ok {
			t.Fatalf("answer %q should launch", ans)
		}
		if len(*launches) != 1 || (*launches)[0] != "claude "+briefPrompt {
			t.Fatalf("answer %q: unexpected launches %v", ans, *launches)
		}
	}
	hio, launches := fakeIO("n", cleanExit)
	ok, err := HandoffOffer(mfst(), []detect.DetectedHost{claudeHost}, true, hio, &strings.Builder{}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Fatal("'n' should decline")
	}
	if len(*launches) != 0 {
		t.Fatalf("decline should not launch, got %v", *launches)
	}
}

func TestHandoffOfferMultipleHosts(t *testing.T) {
	hosts := []detect.DetectedHost{claudeHost, codexHost}

	hio, launches := fakeIO("2", cleanExit)
	ok, err := HandoffOffer(mfst(), hosts, true, hio, &strings.Builder{}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ok || (*launches)[0] != "codex "+briefPrompt {
		t.Fatalf("'2' should launch codex, got %v", *launches)
	}

	// Launching an agent is a side effect, so the multi-host menu requires an
	// explicit, in-range number; an empty answer skips without launching agent 1.
	hio, launches = fakeIO("", cleanExit)
	ok, err = HandoffOffer(mfst(), hosts, true, hio, &strings.Builder{}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok || len(*launches) != 0 {
		t.Fatalf("empty should skip without launching, got %v", *launches)
	}

	hio, launches = fakeIO("n", cleanExit)
	ok, err = HandoffOffer(mfst(), hosts, true, hio, &strings.Builder{}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok || len(*launches) != 0 {
		t.Fatalf("'n' should skip without launching, got %v", *launches)
	}

	// Junk / out-of-range must not launch agent 1 the user never chose.
	for _, ans := range []string{"9", "0", "banana", "-1"} {
		hio, launches = fakeIO(ans, cleanExit)
		ok, err = HandoffOffer(mfst(), hosts, true, hio, &strings.Builder{}, "")
		if err != nil {
			t.Fatalf("answer %q: unexpected error: %v", ans, err)
		}
		if ok {
			t.Fatalf("answer %q should skip", ans)
		}
		if len(*launches) != 0 {
			t.Fatalf("answer %q should not launch, got %v", ans, *launches)
		}
	}
}

func TestHandoffOfferLaunchFailureFallsBack(t *testing.T) {
	// Could not start: returns false (caller prints instructions).
	hio, launches := fakeIO("y", LaunchResult{Started: false, Err: errors.New("exec: \"claude\": not found")})
	ok, err := HandoffOffer(mfst(), []detect.DetectedHost{claudeHost}, true, hio, &strings.Builder{}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Fatal("unstartable launch should return false")
	}
	if len(*launches) != 1 {
		t.Fatalf("a launch should have been attempted, got %v", *launches)
	}
	// Started but exited non-zero / signalled: also a fallback.
	hio, _ = fakeIO("y", LaunchResult{Started: true, Err: errors.New("exit status 1")})
	ok, err = HandoffOffer(mfst(), []detect.DetectedHost{claudeHost}, true, hio, &strings.Builder{}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Fatal("non-clean exit should return false")
	}
}

func TestHandoffOfferThreadsRoot(t *testing.T) {
	hio, launches := fakeIO("y", cleanExit)
	ok, err := HandoffOffer(&manifest.Manifest{RootPath: "context/"}, []detect.DetectedHost{claudeHost}, true, hio, &strings.Builder{}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ok {
		t.Fatal("should launch")
	}
	want := "claude Read ./context/.leji/onboarding-brief.md and follow it."
	if (*launches)[0] != want {
		t.Fatalf("root not threaded: got %q", (*launches)[0])
	}
}
