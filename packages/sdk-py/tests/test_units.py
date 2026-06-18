"""Unit tests mirroring packages/sdk/test/units.test.ts."""

import json
import shutil
import subprocess
from pathlib import Path

import datetime as dt

from leji import (
    check_changelog_append_only,
    check_index,
    compact_changelog,
    conformance_report,
    freshness_report,
    generate_docs,
    load_manifest,
    validate_layer,
    write_index,
)
from leji.fsx import under_path, walk_md
from leji.layer import (
    excluded_from_categories,
    scan_agent_profiles,
    scan_categories,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = REPO_ROOT / "examples" / "monorepo"
FIXTURES = REPO_ROOT / "fixtures"


def _copy(src: Path, tmp_path: Path) -> Path:
    dest = tmp_path / "layer"
    shutil.copytree(src, dest)
    return dest


def test_core_layer_index_resolves_default_path(tmp_path: Path) -> None:
    # A core layer declares no machine.indexPath; the effective path defaults to
    # rootPath + context-index.json. check_index reports the missing file (never a
    # "not declared" error), and write_index writes that default and succeeds.
    layer = _copy(FIXTURES / "valid-minimal-core", tmp_path)
    manifest = load_manifest(str(layer)).manifest
    check = check_index(str(layer), manifest)
    assert check.findings[0].rule == "index-required"
    assert (
        check.findings[0].message
        == "index docs/context-index.json does not exist; run `leji index`"
    )
    write = write_index(str(layer), manifest)
    assert [f for f in write.findings if f.severity == "error"] == []
    assert (layer / "docs" / "context-index.json").is_file()


def test_no_machine_block_agents_and_decisions_resolve_to_defaults(tmp_path: Path) -> None:
    # The fixture declares no machine block; agents/decisions resolve to the
    # spec defaults under rootPath (docs/agents/, docs/decisions/). A profile
    # dropped at the undeclared default path is scanned, contributes its
    # freshness horizon, and is excluded from category content.
    layer = _copy(FIXTURES / "valid-minimal-core", tmp_path)
    manifest = load_manifest(str(layer)).manifest
    assert manifest is not None
    assert "machine" not in manifest, "fixture has no machine block"

    agents_dir = layer / "docs" / "agents"
    agents_dir.mkdir(parents=True, exist_ok=True)
    (agents_dir / "core.md").write_text(
        "\n".join(
            [
                "---",
                "id: core",
                "name: Core",
                "role: core",
                "requiredRead:",
                "  - docs/boot-profile.md",
                "mustAskWhen:",
                "  - a proposal weakens an invariant",
                "freshness:",
                "  reviewAfter: 2020-01-01",
                "---",
                "",
                "# Core",
                "",
                "A profile under the default agents directory.",
                "",
            ]
        )
    )

    # scan_agent_profiles finds the profile at the undeclared-but-defaulted path.
    profiles = scan_agent_profiles(str(layer), manifest)
    assert any(p.rel_path == "docs/agents/core.md" and not p.findings for p in profiles), (
        "profile under docs/agents/ is scanned and valid"
    )

    # freshness includes the profile's expired horizon.
    freshness = freshness_report(str(layer), manifest)
    assert any(i["path"] == "docs/agents/core.md" for i in freshness.expired), (
        "profile freshness horizon is included"
    )

    # docs/agents/ is excluded from category content even when undeclared.
    excluded = excluded_from_categories(manifest)
    assert excluded("docs/agents/core.md") is True
    docs = scan_categories(str(layer), manifest)
    assert not any(d.rel_path == "docs/agents/core.md" for d in docs)


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
    # Name + homepage are injected as a compact JSON config blob (byte-identical
    # across SDKs: name then homepage, no spaces), not interpolated JS.
    assert '{"name":"acme-billing-context","homepage":"boot-profile.md"}' in html
    assert "stripFrontmatter" in html
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


# --- changelog compact ---

_CHANGELOG_REL = "docs/context-changelog.json"


def _seed_with_entries(tmp_path: Path, count: int) -> Path:
    """Git-committed example whose changelog carries ``count`` dated entries."""
    layer = _copy(EXAMPLE, tmp_path)
    subprocess.run(["git", "init", "-q"], cwd=layer, check=True)
    subprocess.run(["git", "config", "user.email", "t@e.com"], cwd=layer, check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=layer, check=True)
    abs_path = layer / _CHANGELOG_REL
    log = json.loads(abs_path.read_text())
    log["entries"] = [
        {
            "id": f"e-{i + 1:02d}",
            "date": f"2026-0{1 + i // 28}-{(i % 28) + 1:02d}",
            "type": "added",
            "summary": f"Change {i + 1}.",
            "paths": [f"docs/file-{i + 1}.md"],
        }
        for i in range(count)
    ]
    abs_path.write_text(json.dumps(log, indent=2) + "\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=layer, check=True)
    subprocess.run(["git", "commit", "-qm", "seed"], cwd=layer, check=True)
    return layer


def test_compact_keep_folds_oldest_appends_compaction_validates(tmp_path: Path) -> None:
    layer = _seed_with_entries(tmp_path, 10)
    manifest = load_manifest(str(layer)).manifest
    result = compact_changelog(str(layer), manifest, keep=4)
    assert [f for f in result.findings if f.severity == "error"] == []
    assert result.folded == 6
    assert result.kept == 5  # 4 survivors + 1 compaction entry

    log = json.loads((layer / _CHANGELOG_REL).read_text())
    ids = [e["id"] for e in log["entries"]]
    # Oldest six (e-01..e-06) folded; newest four (e-07..e-10) survive.
    assert ids[:4] == ["e-07", "e-08", "e-09", "e-10"]
    compaction = log["entries"][-1]
    assert compaction["type"] == "compaction"
    assert compaction["compacted"]["entries"] == 6
    assert compaction["compacted"]["firstId"] == "e-01"
    assert compaction["compacted"]["lastId"] == "e-06"
    assert compaction["paths"] == [
        "docs/file-1.md",
        "docs/file-2.md",
        "docs/file-3.md",
        "docs/file-4.md",
        "docs/file-5.md",
        "docs/file-6.md",
    ]

    # The compacted changelog passes append-only discipline against the git baseline.
    check = check_changelog_append_only(str(layer), _CHANGELOG_REL)
    assert [f for f in check.findings if f.severity == "error"] == []
    # And the whole layer still validates clean (schema + currency + discipline).
    assert not any(f.severity == "error" for f in validate_layer(str(layer)).findings)


def test_compact_before_folds_entries_before_cutoff(tmp_path: Path) -> None:
    layer = _seed_with_entries(tmp_path, 10)
    manifest = load_manifest(str(layer)).manifest
    # With 10 entries all are 2026-01; cut before 2026-01-06 folds e-01..e-05.
    result = compact_changelog(str(layer), manifest, before="2026-01-06")
    assert [f for f in result.findings if f.severity == "error"] == []
    assert result.folded == 5
    log = json.loads((layer / _CHANGELOG_REL).read_text())
    compaction = log["entries"][-1]
    assert compaction["compacted"]["firstId"] == "e-01"
    assert compaction["compacted"]["lastId"] == "e-05"
    assert not any(
        f.severity == "error"
        for f in check_changelog_append_only(str(layer), _CHANGELOG_REL).findings
    )


def test_compact_with_both_flags_folds_intersection(tmp_path: Path) -> None:
    layer = _seed_with_entries(tmp_path, 10)
    manifest = load_manifest(str(layer)).manifest
    # --keep 3 marks e-01..e-07 foldable; --before 2026-01-04 marks e-01..e-03.
    # The intersection (an entry must satisfy BOTH) is e-01..e-03.
    result = compact_changelog(str(layer), manifest, keep=3, before="2026-01-04")
    assert result.folded == 3
    log = json.loads((layer / _CHANGELOG_REL).read_text())
    compaction = log["entries"][-1]
    assert compaction["compacted"]["firstId"] == "e-01"
    assert compaction["compacted"]["lastId"] == "e-03"


def test_compact_is_a_noop_when_nothing_folds(tmp_path: Path) -> None:
    layer = _seed_with_entries(tmp_path, 5)
    manifest = load_manifest(str(layer)).manifest
    before = (layer / _CHANGELOG_REL).read_text()
    result = compact_changelog(str(layer), manifest, keep=10)  # keep more than exist
    assert result.folded == 0
    assert result.findings == []
    assert (layer / _CHANGELOG_REL).read_text() == before  # file unchanged on no-op


def test_compact_dedupes_compaction_id_when_one_exists_for_today(tmp_path: Path) -> None:
    layer = _seed_with_entries(tmp_path, 6)
    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
    abs_path = layer / _CHANGELOG_REL
    log = json.loads(abs_path.read_text())
    log["entries"][0]["id"] = f"compaction-{today}"  # collide with the picked id
    abs_path.write_text(json.dumps(log, indent=2) + "\n", encoding="utf-8")
    manifest = load_manifest(str(layer)).manifest
    result = compact_changelog(str(layer), manifest, keep=2)
    assert result.folded > 0
    after = json.loads(abs_path.read_text())
    compaction = after["entries"][-1]
    assert compaction["id"] == f"compaction-{today}-2"


def test_compact_missing_changelog_errors(tmp_path: Path) -> None:
    layer = _copy(FIXTURES / "valid-minimal-core", tmp_path)
    manifest = load_manifest(str(layer)).manifest
    result = compact_changelog(str(layer), manifest, keep=1)
    assert any(
        f.rule == "changelog-required" and "context-changelog.json does not exist" in f.message
        for f in result.findings
    )
