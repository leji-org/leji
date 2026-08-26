---
title: The Trust Boundary
summary: What the leji CLI guarantees about where it writes and what it reads, and the one mechanism in each SDK that holds the guarantee.
freshness:
  reviewAfter: 2027-02-17
---

# The trust boundary

The `leji` CLI runs on a repository it did not write, over a manifest and a content tree
anyone with commit access can change. Paths in that layer are input, not instruction: a
declared path, a `--out` argument, a directory that turns into a symlink between one
command and the next. This page states what the tool guarantees about the filesystem it
touches, and how each SDK holds the guarantee, so that a reviewer or an independent
implementer reads the same bar the reference implements.

## Two trust domains

**Repository content** is yours. The layer's markdown, its manifest, its index and
changelog: the tool reads them, validates them, and rewrites the artifacts it owns. Their
content is never trusted to decide where a write lands.

**The `.leji/` tree** is the tool's own domain, one directory at the repository root
holding a role per generated thing: `viewer/` (the generated chrome), `dist/` (the default
export output), `work/` (the transient onboarding workspace), and `mounts/` (the private
federation store and projection cache). It is gitignored. Exactly one role is servable,
`viewer/`, which is what the local preview server (`leji view`, `leji viewer serve`)
serves as the chrome around your content; every other role is denied by name, and no
export carries a byte of any of them.

The tree also ignores itself: the first time a command creates a role under `.leji/`,
it ensures `.leji/.gitignore` holds exactly `*`, so a repository whose own root
`.gitignore` never received the `.leji/` line still commits none of it. That one file
sits directly under `.leji/` and belongs to no role, which is why it is the single
named exception below.

## The containment rule

Every write and every clear is judged on the RESOLVED target, immediately before the act:

1. **Inside the repository, absolutely.** A target that resolves outside the repository
   root is refused, with no exceptions and no roles that soften it. A `.leji/dist` or
   `.leji/viewer` symlinked out of the tree does not relocate the output; it is refused
   and nothing is written through it. The exported folder is yours: copy it wherever your
   host reads from.
2. **Its own role, or no role.** A target that lands under root `.leji/` is refused unless
   the acting command owns that exact role. The export writes into `.leji/dist/` and
   nowhere else under `.leji/`; the viewer writes into `.leji/viewer/`; content such as
   `overview.md` has no `.leji/` role at all, so any `.leji/` landing refuses it. The
   metadata-file exception below is the one target this rule allows outside every role.
3. **Unresolvable is refused.** A path that cannot be resolved because of a permission or
   I/O error is not rebuilt from its spelling and written to. Only genuine absence is
   treated as a not-yet-created target, resolved through its nearest existing ancestor so
   a symlinked parent is caught before anything is created under it.

The rule is applied resolved against resolved, so a redirecting symlink, a symlink chain,
or a case-variant spelling such as `.LEJI/` on a case-insensitive filesystem is judged by
where it actually lands, never by how it was written. A refusal is hard: the command
reports it as a usage error, a build error, or an error finding, and nothing is written,
cleared, or renamed.

## The mechanism

Two sentences carry it, and every SDK implements both:

- **Every write and clear**: resolve the target natively, judge the resolved path against
  the rule, then act on that resolved path.
- **Every read whose bytes then decide an act**: open a verified descriptor and read from
  it, so the file that was judged is the file that is read. That covers every
  read-modify-write in the tool: the `.gitignore` merge, the manifest edit that binds an
  agent, the pre-commit hook merge, the CI workflow merge, the agent-host settings
  merge, the overview page the viewer seeds and then renders from,
  the stored index that generation carries ids from,
  the changelog compaction, the vendor entrypoints an adoption archives and rewrites,
  and the export marker that authorizes clearing a previous export.

No pathname existence check decides a write. A command that must know what stands at a
target before writing it uses the verified read: a regular file is compared or merged
from its own bytes, absence is the create path, and a refusal is that command's refusal
or its manual outcome, with nothing written. A command whose semantics is create-if-absent
writes exclusively (`O_EXCL`) through the chokepoint and treats the `exists` verdict as
its skip. A dangling symlink is a standing entry under both forms: never written through,
never read as absent.

### One chokepoint for writes

`guardedWrite` is the single place the rule lives. It resolves the target, applies the
rule, and performs the operation on the resolved path only when the target is allowed to
land there; on refusal it returns the verdict (outside the repository, the private role
crossed into, unresolvable) and touches nothing. Commands never spell a raw filesystem
write of their own. They call the guarded conveniences built on the chokepoint:

| Convenience | What it does |
| --- | --- |
| `writeFileGuarded` | write bytes, with an optional mode and an exclusive (`O_EXCL`) create |
| `mkdirpGuarded` | create a directory and its parents, returning the resolved directory |
| `rmGuarded` | clear a target recursively |
| `renameGuarded` | rename, with BOTH ends judged before either is touched |
| `chmodGuarded` | set a mode |
| `openWriteGuarded` | open a judged destination for writing and hand back the descriptor |
| `writeFileAtomicGuarded` | temp sibling plus rename, both paths judged, wholly inside the helper |

Parent directories are created only inside a write that actually happens, so a refused run
establishes nothing. A per-file check is not a formality on a tree that was already
judged: a descendant swapped to a symlink after the output directory was established is
caught at the file it would have redirected.

### Verified reads

`openVerifiedSource` resolves a source, judges the resolved path, opens it, and proves with
`fstat` that the descriptor is a regular file, then re-resolves and requires the same
location and the same `(device, inode)`. The bytes then come from the inode the check
cleared rather than from a path that could have changed underneath it.

`verifiedTargetRead` is the read-then-act form, for a command that must look at what is
standing at a target before writing it. The original directory entry decides its own kind
first, so a directory, a socket, a FIFO, or a link to one is refused rather than opened.
Absence is decided on that original entry, never on where it resolves: a dangling symlink
is a standing entry the run could not verify, so it is refused rather than written
through. Operational I/O failures on an allowed path propagate as failures; only
containment, entry kind, and verification become refusals.

## The declared exceptions

Each SDK enforces the boundary with a source-audit test. It parses every production source
file and looks for two things: any call into the filesystem's mutation surface (the
synchronous, callback, and promise forms alike, however the module was imported or the
call was spelled), and any call that hands work to a child process, which could write
whatever it likes. Each hit must be allowed by NAMED SYMBOL, with a reason; an allowance
that no longer matches anything fails too, so a stale exception cannot sit unread.

The allowed write symbols are the chokepoint's own helpers, the copy that writes into a
descriptor `openWriteGuarded` returned, and these three exceptions, which are all of them:

- **The federation per-entry protocol** (`lib/mounts`): materializing a pinned projection,
  publishing a cache entry by rename, and clearing its own staging directory use raw
  primitives under a store, cache, or staging root that the chokepoint established and
  returned. The protocol has its own closure rules (hashed identities, contained relative
  paths, symlink-escape refusals), and it never re-joins a path from the repository root.
- **Root bootstrap** (`init` and `adopt`): creating the directory the user named, which
  happens before there is a repository root for the rule to be about.
- **Verification staging under the OS temp directory**: verifying a cached projection is a
  read-only question, so asking it must not write into the tree being asked about.

### The metadata file, the one exception to the role rule

Everything above is about which symbols may touch the filesystem raw. One exception is
about the role rule itself: `.leji/.gitignore`, the file that keeps the tool's tree out
of the repository. It sits directly under `.leji/`, so it belongs to no role and rule 2
would refuse it. It is judged where the REQUESTED target is still visible, never by the
role rule, which sees only the resolved path, and only ALL THREE of these make it
writable:

1. the requested path is exactly the layer root's `.leji/.gitignore`, and it resolves to
   itself;
2. the root's `.leji` is a real directory, not a symlink;
3. the entry is absent or a regular file, not a symlink and not anything else.

Any other case is refused, never allowed: a `.leji` symlinked out of the tree refuses
exactly as it does today, and an entry that redirects onto ordinary content is refused
rather than written through. Each SDK constructs this verdict at exactly ONE named
symbol, which its source-audit test pins the way the write allow-list is pinned, so
the exception cannot quietly grow a second site. That pin covers every statically spelled
construction of the verdict, reflective forms included; a key assembled at runtime is the
one class no static audit can see, and it is named here so it is a known residual, not a
gap nobody looked at.

The file is written under the read-then-act rule like every other read-modify-write
here: what stands at the target is read verified, `*` plus a newline is created
exclusively when nothing does, a file already holding those bytes is left alone, and a
file holding anything else is left BYTE-IDENTICAL; the run says so once on stderr,
under every output mode including `--json`, and merges nothing.

The subprocess allowances are separate and just as explicit. Most are `git`, and all but
one of those are read-only queries about the host repository; the exception is the
federation resolver, whose `git init` and `git fetch` write only into a store or cache
directory the chokepoint established. Four allowances are not git: one opens the preview
URL in the desktop browser, two hand the finished scaffold to the agent host the user
selected, by launching it or by running the command it declares, an unrestricted child
process by nature whose writes are that program's rather than this tool's, and the fourth
is the hand-off below.

**The hand-off to a repository's own CLI.** The installed executable of the Node and
Python CLIs gives the WHOLE invocation to the Leji CLI a repository pins, so that a
teammate, a hook, CI, and a person typing `leji` all run one version of the tool. It
happens only when the repository DIRECTLY DECLARES the CLI in the manifest it commits,
the copy is installed INSIDE the repository (the executable, the package metadata, and
the entry that metadata declares all resolve, through every symlink, within the
repository root), the package identifies itself by name rather than by the spelling of a
directory, and its version meets the minimum the layer's spec line requires; the target
is never reached through a package manager, and the copy is never this running one. That
last check is made on the ENTRY the installed package declares rather than on the shim
that gets executed, because a package manager's shim may be a link to the entry or a
small script that runs it, and only the entry identifies the copy in both shapes.
Anything else hands off nothing and runs the global CLI exactly as before: a MANIFEST
that is refused, unreadable, or missing ends the question there, since it is what
declares the CLI at all. A refused LOCKFILE does not, because a lockfile only names
which manager owns the environment: a candidate whose shape cannot be verified is
ignored rather than fatal, so a repository whose remaining lock family verifies cleanly
still hands off, and one whose evidence is then ambiguous or absent falls to the same
rules as any other. `LEJI_NO_LOCAL`, set to any value, turns it off.

What that copy then receives is everything: the arguments as given, the full environment,
this terminal, and the working directory, on every invocation including `--version` and
`--help`. It is repository-local code, so this is a real grant, made deliberately and
narrowly, on the same evidence a person would use to run `npx leji` there. The metadata
that decides it is read through the verified read above, and every path is judged
resolved.

Every byte that SELECTS the copy is read that way, and the two runtimes reach that
differently because they select differently. The Node CLI takes the declaration from the
ordinary ecosystem scan: there the manager is not part of the answer, since the target is
the installed package at a fixed location, so that file is the repository author's
request for the hand-off and nothing more, and a swap between the scan and the verified
reads can only turn the request on or off. The Python CLI cannot say the same, because
its manager names the environment and therefore which console script would run, so it
does not consult the scan at all: it derives BOTH the declaration and the manager from
one verified read of the declaring manifest. The names it lists first decide only which
files it then opens verified, and a lockfile, whose whole evidence is its name, counts
only when that open succeeds, so a name with nothing behind it selects no environment.

The residual is the recorded check-before-act limit: a target swapped between the
check and the exec cannot be closed portably, so the window is stated here rather than
claimed away. A selected target that then fails to run is a hard failure, never a quiet
fall back to the global copy: falling back would run a different version of the tool
than the repository pinned, which is the outcome the hand-off exists to prevent.

## What this is not

It is not a sandbox, and it does not defend a machine against its own owner. `.leji/` is
gitignored, so what lands there arrives from a local run rather than from a clone. The
guarantee is about what the tool does with input it is given: no path in a layer, and no
argument on the command line, causes `leji` to write outside the repository it was pointed
at, to write into a role it does not own, or to act on bytes it did not verify.
