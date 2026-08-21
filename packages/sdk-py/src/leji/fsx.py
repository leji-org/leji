"""Filesystem helpers; all returned paths are repository-root-relative POSIX."""

from __future__ import annotations

import os
import shutil
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Literal, Optional, Union

from .layout import TargetVerdict, writable_target


def to_posix(p: str) -> str:
    return p.replace(os.sep, "/")


def is_contained(root: str, candidate: Path) -> bool:
    """True when ``candidate``'s real path stays under ``root``'s real path.

    The LENIENT containment form, and READ-side only: it never guards a write, a
    clear, or any decision a write depends on — those go through
    :func:`resolved_within_root` and the chokepoint, which fail closed. It survives
    where the reference SDK deleted its counterpart because the two resolvers are not
    equivalent here: Node's ``realpath.native`` reads a component's canonical spelling
    from the kernel, while this port must list the parent directory to recover it (see
    :func:`_real_name`). A directory that is traversable but not enumerable therefore
    makes the strict form unresolvable in Python where the reference resolves it
    happily — and a layer's index files, read behind an existence check, must stay
    readable there rather than reporting a layer that has no index at all."""
    try:
        real_root = Path(os.path.realpath(root))
        real = Path(os.path.realpath(candidate))
    except OSError:
        return False
    return real == real_root or real.is_relative_to(real_root)


def _real_name(directory: str, name: str) -> str:
    """The filesystem's own spelling of ``name`` inside ``directory``: ``name``
    itself when the directory holds it verbatim, otherwise the entry that differs
    from it only in case.

    This is what closes case-variant role aliasing, which Node closes with
    ``realpathSync.native``: on a case-insensitive volume ``.LEJI/mounts`` opens the
    very directory ``.leji/mounts`` names, yet compares unequal to it as a string,
    so a decision made on the spelling is not a decision about the file.
    ``os.path.realpath`` hands back the spelling it was given, so the canonical name
    is read from the directory itself. A directory that denies enumeration (permission
    or I/O) makes the canonical spelling unknowable, so the error propagates and the
    whole path is unresolvable: a directory can refuse to be listed while still
    allowing traversal and writes through it, and falling back to the caller's
    spelling would let a ``.LEJI/`` alias be judged as a location outside the roles it
    actually opens. Mere nonexistence is not a failure — that is the not-yet-created
    target the caller rebuilds lexically."""
    try:
        entries = os.listdir(directory)
    except FileNotFoundError:
        return name
    folded = ""
    for entry in entries:
        if entry == name:
            return name  # the volume holds this exact spelling
        if folded == "" and entry.casefold() == name.casefold():
            folded = entry
    return folded or name


def _canonical_case(base: str, abs_path: str) -> str:
    """``abs_path`` (existing and symlink-free) with each component below ``base``
    spelled as the filesystem holds it.

    ``base`` is a prefix already known to be canonical — the resolved repository
    root at every check-before-act call site — so the walk stays inside the tree the decision is
    about instead of reading every directory from the filesystem root down. An
    empty base, or a path outside it, canonicalizes from the volume root. The
    ``OSError`` a component's directory raises travels out: a spelling that cannot be
    read back is not a spelling to decide on."""
    if base and abs_path == base:
        return base
    if base and abs_path.startswith(base + os.sep):
        current, rest = base, abs_path[len(base) + 1 :]
    else:
        drive, tail = os.path.splitdrive(abs_path)
        current, rest = drive + os.sep, tail.lstrip(os.sep)
    if rest == "":
        return current
    for segment in rest.split(os.sep):
        if segment:
            current = os.path.join(current, _real_name(current, segment))
    return current


def _native_realpath(base: str, abs_path: str) -> str:
    """Resolve every symlink in ``abs_path`` AND canonicalize the case of each
    component below ``base``, the two halves of Node's ``realpathSync.native``.
    Raises ``OSError`` exactly as a strict resolution does — from either half, since
    either failing fails the whole resolution."""
    return _canonical_case(base, os.path.realpath(abs_path, strict=True))


def _resolve_link(abs_path: str) -> str:
    """The symlink at ``abs_path`` read as an absolute path (a relative target
    resolves against the link's own directory)."""
    try:
        target = os.readlink(abs_path)
    except OSError:
        return abs_path
    if os.path.isabs(target):
        return os.path.normpath(target)
    return os.path.normpath(os.path.join(os.path.dirname(abs_path), target))


def resolved_path(abs_path: str) -> Optional[str]:
    """``abs_path`` with every symlink in it resolved, and with the filesystem's own
    spelling of each existing component — so a case-variant path on a
    case-insensitive filesystem comes back canonical. A path that does not exist yet
    resolves through its nearest existing ancestor, with the remainder re-appended,
    so a caller can judge a write target before anything is created under it. None
    when even the ancestor cannot be resolved.

    Judge with this whenever a decision and the write it guards must be about the
    same path: a lexical comparison answers for the spelling, not for the file."""
    return resolved_path_under("", abs_path)


def resolved_path_under(base: str, abs_path: str) -> Optional[str]:
    """:func:`resolved_path` with a prefix already known to be canonical — the
    resolved repository root, which every check-before-act call site holds — so only the
    components below it are read back from the filesystem. Semantics are identical;
    a path that resolves outside ``base`` is canonicalized in full."""
    try:
        return _native_realpath(base, abs_path)  # path exists (overwrite target, vendor file)
    except FileNotFoundError:
        pass
    except OSError:
        # Only genuine nonexistence is rebuilt lexically from the nearest existing
        # ancestor. A permission or I/O error (EACCES, EIO, ELOOP, ENOTDIR, …) means
        # the path exists but cannot be resolved: it FAILS the check rather than
        # being reconstructed as if it were an absent write target — a resolved
        # decision and the write it guards must be about the same real path.
        return None
    # A dangling symlink at the final component: realpath cannot follow it to a
    # missing target, but a write WOULD follow it there, so resolve the link's target
    # rather than treating the link's own name as the location — otherwise a symlink
    # into a private role reads as its own path and slips the boundary. (realpath
    # already proved the chain has no loop; a loop raises and is refused above.) A
    # missing final component that is not a symlink falls through to the ancestor
    # walk, the normal not-yet-created write target.
    if os.path.islink(abs_path):
        return resolved_path_under(base, _resolve_link(abs_path))
    # Walk to the nearest existing ancestor. A dangling symlink in an INTERMEDIATE
    # component is not "absent": a write would follow it, so follow it here too —
    # resolve the link and re-root the remainder onto its target, rather than
    # climbing past it and rebuilding the link's own name lexically. Otherwise a
    # nested `redirect/export` whose `redirect` dangles into a private role reads as
    # `.../redirect/export` (outside `.leji/`) and a target created after the check
    # lands the write inside the role — the check/use race this closes.
    p = os.path.dirname(abs_path)
    while not os.path.exists(p) and os.path.dirname(p) != p:
        try:
            mode = os.lstat(p).st_mode
        except FileNotFoundError:
            mode = 0
        except OSError:
            return None  # p is present but cannot be lstat'd (permission/I/O)
        if stat.S_ISLNK(mode):
            return resolved_path_under(
                base, os.path.join(_resolve_link(p), os.path.relpath(abs_path, p))
            )
        p = os.path.dirname(p)
    try:
        ancestor = _native_realpath(base, p)
    except OSError:
        return None
    return os.path.join(ancestor, os.path.relpath(abs_path, p))


#: The creation mode a guarded write hands the OS when the caller names none.
#: Spelled out because ``os.open`` defaults to ``0o777`` while the reference SDK's
#: write defaults to ``0o666``: taking Python's default would leave every generated
#: file executable, and the three SDKs would disagree on the modes they leave behind.
#: The process umask narrows it exactly as it does there.
_DEFAULT_CREATE_MODE = 0o666


def guard_root(root: str) -> str:
    """The repository root as every guard judges it: absolute and realpath-resolved,
    falling back to the absolute spelling when it cannot be resolved at all. Both
    sides of the containment rule must come through the same resolver, or a root
    reached through a symlinked ancestor (``/tmp`` -> ``/private/tmp``) compares
    unequal to its own children and every write under it reads as an escape."""
    abs_path = os.path.abspath(root)
    return resolved_path(abs_path) or abs_path


def resolved_within_root(root: str, candidate: Path) -> bool:
    """True when ``candidate`` resolves (following symlinks) within ``root``, even
    when ``candidate`` does not yet exist: a non-existent target is checked via its
    nearest existing ancestor, so a symlinked ancestor that escapes root is caught
    before a write creates the file under it.

    Fails CLOSED: a path that cannot be resolved at all (permission or I/O error, a
    symlink loop, a dangling link out of the tree) is not within root. A containment
    check under a security contract answers "provably inside" or nothing."""
    real = resolved_path(str(candidate))
    if real is None:
        return False
    try:
        # Both sides through the same resolver: a root resolved one way and a child
        # the other would differ in spelling alone and read as an escape.
        real_root = _native_realpath("", str(root))
    except OSError:
        return False
    return real == real_root or real.startswith(real_root + os.sep)


def _judge_target(
    root_abs: str, target_abs: str, own_role_rel: Optional[str]
) -> tuple[TargetVerdict, Optional[str]]:
    """One judged target: the verdict :func:`~leji.layout.writable_target` returns
    for its RESOLVED path, and that path — None only when it could not be resolved."""
    resolved = resolved_path_under(root_abs, target_abs)
    if resolved is None:
        return TargetVerdict(unresolvable=True), None
    return writable_target(root_abs, resolved, own_role_rel), resolved


def guarded_write(
    root_abs: str,
    target_abs: str,
    own_role_rel: Optional[str],
    op: Callable[[str], None],
) -> TargetVerdict:
    """The single guarded-write chokepoint (check-before-act). Realpath-resolve
    ``target_abs``, run :func:`~leji.layout.writable_target` on the resolved path,
    and perform the write or clear — through ``op``, on that resolved path — ONLY
    when the target is allowed to land there, which means all of: it resolves at all;
    it resolves INSIDE the repository root, with no exceptions; and it lands outside
    root ``.leji/`` or inside the one role ``own_role_rel`` names. On refusal nothing
    is touched: the verdict is returned (unresolvable, outside the repository, or the
    private ``.leji/`` role the target crossed into) so the caller renders the
    mandated hard refusal in its own channel — a generation ``Finding``, or a raised
    build error — before any byte is written.

    ``root_abs`` must already be realpath-resolved (:func:`guard_root`).
    ``own_role_rel`` names the one ``.leji/`` role this write may legitimately land
    in, or None when the target has no ``.leji/`` role at all (user content such as
    overview.md). One home for every write whose target derives from
    user-influenceable input, so a new write site is guarded by construction rather
    than by remembering to guard it — and the guarded conveniences below are how
    command modules reach it, so no command spells a raw write primitive of its own.

    The recorded check-before-act limit (``docs/practice/trust-boundary.md``) stands:
    the act is by pathname, immediately after the resolved decision, because no
    portable descriptor-bound directory walk exists here. An attacker must win the
    race between the two."""
    verdict, resolved = _judge_target(root_abs, target_abs, own_role_rel)
    if verdict.ok and resolved is not None:
        op(resolved)
    return verdict


def write_file_guarded(
    root_abs: str,
    target_abs: str,
    own_role_rel: Optional[str],
    content: Union[str, bytes],
    mode: Optional[int] = None,
    exclusive: bool = False,
) -> TargetVerdict:
    """Write ``content`` to a guarded target, creating its parent directories only
    when the write itself happens (a refused run establishes nothing). ``mode`` sets
    the mode at creation; ``exclusive`` creates with ``O_EXCL``, so a target that
    already exists comes back as the ``exists`` verdict rather than being overwritten
    or followed through a planted symlink.

    An exclusive create is decided on the ORIGINAL directory entry before anything is
    resolved: ANY standing entry — a regular file, a directory, a symlink whether it
    dangles or not — is ``exists``. Resolving first would defeat the point, because a
    dangling symlink resolves to its missing destination, and ``O_EXCL`` on that
    destination would happily create the file the link points at. Nothing stands
    there ⇒ the resolved path is judged (its parents included) and ``O_EXCL`` still
    closes the race between that judgement and the create."""
    if exclusive and not nothing_stands_at(target_abs):
        return TargetVerdict(exists=True)
    data = content.encode("utf-8") if isinstance(content, str) else content
    already_there = False

    def op(resolved: str) -> None:
        nonlocal already_there
        os.makedirs(os.path.dirname(resolved), exist_ok=True)
        flags = os.O_WRONLY | os.O_CREAT | (os.O_EXCL if exclusive else os.O_TRUNC)
        try:
            fd = os.open(resolved, flags, _DEFAULT_CREATE_MODE if mode is None else mode)
        except FileExistsError:
            already_there = True
            return
        with os.fdopen(fd, "wb") as f:
            f.write(data)

    verdict = guarded_write(root_abs, target_abs, own_role_rel, op)
    return TargetVerdict(exists=True) if already_there else verdict


@dataclass
class GuardedDir:
    """A guarded directory: the RESOLVED directory the rule judged, so every act that
    follows works from the path that was checked rather than re-joining its own.
    ``real`` is set only when ``verdict.ok``."""

    verdict: TargetVerdict
    real: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.verdict.ok and self.real is not None


def mkdirp_guarded(root_abs: str, target_abs: str, own_role_rel: Optional[str]) -> GuardedDir:
    """Create a guarded directory and every missing parent, and hand back the
    resolved path it was created at."""
    verdict, resolved = _judge_target(root_abs, target_abs, own_role_rel)
    if not verdict.ok or resolved is None:
        return GuardedDir(verdict=verdict)
    os.makedirs(resolved, exist_ok=True)
    return GuardedDir(verdict=verdict, real=resolved)


def rm_guarded(root_abs: str, target_abs: str, own_role_rel: Optional[str]) -> TargetVerdict:
    """Clear a guarded target: recursive, and absent is success (the clean-rebuild
    form every generator uses)."""

    def op(resolved: str) -> None:
        try:
            entry = os.lstat(resolved)
        except FileNotFoundError:
            return  # absent is success
        if stat.S_ISDIR(entry.st_mode):
            shutil.rmtree(resolved, ignore_errors=True)
        else:
            try:
                os.remove(resolved)
            except FileNotFoundError:
                pass

    return guarded_write(root_abs, target_abs, own_role_rel, op)


def rename_guarded(
    root_abs: str, from_abs: str, to_abs: str, own_role_rel: Optional[str]
) -> TargetVerdict:
    """Rename with BOTH ends judged before either is touched, so neither the source
    nor the destination can be redirected out of the rule by a planted symlink."""
    from_verdict, from_real = _judge_target(root_abs, from_abs, own_role_rel)
    if not from_verdict.ok or from_real is None:
        return from_verdict
    to_verdict, to_real = _judge_target(root_abs, to_abs, own_role_rel)
    if not to_verdict.ok or to_real is None:
        return to_verdict
    os.replace(from_real, to_real)
    return TargetVerdict(ok=True)


def chmod_guarded(
    root_abs: str, target_abs: str, own_role_rel: Optional[str], mode: int
) -> TargetVerdict:
    """Set the mode of a guarded target."""
    return guarded_write(
        root_abs, target_abs, own_role_rel, lambda resolved: os.chmod(resolved, mode)
    )


@dataclass
class GuardedOpen:
    """A guarded destination opened for writing: the descriptor and the resolved path
    it is bound to, or the refusal verdict. The caller writes into ``fd`` and closes
    it; the bytes then land in the file the rule judged, never in a path reopened
    afterwards."""

    verdict: TargetVerdict
    fd: Optional[int] = None
    real: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.verdict.ok and self.fd is not None


def open_write_guarded(
    root_abs: str, target_abs: str, own_role_rel: Optional[str], mode: Optional[int] = None
) -> GuardedOpen:
    """Open a guarded destination for writing (truncating), creating its parent
    directories only when the open actually happens."""
    verdict, resolved = _judge_target(root_abs, target_abs, own_role_rel)
    if not verdict.ok or resolved is None:
        return GuardedOpen(verdict=verdict)
    os.makedirs(os.path.dirname(resolved), exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(resolved, flags, _DEFAULT_CREATE_MODE if mode is None else mode)
    return GuardedOpen(verdict=verdict, fd=fd, real=resolved)


def write_file_atomic_guarded(
    root_abs: str, target_abs: str, own_role_rel: Optional[str], content: str
) -> TargetVerdict:
    """Write a guarded target atomically: a temp sibling in the same directory, then a
    rename onto the destination, so an interrupted write never leaves a partial file.
    Both paths are judged before either is touched — a planted ``<target>.leji-tmp``
    symlink would otherwise be written through before the rename — and the temp is
    removed when anything fails, so the whole compound operation lives here rather
    than being re-composed at each call site."""
    tmp_verdict, tmp_real = _judge_target(root_abs, target_abs + ".leji-tmp", own_role_rel)
    if not tmp_verdict.ok or tmp_real is None:
        return tmp_verdict
    dest_verdict, dest_real = _judge_target(root_abs, target_abs, own_role_rel)
    if not dest_verdict.ok or dest_real is None:
        return dest_verdict
    try:
        os.makedirs(os.path.dirname(dest_real), exist_ok=True)
        with open(tmp_real, "w", encoding="utf-8") as f:
            f.write(content)
        _maybe_inject_write_failure()
        os.replace(tmp_real, dest_real)
    except OSError:
        try:
            os.remove(tmp_real)
        except OSError:
            pass  # best-effort cleanup; the caller reports the original failure
        raise
    return TargetVerdict(ok=True)


def _maybe_inject_write_failure() -> None:
    """Test-only fault injection for :func:`write_file_atomic_guarded`: with
    LEJI_TEST_FAIL_RENAME set, fail after the temp file exists but before the rename,
    to exercise the cleanup and the caller's normalized-error path."""
    if os.environ.get("LEJI_TEST_FAIL_RENAME"):
        raise OSError("injected write failure")


def nothing_stands_at(abs_path: str) -> bool:
    """True when NOTHING stands at ``abs_path``, which is what makes a name free.

    The ORIGINAL directory entry decides it, exactly as an exclusive create does:
    ``Path.exists()`` follows symlinks, so a dangling link reads as a free name and
    the write that follows lands at the link's missing destination. Any standing
    entry, a dangling link included, is occupied."""
    try:
        os.lstat(abs_path)
    except FileNotFoundError:
        return True
    return False


@dataclass
class VerifiedSource:
    """An opened source: the descriptor when the source passed every check (the
    caller closes it), else None — with the resolved path, when it could be resolved
    at all, so a refusal can name where the source actually landed."""

    fd: Optional[int] = None
    real: Optional[str] = None


def open_verified_source(
    abs_path: str, allow: Callable[[str], bool], base: str = ""
) -> VerifiedSource:
    """The guarded-READ counterpart of :func:`guarded_write` (check-before-act),
    for every source whose bytes are about to be served, linted, or exported.
    Resolve ``abs_path``, judge the RESOLVED path with ``allow``, then open that path
    and prove the DESCRIPTOR is a regular file with ``fstat`` — so the file the check
    judged is the file the read gets. A path-based check leaves two windows open: an
    ancestor directory swapped to a symlink after enumeration (an ``lstat`` of the
    final component follows it and reports an ordinary file), and the gap between any
    check and a later read or copy by path. Reading from the descriptor closes both:
    the inode is pinned by the open.

    The open itself is by path, so one window survives that: a swap landing between
    the resolve above and the open makes the open follow the new link, and ``fstat``
    sees only an ordinary regular file. So the source is resolved ONCE MORE after the
    open and the descriptor is required to be that same location and that same file
    identity (``os.path.samestat``, the portable (st_dev, st_ino) comparison) — the
    bytes about to be read are then provably the ones ``allow`` judged. What remains
    is the recorded check-before-act limit: an attacker must swap AND revert within the
    open→recheck span to pass both resolutions. The reference implementation states
    the same limit for the same reason, so this port keeps the
    resolve→open→fstat→recheck order rather than reaching for a platform ``openat``:
    the observable behavior is the contract, and it must be identical in all three
    SDKs.

    The caller closes ``fd`` when it is not None, and owns the refusal semantics — a
    silent drop, a boundary warning, or an error — since only it knows which the
    source deserves. A source that vanished between the check and the open is one
    such refusal; any other I/O error on an allowed path is the filesystem failing
    rather than the boundary refusing, so it raises as a read by path always has.

    ``base`` is the canonical-prefix optimization :func:`resolved_path_under` takes:
    a resolved repository root the caller already holds."""
    real = resolved_path_under(base, abs_path)
    if real is None or not allow(real):
        return VerifiedSource(fd=None, real=real)
    try:
        fd = os.open(real, os.O_RDONLY)
    except FileNotFoundError:
        return VerifiedSource(fd=None, real=real)  # gone between the check and the open
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            os.close(fd)
            return VerifiedSource(fd=None, real=real)
        # The recheck. A refusal names where the source resolves NOW, not where it
        # resolved before the swap, so the caller's boundary message points at the
        # role the bytes would actually have come from.
        recheck = resolved_path_under(base, abs_path)
        landed = None if recheck is None else os.stat(recheck)
        if recheck != real or landed is None or not os.path.samestat(opened, landed):
            os.close(fd)
            return VerifiedSource(fd=None, real=recheck if recheck is not None else real)
    except OSError:
        os.close(fd)
        return VerifiedSource(fd=None, real=real)
    return VerifiedSource(fd=fd, real=real)


def read_all(fd: int) -> bytes:
    """Every byte of an open descriptor, read from the descriptor itself rather than
    reopened by path: the bytes a check judged are the bytes a caller gets."""
    chunks: list[bytes] = []
    while True:
        chunk = os.read(fd, 64 * 1024)
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)


#: Why a standing entry was refused, byte-identical to the reference SDK's union.
RefusalReason = Literal["outside-root", "other-role", "not-regular", "unverifiable"]


@dataclass
class VerifiedTargetRead:
    """What stood at a read-then-act target, judged by the same rule the write will
    be: nothing (``absent``), a regular file whose verified bytes are carried along
    (``regular``), or a standing entry this run refuses to act through (``refused``,
    with the reason and where it resolved, when it resolved at all)."""

    status: Literal["absent", "regular", "refused"]
    real: Optional[str] = None
    data: bytes = b""
    reason: Optional[RefusalReason] = None

    def text(self) -> str:
        """The verified bytes as UTF-8 text (``regular`` only)."""
        return self.data.decode("utf-8")


def verified_target_read(
    root_abs: str, target_abs: str, own_role_rel: Optional[str]
) -> VerifiedTargetRead:
    """Read a target that is about to be written, under the write rule itself: the
    shape every "look at what is there, then act on it" command needs, so none of
    them re-composes it.

    The ORIGINAL directory entry decides the kind first — a socket, a FIFO, a device
    node or a directory standing at the target is refused rather than opened, and a
    symlink is settled on what it resolves TO, because the open would follow it.
    Then :func:`open_verified_source` judges the RESOLVED path against
    :func:`~leji.layout.writable_target` for this role and proves the descriptor is
    that same regular file, so the bytes come back from the inode the rule cleared.

    ``absent`` is decided on the original entry, never on where it resolves: a
    dangling symlink resolves to a missing destination while the link itself is still
    standing, and a standing entry this run could not verify is
    ``refused/unverifiable``, never a write through it. Operational I/O failures on
    an allowed path PROPAGATE, as a read by path always has; only containment, entry
    kind, and verification become refusals."""
    try:
        entry: Optional[os.stat_result] = os.lstat(target_abs)
    except FileNotFoundError:
        entry = None
    if entry is not None and not stat.S_ISREG(entry.st_mode) and not stat.S_ISLNK(entry.st_mode):
        return VerifiedTargetRead(
            status="refused", real=resolved_path_under(root_abs, target_abs), reason="not-regular"
        )
    if entry is not None and stat.S_ISLNK(entry.st_mode):
        try:
            followed: Optional[os.stat_result] = os.stat(target_abs)
        except (FileNotFoundError, NotADirectoryError):
            followed = None
        if followed is not None and not stat.S_ISREG(followed.st_mode):
            return VerifiedTargetRead(
                status="refused",
                real=resolved_path_under(root_abs, target_abs),
                reason="not-regular",
            )
    refusal: Optional[RefusalReason] = None

    def allow(resolved: str) -> bool:
        nonlocal refusal
        verdict = writable_target(root_abs, resolved, own_role_rel)
        if verdict.ok:
            return True
        refusal = "outside-root" if verdict.outside_root else "other-role"
        return False

    src = open_verified_source(target_abs, allow, root_abs)
    if src.fd is not None and src.real is not None:
        try:
            return VerifiedTargetRead(status="regular", real=src.real, data=read_all(src.fd))
        finally:
            os.close(src.fd)
    if refusal is not None:
        return VerifiedTargetRead(status="refused", real=src.real, reason=refusal)
    if src.real is None:
        return VerifiedTargetRead(status="refused", real=None, reason="unverifiable")
    # Nothing verified was opened, and only ONE thing may follow from that: the
    # target is absent. Anything still standing there is a refusal.
    if nothing_stands_at(target_abs):
        return VerifiedTargetRead(status="absent", real=src.real)
    return VerifiedTargetRead(status="refused", real=src.real, reason="unverifiable")


def walk_md(root: str, rel_path: str) -> list[str]:
    """Markdown files under a declared path (file or directory), sorted.

    Symlinked entries whose real path escapes the repository root are excluded;
    a local preview/index never reaches outside the repo via a symlink."""
    abs_path = Path(root) / rel_path
    if abs_path.is_file():
        if not rel_path.endswith(".md") or not resolved_within_root(root, abs_path):
            return []
        return [to_posix(rel_path)]
    if not abs_path.is_dir():
        return []
    out: list[str] = []
    for dirpath, dirnames, filenames in os.walk(abs_path):
        dirnames[:] = [
            d
            for d in dirnames
            if not d.startswith(".")
            and d != "node_modules"
            and resolved_within_root(root, Path(dirpath) / d)
        ]
        for name in filenames:
            if name.startswith(".") or not name.endswith(".md"):
                continue
            full = Path(dirpath) / name
            # Skip symlinked entries during traversal to match the Node and Go walks,
            # which only collect regular files (a symlink is not isFile/IsRegular). A
            # directly-declared symlinked .md still resolves via the is_file branch above.
            if full.is_symlink():
                continue
            if not resolved_within_root(root, full):
                continue
            out.append(to_posix(str(full.relative_to(root))))
    return sorted(out)


def walk_tree(root: str, rel_path: str) -> list[str]:
    """All markdown files under a context path, repo-relative POSIX, sorted.

    The viewer uses this to build the directory browse zone of the sidebar; it
    shares walk_md's dotfile/node_modules skip and symlink containment, so the
    ``.leji`` viewer dir is never traversed."""
    return walk_md(root, rel_path)


def strip_slash(p: str) -> str:
    return p[:-1] if p.endswith("/") else p


def join_under_root(root_path: str, sub: str) -> str:
    """Join a sub-path under a context root with POSIX semantics, treating a ``.``
    or empty root as the repository root. ``join_under_root('docs/', 'context/')``
    is ``docs/context/``, and ``join_under_root('.', 'context/')`` is
    ``context/``, never the hidden ``.context/`` a bare concatenation produces."""
    base = strip_slash(root_path)
    return sub if base in ("", ".") else f"{base}/{sub}"


def under_path(rel_path: str, declared: str) -> bool:
    """True when rel_path is the declared path itself or falls under it."""
    base = strip_slash(declared)
    # An empty or "." root means the repository root: everything is under it.
    if base in ("", "."):
        return True
    return rel_path == base or rel_path.startswith(base + "/")
