package initcmd

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"

	"github.com/leji-org/leji/packages/sdk-go/internal/ecosystem"
)

// AddResult is what running one manager add command did: the runner's own result
// type, where the start state lives. A spawn that never started reports Started
// false; a started run reports its exit code, and Signal when the runtime killed
// it. Transcribed from the TypeScript reference's spawnSync shape: error, then
// signal, then a non-zero code.
type AddResult struct {
	Started  bool
	ExitCode int
	Signal   string
}

// DependencyIO is injectable I/O for the declaration offer, so the interactive
// flow is deterministically testable and no test can reach a real package
// manager. DefaultDependencyIO is the production wiring.
type DependencyIO struct {
	// ReadLine prompts and returns one trimmed line; "" means accept the default.
	ReadLine func(question, fallback string) string
	// Run runs the manager's own add command from cwd, argv only and never a
	// shell, with the child inheriting the terminal so the user sees the manager's
	// own output.
	Run func(bin string, args []string, cwd string) AddResult
}

// DefaultDependencyIO wires a one-shot stdin line reader and an argv spawn.
func DefaultDependencyIO(in io.Reader, out io.Writer) *DependencyIO {
	hio := DefaultHandoffIO(in, out)
	return &DependencyIO{
		ReadLine: hio.ReadLine,
		Run: func(bin string, args []string, cwd string) AddResult {
			cmd := exec.Command(bin, args...)
			cmd.Dir = cwd
			cmd.Stdin = os.Stdin
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
			err := cmd.Run()
			if err == nil {
				return AddResult{Started: true, ExitCode: 0}
			}
			var exitErr *exec.ExitError
			if errors.As(err, &exitErr) {
				// The process started. A signalled child has no exit code of its own,
				// so the signal is what the outcome reports.
				if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
					return AddResult{Started: true, ExitCode: -1, Signal: SignalName(status.Signal())}
				}
				return AddResult{Started: true, ExitCode: exitErr.ExitCode()}
			}
			// Never started (ENOENT and friends): a missing binary, not a failed add.
			return AddResult{Started: false}
		},
	}
}

// DependencyOfferOptions configures OfferDependency, the post-scaffold
// declaration offer.
type DependencyOfferOptions struct {
	// Root is the absolute layer root: the cwd the manager runs in, so its manifest
	// and lock edits land in this repository and nowhere else.
	Root string
	// Report is the detection answer for Root.
	Report ecosystem.Report
	// Interactive is a real TTY, not --yes, and not --json; the manager never runs
	// otherwise.
	Interactive bool
	IO          *DependencyIO
}

// DependencyOffer is what the declaration step did, in the reference's shape:
// Ran means the add was consented to and attempted, and ExitCode and Signal are
// nullable exactly as they are in the `--json` contract. A signalled manager has
// no exit code of its own (ExitCode nil, Signal set), and a spawn that never
// started has neither (both nil with Ran true) — which counts as a failure just
// like a non-zero exit. The runner's start state stays in AddResult.
type DependencyOffer struct {
	Offered  bool
	Ran      bool
	Command  []string
	ExitCode *int
	Signal   *string
}

// DependencyAddFailed reports a consented add that did not succeed, so the
// command must not exit 0: the layer is written but the durable setup the run
// promised was not reached.
func DependencyAddFailed(offer DependencyOffer) bool {
	return offer.Ran && (offer.ExitCode == nil || *offer.ExitCode != 0 || offer.Signal != nil)
}

func intPtr(v int) *int       { return &v }
func sigPtr(v string) *string { return &v }

// OfferDependency tells the user how a clean install of this repository will
// bring leji, and offers to run their own package manager's add command. leji
// writes no manifest or lockfile byte itself: the manager owns both formats, so
// the only thing that changes the repository here is a command the user
// explicitly accepted.
//
// The block is ALWAYS printed (this function is simply not called under --json,
// which is a single-document mode). The prompt fires only when the run is
// interactive, an add command exists for the detected manager, and the CLI is not
// already declared.
func OfferDependency(opts DependencyOfferOptions, out io.Writer) DependencyOffer {
	fmt.Fprintln(out, "\n"+ecosystem.RenderBlock(opts.Report))
	selected := opts.Report.Selected
	var command []string
	if selected != nil && selected.Add != nil {
		command = selected.Add
	}
	offered := command != nil && !selected.DirectDeclared
	skipped := DependencyOffer{Offered: offered, Command: command}
	if !offered || !opts.Interactive {
		return skipped
	}

	dio := opts.IO
	if dio == nil {
		dio = DefaultDependencyIO(os.Stdin, out)
	}
	// Consent is only consent if it is informed: the manager runs here, as this
	// user, with this environment, and does whatever it normally does.
	fmt.Fprintln(out, ecosystem.ConsentDisclosure(command[0]))
	answer := strings.ToLower(dio.ReadLine(ecosystem.ConsentPrompt, "Y/n"))
	if !(answer == "" || answer == "y" || answer == "yes") {
		fmt.Fprintln(out, ecosystem.ConsentDeclined)
		fmt.Fprintln(out, ecosystem.ConsentCommand(command))
		return skipped
	}
	fmt.Fprintln(out, ecosystem.ConsentRunning(command))
	res := dio.Run(command[0], command[1:], opts.Root)
	attempted := DependencyOffer{Offered: offered, Ran: true, Command: command}
	// A spawn that never started surfaces as a start failure, never as an exit
	// code, so it is reported as a missing binary rather than as a failed add, and
	// it carries neither an exit code nor a signal.
	if !res.Started {
		fmt.Fprintln(out, ecosystem.ConsentMissing(command[0]))
		fmt.Fprintln(out, ecosystem.ConsentCommand(command))
		return attempted
	}
	if res.Signal != "" {
		fmt.Fprintln(out, ecosystem.ConsentSignaled(command[0], res.Signal))
		fmt.Fprintln(out, ecosystem.ConsentCommand(command))
		attempted.Signal = sigPtr(res.Signal)
		return attempted
	}
	attempted.ExitCode = intPtr(res.ExitCode)
	if res.ExitCode != 0 {
		fmt.Fprintln(out, ecosystem.ConsentExited(command[0], res.ExitCode))
		fmt.Fprintln(out, ecosystem.ConsentCommand(command))
		return attempted
	}
	fmt.Fprintln(out, ecosystem.ConsentDeclared(selected.Ecosystem))
	return attempted
}
