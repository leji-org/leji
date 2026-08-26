"""Targeted behavioral tests for genuinely-untested branches.

Each test exercises an error branch, edge case, or fallback that the broader
suite (units, sdk, cli, fixtures) leaves uncovered. Behavior is verified
against the documented contract, not merely line-touched.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from leji import (
    check_changelog_append_only,
    check_index,
    conformance_report,
    load_manifest,
    validate_layer,
    write_index,
)
from leji.viewer_cmd import _relative_to_root
from leji.findings import Finding, has_errors
from leji.gitutil import git_last_modified, git_show_head
from leji.layer import read_json_artifact, scan_categories
from leji.mounts import cache_key_for, normalize_source

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


def test_cli_changelog_resolves_default_path(tmp_path, capsys) -> None:
    from leji.cli import main

    # valid-minimal-core declares no machine.changelogPath; the effective path
    # defaults to rootPath + context-changelog.json. The file is simply absent, so
    # the finding is the missing-file changelog-required, never a "not declared"
    # error.
    layer = _copy(FIXTURES / "valid-minimal-core", tmp_path)
    code = main(["changelog", "check", "--root", str(layer)])
    out = capsys.readouterr().out
    assert code == 1
    assert "changelog-required" in out
    assert "no machine" not in out and "not declared" not in out
    assert "changelog docs/context-changelog.json does not exist" in out


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
    assert "leji validate --content" in out


def test_cli_viewer_text_output_serve_hint(tmp_path, capsys) -> None:
    from leji.cli import main

    layer = _copy(EXAMPLE, tmp_path)
    code = main(["viewer", "--root", str(layer)])
    out = capsys.readouterr().out
    assert code == 0
    assert "serve: leji view" in out
    assert "viewer ready (3 entries) → .leji/viewer/" in out


def test_serve_viewer_rejects_escaping_root_rel(tmp_path) -> None:
    # The CLI passes a schema-validated rootPath, but a direct SDK caller could pass
    # an escaping root_rel (e.g. ".."); serve_viewer must refuse. Mirrors Node/Go.
    from leji.serve_cmd import serve_viewer

    layer = _copy(EXAMPLE, tmp_path)
    for root_rel in ("..", "../.."):
        with pytest.raises(ValueError, match="escapes the layer root"):
            serve_viewer(str(layer), 0, root_rel)


def test_serve_viewer_serves_chrome_content_and_refuses_traversal(tmp_path) -> None:
    # A real HTTP exercise of the serve handler (Node fetches a live server; Python
    # had only a mocked server). Covers the virtual mount, the sidebar alias, the
    # dotfile/.leji refusal, parent-traversal 403, and the malformed-encoding 400.
    import http.client
    import threading

    from leji.serve_cmd import serve_viewer
    from leji.viewer_cmd import generate_viewer

    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest
    generate_viewer(str(layer), manifest)
    server = serve_viewer(str(layer), 0, manifest["rootPath"])
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    # http.client sends the request path verbatim (no client-side normalization),
    # so raw traversal and malformed-encoding paths reach the handler intact.
    def get(path: str) -> tuple[int, bytes]:
        conn = http.client.HTTPConnection("127.0.0.1", port)
        try:
            conn.request("GET", path)
            resp = conn.getresponse()
            return resp.status, resp.read()
        finally:
            conn.close()

    try:
        status, body = get("/")
        assert status == 200
        assert b"viewer-boot" in body  # the viewer chrome is served at the web root
        assert get("/assets/docsify.min.js")[0] == 200
        assert get("/content/domain/glossary.md")[0] == 200  # markdown under /content/
        assert get("/content/_sidebar.md")[0] == 200  # generated sidebar alias
        # The internal .leji path is reachable only through the mounts, never directly.
        assert get("/content/.leji/viewer/index.html")[0] == 404
        # A directory with no index.html, and a missing file, both answer 404.
        assert get("/content/domain")[0] == 404
        assert get("/content/does-not-exist.md")[0] == 404
        # A malformed percent-encoding answers 400 rather than crashing the server.
        assert get("/%E0%A4%A")[0] == 400
        # A symlink under the content dir that resolves outside the root -> 403
        # (matches the unconditional symlink convention in test_ci.py).
        (Path(layer) / "docs" / "evil").symlink_to("/etc/hosts")
        assert get("/content/evil")[0] == 403
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


def test_serve_viewer_live_sidebar_and_index(tmp_path) -> None:
    # The served sidebar and context index are live: a document added after
    # generation shows up on the next fetch without regenerating, and the stored
    # index path serves freshly generated JSON (the classification chip's source).
    import http.client
    import threading

    from leji.serve_cmd import serve_viewer
    from leji.viewer_cmd import generate_viewer

    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest
    generate_viewer(str(layer), manifest)
    server = serve_viewer(str(layer), 0, manifest["rootPath"])
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def get(path: str) -> tuple[int, bytes]:
        conn = http.client.HTTPConnection("127.0.0.1", port)
        try:
            conn.request("GET", path)
            resp = conn.getresponse()
            return resp.status, resp.read()
        finally:
            conn.close()

    try:
        status, body = get("/content/_sidebar.md")
        assert status == 200
        assert b"Glossary" in body
        # A new ungoverned doc lands in the Reference drawer on the very next
        # fetch, without regenerating the viewer.
        (Path(layer) / "docs" / "fresh-note.md").write_text(
            "---\ntitle: Fresh Note\n---\n\n# Fresh Note\n"
        )
        status, body = get("/content/_sidebar.md")
        assert status == 200
        assert b"[Fresh Note](/fresh-note.md)" in body
        assert b"- **Reference**" in body
        # The stored index path serves the live index JSON.
        status, body = get("/content/context-index.json")
        assert status == 200
        assert b'"entries"' in body
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


def test_open_browser_spawns_and_swallows_errors(monkeypatch) -> None:
    # open_browser is best-effort: it spawns the platform opener and never raises,
    # even when the opener is missing. Covers the happy path and the OSError branch.
    from leji import serve_cmd

    calls: list[list[str]] = []

    def fake_popen(cmd, **_kwargs):
        calls.append(cmd)
        return object()

    monkeypatch.setattr(subprocess, "Popen", fake_popen)
    serve_cmd.open_browser("http://127.0.0.1:5354/")
    assert len(calls) == 1
    assert calls[0][-1] == "http://127.0.0.1:5354/"

    def raising_popen(_cmd, **_kwargs):
        raise OSError("no opener on PATH")

    monkeypatch.setattr(subprocess, "Popen", raising_popen)
    serve_cmd.open_browser("http://127.0.0.1:5354/")  # must not raise


def test_build_viewer_exports_static_folder_and_contains_output(tmp_path) -> None:
    # build_viewer was untested in Python: exercise the default export, an absolute
    # in-repo --out, and the containment guards (escape / repo root / context root).
    from leji.export_cmd import build_viewer

    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest

    # Default out: the dist role of the unified root `.leji/`, mirroring the served
    # URL contract (chrome at the web root, markdown under /content/).
    result = build_viewer(str(layer), manifest)
    assert result.out == ".leji/dist"
    assert not has_errors(result.findings)
    out = Path(layer) / ".leji" / "dist"
    index = (out / "index.html").read_text()
    assert index.startswith("<!--") and "Leji viewer" in index  # protect warning prepended
    assert (out / "content" / "domain" / "glossary.md").is_file()
    assert (out / "content" / "_sidebar.md").is_file()
    assert (out / "assets" / "docsify.min.js").is_file()

    # An absolute --out inside the repo is honored.
    abs_out = Path(layer) / "dist-abs"
    assert build_viewer(str(layer), manifest, str(abs_out)).out == "dist-abs"
    assert (abs_out / "index.html").is_file()

    # Containment guards. An escaping --out is answered by the write rule itself, ahead
    # of the collision checks: every write stays inside the repository root.
    with pytest.raises(RuntimeError, match="resolves outside the repository"):
        build_viewer(str(layer), manifest, "../escape")
    # The repo root and the context root are the collision usage errors, raised before
    # any work starts.
    for bad in (".", "docs"):
        with pytest.raises(RuntimeError, match="must be a path inside the repository"):
            build_viewer(str(layer), manifest, bad)


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
    monkeypatch.setattr(
        cli, "serve_viewer", lambda _root, _port, _root_rel="", log=None, entries=None: fake
    )
    code = cli.main(["viewer", "serve", "--root", str(layer)])
    out = capsys.readouterr().out
    assert code == 0
    assert "acme-billing-context viewer → http://localhost:5354/   (Ctrl+C to stop)" in out
    assert fake.shutdown_called is True


def test_cli_view_command_opens_browser(tmp_path, monkeypatch, capsys) -> None:
    from leji import cli

    layer = _copy(EXAMPLE, tmp_path)

    class FakeServer:
        server_address = ("127.0.0.1", 5354)

        def serve_forever(self) -> None:
            raise KeyboardInterrupt

        def shutdown(self) -> None:
            pass

    monkeypatch.setattr(
        cli,
        "serve_viewer",
        lambda _root, _port, _root_rel="", log=None, entries=None: FakeServer(),
    )
    opened: list[str] = []
    monkeypatch.setattr(cli, "open_browser", lambda url: opened.append(url))
    # `leji view` == viewer serve --open: it serves and opens the browser.
    code = cli.main(["view", "--root", str(layer)])
    out = capsys.readouterr().out
    assert code == 0
    assert "acme-billing-context viewer → http://localhost:5354/   (Ctrl+C to stop)" in out
    assert len(opened) == 1
    assert opened[0] == "http://localhost:5354/"


# --- layer.py ---------------------------------------------------------------


def test_scan_categories_excludes_boot_profile_and_readme(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    # A README inside a category path is excluded; the boot profile is too.
    (layer / "docs" / "domain" / "README.md").write_text("# Readme\n", encoding="utf-8")
    manifest = load_manifest(str(layer)).manifest
    docs = scan_categories(str(layer), manifest).docs
    paths = {d.rel_path for d in docs}
    assert "docs/domain/README.md" not in paths
    assert manifest["bootProfilePath"] not in paths


def test_scan_categories_index_entry_may_be_single_file(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    # An index entry may point at a single .md file (not just a directory).
    (layer / "docs" / "context" / "system.md").write_text(
        "# System\n\n```leji-index\n- path: docs/system-notes.md\n```\n", encoding="utf-8"
    )
    (layer / "docs" / "system-notes.md").write_text("# System Notes\n", encoding="utf-8")
    m = load_manifest(str(layer)).manifest
    docs = scan_categories(str(layer), m).docs
    note = next(d for d in docs if d.rel_path == "docs/system-notes.md")
    assert note.category == "system"


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
    # decisionRecordsPath and the decisions category index resolve to the same
    # files via distinct path strings (trailing slash differs), so the same
    # record is reached twice and must be deduped on rel_path.
    manifest.setdefault("machine", {})["decisionRecordsPath"] = "docs/decisions"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    (layer / "docs" / "context" / "decisions.md").write_text(
        "# Decisions\n\n```leji-index\n- path: docs/decisions/\n```\n", encoding="utf-8"
    )
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


# --- viewer_cmd.py ------------------------------------------------------------


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


def test_changelog_new_file_no_head_is_unverifiable(tmp_path) -> None:
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
    assert result.verified is False
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


def test_validate_category_index_missing(tmp_path) -> None:
    layer = _copy(FIXTURES / "valid-minimal-core", tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["categories"]["domain"]["indexes"] = ["docs/context/ghost.md"]
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    result = validate_layer(str(layer))
    assert any(
        f.rule == "category-index-missing" and f.path == "docs/context/ghost.md"
        for f in result.findings
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


def test_validate_mount_duplicate_and_self_name(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    host = manifest["name"]
    pin = "a" * 40
    src = "https://github.com/acme/product-context"
    manifest["federation"] = {
        "mounts": [
            {"name": "alpha", "source": src, "pin": pin, "owner": {"name": "Jo"}},
            # same name as the first -> mount-duplicate
            {"name": "alpha", "source": src, "pin": pin, "owner": {"name": "Jo"}},
            # reuses the host layer's own name -> mount-self
            {"name": host, "source": src, "pin": pin, "owner": {"name": "Jo"}},
        ]
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    result = validate_layer(str(layer))
    assert any(f.rule == "mount-duplicate" and "same name" in f.message for f in result.findings)
    assert any(f.rule == "mount-self" for f in result.findings)
    # Names the manifest lies about never additionally report availability.
    assert not any(f.rule == "mount-unavailable" for f in result.findings)


def test_validate_mount_hydrated_projection_suppresses_warning(tmp_path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["federation"] = {
        "mounts": [
            {
                "name": "mm",
                "source": "https://github.com/acme/mm",
                "pin": "a" * 40,
                "owner": {"name": "Jo"},
            }
        ]
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    # Nothing published under the derived key -> unavailable (warning).
    result = validate_layer(str(layer))
    assert any(f.rule == "mount-unavailable" and f.severity == "warning" for f in result.findings)
    # Availability is the published marker at the derived key: no state file exists
    # to point at a projection, so the cache key comes from the declaration itself.
    mount = manifest["federation"]["mounts"][0]
    identity = normalize_source(mount["source"])
    assert identity is not None
    projection = (
        layer / ".leji" / "mounts" / "cache" / cache_key_for(identity, mount["pin"]) / "projection"
    )
    projection.mkdir(parents=True)
    (projection / "complete").write_text("", encoding="utf-8")
    result = validate_layer(str(layer))
    assert not any(f.rule == "mount-unavailable" for f in result.findings)


def test_changelog_head_not_valid_json_is_unverifiable(tmp_path) -> None:
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
    assert result.verified is False
    assert not any(f.rule == "changelog-append-only" for f in result.findings)


def _patched_mount(tmp_path: Path, label: str, **patch) -> list:
    """One field rewritten on a declared mount, and what ordinary validation then
    says about the layer."""
    layer = _copy(EXAMPLE, tmp_path / label)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    mount = {
        "name": "alpha",
        "source": "https://github.com/acme/product-context",
        "pin": "a" * 40,
        "owner": {"name": "Jo"},
        **patch,
    }
    manifest["federation"] = {"mounts": [mount]}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    return validate_layer(str(layer)).findings


def test_a_malformed_source_or_tracking_ref_is_a_manifest_error(tmp_path) -> None:
    # distribution.md calls a malformed ``source`` or ``pin`` a manifest error.
    # Ordinary validation turned an unnormalizable source into ``mount-unavailable``,
    # a warning that reads as "not hydrated here"; the schema's tracking-ref pattern
    # accepted anything under refs/heads/ or refs/tags/, including refs the resolver
    # refuses.
    bad_source = _patched_mount(tmp_path, "src", source="file:///srv/product-context")
    assert any(f.rule == "mount-source" and f.severity == "error" for f in bad_source)
    # Availability is not reported for a mount whose declaration is already a lie.
    assert not any(f.rule == "mount-unavailable" for f in bad_source)
    # Schema-legal (refs/heads/ + something), resolver-illegal (``..``, ``@{``, ``.lock``).
    for i, ref in enumerate(["refs/heads/../evil", "refs/heads/main@{1}", "refs/heads/main.lock"]):
        findings = _patched_mount(tmp_path, f"ref-{i}", trackingRef=ref)
        assert any(f.rule == "mount-tracking-ref" and f.severity == "error" for f in findings), ref
    ok = _patched_mount(tmp_path, "ref-ok", trackingRef="refs/tags/v1.0.0")
    assert not any(f.rule == "mount-tracking-ref" for f in ok)


def test_conformance_sibling_mounts_tests_the_normalized_source_it_claims(tmp_path) -> None:
    # The item said "a normalized source and a full commit pin" and tested that the
    # source was a nonempty string: a ``file://`` locator no resolver can normalize
    # passed the federated checklist.
    layer = _copy(EXAMPLE, tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["federation"] = {
        "mounts": [
            {
                "name": "alpha",
                "source": "file:///srv/product-context",
                "pin": "a" * 40,
                "owner": {"name": "Jo"},
            }
        ]
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    item = next(i for i in conformance_report(str(layer)).items if i.id == "sibling-mounts")
    assert item.status == "fail"
    assert item.detail == 'mount "alpha" declares a source that is not a normalizable locator'


def test_conformance_reports_all_four_mount_items_when_none_are_declared(tmp_path) -> None:
    # Two of the four used to be dropped, so the checklist read as though pin
    # reachability and routing metadata had simply not been considered.
    # ``not-applicable`` is not scored either way, so this changes the report, not the
    # level.
    layer = _copy(REPO_ROOT / "fixtures" / "valid-minimal-core", tmp_path)
    federated = [i for i in conformance_report(str(layer)).items if i.level == "federated"]
    assert [(i.id, i.status) for i in federated] == [
        ("consumed-externally", "manual"),
        ("stale-pin-reporting", "manual"),
        ("sibling-mounts", "not-applicable"),
        ("pin-reachable", "not-applicable"),
        ("mount-routing", "not-applicable"),
        ("mount-discovery", "not-applicable"),
    ]


# Mirrors units.test.ts "seedChangelogIfMissing treats a dangling changelog link as
# present, never seeding through it" and its out-of-repository twin.
def test_seed_changelog_treats_a_dangling_link_as_present(tmp_path: Path) -> None:
    # An existence check follows symlinks, so a dangling changelog link read as absent
    # and the seed was created at the link's missing destination. The exclusive create
    # judges the ORIGINAL entry, so any standing entry is the same no-op an existing
    # changelog is.
    from leji.changelog import seed_changelog_if_missing

    layer = _copy(FIXTURES / "valid-minimal-core", tmp_path)
    mp = layer / "leji.json"
    m = json.loads(mp.read_text(encoding="utf-8"))
    m["conformance"] = {**m.get("conformance", {}), "claimedLevel": "indexed"}
    mp.write_text(json.dumps(m, indent=2) + "\n", encoding="utf-8")
    link = layer / "docs" / "context-changelog.json"
    link.symlink_to("never-created.json")
    manifest = load_manifest(str(layer)).manifest
    assert manifest is not None

    assert seed_changelog_if_missing(str(layer), manifest) is None, (
        "a standing entry is never seeded through"
    )
    assert not (layer / "docs" / "never-created.json").exists(), (
        "the dangling link's destination is never created"
    )
    assert link.is_symlink(), "the planted link is left exactly as it was"


def test_seed_changelog_refuses_a_link_resolving_outside_the_repository(
    tmp_path: Path, tmp_path_factory: pytest.TempPathFactory
) -> None:
    from leji.changelog import seed_changelog_if_missing

    layer = _copy(FIXTURES / "valid-minimal-core", tmp_path)
    outside = tmp_path_factory.mktemp("leji-seed-outside")
    mp = layer / "leji.json"
    m = json.loads(mp.read_text(encoding="utf-8"))
    m["conformance"] = {**m.get("conformance", {}), "claimedLevel": "indexed"}
    mp.write_text(json.dumps(m, indent=2) + "\n", encoding="utf-8")
    (layer / "docs" / "context-changelog.json").symlink_to(outside / "context-changelog.json")
    manifest = load_manifest(str(layer)).manifest
    assert manifest is not None

    assert seed_changelog_if_missing(str(layer), manifest) is None, (
        "nothing seeded through a link that leaves the repository"
    )
    assert not (outside / "context-changelog.json").exists(), "nothing written outside the root"
