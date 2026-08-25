"""The structural half of the snapshot contract: the badge and canary suites hold one
tree-snapshot helper between them, and a private walker must not be able to grow back
beside it. A walker needs a directory-enumeration primitive, so this audit counts every
reference to one in those two files and compares the counts against the named exceptions
below. The claim is bounded and mechanical: it prevents a walker built on the primitives
below, whatever it is named and whether it is a function, a method or a lambda. It claims
nothing about a walker built on anything else; that wider closure is review of the
imports and call sites, not this scan.

Mirrors packages/sdk/test/snapshot-audit.test.ts, whose shape this keeps: names, an
exception table carrying a COUNT and a reason per context, and a scan over the parsed
source, so a primitive named in a comment is not a hit (comments are not in the tree),
a name inside a longer docstring is not a hit (the whole string has to be the name), and
a name reached through a string is (`monkeypatch.setattr(os, "scandir", ...)`): the name
has to be spelled somewhere for the primitive to be reached, as an identifier or as a
string.
"""

from __future__ import annotations

import ast
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent

# The names this audit is bounded to, Python's directory-enumeration calls:
# `os.walk`, `os.scandir`, `os.listdir`, `Path.iterdir`, `Path.rglob` and `Path.glob`. A
# walker built on any of them has to spell one, whatever it calls itself. A walker built
# on something else (`glob.iglob`, `fnmatch` over a shelled-out `find`, a dependency)
# spells none of them and is outside the mechanical guarantee: that one is left to
# review of the imports and call sites.
PRIMITIVES = frozenset({"walk", "scandir", "listdir", "iterdir", "rglob", "glob"})

# The shared helper, as the two files must import and call it.
HELPER_MODULE = "helpers.snapshot"
HELPER_NAME = "snapshot_tree"

FILES = ("test_badge.py", "test_canary.py")

# The exceptions, by `file#context` with the number of references each context is
# allowed. A count rather than a bare name, so a new reference fails even inside a
# context that already holds one; a context that no longer matches fails too, because a
# stale exception is an exception nobody is checking. `context` is the nearest named
# function, or `(top level)` for module scope, which a comprehension keeps, since a
# comprehension is a scope but not a function anyone can name.
ALLOWED: dict[str, tuple[int, str]] = {
    "test_badge.py#test_an_out_whose_parent_resolves_outside_the_repository_is_refused_and_reads_nothing": (
        1,
        "lists an out-of-repository directory to prove nothing was created there; "
        "one level, no walk",
    ),
    "test_badge.py#test_an_out_whose_parent_resolves_into_leji_is_refused_at_any_depth": (
        1,
        "asserts the private role is still empty; one level, no walk",
    ),
    "test_badge.py#(top level)": (
        1,
        "enumerates the fixture directory to generate one test per fixture carrying a badge block",
    ),
    "test_canary.py#_copy_seed": (
        1,
        "the seed materializer: copies a committed seed into its declared target",
    ),
    "test_canary.py#_files_under": (
        1,
        "the export listing: files only, a different contract from the snapshot",
    ),
    "test_canary.py#_count_token": (
        1,
        "the canary token scan: reads bytes, records no tree",
    ),
    "test_canary.py#test_check_before_act_out_of_repository_viewer_or_dist_alias_is_refused": (
        2,
        "asserts two out-of-tree destinations are empty; one level each, no walk",
    ),
    "test_canary.py#test_check_before_act_ancestor_swapped_after_enumeration_is_never_followed": (
        2,
        "the interception spy: captures and replaces the builtin to swap a tree mid-walk",
    ),
}


def _parse(name: str) -> ast.Module:
    return ast.parse((TESTS_DIR / name).read_text(encoding="utf-8"), filename=name)


def _parents(tree: ast.Module) -> dict[ast.AST, ast.AST]:
    """Every node's parent, since an ast node carries no link upward."""
    links: dict[ast.AST, ast.AST] = {}
    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            links[child] = parent
    return links


def _context(node: ast.AST, links: dict[ast.AST, ast.AST]) -> str:
    """The nearest named function containing `node`, or the name a lambda is bound to:
    what a reviewer would cite when arguing the exception."""
    current = links.get(node)
    while current is not None:
        if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return current.name
        if isinstance(current, ast.Lambda):
            parent = links.get(current)
            if isinstance(parent, ast.Assign):
                for target in parent.targets:
                    if isinstance(target, ast.Name):
                        return target.id
        current = links.get(current)
    return "(top level)"


def _spellings(node: ast.AST) -> list[str]:
    """How a node spells a name: an identifier in any of the places an identifier can
    stand, or a string literal whose whole value is the name."""
    if isinstance(node, ast.Name):
        return [node.id]
    if isinstance(node, ast.Attribute):
        return [node.attr]
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return [node.name]
    if isinstance(node, ast.arg):
        return [node.arg]
    if isinstance(node, ast.keyword):
        return [node.arg] if node.arg is not None else []
    if isinstance(node, ast.alias):
        return [node.name] + ([node.asname] if node.asname is not None else [])
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    return []


def _references(name: str) -> tuple[dict[str, int], list[str]]:
    """Every reference to an enumeration primitive in one file, as `file#context` keys
    with their counts, plus the line of each for the failure message."""
    tree = _parse(name)
    links = _parents(tree)
    counts: dict[str, int] = {}
    where: list[str] = []
    for node in ast.walk(tree):
        for spelled in _spellings(node):
            if spelled not in PRIMITIVES:
                continue
            key = f"{name}#{_context(node, links)}"
            counts[key] = counts.get(key, 0) + 1
            where.append(f"{name}:{getattr(node, 'lineno', 0)} {key}")
    return counts, where


def test_no_private_tree_walker_in_the_badge_and_canary_suites() -> None:
    counts: dict[str, int] = {}
    where: list[str] = []
    for name in FILES:
        found, found_where = _references(name)
        counts.update(found)
        where.extend(found_where)

    actual = dict(sorted(counts.items()))
    expected = dict(sorted((key, entry[0]) for key, entry in ALLOWED.items()))
    assert actual == expected, (
        "a directory-enumeration primitive appeared where no exception allows it, or an "
        "exception no longer matches. Every reference found:\n" + "\n".join(sorted(where))
    )


def test_the_badge_and_canary_suites_take_their_snapshots_from_the_shared_helper() -> None:
    for name in FILES:
        tree = _parse(name)
        imported = any(
            isinstance(node, ast.ImportFrom)
            and node.module == HELPER_MODULE
            and any(alias.name == HELPER_NAME and alias.asname is None for alias in node.names)
            for node in ast.walk(tree)
        )
        assert imported, f"{name} imports {HELPER_NAME} from {HELPER_MODULE}"

        calls = sum(
            1
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == HELPER_NAME
        )
        assert calls > 0, f"{name} calls {HELPER_NAME}"
