"""Unit tests mirroring packages/sdk/test/units.test.ts."""

import json
import shutil
import subprocess
from pathlib import Path

from leji import (
    check_changelog_append_only,
    check_index,
    conformance_report,
    generate_docs,
    load_manifest,
    validate_layer,
    write_index,
)
from leji.fsx import under_path, walk_md

REPO_ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = REPO_ROOT / "examples" / "monorepo"
FIXTURES = REPO_ROOT / "fixtures"


def _copy(src: Path, tmp_path: Path) -> Path:
    dest = tmp_path / "layer"
    shutil.copytree(src, dest)
    return dest


def test_index_commands_without_declared_path(tmp_path: Path) -> None:
    layer = _copy(FIXTURES / "valid-minimal-core", tmp_path)
    manifest = load_manifest(str(layer)).manifest
    assert check_index(str(layer), manifest).findings[0].rule == "index-required"
    assert write_index(str(layer), manifest).findings[0].rule == "index-required"


def test_corrupt_stored_index_is_artifact_parse(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    (layer / "docs" / "context-index.json").write_text("{ not json")
    manifest = load_manifest(str(layer)).manifest
    result = check_index(str(layer), manifest)
    assert result.stale is True
    assert result.findings[0].rule == "artifact-parse"


def test_corrupt_changelog_is_artifact_parse(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    (layer / "docs" / "context-changelog.json").write_text("{ not json")
    result = check_changelog_append_only(str(layer), "docs/context-changelog.json")
    assert result.verified is False
    assert result.findings[0].rule == "artifact-parse"


def test_changelog_entry_removal_violates_append_only(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    subprocess.run(["git", "init", "-q"], cwd=layer, check=True)
    subprocess.run(["git", "config", "user.email", "t@e.com"], cwd=layer, check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=layer, check=True)
    subprocess.run(["git", "add", "-A"], cwd=layer, check=True)
    subprocess.run(["git", "commit", "-qm", "seed"], cwd=layer, check=True)
    rel = "docs/context-changelog.json"
    changelog = json.loads((layer / rel).read_text())
    changelog["entries"].pop()
    (layer / rel).write_text(json.dumps(changelog, indent=2) + "\n")
    result = check_changelog_append_only(str(layer), rel)
    assert any(
        f.rule == "changelog-append-only" and "removed" in f.message for f in result.findings
    )


def test_duplicate_profile_ids_and_unknown_inherits(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    (layer / "docs" / "agents" / "extra.md").write_text(
        "---\nid: core\nname: Extra\nrole: extra\ninherits: ghost\n"
        "requiredRead:\n  - docs/boot-profile.md\nmustAskWhen:\n  - always\n---\n\n# Extra\n"
    )
    result = validate_layer(str(layer))
    assert any(f.rule == "id-duplicate" for f in result.findings)
    assert any(f.rule == "inherits-unknown" and f.severity == "warning" for f in result.findings)


def test_invalid_frontmatter_id_is_id_pattern(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    (layer / "docs" / "domain" / "extra.md").write_text("---\nid: Bad_ID\n---\n\n# Extra Doc\n")
    manifest = load_manifest(str(layer)).manifest
    result = write_index(str(layer), manifest)
    assert any(f.rule == "id-pattern" for f in result.findings)


def test_slug_collisions_de_collide_with_parent(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    (layer / "docs" / "domain" / "payments").mkdir(parents=True)
    (layer / "docs" / "domain" / "payments" / "glossary.md").write_text("# Payments Glossary\n")
    manifest = load_manifest(str(layer)).manifest
    result = write_index(str(layer), manifest)
    ids = [e["id"] for e in result.index["entries"]]
    assert len(set(ids)) == len(ids)
    assert "payments-glossary" in ids


def test_category_path_may_declare_single_file(tmp_path: Path) -> None:
    layer = _copy(FIXTURES / "valid-minimal-core", tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["categories"]["system"] = {"paths": ["docs/system-notes.md"]}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    (layer / "docs" / "system-notes.md").write_text("# System Notes\n")
    result = validate_layer(str(layer))
    assert [f for f in result.findings if f.severity == "error"] == []


def test_declared_vendor_adapter_that_redirects_passes(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["vendorAdapters"] = ["CLAUDE.md"]
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    (layer / "CLAUDE.md").write_text("Read docs/boot-profile.md and follow it.\n")
    result = validate_layer(str(layer))
    assert [f for f in result.findings if f.severity == "error"] == []


def test_fsx_helpers() -> None:
    assert walk_md(str(EXAMPLE), "docs/domain/glossary.md") == ["docs/domain/glossary.md"]
    assert walk_md(str(EXAMPLE), "leji.json") == []
    assert walk_md(str(EXAMPLE), "docs/nonexistent/") == []
    assert under_path("docs/domain/x.md", "docs/") is True
    assert under_path("docs", "docs/") is True
    assert under_path("docsx/y.md", "docs/") is False


def test_audit_path_traversal_rejected_by_schema(tmp_path: Path) -> None:
    layer = _copy(FIXTURES / "valid-minimal-core", tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["machine"] = {"indexPath": "../escape-index.json"}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    result = validate_layer(str(layer))
    assert any(f.rule == "manifest-schema" for f in result.findings)


def test_audit_malformed_changelog_entries_no_crash(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    (layer / "docs" / "context-changelog.json").write_text(
        '{ "schemaVersion": "1.0", "entries": {} }\n'
    )
    result = validate_layer(str(layer))
    assert any(f.rule == "artifact-schema" for f in result.findings)


def test_audit_decisions_in_second_mapped_path_found(tmp_path: Path) -> None:
    layer = _copy(FIXTURES / "valid-minimal-core", tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["categories"]["decisions"]["paths"] = ["docs/adr/", "docs/decisions/"]
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    (layer / "docs" / "adr").mkdir()
    (layer / "docs" / "adr" / "note.md").write_text("# Note\n\nNot a decision record.\n")
    result = validate_layer(str(layer))
    assert any(f.rule == "decision-frontmatter" for f in result.findings)
    assert not any(f.rule == "decisions-empty" for f in result.findings)


def test_audit_agents_map_target_outside_profiles_dir(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["agents"]["reviewer"] = "docs/reviewer.md"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    (layer / "docs" / "reviewer.md").write_text("# Reviewer\n\nNo frontmatter.\n")
    result = validate_layer(str(layer))
    assert any(
        f.rule == "profile-frontmatter" and f.path == "docs/reviewer.md" for f in result.findings
    )


def test_audit_index_check_rejects_unsupported_schema_version(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest
    write_index(str(layer), manifest)
    rel = layer / "docs" / "context-index.json"
    index = json.loads(rel.read_text())
    index["schemaVersion"] = "2.0"
    rel.write_text(json.dumps(index, indent=2) + "\n")
    result = check_index(str(layer), manifest)
    assert result.stale is True
    assert any(f.rule == "schema-version" for f in result.findings)


def test_audit_reordered_changelog_keys_not_violation(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    subprocess.run(["git", "init", "-q"], cwd=layer, check=True)
    subprocess.run(["git", "config", "user.email", "t@e.com"], cwd=layer, check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=layer, check=True)
    subprocess.run(["git", "add", "-A"], cwd=layer, check=True)
    subprocess.run(["git", "commit", "-qm", "seed"], cwd=layer, check=True)
    rel = layer / "docs" / "context-changelog.json"
    changelog = json.loads(rel.read_text())
    changelog["entries"][0] = dict(reversed(list(changelog["entries"][0].items())))
    rel.write_text(json.dumps(changelog, indent=2) + "\n")
    result = check_changelog_append_only(str(layer), "docs/context-changelog.json")
    assert not any(f.rule == "changelog-append-only" for f in result.findings)


def test_audit_empty_root_path_no_bogus_warnings(tmp_path: Path) -> None:
    layer = _copy(FIXTURES / "valid-minimal-core", tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["rootPath"] = ""
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    result = validate_layer(str(layer))
    assert not any(f.rule == "paths-outside-root" for f in result.findings)


def test_quality_generated_index_content_exact(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest
    result = write_index(str(layer), manifest)
    entries = [
        {k: v for k, v in e.items() if k not in ("lastModified", "contentHash")}
        for e in result.index["entries"]
    ]
    assert entries == [
        {
            "id": "adopt-leji",
            "path": "docs/decisions/0001-adopt-leji.md",
            "title": "Adopt the Leji context layer",
            "category": "decisions",
        },
        {
            "id": "glossary",
            "path": "docs/domain/glossary.md",
            "title": "Glossary",
            "category": "domain",
            "summary": "What invoice, credit note, and settlement mean at Acme.",
        },
        {
            "id": "system-invariants",
            "path": "docs/system/invariants.md",
            "title": "System Invariants",
            "category": "system",
            "summary": "Money handling, ledger append-only rule, service boundaries.",
            "freshness": {"reviewAfter": "2026-12-10"},
        },
    ]
    assert result.index["schemaVersion"] == "1.0"
    assert result.index["rootPath"] == "docs/"
    import re as _re

    for entry in result.index["entries"]:
        assert _re.fullmatch(r"sha256:[0-9a-f]{16}", entry["contentHash"])


def test_quality_duplicate_decision_ids_reported(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    (layer / "docs" / "decisions" / "0002-duplicate.md").write_text(
        "---\nid: adopt-leji\ntitle: Duplicate\nstatus: accepted\ndate: 2026-06-12\n---\n\n# Duplicate\n",
        encoding="utf-8",
    )
    result = validate_layer(str(layer))
    assert any(
        f.rule == "id-duplicate" and f.path == "docs/decisions/0002-duplicate.md"
        for f in result.findings
    )


def test_quality_duplicate_frontmatter_ids_across_index_docs(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    (layer / "docs" / "domain" / "extra.md").write_text(
        "---\nid: glossary\n---\n\n# Extra\n", encoding="utf-8"
    )
    manifest = load_manifest(str(layer)).manifest
    result = write_index(str(layer), manifest)
    assert any(f.rule == "id-duplicate" for f in result.findings)


def test_quality_governed_layer_verifies_governed(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["conformance"]["claimedLevel"] = "governed"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    write_index(str(layer), manifest)
    result = conformance_report(str(layer))
    assert result.verified_level == "governed"
    assert result.findings == []
    manual = [i.id for i in result.items if i.status == "manual"]
    assert "review-gate" in manual and "ci-validates" in manual


def test_quality_federated_missing_mount_fails(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["conformance"]["claimedLevel"] = "federated"
    manifest["federation"] = {
        "mounts": [{"path": "context/product", "name": "product", "owner": {"name": "Jo"}}]
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    write_index(str(layer), manifest)
    result = conformance_report(str(layer))
    item = next(i for i in result.items if i.id == "sibling-mounts")
    assert item.status == "fail"
    assert any(f.rule == "conformance-claim" for f in result.findings)


def test_quality_duplicate_yaml_keys_invalid(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    (layer / "docs" / "agents" / "dup.md").write_text(
        "---\nid: dup\nid: dup2\nname: D\nrole: d\nrequiredRead:\n  - docs/boot-profile.md\nmustAskWhen:\n  - always\n---\n\n# D\n",
        encoding="utf-8",
    )
    result = validate_layer(str(layer))
    assert any(
        f.rule == "profile-frontmatter" and f.path == "docs/agents/dup.md" for f in result.findings
    )


def _git_seed_example(tmp_path: Path) -> Path:
    layer = _copy(EXAMPLE, tmp_path)
    subprocess.run(["git", "init", "-q"], cwd=layer, check=True)
    subprocess.run(["git", "config", "user.email", "t@e.com"], cwd=layer, check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=layer, check=True)
    subprocess.run(["git", "add", "-A"], cwd=layer, check=True)
    subprocess.run(["git", "commit", "-qm", "seed"], cwd=layer, check=True)
    return layer


def test_compaction_with_marker_passes(tmp_path: Path) -> None:
    layer = _git_seed_example(tmp_path)
    rel = layer / "docs" / "context-changelog.json"
    changelog = json.loads(rel.read_text())
    dropped = changelog["entries"].pop(0)
    changelog["entries"].append(
        {
            "id": "compact-2026-06",
            "date": "2026-06-12",
            "type": "compaction",
            "summary": "Compacted the oldest entry; full record in git history.",
            "paths": ["docs/context-changelog.json"],
            "compacted": {"entries": 1, "firstId": dropped["id"], "lastId": dropped["id"]},
        }
    )
    rel.write_text(json.dumps(changelog, indent=2) + "\n", encoding="utf-8")
    result = check_changelog_append_only(str(layer), "docs/context-changelog.json")
    assert [f for f in result.findings if f.severity == "error"] == []
    assert result.verified is True


def test_compaction_without_marker_fails(tmp_path: Path) -> None:
    layer = _git_seed_example(tmp_path)
    rel = layer / "docs" / "context-changelog.json"
    changelog = json.loads(rel.read_text())
    changelog["entries"].pop(0)
    rel.write_text(json.dumps(changelog, indent=2) + "\n", encoding="utf-8")
    result = check_changelog_append_only(str(layer), "docs/context-changelog.json")
    assert any(
        f.rule == "changelog-append-only" and "without a compaction entry" in f.message
        for f in result.findings
    )


def test_compaction_to_empty_fails(tmp_path: Path) -> None:
    layer = _git_seed_example(tmp_path)
    rel = layer / "docs" / "context-changelog.json"
    changelog = json.loads(rel.read_text())
    changelog["entries"] = []
    rel.write_text(json.dumps(changelog, indent=2) + "\n", encoding="utf-8")
    result = check_changelog_append_only(str(layer), "docs/context-changelog.json")
    assert any(
        f.rule == "changelog-append-only" and "compacted to empty" in f.message
        for f in result.findings
    )


def test_changelog_array_reordering_not_violation(tmp_path: Path) -> None:
    # Discipline is id-keyed by canonical (date, id) order, not array position:
    # reversing the entries array is not an append-only violation.
    layer = _git_seed_example(tmp_path)
    rel = layer / "docs" / "context-changelog.json"
    changelog = json.loads(rel.read_text())
    changelog["entries"] = list(reversed(changelog["entries"]))
    rel.write_text(json.dumps(changelog, indent=2) + "\n", encoding="utf-8")
    result = check_changelog_append_only(str(layer), "docs/context-changelog.json")
    assert not any(f.rule == "changelog-append-only" for f in result.findings)
    assert result.verified is True


def test_changelog_remove_newest_entry_fails(tmp_path: Path) -> None:
    # Removing a non-oldest (newest) entry is forbidden even if a compaction
    # marker is present: only the oldest end may be compacted.
    layer = _git_seed_example(tmp_path)
    rel = layer / "docs" / "context-changelog.json"
    changelog = json.loads(rel.read_text())
    # Drop the newest entry (thought-partner-profile, 2026-06-12), keep oldest.
    changelog["entries"] = [e for e in changelog["entries"] if e["id"] == "seed-layer"]
    rel.write_text(json.dumps(changelog, indent=2) + "\n", encoding="utf-8")
    result = check_changelog_append_only(str(layer), "docs/context-changelog.json")
    assert any(
        f.rule == "changelog-append-only" and "other than the oldest end" in f.message
        for f in result.findings
    )


def test_changelog_modifying_surviving_entry_fails(tmp_path: Path) -> None:
    layer = _git_seed_example(tmp_path)
    rel = layer / "docs" / "context-changelog.json"
    changelog = json.loads(rel.read_text())
    changelog["entries"][0]["summary"] = "Mutated summary after HEAD."
    rel.write_text(json.dumps(changelog, indent=2) + "\n", encoding="utf-8")
    result = check_changelog_append_only(str(layer), "docs/context-changelog.json")
    assert any(
        f.rule == "changelog-append-only" and "surviving entries are immutable" in f.message
        for f in result.findings
    )


def test_docs_generates_viewer_and_sidebar(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest
    result = generate_docs(str(layer), manifest)
    assert result.written == [
        "docs/index.html",
        "docs/_sidebar.md",
        "docs/docs-viewer-assets/docsify-sidebar-collapse.min.css",
        "docs/docs-viewer-assets/docsify-sidebar-collapse.min.js",
        "docs/docs-viewer-assets/docsify.min.js",
        "docs/docs-viewer-assets/search.min.js",
        "docs/docs-viewer-assets/vue.css",
    ]
    html = (layer / "docs" / "index.html").read_text()
    # Name + homepage are injected as a JSON config blob, not interpolated JS.
    assert '"name": "acme-billing-context"' in html
    assert "stripFrontmatter" in html
    assert '"homepage": "boot-profile.md"' in html
    # Vendored assets (core + theme + search/collapse plugins) are copied locally;
    # no remote CDN, PROVENANCE not shipped.
    assert (layer / "docs" / "docs-viewer-assets" / "docsify.min.js").is_file()
    assert (layer / "docs" / "docs-viewer-assets" / "vue.css").is_file()
    assert (layer / "docs" / "docs-viewer-assets" / "search.min.js").is_file()
    assert (layer / "docs" / "docs-viewer-assets" / "docsify-sidebar-collapse.min.js").is_file()
    assert not (layer / "docs" / "docs-viewer-assets" / "PROVENANCE.txt").exists()
    sidebar = (layer / "docs" / "_sidebar.md").read_text()
    assert sidebar == "\n".join(
        [
            "- [Boot profile](boot-profile.md)",
            "",
            "---",
            "",
            "- Domain",
            "  - [Glossary](domain/glossary.md)",
            "- System",
            "  - [System Invariants](system/invariants.md)",
            "- Decisions",
            "  - [Adopt the Leji context layer](decisions/0001-adopt-leji.md)",
            "",
        ]
    )
    generate_docs(str(layer), manifest)
    assert (layer / "docs" / "_sidebar.md").read_text() == sidebar


def test_docs_after_init(tmp_path: Path) -> None:
    from leji import init_layer

    init_layer(str(tmp_path), yes=True, name="demo-context")
    manifest = load_manifest(str(tmp_path)).manifest
    result = generate_docs(str(tmp_path), manifest)
    assert result.entries == 3
    assert (tmp_path / "docs" / "index.html").is_file()


def test_docs_serve_localhost(tmp_path: Path) -> None:
    import threading
    import urllib.request

    from leji import serve_docs

    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest
    generate_docs(str(layer), manifest)
    server = serve_docs(str(layer), 0)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/docs/") as page:
            assert page.status == 200
            assert b"stripFrontmatter" in page.read()
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/docs/domain/glossary.md") as md:
            assert md.status == 200
    finally:
        server.shutdown()


def test_docs_port_precedence(tmp_path: Path) -> None:
    from leji import resolve_docs_port

    base = json.loads((EXAMPLE / "leji.json").read_text())
    assert resolve_docs_port(base) == 5354
    assert resolve_docs_port({**base, "docs": {"port": 21300}}) == 21300
    assert resolve_docs_port({**base, "docs": {"port": 21300}}, 4000) == 4000
    assert resolve_docs_port({**base, "docs": {"port": 21300}}, 0) == 0


def test_docs_block_in_manifest_validates(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["docs"] = {"port": 21300}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    result = validate_layer(str(layer))
    assert [f for f in result.findings if f.severity == "error"] == []
