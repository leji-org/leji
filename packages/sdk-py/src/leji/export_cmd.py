"""``leji export`` (and ``leji viewer build``, its co-equal name for the same
operation): the static export pipeline, in its own module so its transitive import
set can be checked. Nothing here — and nothing it imports — pulls in
``http.server``, ``socket``, ``socketserver`` or ``urllib.request``; the local
preview server keeps all of that in ``serve_cmd``. The only subprocess the pipeline
reaches is ``git``, through the mount status the manifest page renders, with lazy
fetch disabled. An import-inspection test pins the first claim.

Mirrors the Node SDK's `commands/export.ts`.
"""

from __future__ import annotations

import os
import stat
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .findings import Finding, sort_findings
from .leji_ignore import (
    LejiIgnoreContext,
    ensure_leji_ignore_file,
    new_leji_ignore_context,
)
from .fsx import (
    mkdirp_guarded,
    open_verified_source,
    open_write_guarded,
    read_all,
    resolved_path,
    resolved_path_under,
    resolved_within_root,
    rm_guarded,
    strip_slash,
    to_posix,
    verified_target_read,
    write_file_guarded,
)
from .layout import (
    DIST_REL,
    LEJI_DIR,
    LEJI_IGNORE_REL,
    VIEWER_REL,
    TargetVerdict,
    leji_role,
    role_abs,
    servable_path,
    writable_target,
)
from .manifest import Manifest
from .renderlint import RENDER_UNSUPPORTED_RULE, render_lint_findings
from .viewer_cmd import (
    ACTIVE_EXTENSIONS,
    EXPORT_BASE,
    OVERVIEW_REL,
    _build_index_html,
    _resolved_profile_pages,
    generate_viewer,
    render_overview,
)

# The protect-your-context warning shown by `leji export` and embedded in the
# exported index.html: a context layer is sensitive and the static export should not
# be hosted somewhere public.
PROTECT_WARNING = (
    "This is your context layer (identity, invariants, decisions, sometimes sensitive "
    "internal knowledge). Host the exported folder behind internal authentication, not a "
    "public or shared bucket where it could be indexed or leaked. Active file types "
    "(.htm, .html, .js, .mjs, .xhtml) are left out of the exported content: a static "
    "host would serve them as same-origin documents that execute with no policy."
)

# The first bytes an export writes into its index.html, under either of the
# command's names. A target directory carrying this marker is a previous export and
# may be cleared; any other non-empty directory is somebody's content and is never
# removed. The marker is a byte contract shared with the Node and Go SDKs, so it
# reads as it has always read: an export written by any of the three, under either
# name, is clearable by any of the three.
EXPORT_MARKER = "<!--\n  Leji viewer (leji viewer build).\n"

# The lint-class rules ``--strict`` promotes to a failed run. The gate is
# rule-scoped rather than "any finding": ordinary viewer warnings (an unresolved
# ``viewer.homepage``, say) stay warnings under ``--strict``, and error findings fail
# the run with or without it. The rendering lint's ``render-unsupported`` is the
# class the flag exists for; a later lint rule joins it here.
STRICT_LINT_RULES = frozenset({RENDER_UNSUPPORTED_RULE})

#: Copy chunk for the descriptor-to-descriptor stream below.
_COPY_CHUNK = 64 * 1024


def _clearable_export(root_abs: Path, out_abs: Path) -> bool:
    """True when the export may clear out_abs: it is absent, an empty directory, or a
    previous export. Anything else (a file, a populated directory the exporter did not
    write) is content the tool has no business deleting.

    The marker decides a recursive delete, so it is read through the verified read: the
    bytes that authorize clearing the tree come from the descriptor the rule cleared,
    never from a pathname that a planted ``index.html`` link could point elsewhere. A
    marker file that cannot be verified is simply not a previous export."""
    if not out_abs.exists():
        return True
    if not out_abs.is_dir():
        return False
    if not any(out_abs.iterdir()):
        return True
    marker = verified_target_read(str(root_abs), str(out_abs / "index.html"), DIST_REL)
    if marker.status != "regular":
        return False
    try:
        return marker.text().startswith(EXPORT_MARKER)
    except UnicodeDecodeError:
        return False


def _refused_dest(root_abs: Path, dest_abs: Path, verdict: TargetVerdict) -> RuntimeError:
    """The one refusal every export destination act raises: a hard stop mid-run, since
    a destination that stopped being writable can only mean the tree moved under the
    export."""
    if verdict.unresolvable:
        why = "cannot be resolved (permission or I/O error)"
    elif verdict.outside_root:
        why = "resolves outside the repository"
    else:
        why = f"resolves into {LEJI_DIR}/{verdict.role} (private)"
    rel = os.path.relpath(dest_abs, root_abs)
    return RuntimeError(f'refusing to write "{rel}": it {why}; the export is incomplete')


def _copy_from_descriptor(fd: int, root_abs: Path, dest: Path) -> None:
    """Stream a source's bytes from the descriptor a check already judged, rather
    than reopening its path: only the linted markdown is held in memory, and the
    bytes still come from the checked inode. A write may be short (a pipe-backed or
    unusual destination), so each chunk is written to completion or the copy would
    silently truncate the file.

    The destination is judged and opened by the chokepoint; the bytes then go into
    that descriptor, so the copy can never reopen — or redirect to — a path."""
    mode = os.fstat(fd).st_mode & 0o777
    opened = open_write_guarded(str(root_abs), str(dest), DIST_REL, mode)
    if not opened.ok or opened.fd is None:
        raise _refused_dest(root_abs, dest, opened.verdict)
    out_fd = opened.fd
    try:
        while True:
            chunk = os.read(fd, _COPY_CHUNK)
            if not chunk:
                return
            written = 0
            while written < len(chunk):
                written += os.write(out_fd, chunk[written:])
    finally:
        os.close(out_fd)


@dataclass
class BuildResult:
    """One export run's result: the relative output dir, the findings the run
    reports, and whether the tree was written. ``wrote`` is False when a pre-write
    check stopped the run (an error finding, or a lint finding under ``--strict``),
    in which case a pre-existing target is byte-untouched. A refusal never returns:
    it raises."""

    out: str
    findings: list[Finding] = field(default_factory=list)
    wrote: bool = False


@dataclass
class _Carried:
    """One entry the content walk enumerated: a rootPath-relative POSIX path, and
    whether it is a directory."""

    rel: str
    is_dir: bool


def build_viewer(
    root: str,
    manifest: Manifest,
    out_rel: Optional[str] = None,
    strict: bool = False,
    ignore_context: Optional[LejiIgnoreContext] = None,
) -> BuildResult:
    """Export a self-contained static viewer into out_rel with the same URL contract
    the local server serves (chrome at the web root, layer markdown under /content/),
    so any static host serves it as-is. The pipeline is fixed: regenerate the chrome
    (server flavor, always), run the pre-write checks, and only on a clean result
    clear and write the target — so a failing check leaves a pre-existing export
    byte-untouched. ``strict`` is the gate: a lint finding fails the run before the
    target is cleared, mirroring ``status --strict``. The exported index.html carries
    the protect-your-context warning as a comment. ``ignore_context`` is the
    invocation's notice state for the self-managed ``.leji/.gitignore``, passed through
    to the generation pass this run nests so one invocation notices once; a direct SDK
    call that omits it notices at most once for that call."""
    # One context for the whole run, whether the caller supplied it or not: this command
    # establishes two roles (the chrome it regenerates and its own output), and a caller
    # that passes none is still one call.
    ignore_context = ignore_context or new_leji_ignore_context()
    gen = generate_viewer(root, manifest, ignore_context)
    # Every path below is resolved, root included, so the path a check judges is the
    # path the write lands on: a symlinked component — or a case-variant spelling of a
    # reserved role on a case-insensitive filesystem — resolves to its real name here,
    # before the reservation and containment rules are applied to it.
    requested_root = str(Path(root).resolve())
    root_abs = Path(resolved_path(requested_root) or requested_root)
    root_dir = strip_slash(manifest["rootPath"]) or "."
    content_abs = root_abs if root_dir == "." else root_abs / root_dir
    dist_abs = Path(role_abs(str(root_abs), DIST_REL))
    if out_rel is None:
        requested_out = dist_abs
    elif Path(out_rel).is_absolute():
        requested_out = Path(os.path.normpath(out_rel))
    else:
        requested_out = root_abs / out_rel
    # The ORIGINAL entry is judged before resolution, because a dangling symlink is a
    # standing entry and never an absence: resolved first, `.leji/dist -> missing` hands
    # every check below the link's MISSING destination, which reads as an unoccupied
    # target the export then clears and creates — a write through the link. An lstat or
    # stat that fails for any other reason (permission, I/O, a symlink loop) is not an
    # absence either; that path is refused by the resolution check just below.
    dangling_out = False
    try:
        entry = os.lstat(str(requested_out))
        if stat.S_ISLNK(entry.st_mode):
            try:
                os.stat(str(requested_out))
            except FileNotFoundError:
                dangling_out = True
    except OSError:
        dangling_out = False
    if dangling_out:
        raise RuntimeError(
            f'refusing to build the viewer into "{out_rel if out_rel is not None else DIST_REL}": '
            "it is a dangling symlink; remove the symlink or pass --out"
        )
    # Check-before-act: resolve the output target with the native resolver BEFORE judging or writing
    # it. An unresolvable path (permission/I/O error, not mere absence) fails the check
    # rather than being rebuilt lexically and written to.
    resolved_out = resolved_path_under(str(root_abs), str(requested_out))
    if resolved_out is None:
        raise RuntimeError(
            f'refusing to build the viewer into "{out_rel if out_rel is not None else DIST_REL}": '
            "the output path cannot be resolved (permission or I/O error)"
        )
    out_abs = Path(resolved_out)
    out_display = os.path.relpath(out_abs, root_abs)

    # Never run the destructive export when generation failed (e.g. a symlinked
    # rootPath escaping the layer): the viewer was not written, and the rmtree
    # below would otherwise delete an escaped output path.
    if any(f.severity == "error" for f in gen.findings):
        return BuildResult(out=out_display, findings=gen.findings, wrote=False)
    # Check-before-act: the output target is validated against the write rule
    # BEFORE any clean or write, UNCONDITIONALLY — the default `.leji/dist` and a
    # caller `--out` alike, with no out_rel-is-None fast path around it. It must resolve
    # INSIDE the repository (a `.leji/dist` symlinked out of the tree is refused, not
    # followed: the export folder is yours to copy wherever your host reads it from),
    # and either to its own role (`.leji/dist/`) or clear of `.leji/` altogether; a
    # DIFFERENT private role (`mounts`, `work`, `viewer`, a future one) is refused.
    # Resolved-vs-resolved, so neither a redirecting symlink nor a `.LEJI/` spelling
    # reaches a private role by looking like something else.
    ref = out_rel if out_rel is not None else out_display
    out_verdict = writable_target(str(root_abs), str(out_abs), DIST_REL)
    if not out_verdict.ok:
        refused = out_rel if out_rel is not None else DIST_REL
        if out_verdict.outside_root:
            raise RuntimeError(
                f'refusing to build the viewer into "{refused}": it resolves outside '
                "the repository; every write stays inside the repository root, so copy "
                "the exported folder to your host instead"
            )
        raise RuntimeError(
            f'refusing to build the viewer into "{refused}": it resolves into '
            f"{LEJI_DIR}/{out_verdict.role} (private), reserved for the tool's own "
            "roles; remove the symlink or pass --out"
        )
    # The role reservation is EXACT for a caller-supplied `--out`: `.leji/dist` is the
    # one reserved name it may resolve to, never a path underneath it. (The check-before-act check
    # above allows a target anywhere inside its own role, which is what a generation
    # target needs; an export target is the single directory the role names.)
    if out_rel is not None and str(out_abs).startswith(str(dist_abs) + os.sep):
        raise RuntimeError(
            f'refusing to build the viewer into "{out_rel}": {DIST_REL} is the '
            "reserved export target itself, never a path inside it"
        )
    # These collision checks measure a caller-supplied `--out` only: the default
    # `.leji/dist` is answered by the role reservation above, and repository containment
    # is answered for both by the write rule. A `--out` must additionally stay clear of
    # the context root in BOTH directions, so an export never deletes governed content
    # or the layer that contains it, and it says so as a usage error before work starts.
    collides = str(out_abs).startswith(str(content_abs) + os.sep) or str(content_abs).startswith(
        str(out_abs) + os.sep
    )
    if out_rel is not None and (
        out_abs == root_abs
        or out_abs == content_abs
        or not resolved_within_root(str(root_abs), out_abs)
        or collides
    ):
        raise RuntimeError(
            f'refusing to build the viewer into "{out_rel}": --out must be a path inside '
            "the repository, and must not be the repository root, the context root, "
            "inside the context root, or a directory containing the context root"
        )
    # Never remove a directory this command did not write: the export clears a
    # previous export, and refuses anything else that is already occupied.
    if not _clearable_export(root_abs, out_abs):
        raise RuntimeError(
            f'refusing to build the viewer into "{ref}": the target exists and is '
            "neither empty nor a previous viewer export; remove it or pick another --out"
        )
    # The export reads the chrome by name; each file is realpath-checked against the
    # servable whitelist in _copy_chrome below, and the generation pass above already
    # refused a `.leji/viewer/` that does not resolve inside its own role — so the two
    # vectors a separate identity check guarded are closed at their operations.
    viewer_abs = Path(role_abs(str(root_abs), VIEWER_REL))
    out_content = out_abs / "content"

    # Every destination act below goes through the write chokepoint with the export's
    # own role, one resolved check per act rather than one verdict inherited by a whole
    # tree: a descendant of the output directory swapped to a symlink after the target
    # was judged is caught at the file it would have redirected. A refusal is a hard
    # stop mid-run, since it can only mean the tree moved under the export.
    def mkdir_dest(dest_abs: Path) -> None:
        made = mkdirp_guarded(str(root_abs), str(dest_abs), DIST_REL)
        if not made.ok:
            raise _refused_dest(root_abs, dest_abs, made.verdict)

    def write_dest(dest_abs: Path, content: bytes | str) -> None:
        verdict = write_file_guarded(str(root_abs), str(dest_abs), DIST_REL, content)
        if not verdict.ok:
            raise _refused_dest(root_abs, dest_abs, verdict)

    # Check-before-act level-2 (boundary skip): a real, otherwise-servable read source withheld
    # because its RESOLVED path lands in a private role says why exactly once — on
    # stderr, never on stdout, never in the `--json` object — so the boundary answers
    # the "why isn't my doc showing?" question instead of dropping silently. A routine
    # dot-entry or ordinary symlink stays silent (a clean build has dozens of those);
    # this speaks only when the whitelist actually withheld something servable-looking.
    boundary_skipped: set[str] = set()

    def boundary_skip(child_rel: str, real: str) -> None:
        if child_rel in boundary_skipped:
            return
        boundary_skipped.add(child_rel)
        sys.stderr.write(
            f"skipped {child_rel}: resolves into "
            f"{LEJI_DIR}/{leji_role(str(root_abs), real)} (private); not served or exported\n"
        )

    # Enumerate the content root — every file and directory /content will carry —
    # skipping ALL dotfiles/dot-dirs and symlinks: an export is a self-contained
    # snapshot, and a symlink or dot-path (.git, .secret.md) must never leak into it.
    # Explicit walk, not copytree, so the default output dir under the content root
    # isn't copied into itself. Enumerating BEFORE the clean below is what lets the
    # rendering lint read exactly the set the export will carry while the target is
    # still untouched; the copy then replays this list.
    carried: list[_Carried] = []

    def walk_content(rel: str) -> None:
        src_dir = content_abs if rel == "" else content_abs / rel
        with os.scandir(src_dir) as it:
            entries = sorted(it, key=lambda e: e.name)
        for entry in entries:
            if entry.name.startswith("."):
                continue
            child_rel = entry.name if rel == "" else f"{rel}/{entry.name}"
            child_abs = content_abs / child_rel
            # A symlink is never exported (snapshot semantics). An ordinary one is a
            # routine, silent exclusion; one resolving into a private role is a
            # boundary skip — a servable-looking source withheld, named once on stderr.
            if entry.is_symlink():
                real = resolved_path_under(str(root_abs), str(child_abs))
                if real is not None and not servable_path(str(root_abs), real):
                    boundary_skip(child_rel, real)
                continue
            # Second line of defense behind the --out containment above: the export
            # never walks into itself, whatever the output path turns out to be.
            if child_abs == out_abs:
                continue
            # The servable-roots whitelist, mirrored on the export side: the only
            # `.leji/` content an export may read is `viewer/`, and it reads that by
            # name below. Independent of the dot-skip above, which also covers it; a
            # withheld servable-looking source is named once, exactly as a boundary skip.
            if not servable_path(str(root_abs), str(child_abs)):
                real = resolved_path_under(str(root_abs), str(child_abs))
                if real is not None and not servable_path(str(root_abs), real):
                    boundary_skip(child_rel, real)
                continue
            if entry.is_dir():
                carried.append(_Carried(rel=child_rel, is_dir=True))
                walk_content(child_rel)
            elif entry.is_file():
                # Active types never ride along: the export is meant to be hosted, and
                # a static host would serve them as same-origin documents with no policy.
                if child_abs.suffix.lower() in ACTIVE_EXTENSIONS:
                    continue
                carried.append(_Carried(rel=child_rel, is_dir=False))

    walk_content("")

    # A carried source is BOUND to its bytes at the moment it is used, not trusted from
    # the walk: between enumeration and use, the file — or any directory above it — can
    # become a symlink, and a read or copy by path then follows it past every check the
    # walk made. So each source is resolved natively, the RESOLVED path is judged
    # against the content root and the servable whitelist, and its bytes come from the
    # descriptor fstat proved a regular file: check and use hold the same inode. A
    # source that fails is dropped from the export with the same check-before-act semantics the walk
    # applies — silent for an ordinary redirect or a vanished file, named once on stderr
    # when it resolves into a private role.
    content_real = resolved_path_under(str(root_abs), str(content_abs)) or str(content_abs)

    def carried_source(real: str) -> bool:
        return servable_path(str(root_abs), real) and (
            real == content_real or real.startswith(content_real + os.sep)
        )

    def open_carried(child_rel: str) -> Optional[int]:
        src = open_verified_source(str(content_abs / child_rel), carried_source, str(root_abs))
        if src.fd is None and src.real is not None and not servable_path(str(root_abs), src.real):
            boundary_skip(child_rel, src.real)
        return src.fd

    # The rendering lint (`adoption/rendering.md`): every markdown document the export
    # will carry under content/, governed and reference alike, since anything served
    # can diverge across renderers. It reads the layer's own files — the author's bytes
    # at the author's line numbers, which is what a finding must point at — never the
    # generated chrome pages, which no one edits and every run rewrites. Each document
    # is read EXACTLY ONCE, and the bytes read are the bytes exported below: the lint's
    # verdict and the exported file are then the same document, with no window in which
    # one is judged and the other written. Only markdown is held (the set the lint
    # reads); every other file streams straight through the copy.
    lint: list[Finding] = []
    linted: dict[str, bytes] = {}
    for item in carried:
        if item.is_dir or not item.rel.lower().endswith(".md"):
            continue
        fd = open_carried(item.rel)
        if fd is None:
            continue
        try:
            data = read_all(fd)
        finally:
            os.close(fd)
        linted[item.rel] = data
        repo_rel = item.rel if root_dir == "." else f"{root_dir}/{item.rel}"
        lint.extend(render_lint_findings(repo_rel, data.decode("utf-8", "replace")))
    # Canonical order for the whole result: (path, line, rule, construct). The walk is
    # directory order, so the sort is what makes two runs — and three SDKs — report the
    # same sequence.
    findings = sort_findings([*gen.findings, *lint])

    # The `--strict` gate, and the last thing before the first byte moves: the refusals
    # above are about the destination (exit 2, whatever the flags say), while strict is
    # about the layer — a lint finding fails the run, and because the gate sits ahead of
    # the clean below, a pre-existing export is left exactly as it was. The pipeline is
    # regenerate -> check -> clear-and-write, in that order, so the promise holds for
    # every check that lands in it later.
    if strict and any(f.rule in STRICT_LINT_RULES for f in findings):
        return BuildResult(out=out_display, findings=findings, wrote=False)

    # Clean rebuild so a removed source file never lingers in the export.
    cleared = rm_guarded(str(root_abs), str(out_abs), DIST_REL)
    if not cleared.ok:
        raise _refused_dest(root_abs, out_abs, cleared)
    mkdir_dest(out_content)
    # The output role exists: ensure the tool's own ignore file, as every role
    # establisher does. The generation pass above shares this run's context, so an
    # existing file is noticed once for the whole invocation rather than per role.
    if ensure_leji_ignore_file(str(root_abs), ignore_context) == "refused":
        raise RuntimeError(
            f'refusing to write "{LEJI_IGNORE_REL}": it does not resolve to a regular '
            f"file inside {LEJI_DIR}/; remove the symlink"
        )
    for item in carried:
        dest = out_content / item.rel
        if item.is_dir:
            mkdir_dest(dest)
            continue
        # Markdown was read once already: the exported file is that snapshot, so what
        # the lint judged is what the export carries. A document the re-check dropped
        # has no snapshot and is not exported.
        #
        # The overview homepage is the one path whose exported copy is not its source:
        # the layer map is substituted between its markers here, after the lint has
        # judged the source bytes, from the entries the generation above already
        # projected. The layer's own file is not touched, and the map an export carries
        # is the map the local server renders from the same function.
        if item.rel.lower().endswith(".md"):
            snapshot = linted.get(item.rel)
            if snapshot is not None:
                if item.rel == OVERVIEW_REL:
                    # `errors="replace"` mirrors Node's Buffer.toString('utf8'), which
                    # substitutes rather than throwing on invalid bytes.
                    rendered = render_overview(
                        snapshot.decode("utf-8", errors="replace"), manifest, gen.index_entries
                    )
                    if rendered.markers_found:
                        snapshot = rendered.text.encode("utf-8")
                write_dest(dest, snapshot)
            continue
        fd = open_carried(item.rel)
        if fd is None:
            continue
        try:
            _copy_from_descriptor(fd, root_abs, dest)
        finally:
            os.close(fd)
    # An inheriting agent profile exports resolved, exactly as the local server
    # renders it: the copied file is only its own half of the profile.
    for rel, page in _resolved_profile_pages(str(root_abs), manifest):
        target = out_content / rel
        if not resolved_within_root(str(out_content), target):
            continue
        write_dest(target, page)

    # One generated chrome file into the export. A symlink is not a generated file:
    # lstat refuses it without following it, and the bytes come from the same guarded
    # open the content copy uses — the resolved path judged by the whitelist, the
    # descriptor proved to be that file — so nothing planted inside the chrome tree can
    # pull a private role's bytes along, and no copy reopens a checked path.
    def copy_chrome(src_abs: Path, dest_abs: Path) -> None:
        def refuse() -> RuntimeError:
            return RuntimeError(
                f'refusing to export "{to_posix(os.path.relpath(src_abs, root_abs))}": '
                f"the export carries only generated files from {VIEWER_REL}/"
            )

        if src_abs.is_symlink() or not src_abs.is_file():
            raise refuse()
        fd = open_verified_source(
            str(src_abs), lambda real: servable_path(str(root_abs), real), str(root_abs)
        ).fd
        if fd is None:
            raise refuse()
        try:
            _copy_from_descriptor(fd, root_abs, dest_abs)
        finally:
            os.close(fd)

    # The chrome asset tree, entry by entry rather than a blanket tree copy:
    # dot-entries and symlinks are skipped exactly as the content walk skips them.
    def copy_chrome_tree(src_abs: Path, dest_abs: Path) -> None:
        mkdir_dest(dest_abs)
        with os.scandir(src_abs) as it:
            entries = sorted(it, key=lambda e: e.name)
        for entry in entries:
            if entry.name.startswith(".") or entry.is_symlink():
                continue
            child_src = src_abs / entry.name
            child_dest = dest_abs / entry.name
            if entry.is_dir():
                copy_chrome_tree(child_src, child_dest)
            elif entry.is_file():
                copy_chrome(child_src, child_dest)

    # The generated sidebar and Manifest page are served as if at the content root.
    copy_chrome(viewer_abs / "_sidebar.md", out_content / "_sidebar.md")
    copy_chrome(viewer_abs / "_manifest.md", out_content / "_manifest.md")
    # The viewer assets at the web root.
    copy_chrome_tree(viewer_abs / "assets", out_abs / "assets")
    # index.html at the web root, with the protect-your-context warning prepended. The
    # export flavor is GENERATED here, by the same code path that wrote the served one,
    # with the base that lets the tree host under a subpath: the servable area never
    # holds export-flavored bytes, and no emitted HTML is rewritten after the fact. Its
    # resolution warnings were reported by the generation run above, so this pass
    # discards them.
    index_html = _build_index_html(root, manifest, EXPORT_BASE, [])
    write_dest(
        out_abs / "index.html",
        f"<!--\n  Leji viewer (leji viewer build).\n  {PROTECT_WARNING}\n-->\n{index_html}",
    )

    return BuildResult(out=out_display, findings=findings, wrote=True)
