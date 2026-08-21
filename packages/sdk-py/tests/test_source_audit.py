"""The acceptance check for the write boundary: no production source file of this SDK
reaches a raw filesystem mutation, or a subprocess that could perform one, except at a
symbol named below. Every other write goes through ``leji/fsx.py`` — the chokepoint and
its guarded conveniences — so a new write site is contained by construction rather than
by remembering to contain it, and a reviewer can read the exceptions instead of
re-deriving them. ``docs/practice/trust-boundary.md`` mirrors both lists.

The scan is an ``ast`` walk with IMPORT-ALIAS RESOLUTION: every call is asked what it
actually calls, so a mutator is recognized by the module function it lands on rather
than by how the call was spelled. ``os.rename(p, q)``, ``import os as o; o.rename(...)``,
``from os import rename``, ``from os import rename as mv``, ``from shutil import rmtree
as nuke``, and ``getattr(os, "rename")`` all resolve to the same ``os.rename``. On top of
that, the unmistakable ``pathlib`` mutator METHODS are matched on the attribute name
whatever the receiver, since Python offers no type resolution here and those names
belong to no other API this repository uses.

Mirrors packages/sdk/test/source-audit.test.ts.
"""

from __future__ import annotations

import ast
import threading
from dataclasses import dataclass
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parents[1] / "src" / "leji"

# --- the mutation surface ------------------------------------------------------

#: ``os`` functions that create, destroy, move, or re-permission something on disk,
#: plus the descriptor writes: bytes reaching a file through an fd are a mutation as
#: much as bytes reaching it through a path, and the descriptor copy the export runs
#: is an allowed exception BY SYMBOL rather than an unwatched one.
OS_MUTATORS = frozenset(
    {
        "chmod",
        "chown",
        "fchmod",
        "fchown",
        "lchmod",
        "lchown",
        "link",
        "makedirs",
        "mkdir",
        "mkfifo",
        "mknod",
        "remove",
        "removedirs",
        "rename",
        "renames",
        "replace",
        "rmdir",
        "symlink",
        "truncate",
        "ftruncate",
        "unlink",
        "utime",
        "write",
        "writev",
        "pwrite",
    }
)

#: ``shutil`` copies, moves, and recursive deletes.
SHUTIL_MUTATORS = frozenset(
    {
        "copy",
        "copy2",
        "copyfile",
        "copymode",
        "copystat",
        "copytree",
        "make_archive",
        "move",
        "rmtree",
        "unpack_archive",
    }
)

#: ``tempfile`` entry points that materialize something on a filesystem.
TEMPFILE_MUTATORS = frozenset(
    {"NamedTemporaryFile", "TemporaryDirectory", "TemporaryFile", "mkdtemp", "mkstemp"}
)

#: Anything that hands work to another program, which can then write whatever it likes.
SUBPROCESS_SPAWNERS = frozenset(
    {"Popen", "call", "check_call", "check_output", "getoutput", "getstatusoutput", "run"}
)

#: ``os``'s own process launchers, the same class as ``subprocess``.
OS_SPAWNERS = frozenset(
    {
        "execl",
        "execle",
        "execlp",
        "execv",
        "execve",
        "execvp",
        "execvpe",
        "fork",
        "forkpty",
        "popen",
        "posix_spawn",
        "posix_spawnp",
        "spawnl",
        "spawnv",
        "spawnve",
        "system",
    }
)

#: ``pathlib`` mutator methods, matched on the attribute name whatever the receiver:
#: no other API this repository uses carries these names, so an indirect receiver
#: (``p = Path(x); p.write_text(...)``) is caught along with the direct one.
PATH_MUTATOR_METHODS = frozenset(
    {
        "chmod",
        "hardlink_to",
        "lchmod",
        "mkdir",
        "rename",
        "rmdir",
        "symlink_to",
        "touch",
        "unlink",
        "write_bytes",
        "write_text",
    }
)

#: ``Path.replace(target)`` takes ONE argument; ``str.replace(old, new)`` takes at
#: least two. The arity is what tells the path mutator from the string method, which
#: is why this one name is judged separately from the set above.
PATH_REPLACE = "replace"

MODULE_MUTATORS = {
    "os": OS_MUTATORS,
    "os.path": frozenset(),
    "shutil": SHUTIL_MUTATORS,
    "tempfile": TEMPFILE_MUTATORS,
}
MODULE_SPAWNERS = {"subprocess": SUBPROCESS_SPAWNERS, "os": OS_SPAWNERS}

#: Read-only ``open()`` modes. Any other mode creates, truncates, or appends; an
#: absent mode is Python's default ``"r"``, which is read-only.
READ_ONLY_OPEN_MODES = frozenset({"r", "rb", "rt", "br", "tr"})

#: The three spellings of "open a file": the builtin, ``io.open`` (the very same
#: function under another name), and ``Path.open``. All three create or truncate under
#: a write mode, so all three are judged by the mode rather than by the name. The mode
#: sits at a different argument position for the method form, which takes no path.
BUILTIN_OPEN_MODE_INDEX = 1
PATH_OPEN_MODE_INDEX = 0

# --- the allow-lists -----------------------------------------------------------

#: The write allow-list, by ``file#symbol`` — never by whole module, so a future raw
#: mutation elsewhere in an allowed file still fails. An entry that matches nothing
#: fails too: a stale exception is an exception nobody is checking. The symbol is the
#: dotted name of the enclosing function (a lambda is transparent, belonging to the
#: function that owns it).
ALLOWED_WRITES: dict[str, str] = {
    "fsx.py#write_file_guarded.op": "the chokepoint itself: the guarded write, judged before it acts",
    "fsx.py#mkdirp_guarded": "the chokepoint itself: the guarded directory establishment",
    "fsx.py#rm_guarded.op": "the chokepoint itself: the guarded clear",
    "fsx.py#rename_guarded": "the chokepoint itself: the guarded rename, both ends judged",
    "fsx.py#chmod_guarded": "the chokepoint itself: the guarded mode change",
    "fsx.py#open_write_guarded": "the chokepoint itself: the guarded destination descriptor",
    "fsx.py#write_file_atomic_guarded": "the chokepoint itself: temp sibling plus rename, both ends judged",
    "export_cmd.py#_copy_from_descriptor": (
        "writes into the descriptor open_write_guarded returned, never to a path"
    ),
    "mounts.py#extract_projection": "mounts per-entry protocol, under a store root the chokepoint established",
    "mounts.py#_publish_cache_entry": "mounts per-entry protocol: sidecar, marker, publish-by-rename, staging clear",
    "mounts.py#hydrate_mounts": "mounts per-entry protocol: clears its own established staging directory",
    "mounts.py#verify_projection": "verification staging under the OS temp directory, outside the repository",
    "init_cmd.py#init_layer": "root bootstrap: creates the selected root before any repository root exists",
    "init_cmd.py#adopt_layer": "root bootstrap: creates the selected root before any repository root exists",
}

#: The subprocess allow-list. A child process is outside every guard this SDK can
#: enforce, so each caller is named with what it runs and what it may write.
ALLOWED_SUBPROCESSES: dict[str, str] = {
    "gitutil.py#_git": "read-only git queries (log, ls-files, status) in the host repository",
    "mounts.py#run_git": (
        "the federation resolver: git init/fetch write ONLY into a store or cache root the "
        "chokepoint established, plus read-only queries"
    ),
    "init_cmd.py#_git_config": "read-only `git config --get`",
    "init_cmd.py#_hooks_path_config": "read-only `git -C root config core.hooksPath`",
    "init_cmd.py#_git_hooks_dir": "read-only `git rev-parse --git-path hooks`",
    "init_cmd.py#_git_dirs": "read-only `git rev-parse --git-dir --git-common-dir`",
    "init_cmd.py#_capture_run": (
        "the handoff IO's bounded probe: asks for a version with argv only, cwd-pinned to the "
        "repository root, stdin closed, stderr discarded, output and wall time capped while the "
        "child runs (reads are unbuffered and sized to what the cap still allows, so passing the "
        "cap terminates the child promptly, whole session and all), and an environment that "
        "REPLACES this process's rather than extending it; it never invokes a package manager's "
        "script runner, and it writes nothing"
    ),
    "init_cmd.py#_default_handoff_io.launch": (
        "the handoff IO: launches the agent host the user chose; its writes are that program, "
        "not this SDK"
    ),
    "dependency.py#default_dependency_io.run": (
        "the declaration offer: runs the repository's OWN package manager add command, argv only "
        "and never a shell, and only after the user says yes at init/adopt; its writes are that "
        "manager's (manifest and lockfile), not this SDK's"
    ),
    "init_cmd.py#_default_handoff_io.run": (
        "the handoff IO: runs the host command the user chose, same reasoning as `launch`"
    ),
    "serve_cmd.py#open_browser": "opens the preview URL in the desktop browser; writes nothing",
    "localcli.py#_exec_replace": (
        "the hand-off: the installed console script REPLACES itself with the repository's OWN "
        "pinned Leji CLI, chosen only when the repository directly declares it and the copy is "
        "installed in the project environment inside the repository with its distribution "
        "identity verified and meeting the layer's minimum; argv, never a shell, and the target "
        "inherits this terminal and environment because it IS this invocation, so its writes are "
        "that copy's rather than this one's"
    ),
    "localcli.py#_run_child": (
        "the same hand-off on Windows, where a process cannot replace itself: the identical "
        "target, run as a child so its return code can be re-raised as this process's exit"
    ),
}


# --- the analyzer ---------------------------------------------------------------


@dataclass(frozen=True)
class Hit:
    key: str
    line: int
    name: str


class _Analyzer(ast.NodeVisitor):
    """One module's filesystem mutations and subprocess launches.

    Import aliases are resolved first, so the binding a call was reached through does
    not matter: ``modules`` maps a local name to the module it aliases (``import os as
    o`` -> ``{"o": "os"}``), and ``symbols`` maps a local name to the SET of
    ``module.function`` values it may hold (``from os import rename as mv`` ->
    ``{"mv": {"os.rename"}}``). A set rather than one value because a name can be bound
    more than once — ``x = io.open`` then ``x = os.rename`` — and a static reader cannot
    know which binding a call reaches; every possibility is therefore judged, so the
    audit over-approximates which names are dangerous and never under-approximates."""

    def __init__(self, rel: str, tree: ast.AST) -> None:
        self.rel = rel
        self.writes: list[Hit] = []
        self.subprocesses: list[Hit] = []
        self.modules: dict[str, str] = {}
        self.symbols: dict[str, set[str]] = {}
        self.scope: list[str] = []
        self._collect_imports(tree)
        self._collect_assignments(tree)

    # -- imports ---------------------------------------------------------------

    def _collect_imports(self, tree: ast.AST) -> None:
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    self.modules[alias.asname or alias.name.split(".")[0]] = alias.name
            elif isinstance(node, ast.ImportFrom) and node.module is not None and node.level == 0:
                for alias in node.names:
                    local = alias.asname or alias.name
                    if alias.name in MODULE_MUTATORS or alias.name in MODULE_SPAWNERS:
                        self.modules[local] = alias.name  # `from os import path`-style
                    self.symbols.setdefault(local, set()).add(f"{node.module}.{alias.name}")

    def _collect_assignments(self, tree: ast.AST) -> None:
        """Rebind a watched function to a local name and the call site names neither
        the module nor the function: ``mv = os.rename`` then ``mv(a, b)``. Every simple
        assignment whose value resolves to a module function is ADDED to the set the
        same symbol table an import would populate holds for that name, so the call
        resolves identically — and a name assigned twice carries both possibilities,
        because which one a call reaches is a runtime fact this reader does not have.

        Run to a TRUE fixpoint — passes until one of them changes nothing — because a
        chain (``a = os.rename`` then ``b = a``) resolves one link per pass and
        ``ast.walk`` is not source order, so a chain assembled bottom-up needs as many
        passes as it has links. No pass cap: a cap silently stops resolving every chain
        longer than itself, which is an under-approximation nobody sees.

        Termination rests on the table being MONOTONE, and a monotone table over a
        finite set of names cannot loop forever: every set only GROWS, over a universe
        of qualified names the module's own imports and attributes already bound, so a
        pass can never undo an earlier one and "no change" is both reachable and final.
        Neither of the two tempting alternatives works. Last-write-wins does not
        terminate at all — two assignments of different values to one name flip it back
        and forth and ``changed`` never goes false. Binding a name once (with an upgrade
        to a watched value) terminates but UNDER-approximates: it drops the second
        watched binding of ``x = io.open`` then ``x = os.rename``, and the call
        ``x(a, "r")`` then reads as a read-only open. The table is module-wide rather
        than per-scope for the same reason the value is a set: an audit may
        over-approximate which names are dangerous, never under-approximate."""
        changed = True
        while changed:
            changed = False
            for node in ast.walk(tree):
                if isinstance(node, ast.Assign):
                    targets: list[ast.expr] = list(node.targets)
                    value: ast.expr | None = node.value
                elif isinstance(node, ast.AnnAssign):
                    targets, value = [node.target], node.value
                else:
                    continue
                qualified = set() if value is None else self._resolutions(value)
                if not qualified:
                    continue
                for target in targets:
                    if not isinstance(target, ast.Name):
                        continue
                    known = self.symbols.setdefault(target.id, set())
                    if not qualified <= known:
                        known |= qualified
                        changed = True

    # -- scope -----------------------------------------------------------------

    def _in_scope(self, name: str, node: ast.AST) -> None:
        self.scope.append(name)
        self.generic_visit(node)
        self.scope.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._in_scope(node.name, node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._in_scope(node.name, node)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self._in_scope(node.name, node)

    @property
    def _key(self) -> str:
        return f"{self.rel}#{'.'.join(self.scope) or '(top level)'}"

    def _record(self, into: list[Hit], node: ast.AST, name: str) -> None:
        into.append(Hit(key=self._key, line=getattr(node, "lineno", 0), name=name))

    # -- calls -----------------------------------------------------------------

    def _resolutions(self, func: ast.expr) -> set[str]:
        """Every ``module.function`` a callee may name, following import aliases and
        rebinding; empty when the callee is not a module-level function this audit
        tracks. More than one member means the name was bound more than once, and each
        member is judged on its own — the call is whichever of them runs."""
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            module = self.modules.get(func.value.id)
            return set() if module is None else {f"{module}.{func.attr}"}
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Attribute):
            return {f"{inner}.{func.attr}" for inner in self._resolutions(func.value)}
        if isinstance(func, ast.Name):
            return set(self.symbols.get(func.id, ()))
        return set()

    def _flag_qualified(self, node: ast.Call, qualified: str) -> None:
        """Record the call under whichever list this qualified name belongs to. Both
        lists are consulted, never one or the other: a name holding both ``os.rename``
        and ``subprocess.run`` is a write hit AND a subprocess hit, so neither the write
        allow-list nor the subprocess allow-list can be slipped past by rebinding."""
        module, _, name = qualified.rpartition(".")
        if name in MODULE_MUTATORS.get(module, frozenset()):
            self._record(self.writes, node, qualified)
        if name in MODULE_SPAWNERS.get(module, frozenset()):
            self._record(self.subprocesses, node, qualified)

    def _judge_call(self, node: ast.Call, qualified: str) -> None:
        """One possibility for what this call lands on. The mode judgement belongs to
        the open family alone; any other watched member is a hit whatever the arguments
        look like, since the arguments were written for the binding the author had in
        mind, not for the one this member names."""
        if qualified == "os.open":
            if not _read_only_os_open(node):
                self._record(self.writes, node, "os.open")
        elif qualified in ("io.open", "builtins.open"):
            # `io.open` IS the builtin, reached through the module that defines it.
            if not _read_only_open(node, BUILTIN_OPEN_MODE_INDEX):
                self._record(self.writes, node, qualified)
        else:
            self._flag_qualified(node, qualified)

    def visit_Call(self, node: ast.Call) -> None:
        for qualified in sorted(self._resolutions(node.func)):
            self._judge_call(node, qualified)
        # `getattr(os, "rename")` reaches a mutator without ever naming it as a call:
        # the module and the attribute are both there to read, so it is resolved the
        # same way rather than left as a residual.
        if isinstance(node.func, ast.Name) and node.func.id == "getattr" and len(node.args) >= 2:
            target, attr = node.args[0], node.args[1]
            if isinstance(target, ast.Name) and isinstance(attr, ast.Constant):
                module = self.modules.get(target.id)
                if module is not None and isinstance(attr.value, str):
                    self._flag_qualified(node, f"{module}.{attr.value}")
        # The builtin `open`, unless the mode is provably read-only.
        if (
            isinstance(node.func, ast.Name)
            and node.func.id == "open"
            and "open" not in self.symbols
        ):
            if not _read_only_open(node, BUILTIN_OPEN_MODE_INDEX):
                self._record(self.writes, node, "open")
        # The pathlib mutator methods, whatever the receiver.
        if isinstance(node.func, ast.Attribute) and not self._resolutions(node.func):
            attr = node.func.attr
            if attr in PATH_MUTATOR_METHODS:
                self._record(self.writes, node, f"Path.{attr}")
            elif attr == PATH_REPLACE and len(node.args) == 1 and not node.keywords:
                self._record(self.writes, node, "Path.replace")
            elif attr == "open" and not _read_only_open(node, PATH_OPEN_MODE_INDEX):
                # `Path.open` takes no path, so its mode is the FIRST argument.
                self._record(self.writes, node, "Path.open")
        self.generic_visit(node)


def _read_only_open(node: ast.Call, mode_index: int) -> bool:
    """``open(p)`` and ``open(p, "r")`` read; every other mode creates, truncates or
    appends, and a non-literal mode cannot be proven read-only. ``mode_index`` is where
    the mode sits positionally: after the path for the builtin and ``io.open``, first
    for ``Path.open``, which is already bound to its path."""
    mode: ast.expr | None = node.args[mode_index] if len(node.args) > mode_index else None
    for keyword in node.keywords:
        if keyword.arg == "mode":
            mode = keyword.value
    if mode is None:
        return True
    return isinstance(mode, ast.Constant) and mode.value in READ_ONLY_OPEN_MODES


def _read_only_os_open(node: ast.Call) -> bool:
    """``os.open`` reads only when its flags are literally ``os.O_RDONLY``; anything
    else — a creating or truncating flag set, or flags this audit cannot read — is a
    mutation."""
    flags: ast.expr | None = node.args[1] if len(node.args) > 1 else None
    for keyword in node.keywords:
        if keyword.arg == "flags":
            flags = keyword.value
    return (
        isinstance(flags, ast.Attribute)
        and flags.attr == "O_RDONLY"
        and isinstance(flags.value, ast.Name)
    )


def _analyze(rel: str, source: str) -> tuple[list[Hit], list[Hit]]:
    analyzer = _Analyzer(rel, ast.parse(source))
    analyzer.visit(ast.parse(source))
    return analyzer.writes, analyzer.subprocesses


def _audit_tree() -> tuple[list[Hit], list[Hit]]:
    """Every production source file of this SDK (there are no tests under ``src/``)."""
    files = sorted(SRC_DIR.rglob("*.py"))
    assert files, "the audit loaded no source files"
    writes: list[Hit] = []
    subprocesses: list[Hit] = []
    for path in files:
        rel = path.relative_to(SRC_DIR).as_posix()
        found = _analyze(rel, path.read_text(encoding="utf-8"))
        writes.extend(found[0])
        subprocesses.extend(found[1])
    return writes, subprocesses


def _unexpected(hits: list[Hit], allowed: dict[str, str]) -> list[str]:
    return [f"{h.key} ({h.name}) at line {h.line}" for h in hits if h.key not in allowed]


def _stale(hits: list[Hit], allowed: dict[str, str]) -> list[str]:
    matched = {h.key for h in hits}
    return [key for key in allowed if key not in matched]


# --- the acceptance checks -------------------------------------------------------


def test_no_production_source_reaches_a_raw_filesystem_mutation() -> None:
    writes, _ = _audit_tree()
    outside = _unexpected(writes, ALLOWED_WRITES)
    assert outside == [], (
        f"raw filesystem mutations outside the chokepoint: {', '.join(outside)}\n"
        "Route the write through leji/fsx.py (write_file_guarded, mkdirp_guarded, rm_guarded, "
        "rename_guarded, chmod_guarded, open_write_guarded, write_file_atomic_guarded), or argue "
        "the exception into the allow-list."
    )
    dead = _stale(writes, ALLOWED_WRITES)
    assert dead == [], f"write allow-list entries matching no symbol (delete them): {dead}"


def test_every_subprocess_call_is_a_named_reasoned_exception() -> None:
    _, subprocesses = _audit_tree()
    outside = _unexpected(subprocesses, ALLOWED_SUBPROCESSES)
    assert outside == [], (
        f"subprocess calls outside the allow-list: {', '.join(outside)}\n"
        "A child process writes wherever it likes; name the caller and say what it runs and what "
        "it may write."
    )
    dead = _stale(subprocesses, ALLOWED_SUBPROCESSES)
    assert dead == [], f"subprocess allow-list entries matching no symbol (delete them): {dead}"


# --- the laundering corpus, permanent ---------------------------------------------

# Each probe below is a way of reaching a mutator that a naive scanner misses; they are
# fed to the same analyzer as production source, so the audit's reach is asserted rather
# than assumed. The negatives at the end are the controls: ordinary calls that share
# their names, or their shape, with the laundering above and must never be flagged.


def _reverse_alias_chain(links: int, root: str) -> str:
    """A module that aliases ``root`` ``links`` deep, one builder function per link, the
    builders DEFINED in REVERSE dependency order: the assignment consuming a link is
    walked before the assignment producing it. A pass of the collector can therefore
    resolve exactly one more link, so the chain costs one pass per link and any cap stops
    resolving a chain longer than itself — while the module stays ordinary, runnable
    Python (run the builders in order and ``_l<links>`` IS ``root``), so a miss here is a
    real miss rather than an artifact of source a program could never execute."""
    lines = ["import os"]
    lines += [f"def _s{i}():\n    global _l{i}\n    _l{i} = _l{i - 1}" for i in range(links, 1, -1)]
    lines.append(f"def _s1():\n    global _l1\n    _l1 = {root}")
    lines.append(f"def reached(a, b):\n    _l{links}(a, b)")
    return "\n".join(lines) + "\n"


#: Long enough that no plausible cap resolves it, and far past the eight passes that
#: once bounded the loop.
CHAIN_LINKS = 14

PROBES: list[tuple[str, str, bool]] = [
    (
        "aliased module",
        "import os as o\ndef launder(p):\n    o.rename(p, p + '.bak')\n",
        True,
    ),
    (
        "destructured import",
        "from shutil import rmtree\ndef launder(p):\n    rmtree(p)\n",
        True,
    ),
    (
        "renamed destructured import",
        "from os import rename as mv\ndef launder(p, q):\n    mv(p, q)\n",
        True,
    ),
    (
        "getattr indirection",
        "import os\ndef launder(p, q):\n    getattr(os, 'rename')(p, q)\n",
        True,
    ),
    (
        "an indirect pathlib receiver",
        "def launder(p):\n    target = p / 'x'\n    target.write_text('x')\n",
        True,
    ),
    (
        "open in write mode",
        "def launder(p):\n    with open(p, 'w') as f:\n        f.write('x')\n",
        True,
    ),
    (
        "os.open with creating flags",
        "import os\ndef launder(p):\n    os.open(p, os.O_WRONLY | os.O_CREAT)\n",
        True,
    ),
    (
        "a renamed subprocess import",
        "from subprocess import run as go\ndef launder():\n    go(['rm', '-rf', '/'])\n",
        True,
    ),
    (
        "a descriptor write",
        "import os\ndef launder(fd, data):\n    os.write(fd, data)\n",
        True,
    ),
    (
        "Path.open in write mode",
        "def launder(p):\n    with p.open('w') as f:\n        f.write('x')\n",
        True,
    ),
    (
        "io.open in write mode",
        "import io\ndef launder(p):\n    with io.open(p, 'w') as f:\n        f.write('x')\n",
        True,
    ),
    (
        "assignment laundering",
        "import os\nmv = os.rename\ndef launder(a, b):\n    mv(a, b)\n",
        True,
    ),
    (
        "assignment laundering through a chain",
        "import os\n_a = os.rmdir\n_b = _a\ndef launder(p):\n    _b(p)\n",
        True,
    ),
    (
        f"assignment laundering through a {CHAIN_LINKS}-link chain, defined in reverse",
        _reverse_alias_chain(CHAIN_LINKS, "os.rename"),
        True,
    ),
    (
        "negative: Path.open in read mode",
        "def read(p):\n    with p.open('r') as f:\n        return f.read()\n",
        False,
    ),
    (
        "negative: Path.open with no mode",
        "def read(p):\n    with p.open() as f:\n        return f.read()\n",
        False,
    ),
    (
        "negative: a read and a string replace",
        "def read(p, line):\n    with open(p) as f:\n        return f.read().replace('a', 'b')\n",
        False,
    ),
    (
        "negative: a read-only os.open and a dict copy",
        "import os\ndef read(p, d):\n    fd = os.open(p, os.O_RDONLY)\n    return fd, d.copy()\n",
        False,
    ),
    (
        f"negative: a {CHAIN_LINKS}-link chain ending in a function nobody watches",
        _reverse_alias_chain(CHAIN_LINKS, "os.getcwd"),
        False,
    ),
]


def test_the_analyzer_sees_through_every_known_laundering() -> None:
    for name, source, expected in PROBES:
        writes, subprocesses = _analyze("__probe.py", source)
        flagged = bool(writes) or bool(subprocesses)
        assert flagged == expected, (
            f"probe {name!r}: expected {'a hit' if expected else 'no hit'}, "
            f"got writes={[h.name for h in writes]} subprocesses={[h.name for h in subprocesses]}"
        )


# --- the resolver's termination, permanent -----------------------------------------

# A name REBOUND to a second value is where a resolver that merely overwrites its table
# stops converging: the two assignments hand the name back and forth, `changed` never
# goes false, and an uncapped loop spins forever. Growing a SET per name is what rules
# that out — and keeping every member is what stops the opposite failure, a resolver that
# binds a name once and so never sees the second watched function. These probes pin both,
# in both orders, across the open family and across the write/subprocess line. They are
# kept out of PROBES deliberately: a regression here HANGS rather than returns, so they
# need the wall-clock bound below instead of the shared corpus loop.
REBINDING_PROBES: list[tuple[str, str, list[str], list[str]]] = [
    (
        "rebinding, harmless binding first",
        "import os\nx = os.path.join\nx = os.rename\ndef launder(p, q):\n    x(p, q)\n",
        ["os.rename"],
        [],
    ),
    (
        "rebinding, watched binding first",
        "import os\nx = os.rename\nx = os.path.join\ndef launder(p, q):\n    x(p, q)\n",
        ["os.rename"],
        [],
    ),
    (
        # The arguments were written for the open; the rename is reached with the very
        # same call, and a mode argument says nothing about it.
        "rebinding from one watched function to another, under a read-only mode",
        'import io, os\nx = io.open\nx = os.rename\ndef launder(a):\n    x(a, "r")\n',
        ["os.rename"],
        [],
    ),
    (
        "rebinding across the write/subprocess line",
        "import os, subprocess\nx = os.rename\nx = subprocess.run\n"
        "def launder(a, b):\n    x(a, b)\n",
        ["os.rename"],
        ["subprocess.run"],
    ),
    (
        "negative: rebinding among functions nobody watches",
        "import os\nx = os.path.join\nx = os.getcwd\ndef read():\n    return x()\n",
        [],
        [],
    ),
]

#: Generous by three orders of magnitude — the whole file analyzes in well under a
#: second — because the bound exists to catch a resolver that never returns, not a slow
#: one.
RESOLVER_TIMEOUT_SECONDS = 5.0


def _analyze_within(seconds: float, rel: str, source: str) -> tuple[list[Hit], list[Hit]] | None:
    """``_analyze`` on a worker thread; None when it is still running after ``seconds``.

    A resolver that stops converging never leaves a single ``_analyze`` call, so the
    only way to fail on it is a wall-clock bound: without one the regression hangs the
    whole pytest run instead of failing one test. The worker is a daemon, so a spinning
    one cannot hold the run open either."""
    found: list[tuple[list[Hit], list[Hit]]] = []
    failed: list[BaseException] = []

    def run() -> None:
        try:
            found.append(_analyze(rel, source))
        except BaseException as error:  # reported by the caller, never swallowed
            failed.append(error)

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(seconds)
    if failed:
        raise failed[0]
    return found[0] if found else None


def test_the_assignment_resolver_keeps_every_binding_of_a_rebound_name() -> None:
    for name, source, expected_writes, expected_subprocesses in REBINDING_PROBES:
        found = _analyze_within(RESOLVER_TIMEOUT_SECONDS, "__probe.py", source)
        assert found is not None, (
            f"probe {name!r}: the assignment resolver did not converge within "
            f"{RESOLVER_TIMEOUT_SECONDS}s. A rebound name must not be able to flip the "
            "symbol table back and forth: grow a set per name, so the table is monotone "
            "and 'no change' is reachable."
        )
        writes, subprocesses = found
        assert [h.name for h in writes] == expected_writes, (
            f"probe {name!r}: expected writes {expected_writes}, "
            f"got {[h.name for h in writes]}. Every binding a name may hold is judged; "
            "dropping one is how a second watched function slips through."
        )
        assert [h.name for h in subprocesses] == expected_subprocesses, (
            f"probe {name!r}: expected subprocesses {expected_subprocesses}, "
            f"got {[h.name for h in subprocesses]}"
        )
