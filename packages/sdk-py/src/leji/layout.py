"""The unified ``.leji/`` layout: one tree at the repository root holding every
role the tool owns, whatever ``rootPath`` the layer declares.

Roles are repository-root-relative by construction — a generated artifact never
lives inside the context root, so the content walk and the served content mount
carry nothing of the tool's own.

- ``mounts/`` + ``mounts.local.json`` — the private federation domain (owned by
  mounts.py, which spells the paths inside it; never servable, never exportable).
- ``viewer/`` — generated chrome, the ONE servable role.
- ``dist/`` — the default export output.
- ``work/`` — the transient onboarding workspace.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

#: The unified tree at the repository root.
LEJI_DIR = ".leji"

#: Generated viewer chrome (index.html, _sidebar.md, _manifest.md, assets/).
VIEWER_REL = f"{LEJI_DIR}/viewer"

#: Default export output; the only role a caller-supplied ``--out`` may name.
DIST_REL = f"{LEJI_DIR}/dist"

#: Transient onboarding workspace (brief, proposal, hooks).
WORK_REL = f"{LEJI_DIR}/work"

#: The private federation domain: managed object stores, projection cache, staging.
MOUNTS_REL = f"{LEJI_DIR}/mounts"

#: The one metadata file the tool keeps directly under root ``.leji/``, outside every
#: role: the ignore file that keeps the tool's own tree out of the repository even
#: when the root ``.gitignore`` never received the ``.leji/`` line. It belongs to no
#: role, so the role rule below refuses it; the single named exception that allows it
#: lives in ``fsx.py``, where the REQUESTED entry is still visible.
LEJI_IGNORE_REL = f"{LEJI_DIR}/.gitignore"


def role_abs(root_abs: str, rel: str) -> str:
    """Join a repository-root-relative role path (POSIX, as the constants above
    spell it) onto an absolute root, in the host's own separator."""
    return os.path.join(root_abs, *rel.split("/"))


def _under(directory: str, abs_path: str) -> bool:
    """True when ``abs_path`` is ``directory`` or sits underneath it."""
    return abs_path == directory or abs_path.startswith(directory + os.sep)


def servable_path(root_abs: str, abs_path: str) -> bool:
    """The servable-roots whitelist: a path may be served or exported only when it
    lies outside root ``.leji/`` entirely, or inside ``.leji/viewer/``.

    Every other role under ``.leji/`` — the private mounts domain, the export
    output, the onboarding workspace, and any role added later — is denied **by
    name**, so a new role is born unservable and no relaxation of the dot-segment
    refusal (kept as defense in depth) can open the trust domain as a side effect.

    ``root_abs`` must be a resolved (realpath'd) repository root, and ``abs_path``
    is judged both as requested and after symlink resolution: the name is what
    decides, not how the caller spelled it."""
    if not _under(role_abs(root_abs, LEJI_DIR), abs_path):
        return True
    return _under(role_abs(root_abs, VIEWER_REL), abs_path)


def leji_role(root_abs: str, abs_path: str) -> str:
    """The private ``.leji/`` role a resolved path falls into: the first path
    segment under ``.leji/`` (``mounts``, ``work``, ``dist``, ``viewer``, or any
    future role name), or ``""`` when the path is ``.leji/`` itself. Callers
    establish that ``abs_path`` is under ``.leji/`` before asking; used to name the
    role in a boundary message."""
    try:
        rest = os.path.relpath(abs_path, role_abs(root_abs, LEJI_DIR))
    except ValueError:  # different drives on Windows: no role to name
        return ""
    return "" if rest == "." else rest.split(os.sep)[0]


@dataclass(kw_only=True)
class TargetVerdict:
    """The verdict of :func:`writable_target`: whether a tool-owned target may be
    written or cleared, and — when refused — that it landed outside the repository,
    the private role it crossed into, that the path could not be resolved at all
    (permission/I/O, not mere absence), or that an exclusive create found the file
    already there.

    ``metadata_file`` marks the one allowed target that belongs to no role,
    :data:`LEJI_IGNORE_REL`. It is never produced here: only the named exception in
    ``fsx.py`` constructs it, on the requested entry, and a source-audit test pins that
    single constructor site.

    KEYWORD-ONLY, deliberately. The pin that keeps ``metadata_file`` to one constructor
    reads NAMES, so a positional ``TargetVerdict(True, "", False, False, False, True)``
    would set the field without ever spelling it. ``kw_only`` removes that spelling from
    the language rather than leaving it to an audit to chase: a positional construction
    is now a ``TypeError``, not a silent second exception. The audit flags it too, so the
    refusal is visible at review time as well as at run time."""

    ok: bool = False
    role: str = ""
    unresolvable: bool = False
    outside_root: bool = False
    exists: bool = False
    metadata_file: bool = False


def writable_target(root_abs: str, resolved_abs: str, own_role_rel: Optional[str]) -> TargetVerdict:
    """The check-before-act rule for a WRITE or CLEAR target, judged on the
    RESOLVED path immediately before the act, in this order:

    1. The target must resolve INSIDE the repository root. Every write this tool
       makes lands in the repository it was pointed at, with no exceptions: a
       ``.leji/`` role symlinked out of the tree is refused rather than followed. A
       user who wants the export somewhere else copies the finished folder there.
    2. A target under root ``.leji/`` is refused — that tree is the tool's own trust
       domain — UNLESS ``own_role_rel`` is given and the target lies under that one
       role.
    3. Anything else inside the repository is ordinary content and is allowed.

    Both ``root_abs`` and ``resolved_abs`` must be realpath-resolved, so a
    redirecting symlink or a case-variant spelling is judged by where it lands, not
    by how it was written. One home for the rule, called before every write and
    clear.

    ``own_role_rel`` names the ONE ``.leji/`` role the target may land in, as a
    lexical path under the resolved root; pass ``None`` when the target has no
    legitimate ``.leji/`` role at all (user content such as overview.md, which lives
    under the content root, never inside ``.leji/``) — then any ``.leji/`` landing is
    refused."""
    if not _under(root_abs, resolved_abs):
        return TargetVerdict(outside_root=True)
    if not _under(role_abs(root_abs, LEJI_DIR), resolved_abs):
        return TargetVerdict(ok=True)  # inside the repository, outside .leji/
    if own_role_rel is not None and _under(role_abs(root_abs, own_role_rel), resolved_abs):
        return TargetVerdict(ok=True)  # its own role
    return TargetVerdict(role=leji_role(root_abs, resolved_abs))
