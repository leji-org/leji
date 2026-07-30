"""Tests for the Task routing reference (mirrors packages/sdk/test/route.test.ts
and the Go layer route tests)."""

from __future__ import annotations

import copy
import json
import re
import shutil
from pathlib import Path

import pytest

from leji import RouteInput, route
from leji.cli import main
from leji.manifest import load_manifest


def _write(root: Path, rel: str, content: str) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")


def _index(entry: str) -> str:
    return f"# Index\n\n```leji-index\n- path: {entry}\n```\n"


def _record(rid: str, fields: str) -> str:
    return f"---\nid: {rid}\ntitle: {rid}\ndate: 2026-06-20\n{fields}---\n\nbody\n"


def _layer(tmp_path: Path) -> tuple[str, dict]:
    root = tmp_path / "layer"
    root.mkdir()
    manifest = {
        "rootPath": "docs/",
        "bootProfilePath": "docs/boot-profile.md",
        "categories": {
            "domain": {"indexes": ["docs/context/domain.md"]},
            "system": {"indexes": ["docs/context/system.md"]},
            "decisions": {"indexes": ["docs/context/decisions.md"]},
        },
        "machine": {
            "agentProfilesPath": "docs/agents/",
            "decisionRecordsPath": "docs/decisions/",
        },
    }
    _write(root, "docs/context/domain.md", _index("docs/domain/"))
    _write(root, "docs/context/system.md", _index("docs/system/"))
    _write(root, "docs/context/decisions.md", _index("docs/decisions/"))
    _write(root, "docs/domain/glossary.md", "---\nid: g\n---\n\nbody")
    _write(root, "docs/system/invariants.md", "---\nid: inv\n---\n\nbody")
    _write(root, "docs/decisions/dec-unscoped.md", _record("dec-unscoped", "status: accepted\n"))
    _write(
        root,
        "docs/decisions/dec-path.md",
        _record("dec-path", "status: accepted\naffectedPaths:\n  - src/payments/\n"),
    )
    _write(
        root,
        "docs/decisions/dec-system.md",
        _record("dec-system", "status: accepted\naffectedCategories:\n  - system\n"),
    )
    _write(
        root,
        "docs/decisions/dec-deprecated.md",
        _record("dec-deprecated", "status: deprecated\naffectedPaths:\n  - docs/system/\n"),
    )
    _write(
        root,
        "docs/decisions/dec-super.md",
        _record(
            "dec-super",
            "status: superseded\nsupersededBy: dec-system\naffectedCategories:\n  - system\n",
        ),
    )
    _write(
        root,
        "docs/decisions/dec-proposed.md",
        _record("dec-proposed", "status: proposed\naffectedCategories:\n  - system\n"),
    )
    return str(root), manifest


def _match_map(decisions) -> dict[str, str]:
    return {d.id: d.matched_by for d in decisions}


def test_file_path_matches_ancestor_scope(tmp_path: Path) -> None:
    root, manifest = _layer(tmp_path)
    r = route(root, manifest, RouteInput(paths=["src/payments/billing.ts"]))
    assert r.path_scoped is True
    assert r.categories == []  # an ungoverned source file selects no category
    assert r.documents == []
    assert _match_map(r.decisions) == {"dec-path": "path", "dec-unscoped": "unscoped"}


def test_governed_doc_signals_category_without_expanding(tmp_path: Path) -> None:
    root, manifest = _layer(tmp_path)
    r = route(root, manifest, RouteInput(paths=["docs/system/invariants.md"]))
    # The path signals `system` for decision and mount matching, but expands nothing:
    # a path scope routes the entries it touches, never the whole category.
    assert r.categories == []
    assert r.category_signals == ["system"]
    assert [d.path for d in r.documents] == ["docs/system/invariants.md"]
    assert _match_map(r.decisions) == {
        "dec-deprecated": "path",
        "dec-system": "category",
        "dec-unscoped": "unscoped",
    }


def test_named_category(tmp_path: Path) -> None:
    root, manifest = _layer(tmp_path)
    r = route(root, manifest, RouteInput(categories=["domain"]))
    assert r.path_scoped is False
    assert r.categories == ["domain"]
    assert [d.path for d in r.documents] == ["docs/domain/glossary.md"]
    assert _match_map(r.decisions) == {"dec-unscoped": "unscoped"}


def test_empty_scope(tmp_path: Path) -> None:
    root, manifest = _layer(tmp_path)
    r = route(root, manifest, RouteInput())
    assert r.path_scoped is False
    assert r.categories == []
    assert r.documents == []
    assert _match_map(r.decisions) == {"dec-unscoped": "unscoped"}


def test_directory_path_bidirectional(tmp_path: Path) -> None:
    root, manifest = _layer(tmp_path)
    r = route(root, manifest, RouteInput(paths=["docs/"]))
    deprecated = next(d for d in r.decisions if d.id == "dec-deprecated")
    assert deprecated.matched_by == "path"


def test_federated_mount_relevance() -> None:
    from leji import load_manifest

    repo_root = Path(__file__).resolve().parents[3]
    core_context = str(repo_root / "examples" / "multi-repo" / "core-context")
    manifest = load_manifest(core_context).manifest
    assert manifest is not None
    # The mount declares categories [domain, decisions].
    domain = route(core_context, manifest, RouteInput(categories=["domain"]))
    assert [m.name for m in domain.mounts] == ["acme-product-context"]
    system = route(core_context, manifest, RouteInput(categories=["system"]))
    assert system.mounts == []


def test_directory_path_selects_entries_beneath_it(tmp_path: Path) -> None:
    root, manifest = _layer(tmp_path)
    r = route(root, manifest, RouteInput(paths=["docs/system/"]))
    # Containment is bidirectional and lexical; a directory is not itself a governed
    # document, so it infers no category at all.
    assert r.categories == []
    assert r.category_signals == []
    assert any(d.path == "docs/system/invariants.md" for d in r.documents)


def test_trailing_slash_changes_nothing(tmp_path: Path) -> None:
    root, manifest = _layer(tmp_path)
    a = route(root, manifest, RouteInput(paths=["docs/system"]))
    b = route(root, manifest, RouteInput(paths=["docs/system/"]))
    assert a == b


# --- topics (mirrors the route.test.ts topic block) -------------------------

_CORE_CONTEXT = Path(__file__).resolve().parents[3] / "examples" / "multi-repo" / "core-context"


def _mount_layer(tmp_path: Path, topics: list[str], name: str = "topics") -> tuple[str, dict]:
    """A copy of the federated host example whose one mount declares ``topics``, so
    topic matching runs against controlled values. That mount declares categories
    [domain, decisions]."""
    dest = tmp_path / name
    shutil.copytree(_CORE_CONTEXT, dest)
    p = dest / "leji.json"
    m = json.loads(p.read_text(encoding="utf-8"))
    m["federation"]["mounts"][0]["topics"] = topics
    p.write_text(json.dumps(m, indent=2) + "\n", encoding="utf-8")
    manifest = load_manifest(str(dest)).manifest
    assert manifest is not None
    return str(dest), manifest


def _mount_names(r) -> list[str]:
    return [m.name for m in r.mounts]


def test_a_named_topic_selects_the_mount_declaring_it_and_nothing_else(tmp_path: Path) -> None:
    root, manifest = _mount_layer(tmp_path, ["billing", "product surface"])
    topical = route(root, manifest, RouteInput(topics=["billing"]))
    assert _mount_names(topical) == ["acme-product-context"]
    # Topics-only is a real scope, not an empty one: it routes mounts plus the
    # org-wide unscoped decisions, and reports that no path scope was evaluated.
    assert topical.path_scoped is False
    # Mount-only: the topic enters neither category set and loads nothing.
    assert topical.categories == []
    assert topical.category_signals == []
    assert topical.documents == []
    assert topical.records == []
    assert topical.decisions == route(root, manifest, RouteInput()).decisions
    # A topic no mount declares selects nothing.
    assert route(root, manifest, RouteInput(topics=["shipping"])).mounts == []


def test_a_category_match_and_a_topic_match_select_the_mount_once(tmp_path: Path) -> None:
    root, manifest = _mount_layer(tmp_path, ["billing"])
    by_category = route(root, manifest, RouteInput(categories=["domain"]))
    assert _mount_names(by_category) == ["acme-product-context"]
    by_both = route(root, manifest, RouteInput(categories=["domain"], topics=["billing"]))
    assert by_both.mounts == by_category.mounts


def test_duplicate_topics_are_one_signal(tmp_path: Path) -> None:
    root, manifest = _mount_layer(tmp_path, ["billing"])
    assert route(root, manifest, RouteInput(topics=["billing", "billing"])) == route(
        root, manifest, RouteInput(topics=["billing"])
    )


def test_topic_matching_is_exact_never_folded_or_normalized(tmp_path: Path) -> None:
    composed = "caf\u00e9"  # e-acute as one scalar value
    decomposed = "cafe\u0301"  # e + combining acute: equivalent, different bytes
    root, manifest = _mount_layer(tmp_path, ["billing", composed])
    assert route(root, manifest, RouteInput(topics=["Billing"])).mounts == []
    assert route(root, manifest, RouteInput(topics=[decomposed])).mounts == []
    # The byte-identical non-ASCII spelling does match.
    assert _mount_names(route(root, manifest, RouteInput(topics=[composed]))) == [
        "acme-product-context"
    ]


def test_a_topic_that_spells_a_category_id_selects_by_topic_only(tmp_path: Path) -> None:
    root, manifest = _mount_layer(tmp_path, ["domain"])
    by_topic = route(root, manifest, RouteInput(topics=["domain"]))
    assert _mount_names(by_topic) == ["acme-product-context"]
    # Naming the category expands it; naming the same string as a topic does not.
    assert route(root, manifest, RouteInput(categories=["domain"])).documents
    assert by_topic.categories == []
    assert by_topic.category_signals == []
    assert by_topic.documents == []
    assert by_topic.records == []


def test_an_invalid_caller_topic_is_an_input_error(tmp_path: Path) -> None:
    root, manifest = _mount_layer(tmp_path, ["billing"])
    for topics, message in (
        ([""], "invalid task topic: empty string"),
        (["billing", ""], "invalid task topic: empty string"),
        (["\ud800"], "invalid task topic: lone surrogate"),
        # A non-string reaches the library only by a caller's own mistake, but
        # silently dropping it would return a plausible empty match.
        ([7], "invalid task topic: not a string"),
    ):
        with pytest.raises(ValueError, match=re.escape(message)):
            route(root, manifest, RouteInput(topics=topics))
    # A matched surrogate pair is one scalar value and stays valid.
    assert route(root, manifest, RouteInput(topics=["🚀"])).mounts == []


def test_an_invalid_declared_mount_topic_is_an_input_error_naming_the_mount(
    tmp_path: Path,
) -> None:
    root, manifest = _mount_layer(tmp_path, ["billing"])
    # load_manifest refuses both shapes on disk (schema minLength, and the manifest
    # scalar gate), so this guard covers the caller that holds a manifest object
    # directly instead of reading one through load_manifest.
    for declared, message in (
        (["billing", ""], 'invalid mount topic on "acme-product-context": empty string'),
        (["\ud800"], 'invalid mount topic on "acme-product-context": lone surrogate'),
    ):
        hostile = copy.deepcopy(manifest)
        hostile["federation"]["mounts"][0]["topics"] = declared
        with pytest.raises(ValueError, match=re.escape(message)):
            route(root, hostile, RouteInput(topics=["billing"]))


def test_the_cli_topics_flag_is_repeatable_and_whole_value(tmp_path: Path, capsys) -> None:
    root, _manifest = _mount_layer(tmp_path, ["product, surface", "billing"])
    # Occurrences accumulate, and a value carrying a comma and spaces survives whole.
    assert (
        main(
            [
                "route",
                "--topics",
                "shipping",
                "--topics",
                "product, surface",
                "--json",
                "--root",
                root,
            ]
        )
        == 0
    )
    payload = json.loads(capsys.readouterr().out)
    assert [m["name"] for m in payload["mounts"]] == ["acme-product-context"]
    # Exact duplicates count once.
    assert (
        main(["route", "--topics", "billing", "--topics", "billing", "--json", "--root", root]) == 0
    )
    assert len(json.loads(capsys.readouterr().out)["mounts"]) == 1
    # An empty occurrence is an error, never a silent non-match.
    assert main(["route", "--topics", "", "--root", root]) == 2
    assert "non-empty topic" in capsys.readouterr().err
    # So is a string that is not Unicode scalar values (an unpaired surrogate).
    assert main(["route", "--topics", "\ud800", "--root", root]) == 2
    assert "invalid topic" in capsys.readouterr().err


def test_a_non_matching_topic_changes_no_byte_of_the_json_output(tmp_path: Path, capsys) -> None:
    root, _manifest = _mount_layer(tmp_path, ["billing"])
    as_of = ["--as-of", "2026-06-27"]
    assert main(["route", "--categories", "domain", *as_of, "--json", "--root", root]) == 0
    base = capsys.readouterr().out
    assert (
        main(
            [
                "route",
                "--categories",
                "domain",
                "--topics",
                "shipping",
                *as_of,
                "--json",
                "--root",
                root,
            ]
        )
        == 0
    )
    assert capsys.readouterr().out == base
    payload = json.loads(base)
    assert list(payload.keys()) == [
        "command",
        "ok",
        "asOf",
        "pathScoped",
        "categories",
        "categorySignals",
        "documents",
        "records",
        "decisions",
        "mounts",
    ]
    assert list(payload["mounts"][0].keys()) == ["name", "pin"]


def test_task_paths_normalize_before_matching(tmp_path: Path) -> None:
    root, manifest = _layer(tmp_path)
    governed = "docs/system/invariants.md"
    canonical = route(root, manifest, RouteInput(paths=[governed]))
    # Every spelling Requirement 6 normalizes away has to route identically. The gap
    # this closes: ``--federation=required`` passed open on ``./x`` and ``x/``
    # because neither is a key in the governed-document map, so neither signalled its
    # category and neither routed the mounts the task actually touches.
    for spelling in [
        f"./{governed}",
        f"{governed}/",
        "docs/./system//invariants.md",
        "docs/x/../system/invariants.md",
    ]:
        r = route(root, manifest, RouteInput(paths=[spelling]))
        assert r.category_signals == canonical.category_signals, spelling
        assert [d.path for d in r.documents] == [d.path for d in canonical.documents], spelling
        assert _match_map(r.decisions) == _match_map(canonical.decisions), spelling
    # The repository root is a real scope, not an empty one: it contains everything.
    for root_spelling in [".", "./", "docs/.."]:
        assert route(root, manifest, RouteInput(paths=[root_spelling])).path_scoped, root_spelling


def test_a_task_path_with_no_root_relative_form_is_an_input_error(tmp_path: Path) -> None:
    root, manifest = _layer(tmp_path)
    # Never a silent non-match: a federation gate reading "you spelled it wrongly" as
    # "this task touches no mount" is the hole this closes.
    for bad in ["/etc/passwd", "../outside.md", "docs/../../outside.md"]:
        with pytest.raises(ValueError) as excinfo:
            route(root, manifest, RouteInput(paths=[bad]))
        assert str(excinfo.value) == (
            f'invalid task path "{bad}": must be repository-root-relative POSIX '
            '(no leading "/", no ".." above the root)'
        )
