"""The projection closure and the status projection section.

Mirrors the closure block of packages/sdk/test/mounts.test.ts. A layer projects as
its manifest declares it, not as its directory layout happens to look: relocated
machine artifacts, governed content outside rootPath and bound profiles outside the
profiles tree all travel. An absent optional selection contributes nothing; an
absent referenced file fails the closure with a stable code naming the artifact that
declared it, and every failure carries the class it was tagged with at its own site.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Union

from leji.cli import main
from leji.manifest import load_manifest
from leji.mounts import cache_key_for, hydrate_mounts, normalize_source, self_projection
from leji.validate import validate_layer

from test_mounts import SIBLING_EXAMPLE, git, mounted_pair

REPO_ROOT = Path(__file__).resolve().parents[3]
ACME_SOURCE = "https://github.com/acme/product-context"
ACME_IDENTITY = normalize_source(ACME_SOURCE)
assert ACME_IDENTITY is not None

# A filename with no decoding: 0xFF is not a legal UTF-8 lead byte.
BAD_PATH_BYTES = b"\xff.md"


def custom_sibling(
    tmp_path: Path, manifest: Union[dict, str], files: dict[str, str]
) -> tuple[str, Path, str]:
    """A sibling built from an explicit manifest and file set, plus the
    ``mounted_pair`` host re-pinned and re-hinted at it. Every closure fixture
    differs only in those two, so the wiring is written once. A string manifest is
    written verbatim, for the fixtures whose point is bytes an object cannot
    express."""
    host, _sibling, _pin = mounted_pair(tmp_path)
    sibling = tmp_path / "custom-sibling"
    sibling.mkdir(parents=True, exist_ok=True)
    (sibling / "leji.json").write_text(
        manifest if isinstance(manifest, str) else json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    for rel, body in files.items():
        abs_path = sibling / Path(*rel.split("/"))
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        abs_path.write_text(body, encoding="utf-8")
    git(sibling, "init", "-q", "-b", "main")
    git(sibling, "add", "-A")
    git(
        sibling, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "seed"
    )
    pin = git(sibling, "rev-parse", "HEAD")
    repin(host, pin)
    (Path(host) / ".leji" / "mounts.local.json").write_text(
        json.dumps({"mounts": {"acme-product-context": {"repo": "../custom-sibling"}}}) + "\n",
        encoding="utf-8",
    )
    return host, sibling, pin


def repin(host: str, pin: str) -> None:
    mp = Path(host) / "leji.json"
    m = json.loads(mp.read_text(encoding="utf-8"))
    m["federation"]["mounts"][0]["pin"] = pin
    mp.write_text(json.dumps(m, indent=2) + "\n", encoding="utf-8")


def sibling_manifest(**extra) -> dict:
    """A sibling manifest that validates against the canonical schema: the fixture's
    own declarations laid over the fields every manifest must carry. The closure
    schema-checks the pinned manifest, so a fixture about (say) relocated machine
    artifacts still has to be a real manifest, not the two fields it happens to
    read."""
    return {
        "leji": "1.0",
        "name": "acme-product-context",
        "owners": {"primary": {"name": "Sibling Owner"}},
        "categories": {"domain": {"indexes": ["docs/index/domain.md"]}},
        **extra,
    }


# The one file ``sibling_manifest``'s category index makes closure-critical. Inside
# ``docs/``, so a fixture asserting the projected top level is unchanged by it.
SIBLING_INDEX_FILES = {"docs/index/domain.md": "# Domain index\n"}


def stored_index(governed_paths: list[str]) -> str:
    """A pinned context index as its schema requires one. A closure fixture cares
    only about which governed paths the index names; the required id/title/category
    on each entry, and the header the schema requires, are filled in here."""
    return (
        json.dumps(
            {
                "schemaVersion": "1.0",
                "generatedAt": "2026-01-01T00:00:00Z",
                "rootPath": "docs/",
                "entries": [
                    {
                        "id": f"fixture-entry-{i}",
                        "path": p,
                        "title": "Fixture",
                        "category": "domain",
                    }
                    for i, p in enumerate(governed_paths)
                ],
            },
            indent=2,
        )
        + "\n"
    )


def stored_changelog() -> str:
    """A pinned context changelog as its schema requires one (at least one entry)."""
    return (
        json.dumps(
            {
                "schemaVersion": "1.0",
                "entries": [
                    {
                        "id": "fixture-seed",
                        "date": "2026-01-01",
                        "type": "added",
                        "summary": "Fixture",
                        "paths": ["docs/"],
                    }
                ],
            },
            indent=2,
        )
        + "\n"
    )


def hydrate_one(host: str, pin: str) -> tuple[dict, Path]:
    """Hydrate the host's single declared mount: its outcome, and where it lands."""
    manifest = load_manifest(host).manifest
    assert manifest is not None
    outcome = hydrate_mounts(host, manifest).outcomes[0]
    projection = (
        Path(host) / ".leji" / "mounts" / "cache" / cache_key_for(ACME_IDENTITY, pin) / "projection"
    )
    return outcome, projection


def hydrate_json(host: str, capsys) -> tuple[int, dict]:
    code = main(["mounts", "hydrate", "--json", "--root", host])
    return code, json.loads(capsys.readouterr().out)


def test_relocated_machine_artifacts_are_projected_from_their_declared_paths(tmp_path) -> None:
    host, _sibling, pin = custom_sibling(
        tmp_path,
        sibling_manifest(
            rootPath="docs/",
            bootProfilePath="docs/boot-profile.md",
            machine={
                "indexPath": "meta/context-index.json",
                "changelogPath": "meta/context-changelog.json",
            },
        ),
        {
            **SIBLING_INDEX_FILES,
            "docs/boot-profile.md": "# Boot\n",
            "meta/context-index.json": stored_index([]),
            "meta/context-changelog.json": stored_changelog(),
        },
    )
    outcome, projection = hydrate_one(host, pin)
    assert outcome["status"] == "hydrated"
    assert sorted(p.name for p in (projection / "meta").iterdir()) == [
        "context-changelog.json",
        "context-index.json",
    ]


def test_governed_content_outside_root_path_is_projected(tmp_path) -> None:
    host, _sibling, pin = custom_sibling(
        tmp_path,
        sibling_manifest(rootPath="docs/", bootProfilePath="docs/boot-profile.md"),
        {
            **SIBLING_INDEX_FILES,
            "docs/boot-profile.md": "# Boot\n",
            "docs/context-index.json": stored_index(["src/auth/DESIGN.md"]),
            "src/auth/DESIGN.md": "# Auth design\n",
        },
    )
    outcome, projection = hydrate_one(host, pin)
    assert outcome["status"] == "hydrated"
    assert (projection / "src" / "auth" / "DESIGN.md").exists()


def test_an_agents_binding_outside_the_profiles_tree_is_projected(tmp_path) -> None:
    host, _sibling, pin = custom_sibling(
        tmp_path,
        sibling_manifest(
            rootPath="docs/",
            bootProfilePath="docs/boot-profile.md",
            machine={"agentProfilesPath": "docs/agents/"},
            agents={"reviewer": "tools/review/profile.md"},
        ),
        {
            **SIBLING_INDEX_FILES,
            "docs/boot-profile.md": "# Boot\n",
            "tools/review/profile.md": "# Reviewer\n",
        },
    )
    outcome, projection = hydrate_one(host, pin)
    assert outcome["status"] == "hydrated"
    # The binding, not the tree, selects.
    assert (projection / "tools" / "review" / "profile.md").exists()


def test_a_layer_with_no_decisions_tree_and_no_generated_index_still_projects(tmp_path) -> None:
    host, _sibling, pin = custom_sibling(
        tmp_path,
        sibling_manifest(rootPath="docs/", bootProfilePath="docs/boot-profile.md"),
        {
            **SIBLING_INDEX_FILES,
            "docs/boot-profile.md": "# Boot\n",
            "docs/domain/overview.md": "# Overview\n",
        },
    )
    # Every optional selection is absent at once: git cannot represent an empty
    # directory, and a core layer has never generated an index. Absence is normal.
    outcome, projection = hydrate_one(host, pin)
    assert outcome["status"] == "hydrated"
    assert sorted(p.name for p in projection.iterdir()) == [
        "complete",
        "docs",
        "leji.json",
        "metadata.json",
    ]


def test_a_dangling_agents_binding_fails_naming_the_declaring_artifact(tmp_path, capsys) -> None:
    host, _sibling, pin = custom_sibling(
        tmp_path,
        sibling_manifest(
            rootPath="docs/",
            bootProfilePath="docs/boot-profile.md",
            agents={"reviewer": "tools/review/profile.md"},
        ),
        {**SIBLING_INDEX_FILES, "docs/boot-profile.md": "# Boot\n"},
    )
    # Closure-critical content absent at the pin is degraded knowledge of the
    # sibling, not a guard this host crossed: the mount is unavailable, and hydrate
    # stays best-effort about it.
    outcome, _projection = hydrate_one(host, pin)
    detail = (
        "closure-critical path missing at the pin: agents.reviewer profile tools/review/profile.md"
    )
    assert [outcome["status"], outcome["detail"]] == ["unavailable", detail]
    assert outcome["projectionFailed"] is True
    # Exit 0, with the failure in findings[] as well as the outcome: the JSON
    # consumer's diagnostic interface is findings, and it carries the same sentence.
    code, out = hydrate_json(host, capsys)
    assert code == 0
    assert out["ok"] is True
    assert [(f["rule"], f["severity"]) for f in out["findings"]] == [
        ("mount-projection-failed", "warning")
    ]
    assert detail in out["findings"][0]["message"]
    assert out["findings"][0]["path"] == "acme-product-context"


def test_a_pin_no_object_store_holds_is_unavailable_before_any_closure(tmp_path, capsys) -> None:
    host, _sibling, _pin = mounted_pair(tmp_path)
    # A well-formed pin the hint repository does not contain: resolution fails at the
    # object-source step, so the closure never runs and there is nothing to warn
    # about beyond the mount being unavailable.
    repin(host, "b" * 40)
    manifest = load_manifest(host).manifest
    assert manifest is not None
    outcome = hydrate_mounts(host, manifest).outcomes[0]
    assert [outcome["status"], outcome["detail"]] == [
        "unavailable",
        "no reachable object store holds the pin (declare a hint, or pass --fetch)",
    ]
    assert "projectionFailed" not in outcome
    code, out = hydrate_json(host, capsys)
    assert code == 0
    assert out["findings"] == []


def test_a_malformed_string_in_the_pinned_manifest_is_an_error(tmp_path, capsys) -> None:
    # Written as bytes, because the point is the unpaired surrogate that parses out
    # of them: valid JSON carrying a string the scalar gate exists to refuse.
    host, _sibling, pin = custom_sibling(
        tmp_path,
        '{"leji":"1.0","name":"acme-product-context","rootPath":"docs/",'
        '"bootProfilePath":"docs/boot-profile.md","description":"\\ud800"}\n',
        {"docs/boot-profile.md": "# Boot\n"},
    )
    outcome, _projection = hydrate_one(host, pin)
    assert [outcome["status"], outcome["detail"]] == [
        "error",
        "the pinned leji.json contains a malformed string",
    ]
    code, out = hydrate_json(host, capsys)
    assert code == 1
    assert out["ok"] is False


def test_structurally_malformed_pinned_content_is_unavailable_never_a_raise(
    tmp_path, capsys
) -> None:
    # Valid JSON of the wrong shape at a point the closure dereferences. Each one
    # reaches a property access on something that is not a mapping, which raises
    # where the closure owes a tagged failure; all are ordinary sibling-shape
    # defects, so all are unavailability.
    base = sibling_manifest(rootPath="docs/", bootProfilePath="docs/boot-profile.md")
    boot = {**SIBLING_INDEX_FILES, "docs/boot-profile.md": "# Boot\n"}
    cases: list[tuple[str, Union[dict, str], dict[str, str], str]] = [
        (
            "a manifest that parses to null",
            "null\n",
            {},
            "the pinned leji.json is not an object",
        ),
        (
            "category indexes as an object",
            {**base, "categories": {"domain": {"indexes": {"first": "docs/index.md"}}}},
            boot,
            "the pinned leji.json categories.domain has no indexes array",
        ),
        (
            "index entries as an object",
            base,
            {**boot, "docs/context-index.json": '{"entries": {"path": "docs/x.md"}}\n'},
            "the pinned context index has no entries array",
        ),
        # A machine field of the wrong type either raises in the path helpers or
        # reads as absent and quietly defaults; both are worse than saying so.
        (
            "machine.indexPath as a number",
            {**base, "machine": {"indexPath": 3}},
            boot,
            "the pinned leji.json machine.indexPath is not a string",
        ),
        (
            "machine.agentProfilesPath as an array",
            {**base, "machine": {"agentProfilesPath": ["docs/agents/"]}},
            boot,
            "the pinned leji.json machine.agentProfilesPath is not a string",
        ),
        (
            "a null machine path, which would otherwise default silently",
            {**base, "machine": {"changelogPath": None}},
            boot,
            "the pinned leji.json machine.changelogPath is not a string",
        ),
    ]
    for i, (what, manifest, files, detail) in enumerate(cases):
        case_dir = tmp_path / f"case-{i}"
        case_dir.mkdir()
        host, _sibling, pin = custom_sibling(case_dir, manifest, files)
        outcome, _projection = hydrate_one(host, pin)
        assert [outcome["status"], outcome["detail"]] == ["unavailable", detail], what
        code, out = hydrate_json(host, capsys)
        assert code == 0, what
        assert [(f["rule"], f["severity"]) for f in out["findings"]] == [
            ("mount-projection-failed", "warning")
        ], what


def _git_raw(cwd: Path, args: list[str], stdin: bytes | None = None) -> bytes:
    """Raw-bytes git: stdin and stdout stay bytes. A path with no UTF-8 form cannot
    reach git through argv and cannot be written to an APFS filesystem at all, so it
    is built straight into a tree object instead."""
    env = dict(os.environ)
    env.pop("GIT_DIR", None)
    return subprocess.run(
        ["git", *args], cwd=cwd, env=env, input=stdin, capture_output=True, check=True
    ).stdout


def pin_undecodable_path(host: str, sibling: Path, where: str) -> str:
    """Re-pin the sibling at a commit whose tree carries a path that is not valid
    UTF-8, placed either beside the projection's selections or inside ``docs/``.
    ``ls-tree -z`` emits exactly the record format ``mktree -z`` consumes, so the
    existing tree is reused verbatim and only the extra entry is authored here."""
    oid = _git_raw(sibling, ["hash-object", "-w", "--stdin"], b"# Bad\n").decode().strip()
    bad_entry = b"100644 blob " + oid.encode() + b"\t" + BAD_PATH_BYTES + b"\0"

    def mktree(stdin: bytes) -> str:
        return _git_raw(sibling, ["mktree", "-z"], stdin).decode().strip()

    if where == "outside":
        root_tree = mktree(_git_raw(sibling, ["ls-tree", "-z", "HEAD"]) + bad_entry)
    else:
        docs = mktree(_git_raw(sibling, ["ls-tree", "-z", "HEAD:docs"]) + bad_entry)
        leji_json = git(sibling, "rev-parse", "HEAD:leji.json")
        root_tree = mktree(
            b"100644 blob " + leji_json.encode() + b"\tleji.json\0"
            b"040000 tree " + docs.encode() + b"\tdocs\0"
        )
    pin = git(
        sibling,
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.com",
        "commit-tree",
        root_tree,
        "-m",
        "bad",
    )
    # Neither test means anything unless the bytes really landed in the tree, and a
    # silently-dropped entry would leave both of them passing.
    listing = _git_raw(sibling, ["ls-tree", "-r", "-z", "--full-tree", pin])
    assert BAD_PATH_BYTES in listing
    repin(host, pin)
    return pin


def test_an_undecodable_path_outside_every_selection_is_skipped(tmp_path) -> None:
    host, sibling, _pin = custom_sibling(
        tmp_path,
        sibling_manifest(rootPath="docs/", bootProfilePath="docs/boot-profile.md"),
        {**SIBLING_INDEX_FILES, "docs/boot-profile.md": "# Boot\n"},
    )
    # The enumeration is the whole repository, so it sees paths the projection never
    # selects. One of them being undecodable is another repository's business.
    pin = pin_undecodable_path(host, sibling, "outside")
    outcome, projection = hydrate_one(host, pin)
    assert outcome["status"] == "hydrated"
    assert sorted(p.name for p in projection.iterdir()) == [
        "complete",
        "docs",
        "leji.json",
        "metadata.json",
    ]


def test_an_undecodable_path_under_a_selected_prefix_stays_a_safety_error(tmp_path, capsys) -> None:
    host, sibling, _pin = custom_sibling(
        tmp_path,
        sibling_manifest(rootPath="docs/", bootProfilePath="docs/boot-profile.md"),
        {**SIBLING_INDEX_FILES, "docs/boot-profile.md": "# Boot\n"},
    )
    # Inside the projection there is no skipping it: nothing can be materialized
    # under a name that has no UTF-8 form.
    pin = pin_undecodable_path(host, sibling, "inside")
    outcome, _projection = hydrate_one(host, pin)
    assert outcome["status"] == "error"
    assert str(outcome["detail"]).startswith("non-UTF-8 path in the pinned tree: ")
    code, _out = hydrate_json(host, capsys)
    assert code == 1


def test_a_governed_path_with_glob_metacharacters_selects_itself(tmp_path) -> None:
    # The closure enumerates the tree and selects by name. Handed to git as a
    # pathspec, `src/a[b].md` is a character class matching `src/ab.md`: the decoy
    # would travel and the real file would be reported missing at the pin.
    host, _sibling, pin = custom_sibling(
        tmp_path,
        sibling_manifest(rootPath="docs/", bootProfilePath="docs/boot-profile.md"),
        {
            **SIBLING_INDEX_FILES,
            "docs/boot-profile.md": "# Boot\n",
            "docs/context-index.json": stored_index(["src/a[b].md"]),
            "src/a[b].md": "# Literal\n",
            "src/ab.md": "# Decoy\n",
        },
    )
    outcome, projection = hydrate_one(host, pin)
    assert outcome["status"] == "hydrated"
    assert (projection / "src" / "a[b].md").exists()
    assert not (projection / "src" / "ab.md").exists()


def test_the_first_missing_critical_path_is_chosen_by_byte_order(tmp_path) -> None:
    host, _sibling, pin = custom_sibling(
        tmp_path,
        sibling_manifest(
            rootPath="docs/",
            bootProfilePath="docs/boot-profile.md",
            agents={"zeta": "tools/z.md", "alpha": "tools/a.md"},
        ),
        {**SIBLING_INDEX_FILES, "docs/boot-profile.md": "# Boot\n"},
    )
    # Both bindings dangle, and declaration order puts zeta first. Every SDK must
    # still name tools/a.md, or insertion order decides which failure a host is told
    # about.
    outcome, _projection = hydrate_one(host, pin)
    assert [outcome["status"], outcome["detail"]] == [
        "unavailable",
        "closure-critical path missing at the pin: agents.alpha profile tools/a.md",
    ]


def test_a_declared_path_escaping_the_repository_fails_the_closure(tmp_path) -> None:
    host, _sibling, pin = custom_sibling(
        tmp_path,
        sibling_manifest(rootPath="docs/", bootProfilePath="../outside.md"),
        {**SIBLING_INDEX_FILES, "docs/keep.md": "# Keep\n"},
    )
    outcome, _projection = hydrate_one(host, pin)
    assert [outcome["status"], outcome["detail"]] == [
        "error",
        "uncontained bootProfilePath: ../outside.md",
    ]


def test_overlapping_selections_are_deduplicated(tmp_path) -> None:
    host, _sibling, pin = custom_sibling(
        tmp_path,
        sibling_manifest(rootPath="docs/", bootProfilePath="docs/boot-profile.md"),
        {
            **SIBLING_INDEX_FILES,
            "docs/boot-profile.md": "# Boot\n",
            "docs/context-index.json": stored_index(["docs/domain/overview.md"]),
            "docs/domain/overview.md": "# Overview\n",
        },
    )
    outcome, projection = hydrate_one(host, pin)
    assert outcome["status"] == "hydrated"
    # The indexed path is inside the rootPath tree, so two selections reach it. The
    # projection is their union: the manifest, the boot profile, the index, the
    # category index file and the one governed document, counted once each.
    metadata = json.loads((projection / "metadata.json").read_text(encoding="utf-8"))
    assert metadata["files"] == 5


def test_a_cache_entry_published_under_the_old_epoch_is_never_served(tmp_path) -> None:
    host, _sibling, pin = mounted_pair(tmp_path)
    # An entry keyed under "1" holds a pre-closure projection of this exact pin. The
    # epoch is the whole invalidation mechanism, so it may not answer for it.
    old_key = hashlib.sha256(f"{ACME_IDENTITY}\n{pin}\n1".encode()).hexdigest()
    old_projection = Path(host) / ".leji" / "mounts" / "cache" / old_key / "projection"
    old_projection.mkdir(parents=True)
    (old_projection / "complete").write_text("", encoding="utf-8")
    outcome, projection = hydrate_one(host, pin)
    assert outcome["status"] == "hydrated"
    assert outcome["cacheKey"] != old_key
    assert (projection / "leji.json").exists()


# --- the status projection section ---


def test_the_status_projection_sees_an_untracked_bound_profile(tmp_path, capsys) -> None:
    # The discover-before-host case: validation reads the working tree, where the
    # bound profile is right there, while the projection reads HEAD's object store,
    # where it was never committed. Only the second is what a host would get.
    root = tmp_path / "selfproj"
    fixture = REPO_ROOT / "fixtures" / "valid-actors"
    profile_rel = Path("docs") / "agents" / "reviewer.md"
    shutil.copytree(fixture, root)
    (root / profile_rel).unlink()
    git(root, "init", "-q", "-b", "main")
    git(root, "add", "-A")
    git(root, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "seed")
    shutil.copy2(fixture / profile_rel, root / profile_rel)
    # The working tree is valid, which is exactly why validate cannot see this.
    assert [f for f in validate_layer(str(root)).findings if f.severity == "error"] == []
    # The projection section diagnoses; it never gates.
    assert main(["status", "--json", "--root", str(root)]) == 0
    projection = json.loads(capsys.readouterr().out)["projection"]
    assert projection["state"] == "fail"
    assert "agents.reviewer" in projection["detail"]


def test_the_status_projection_is_ok_on_a_committed_layer_and_no_commit_before(
    tmp_path, capsys
) -> None:
    _host, sibling, _pin = mounted_pair(tmp_path)
    assert main(["status", "--json", "--root", str(sibling)]) == 0
    ok = json.loads(capsys.readouterr().out)["projection"]
    assert ok["state"] == "ok"
    assert ok["files"] > 0
    # The report names the commit it judged.
    assert len(ok["commit"]) == 40 and all(c in "0123456789abcdef" for c in ok["commit"])
    # An unborn HEAD has nothing to judge, and the section says so rather than failing.
    fresh = tmp_path / "unborn"
    shutil.copytree(SIBLING_EXAMPLE, fresh)
    git(fresh, "init", "-q", "-b", "main")
    assert main(["status", "--json", "--root", str(fresh)]) == 0
    assert json.loads(capsys.readouterr().out)["projection"] == {"state": "no-commit"}
    # The library-level report agrees with the CLI's.
    assert self_projection(str(fresh)).state == "no-commit"


# --- The canonical-schema gate, and the portability rules the closure holds ---
#
# Every test below pins a rule the three SDKs have to answer identically, and each
# names the divergence it closes: the fixture on its own does not show it.


def pin_with_entries(host: str, sibling: Path, entries: list[tuple[str, bytes, str]]) -> str:
    """Re-pin the sibling at a commit whose tree carries authored entries the working
    tree cannot hold: a (mode, content, relPath) triple per entry, staged straight
    into the index. A case-insensitive filesystem cannot hold two names that fold
    together, and no filesystem holds a zero-byte symlink, so these are built rather
    than written. Content stays bytes end to end: a symlink target's point can be
    bytes that no string round-trips."""
    for mode, content, rel in entries:
        oid = _git_raw(sibling, ["hash-object", "-w", "--stdin"], content).decode().strip()
        git(sibling, "update-index", "--add", "--cacheinfo", f"{mode},{oid},{rel}")
    tree = git(sibling, "write-tree")
    pin = git(
        sibling,
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.com",
        "commit-tree",
        tree,
        "-m",
        "authored",
    )
    repin(host, pin)
    return pin


def closure_files(**extra: str) -> dict[str, str]:
    """The file set every fixture below starts from."""
    return {**SIBLING_INDEX_FILES, "docs/boot-profile.md": "# Boot\n", **extra}


def test_a_pinned_manifest_missing_a_schema_required_field_is_unavailable(tmp_path) -> None:
    # ``categories`` is schema-required and the closure never dereferences an absent
    # one, so no shape guard could see this: the ad-hoc checks passed a manifest no
    # ``leji validate`` would accept, and the projection published it.
    manifest = sibling_manifest(rootPath="docs/", bootProfilePath="docs/boot-profile.md")
    del manifest["categories"]
    host, _sibling, pin = custom_sibling(tmp_path, manifest, {"docs/boot-profile.md": "# Boot\n"})
    outcome, _projection = hydrate_one(host, pin)
    assert [outcome["status"], outcome["detail"]] == [
        "unavailable",
        "the pinned leji.json does not validate against the manifest schema",
    ]


def test_a_pinned_index_failing_its_schema_is_unavailable(tmp_path) -> None:
    # Entries carrying a path and nothing else drove the content closure: ``id``,
    # ``title`` and ``category`` are schema-required on each entry, and the header
    # the schema requires was not checked at all.
    host, _sibling, pin = custom_sibling(
        tmp_path,
        sibling_manifest(rootPath="docs/", bootProfilePath="docs/boot-profile.md"),
        closure_files(
            **{
                "docs/context-index.json": json.dumps(
                    {"entries": [{"path": "docs/domain/overview.md"}]}, indent=2
                )
                + "\n",
                "docs/domain/overview.md": "# Overview\n",
            }
        ),
    )
    outcome, _projection = hydrate_one(host, pin)
    assert [outcome["status"], outcome["detail"]] == [
        "unavailable",
        "the pinned context index does not validate against the index schema",
    ]


def test_a_pinned_changelog_failing_its_schema_is_unavailable(tmp_path) -> None:
    # A born-empty changelog: valid JSON, invalid against its schema (minItems 1).
    host, _sibling, pin = custom_sibling(
        tmp_path,
        sibling_manifest(rootPath="docs/", bootProfilePath="docs/boot-profile.md"),
        closure_files(
            **{"docs/context-changelog.json": '{"schemaVersion": "1.0", "entries": []}\n'}
        ),
    )
    outcome, _projection = hydrate_one(host, pin)
    assert [outcome["status"], outcome["detail"]] == [
        "unavailable",
        "the pinned context changelog does not validate against the changelog schema",
    ]


def test_the_closure_walks_categories_in_document_order(tmp_path) -> None:
    # Declaration order decides which defect is reached first, and these two carry
    # different classes: sorted traversal reaches ``domain`` (availability, exit 0),
    # the document reaches ``system`` (safety, exit 1). Go sorted and the other two
    # did not, so one pinned tree exited 0 under two SDKs and 1 under the third.
    host, _sibling, pin = custom_sibling(
        tmp_path,
        sibling_manifest(
            rootPath="docs/",
            bootProfilePath="docs/boot-profile.md",
            categories={
                "system": {"indexes": ["../escape.md"]},
                "domain": {"indexes": ["docs/index/missing.md"]},
            },
        ),
        {"docs/boot-profile.md": "# Boot\n"},
    )
    outcome, _projection = hydrate_one(host, pin)
    assert [outcome["status"], outcome["detail"]] == [
        "error",
        "uncontained categories.system index: ../escape.md",
    ]


def test_the_projection_path_limit_is_measured_in_utf8_bytes(tmp_path) -> None:
    # One constant, one unit. ``len`` counts code points here, UTF-16 code units in
    # Node and bytes in Go, so a path of astral characters crossed the same declared
    # 4096 limit at three different lengths. A declared path reaches the check
    # without ever being written, which is the only way to test a length no
    # filesystem takes.
    def at(repeats: int) -> str:
        return "docs/" + "\U0001f600" * repeats + ".md"

    # 4,008 bytes: inside the limit, so the path is contained and merely absent.
    under = tmp_path / "under"
    under.mkdir()
    host, _sibling, pin = custom_sibling(
        under,
        sibling_manifest(rootPath="docs/", bootProfilePath=at(1000)),
        dict(SIBLING_INDEX_FILES),
    )
    outcome, _projection = hydrate_one(host, pin)
    assert [outcome["status"], outcome["detail"]] == [
        "unavailable",
        f"closure-critical path missing at the pin: bootProfilePath {at(1000)}",
    ]
    # 4,408 bytes: over the limit in bytes, and only in bytes.
    over = tmp_path / "over"
    over.mkdir()
    host2, _sibling2, pin2 = custom_sibling(
        over,
        sibling_manifest(rootPath="docs/", bootProfilePath=at(1100)),
        dict(SIBLING_INDEX_FILES),
    )
    outcome2, _projection2 = hydrate_one(host2, pin2)
    assert [outcome2["status"], outcome2["detail"]] == [
        "error",
        f"uncontained bootProfilePath: {at(1100)}",
    ]


def test_an_ordinary_directory_symlink_is_inside_the_projection(tmp_path) -> None:
    # ``ln -s sub/ link`` resolves to ``docs/sub/``, which is no projected path and
    # no declared prefix, so the trailing slash alone refused a conforming sibling
    # here and in Node while Go, whose path.Join Cleans it away, hydrated it. The
    # explicit strip is what makes all three answer the same.
    inside = tmp_path / "inside"
    inside.mkdir()
    host, sibling, _pin = custom_sibling(
        inside,
        sibling_manifest(rootPath="docs/", bootProfilePath="docs/boot-profile.md"),
        closure_files(**{"docs/sub/page.md": "# Page\n"}),
    )
    pin = pin_with_entries(host, sibling, [("120000", b"sub/", "docs/link")])
    outcome, projection = hydrate_one(host, pin)
    assert outcome["status"] == "hydrated", outcome
    assert os.readlink(projection / "docs" / "link") == "sub/"
    # The containment guard itself is unchanged: an escaping target carrying the
    # same trailing slash is still refused.
    escaping = tmp_path / "escaping"
    escaping.mkdir()
    host2, sibling2, _pin2 = custom_sibling(
        escaping,
        sibling_manifest(rootPath="docs/", bootProfilePath="docs/boot-profile.md"),
        closure_files(),
    )
    pin2 = pin_with_entries(host2, sibling2, [("120000", b"../../etc/", "docs/link")])
    bad, _projection2 = hydrate_one(host2, pin2)
    assert [bad["status"], bad["detail"]] == ["error", "symlink docs/link escapes the projection"]


def test_an_empty_or_undecodable_symlink_target_is_refused(tmp_path) -> None:
    cases = [
        # Zero bytes: no ``ln -s`` produces it, the system call that would
        # materialize it fails, and resolving it read as the containing directory
        # here and as the entry itself in Node and Go.
        (b"", "symlink target is empty in docs/link"),
        # Not valid UTF-8: Node and this SDK substituted U+FFFD and wrote different
        # bytes than Go, under the same cache key.
        (b"sub/\xff", "symlink target is not valid UTF-8 in docs/link"),
    ]
    for i, (content, detail) in enumerate(cases):
        case_dir = tmp_path / f"link-case-{i}"
        case_dir.mkdir()
        host, sibling, _pin = custom_sibling(
            case_dir,
            sibling_manifest(rootPath="docs/", bootProfilePath="docs/boot-profile.md"),
            closure_files(**{"docs/sub/page.md": "# Page\n"}),
        )
        pin = pin_with_entries(host, sibling, [("120000", content, "docs/link")])
        outcome, _projection = hydrate_one(host, pin)
        assert [outcome["status"], outcome["detail"]] == ["error", detail], content


def test_case_collision_folds_ascii_only(tmp_path) -> None:
    def build(label: str, names: list[str]) -> dict:
        case_dir = tmp_path / label
        case_dir.mkdir()
        host, sibling, _pin = custom_sibling(
            case_dir,
            sibling_manifest(rootPath="docs/", bootProfilePath="docs/boot-profile.md"),
            closure_files(),
        )
        pin = pin_with_entries(host, sibling, [("100644", f"# {n}\n".encode(), n) for n in names])
        outcome, _projection = hydrate_one(host, pin)
        return outcome

    # ASCII still collides: this is what the guard is for.
    ascii_case = build("ascii", ["docs/Page.md", "docs/page.md"])
    assert ascii_case["status"] == "error"
    assert str(ascii_case["detail"]).startswith("case collision in the pinned tree: docs/")
    # Non-ASCII does not, in any SDK. The cost is real and deliberate: a
    # case-insensitive filesystem may still fold these together. A shared Unicode
    # table was rejected because table versions differ across runtimes, and three
    # runtime-specific lowercase mappings are not a contract at all.
    assert build("nonascii", ["docs/Ä.md", "docs/ä.md"])["status"] == "hydrated"
