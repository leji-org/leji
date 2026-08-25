// Package lejiignore keeps the tool's own directory out of the repository from
// inside. A layer whose root `.gitignore` never received the `.leji/` line (adopted
// before the unified layout, or written by hand) otherwise grows an untracked
// generated tree at every command; one file inside `.leji/` closes that without
// touching the repository's own ignore rules.
//
// The file is written the first time a command creates a role under `.leji/`, and
// only there: nothing read-only ever creates it. What stands at the target decides
// the act, read through the verified read rather than a pathname check, so a file
// swapped between the look and the write is never written through.
package lejiignore

import (
	"fmt"
	"os"
	"sync"

	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/layout"
)

// Content is the whole file: ignore everything under `.leji/`, this file included.
// Nothing in that tree is committed by design, so the rule needs no exceptions and
// never grows any. A byte contract shared with the Node and Python SDKs.
const Content = "*\n"

// Notice is what a run says, once, when it left an existing file alone. Frozen text,
// on stderr under every output mode: it is an advisory about the repository, never
// part of a `--json` document.
const Notice = "leji: " + layout.LejiIgnoreRel + " exists and was left as is (expected content: *)"

// Context is one invocation's notice state. Created at the CLI command entry point
// and passed down every call path that can create a role, so one invocation says it
// once however many roles it establishes: `leji export` creates the viewer chrome and
// the export output and still notices once. A directly callable SDK function takes it
// as an optional trailing argument and passes it to whatever it nests; a direct caller
// that supplies none gets a context local to that call, so the documented behavior
// there is at most one notice per call. Deliberately not a package global: that would
// be process-scoped, and a long-lived host or a second repository in the same process
// would inherit a state that is not its own.
//
// The mutex is what makes one context safe to hand to concurrent establishers: the
// notice is said by whichever of them reaches it first, and once.
type Context struct {
	mu      sync.Mutex
	noticed bool
}

// NewContext is a fresh invocation context.
func NewContext() *Context {
	return &Context{}
}

// From is the context a variadic call site was handed, or nil when it was handed
// none: the Go spelling of the reference SDK's optional parameter, so a caller that
// has a context threads it and a direct caller that has none is left exactly as it
// was. EnsureFile reads nil as "a context local to this call".
func From(ctx ...*Context) *Context {
	if len(ctx) > 0 {
		return ctx[0]
	}
	return nil
}

// say emits the frozen notice unless this context already did.
func (c *Context) say() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.noticed {
		return
	}
	c.noticed = true
	fmt.Fprintln(os.Stderr, Notice)
}

// Outcome is what one EnsureFile call did.
type Outcome string

const (
	// Created is nothing standing there and the file created exclusively.
	Created Outcome = "created"
	// Present is a regular file already holding exactly these bytes.
	Present Outcome = "present"
	// LeftAsIs is a regular file holding something else: it is untouched and the
	// notice was emitted (once per context).
	LeftAsIs Outcome = "left-as-is"
	// Exists is an entry that appeared between the read and the exclusive create, so
	// the create found it and wrote nothing.
	Exists Outcome = "exists"
	// Refused is the boundary refusing the target (a symlink at `.leji` or at the
	// file, a non-regular entry, a containment failure); nothing was written.
	Refused Outcome = "refused"
)

// EnsureFile ensures `.leji/.gitignore` exists, at the one exception the write rule
// declares.
//
// Idempotent, and safe to call from every role establisher: the decision comes from
// fsx.VerifiedTargetRead (bytes read from the descriptor the rule cleared), and the
// create is exclusive through the guarded write path, so neither branch rests on a
// pathname that could change underneath it. A refusal is returned rather than raised;
// the calling command reports it the way it reports any refused write. An operational
// I/O failure travels out as an error, as a read by path always has.
//
// ctx nil means a context local to this call.
func EnsureFile(root string, ctx *Context) (Outcome, error) {
	if ctx == nil {
		ctx = NewContext()
	}
	rootReal := fsx.GuardRoot(root)
	abs := layout.Abs(rootReal, layout.LejiIgnoreRel)
	// Two looks at most. Another run creating this same file lands between the first
	// look and its verification, and a standing entry that could not be verified is
	// RefusedUnverifiable, which here is an ordinary concurrent create rather than a
	// refusal, so it is looked at once more and read as what it now is. Anything this
	// run genuinely cannot verify refuses on the second look exactly as on the first,
	// and every other refusal (a symlink, a non-regular entry, a containment failure)
	// is final at the first.
	for look := 0; look < 2; look++ {
		standing, err := fsx.VerifiedTargetRead(rootReal, abs, "")
		if err != nil {
			return Refused, err
		}
		if standing.Status == fsx.ReadRefused {
			if standing.Reason == fsx.RefusedUnverifiable && look == 0 {
				continue
			}
			return Refused, nil
		}
		if standing.Status == fsx.ReadRegular {
			if string(standing.Bytes) == Content {
				return Present, nil
			}
			// An empty file is the other half of that concurrent create: the winner has
			// opened it exclusively and not yet written its two bytes. Looking again
			// answers what it holds; a file that is genuinely empty answers the same
			// thing twice and is left alone like any other content.
			if len(standing.Bytes) == 0 && look == 0 {
				continue
			}
			// Someone else's file: never merged, never rewritten. The run says so once
			// and leaves the bytes exactly as they are.
			ctx.say()
			return LeftAsIs, nil
		}
		verdict, err := fsx.WriteFileGuarded(rootReal, abs, "", []byte(Content), fsx.WriteOptions{Exclusive: true})
		if err != nil {
			return Refused, err
		}
		if verdict.Exists {
			return Exists, nil
		}
		if verdict.OK {
			return Created, nil
		}
		return Refused, nil
	}
	return Refused, nil
}
