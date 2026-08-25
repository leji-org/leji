"""The declared exception to the ROLE rule, pinned the way the write allow-list is
pinned: the role rule allows exactly one target that belongs to no role (the
self-managed ``.leji/.gitignore``), and exactly one symbol may say so, by putting the
``metadata_file`` field on a :class:`~leji.layout.TargetVerdict`.
``docs/practice/trust-boundary.md`` mirrors this list. The write allow-list
(``test_source_audit.py``) says which symbols may touch the filesystem raw; this one
says which may declare a target writable that the role rule refuses, and it exists for
the same reason: an exception nobody can find is an exception nobody is checking.

Mirrors packages/sdk/test/source-audit.test.ts (the role-exception pin) and
packages/sdk-go/internal/sourceaudit/role_test.go.
"""

from __future__ import annotations

import ast
import json
from dataclasses import dataclass
from pathlib import Path

import pytest

from leji.layout import TargetVerdict

SRC_DIR = Path(__file__).resolve().parents[1] / "src" / "leji"

#: The exception list, by ``file#symbol``: the one place a ``metadata_file`` verdict may
#: be constructed. The symbol is the dotted name of the enclosing function (a lambda is
#: transparent, belonging to the function that owns it).
ALLOWED_ROLE_EXCEPTIONS: dict[str, str] = {
    "fsx.py#_metadata_file_verdict": (
        "the self-managed .leji/.gitignore: judged on the requested entry, with a real "
        ".leji directory and a non-symlink entry, refused otherwise"
    ),
}

#: The attribute that carries the exception.
ROLE_EXCEPTION_ATTRIBUTE = "metadata_file"

#: The verdict type the attribute lives on. A POSITIONAL construction sets the field
#: without spelling its name, so it is a constructor site whatever the arguments look
#: like, and the only way to tell one from a keyword construction is the presence of a
#: positional argument. :class:`~leji.layout.TargetVerdict` is declared ``kw_only``, so
#: such a call also fails at run time; this flags it at review time.
ROLE_VERDICT_TYPE = "TargetVerdict"

#: The calls that put an attribute on a value from a NAME given as an argument rather
#: than from a keyword written at the call: the shapes nothing else in this scan would
#: see. ``setattr`` and ``object.__setattr__`` belong to no other API this repository
#: uses, so the member name alone counts and an aliased binding is caught with it.
REFLECTIVE_SETTERS = frozenset({"setattr", "__setattr__"})


@dataclass(frozen=True)
class Hit:
    key: str
    line: int
    name: str


def _constant_string(node: ast.expr | None) -> str | None:
    """The string a node IS, when it is written as a literal; None for anything else.
    A name assembled at runtime is the residual stated below, not something to guess."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _json_spells_attribute(text: str) -> bool:
    """True when a string is a JSON DOCUMENT carrying the attribute as a key, at any
    depth. The text is parsed rather than substring-matched, deliberately: a literal that
    merely NAMES the attribute (an error message, a docstring, this audit's own constant)
    creates nothing and must not be flagged, while ``'{"metadata_file": true}'`` handed
    to a decoder creates exactly the thing this pin is about."""
    try:
        parsed = json.loads(text)
    except ValueError:
        return False

    def walk(value: object) -> bool:
        if isinstance(value, dict):
            return ROLE_EXCEPTION_ATTRIBUTE in value or any(walk(v) for v in value.values())
        if isinstance(value, list):
            return any(walk(v) for v in value)
        return False

    return walk(parsed)


class _RoleAnalyzer(ast.NodeVisitor):
    """Every CONSTRUCTION of the metadata-file verdict in one module, keyed
    ``file#symbol``.

    An attribute can be put on a value in a bounded number of statically named ways, and
    all of them count: passed as a KEYWORD at a constructor or a ``replace``; assigned
    onto a value afterwards by attribute; assigned into a mapping (``__dict__``,
    ``vars()``, or an ordinary dict) under a literal key; written into a dict literal
    such a mapping is updated from; handed to ``setattr`` or ``object.__setattr__`` as an
    attribute NAME; or carried as a key inside a JSON document literal a decoder is given.

    And one way that spells no name at all: a POSITIONAL ``TargetVerdict(True, …)``,
    which sets fields by ORDER. A name-based reader cannot see it, so it is recognized by
    the callee and the presence of a positional argument instead, and every such call is
    a constructor site whatever its arity: the sixth position is the exception, and an
    audit that counted arguments would be one field rename away from being wrong.
    ``TargetVerdict`` is also declared ``kw_only``, so the call fails at run time as well;
    the two together are why positional construction is no longer a residual class.

    The NAME is what decides for the keyword forms, never the value's type: a verdict
    built on a duck-typed stand-in, or on a shape no annotation relates to
    ``TargetVerdict``, must fail this audit rather than slip through it. Reflective forms
    work where a direct assignment would not (a frozen dataclass, ``__slots__``), which is
    exactly why they are audited here rather than left to the type checker.

    READING the attribute is not constructing it, so a plain ``verdict.metadata_file``
    test is deliberately not a hit; only positions that create it are. The dataclass
    FIELD DECLARATION in ``layout.py`` is not a hit either: declaring the field is what
    the exception is about, not a second exception.

    THE RESIDUAL, stated exactly. One class remains outside, and only one: an attribute
    name ASSEMBLED AT RUNTIME, so that no single string can be read for it statically: a
    concatenation (``"metadata_" + "file"``), an f-string, a variable this reader cannot
    narrow to one literal, a value read from data. Every such site is invisible to any
    static audit, this one included; its closure is human, through
    ``docs/practice/trust-boundary.md`` and the diff review. Positional construction was
    once in this list and is not any more: it is prevented by ``kw_only`` and flagged
    here."""

    def __init__(self, rel: str) -> None:
        self.rel = rel
        self.hits: list[Hit] = []
        self.scope: list[str] = []
        self._seen: set[tuple[int, int]] = set()

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

    def _record(self, node: ast.AST, name: str) -> None:
        where = (getattr(node, "lineno", 0), getattr(node, "col_offset", 0))
        if where in self._seen:
            return
        self._seen.add(where)
        key = f"{self.rel}#{'.'.join(self.scope) or '(top level)'}"
        self.hits.append(Hit(key=key, line=where[0], name=name))

    # -- constructions ---------------------------------------------------------

    def visit_Assign(self, node: ast.Assign) -> None:
        self._judge_targets(node, node.targets)
        self.generic_visit(node)

    def visit_AugAssign(self, node: ast.AugAssign) -> None:
        self._judge_targets(node, [node.target])
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        # `metadata_file: bool = False` inside the dataclass DECLARES the field; only an
        # attribute or subscript target constructs it on a value.
        self._judge_targets(node, [node.target])
        self.generic_visit(node)

    def _judge_targets(self, node: ast.AST, targets: list[ast.expr]) -> None:
        for target in targets:
            if isinstance(target, ast.Attribute) and target.attr == ROLE_EXCEPTION_ATTRIBUTE:
                self._record(node, "attribute assignment")
            if (
                isinstance(target, ast.Subscript)
                and _constant_string(target.slice) == ROLE_EXCEPTION_ATTRIBUTE
            ):
                self._record(node, "subscript assignment")

    def visit_Dict(self, node: ast.Dict) -> None:
        for key in node.keys:
            if _constant_string(key) == ROLE_EXCEPTION_ATTRIBUTE:
                self._record(node, "dict literal")
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        for keyword in node.keywords:
            if keyword.arg == ROLE_EXCEPTION_ATTRIBUTE:
                self._record(node, "keyword argument")
        member = (
            node.func.attr
            if isinstance(node.func, ast.Attribute)
            else node.func.id
            if isinstance(node.func, ast.Name)
            else None
        )
        # Positional construction, which spells no field name at all: whatever the arity,
        # the fields are set by ORDER and one of those positions is the exception.
        if member == ROLE_VERDICT_TYPE and node.args:
            self._record(node, "positional construction")
        if member in REFLECTIVE_SETTERS and len(node.args) >= 2:
            if _constant_string(node.args[1]) == ROLE_EXCEPTION_ATTRIBUTE:
                self._record(node, f"{member}()")
        self.generic_visit(node)

    def visit_Constant(self, node: ast.Constant) -> None:
        if isinstance(node.value, str) and _json_spells_attribute(node.value):
            self._record(node, "JSON document")
        self.generic_visit(node)


def _analyze_role(rel: str, source: str) -> list[Hit]:
    analyzer = _RoleAnalyzer(rel)
    analyzer.visit(ast.parse(source))
    return analyzer.hits


def _role_audit_tree() -> list[Hit]:
    """Every production source file of this SDK (there are no tests under ``src/``)."""
    files = sorted(SRC_DIR.rglob("*.py"))
    assert files, "the role audit loaded no source files"
    hits: list[Hit] = []
    for path in files:
        hits.extend(_analyze_role(path.relative_to(SRC_DIR).as_posix(), path.read_text("utf-8")))
    return hits


def _unexpected(hits: list[Hit], allowed: dict[str, str]) -> list[str]:
    return [f"{h.key} ({h.name}) at line {h.line}" for h in hits if h.key not in allowed]


def _stale(hits: list[Hit], allowed: dict[str, str]) -> list[str]:
    matched = {h.key for h in hits}
    return [key for key in allowed if key not in matched]


def test_the_role_rule_has_exactly_one_declared_exception_at_one_named_site() -> None:
    hits = _role_audit_tree()
    outside = _unexpected(hits, ALLOWED_ROLE_EXCEPTIONS)
    assert outside == [], (
        f"a metadata-file verdict is constructed outside the declared exception: {outside}\n"
        "The role rule allows one target that belongs to no role; argue any other into the "
        "list, or route the write through its own role."
    )
    dead = _stale(hits, ALLOWED_ROLE_EXCEPTIONS)
    assert dead == [], f"role-exception entries matching no symbol (delete them): {dead}"
    assert len(hits) == len(ALLOWED_ROLE_EXCEPTIONS), (
        f"one construction, not several at one site: {[(h.key, h.line, h.name) for h in hits]}"
    )


# --- the role-exception laundering corpus, permanent -------------------------------

# Each probe is another way of putting `metadata_file` on a verdict, and each must be
# flagged: the promise the single-constructor pin makes is that a SECOND exception cannot
# be added quietly, so every spelling a second one could take is asserted here rather than
# assumed. The negatives at the end are the controls: a longer, unrelated attribute name,
# an ordinary READ of the attribute, prose that merely names it, and the dataclass field
# declaration itself, none of which is a second construction.

ROLE_PROBES: list[tuple[str, str, bool]] = [
    (
        "keyword argument",
        "def launder():\n    return TargetVerdict(ok=True, metadata_file=True)\n",
        True,
    ),
    (
        # The review's own probe: the field set by ORDER, its name spelled nowhere.
        "positional construction",
        "def launder():\n    return TargetVerdict(True, '', False, False, False, True)\n",
        True,
    ),
    (
        "positional construction through a qualified name",
        "from leji import layout\ndef launder():\n"
        "    return layout.TargetVerdict(True, '', False, False, False, True)\n",
        True,
    ),
    (
        "positional construction splatted from a sequence",
        "def launder(values):\n    return TargetVerdict(*values)\n",
        True,
    ),
    (
        "keyword argument through dataclasses.replace",
        "import dataclasses\ndef launder(v):\n"
        "    return dataclasses.replace(v, metadata_file=True)\n",
        True,
    ),
    (
        "attribute assignment",
        "def launder(v):\n    v.metadata_file = True\n    return v\n",
        True,
    ),
    (
        "attribute assignment inside a lambda's owner",
        "def launder(v):\n    apply = lambda: setattr(v, 'metadata_file', True)\n"
        "    apply()\n    return v\n",
        True,
    ),
    (
        "setattr with a literal name",
        "def launder(v):\n    setattr(v, 'metadata_file', True)\n    return v\n",
        True,
    ),
    (
        "object.__setattr__ on a frozen value",
        "def launder(v):\n    object.__setattr__(v, 'metadata_file', True)\n    return v\n",
        True,
    ),
    (
        "__dict__ subscript",
        "def launder(v):\n    v.__dict__['metadata_file'] = True\n    return v\n",
        True,
    ),
    (
        "vars() update from a dict literal",
        "def launder(v):\n    vars(v).update({'metadata_file': True})\n    return v\n",
        True,
    ),
    (
        "dict literal a constructor is splatted from",
        "def launder():\n    fields = {'ok': True, 'metadata_file': True}\n"
        "    return TargetVerdict(**fields)\n",
        True,
    ),
    (
        "JSON document literal",
        'import json\ndef launder():\n    return json.loads(\'{"ok": true, "metadata_file": true}\')\n',
        True,
    ),
    (
        "negative: a longer, unrelated attribute",
        "def other(v):\n    v.metadata_file_name = 'x'\n"
        "    setattr(v, 'metadata_file_name', 'y')\n    return v\n",
        False,
    ),
    (
        "negative: reading the attribute",
        "def read(v):\n    return v.metadata_file is True and v.ok\n",
        False,
    ),
    (
        "negative: prose that merely names the attribute",
        "MESSAGE = 'metadata_file is the one exception the role rule allows'\n",
        False,
    ),
    (
        "negative: the dataclass field declaration itself",
        "from dataclasses import dataclass\n@dataclass\nclass Verdict:\n"
        "    ok: bool = False\n    metadata_file: bool = False\n",
        False,
    ),
    (
        # The control for the positional rule: an ordinary keyword construction that does
        # not name the exception is not a constructor site, or every verdict in the SDK
        # would be one.
        "negative: keyword construction that does not name the exception",
        "def ordinary():\n    return TargetVerdict(ok=True, role='viewer')\n",
        False,
    ),
]


def test_the_role_exception_pin_sees_through_every_spelling_a_second_exception_could_take() -> None:
    for name, source, expected in ROLE_PROBES:
        hits = _analyze_role("__probe.py", source)
        assert bool(hits) == expected, (
            f"probe {name!r}: expected {'a hit' if expected else 'no hit'}, "
            f"got {[(h.name, h.line) for h in hits]}"
        )


def test_the_verdict_cannot_be_constructed_positionally_at_all() -> None:
    """The language half of the same pin: positional construction is not merely audited,
    it does not run. Without ``kw_only`` on the dataclass this call succeeds and sets
    ``metadata_file`` without ever spelling it, which is exactly the bypass the audit
    above cannot see by name."""
    with pytest.raises(TypeError):
        TargetVerdict(True, "", False, False, False, True)  # type: ignore[misc]
    # The keyword form is unaffected, so the constraint costs the SDK nothing.
    assert TargetVerdict(ok=True, metadata_file=True).metadata_file is True
