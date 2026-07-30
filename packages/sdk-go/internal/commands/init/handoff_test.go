package initcmd

import (
	"errors"
	"reflect"
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

// fakeIO answers every prompt with `answer` and records each launch; `result`
// is the scripted launch outcome.
func fakeIO(answer string, result LaunchResult) (*HandoffIO, *[]string) {
	launches := []string{}
	hio := &HandoffIO{
		ReadLine: func(_, _ string) string { return answer },
		Launch: func(bin, promptArg, _ string, _ []string) LaunchResult {
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
		Launch: func(bin, promptArg, cwd string, _ []string) LaunchResult {
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
	ok, err := HandoffOffer(mfst(), []detect.DetectedHost{claudeHost}, false, hio, &strings.Builder{}, "", "", McpOfferOutcome{})
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
	ok, err := HandoffOffer(mfst(), []detect.DetectedHost{cursorHost}, true, hio, &strings.Builder{}, "", "", McpOfferOutcome{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Fatal("directory-only host should yield no offer")
	}
	// A prompt-capable host present only via repo config (not on PATH) is ignored.
	ok, err = HandoffOffer(mfst(), []detect.DetectedHost{detectedHost("codex", "Codex", false)}, true, hio, &strings.Builder{}, "", "", McpOfferOutcome{})
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
		ok, err := HandoffOffer(mfst(), []detect.DetectedHost{claudeHost}, true, hio, &strings.Builder{}, "", "", McpOfferOutcome{})
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
	ok, err := HandoffOffer(mfst(), []detect.DetectedHost{claudeHost}, true, hio, &strings.Builder{}, "", "", McpOfferOutcome{})
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
	ok, err := HandoffOffer(mfst(), hosts, true, hio, &strings.Builder{}, "", "", McpOfferOutcome{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ok || (*launches)[0] != "codex "+briefPrompt {
		t.Fatalf("'2' should launch codex, got %v", *launches)
	}

	// Launching is a side effect: the multi-host menu needs an explicit in-range
	// number; empty skips without launching agent 1.
	hio, launches = fakeIO("", cleanExit)
	ok, err = HandoffOffer(mfst(), hosts, true, hio, &strings.Builder{}, "", "", McpOfferOutcome{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok || len(*launches) != 0 {
		t.Fatalf("empty should skip without launching, got %v", *launches)
	}

	hio, launches = fakeIO("n", cleanExit)
	ok, err = HandoffOffer(mfst(), hosts, true, hio, &strings.Builder{}, "", "", McpOfferOutcome{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok || len(*launches) != 0 {
		t.Fatalf("'n' should skip without launching, got %v", *launches)
	}

	// Junk / out-of-range must not launch agent 1 the user never chose.
	for _, ans := range []string{"9", "0", "banana", "-1"} {
		hio, launches = fakeIO(ans, cleanExit)
		ok, err = HandoffOffer(mfst(), hosts, true, hio, &strings.Builder{}, "", "", McpOfferOutcome{})
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
	ok, err := HandoffOffer(mfst(), []detect.DetectedHost{claudeHost}, true, hio, &strings.Builder{}, "", "", McpOfferOutcome{})
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
	ok, err = HandoffOffer(mfst(), []detect.DetectedHost{claudeHost}, true, hio, &strings.Builder{}, "", "", McpOfferOutcome{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Fatal("non-clean exit should return false")
	}
}

func TestHandoffOfferThreadsRoot(t *testing.T) {
	hio, launches := fakeIO("y", cleanExit)
	ok, err := HandoffOffer(&manifest.Manifest{RootPath: "context/"}, []detect.DetectedHost{claudeHost}, true, hio, &strings.Builder{}, "", "", McpOfferOutcome{})
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

// --- MCP install offer (pre-handoff) ---

// The per-host register argv (mirrors detect.go) and the presence-check argv.
var (
	claudeMcpAdd = []string{"mcp", "add", "leji", "--scope", "project", "--", "npx", "-y", "@leji-org/mcp"}
	codexMcpAdd  = []string{"mcp", "add", "leji", "--", "npx", "-y", "@leji-org/mcp"}
	mcpCheck     = []string{"mcp", "get", "leji"}
)

// A presence check reporting "absent" (started, non-zero exit) so the offer fires,
// then a clean register. Mirrors the Node ABSENT_THEN_OK fixture.
func absentThenOK() []LaunchResult {
	return []LaunchResult{{Started: true, Err: errors.New("exit status 1")}, {Started: true}}
}

type recordedRun struct {
	bin   string
	args  []string
	cwd   string
	quiet bool
}

// fakeMcpIO answers every prompt with `answer`, records each Run call, and returns
// the scripted run results in order (a clean exit once the script is exhausted).
func fakeMcpIO(answer string, runResults []LaunchResult) (*HandoffIO, *[]string, *[]recordedRun) {
	questions := []string{}
	runs := []recordedRun{}
	idx := 0
	hio := &HandoffIO{
		ReadLine: func(q, _ string) string {
			questions = append(questions, q)
			return answer
		},
		Run: func(bin string, args []string, cwd string, quiet bool) LaunchResult {
			runs = append(runs, recordedRun{bin: bin, args: args, cwd: cwd, quiet: quiet})
			res := LaunchResult{Started: true}
			if idx < len(runResults) {
				res = runResults[idx]
			}
			idx++
			return res
		},
	}
	return hio, &questions, &runs
}

func TestOfferMcpInstallNeverFiresNonInteractively(t *testing.T) {
	hio, questions, runs := fakeMcpIO("y", absentThenOK())
	OfferMcpInstall(McpOfferOptions{Root: "/repo", Detected: []detect.DetectedHost{claudeHost}, Interactive: false}, hio, &strings.Builder{})
	if len(*questions) != 0 {
		t.Fatalf("non-interactive should not prompt, got %v", *questions)
	}
	if len(*runs) != 0 {
		t.Fatalf("non-interactive should not run, got %v", *runs)
	}
}

func TestOfferMcpInstallNoLaunchableHost(t *testing.T) {
	hio, questions, runs := fakeMcpIO("y", absentThenOK())
	OfferMcpInstall(McpOfferOptions{Root: "/repo", Detected: []detect.DetectedHost{cursorHost}, Interactive: true}, hio, &strings.Builder{})
	if len(*questions) != 0 {
		t.Fatalf("directory-only host should yield no prompt, got %v", *questions)
	}
	if len(*runs) != 0 {
		t.Fatalf("directory-only host should yield no run, got %v", *runs)
	}
}

func TestOfferMcpInstallRegistersOnAccept(t *testing.T) {
	// Empty answer = Y default.
	hio, questions, runs := fakeMcpIO("", absentThenOK())
	OfferMcpInstall(McpOfferOptions{Root: "/repo", Detected: []detect.DetectedHost{claudeHost}, Interactive: true}, hio, &strings.Builder{})
	if len(*questions) != 1 {
		t.Fatalf("expected exactly one prompt, got %v", *questions)
	}
	if len(*runs) != 2 {
		t.Fatalf("expected check then register, got %v", *runs)
	}
	// First run is the quiet presence check; second is the register, both at the root.
	if got := (*runs)[0]; got.bin != "claude" || !reflect.DeepEqual(got.args, mcpCheck) || got.cwd != "/repo" || !got.quiet {
		t.Fatalf("unexpected presence check: %+v", got)
	}
	if got := (*runs)[1]; got.bin != "claude" || !reflect.DeepEqual(got.args, claudeMcpAdd) || got.cwd != "/repo" || got.quiet {
		t.Fatalf("unexpected register: %+v", got)
	}
}

func TestOfferMcpInstallSkipsWhenAlreadyRegistered(t *testing.T) {
	// Check reports present (clean exit): no nag, no register.
	hio, questions, runs := fakeMcpIO("y", []LaunchResult{{Started: true}})
	OfferMcpInstall(McpOfferOptions{Root: "/repo", Detected: []detect.DetectedHost{claudeHost}, Interactive: true}, hio, &strings.Builder{})
	if len(*questions) != 0 {
		t.Fatalf("no prompt when already present, got %v", *questions)
	}
	if len(*runs) != 1 || !(*runs)[0].quiet {
		t.Fatalf("only the quiet presence check should run, got %v", *runs)
	}
}

func TestOfferMcpInstallDeclineDoesNotRegister(t *testing.T) {
	hio, questions, runs := fakeMcpIO("n", absentThenOK())
	OfferMcpInstall(McpOfferOptions{Root: "/repo", Detected: []detect.DetectedHost{claudeHost}, Interactive: true}, hio, &strings.Builder{})
	if len(*questions) != 1 {
		t.Fatalf("expected the offer prompt, got %v", *questions)
	}
	if len(*runs) != 1 {
		t.Fatalf("decline should run only the presence check, got %v", *runs)
	}
}

// fakeFlowIO scripts sequenced answers (the last one repeats) and records the
// interleaved run/launch order, for the pick-then-register-then-launch flow.
func fakeFlowIO(answers []string, runResults []LaunchResult) (*HandoffIO, *[]string, *[]recordedRun, *[]string) {
	questions := []string{}
	runs := []recordedRun{}
	events := []string{}
	runIdx := 0
	ansIdx := 0
	hio := &HandoffIO{
		ReadLine: func(q, _ string) string {
			questions = append(questions, q)
			a := answers[len(answers)-1]
			if ansIdx < len(answers) {
				a = answers[ansIdx]
			}
			ansIdx++
			return a
		},
		Launch: func(bin, _, _ string, _ []string) LaunchResult {
			events = append(events, "launch:"+bin)
			return LaunchResult{Started: true}
		},
		Run: func(bin string, args []string, cwd string, quiet bool) LaunchResult {
			runs = append(runs, recordedRun{bin: bin, args: args, cwd: cwd, quiet: quiet})
			events = append(events, "run:"+bin)
			res := LaunchResult{Started: true}
			if runIdx < len(runResults) {
				res = runResults[runIdx]
			}
			runIdx++
			return res
		},
	}
	return hio, &questions, &runs, &events
}

func TestOfferMcpInstallMultiHostAsksThePickOnceThenRegistersForIt(t *testing.T) {
	hio, questions, runs, _ := fakeFlowIO([]string{"2", "y"}, absentThenOK())
	outcome := OfferMcpInstall(McpOfferOptions{Root: "/repo", Detected: []detect.DetectedHost{claudeHost, codexHost}, Interactive: true}, hio, &strings.Builder{})
	if len(*questions) == 0 || !strings.Contains((*questions)[0], "Which agent?") {
		t.Fatalf("the host pick should come before the MCP question, got %v", *questions)
	}
	if len(*runs) != 2 || (*runs)[1].bin != "codex" || !reflect.DeepEqual((*runs)[1].args, codexMcpAdd) {
		t.Fatalf("should register for the picked host (codex), got %v", *runs)
	}
	if outcome.next != "launch" || outcome.host == nil || outcome.host.bin != "codex" {
		t.Fatalf("outcome should launch the picked host, got %+v", outcome)
	}
}

func TestOfferMcpInstallSkipsEverythingWhenThePickIsDeclined(t *testing.T) {
	hio, questions, runs, _ := fakeFlowIO([]string{""}, absentThenOK())
	outcome := OfferMcpInstall(McpOfferOptions{Root: "/repo", Detected: []detect.DetectedHost{claudeHost, codexHost}, Interactive: true}, hio, &strings.Builder{})
	if outcome.next != "skip" {
		t.Fatalf("a declined pick should return skip, got %+v", outcome)
	}
	if len(*questions) != 1 {
		t.Fatalf("only the pick should have been asked, got %v", *questions)
	}
	if len(*runs) != 0 {
		t.Fatalf("no check or register for a declined pick, got %v", *runs)
	}
}

func TestOfferMcpInstallSingleHostReturnsDefault(t *testing.T) {
	hio, _, _ := fakeMcpIO("y", absentThenOK())
	outcome := OfferMcpInstall(McpOfferOptions{Root: "/repo", Detected: []detect.DetectedHost{claudeHost}, Interactive: true}, hio, &strings.Builder{})
	if outcome.next != "default" {
		t.Fatalf("a single host keeps the handoff's own confirm, got %+v", outcome)
	}
}

func TestHandoffOfferLaunchesTheMcpPickedHostWithoutReAsking(t *testing.T) {
	hio, questions, _, events := fakeFlowIO([]string{"never-read"}, nil)
	ok, err := HandoffOffer(mfst(), []detect.DetectedHost{claudeHost, codexHost}, true, hio, &strings.Builder{}, "", "/repo",
		McpOfferOutcome{next: "launch", host: &promptHost{id: "codex", bin: "codex", name: "Codex"}})
	if err != nil || !ok {
		t.Fatalf("expected a clean launch, got ok=%v err=%v", ok, err)
	}
	if len(*questions) != 0 {
		t.Fatalf("no second pick or confirm, got %v", *questions)
	}
	if !reflect.DeepEqual(*events, []string{"launch:codex"}) {
		t.Fatalf("should launch the picked host directly, got %v", *events)
	}
}

func TestHandoffOfferHonorsASkippedMcpPick(t *testing.T) {
	hio, questions, _, events := fakeFlowIO([]string{"never-read"}, nil)
	ok, err := HandoffOffer(mfst(), []detect.DetectedHost{claudeHost, codexHost}, true, hio, &strings.Builder{}, "", "/repo",
		McpOfferOutcome{next: "skip"})
	if err != nil || ok {
		t.Fatalf("a skipped pick should not launch, got ok=%v err=%v", ok, err)
	}
	if len(*questions) != 0 || len(*events) != 0 {
		t.Fatalf("no prompt and no launch after a skipped pick, got %v / %v", *questions, *events)
	}
}

func TestOfferThenHandoffComposeRegisterBeforeLaunchSameHost(t *testing.T) {
	hio, _, _, events := fakeFlowIO([]string{"2", "y"}, absentThenOK())
	outcome := OfferMcpInstall(McpOfferOptions{Root: "/repo", Detected: []detect.DetectedHost{claudeHost, codexHost}, Interactive: true}, hio, &strings.Builder{})
	ok, err := HandoffOffer(mfst(), []detect.DetectedHost{claudeHost, codexHost}, true, hio, &strings.Builder{}, "", "/repo", outcome)
	if err != nil || !ok {
		t.Fatalf("expected a clean launch, got ok=%v err=%v", ok, err)
	}
	// check, register, launch: all codex, the register strictly before the launch.
	if !reflect.DeepEqual(*events, []string{"run:codex", "run:codex", "launch:codex"}) {
		t.Fatalf("register must precede the launch of the same host, got %v", *events)
	}
}

func TestOfferMcpInstallHonorsAgent(t *testing.T) {
	// Codex is not even detected; --agent forces it, and its argv omits --scope project.
	hio, _, runs := fakeMcpIO("y", absentThenOK())
	OfferMcpInstall(McpOfferOptions{Root: "/repo", Detected: []detect.DetectedHost{claudeHost}, Interactive: true, Agent: "codex"}, hio, &strings.Builder{})
	if len(*runs) != 2 {
		t.Fatalf("expected check then register, got %v", *runs)
	}
	if got := (*runs)[1]; got.bin != "codex" || !reflect.DeepEqual(got.args, codexMcpAdd) {
		t.Fatalf("--agent codex should register with the codex argv, got %+v", got)
	}
}

func TestOfferMcpInstallNeverPanicsWhenRegisterFails(t *testing.T) {
	// Check absent, then the register never starts: the offer must not panic.
	hio, _, runs := fakeMcpIO("y", []LaunchResult{
		{Started: true, Err: errors.New("exit status 1")},
		{Started: false, Err: errors.New("exec: \"claude\": not found")},
	})
	OfferMcpInstall(McpOfferOptions{Root: "/repo", Detected: []detect.DetectedHost{claudeHost}, Interactive: true}, hio, &strings.Builder{})
	if len(*runs) != 2 {
		t.Fatalf("expected check then attempted register, got %v", *runs)
	}
}
