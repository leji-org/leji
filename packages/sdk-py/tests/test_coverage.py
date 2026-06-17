"""Targeted behavioral tests for genuinely-untested branches.

Each test exercises an error branch, edge case, or fallback that the broader
suite (units, sdk, cli, fixtures) leaves uncovered. Behavior is verified
against the documented contract, not merely line-touched.
"""

import json
import shutil
import subprocess
from pathlib import Path

from leji import (
    check_changelog_append_only,
    check_index,
    conformance_report,
    load_manifest,
    validate_layer,
    write_index,
)
from leji.docs_cmd import _relative_to_root
from leji.findings import Finding, has_errors
from leji.gitutil import git_last_modified, git_show_head
from leji.layer import read_json_artifact, scan_categories

REPO_ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = REPO_ROOT / "examples" / "monorepo"
FIXTURES = REPO_ROOT / "fixtures"


def _copy(src: Path, tmp_path: Path) -> Path:
    dest = tmp_path / "layer"
    shutil.copytree(src, dest)
    return dest


def _git_seed(layer: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=layer, check=True)
    subprocess.run(["git", "config", "user.email", "t@e.com"], cwd=layer, check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=layer, check=True)
    subprocess.run(["git", "add", "-A"], cwd=layer, check=True)
    subprocess.run(["git", "commit", "-qm", "seed"], cwd=layer, check=True)


# --- cli.py -----------------------------------------------------------------


def test_cli_help_pseudo_command_prints_help(capsys) -> None:
    from leji.cli import main

    code = main(["help"])
    out = capsys.readouterr().out
    assert code == 0
    assert "usage" in out.lower()


def test_cli_version_pseudo_command_prints_version(capsys) -> None:
    from leji.cli import main
    from leji.schemas import SDK_VERSION

    code = main(["version"])
    out = capsys.readouterr().out.strip()
    assert code == 0
    assert out == SDK_VERSION


def test_cli_changelog_no_declared_path_errors(tmp_path, capsys) -> None:
    from leji.cli import main

    # valid-minimal-core is a core layer with no machine.changelogPath.
    layer = _copy(FIXTURES / "valid-minimal-core", tmp_path)
    code = main(["changelog", "check", "--root", str(layer)])
    out = capsys.readouterr().out
    assert code == 1
    assert "changelog-required" in out
    assert "no machine.changelogPath" in out


def test_cli_freshness_text_prints_upcoming(tmp_path, capsys) -> None:
    from leji.cli import main

    layer = _copy(EXAMPLE, tmp_path)
    # Add a doc whose review horizon lands inside the 30-day window so the
    # text path prints an "upcoming" line.
    import datetime as dt

    soon = (dt.datetime.now(dt.timezone.utc).date() + dt.timedelta(days=10)).isoformat()
    (layer / "docs" / "domain" / "soon.md").write_text(
        f"---\nfreshness:\n  reviewAfter: {soon}\n---\n\n# Soon\n", encoding="utf-8"
    )
    code = main(["freshness", "--root", str(layer)])
    out = capsys.readouterr().out
    assert code == 0
    assert "upcoming docs/domain/soon.md" in out
    assert soon in out


def test_cli_init_text_output_lists_written_files(tmp_path, capsys) -> None:
    from leji.cli import main

    code = main(["init", "--dir", str(tmp_path), "--yes"])
    out = capsys.readouterr().out
    assert code == 0
    assert "Wrote" in out and "files:" in out
    assert "leji.json" in out
    # entering_the_layer guidance is printed too.
    assert "Enter the layer" in out


def test_cli_docs_text_output_serve_hint(tmp_path, capsys) -> None:
    from leji.cli import main

    layer = _copy(EXAMPLE, tmp_path)
    code = main(["docs", "--root", str(layer)])
    out = capsys.readouterr().out
    assert code == 0
    assert "serve locally: leji docs --serve" in out


def test_cli_default_argv_from_sys_argv(monkeypatch, capsys) -> None:
    from leji import cli

    # argv=None -> main reads sys.argv[1:]; no command -> usage, exit 2.
    monkeypatch.setattr(cli.sys, "argv", ["leji"])
    code = cli.main()
    assert code == 2
    assert "usage" in capsys.readouterr().out.lower()


def test_cli_docs_serve_starts_and_stops(tmp_path, monkeypatch, capsys) -> None:
    from leji import cli

    layer = _copy(EXAMPLE, tmp_path)

    class FakeServer:
        server_address = ("127.0.0.1", 5354)

        def __init__(self) -> None:
            self.shutdown_called = False

        def serve_forever(self) -> None:
            # Mirror a Ctrl+C while serving; main must catch it and shut down.
            raise KeyboardInterrupt

        def shutdown(self) -> None:
            self.shutdown_called = True

    fake = FakeServer()
    monkeypatch.setattr(cli, "serve_docs", lambda _root, _port: fake)
    code = cli.main(["docs", "--root", str(layer), "--serve"])
    out = capsys.readouterr().out
    assert code == 0
    assert "serving http://127.0.0.1:5354/" in out
    assert fake.shutdown_called is True


# --- layer.py ---------------------------------------------------------------


def test_scan_categories_excludes_boot_profile_and_readme(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    # A README inside a category path is excluded; the boot profile is too.
    (layer / "docs" / "domain" / "README.md").write_text("# Readme\n", encoding="utf-8")
    manifest = load_manifest(str(layer)).manifest
    docs = scan_categories(str(layer), manifest)
    paths = {d.rel_path for d in docs}
    assert "docs/domain/README.md" not in paths
    assert manifest["bootProfilePath"] not in paths


def test_scan_categories_longest_declared_path_wins(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    # Map the same file under two category paths; the longer (more specific)
    # declared path must claim it.
    manifest["categories"]["domain"]["paths"] = ["docs/", "docs/domain/"]
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    m = load_manifest(str(layer)).manifest
    docs = scan_categories(str(layer), m)
    glossary = next(d for d in docs if d.rel_path == "docs/domain/glossary.md")
    assert glossary.category == "domain"


def test_scan_excludes_readme_in_agent_profiles(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    (layer / "docs" / "agents" / "README.md").write_text("# Agents\n", encoding="utf-8")
    from leji.layer import scan_agent_profiles

    manifest = load_manifest(str(layer)).manifest
    profiles = scan_agent_profiles(str(layer), manifest)
    assert all(p.rel_path != "docs/agents/README.md" for p in profiles)


def test_scan_decision_records_dedups_overlapping_paths(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    # decisionRecordsPath and the mapped decisions category resolve to the same
    # files via distinct path strings (trailing slash differs), so the same
    # record is reached twice and must be deduped on rel_path.
    manifest["machine"]["decisionRecordsPath"] = "docs/decisions"
    manifest["categories"]["decisions"]["paths"] = ["docs/decisions/"]
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    from leji.layer import scan_decision_records

    m = load_manifest(str(layer)).manifest
    records = scan_decision_records(str(layer), m)
    rels = [r.rel_path for r in records]
    assert len(rels) == len(set(rels))
    assert "docs/decisions/0001-adopt-leji.md" in rels


def test_read_json_artifact_missing_file_returns_none_none(tmp_path) -> None:
    data, finding = read_json_artifact(str(tmp_path), "nope.json")
    assert data is None
    assert finding is None


# --- indexgen.py ------------------------------------------------------------


def test_index_emits_tags_owners_links_from_frontmatter(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    (layer / "docs" / "domain" / "rich.md").write_text(
        "---\n"
        "id: rich-doc\n"
        "title: Rich\n"
        "tags:\n  - a\n  - b\n"
        "owners:\n  - jo@acme.example\n"
        "links:\n  - https://example.com\n"
        "---\n\n# Rich\n",
        encoding="utf-8",
    )
    manifest = load_manifest(str(layer)).manifest
    result = write_index(str(layer), manifest)
    entry = next(e for e in result.index["entries"] if e["id"] == "rich-doc")
    assert entry["tags"] == ["a", "b"]
    assert entry["owners"] == ["jo@acme.example"]
    assert entry["links"] == ["https://example.com"]


def test_index_drops_empty_and_non_string_array_members(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    # tags has only non-string members -> _str_array returns None, no key.
    (layer / "docs" / "domain" / "thin.md").write_text(
        "---\nid: thin-doc\ntitle: Thin\ntags:\n  - 1\n  - true\n---\n\n# Thin\n",
        encoding="utf-8",
    )
    manifest = load_manifest(str(layer)).manifest
    result = write_index(str(layer), manifest)
    entry = next(e for e in result.index["entries"] if e["id"] == "thin-doc")
    assert "tags" not in entry


def test_index_numeric_de_collision_of_slug(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    # Files whose stem ("notes") collides and whose parent dirs all slugify to
    # the same "dir", so parent de-collision yields the same "dir-notes" id and
    # the numeric -2/-3 suffix loop must run.
    for sub in ("dir", "dir.", "dir!"):
        d = layer / "docs" / "domain" / sub
        d.mkdir(parents=True)
        (d / "notes.md").write_text("# Notes\n")
    manifest = load_manifest(str(layer)).manifest
    result = write_index(str(layer), manifest)
    ids = [e["id"] for e in result.index["entries"]]
    assert len(set(ids)) == len(ids), "ids must stay unique after de-collision"
    # At least one numerically-suffixed variant exists.
    assert any(i.endswith("-2") for i in ids)


def test_check_index_reports_schema_violation(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest
    write_index(str(layer), manifest)
    rel = layer / "docs" / "context-index.json"
    index = json.loads(rel.read_text())
    # Break the schema: entries must be an array.
    index["entries"] = "not-an-array"
    rel.write_text(json.dumps(index, indent=2) + "\n")
    result = check_index(str(layer), manifest)
    assert result.stale is True
    assert any(f.rule == "artifact-schema" for f in result.findings)


# --- init_cmd.py ------------------------------------------------------------


def test_init_git_config_failure_falls_back(tmp_path, monkeypatch) -> None:
    from leji import init_cmd

    def boom(*_a, **_k):
        raise OSError("no git")

    monkeypatch.setattr(init_cmd.subprocess, "run", boom)
    answers = init_cmd._default_answers(str(tmp_path), None, None)
    assert answers.owner_name == "<named owner>"
    assert answers.owner_contact == ""


def test_init_prompt_defaults_and_optional_categories(tmp_path, monkeypatch) -> None:
    from leji import init_cmd

    # Empty answers everywhere -> defaults; empty yes/no answers fall back to
    # each question's default (domain Y, system Y, practice N, governance N);
    # context root without trailing slash gets one appended.
    answers_iter = iter(["", "", "ctx", "Jo", "jo@x.example", "", "", "y", "y", ""])
    monkeypatch.setattr("builtins.input", lambda _p: next(answers_iter))
    result = init_cmd._prompt(str(tmp_path), None, None)
    assert result.root_path == "ctx/"
    assert "practice" in result.categories
    assert "governance" in result.categories
    assert result.level == "core"


def test_init_does_not_overwrite_existing_seeded_files(tmp_path) -> None:
    from leji.init_cmd import init_layer

    # Pre-create the boot profile; init must keep our content (skip path).
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "boot-profile.md").write_text("PRESERVED\n", encoding="utf-8")
    result = init_layer(str(tmp_path), yes=True, name="demo-context")
    assert (tmp_path / "docs" / "boot-profile.md").read_text() == "PRESERVED\n"
    assert "docs/boot-profile.md" not in result.written


# --- gitutil.py -------------------------------------------------------------


def test_git_last_modified_none_when_dirty(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    _git_seed(layer)
    rel = "docs/domain/glossary.md"
    # Modify after commit so working tree is dirty for this path.
    (layer / rel).write_text("# Glossary changed\n", encoding="utf-8")
    assert git_last_modified(str(layer), rel) is None


def test_git_show_head_none_outside_repo(tmp_path) -> None:
    # No git init -> no toplevel -> None.
    assert git_show_head(str(tmp_path), "anything.json") is None


# --- findings.py ------------------------------------------------------------


def test_has_errors_detects_error_severity() -> None:
    assert has_errors([Finding("r", "warning", "m"), Finding("r", "error", "m")]) is True
    assert has_errors([Finding("r", "warning", "m")]) is False
    assert has_errors([]) is False


# --- freshness.py -----------------------------------------------------------


def test_freshness_includes_agent_profile_horizon(tmp_path) -> None:
    from leji import freshness_report

    layer = _copy(EXAMPLE, tmp_path)
    import datetime as dt

    past = (dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=5)).isoformat()
    (layer / "docs" / "agents" / "stale.md").write_text(
        "---\nid: stale\nname: S\nrole: s\n"
        "requiredRead:\n  - docs/boot-profile.md\nmustAskWhen:\n  - always\n"
        f"freshness:\n  reviewAfter: {past}\n---\n\n# S\n",
        encoding="utf-8",
    )
    manifest = load_manifest(str(layer)).manifest
    report = freshness_report(str(layer), manifest)
    assert any(i["path"] == "docs/agents/stale.md" for i in report.expired)


# --- docs_cmd.py ------------------------------------------------------------


def test_relative_to_root_dot_root_passthrough() -> None:
    # Empty / "." rootPath: paths pass through unchanged.
    assert _relative_to_root("docs/x.md", "") == "docs/x.md"
    assert _relative_to_root("docs/x.md", ".") == "docs/x.md"


def test_relative_to_root_outside_root_is_none() -> None:
    assert _relative_to_root("other/x.md", "docs/") is None


# --- conformance.py ---------------------------------------------------------


def test_conformance_changelog_append_only_failure_marks_fail(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    _git_seed(layer)
    rel = layer / "docs" / "context-changelog.json"
    changelog = json.loads(rel.read_text())
    # Modify a surviving entry's summary -> append-only error.
    changelog["entries"][0]["summary"] = "tampered"
    rel.write_text(json.dumps(changelog, indent=2) + "\n", encoding="utf-8")
    result = conformance_report(str(layer))
    item = next(i for i in result.items if i.id == "changelog")
    assert item.status == "fail"


# --- validate.py ------------------------------------------------------------


def test_validate_below_level_index_schema_checked(tmp_path) -> None:
    # A core layer that nonetheless ships an index file: the index is
    # schema-validated even though the level does not require it.
    layer = _copy(FIXTURES / "valid-minimal-core", tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["machine"] = {**manifest.get("machine", {}), "indexPath": "docs/context-index.json"}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    # Write a schema-invalid index.
    (layer / "docs" / "context-index.json").write_text(
        json.dumps({"schemaVersion": "1.0", "entries": "bad"}) + "\n", encoding="utf-8"
    )
    result = validate_layer(str(layer))
    assert any(
        f.rule == "artifact-schema" and f.path == "docs/context-index.json" for f in result.findings
    )


def test_validate_below_level_index_parse_error(tmp_path) -> None:
    layer = _copy(FIXTURES / "valid-minimal-core", tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["machine"] = {**manifest.get("machine", {}), "indexPath": "docs/context-index.json"}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    (layer / "docs" / "context-index.json").write_text("{ not json", encoding="utf-8")
    result = validate_layer(str(layer))
    assert any(f.rule == "artifact-parse" for f in result.findings)


def test_validate_indexed_missing_changelog_required(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    # Claim indexed but declare a changelog path that does not exist.
    manifest["conformance"]["claimedLevel"] = "indexed"
    manifest["machine"]["changelogPath"] = "docs/missing-changelog.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    write_index(str(layer), manifest)  # keep index current so we isolate changelog
    result = validate_layer(str(layer))
    assert any(
        f.rule == "changelog-required" and "does not exist" in f.message for f in result.findings
    )


def test_changelog_data_none_when_declared_file_absent(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    result = check_changelog_append_only(str(layer), "docs/does-not-exist.json")
    assert result.verified is False
    assert any(
        f.rule == "changelog-required" and "does not exist" in f.message for f in result.findings
    )


def test_changelog_new_file_no_head_verified_true(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    _git_seed(layer)
    # A brand-new changelog committed nowhere: add a fresh file not at HEAD.
    rel = "docs/context-changelog-new.json"
    (layer / rel).write_text(
        json.dumps(
            {
                "$schema": "https://leji.org/schemas/v1.0/context-changelog.schema.json",
                "schemaVersion": "1.0",
                "entries": [
                    {
                        "id": "e1",
                        "date": "2026-06-12",
                        "type": "added",
                        "summary": "new",
                        "paths": ["docs/x.md"],
                    }
                ],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    # Not committed -> git_show_head returns None -> verified True, no error.
    result = check_changelog_append_only(str(layer), rel)
    assert result.verified is True
    assert [f for f in result.findings if f.severity == "error"] == []


def test_changelog_canonical_json_ignores_float_spelling(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    rel = "docs/context-changelog.json"
    changelog = json.loads((layer / rel).read_text())
    # Add a numeric field spelled as an integer.
    changelog["entries"][0]["count"] = 1
    (layer / rel).write_text(json.dumps(changelog, indent=2) + "\n", encoding="utf-8")
    _git_seed(layer)
    # Rewrite the same value as a float 1.0; canonical form must match HEAD.
    again = json.loads((layer / rel).read_text())
    again["entries"][0]["count"] = 1.0
    (layer / rel).write_text(json.dumps(again, indent=2) + "\n", encoding="utf-8")
    result = check_changelog_append_only(str(layer), rel)
    assert not any(
        f.rule == "changelog-append-only" and "modified" in f.message for f in result.findings
    )


def test_validate_categories_minimum_missing_decisions(tmp_path) -> None:
    layer = _copy(FIXTURES / "valid-minimal-core", tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    # Drop decisions so the minimum (domain|system + decisions) is unmet.
    del manifest["categories"]["decisions"]
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    result = validate_layer(str(layer))
    assert any(f.rule == "categories-minimum" for f in result.findings)


def test_validate_category_path_missing(tmp_path) -> None:
    layer = _copy(FIXTURES / "valid-minimal-core", tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["categories"]["domain"]["paths"] = ["docs/ghost/"]
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    result = validate_layer(str(layer))
    assert any(
        f.rule == "category-path-missing" and f.path == "docs/ghost/" for f in result.findings
    )


def test_validate_machine_path_outside_root_warns(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    # A machine path under a different top-level dir than rootPath ("docs/").
    manifest["machine"]["agentProfilesPath"] = "elsewhere/agents/"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    result = validate_layer(str(layer))
    assert any(
        f.rule == "paths-outside-root" and "machine.agentProfilesPath" in f.message
        for f in result.findings
    )


def test_validate_agent_outside_profiles_dir_bad_frontmatter(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    # An agents-map target outside agentProfilesPath with malformed YAML
    # frontmatter: parse_frontmatter sets fm.error.
    manifest["agents"]["reviewer"] = "docs/reviewer.md"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    (layer / "docs" / "reviewer.md").write_text(
        "---\n: : bad yaml : :\n---\n\n# Reviewer\n", encoding="utf-8"
    )
    result = validate_layer(str(layer))
    assert any(
        f.rule == "profile-frontmatter" and f.path == "docs/reviewer.md" for f in result.findings
    )


def test_validate_agent_outside_profiles_dir_schema_error(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["agents"]["reviewer"] = "docs/reviewer.md"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    # Valid YAML, present frontmatter, but violates the agent-profile schema
    # (missing required fields) -> schema_errors path.
    (layer / "docs" / "reviewer.md").write_text(
        "---\nid: reviewer\n---\n\n# Reviewer\n", encoding="utf-8"
    )
    result = validate_layer(str(layer))
    assert any(
        f.rule == "profile-frontmatter" and f.path == "docs/reviewer.md" for f in result.findings
    )


def test_validate_mount_duplicate_path_and_self_name(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    host = manifest["name"]
    manifest["federation"] = {
        "mounts": [
            {"path": "sub/a", "name": "alpha", "owner": {"name": "Jo"}},
            # same path as the first -> mount-duplicate (path branch)
            {"path": "sub/a", "name": "beta", "owner": {"name": "Jo"}},
            # reuses the host layer's own name -> mount-self
            {"path": "sub/c", "name": host, "owner": {"name": "Jo"}},
        ]
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    result = validate_layer(str(layer))
    assert any(f.rule == "mount-duplicate" and "same path" in f.message for f in result.findings)
    assert any(f.rule == "mount-self" for f in result.findings)


def test_validate_mount_invalid_json_manifest(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["federation"] = {"mounts": [{"path": "sub/m", "name": "mm", "owner": {"name": "Jo"}}]}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    mount_dir = layer / "sub" / "m"
    mount_dir.mkdir(parents=True)
    # A sibling leji.json that is not valid JSON -> mount-not-a-layer warning.
    (mount_dir / "leji.json").write_text("{ not json", encoding="utf-8")
    result = validate_layer(str(layer))
    assert any(
        f.rule == "mount-not-a-layer" and "not valid JSON" in f.message for f in result.findings
    )


def test_changelog_head_not_valid_json_verified_true(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    rel = "docs/context-changelog.json"
    # Commit a non-JSON changelog at HEAD.
    (layer / rel).write_text("not json at all\n", encoding="utf-8")
    _git_seed(layer)
    # Now write valid JSON in the working tree.
    (layer / rel).write_text(
        json.dumps(
            {
                "$schema": "https://leji.org/schemas/v1.0/context-changelog.schema.json",
                "schemaVersion": "1.0",
                "entries": [
                    {
                        "id": "e1",
                        "date": "2026-06-12",
                        "type": "added",
                        "summary": "s",
                        "paths": ["docs/x.md"],
                    }
                ],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    result = check_changelog_append_only(str(layer), rel)
    # HEAD parse failed -> append-only treated as verified, no append-only error.
    assert result.verified is True
    assert not any(f.rule == "changelog-append-only" for f in result.findings)
