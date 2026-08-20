package initcmd

import (
	"bytes"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/ecosystem"
)

type depRun struct {
	bin  string
	args []string
	cwd  string
}

// fakeIO is the ONLY way this suite could reach a package manager, and it records
// instead of spawning.
func fakeDepIO(answer string, result AddResult) (*DependencyIO, *[]depRun, *[]string) {
	runs := &[]depRun{}
	questions := &[]string{}
	io := &DependencyIO{
		ReadLine: func(question, fallback string) string {
			*questions = append(*questions, question)
			return answer
		},
		Run: func(bin string, args []string, cwd string) AddResult {
			*runs = append(*runs, depRun{bin: bin, args: args, cwd: cwd})
			return result
		},
	}
	return io, runs, questions
}

func caseRoot(t *testing.T, name string) string {
	t.Helper()
	return filepath.Join(goldensDir(t), "..", "ecosystem", name)
}

func runOffer(t *testing.T, fixture string, interactive bool, answer string, result AddResult) (DependencyOffer, string, []depRun) {
	t.Helper()
	root := caseRoot(t, fixture)
	io, runs, _ := fakeDepIO(answer, result)
	var out bytes.Buffer
	offer := OfferDependency(DependencyOfferOptions{
		Root: root, Report: ecosystem.Detect(root), Interactive: interactive, IO: io,
	}, &out)
	return offer, out.String(), *runs
}

func TestOfferDependencyYesRunsTheManager(t *testing.T) {
	offer, out, runs := runOffer(t, "node-pnpm-lock", true, "y", AddResult{Started: true})
	if len(runs) != 1 || runs[0].bin != "pnpm" || !reflect.DeepEqual(runs[0].args, []string{"add", "-D", "@leji-org/leji"}) {
		t.Fatalf("argv: %+v", runs)
	}
	if runs[0].cwd != caseRoot(t, "node-pnpm-lock") {
		t.Errorf("cwd = %q", runs[0].cwd)
	}
	for _, want := range []string{
		"Detected pnpm (pnpm-lock.yaml).",
		"This runs pnpm here with your environment, as when you run it yourself: it will contact its registry and may run install scripts.",
		"Running: pnpm add -D @leji-org/leji",
		"Declared @leji-org/leji; a clean install now brings leji.",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	// The whole record, exactly as the reference asserts it.
	assertOffer(t, offer, DependencyOffer{
		Offered: true, Ran: true, Command: []string{"pnpm", "add", "-D", "@leji-org/leji"},
		ExitCode: intPtr(0),
	})
	if DependencyAddFailed(offer) {
		t.Error("a clean add is not a failure")
	}
}

// assertOffer compares the terminal outcome field by field, including the two
// nullable ones: a signalled add has no exit code, and a spawn that never started
// has neither.
func assertOffer(t *testing.T, got, want DependencyOffer) {
	t.Helper()
	if got.Offered != want.Offered || got.Ran != want.Ran || !reflect.DeepEqual(got.Command, want.Command) {
		t.Errorf("offer = %+v, want %+v", got, want)
	}
	if !samePtrInt(got.ExitCode, want.ExitCode) {
		t.Errorf("exitCode = %s, want %s", showInt(got.ExitCode), showInt(want.ExitCode))
	}
	if !samePtrStr(got.Signal, want.Signal) {
		t.Errorf("signal = %s, want %s", showStr(got.Signal), showStr(want.Signal))
	}
}

func samePtrInt(a, b *int) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func samePtrStr(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func showInt(p *int) string {
	if p == nil {
		return "null"
	}
	return strconv.Itoa(*p)
}

func showStr(p *string) string {
	if p == nil {
		return "null"
	}
	return *p
}

// The disclosure comes BEFORE the prompt, and never without one.
func TestOfferDependencyDisclosureOrder(t *testing.T) {
	_, out, _ := runOffer(t, "node-pnpm-lock", true, "n", AddResult{Started: true})
	disclosure := ecosystem.ConsentDisclosure("pnpm")
	if !strings.Contains(out, disclosure) {
		t.Fatalf("no disclosure:\n%s", out)
	}
	if strings.Index(out, "Detected pnpm") > strings.Index(out, disclosure) {
		t.Error("the block comes first")
	}
	offer, quiet, runs := runOffer(t, "node-pnpm-lock", false, "y", AddResult{Started: true})
	if strings.Contains(quiet, "This runs") || len(runs) != 0 {
		t.Errorf("non-interactive prints the block and runs nothing:\n%s", quiet)
	}
	assertOffer(t, offer, DependencyOffer{
		Offered: true, Command: []string{"pnpm", "add", "-D", "@leji-org/leji"},
	})
	for _, c := range []struct{ fixture, bin string }{
		{"python-uv", "uv"}, {"go-1.24", "go"}, {"node-npm-lock", "npm"},
	} {
		_, text, _ := runOffer(t, c.fixture, true, "n", AddResult{Started: true})
		if !strings.Contains(text, "This runs "+c.bin+" here with your environment") {
			t.Errorf("%s: %s", c.fixture, text)
		}
	}
}

func TestOfferDependencyDecline(t *testing.T) {
	for _, answer := range []string{"n", "no", "q", "N"} {
		offer, out, runs := runOffer(t, "node-pnpm-lock", true, answer, AddResult{Started: true})
		if len(runs) != 0 || DependencyAddFailed(offer) {
			t.Errorf("%q must not run the manager", answer)
		}
		// Declining leaves the terminal outcome empty: nothing ran, so there is no
		// exit code and no signal to report.
		assertOffer(t, offer, DependencyOffer{
			Offered: true, Command: []string{"pnpm", "add", "-D", "@leji-org/leji"},
		})
		if !strings.Contains(out, "Skipped; declare it later with:\n   pnpm add -D @leji-org/leji") {
			t.Errorf("%q: follow-up line missing:\n%s", answer, out)
		}
	}
}

// Node reports a signalled child with no exit code of its own, and a spawn that
// never started as an error rather than an exit code; both are failures, and both
// are reported in their own words.
func TestOfferDependencyFailureBranches(t *testing.T) {
	offer, out, _ := runOffer(t, "python-uv", true, "y", AddResult{Started: true, ExitCode: 1})
	if !strings.Contains(out, "uv exited 1; run it yourself:\n   uv add --dev leji") {
		t.Errorf("non-zero add:\n%s", out)
	}
	assertOffer(t, offer, DependencyOffer{
		Offered: true, Ran: true, Command: []string{"uv", "add", "--dev", "leji"}, ExitCode: intPtr(1),
	})
	if !DependencyAddFailed(offer) {
		t.Error("a non-zero add is a failure")
	}

	// A signalled manager has no exit code of its own: the signal is the outcome,
	// and its name is the canonical one every SDK prints.
	offer, out, _ = runOffer(t, "go-1.24", true, "y", AddResult{Started: true, ExitCode: -1, Signal: "SIGTERM"})
	if !strings.Contains(out, "go was terminated (SIGTERM); run it yourself:") {
		t.Errorf("signalled add:\n%s", out)
	}
	assertOffer(t, offer, DependencyOffer{
		Offered: true, Ran: true,
		Command: []string{"go", "get", "-tool", "github.com/leji-org/leji/packages/sdk-go/cmd/leji@latest"},
		Signal:  sigPtr("SIGTERM"),
	})
	if !DependencyAddFailed(offer) {
		t.Error("a signalled add is a failure")
	}

	// A spawn that never started carries neither an exit code nor a signal, and is
	// still a failure: reading its null exit code as success would pass a run in
	// which nothing happened.
	offer, out, _ = runOffer(t, "node-npm-lock", true, "y", AddResult{Started: false})
	if !strings.Contains(out, "npm is not on your PATH; run it yourself once it is:\n   npm i -D @leji-org/leji") {
		t.Errorf("spawn error:\n%s", out)
	}
	assertOffer(t, offer, DependencyOffer{
		Offered: true, Ran: true, Command: []string{"npm", "i", "-D", "@leji-org/leji"},
	})
	if !DependencyAddFailed(offer) {
		t.Error("a spawn that never started is a failure")
	}
}

// The canonical signal names, which Go's own Signal.String() does not give.
func TestSignalNameIsCanonical(t *testing.T) {
	for sig, want := range map[syscall.Signal]string{
		syscall.SIGTERM: "SIGTERM", syscall.SIGINT: "SIGINT", syscall.SIGKILL: "SIGKILL",
		syscall.SIGHUP: "SIGHUP", syscall.SIGPIPE: "SIGPIPE",
	} {
		if got := SignalName(sig); got != want {
			t.Errorf("SignalName(%d) = %q, want %q", int(sig), got, want)
		}
	}
	if got := SignalName(syscall.Signal(64)); got != "SIG64" {
		t.Errorf("an unknown signal falls back to its number: %q", got)
	}
}

func TestOfferDependencyNeverPromptsWithoutACommand(t *testing.T) {
	declared, out, runs := runOffer(t, "node-declared", true, "y", AddResult{Started: true})
	if len(runs) != 0 {
		t.Error("a declared repository is told so and never prompted")
	}
	// `Command` still names the add this repository would use; `Offered` is what says
	// there is nothing to consent to, because the CLI is already declared.
	assertOffer(t, declared, DependencyOffer{Command: []string{"npm", "i", "-D", "@leji-org/leji"}})
	if strings.TrimSpace(out) != "The Leji CLI is already declared in package.json." {
		t.Errorf("declared block: %q", out)
	}
	// pip and pre-1.24 Go have no add command leji could run, and no manager-less
	// outcome ever guesses one.
	for _, fixture := range []string{
		"python-bare-pyproject", "python-requirements-only", "go-1.23-legacy",
		"node-two-lockfiles", "node-refused-evidence", "node-unreadable-manifest",
		"node-packagemanager-unknown", "none", "multiple-ecosystems", "composite-ambiguity",
	} {
		offer, _, runs := runOffer(t, fixture, true, "y", AddResult{Started: true})
		if len(runs) != 0 || offer.Offered || offer.Ran || DependencyAddFailed(offer) {
			t.Errorf("%s: nothing to consent to", fixture)
		}
	}
}
