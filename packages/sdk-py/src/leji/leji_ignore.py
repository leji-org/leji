"""The self-managed ``.leji/.gitignore``: the tool ignores its own directory from
inside.

A layer whose root ``.gitignore`` never received the ``.leji/`` line (adopted before
the unified layout, or written by hand) otherwise grows an untracked generated tree at
every command; one file inside ``.leji/`` closes that without touching the
repository's own ignore rules.

The file is written the first time a command creates a role under ``.leji/``, and only
there: nothing read-only ever creates it. What stands at the target decides the act,
read through the verified read rather than a pathname check, so a file swapped between
the look and the write is never written through.

Mirrors packages/sdk/src/lib/leji-ignore.ts.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from typing import Literal, Optional

from .fsx import guard_root, verified_target_read, write_file_guarded
from .layout import LEJI_IGNORE_REL, role_abs

#: The whole file: ignore everything under ``.leji/``, this file included. Nothing in
#: that tree is committed by design, so the rule needs no exceptions and never grows
#: any. A byte contract shared with the Node and Go SDKs.
LEJI_IGNORE_CONTENT = "*\n"

#: What a run says, once, when it left an existing file alone. Frozen text, on stderr
#: under every output mode: it is an advisory about the repository, never part of a
#: ``--json`` document.
LEJI_IGNORE_NOTICE = f"leji: {LEJI_IGNORE_REL} exists and was left as is (expected content: *)"


@dataclass
class LejiIgnoreContext:
    """One invocation's notice state. Created at the CLI command entry point and passed
    down every call path that can create a role, so one invocation says it once however
    many roles it establishes: ``leji export`` creates the viewer chrome and the export
    output and still notices once. A directly callable SDK function takes it as an
    optional parameter and passes it to whatever it nests; a direct caller that supplies
    none gets a context local to that call, so the documented behavior there is at most
    one notice per call. Deliberately not a module global: that would be process-scoped,
    and a long-lived host or a second repository in the same process would inherit a
    state that is not its own."""

    noticed: bool = False

    def say(self) -> None:
        """Emit the frozen notice unless this context already did."""
        if self.noticed:
            return
        self.noticed = True
        print(LEJI_IGNORE_NOTICE, file=sys.stderr)


def new_leji_ignore_context() -> LejiIgnoreContext:
    """A fresh invocation context."""
    return LejiIgnoreContext()


#: What one :func:`ensure_leji_ignore_file` call did:
#:
#: - ``created``: nothing stood there and the file was created exclusively;
#: - ``present``: a regular file already holds exactly these bytes;
#: - ``left-as-is``: a regular file holds something else; it is untouched and the
#:   notice was emitted (once per context);
#: - ``exists``: an entry appeared between the read and the exclusive create, so the
#:   create found it and wrote nothing;
#: - ``refused``: the boundary refused the target (a symlink at ``.leji`` or at the
#:   file, a non-regular entry, a containment failure); nothing was written.
LejiIgnoreOutcome = Literal["created", "present", "left-as-is", "exists", "refused"]


def ensure_leji_ignore_file(
    root: str, ctx: Optional[LejiIgnoreContext] = None
) -> LejiIgnoreOutcome:
    """Ensure ``.leji/.gitignore`` exists, at the one exception the write rule declares.

    Idempotent, and safe to call from every role establisher: the decision comes from
    :func:`~leji.fsx.verified_target_read` (bytes read from the descriptor the rule
    cleared), and the create is exclusive through the guarded write path, so neither
    branch rests on a pathname that could change underneath it. A refusal is returned
    rather than raised; the calling command reports it the way it reports any refused
    write.

    ``ctx`` None means a context local to this call."""
    if ctx is None:
        ctx = new_leji_ignore_context()
    root_real = guard_root(root)
    abs_path = role_abs(root_real, LEJI_IGNORE_REL)
    # Two looks at most. Another run creating this same file lands between the first
    # look and its verification, and a standing entry that could not be verified is
    # `unverifiable`, which here is an ordinary concurrent create rather than a
    # refusal, so it is looked at once more and read as what it now is. Anything this
    # run genuinely cannot verify refuses on the second look exactly as on the first,
    # and every other refusal (a symlink, a non-regular entry, a containment failure)
    # is final at the first.
    for look in range(2):
        standing = verified_target_read(root_real, abs_path, None)
        if standing.status == "refused":
            if standing.reason == "unverifiable" and look == 0:
                continue
            return "refused"
        if standing.status == "regular":
            if standing.data == LEJI_IGNORE_CONTENT.encode("utf-8"):
                return "present"
            # An empty file is the other half of that concurrent create: the winner has
            # opened it exclusively and not yet written its two bytes. Looking again
            # answers what it holds; a file that is genuinely empty answers the same
            # thing twice and is left alone like any other content.
            if len(standing.data) == 0 and look == 0:
                continue
            # Someone else's file: never merged, never rewritten. The run says so once
            # and leaves the bytes exactly as they are.
            ctx.say()
            return "left-as-is"
        verdict = write_file_guarded(root_real, abs_path, None, LEJI_IGNORE_CONTENT, exclusive=True)
        if verdict.exists:
            return "exists"
        return "created" if verdict.ok else "refused"
    return "refused"
