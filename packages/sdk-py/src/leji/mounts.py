"""The federation resolver: materializes a mount's pinned layer projection into
the gitignored cache under ``.leji/mounts/`` (distribution.md pattern 3).

Mirrors packages/sdk/src/lib/mounts.ts byte-for-byte in behavior and output.

Contracts (per the resolver-only mounts design):
- The pin is resolved from a git object store, never a working tree.
- the projection extracts the sibling's leji.json, its rootPath tree, and its
  agent-profiles path if outside rootPath; nothing else. Gitlinks are recorded
  in metadata, never materialized; LFS pointers extract as the pointers they are.
- Caches are keyed by sha256(source identity \\n pin \\n cache format version) and
  published by rename-if-absent under a ``complete`` marker; no global lock.
- The sidecar is evidence, never proof: verification reads the object store.
- No network unless the caller passes fetch=True (git fetch into the
  resolver-managed store); everything else is offline.
- The witness namespace is the resolver's own: ``hydrate --fetch`` writes
  refs/leji-witness/v1/ in the managed store and nothing else does, so pin
  ancestry has a ref to compare against without ``status`` ever fetching.
"""

from __future__ import annotations

import datetime as dt
import errno
import hashlib
import json
import os
import posixpath
import re
import secrets
import shutil
import stat as statmod
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Literal, cast

from .fsx import resolved_within_root
from .manifest import Manifest, all_strings_scalar
from .schemas import schema_errors

# The single cache-invalidation epoch: bump it and every key changes.
# "2": the projection closure (boot profile, machine artifacts, category indexes,
# bound agent profiles, indexed governed paths) replaced the root-tree-only
# extraction; entries under "1" hold incomplete projections for the same pin.
CACHE_FORMAT_VERSION = "2"

# The resolver-owned witness namespace in the managed store, and the pin
# namespace that keeps the version of record from being pruned.
WITNESS_REF_NAMESPACE = "refs/leji-witness"
PIN_REF_NAMESPACE = "refs/leji-pin"

# Normative projection limits, identical across SDKs.
MAX_PROJECTION_FILES = 65536
MAX_PROJECTION_BYTES = 2 * 1024 * 1024 * 1024
MAX_PROJECTION_PATH = 4096

# What one whole-tree listing may occupy in transport.
#
# This bounds tree *metadata* -- one mode/type/oid/path record per entry in the
# pinned commit -- not projected content, which is what MAX_PROJECTION_BYTES caps.
# The two are deliberately different numbers: the listing enumerates the entire
# repository so that selection can happen in-process, so capping it at the content
# limit would fail a large repository that holds a perfectly small valid
# projection. At the normative 65,536-file limit this leaves about 4 KiB per entry,
# against a path limit of MAX_PROJECTION_PATH and roughly 60 bytes of fixed record
# overhead.
MAX_TREE_LISTING_BYTES = 256 * 1024 * 1024

# Node's execFileSync default, applied to every other git call so a runaway
# output fails the same way in all three SDKs.
_DEFAULT_MAX_BUFFER = 64 * 1024 * 1024

# Why a projection failed, tagged where the failure is created and carried outward
# unchanged. "unavailable" is degraded knowledge of the pinned layer (the
# declaration is sound; the pin's content is missing or malformed), "safety" is a
# guard the projection refuses to cross. Nothing downstream re-derives the class
# from the detail text: a stable sentence is output, never a classifier.
ProjectionFailureKind = Literal["unavailable", "safety"]


@dataclass
class MountDecl:
    name: str
    source: str
    pin: str
    tracking_ref: str | None = None


@dataclass
class GitResult:
    ok: bool
    stdout: bytes
    # git's exit status: callers that read an answer out of it (merge-base) must
    # separate the answer's exit codes from operational failure. None = unknown.
    code: int | None = None
    error: str | None = None
    # The output did not fit ``max_buffer``. Tagged here, where the reader still
    # knows why it stopped, so no caller has to recognize a transport failure by
    # its message.
    overflowed: bool = False


@dataclass
class ObjectSource:
    repo: str | None
    kind: str | None  # 'hint' | 'store' | 'submodule' | None
    ambiguous: bool = False


@dataclass
class FetchResult:
    repo: str | None
    # Set only when this run attempted the witness refresh and it did not publish.
    # The run reporting on itself, never a remembered observation.
    witness_refresh_failed: bool = False
    error: str | None = None


@dataclass
class ProjectionResult:
    ok: bool
    error: str | None = None
    # Set with ``error``, never without it.
    kind: str | None = None
    commit: str | None = None
    tree: str | None = None
    files: int | None = None
    bytes: int | None = None
    gitlinks: list[dict[str, str]] | None = None
    sibling_name: str | None = None


@dataclass
class HydrateResult:
    outcomes: list[dict[str, object]]
    fatal: str | None = None


def read_text_within(root: str, abs_path: Path) -> str | None:
    """Read a declared file's text, only if it is a regular file whose real path
    stays within ``root``. Returns None when missing, not a regular file, or
    symlinked out of root. Mirrors Node's readTextWithin; the single shared
    implementation for resolver-state reads (validate.py imports it too)."""
    p = Path(abs_path)
    if not p.is_file() or not resolved_within_root(root, p):
        return None
    return p.read_text(encoding="utf-8")


_SCP_RE = re.compile(r"^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(?!//)(.+)$")
_URL_RE = re.compile(r"^(https|ssh)://(?:([^@/]+)@)?([A-Za-z0-9.-]+)(?::(\d+))?/(.*)$")


def normalize_source(raw: str) -> str | None:
    """Normalize a repository locator to its canonical identity: https://, ssh://,
    or SCP-style (git@host:path, rewritten to ssh://git@host/path). Lowercases
    scheme and host, strips userinfo except the ssh user, strips one trailing "/"
    and one trailing ".git". Returns None for anything else (local paths belong
    in hints)."""
    s = raw.strip()
    if s == "":
        return None
    # SCP-style: user@host:path (no scheme, single colon before the path).
    scp = _SCP_RE.match(s)
    if scp:
        s = f"ssh://{scp.group(1)}@{scp.group(2)}/{scp.group(3)}"
    m = _URL_RE.match(s)
    if not m:
        return None
    scheme = m.group(1).lower()
    user = m.group(2)
    host = m.group(3).lower()
    port = f":{m.group(4)}" if m.group(4) else ""
    p = m.group(5)
    if p.endswith("/"):
        p = p[:-1]
    if p.endswith(".git"):
        p = p[:-4]
    if p == "" or "\\" in p:
        return None
    # Userinfo is stripped except the ssh user; credentials never enter identities.
    user_part = f"{user.split(':')[0]}@" if scheme == "ssh" and user else ""
    return f"{scheme}://{user_part}{host}{port}/{p}"


def sha256_hex(data: str | bytes) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def cache_key_for(source_identity: str, pin: str) -> str:
    return sha256_hex(f"{source_identity}\n{pin}\n{CACHE_FORMAT_VERSION}")


def _join(*parts: str) -> str:
    """Node's path.join: join then normalize, so '.'/'..' segments collapse
    ('host' + '../sibling' -> 'sibling'). os.path.join alone does not normalize,
    which would leak into emitted paths (repository, projection path)."""
    return os.path.normpath(os.path.join(*parts))


def mounts_dir(root: str) -> str:
    return _join(root, ".leji", "mounts")


def read_hints(root: str) -> dict[str, str]:
    """Machine-local resolution hints (never committed): .leji/mounts.local.json."""
    raw = read_text_within(root, Path(root) / ".leji" / "mounts.local.json")
    if raw is None:
        return {}
    try:
        parsed = json.loads(raw)
        out: dict[str, str] = {}
        mounts = parsed.get("mounts") if isinstance(parsed, dict) else None
        for name, entry in (mounts if isinstance(mounts, dict) else {}).items():
            if isinstance(entry, dict):
                repo = entry.get("repo")
                if isinstance(repo, str) and repo != "":
                    out[name] = repo
        return out
    except Exception:
        return {}


def run_git(
    args: list[str], cwd: str | None = None, max_buffer: int = _DEFAULT_MAX_BUFFER
) -> GitResult:
    """Run git with a fixed, non-interactive environment; argv-array only, never
    a shell. Mirrors the Node runGit contract (ok / stdout bytes / error from
    stderr trimmed / overflowed when the output exceeded ``max_buffer``)."""
    env = dict(os.environ)
    env.update(
        {
            "LC_ALL": "C",
            "GIT_PAGER": "cat",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_OPTIONAL_LOCKS": "0",
            # A promisor clone used as a hint or submodule would otherwise reach
            # the network from commands documented as offline.
            "GIT_NO_LAZY_FETCH": "1",
        }
    )
    try:
        r = subprocess.run(
            ["git", "--no-replace-objects", *args],
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
        )
    except OSError as e:
        return GitResult(ok=False, stdout=b"", code=None, error=str(e) or "git failed")
    stderr = r.stderr.decode("utf-8", errors="replace").strip()
    # The output did not fit the buffer: the reader's own signal, never a message
    # match. Node surfaces the same condition as ENOBUFS with no exit status.
    if len(r.stdout) > max_buffer:
        return GitResult(
            ok=False,
            stdout=b"",
            code=None,
            error=stderr or "git failed",
            overflowed=True,
        )
    if r.returncode != 0:
        return GitResult(ok=False, stdout=b"", code=r.returncode, error=stderr or "git failed")
    return GitResult(ok=True, stdout=r.stdout, code=0)


def _is_git_repo(directory: str) -> bool:
    if not os.path.isdir(directory):
        return False
    return run_git(["-C", directory, "rev-parse", "--git-dir"]).ok


def _has_commit(repo: str, pin: str) -> bool:
    return run_git(["-C", repo, "cat-file", "-e", f"{pin}^{{commit}}"]).ok


def _rev_oid(repo: str, rev: str) -> str | None:
    """Resolve a revision to a commit id in ``repo``; None when it does not resolve."""
    r = run_git(["-C", repo, "rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}"])
    return r.stdout.decode("utf-8").strip() if r.ok else None


def _ref_oid(repo: str, ref: str) -> str | None:
    """The raw object a ref points at, unpeeled; None when the ref does not exist."""
    r = run_git(["-C", repo, "rev-parse", "--verify", "--quiet", ref])
    return r.stdout.decode("utf-8").strip() if r.ok else None


def _store_dir(root: str, source_identity: str) -> str:
    """The resolver-managed bare store for a source identity."""
    return _join(mounts_dir(root), "store", sha256_hex(source_identity))


# Control characters, space, and the glob and revision metacharacters git forbids.
_REF_META_RE = re.compile(r"[\x00-\x20\x7F~^:?*\[\\]")


def valid_tracking_ref(ref: str) -> bool:
    """A declared witness ref is a fully qualified branch or tag that ``git
    check-ref-format`` would accept: no control characters, whitespace, glob or
    revision metacharacters, no ``..``, ``@{``, empty or dot-leading component,
    ``.lock`` suffix, or trailing ``/`` or ``.``."""
    if not (ref.startswith("refs/heads/") or ref.startswith("refs/tags/")):
        return False
    if _REF_META_RE.search(ref):
        return False
    if ".." in ref or "@{" in ref:
        return False
    if ref.endswith("/") or ref.endswith("."):
        return False
    components = ref.split("/")
    if len(components) < 3:
        return False
    return all(c != "" and not c.startswith(".") and not c.endswith(".lock") for c in components)


def witness_ref_for(source_identity: str, tracking_ref: str) -> str:
    """The managed witness ref for a source and its tracking ref:
    refs/leji-witness/v1/<sha256(identity)>/<sha256(trackingRef)>. Both components
    are fixed-length lowercase hex, so no declaration can outgrow a filesystem's
    per-component limit and no case-insensitive filesystem folds two onto one."""
    return f"{WITNESS_REF_NAMESPACE}/v1/{sha256_hex(source_identity)}/{sha256_hex(tracking_ref)}"


def pin_ref_for(source_identity: str, pin_oid: str) -> str:
    """The ref that retains a pin in the managed store:
    refs/leji-pin/v1/<source-key>/<oid>. A fetch leaves the pin reachable only
    through FETCH_HEAD, which the witness fetch then overwrites — without this
    ref, git maintenance may prune the version of record."""
    return f"{PIN_REF_NAMESPACE}/v1/{sha256_hex(source_identity)}/{pin_oid}"


_SUBMODULE_SECTION_RE = re.compile(r'^\s*\[submodule\s+"(.+)"\]\s*$')
_SUBMODULE_PATH_RE = re.compile(r"^\s*path\s*=\s*(.+?)\s*$")
_SUBMODULE_URL_RE = re.compile(r"^\s*url\s*=\s*(.+?)\s*$")


def _submodule_candidates(root: str, source_identity: str) -> list[str]:
    """Discover host submodules whose .gitmodules URL normalizes to the identity."""
    raw = read_text_within(root, Path(root) / ".gitmodules")
    if raw is None:
        return []
    out: list[str] = []
    current_path: str | None = None
    for line in raw.split("\n"):
        if _SUBMODULE_SECTION_RE.match(line):
            current_path = None
        pm = _SUBMODULE_PATH_RE.match(line)
        if pm:
            current_path = pm.group(1)
        um = _SUBMODULE_URL_RE.match(line)
        if um and current_path:
            ident = normalize_source(um.group(1))
            if ident is not None and ident == source_identity:
                out.append(_join(root, current_path))
    return [p for p in out if _is_git_repo(p)]


def object_source_candidates(
    root: str, mount: MountDecl, source_identity: str
) -> tuple[list[ObjectSource], bool]:
    """Every object source holding the pin, in the deterministic offline
    precedence: explicit hint, then the resolver-managed store, then a unique
    matching submodule. Ambiguous submodule matches are reported, never ordered
    around: the flag is about the submodules alone, because a caller that walks
    past the other candidates ends up with repositories it never consulted either
    way. Callers needing a second operand (a witness ref) walk the list; callers
    needing only the pin take the first."""
    candidates: list[ObjectSource] = []
    hint = read_hints(root).get(mount.name)
    if hint:
        abs_hint = hint if os.path.isabs(hint) else _join(root, hint)
        if _is_git_repo(abs_hint) and _has_commit(abs_hint, mount.pin):
            candidates.append(ObjectSource(repo=abs_hint, kind="hint"))
    store = _store_dir(root, source_identity)
    if _is_git_repo(store) and _has_commit(store, mount.pin):
        candidates.append(ObjectSource(repo=store, kind="store"))
    subs = _submodule_candidates(root, source_identity)
    if len(subs) == 1 and _has_commit(subs[0], mount.pin):
        candidates.append(ObjectSource(repo=subs[0], kind="submodule"))
    return candidates, len(subs) > 1


def find_object_source(root: str, mount: MountDecl, source_identity: str) -> ObjectSource:
    """The first object source holding the pin: what hydration projects from."""
    candidates, ambiguous = object_source_candidates(root, mount, source_identity)
    if candidates:
        return candidates[0]
    return ObjectSource(repo=None, kind=None, ambiguous=ambiguous)


def fetch_into_store(root: str, mount: MountDecl, source_identity: str) -> FetchResult:
    """Fetch the pin and refresh the managed witness ref in the store. This is the
    only writer of the witness namespace: ``status`` never fetches, so a mount
    whose pin a hint already resolves still needs its store populated here."""

    def failed(error: str) -> FetchResult:
        # Details are stable, Leji-authored text: git stderr never reaches output.
        return FetchResult(repo=None, error=error)

    # The locator becomes argv here: anything option-shaped is refused, never passed.
    if mount.source.startswith("-"):
        return failed('the source locator may not begin with "-"')
    store = _store_dir(root, source_identity)
    if not _is_git_repo(store):
        Path(store).mkdir(parents=True, exist_ok=True)
        if not run_git(["init", "--bare", "-q", store]).ok:
            return failed("the managed store could not be initialized")
    # The pin is immutable: a store that already holds it needs no round trip. The
    # declared pin is resolved directly, never read back out of FETCH_HEAD, so the
    # fetch has no reason to write one and races with a concurrent fetch.
    if not _has_commit(store, mount.pin):
        fetch = run_git(
            [
                "-C",
                store,
                "-c",
                "fetch.recurseSubmodules=no",
                "fetch",
                "-q",
                "--no-write-fetch-head",
                mount.source,
                mount.pin,
            ]
        )
        if not fetch.ok:
            return failed("the pin could not be fetched from the source")
    # Retain the pin by a ref of our own: without it, git maintenance may prune the
    # version of record.
    pin_oid = _rev_oid(store, mount.pin)
    if pin_oid is None:
        return failed("fetched, but the pin is not reachable")
    if not run_git(["-C", store, "update-ref", pin_ref_for(source_identity, pin_oid), pin_oid]).ok:
        return failed("the pin could not be retained by a ref in the managed store")
    # The witness refresh is the second half of what ``--fetch`` was asked to do, so
    # a run that attempts it and does not publish says so on its own terms. Reported
    # only when it was actually attempted: a run that never got this far has already
    # reported the fetch failure that stopped it.
    if mount.tracking_ref is not None and valid_tracking_ref(mount.tracking_ref):
        if not _refresh_witness(store, mount, source_identity):
            return FetchResult(repo=store, witness_refresh_failed=True)
    return FetchResult(repo=store)


def _refresh_witness(store: str, mount: MountDecl, source_identity: str) -> bool:
    """Refresh the managed witness ref: fetch the tracking ref to a unique
    temporary ref, publish it onto the canonical witness with git's own
    compare-and-swap, then drop the temporary. Forced (``+``), so the witness
    follows a non-fast-forward upstream move. No lock: git's ref update is
    atomic, a lost swap means another writer published first (a valid outcome),
    and a failure leaves the previous witness in place."""
    tracking_ref = cast("str", mount.tracking_ref)
    witness_ref = witness_ref_for(source_identity, tracking_ref)
    temp_ref = f"{WITNESS_REF_NAMESPACE}/tmp/{os.getpid()}-{secrets.token_hex(8)}"
    spec = f"+{tracking_ref}:{temp_ref}"
    fetch = run_git(
        ["-C", store, "-c", "fetch.recurseSubmodules=no", "fetch", "-q", mount.source, spec]
    )
    tip = _ref_oid(store, temp_ref) if fetch.ok else None
    # An empty <oldvalue> is git's "must not exist yet".
    expected = _ref_oid(store, witness_ref) or ""
    published = False
    if tip is not None:
        if run_git(["-C", store, "update-ref", witness_ref, tip, expected]).ok:
            published = True
        else:
            # A lost compare-and-swap is only a confirmed mismatch on <oldvalue>:
            # another writer published while we fetched, which is a valid outcome.
            # Permission, malformed-ref, lock and disk failures are not lost races,
            # so the ref itself decides — a valid witness present means someone
            # published, anything else is an operational failure that must not read
            # as success.
            current = _ref_oid(store, witness_ref)
            published = current is not None and current != expected
    # Cleanup is not part of the outcome: the canonical ref has already moved, and
    # a surviving temporary is inert (nothing reads the tmp namespace as a witness).
    run_git(["-C", store, "update-ref", "-d", temp_ref])
    return published


@dataclass
class _TreeEntry:
    mode: str
    type: str
    oid: str
    rel_path: str


def _list_tree(
    repo: str, pin: str, selects_raw_path: Callable[[bytes], bool]
) -> tuple[list[_TreeEntry], str | None, str | None]:
    """Every entry in the pinned tree, enumerated once and selected from in-process.

    Deliberately no pathspec: a declared path is a *name*, and git would read it as
    a glob, so a governed file called ``a[b].md`` selects ``ab.md`` and reports
    itself missing. One argv per indexed path also reaches ARG_MAX long before the
    file-count limit does. Both hazards are structural, and both disappear when the
    only thing git is asked for is the tree.

    Because the enumeration is the whole repository, nothing here may fail on an
    entry the projection does not select. A path with no UTF-8 form is therefore
    routed by ``selects_raw_path`` before it is judged: inside the projection it is
    the safety failure it has always been, outside it is another repository's
    business. Returns (entries, error, kind)."""
    args = ["-C", repo, "ls-tree", "-r", "-z", "--full-tree", pin]
    r = run_git(args, max_buffer=MAX_TREE_LISTING_BYTES)
    if not r.ok:
        # Transport, not content: the listing did not fit, so nothing can be said
        # about the projection either way.
        if r.overflowed:
            return [], "the pinned tree listing exceeds the transport limit", "safety"
        return [], "the pinned tree could not be listed", "safety"
    entries: list[_TreeEntry] = []
    for chunk in r.stdout.split(b"\0"):
        if chunk == b"":
            continue
        tab = chunk.find(b"\t")
        if tab < 0:
            continue
        header = chunk[:tab].decode("latin-1").split(" ")
        mode, type_, oid = header[0], header[1], header[2]
        raw_path = chunk[tab + 1 :]
        # Node decodes utf8 with replacement then compares the re-encoding; a
        # mismatch is a non-UTF-8 path (the error carries the replaced text).
        utf8 = raw_path.decode("utf-8", errors="replace")
        if utf8.encode("utf-8") != raw_path:
            # The routing decision needs no decode: the selections compare as bytes.
            if not selects_raw_path(raw_path):
                continue
            return [], f"non-UTF-8 path in the pinned tree: {utf8}", "safety"
        entries.append(_TreeEntry(mode=mode, type=type_, oid=oid, rel_path=utf8))
    return entries, None, None


def _cat_blob(repo: str, oid: str) -> bytes | None:
    r = run_git(["-C", repo, "cat-file", "blob", oid], max_buffer=MAX_PROJECTION_BYTES)
    return r.stdout if r.ok else None


def _contained_rel_path(p: str) -> bool:
    # UTF-8 bytes, which is the unit the limit is declared in and the only one the
    # three SDKs can agree on: ``len`` is code points here, UTF-16 code units in
    # Node and bytes in Go, so one constant was three different thresholds and a
    # path of astral characters crossed them at three different lengths.
    if p == "" or len(p.encode("utf-8")) > MAX_PROJECTION_PATH:
        return False
    if p.startswith("/") or "\\" in p:
        return False
    return all(s not in ("", ".", "..") for s in p.split("/"))


def _is_record(v: object) -> bool:
    """A parsed JSON value that may be dereferenced as a mapping. Pinned content is
    untrusted and only has to be valid JSON to get this far, so every property
    access on it clears this first."""
    return isinstance(v, dict)


def _declared_dir(p: str) -> str | None:
    """Normalize a manifest-declared directory path ("docs/", "./docs") to a prefix."""
    s = p.strip()
    if s.startswith("./"):
        s = s[2:]
    while s.endswith("/"):
        s = s[:-1]
    if s in ("", "."):
        return ""
    return s if _contained_rel_path(s) else None


def _declared_file(p: str) -> str | None:
    """Normalize a manifest-declared file path ("./docs/x.md") for use as a selection."""
    s = p.strip()
    if s.startswith("./"):
        s = s[2:]
    return s if _contained_rel_path(s) else None


def _join_posix(prefix: str, name: str) -> str:
    """POSIX join for a possibly-empty prefix ('' means repository root)."""
    return name if prefix == "" else f"{prefix}/{name}"


def _strip_trailing_slashes(p: str) -> str:
    """Every trailing ``/`` removed. A resolved symlink target names an entry, and an
    entry's name never ends in a separator; the three runtimes' path normalizers
    disagree about whether one survives."""
    while len(p) > 1 and p.endswith("/"):
        p = p[:-1]
    return p


def _posix_normalize(p: str) -> str:
    """path.posix.normalize: normpath that preserves a single trailing slash."""
    n = posixpath.normpath(p)
    if p.endswith("/") and not n.endswith("/"):
        n += "/"
    return n


_ASCII_FOLD = str.maketrans(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "abcdefghijklmnopqrstuvwxyz",
)


def _ascii_fold(s: str) -> str:
    """ASCII-only case folding: the portable rule the case-collision check uses, and
    the porting contract for it. ``A``-``Z`` fold to ``a``-``z``; every other code
    point is left exactly as it is.

    Deliberately not the runtime's own lowercase mapping. JavaScript's
    ``toLowerCase``, Go's ``strings.ToLower`` and Python's ``str.lower`` implement
    different Unicode versions with different special cases, so the same pinned tree
    can collide in one SDK and not in another; a shared versioned Unicode table was
    considered and rejected, because pinning a table version is the same problem one
    layer down. The cost is stated rather than hidden: a case-insensitive filesystem
    that folds non-ASCII will still collide on a pair this check passes, so the guard
    is a portable floor, not a claim about any particular filesystem.

    Byte-safe in every SDK: no byte of a multi-byte UTF-8 sequence falls in
    0x41-0x5A."""
    return s.translate(_ASCII_FOLD)


def _is_under_any(rel_path: str, prefixes: list[str]) -> bool:
    for p in prefixes:
        if p in (".", ""):
            return True
        if rel_path == p or rel_path.startswith(p + "/"):
            return True
    return False


@dataclass
class _ClosureResult:
    ok: bool
    error: str | None = None
    # Set with ``error``, never without it.
    kind: str | None = None
    commit: str | None = None
    tree: str | None = None
    sibling_name: str | None = None
    # Directory prefixes ('.' = whole tree) -- the symlink-containment set.
    prefixes: list[str] = field(default_factory=list)
    # Blob entries to materialize, deduplicated, path-validated.
    writes: list[tuple[str, str, int]] = field(default_factory=list)
    symlinks: list[tuple[str, str]] = field(default_factory=list)
    gitlinks: list[dict[str, str]] = field(default_factory=list)


def _compute_closure(repo: str, pin: str) -> _ClosureResult:  # noqa: C901
    """Compute the layer-projection closure at a pinned commit: the deduplicated
    union of the root manifest, the rootPath tree, the boot profile, the machine
    artifacts when present, the profiles/decisions trees when present, every bound
    agent profile, every category index, and every governed path in the pinned
    generated index. The sibling's own manifest at the pin defines the projection;
    the host never curates it.

    The failure boundary: a referenced or schema-required file absent from the
    pinned tree fails the closure with a code naming the declaring artifact and the
    missing path; an absent directory or an absent defaulted machine artifact
    contributes nothing (git cannot represent an empty directory; a core layer has
    no index). Everything runs against the object store only -- no working tree, no
    network.

    Every failure is tagged with its class where it is created, so the caller
    decides unavailability from provenance rather than from the sentence it is
    about to print."""

    def unavailable(error: str) -> _ClosureResult:
        return _ClosureResult(ok=False, error=error, kind="unavailable")

    def unsafe(error: str) -> _ClosureResult:
        return _ClosureResult(ok=False, error=error, kind="safety")

    commit_r = run_git(["-C", repo, "rev-parse", f"{pin}^{{commit}}"])
    if not commit_r.ok:
        return unavailable("pin does not resolve to a commit")
    commit = commit_r.stdout.decode("utf-8").strip()
    tree_r = run_git(["-C", repo, "rev-parse", f"{pin}^{{tree}}"])
    tree = tree_r.stdout.decode("utf-8").strip() if tree_r.ok else ""

    manifest_raw = run_git(["-C", repo, "cat-file", "blob", f"{commit}:leji.json"])
    if not manifest_raw.ok:
        return unavailable("the pinned tree has no leji.json at its root")
    try:
        parsed_manifest = json.loads(manifest_raw.stdout.decode("utf-8"))
    except Exception:
        return unavailable("the pinned leji.json is not valid JSON")
    # A sibling manifest is untrusted input like any other: its strings reach
    # hashing, sorting and path construction, so they clear the same scalar gate as
    # the host's. The gate runs before the shape guard, so a malformed string is
    # reported as the safety failure it is whatever shape carried it.
    if not all_strings_scalar(parsed_manifest):
        return unsafe("the pinned leji.json contains a malformed string")
    if not _is_record(parsed_manifest):
        return unavailable("the pinned leji.json is not an object")
    # A mapping, which is all the guard proves: every field below is still checked
    # for its own type before it is used.
    sibling: dict[str, object] = parsed_manifest
    root_path = sibling.get("rootPath")
    if not isinstance(root_path, str):
        return unavailable("the pinned leji.json declares no rootPath")
    root_prefix = _declared_dir(root_path)
    if root_prefix is None:
        return unsafe(f"uncontained rootPath: {root_path}")

    # Every mapping the closure is about to walk, checked once here rather than at
    # each property access. Absent is normal and contributes nothing; present but
    # not a mapping is an ordinary sibling-shape defect, so it is unavailability.
    if "machine" in sibling and not _is_record(sibling["machine"]):
        return unavailable("the pinned leji.json has no machine object")
    machine: dict[str, object] = sibling["machine"] if "machine" in sibling else {}  # type: ignore[assignment]
    # One level down, because the declared type is a claim about the host's own
    # manifest and says nothing about pinned bytes. A present non-string here either
    # raises in the path helpers or reads as absent and silently defaults, and a
    # default is not what the sibling declared. Absent is absent, which is normal.
    for name in ("indexPath", "changelogPath", "agentProfilesPath", "decisionRecordsPath"):
        if name in machine and not isinstance(machine[name], str):
            return unavailable(f"the pinned leji.json machine.{name} is not a string")
    if "categories" in sibling and not _is_record(sibling["categories"]):
        return unavailable("the pinned leji.json has no categories object")
    if "agents" in sibling and not _is_record(sibling["agents"]):
        return unavailable("the pinned leji.json has no agents object")

    # Directory selections. Absence contributes nothing: a selection matching no
    # entry is an empty contribution, never a failure.
    prefixes: list[str] = []

    def add_prefix(p: str) -> None:
        if p not in prefixes:
            prefixes.append(p)

    add_prefix("." if root_prefix == "" else root_prefix)
    for name in ("agentProfilesPath", "decisionRecordsPath"):
        raw = machine.get(name)
        if not isinstance(raw, str):
            continue
        d = _declared_dir(raw)
        if d is None:
            return unsafe(f"uncontained {name}: {raw}")
        if (
            d != ""
            and root_prefix != ""
            and not (d == root_prefix or d.startswith(root_prefix + "/"))
        ):
            add_prefix(d)

    # File selections. ``critical`` maps each required path to its declaring
    # artifact; ``optional`` files are included when present at the pin and owe
    # nothing absent.
    critical: dict[str, str] = {}
    optional: list[str] = []

    def add_critical(raw: object, declaring: str) -> _ClosureResult | None:
        if not isinstance(raw, str):
            return unavailable(f"the pinned leji.json declares no {declaring}")
        f = _declared_file(raw)
        if f is None:
            return unsafe(f"uncontained {declaring}: {raw}")
        if f not in critical:
            critical[f] = declaring
        return None

    err = add_critical(sibling.get("bootProfilePath"), "bootProfilePath")
    if err is not None:
        return err
    categories = cast("dict[str, object]", sibling.get("categories") or {})
    for cid, cat in categories.items():
        if not _is_record(cat):
            return unavailable(f"the pinned leji.json categories.{cid} is not an object")
        if "indexes" not in cast("dict[str, object]", cat):
            continue
        indexes = cast("dict[str, object]", cat)["indexes"]
        if not isinstance(indexes, list):
            return unavailable(f"the pinned leji.json categories.{cid} has no indexes array")
        for idx in indexes:
            err = add_critical(idx, f"categories.{cid} index")
            if err is not None:
                return err
    agents = cast("dict[str, object]", sibling.get("agents") or {})
    for role, rel in agents.items():
        err = add_critical(rel, f"agents.{role} profile")
        if err is not None:
            return err
    # Machine artifacts: included when present, whether their effective path was
    # declared or defaulted -- presence is the criterion, declaration is not.
    machine_files: list[str] = []
    for raw_path in (
        machine["indexPath"]
        if "indexPath" in machine
        else _join_posix(root_prefix, "context-index.json"),
        machine["changelogPath"]
        if "changelogPath" in machine
        else _join_posix(root_prefix, "context-changelog.json"),
    ):
        f = _declared_file(cast("str", raw_path))
        if f is None:
            return unsafe(f"uncontained machine path: {raw_path}")
        if f not in optional:
            optional.append(f)
        machine_files.append(f)

    # The canonical schema, not a hand-rolled restatement of it. Each pinned artifact
    # clears its own pointed guards first, because those name the exact field and read
    # better than "does not validate"; the schema is the backstop for what a guard
    # cannot see, a field the schema requires and the closure never dereferences
    # (``leji``, ``name``, ``owners``, and a ``categories`` map that is absent rather
    # than misshapen). A pinned artifact missing one is malformed pinned content,
    # which distribution.md classes as availability. Every detail here is stable Leji
    # text, never the validator's error list: three validators phrase and order their
    # messages differently, and the class is what the caller acts on. All of it runs
    # before the tree is enumerated, so nothing schema-invalid is traversed, let alone
    # published. The same pattern repeats for the index and the changelog below.
    if schema_errors("context-manifest", parsed_manifest):
        return unavailable("the pinned leji.json does not validate against the manifest schema")

    # Content closure: the pinned generated index names the governed paths, which
    # are required wherever they live. Read as JSON from the object store; no new
    # parser.
    index_path = machine_files[0]
    index_raw = run_git(["-C", repo, "cat-file", "blob", f"{commit}:{index_path}"])
    if index_raw.ok:
        try:
            stored = json.loads(index_raw.stdout.decode("utf-8"))
        except Exception:
            return unavailable("the pinned context index is not valid JSON")
        if not all_strings_scalar(stored):
            return unsafe("the pinned context index contains a malformed string")
        if not _is_record(stored):
            return unavailable("the pinned context index is not an object")
        if "entries" in stored and not isinstance(stored["entries"], list):
            return unavailable("the pinned context index has no entries array")
        for entry in stored["entries"] if "entries" in stored else []:
            if not _is_record(entry):
                return unavailable("the pinned context index entry is not an object")
            err = add_critical(entry.get("path"), "context index entry")
            if err is not None:
                return err
        if schema_errors("context-index", stored):
            return unavailable(
                "the pinned context index does not validate against the index schema"
            )

    # The changelog contributes no path to the closure, so it is read for one reason:
    # it is a pinned machine artifact, and a projection that publishes one which does
    # not validate hands the host malformed content under the schema's name. Absent is
    # normal (a core layer has no changelog) and contributes nothing.
    changelog_raw = run_git(["-C", repo, "cat-file", "blob", f"{commit}:{machine_files[1]}"])
    if changelog_raw.ok:
        try:
            stored_changelog = json.loads(changelog_raw.stdout.decode("utf-8"))
        except Exception:
            return unavailable("the pinned context changelog is not valid JSON")
        if not all_strings_scalar(stored_changelog):
            return unsafe("the pinned context changelog contains a malformed string")
        if schema_errors("context-changelog", stored_changelog):
            return unavailable(
                "the pinned context changelog does not validate against the changelog schema"
            )

    # Selection is a literal comparison against the enumerated tree: a name is
    # matched as a name, and a directory by its prefix. Nothing is handed to git as
    # a pattern, so a path carrying `*`, `?` or `[` selects itself and only itself.
    def selected(p: str) -> bool:
        return p == "leji.json" or _is_under_any(p, prefixes) or p in critical or p in optional

    # The same selection expressed as bytes, for the one entry kind that cannot be
    # decoded into ``selected``'s argument. Every selection came from a JSON string
    # that cleared the scalar gate, so each has a well-defined UTF-8 form; the two
    # predicates must agree, and this one mirrors ``selected`` term for term.
    selects_everything = any(p in (".", "") for p in prefixes)
    file_bytes = [f.encode("utf-8") for f in ["leji.json", *critical.keys(), *optional]]
    dir_bytes = [p.encode("utf-8") for p in prefixes if p not in (".", "")]

    def selects_raw_path(raw: bytes) -> bool:
        if selects_everything:
            return True
        if any(raw == f for f in file_bytes):
            return True
        # 0x2f is "/": the entry sits under the prefix rather than merely sharing
        # its opening bytes.
        return any(
            raw == d or (len(raw) > len(d) and raw[len(d)] == 0x2F and raw[: len(d)] == d)
            for d in dir_bytes
        )

    entries, list_error, list_kind = _list_tree(repo, commit, selects_raw_path)
    if list_error:
        return _ClosureResult(ok=False, error=list_error, kind=list_kind)

    files = 0
    seen: set[str] = set()
    lowered: set[str] = set()
    gitlinks: list[dict[str, str]] = []
    symlinks: list[tuple[str, str]] = []
    writes: list[tuple[str, str, int]] = []

    for e in entries:
        # Filtered before any per-entry rule runs: the enumeration is the whole
        # tree, and a case collision or an unsupported mode outside the projection
        # is not this projection's business.
        if not selected(e.rel_path):
            continue
        # Overlapping selections legitimately reach the same entry; the projection
        # is their deduplicated union.
        if e.rel_path in seen:
            continue
        seen.add(e.rel_path)
        if not _contained_rel_path(e.rel_path):
            return unsafe(f"unsafe path in the pinned tree: {e.rel_path}")
        lower = _ascii_fold(e.rel_path)
        if lower in lowered:
            return unsafe(f"case collision in the pinned tree: {e.rel_path}")
        lowered.add(lower)
        if e.mode == "160000":
            gitlinks.append({"path": e.rel_path, "oid": e.oid})
            continue
        if e.mode == "120000":
            target = _cat_blob(repo, e.oid)
            if target is None:
                return unsafe(f"unreadable symlink {e.rel_path}")
            # A target that is not valid UTF-8 is refused rather than decoded. The
            # three runtimes disagree about what decoding even means here (Node
            # substitutes U+FFFD, Python has to be told to, Go carries the raw bytes
            # through), so a decoded target is a different string in each and the
            # containment check below would then be checking three different things.
            # There is no portable form to fall back to, so there is nothing to do
            # but refuse it.
            try:
                decoded = target.decode("utf-8")
            except UnicodeDecodeError:
                return unsafe(f"symlink target is not valid UTF-8 in {e.rel_path}")
            # An empty target is malformed pinned content, not a link to anything:
            # the system call that would materialize it fails, and resolving it
            # produced a different answer in each SDK (here the containing
            # directory, in Node and Go the entry itself). Refused, so all three
            # agree on nothing.
            if decoded == "":
                return unsafe(f"symlink target is empty in {e.rel_path}")
            symlinks.append((e.rel_path, decoded))
            continue
        if e.type != "blob" or e.mode not in ("100644", "100755"):
            return unsafe(f"unsupported entry {e.mode} {e.rel_path} in the pinned tree")
        writes.append((e.rel_path, e.oid, 0o755 if e.mode == "100755" else 0o644))
        files += 1
        if files > MAX_PROJECTION_FILES:
            return unsafe("projection exceeds the file-count limit")

    # The failure boundary: every closure-critical file resolves at the pin, or the
    # projection fails naming the declaring artifact and the missing path. Symlinked
    # criticals count as present (their targets are containment-checked below).
    #
    # Byte order, not insertion order: with several criticals missing, the one the
    # failure names has to be the same in every SDK.
    present = {rel for rel, _oid, _mode in writes} | {rel for rel, _t in symlinks}
    for f in sorted(critical.keys(), key=lambda s: s.encode("utf-8")):
        if f not in present:
            return unavailable(f"closure-critical path missing at the pin: {critical[f]} {f}")

    # Symlink targets must stay inside the projection after resolution.
    projected = {rel for rel, _oid, _mode in writes}
    for rel, link_target in symlinks:
        if link_target.startswith("/") or "\\" in link_target:
            return unsafe(f"unsafe symlink target in {rel}")
        # Trailing slashes come off the resolved path before it is compared. An
        # ordinary directory symlink (``ln -s sub/ link``) resolves to ``dir/sub/``,
        # which is not a key of any projected path and not a prefix any selection
        # carries, so a conforming sibling was refused for pointing inside itself;
        # Go's path.Join already Cleaned the slash away and hydrated it, and the
        # explicit strip is what makes all three answer the same. Containment itself
        # is unchanged: an escaping trailing-slash target is still refused, because
        # ``..`` resolves before this.
        resolved = _strip_trailing_slashes(
            _posix_normalize(posixpath.join(posixpath.dirname(rel), link_target))
        )
        if not _contained_rel_path(resolved) or (
            resolved not in projected and not _is_under_any(resolved, prefixes)
        ):
            return unsafe(f"symlink {rel} escapes the projection")

    sibling_name = sibling.get("name")
    return _ClosureResult(
        ok=True,
        commit=commit,
        tree=tree,
        sibling_name=sibling_name if isinstance(sibling_name, str) else None,
        prefixes=prefixes,
        writes=writes,
        symlinks=symlinks,
        gitlinks=gitlinks,
    )


def extract_projection(repo: str, pin: str, dest_dir: str) -> ProjectionResult:
    """Extract the layer projection of the pinned sibling into ``dest_dir``: the
    closure, materialized. Byte limits bind here, where content is actually read."""
    closure = _compute_closure(repo, pin)
    if not closure.ok:
        return ProjectionResult(ok=False, error=closure.error, kind=closure.kind)

    total_bytes = 0
    for rel, oid, mode in closure.writes:
        blob = _cat_blob(repo, oid)
        if blob is None:
            return ProjectionResult(ok=False, error=f"unreadable blob for {rel}", kind="safety")
        total_bytes += len(blob)
        if total_bytes > MAX_PROJECTION_BYTES:
            return ProjectionResult(
                ok=False, error="projection exceeds the byte limit", kind="safety"
            )
        abs_path = _join(dest_dir, *rel.split("/"))
        Path(abs_path).parent.mkdir(parents=True, exist_ok=True)
        # Create with the git mode, subject to the umask (Node writeFileSync mode).
        fd = os.open(abs_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        with os.fdopen(fd, "wb") as f:
            f.write(blob)
    for rel, link_target in closure.symlinks:
        abs_path = _join(dest_dir, *rel.split("/"))
        Path(abs_path).parent.mkdir(parents=True, exist_ok=True)
        os.symlink(link_target, abs_path)

    return ProjectionResult(
        ok=True,
        commit=closure.commit,
        tree=closure.tree,
        files=len(closure.writes),
        bytes=total_bytes,
        gitlinks=closure.gitlinks,
        sibling_name=closure.sibling_name,
    )


@dataclass
class SelfProjection:
    """The ``leji status`` projection section: would this layer, at HEAD, project
    completely if a host mounted it? Enumeration-level (closure completeness and
    per-entry rules against the object store); read-only, offline, deterministic."""

    state: str  # 'ok' | 'fail' | 'no-commit'
    commit: str = ""
    files: int = 0
    detail: str = ""


def self_projection(root: str) -> SelfProjection:
    head = run_git(["-C", root, "rev-parse", "HEAD^{commit}"])
    if not head.ok:
        return SelfProjection(state="no-commit")
    commit = head.stdout.decode("utf-8").strip()
    closure = _compute_closure(root, commit)
    if not closure.ok:
        return SelfProjection(state="fail", commit=commit, detail=closure.error or "")
    return SelfProjection(
        state="ok", commit=commit, files=len(closure.writes) + len(closure.symlinks)
    )


# --- Cache publication -------------------------------------------------------
#
# There is no lock over the cache. Git owns object-store and ref concurrency, refs
# publish by compare-and-swap, and the cache is content-addressed, so every
# producer for a key stages byte-identical content. What remains is publishing an
# entry exactly once, which ``rename`` already decides.


def _complete_marker(projection: str) -> str:
    """The publication marker, written *inside* the staged tree before it is moved.
    Publishing the content and its completion evidence in one atomic move closes
    the window where an entry exists without its marker: without that, a producer
    racing a live publisher reads "destination without marker" and wrongly calls it
    poison."""
    return _join(projection, "complete")


def _projection_dir(root: str, key: str) -> str:
    """The published projection for a cache key, marker and all."""
    return _join(mounts_dir(root), "cache", key, "projection")


def cache_entry_published(root: str, key: str) -> bool:
    """True when this cache key holds a published entry. The directory existing
    proves nothing; only the marker inside it does."""
    return os.path.isfile(_complete_marker(_projection_dir(root, key)))


# ``rename`` onto an existing non-empty directory: POSIX reports ENOTEMPTY or
# EEXIST, Windows fails whenever the destination exists (EPERM or EACCES). The
# whole set is matched rather than one code assumed, so no other failure is read as
# "destination exists" by inference.
_DESTINATION_EXISTS = frozenset({errno.EEXIST, errno.ENOTEMPTY, errno.EPERM, errno.EACCES})


def _staging_token() -> str:
    """Unique staging names, so two producers never stage into the same directory."""
    return f"{os.getpid()}-{secrets.token_hex(8)}"


def _publish_cache_entry(
    cache_dir: str, staging: str, metadata_json: str
) -> tuple[str, str | None]:
    """Publish the staged tree as this key's projection.

    The sidecar and the marker are written into staging first, so the single rename
    publishes a complete entry or nothing at all. A published projection therefore
    always holds at least the marker and is never empty, which is what makes the
    rename exclusive in practice: POSIX replaces only an *empty* destination
    directory.

    Poison, meaning a projection with no marker, is never repaired. Repairing it
    would mean deciding from the outside that no other process is mid-publish, and
    that decision cannot be made without reintroducing the race this protocol
    removes. Returns (status, detail); detail is set only on error.
    """
    Path(_join(staging, "metadata.json")).write_text(metadata_json, encoding="utf-8")
    Path(_complete_marker(staging)).write_text("", encoding="utf-8")
    target = _join(cache_dir, "projection")
    try:
        os.rename(staging, target)
        return "hydrated", None
    except OSError as e:
        shutil.rmtree(staging, ignore_errors=True)
        if e.errno not in _DESTINATION_EXISTS:
            return "error", "the projection could not be published into the cache"
    if os.path.isfile(_complete_marker(target)):
        return "cached", None
    return "error", "the cache entry is incomplete and is not repaired automatically"


def _declared_mounts(manifest: Manifest) -> list[MountDecl]:
    return [
        MountDecl(
            name=m["name"],
            source=m["source"],
            pin=m["pin"],
            tracking_ref=m.get("trackingRef"),
        )
        for m in (manifest.get("federation") or {}).get("mounts") or []
    ]


def tracked_cache_files(root: str) -> list[str]:
    """Reject outright when any file under .leji/mounts/ is git-tracked in the host."""
    r = run_git(["-C", root, "ls-files", "--", ".leji/mounts"])
    if not r.ok:
        return []
    return [line for line in r.stdout.decode("utf-8").split("\n") if line]


def _now_iso() -> str:
    """UTC now formatted exactly like JS Date.toISOString(): milliseconds + Z."""
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def hydrate_mounts(
    root: str,
    manifest: Manifest,
    fetch: bool = False,
    names: list[str] | None = None,
) -> HydrateResult:
    tracked = tracked_cache_files(root)
    if tracked:
        return HydrateResult(
            outcomes=[],
            fatal=f"git-tracked files under .leji/mounts/ ({tracked[0]}); "
            "the cache is never committed",
        )
    mounts = [m for m in _declared_mounts(manifest) if names is None or m.name in names]
    outcomes: list[dict[str, object]] = []
    for mount in mounts:
        identity = normalize_source(mount.source)
        # Details never echo a declaration back: a source may be a local path, and
        # canonical output carries no filesystem paths. The mount name locates it.
        if identity is None:
            outcomes.append(
                {
                    "name": mount.name,
                    "status": "error",
                    "detail": "source is not a normalizable locator",
                }
            )
            continue
        if mount.tracking_ref is not None and not valid_tracking_ref(mount.tracking_ref):
            outcomes.append(
                {
                    "name": mount.name,
                    "status": "error",
                    "detail": "trackingRef is not a fully qualified branch or tag",
                }
            )
            continue
        # --fetch populates the store for every declared mount, cached or already
        # resolvable: the store is the only witness namespace the resolver owns,
        # and `status` never fetches.
        fetched = fetch_into_store(root, mount, identity) if fetch else None

        # A requested fetch that did not establish the store is reported on its
        # own terms, whatever the projection then manages from a hint or the cache.
        def outcome(
            o: dict[str, object], fetched: FetchResult | None = fetched
        ) -> dict[str, object]:
            if fetched is not None:
                o["storeFetched"] = fetched.repo is not None
            if fetched is not None and fetched.witness_refresh_failed:
                o["witnessRefreshFailed"] = True
            return o

        key = cache_key_for(identity, mount.pin)
        cache_dir = _join(mounts_dir(root), "cache", key)
        if cache_entry_published(root, key):
            outcomes.append(outcome({"name": mount.name, "status": "cached", "cacheKey": key}))
            continue
        src = find_object_source(root, mount, identity)
        if src.ambiguous:
            outcomes.append(
                outcome(
                    {
                        "name": mount.name,
                        "status": "error",
                        "detail": "more than one submodule matches the source; "
                        "declare an explicit hint in .leji/mounts.local.json",
                    }
                )
            )
            continue
        if src.repo is None:
            outcomes.append(
                outcome(
                    {
                        "name": mount.name,
                        "status": "unavailable",
                        "detail": fetched.error
                        if fetched is not None and fetched.error
                        else "no reachable object store holds the pin "
                        "(declare a hint, or pass --fetch)",
                    }
                )
            )
            continue
        # Staged inside the entry's own directory, so publication is a rename on one
        # filesystem, and under a per-process name, so no two producers collide.
        staging = _join(cache_dir, f".staging-{_staging_token()}")
        Path(staging).mkdir(parents=True, exist_ok=True)
        projected = extract_projection(src.repo, mount.pin, staging)
        if not projected.ok:
            shutil.rmtree(staging, ignore_errors=True)
            # The class the failure was tagged with at its own site decides this,
            # never the detail text: a pinned layer that is absent or malformed
            # leaves the mount unavailable (hydrate is best-effort), while a safety
            # guard the projection refused to cross is an error the run fails on.
            outcomes.append(
                outcome(
                    {
                        "name": mount.name,
                        "status": "unavailable" if projected.kind == "unavailable" else "error",
                        "detail": projected.error,
                        "projectionFailed": True,
                    }
                )
            )
            continue
        host_manifest_raw = read_text_within(root, Path(root) / "leji.json") or ""
        metadata: dict[str, object] = {
            "name": mount.name,
            "sourceIdentity": identity,
            "pin": mount.pin,
            "commit": projected.commit,
            "tree": projected.tree,
            "cacheFormatVersion": CACHE_FORMAT_VERSION,
            "resolverVersion": "leji-sdk",
            "manifestDigest": sha256_hex(host_manifest_raw),
            "files": projected.files,
            "bytes": projected.bytes,
            "gitlinks": projected.gitlinks,
            "siblingName": projected.sibling_name,
            "completionState": "complete",
            "hydratedAt": _now_iso(),
        }
        # The whole tree is extracted and validated before it is publishable.
        status, detail = _publish_cache_entry(
            cache_dir, staging, json.dumps(metadata, indent=2, ensure_ascii=False) + "\n"
        )
        if status == "error":
            outcomes.append(outcome({"name": mount.name, "status": "error", "detail": detail}))
            continue
        published: dict[str, object] = {"name": mount.name, "status": status, "cacheKey": key}
        if status == "hydrated" and src.kind is not None:
            published["objectSource"] = src.kind
        outcomes.append(outcome(published))
    # Nothing is recorded: a mount's cache key is derivable from its declaration, and
    # whether it is hydrated is the marker on disk. A state file would only be a
    # second copy of both, and one that two concurrent partial runs can each drop
    # entries from.
    return HydrateResult(outcomes=outcomes)


def verify_projection(root: str, mount: MountDecl) -> bool | None:
    """Verify a cached projection against a reachable object store: every projected
    file's bytes and mode against the pinned tree. Returns None when no object
    store is reachable (unverifiable), True/False otherwise."""
    identity = normalize_source(mount.source)
    if identity is None:
        return False
    key = cache_key_for(identity, mount.pin)
    if not cache_entry_published(root, key):
        return False
    proj_dir = _projection_dir(root, key)
    src = find_object_source(root, mount, identity)
    if src.repo is None:
        return None
    commit_r = run_git(["-C", src.repo, "rev-parse", f"{mount.pin}^{{commit}}"])
    if not commit_r.ok:
        return None
    commit = commit_r.stdout.decode("utf-8").strip()
    staging = _join(mounts_dir(root), f"verify-{os.getpid()}")
    shutil.rmtree(staging, ignore_errors=True)
    Path(staging).mkdir(parents=True, exist_ok=True)
    try:
        projected = extract_projection(src.repo, commit, staging)
        if not projected.ok:
            return False
        # The published entry carries two resolver files the pinned tree does not:
        # the completion marker and the sidecar. Staging them too keeps the
        # comparison a comparison of sibling content, rather than one that always
        # finds two extras.
        Path(_complete_marker(staging)).write_text("", encoding="utf-8")
        Path(_join(staging, "metadata.json")).write_bytes(
            Path(_join(proj_dir, "metadata.json")).read_bytes()
        )
        return _trees_equal(staging, proj_dir)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _trees_equal(a: str, b: str) -> bool:
    list_a = sorted(_walk_all(a))
    list_b = sorted(_walk_all(b))
    if list_a != list_b:
        return False
    for rel in list_a:
        fa = _join(a, rel)
        fb = _join(b, rel)
        sa = os.lstat(fa)
        sb = os.lstat(fb)
        a_link = statmod.S_ISLNK(sa.st_mode)
        b_link = statmod.S_ISLNK(sb.st_mode)
        if a_link != b_link:
            return False
        if a_link:
            # Bytes, not decoded strings. Two targets that differ in bytes can decode
            # to the same string, and integrity is a claim about what is on disk; the
            # Node port compared decoded strings and reported a tampered link as
            # verified. Passing bytes in returns the target's raw bytes out.
            if os.readlink(os.fsencode(fa)) != os.readlink(os.fsencode(fb)):
                return False
            continue
        if (sa.st_mode & 0o777) != (sb.st_mode & 0o777):
            return False
        if Path(fa).read_bytes() != Path(fb).read_bytes():
            return False
    return True


def _walk_all(directory: str, prefix: str = "") -> list[str]:
    out: list[str] = []
    for name in sorted(os.listdir(directory)):
        abs_path = _join(directory, name)
        rel = name if prefix == "" else f"{prefix}/{name}"
        if statmod.S_ISDIR(os.lstat(abs_path).st_mode):
            out.extend(_walk_all(abs_path, rel))
        else:
            out.append(rel)
    return out


def locate_mount(root: str, manifest: Manifest, name: str) -> dict[str, object]:
    mount = next((m for m in _declared_mounts(manifest) if m.name == name), None)
    if mount is None:
        return {
            "name": name,
            "sourceIdentity": None,
            "pin": None,
            "present": False,
            "verified": False,
            "path": None,
            "detail": "no mount with this name is declared",
        }
    identity = normalize_source(mount.source)
    if identity is None:
        return {
            "name": name,
            "sourceIdentity": None,
            "pin": mount.pin,
            "present": False,
            "verified": False,
            "path": None,
            "detail": "source is not a normalizable locator",
        }
    key = cache_key_for(identity, mount.pin)
    proj_dir = _projection_dir(root, key)
    present = cache_entry_published(root, key)
    verified = verify_projection(root, mount) is True if present else False
    out: dict[str, object] = {
        "name": name,
        "sourceIdentity": identity,
        "pin": mount.pin,
        "present": present,
        "verified": verified,
        "path": proj_dir if present else None,
    }
    if present and not verified:
        out["detail"] = "projection present but not verified against a reachable object store"
    return out


def mount_status(
    root: str,
    manifest: Manifest,
    check_integrity: bool = False,
    now: dt.datetime | None = None,
) -> list[dict[str, object]]:
    """Report every declared mount's pin against its witness, offline. Comparison
    is the availability matrix: the resolver's own witness in the managed store
    first, then any object source that holds both the pin and the tracking ref.
    The pin and the witness always come from the same repository, and nothing
    here fetches."""
    # One observation time for the whole execution, injectable so tests are stable.
    observed_at = (
        _now_iso()
        if now is None
        else now.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    )
    rows: list[dict[str, object]] = []
    # Encoding to UTF-8 makes the sort key the one byte order every ordered
    # canonical surface uses across the three SDKs.
    for mount in sorted(_declared_mounts(manifest), key=lambda m: m.name.encode("utf-8")):
        identity = normalize_source(mount.source)
        present = identity is not None and cache_entry_published(
            root, cache_key_for(identity, mount.pin)
        )
        verified = verify_projection(root, mount) if (check_integrity and present) else None
        base: dict[str, object] = {
            "name": mount.name,
            "sourceIdentity": identity,
            "pin": mount.pin,
            "trackingRef": mount.tracking_ref,
            "present": present,
            "verified": verified,
        }

        def unknown(
            reason: str,
            comparison_repository: str | None = None,
            witness_provenance: str | None = None,
            base: dict[str, object] = base,
            mount: MountDecl = mount,
        ) -> dict[str, object]:
            return {
                **base,
                "pinReport": {
                    "state": "unknown",
                    "comparedRef": mount.tracking_ref,
                    "comparisonRepository": comparison_repository,
                    "witnessProvenance": witness_provenance,
                    "ancestryComplete": False,
                    "reason": reason,
                    "observedAt": observed_at,
                },
            }

        if identity is None:
            rows.append(unknown("mount-source-unnormalizable"))
            continue
        if mount.tracking_ref is None:
            rows.append(unknown("mount-no-tracking-ref"))
            continue
        if not valid_tracking_ref(mount.tracking_ref):
            rows.append(unknown("mount-tracking-ref-invalid"))
            continue

        # Row 1: the managed store holds the pin and the resolver's own witness.
        store = _store_dir(root, identity)
        managed_tip = (
            _rev_oid(store, witness_ref_for(identity, mount.tracking_ref))
            if _is_git_repo(store) and _has_commit(store, mount.pin)
            else None
        )
        # Row 2: the first pin-holding source that also resolves the ref itself. A
        # candidate holding only the pin is passed over, never allowed to mask a
        # later one holding both.
        candidates: list[ObjectSource] = []
        ambiguous = False
        if managed_tip is None:
            candidates, ambiguous = object_source_candidates(root, mount, identity)
        selected: tuple[str, str, str] | None = (
            None if managed_tip is None else (store, "store", managed_tip)
        )
        for candidate in candidates:
            tip = _rev_oid(cast("str", candidate.repo), mount.tracking_ref)
            if tip is not None:
                selected = (cast("str", candidate.repo), cast("str", candidate.kind), tip)
                break
        if selected is None:
            # Ambiguity is its own answer: those repositories were never consulted,
            # so reporting the pin unavailable would claim more than was checked.
            if ambiguous:
                rows.append(unknown("mount-source-ambiguous"))
            elif not candidates:
                rows.append(unknown("mount-pin-unavailable"))
            else:
                rows.append(unknown("mount-witness-unavailable"))
            continue
        repo, kind, tip_oid = selected
        comparison_repository = "managed-store" if kind == "store" else kind
        witness_provenance = "managed" if managed_tip is not None else "unmanaged"

        behind = _count_range(repo, mount.pin, tip_oid)
        ahead = _count_range(repo, tip_oid, mount.pin)
        if behind is None or ahead is None:
            rows.append(
                unknown("mount-ancestry-incomplete", comparison_repository, witness_provenance)
            )
            continue
        shallow = run_git(["-C", repo, "rev-parse", "--is-shallow-repository"])
        ancestry_complete = shallow.ok and shallow.stdout.decode("utf-8").strip() == "false"
        # Both counts positive is either divergence or two unrelated histories, and
        # only a merge base tells them apart. Exit 1 is the answer "no merge base";
        # any other failure is the repository unable to answer, never an answer.
        # Truncated history can also lose a merge base that exists, so `unrelated`
        # is a claim only complete ancestry makes.
        disjoint = False
        if behind > 0 and ahead > 0:
            merge_base = run_git(["-C", repo, "merge-base", mount.pin, tip_oid])
            if not merge_base.ok and merge_base.code != 1:
                rows.append(
                    unknown("mount-ancestry-incomplete", comparison_repository, witness_provenance)
                )
                continue
            disjoint = not merge_base.ok
            if disjoint and not ancestry_complete:
                rows.append(
                    unknown("mount-ancestry-incomplete", comparison_repository, witness_provenance)
                )
                continue
        if behind == 0 and ahead == 0:
            state = "up-to-date"
        elif behind > 0 and ahead > 0:
            state = "unrelated" if disjoint else "diverged"
        elif behind > 0:
            state = "behind"
        else:
            state = "ahead"
        rows.append(
            {
                **base,
                "pinReport": {
                    "state": state,
                    "behind": behind,
                    "ahead": ahead,
                    "comparedRef": mount.tracking_ref,
                    "comparisonRepository": comparison_repository,
                    "witnessProvenance": witness_provenance,
                    "ancestryComplete": ancestry_complete,
                    "observedAt": observed_at,
                },
            }
        )
    return rows


def _count_range(repo: str, from_ref: str, to_ref: str) -> int | None:
    """Commits in ``from..to``, or None when the range cannot be counted
    (missing objects)."""
    r = run_git(["-C", repo, "rev-list", "--count", f"{from_ref}..{to_ref}"])
    if not r.ok:
        return None
    try:
        return int(r.stdout.decode("utf-8").strip())
    except ValueError:
        return None


@dataclass
class ReachabilityResult:
    state: str  # 'reachable' | 'unreachable' | 'unknown'
    witness_ref: str | None
    detail: str | None = None


_HEAD_SYMREF_RE = re.compile(r"^ref:\s+(\S+)\s+HEAD", re.MULTILINE)


def check_pin_reachability(root: str, mount: MountDecl) -> ReachabilityResult:
    """The networked conformance probe: is the pin reachable from an advertised
    ref of ``source``? Advertisement comes from ``git ls-remote`` against the
    declared source (never a hint: hint-only resolution is availability, not
    conformance). The witness is ``tracking_ref``, or the source's advertised
    HEAD symref when absent. Ancestry is then established by fetching the
    witness ref into the resolver store. Any failure to reach the source reports
    ``unknown``, never a guess."""
    identity = normalize_source(mount.source)
    if identity is None:
        return ReachabilityResult(
            state="unknown", witness_ref=None, detail="source is not a normalizable locator"
        )
    # Resolve the witness ref: declared, or the source's advertised default branch.
    witness_ref = mount.tracking_ref
    if witness_ref is None:
        head = run_git(["ls-remote", "--symref", mount.source, "HEAD"])
        if not head.ok:
            return ReachabilityResult(
                state="unknown", witness_ref=None, detail="the source could not be reached"
            )
        m = _HEAD_SYMREF_RE.search(head.stdout.decode("utf-8"))
        if not m:
            return ReachabilityResult(
                state="unknown", witness_ref=None, detail="source advertises no HEAD symref"
            )
        witness_ref = m.group(1)
    adv = run_git(["ls-remote", mount.source, witness_ref])
    if not adv.ok:
        return ReachabilityResult(
            state="unknown", witness_ref=witness_ref, detail="the source could not be reached"
        )
    line = adv.stdout.decode("utf-8").strip()
    if line == "":
        return ReachabilityResult(
            state="unreachable",
            witness_ref=witness_ref,
            detail=f"source does not advertise {witness_ref}",
        )
    tip = line.split("\t")[0]
    # Establish ancestry in the resolver store: fetch the witness ref (full history,
    # no promisor state), then ask whether the pin is an ancestor of its tip.
    store = _join(mounts_dir(root), "store", sha256_hex(identity))
    if not _is_git_repo(store):
        Path(store).mkdir(parents=True, exist_ok=True)
        init = run_git(["init", "--bare", "-q", store])
        if not init.ok:
            return ReachabilityResult(
                state="unknown",
                witness_ref=witness_ref,
                detail="the managed store could not be initialized",
            )
    fetch = run_git(
        ["-C", store, "-c", "fetch.recurseSubmodules=no", "fetch", "-q", mount.source, witness_ref]
    )
    if not fetch.ok:
        return ReachabilityResult(
            state="unknown",
            witness_ref=witness_ref,
            detail="the witness ref could not be fetched from the source",
        )
    anc = run_git(["-C", store, "merge-base", "--is-ancestor", mount.pin, tip])
    if anc.ok:
        return ReachabilityResult(state="reachable", witness_ref=witness_ref)
    # is-ancestor distinguishes "no" (exit 1) from "cannot answer" (missing objects).
    if not _has_commit(store, mount.pin):
        return ReachabilityResult(
            state="unreachable",
            witness_ref=witness_ref,
            detail="the pin is not in the history advertised by the source",
        )
    return ReachabilityResult(
        state="unreachable",
        witness_ref=witness_ref,
        detail=f"the pin is not an ancestor of {witness_ref}",
    )


@dataclass
class EnforcementFinding:
    rule: str
    severity: Literal["error"]
    message: str
    path: str


def federation_enforcement(
    root: str,
    manifest: Manifest,
    mode: str,
    task_mount_names: set[str] | None,
) -> list[EnforcementFinding]:
    """Opt-in federation enforcement for ``leji validate --federation=<mode>``.
    ``available``: every cleanly declared mount must be hydrated AND verified
    against a reachable object store (a restored or unverifiable cache is not
    evidence). ``required``: only mounts the given task paths route to (category
    overlap, the routing algorithm's machine-decidable signal) must be available;
    ``requiredWhen`` stays the agent's judgment. Never mutates; run
    ``mounts hydrate`` first."""
    out: list[EnforcementFinding] = []
    for mount in _declared_mounts(manifest):
        if mode == "required" and (task_mount_names is None or mount.name not in task_mount_names):
            continue
        identity = normalize_source(mount.source)
        if identity is None:
            continue  # declaration errors are ordinary validation's
        # The completion marker, never the directory: an entry without one was
        # never published, so it is poison rather than evidence and enforcement
        # must not accept it as hydrated.
        if not cache_entry_published(root, cache_key_for(identity, mount.pin)):
            required_by = "by this task" if mode == "required" else "by --federation=available"
            out.append(
                EnforcementFinding(
                    rule="mount-enforcement",
                    severity="error",
                    message=f'mount "{mount.name}" is required {required_by} '
                    "but is not hydrated; run `leji mounts hydrate`",
                    path=mount.name,
                )
            )
            continue
        verified = verify_projection(root, mount)
        if verified is not True:
            message = (
                f'mount "{mount.name}" projection does not match its pin; '
                "re-run `leji mounts hydrate`"
                if verified is False
                else f'mount "{mount.name}" projection cannot be verified '
                "(no reachable object store); an unverified cache is not evidence"
            )
            out.append(
                EnforcementFinding(
                    rule="mount-enforcement", severity="error", message=message, path=mount.name
                )
            )
    return out
