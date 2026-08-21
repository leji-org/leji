"""Which dependency ecosystem owns a repository root, which package manager runs
it, how the Leji CLI is declared as a dev dependency there, and how a hook or CI
job should invoke it.

Pure and offline: it reads a bounded set of files directly under the root and
writes nothing, launches nothing, and never walks up out of the root (an add in a
parent directory would write outside the root the user targeted). Every answer is
a total decision table over repository evidence, so the three SDKs return the same
report for the same tree. Transcribed from the TypeScript reference
(``packages/sdk/src/lib/ecosystem.ts``): tables and strings byte for byte.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from .fsx import resolved_within_root

# The npm package name. Its presence in package.json's dependency maps is what
# ``directDeclared`` reports for a Node repository.
DEP_NAME = "@leji-org/leji"
# The distribution name on PyPI and the name a Python manifest declares.
PY_DIST = "leji"
# The Go module path a ``tool`` directive names for the CLI.
GO_TOOL_PATH = "github.com/leji-org/leji/packages/sdk-go/cmd/leji"

# Per-manager commands. ``add`` is None for a manager that cannot declare a dev
# dependency from the command line; its guidance is printed instead. Argv lists,
# never shell strings. No version pin: the lockfile pins the exact version, and Go
# needs a selector, so it takes @latest.
MANAGER_COMMANDS: dict[str, dict[str, Optional[list[str]]]] = {
    "npm": {
        "add": ["npm", "i", "-D", DEP_NAME],
        "runner": ["npx", "--no-install", DEP_NAME],
        "install": ["npm", "install"],
    },
    "pnpm": {
        "add": ["pnpm", "add", "-D", DEP_NAME],
        "runner": ["pnpm", "exec", "leji"],
        "install": ["pnpm", "install"],
    },
    "yarn": {
        "add": ["yarn", "add", "-D", DEP_NAME],
        "runner": ["yarn", "leji"],
        "install": ["yarn", "install"],
    },
    "bun": {
        "add": ["bun", "add", "-d", DEP_NAME],
        "runner": ["bun", "run", "leji"],
        "install": ["bun", "install"],
    },
    "uv": {
        "add": ["uv", "add", "--dev", PY_DIST],
        "runner": ["uv", "run", "leji"],
        "install": ["uv", "sync"],
    },
    "poetry": {
        "add": ["poetry", "add", "--group", "dev", PY_DIST],
        "runner": ["poetry", "run", "leji"],
        "install": ["poetry", "install"],
    },
    "pdm": {
        "add": ["pdm", "add", "-dG", "dev", PY_DIST],
        "runner": ["pdm", "run", "leji"],
        "install": ["pdm", "install"],
    },
    "pipenv": {
        "add": ["pipenv", "install", "--dev", PY_DIST],
        "runner": ["pipenv", "run", "leji"],
        "install": ["pipenv", "install", "--dev"],
    },
    "pip": {"add": None, "runner": ["leji"], "install": None},
    "go": {
        "add": ["go", "get", "-tool", f"{GO_TOOL_PATH}@latest"],
        "runner": ["go", "tool", "leji"],
        # The same command F10's CI table installs a Go repository's tools with.
        "install": ["go", "mod", "download"],
    },
    "go-legacy": {"add": None, "runner": ["leji"], "install": None},
}


def manager_runner_argv(manager: str) -> Optional[list[str]]:
    """The runner argv for one manager name, or None when leji does not know it.
    One runner table serves detection, the hook, and CI."""
    cell = MANAGER_COMMANDS.get(manager)
    return list(cell["runner"]) if cell and cell["runner"] else None


def manager_install_argv(manager: str) -> Optional[list[str]]:
    """The plain install argv for one manager name: what a joiner runs on a fresh clone
    so the CLI the repository declares actually resolves. ``None`` when leji does not
    know the manager, or when the manager has no single install command."""
    cell = MANAGER_COMMANDS.get(manager)
    install = cell.get("install") if cell else None
    return list(install) if install else None


# The fallback runner: the CLI on PATH, for every repository that has not declared it.
PLAIN_RUNNER = ["leji"]

NODE_MANIFEST = "package.json"
GO_MANIFEST = "go.mod"
PYPROJECT = "pyproject.toml"
PIPFILE = "Pipfile"

# Node lockfile families, in the fixed order every list of them uses. Two names
# mark bun (text and binary); either one is presence-only evidence.
NODE_LOCKS: list[tuple[str, str]] = [
    ("package-lock.json", "npm"),
    ("pnpm-lock.yaml", "pnpm"),
    ("yarn.lock", "yarn"),
    ("bun.lock", "bun"),
    ("bun.lockb", "bun"),
]
NODE_MANAGERS = ["npm", "pnpm", "yarn", "bun"]

# Python lock families, in the fixed order every list of them uses. ``Pipfile`` is
# a family member without being a lock: it selects pipenv, but only Pipfile.lock
# evidences a lock.
PY_LOCKS: list[tuple[str, str, bool]] = [
    ("uv.lock", "uv", True),
    ("poetry.lock", "poetry", True),
    ("pdm.lock", "pdm", True),
    ("Pipfile.lock", "pipenv", True),
    (PIPFILE, "pipenv", False),
]
# ``[tool.<x>]`` tables that name a manager when no lock family is present.
PY_TOOL_TABLES: list[tuple[str, str]] = [
    ("tool.uv", "uv"),
    ("tool.poetry", "poetry"),
    ("tool.pdm", "pdm"),
]
# Root files that gate the Python ecosystem alongside the two manifests.
REQUIREMENTS_RE = re.compile(r"^requirements[A-Za-z0-9._-]*\.txt$")

# --- the human block ------------------------------------------------------
# Every string the offer prints lives here once, so the three SDKs transcribe one
# table rather than re-deriving prose.

_OFFER_LEAD = "To declare the Leji CLI as a dev dependency so a clean install brings leji, run:"
_DECLARE_WITH_TOOL = "Declare the Leji CLI as a dev dependency with the tool this repo uses."
INDENT = "   "


def _join_and(items: list[str]) -> str:
    """``a``, ``a and b``, ``a, b and c`` — the one list join every message uses."""
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    return ", ".join(items[:-1]) + " and " + items[-1]


def text_offer(manager: str, file: str) -> str:
    return f"Detected {manager} ({file}). {_OFFER_LEAD}"


def text_declared(manifest: str) -> str:
    return f"The Leji CLI is already declared in {manifest}."


def text_ambiguous(manifest: str, files: list[str]) -> str:
    return (
        f"Detected {manifest} with {_join_and(files)}; leji will not guess the package manager. "
        "Declare it with the one this repo uses:"
    )


def text_multiple(manifests: list[str], commands: bool) -> str:
    tail = ":" if commands else "."
    return (
        f"Detected {_join_and(manifests)}; leji will not guess which ecosystem owns this repository. "
        f"Declare it with the one this repo uses{tail}"
    )


TEXT_NONE = [
    "No package.json, pyproject.toml or go.mod here, so there is nothing for leji to declare itself in. "
    "Install the Leji CLI for yourself:",
    f"{INDENT}npm install -g {DEP_NAME}",
    "Other runtimes and the full walkthrough: https://leji.org/quickstart/",
]


def text_unsupported(manifest: str) -> str:
    return (
        f"Detected {manifest}, whose packageManager field names a package manager leji does not know; "
        f"leji will not guess. {_DECLARE_WITH_TOOL}"
    )


def text_unreadable(manifest: str) -> str:
    return f"Could not read {manifest}, so leji will not guess the package manager. {_DECLARE_WITH_TOOL}"


def text_refused(files: list[str]) -> str:
    return f"Refusing to read {_join_and(files)}: not a regular file inside this repository. {_DECLARE_WITH_TOOL}"


def text_pip_groups(file: str) -> list[str]:
    return [
        f"Detected pip ({file}). To declare the Leji CLI as a dev dependency so a clean install brings leji, "
        f"add to {PYPROJECT}:",
        f"{INDENT}[dependency-groups]",
        f'{INDENT}dev = ["{PY_DIST}"]',
        "then run it with pip 25.1 or newer:",
        f"{INDENT}pip install --group dev",
    ]


def text_pip_requirements(file: str) -> list[str]:
    return [
        f"Detected pip ({file}). To declare the Leji CLI as a dev dependency so a clean install brings leji, "
        f"add a line `{PY_DIST}` to requirements-dev.txt, then run:",
        f"{INDENT}pip install -r requirements-dev.txt",
    ]


def text_go_legacy(file: str) -> list[str]:
    return [
        f"Detected Go ({file}) without a go directive of 1.24 or newer, so leji cannot be declared as a "
        "module tool. Install the Leji CLI for yourself:",
        f"{INDENT}go install {GO_TOOL_PATH}@latest",
    ]


def _line_selected(manager: str, file: str, declared: bool) -> str:
    state = "declared" if declared else "not declared"
    return f"Ecosystem: {manager} ({file}); Leji CLI {state}"


LINE_NONE = "Ecosystem: none detected"


def _line_multiple(manifests: list[str]) -> str:
    return f"Ecosystem: {_join_and(manifests)}; leji will not guess which one owns this repository"


def _line_ambiguous(manifest: str, files: list[str]) -> str:
    return f"Ecosystem: {manifest} with {_join_and(files)}; leji will not guess the package manager"


def _line_unsupported(manifest: str) -> str:
    return f"Ecosystem: {manifest}; unrecognized packageManager field"


def _line_unreadable(manifest: str) -> str:
    return f"Ecosystem: {manifest}; unreadable"


def _line_refused(files: list[str]) -> str:
    return f"Ecosystem: {_join_and(files)}; not a regular file inside this repository"


# The consent path (plan section 3): the prompt, and every outcome of running the
# manager's own add command. leji writes no manifest byte itself, so these are the
# only words it owns once the user says yes.


def consent_disclosure(binary: str) -> str:
    """Printed immediately before the prompt, interactive runs only. The manager
    runs here, as the user, with the user's environment: say so before asking."""
    return (
        f"This runs {binary} here with your environment, as when you run it yourself: "
        "it will contact its registry and may run install scripts."
    )


CONSENT_PROMPT = "Run it now?"


def consent_running(command: list[str]) -> str:
    return "Running: " + " ".join(command)


# What each ecosystem's add command actually declares.
DECLARED_SUBJECT = {"node": DEP_NAME, "python": PY_DIST, "go": "the leji module tool"}


def consent_declared(ecosystem: str) -> str:
    return f"Declared {DECLARED_SUBJECT[ecosystem]}; a clean install now brings leji."


def consent_exited(binary: str, code: int) -> str:
    return f"{binary} exited {code}; run it yourself:"


def consent_signaled(binary: str, signal: str) -> str:
    return f"{binary} was terminated ({signal}); run it yourself:"


def consent_missing(binary: str) -> str:
    return f"{binary} is not on your PATH; run it yourself once it is:"


CONSENT_DECLINED = "Skipped; declare it later with:"


def consent_command(command: list[str]) -> str:
    """One indented command line, so no caller re-derives the indentation."""
    return INDENT + " ".join(command)


# --- evidence eligibility -------------------------------------------------

ENTRY_ABSENT = "absent"
ENTRY_ELIGIBLE = "eligible"
ENTRY_REFUSED = "refused"


def classify_entry(root_abs: str, name: str) -> str:
    """What stands at one probed name directly under the root. A gated file counts
    only when lstat says regular file AND its real path lies inside the real root:
    a symlink, a dangling link, a directory, a socket or a FIFO is refused rather
    than read, so no manifest or lockfile can redirect the answer out of the
    repository the user pointed at."""
    abs_path = os.path.join(root_abs, name)
    try:
        st = os.lstat(abs_path)
    except OSError:
        return ENTRY_ABSENT
    import stat as stat_mod

    if not stat_mod.S_ISREG(st.st_mode):
        return ENTRY_REFUSED
    return ENTRY_ELIGIBLE if resolved_within_root(root_abs, Path(abs_path)) else ENTRY_REFUSED


class _RootScan:
    """The probed names of one root, classified once."""

    def __init__(self, root_abs: str) -> None:
        self.root_abs = root_abs
        self._kinds: dict[str, str] = {}
        self._entries: Optional[list[str]] = None

    def kind(self, name: str) -> str:
        if name not in self._kinds:
            self._kinds[name] = classify_entry(self.root_abs, name)
        return self._kinds[name]

    def present(self, name: str) -> bool:
        return self.kind(name) != ENTRY_ABSENT

    def eligible(self, name: str) -> bool:
        return self.kind(name) == ENTRY_ELIGIBLE

    def refused(self, names: list[str]) -> list[str]:
        """The refused names among ``names``, in the order given."""
        return [n for n in names if self.kind(n) == ENTRY_REFUSED]

    def read(self, name: str) -> Optional[str]:
        """The bytes of one probed name, or None. Structurally gated: a name that is
        not an eligible regular file inside the real root is never opened, so no read
        can bypass the eligibility rule by being spelled at a new call site."""
        if self.kind(name) != ENTRY_ELIGIBLE:
            return None
        try:
            with open(os.path.join(self.root_abs, name), "r", encoding="utf-8") as handle:
                return handle.read()
        except (OSError, UnicodeDecodeError):
            return None

    def matching(self, pattern: re.Pattern[str]) -> list[str]:
        """Every root entry matching ``pattern``, sorted BYTEWISE (never by locale:
        the three SDKs must agree)."""
        if self._entries is None:
            try:
                self._entries = os.listdir(self.root_abs)
            except OSError:
                self._entries = []
        return sorted(n for n in self._entries if pattern.match(n))


# --- result construction --------------------------------------------------


@dataclass
class EcoResult:
    """One gated ecosystem's answer. TOTAL: every field is set on every outcome."""

    ecosystem: str
    status: str
    manifest: Optional[str]
    manager: Optional[str]
    source: Optional[str]
    evidence: list[str]
    add: Optional[list[str]]
    runner: Optional[list[str]]
    direct_declared: bool
    lock_evidenced: bool
    candidates: list[dict[str, Any]]

    def to_json(self) -> dict[str, Any]:
        """The fixed key order the JSON contract pins."""
        return {
            "ecosystem": self.ecosystem,
            "status": self.status,
            "manifest": self.manifest,
            "manager": self.manager,
            "source": self.source,
            "evidence": self.evidence,
            "add": self.add,
            "runner": self.runner,
            "directDeclared": self.direct_declared,
            "lockEvidenced": self.lock_evidenced,
            "candidates": self.candidates,
        }


@dataclass
class EcosystemReport:
    """The whole answer for one root. ``selected`` is non-None only when exactly one
    ecosystem is gated AND it chose a manager."""

    selected: Optional[EcoResult]
    all: list[EcoResult] = field(default_factory=list)
    reason: Optional[str] = None

    def to_json(self) -> dict[str, Any]:
        return {
            "selected": self.selected.to_json() if self.selected else None,
            "all": [r.to_json() for r in self.all],
            "reason": self.reason,
        }


def _result(
    ecosystem: str,
    *,
    status: str = "ok",
    manifest: Optional[str] = None,
    manager: Optional[str] = None,
    source: Optional[str] = None,
    evidence: Optional[list[str]] = None,
    direct_declared: bool = False,
    lock_evidenced: bool = False,
    candidates: Optional[list[dict[str, Any]]] = None,
) -> EcoResult:
    """The one EcoResult constructor. Every field of the result is set here, in the
    fixed key order the JSON contract pins, so no branch can build a partial outcome
    and add/runner always follow the manager rather than the branch."""
    cell = MANAGER_COMMANDS.get(manager) if manager is not None else None
    return EcoResult(
        ecosystem=ecosystem,
        status=status,
        manifest=manifest,
        manager=manager,
        source=source,
        evidence=evidence if evidence is not None else [],
        add=list(cell["add"]) if cell and cell["add"] else None,
        runner=list(cell["runner"]) if cell and cell["runner"] else None,
        direct_declared=direct_declared,
        lock_evidenced=lock_evidenced,
        candidates=candidates if candidates is not None else [],
    )


def _candidates_for(managers: list[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for manager in managers:
        cell = MANAGER_COMMANDS.get(manager)
        add = list(cell["add"]) if cell and cell["add"] else None
        out.append({"manager": manager, "add": add})
    return out


def _uniq(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


# --- Node -----------------------------------------------------------------

# corepack's grammar, <name>[@<version>[+<hash>]]. A value that is present but does
# not parse is malformed — never a fall-through to a lockfile or the default,
# because explicit repository evidence is never overridden by a guess.
PACKAGE_MANAGER_RE = re.compile(
    r"^([a-z][a-z0-9-]*)(?:@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)(?:\+([A-Za-z0-9._-]+))?)?$"
)


def _node_result(scan: _RootScan) -> EcoResult:
    probed = [NODE_MANIFEST] + [f for f, _ in NODE_LOCKS]
    refused = scan.refused(probed)
    if refused:
        return _result(
            "node", status="refused-evidence", manifest=NODE_MANIFEST, evidence=sorted(refused)
        )
    raw = scan.read(NODE_MANIFEST)
    pkg = _parse_package_json(raw) if raw is not None else None
    if pkg is None:
        return _result("node", status="unreadable-manifest", manifest=NODE_MANIFEST)
    locks = [(f, m) for f, m in NODE_LOCKS if scan.eligible(f)]
    evidence = [f for f, _ in locks]
    direct_declared = _declares_dep_in(pkg)

    def selected(manager: str, source: str) -> EcoResult:
        return _result(
            "node",
            manifest=NODE_MANIFEST,
            manager=manager,
            source=source,
            evidence=evidence,
            direct_declared=direct_declared,
            lock_evidenced=any(m == manager for _, m in locks),
        )

    if "packageManager" in pkg:
        value = pkg["packageManager"]
        name = None
        if isinstance(value, str):
            match = PACKAGE_MANAGER_RE.match(value)
            if match:
                name = match.group(1)
        if name is None or name not in NODE_MANAGERS:
            return _result(
                "node",
                status="unsupported-manager",
                manifest=NODE_MANIFEST,
                source="packageManager",
                evidence=evidence,
                direct_declared=direct_declared,
            )
        return selected(name, "packageManager")

    families = _uniq([m for _, m in locks])
    if len(families) > 1:
        return _result(
            "node",
            status="ambiguous-manager",
            manifest=NODE_MANIFEST,
            evidence=evidence,
            direct_declared=direct_declared,
            candidates=_candidates_for(families),
        )
    if len(families) == 1:
        return selected(families[0], "lockfile")
    return selected("npm", "default")


def _reject_non_finite(_: str) -> object:
    """parse_constant hook: a non-finite JSON constant is not strict JSON."""
    raise ValueError("non-finite JSON constant")


def _parse_package_json(raw: str) -> Optional[dict[str, Any]]:
    """Strict JSON after one BOM strip; anything else — unparseable, or parsed to
    something that is not a JSON object — leaves the manifest unreadable, and locks
    and defaults are not consulted from incomplete evidence."""
    text = raw[1:] if raw.startswith("\ufeff") else raw
    try:
        # parse_constant rejects NaN/Infinity/-Infinity, which JSON.parse and Go's
        # encoding/json both forbid and Python's json.loads would otherwise accept:
        # the three SDKs must call the same bytes unreadable.
        parsed = json.loads(text, parse_constant=_reject_non_finite)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _declares_dep_in(pkg: dict[str, Any]) -> bool:
    for field_name in ("dependencies", "devDependencies"):
        deps = pkg.get(field_name)
        if isinstance(deps, dict) and DEP_NAME in deps:
            return True
    return False


# --- Python ---------------------------------------------------------------


@dataclass(frozen=True)
class PythonChoice:
    """Which manager one Python root's evidence names. ``manager`` is None exactly
    when the evidence is ambiguous, and ``candidates`` then names what it could not
    choose between."""

    manager: Optional[str]
    source: Optional[str]
    lock_evidenced: bool
    candidates: list[str]


def python_manager_choice(lock_names: list[str], pyproject_text: Optional[str]) -> PythonChoice:
    """The manager decision table for a Python root, over NAMES and TEXT alone.

    One home for the table, because two callers ask it: the ecosystem report below,
    and the hand-off resolver, which must derive the manager from bytes it verified
    itself rather than from a scan it did not perform. Pure by construction, so
    neither caller can drift from the other about what the same evidence means.
    """
    present = [(f, m, lock) for f, m, lock in PY_LOCKS if f in lock_names]
    families = _uniq([m for _, m, _ in present])
    if len(families) > 1:
        return PythonChoice(None, None, False, families)
    if len(families) == 1:
        # Pipfile alone selects pipenv from the manifest itself; only Pipfile.lock is
        # lock evidence, which is what CI reads to choose a locked install.
        lock = any(m == families[0] and is_lock for _, m, is_lock in present)
        return PythonChoice(families[0], "lockfile" if lock else "manifest", lock, [])
    tables = [
        m
        for t, m in PY_TOOL_TABLES
        if pyproject_text is not None and _toml_has_table(pyproject_text, t)
    ]
    if len(tables) > 1:
        return PythonChoice(None, None, False, tables)
    if len(tables) == 1:
        return PythonChoice(tables[0], "tool-table", False, [])
    # Nothing named a manager: pip is the ecosystem's default, and it is print-only.
    return PythonChoice("pip", "default", False, [])


def python_declares(
    pyproject_text: Optional[str],
    pipfile_text: Optional[str],
    requirements_texts: Iterable[Optional[str]],
) -> bool:
    """Whether a Python root declares the Leji CLI, over TEXT alone. The same two
    callers as :func:`python_manager_choice`, for the same reason. The requirement
    texts are taken lazily, so a caller reads only as far as the first declaration."""
    if pyproject_text is not None and _toml_declares_leji(pyproject_text, _PYPROJECT_FIELDS):
        return True
    if pipfile_text is not None and _toml_declares_leji(pipfile_text, _PIPFILE_FIELDS):
        return True
    return any(text is not None and _requirements_declare_leji(text) for text in requirements_texts)


def _python_result(scan: _RootScan) -> EcoResult:
    requirements = scan.matching(REQUIREMENTS_RE)
    manifest = _python_manifest(scan, requirements)
    probed = _uniq([PYPROJECT] + [f for f, _, _ in PY_LOCKS] + requirements)
    refused = scan.refused(probed)
    if refused:
        return _result(
            "python", status="refused-evidence", manifest=manifest, evidence=sorted(refused)
        )
    pyproject_text = scan.read(PYPROJECT) if scan.eligible(PYPROJECT) else None
    pipfile_text = scan.read(PIPFILE) if scan.eligible(PIPFILE) else None
    if (scan.eligible(PYPROJECT) and pyproject_text is None) or (
        scan.eligible(PIPFILE) and pipfile_text is None
    ):
        return _result("python", status="unreadable-manifest", manifest=manifest)

    lock_names = [f for f, _, _ in PY_LOCKS if scan.eligible(f)]
    evidence = lock_names + requirements
    direct_declared = python_declares(
        pyproject_text,
        pipfile_text,
        (scan.read(name) for name in requirements if scan.eligible(name)),
    )
    choice = python_manager_choice(lock_names, pyproject_text)

    if choice.manager is None:
        return _result(
            "python",
            status="ambiguous-manager",
            manifest=manifest,
            evidence=evidence,
            direct_declared=direct_declared,
            candidates=_candidates_for(choice.candidates),
        )
    return _result(
        "python",
        manifest=manifest,
        manager=choice.manager,
        source=choice.source,
        evidence=evidence,
        direct_declared=direct_declared,
        lock_evidenced=choice.lock_evidenced,
    )


def _python_manifest(scan: _RootScan, requirements: list[str]) -> Optional[str]:
    """Manifest precedence: pyproject, then Pipfile, then the conventional
    requirements files. Decided on presence, so a refused entry still names what was
    refused."""
    if scan.present(PYPROJECT):
        return PYPROJECT
    if scan.present(PIPFILE):
        return PIPFILE
    for name in ("requirements-dev.txt", "requirements.txt"):
        if name in requirements:
            return name
    return requirements[0] if requirements else None


# --- Go -------------------------------------------------------------------

GO_DIRECTIVE_RE = re.compile(r"^go\s+(\d+)\.(\d+)")
_GO_TOOL_BLOCK_RE = re.compile(r"^tool\s*\($")


def _go_result(scan: _RootScan) -> EcoResult:
    refused = scan.refused([GO_MANIFEST])
    if refused:
        return _result("go", status="refused-evidence", manifest=GO_MANIFEST, evidence=refused)
    text = scan.read(GO_MANIFEST)
    if text is None:
        return _result("go", status="unreadable-manifest", manifest=GO_MANIFEST)
    # Tool dependencies are a Go 1.24 feature; an older or missing directive gets the
    # per-person install instead. go.sum is the manager's business, so a declared
    # tool is its own lock evidence.
    direct_declared = _go_declares_tool(text)
    modern = _go_directive_at_least(text, 1, 24)
    return _result(
        "go",
        manifest=GO_MANIFEST,
        manager="go" if modern else "go-legacy",
        source="manifest",
        direct_declared=direct_declared,
        lock_evidenced=modern and direct_declared,
    )


def _go_directive_at_least(text: str, major: int, minor: int) -> bool:
    for line in _split_lines(text):
        match = GO_DIRECTIVE_RE.match(line.strip())
        if not match:
            continue
        found_major, found_minor = int(match.group(1)), int(match.group(2))
        return found_major > major or (found_major == major and found_minor >= minor)
    return False


def _go_declares_tool(text: str) -> bool:
    """A ``tool <path>`` line, or that path inside a ``tool (`` block."""
    in_block = False
    for raw in _split_lines(text):
        line = raw
        cut = line.find("//")
        if cut >= 0:
            line = line[:cut]
        line = line.strip()
        if line == "":
            continue
        if in_block:
            if line == ")":
                in_block = False
            elif line == GO_TOOL_PATH:
                return True
            continue
        if _GO_TOOL_BLOCK_RE.match(line):
            in_block = True
            continue
        if line == "tool " + GO_TOOL_PATH:
            return True
    return False


# --- the TOML dependency scan ---------------------------------------------


@dataclass
class _TomlFields:
    """Which fields of a TOML document declare a dependency. Deliberately not a TOML
    parser: a field-specific, stateful line scan that tracks the current table,
    triple-quoted string state, and the bracket depth of the one array it is
    inspecting. Only the listed fields are inspected, so a description, a comment, or
    an unrelated table cannot produce a false positive — and a false positive is the
    expensive error here, because it suppresses the only offer the user gets."""

    key_table: Callable[[str], bool]
    array_field: Callable[[str, str], bool]


_POETRY_GROUP_RE = re.compile(r"^tool\.poetry\.group\.[^.]+\.dependencies$")

_PYPROJECT_FIELDS = _TomlFields(
    key_table=lambda t: (
        t == "tool.poetry.dependencies"
        or t == "tool.poetry.dev-dependencies"
        or t == "tool.pdm.dev-dependencies"
        or bool(_POETRY_GROUP_RE.match(t))
    ),
    array_field=lambda t, k: (
        (t == "project" and k == "dependencies")
        or t == "project.optional-dependencies"
        or t == "dependency-groups"
        or (t == "tool.uv" and k == "dev-dependencies")
        or t == "tool.pdm.dev-dependencies"
    ),
)

_PIPFILE_FIELDS = _TomlFields(
    key_table=lambda t: t in ("packages", "dev-packages"),
    array_field=lambda t, k: False,
)

# A requirement whose distribution name is exactly leji: the name, then the end of
# the token or one of the characters that can follow a name in PEP 508 /
# requirements syntax.
_LEJI_REQUIREMENT_RE = re.compile(r"^leji($|[\[=<>~!;,\s])")


def _toml_declares_leji(text: str, fields: _TomlFields) -> bool:
    table = ""
    triple = ""
    depth = 0
    inspecting = False
    for line in _split_lines(text):
        i = 0
        if triple:
            close = line.find(triple)
            if close < 0:
                continue
            i = close + 3
            triple = ""
        elif depth == 0:
            header = _toml_table_header(line)
            if header is not None:
                table = header
                continue
            key = _toml_key_at(line)
            if key is None:
                continue
            name, value_at = key
            if name == PY_DIST and fields.key_table(table):
                return True
            inspecting = fields.array_field(table, name)
            i = value_at
        # One character scan carries the rest: strings (whose contents are the only
        # things that can match), bracket depth (which says whether we are inside the
        # inspected array), comments, and a triple quote that runs past this line.
        while i < len(line):
            char = line[i]
            if char == "#":
                break
            if char in ('"', "'"):
                fence = char * 3
                if line.startswith(fence, i):
                    close = line.find(fence, i + 3)
                    if close < 0:
                        triple = fence
                        break
                    # A triple-quoted string is skipped ENTIRELY, on one line as across
                    # several: the scanner has no TOML parser to tell a multi-line
                    # dependency from prose that merely starts with the name, so the
                    # conservative answer is the only safe one.
                    i = close + 3
                    continue
                content, end = _toml_read_string(line, i, char)
                if depth > 0 and inspecting and _LEJI_REQUIREMENT_RE.match(content):
                    return True
                i = end
                continue
            if char == "[":
                depth += 1
            elif char == "]" and depth > 0:
                depth -= 1
                if depth == 0:
                    inspecting = False
            i += 1
    return False


_TOML_ARRAY_HEADER_RE = re.compile(r"^\s*\[\[\s*([^\]]+?)\s*\]\]\s*(?:#.*)?$")
_TOML_HEADER_RE = re.compile(r"^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$")
_WHITESPACE_RE = re.compile(r"\s+")


def _toml_table_header(line: str) -> Optional[str]:
    """``[table]`` or ``[[array-of-tables]]``, with inner whitespace removed."""
    match = _TOML_ARRAY_HEADER_RE.match(line)
    if match:
        return _WHITESPACE_RE.sub("", match.group(1))
    match = _TOML_HEADER_RE.match(line)
    if match:
        return _WHITESPACE_RE.sub("", match.group(1))
    return None


_TOML_KEY_RE = re.compile(r"""^\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_.-]+))\s*=\s*""")


def _toml_key_at(line: str) -> Optional[tuple[str, int]]:
    """The key a line assigns to, bare or quoted, and where its value starts."""
    match = _TOML_KEY_RE.match(line)
    if not match:
        return None
    name = match.group(1)
    if name is None:
        name = match.group(2)
    if name is None:
        name = match.group(3)
    return (name or "", match.end())


def _toml_read_string(line: str, start: int, quote: str) -> tuple[str, int]:
    """One single-line basic or literal string, from its opening quote. Escapes are
    consumed, not decoded: only a ``leji`` prefix is ever tested against the result."""
    out: list[str] = []
    i = start + 1
    while i < len(line):
        char = line[i]
        if quote == '"' and char == "\\":
            out.append(line[i + 1] if i + 1 < len(line) else "")
            i += 2
            continue
        if char == quote:
            return ("".join(out), i + 1)
        out.append(char)
        i += 1
    return ("".join(out), len(line))


def _toml_has_table(text: str, table: str) -> bool:
    """True when the document opens the given table, or any table under it: TOML
    defines ``tool.poetry`` implicitly when a document writes only
    ``[tool.poetry.dependencies]``, and a manager's table is present either way. The
    dot is what keeps ``[tool.uvicorn]`` from answering for ``tool.uv``."""
    triple = ""
    for line in _split_lines(text):
        if triple:
            if triple in line:
                triple = ""
            continue
        header = _toml_table_header(line)
        if header is not None:
            if header == table or header.startswith(table + "."):
                return True
            continue
        opened = _toml_opens_triple(line)
        if opened:
            triple = opened
    return False


def _toml_opens_triple(line: str) -> str:
    """The triple quote a line leaves open, or ""."""
    i = 0
    open_fence = ""
    while i < len(line):
        char = line[i]
        if char == "#":
            break
        if char in ('"', "'"):
            fence = char * 3
            if line.startswith(fence, i):
                close = line.find(fence, i + 3)
                if close < 0:
                    open_fence = fence
                    break
                i = close + 3
                continue
            _, end = _toml_read_string(line, i, char)
            i = end
            continue
        i += 1
    return open_fence


_REQUIREMENT_LINE_RE = re.compile(r"^leji($|[\s\[=<>~!;,#])")


def _requirements_declare_leji(text: str) -> bool:
    """A ``leji`` requirement line: the name at the start of the line, then
    end-of-line or a character that can follow a name."""
    return any(_REQUIREMENT_LINE_RE.match(line) for line in _split_lines(text))


def _split_lines(text: str) -> list[str]:
    return [line[:-1] if line.endswith("\r") else line for line in text.split("\n")]


# --- the report -----------------------------------------------------------


def detect_ecosystem(root_abs: str) -> EcosystemReport:
    """Detect the dependency ecosystems gated by files directly under ``root_abs``.
    Reads; never writes, never runs anything, never walks up."""
    scan = _RootScan(os.path.abspath(root_abs))
    all_results: list[EcoResult] = []
    # Fixed order, so `all` reads the same in every report and in every SDK.
    if scan.present(NODE_MANIFEST):
        all_results.append(_node_result(scan))
    python_gated = (
        scan.present(PYPROJECT) or scan.present(PIPFILE) or bool(scan.matching(REQUIREMENTS_RE))
    )
    if python_gated:
        all_results.append(_python_result(scan))
    if scan.present(GO_MANIFEST):
        all_results.append(_go_result(scan))

    if not all_results:
        return EcosystemReport(selected=None, all=all_results, reason="none")
    if len(all_results) > 1:
        return EcosystemReport(selected=None, all=all_results, reason="multiple-ecosystems")
    only = all_results[0]
    # A manager-less single ecosystem carries its own reason up: the report's reason
    # is never a second, independently derived verdict.
    if only.status != "ok":
        return EcosystemReport(selected=None, all=all_results, reason=only.status)
    return EcosystemReport(selected=only, all=all_results, reason=None)


def runner_argv(report: EcosystemReport) -> list[str]:
    """The argv a hook or CI job runs leji with: the detected manager's runner when
    the repository actually declares the CLI, else the plain fallback on PATH."""
    selected = report.selected
    if selected is not None and selected.direct_declared and selected.runner:
        return list(selected.runner)
    return list(PLAIN_RUNNER)


def render_ecosystem_block(report: EcosystemReport) -> str:
    """The always-printed human block: what was detected, and what to run to declare
    the Leji CLI. Never a prompt, never a command run — the caller owns both."""
    return "\n".join(_block_lines(report))


def _block_lines(report: EcosystemReport) -> list[str]:
    if report.reason == "none":
        return TEXT_NONE
    if report.reason == "multiple-ecosystems":
        # A print-only ecosystem (pip, pre-1.24 Go) contributes no command here; the
        # lead sentence closes with a period rather than dangling a colon.
        commands: list[str] = []
        for result in report.all:
            commands.extend(_command_lines(result))
        manifests = [_manifest_label(r) for r in report.all]
        return [text_multiple(manifests, bool(commands))] + commands
    only = report.all[0]
    if only.direct_declared and only.manifest is not None:
        return [text_declared(only.manifest)]
    if only.status == "refused-evidence":
        return [text_refused(only.evidence)]
    if only.status == "unreadable-manifest":
        return [text_unreadable(only.manifest or "")]
    if only.status == "unsupported-manager":
        return [text_unsupported(only.manifest or "")]
    if only.status == "ambiguous-manager":
        return [text_ambiguous(only.manifest or "", only.evidence)] + _command_lines(only)
    return _ok_lines(only)


def _ok_lines(result: EcoResult) -> list[str]:
    """The offer for one ecosystem that chose a manager. A manager with no add
    command prints its own guidance instead."""
    if result.manager == "pip":
        if result.manifest == PYPROJECT:
            return text_pip_groups(_decider_file(result))
        return text_pip_requirements(_decider_file(result))
    if result.manager == "go-legacy":
        return text_go_legacy(_decider_file(result))
    return [text_offer(result.manager or "", _decider_file(result))] + _command_lines(result)


def _command_lines(result: EcoResult) -> list[str]:
    """The indented command line(s) for one result: its own add command, or one per
    candidate when the evidence could not choose."""
    if result.add is not None:
        return [consent_command(result.add)]
    return [consent_command(c["add"]) for c in result.candidates if c["add"] is not None]


def _decider_file(result: EcoResult) -> str:
    """The one file a message names as the evidence for the manager: the lockfile
    that selected it, the pyproject that carried its tool table, or the manifest."""
    if result.source == "lockfile":
        for name in result.evidence:
            for lock_file, manager in NODE_LOCKS:
                if lock_file == name and manager == result.manager:
                    return name
            for lock_file, manager, is_lock in PY_LOCKS:
                if lock_file == name and manager == result.manager and is_lock:
                    return name
    if result.source == "tool-table":
        return PYPROJECT
    if result.ecosystem == "python" and result.source == "manifest":
        return PIPFILE
    return result.manifest or ""


def _manifest_label(result: EcoResult) -> str:
    return result.manifest if result.manifest is not None else result.ecosystem


def render_ecosystem_line(report: EcosystemReport) -> str:
    """The one line ``leji detect`` prints about the ecosystem."""
    if report.reason == "none":
        return LINE_NONE
    if report.reason == "multiple-ecosystems":
        return _line_multiple([_manifest_label(r) for r in report.all])
    only = report.all[0]
    if only.status == "refused-evidence":
        return _line_refused(only.evidence)
    if only.status == "unreadable-manifest":
        return _line_unreadable(only.manifest or "")
    if only.status == "unsupported-manager":
        return _line_unsupported(only.manifest or "")
    if only.status == "ambiguous-manager":
        return _line_ambiguous(only.manifest or "", only.evidence)
    return _line_selected(only.manager or "", _decider_file(only), only.direct_declared)
