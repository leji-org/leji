"""Unit tests mirroring packages/sdk/test/units.test.ts."""

import json
import shutil
import subprocess
from pathlib import Path

import datetime as dt

from leji import (
    RouteInput,
    check_changelog_append_only,
    check_index,
    compact_changelog,
    conformance_report,
    freshness_report,
    generate_viewer,
    load_manifest,
    route,
    status_report,
    validate_layer,
    write_index,
)
from leji.fsx import under_path, walk_md
from leji.manifest import bind_agent_in_manifest_text
from leji.layer import (
    excluded_from_categories,
    scan_agent_profiles,
    scan_categories,
)
from leji.route import RoutedRecord
from leji.status import ShadowedSelector

REPO_ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = REPO_ROOT / "examples" / "monorepo"
FIXTURES = REPO_ROOT / "fixtures"


def _copy(src: Path, tmp_path: Path) -> Path:
    dest = tmp_path / "layer"
    # Copy only git-tracked files so a polluted working tree (a local `leji
    # viewer`/`init` run leaving generated .leji/ output or a seeded root
    # overview.md) cannot leak into fixtures. Mirrors a clean checkout.
    tracked = subprocess.run(
        ["git", "ls-files", "-z"], cwd=src, capture_output=True, text=True, check=True
    ).stdout.split("\0")
    for rel in filter(None, tracked):
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src / rel, target)
    # Conformance evaluates the directory it is given, so a layer outside a git
    # repository fails core's git requirement. Any test asserting a verified level
    # has to run somewhere git can answer.
    for args in (
        ["init", "-q"],
        ["config", "user.email", "test@example.com"],
        ["config", "user.name", "Test"],
    ):
        subprocess.run(["git", *args], cwd=str(dest), check=True)
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
    docs = scan_categories(str(layer), manifest).docs
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
    assert any(f.rule == "inherits-unknown" and f.severity == "error" for f in result.findings)


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


def test_category_index_entry_may_be_single_file(tmp_path: Path) -> None:
    layer = _copy(FIXTURES / "valid-minimal-core", tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["categories"]["system"] = {"indexes": ["docs/context/system.md"]}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    (layer / "docs" / "context").mkdir(parents=True, exist_ok=True)
    (layer / "docs" / "context" / "system.md").write_text(
        "# System\n\n```leji-index\n- path: docs/system-notes.md\n```\n"
    )
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
    # List a second decisions location in the decisions index file.
    (layer / "docs" / "context" / "decisions.md").write_text(
        "# Decisions\n\n```leji-index\n- path: docs/adr/\n- path: docs/decisions/\n```\n"
    )
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
            "kind": "record",
            "date": "2026-06-10",
        },
        {
            "id": "glossary",
            "path": "docs/domain/glossary.md",
            "title": "Glossary",
            "category": "domain",
            "kind": "intent",
            "summary": "What invoice, credit note, and settlement mean at Acme.",
        },
        {
            "id": "system-invariants",
            "path": "docs/system/invariants.md",
            "title": "System Invariants",
            "category": "system",
            "kind": "intent",
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
    # A committed baseline: append-only discipline compares against HEAD, so an
    # uncommitted tree correctly reports unverified rather than passing.
    for args in (["add", "-A"], ["commit", "-qm", "baseline"]):
        subprocess.run(["git", *args], cwd=str(layer), check=True)
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


def test_quality_pinned_unhydrated_mount_passes_sibling_mounts(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["conformance"]["claimedLevel"] = "federated"
    manifest["federation"] = {
        "mounts": [
            {
                "name": "product",
                "source": "https://github.com/acme/product-context",
                "pin": "a" * 40,
                "owner": {"name": "Jo"},
                "categories": ["domain"],
                "topics": ["billing"],
            }
        ]
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    write_index(str(layer), manifest)
    result = conformance_report(str(layer))
    # Declaration completeness passes; the mount being unhydrated here is honest
    # degraded availability (a validate warning), never a failed federated claim.
    assert next(i for i in result.items if i.id == "sibling-mounts").status == "pass"
    assert next(i for i in result.items if i.id == "mount-routing").status == "pass"
    validation = validate_layer(str(layer))
    assert any(
        f.rule == "mount-unavailable" and f.severity == "warning" for f in validation.findings
    )


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


def test_viewer_generates_viewer_and_sidebar(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest
    result = generate_viewer(str(layer), manifest)
    assert result.written == [
        "docs/.leji/viewer/index.html",
        "docs/.leji/viewer/_sidebar.md",
        "docs/.leji/viewer/assets/docsify-copy-code.min.js",
        "docs/.leji/viewer/assets/docsify-mermaid.js",
        "docs/.leji/viewer/assets/docsify-sidebar-collapse.min.css",
        "docs/.leji/viewer/assets/docsify-sidebar-collapse.min.js",
        "docs/.leji/viewer/assets/docsify.min.js",
        "docs/.leji/viewer/assets/fonts-licenses.txt",
        "docs/.leji/viewer/assets/leji-logo.svg",
        "docs/.leji/viewer/assets/mermaid.min.js",
        "docs/.leji/viewer/assets/prism-bash.min.js",
        "docs/.leji/viewer/assets/prism-json.min.js",
        "docs/.leji/viewer/assets/prism-markdown.min.js",
        "docs/.leji/viewer/assets/prism-typescript.min.js",
        "docs/.leji/viewer/assets/roboto-mono-400-latin-ext.woff2",
        "docs/.leji/viewer/assets/roboto-mono-400-latin.woff2",
        "docs/.leji/viewer/assets/roboto-mono-400-vietnamese.woff2",
        "docs/.leji/viewer/assets/search.min.js",
        "docs/.leji/viewer/assets/source-sans-pro-300-latin-ext.woff2",
        "docs/.leji/viewer/assets/source-sans-pro-300-latin.woff2",
        "docs/.leji/viewer/assets/source-sans-pro-300-vietnamese.woff2",
        "docs/.leji/viewer/assets/source-sans-pro-400-latin-ext.woff2",
        "docs/.leji/viewer/assets/source-sans-pro-400-latin.woff2",
        "docs/.leji/viewer/assets/source-sans-pro-400-vietnamese.woff2",
        "docs/.leji/viewer/assets/source-sans-pro-600-latin-ext.woff2",
        "docs/.leji/viewer/assets/source-sans-pro-600-latin.woff2",
        "docs/.leji/viewer/assets/source-sans-pro-600-vietnamese.woff2",
        "docs/.leji/viewer/assets/viewer-boot.js",
        "docs/.leji/viewer/assets/vue.css",
        "docs/.leji/viewer/assets/zoom-image.min.js",
        "docs/overview.md",
        "docs/.leji/viewer/_manifest.md",
    ]
    viewer = layer / "docs" / ".leji" / "viewer"
    html = (viewer / "index.html").read_text()
    # The layer name is baked into the JSON config and the document title.
    assert "acme-billing-context" in html
    assert "<title>acme-billing-context</title>" in html
    assert '"homepage":"overview.md"' in html
    # Default theming: the Leji mark (in the name HTML, served relative to the page
    # so basePath does not break it) and the brand blue.
    assert "/assets/leji-logo.svg" in html
    assert '"themeColor":"#223F93"' in html
    assert (viewer / "assets" / "leji-logo.svg").is_file()
    # Mermaid is on by default: the two scripts + their assets are present.
    assert "assets/mermaid.min.js" in html
    assert "assets/docsify-mermaid.js" in html
    assert (viewer / "assets" / "mermaid.min.js").is_file()
    # The frontmatter hook moved to a vendored boot script; index.html references
    # it, and the copied boot.js carries the stripFrontmatter hook + content mount.
    assert "viewer-boot.js" in html
    boot_js = (viewer / "assets" / "viewer-boot.js").read_text()
    assert "stripFrontmatter" in boot_js
    assert "basePath: '/content/'" in boot_js
    # Vendored assets (core + theme + search/collapse plugins) are copied locally;
    # no remote CDN, PROVENANCE not shipped.
    assert (viewer / "assets" / "docsify.min.js").is_file()
    assert (viewer / "assets" / "vue.css").is_file()
    assert (viewer / "assets" / "search.min.js").is_file()
    assert (viewer / "assets" / "docsify-sidebar-collapse.min.js").is_file()
    assert not (viewer / "assets" / "PROVENANCE.txt").exists()
    sidebar = (viewer / "_sidebar.md").read_text()
    assert sidebar == "\n".join(
        [
            "- [🤖 Boot profile](boot-profile.md)",
            "- [📄 Manifest](_manifest.md)",
            "",
            "---",
            "",
            "- **🤖 Agents**",
            "  - [Agent Core](agents/core.md)",
            "  - [Thought Partner (Codex)](agents/thought-partner.md)",
            "- **📖 Domain**",
            "  - [Glossary](domain/glossary.md)",
            "- **⚙️ System**",
            "  - [Invariants](system/invariants.md)",
            "- **🧭 Decisions**",
            "  - [Adopt the Leji context layer](decisions/0001-adopt-leji.md)",
            "",
        ]
    )
    generate_viewer(str(layer), manifest)
    assert (viewer / "_sidebar.md").read_text() == sidebar


def test_viewer_brand_config(tmp_path: Path) -> None:
    # Brand config (logo, primary color, title, favicon, pins) flows into the viewer.
    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest
    manifest["viewer"] = {
        "logo": "assets/brand.svg",
        "theme": {"primary": "#FF6600"},
        "title": "Acme Billing",
        "favicon": "assets/icon.svg",
        "pins": ["docs/domain/glossary.md", "docs/nope.md"],
    }
    result = generate_viewer(str(layer), manifest)
    viewer = layer / "docs" / ".leji" / "viewer"
    html = (viewer / "index.html").read_text()
    # A relative logo path is served from the content mount; absolute/url is used as-is.
    assert "/content/assets/brand.svg" in html
    assert '"themeColor":"#FF6600"' in html
    # viewer.title drives the page title; the favicon resolves under /content/.
    assert "<title>Acme Billing</title>" in html
    assert 'href="/content/assets/icon.svg"' in html
    sidebar = (viewer / "_sidebar.md").read_text()
    top = sidebar.split("---")[0]
    # The pinned page renders in the top zone.
    assert "- [Glossary](domain/glossary.md)" in top
    # A missing pin is surfaced, not silently dropped.
    assert any(f.rule == "viewer-pin-missing" and f.path == "docs/nope.md" for f in result.findings)


def test_viewer_path_forms_and_missing_homepage_warns(tmp_path: Path) -> None:
    # Homepage, favicon, and pins accept repo-relative and root-relative forms.
    layer = _copy(EXAMPLE, tmp_path)
    (layer / "docs" / "HOME.md").write_text("# Home\n")
    manifest = load_manifest(str(layer)).manifest
    manifest["viewer"] = {
        "mermaid": False,
        "homepage": "docs/HOME.md",  # repo-relative: normalized to HOME.md
        "favicon": "docs/HOME.md",  # repo-relative: content URL must not double the root
        "pins": ["domain/glossary.md"],  # rootPath-relative pin (canonical form is repo-relative)
    }
    result = generate_viewer(str(layer), manifest)
    assert not any(f.rule == "viewer-path-missing" for f in result.findings)
    html = (layer / "docs" / ".leji" / "viewer" / "index.html").read_text()
    assert '"homepage":"HOME.md"' in html
    assert "/content/HOME.md" in html
    sidebar = (layer / "docs" / ".leji" / "viewer" / "_sidebar.md").read_text()
    assert "](domain/glossary.md)" in sidebar.split("---")[0]
    # An unresolvable homepage is kept as authored and warned about, never silent.
    manifest["viewer"] = {"mermaid": False, "homepage": "docs/NOPE.md"}
    bad = generate_viewer(str(layer), manifest)
    assert any(f.rule == "viewer-path-missing" for f in bad.findings)


def test_viewer_boot_pin_replaces_default_line(tmp_path: Path) -> None:
    # Pinning the boot profile replaces its default sidebar line with the pin's
    # own label and position (the team's to curate).
    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest
    manifest["viewer"] = {
        "mermaid": False,
        "pins": [{"path": "docs/boot-profile.md", "label": "🚀 Start here"}],
    }
    generate_viewer(str(layer), manifest)
    sidebar = (layer / "docs" / ".leji" / "viewer" / "_sidebar.md").read_text()
    assert "🤖 Boot profile" not in sidebar
    assert "- [🚀 Start here](boot-profile.md)" in sidebar


def test_viewer_build_sidebar_skips_out_of_root_boot_and_renders_plain_entries(
    tmp_path: Path,
) -> None:
    from leji.viewer_cmd import SidebarEntry, SidebarGroup, build_sidebar

    base = json.loads((EXAMPLE / "leji.json").read_text())
    # Boot profile outside rootPath: _relative_to_root returns None, so no boot line.
    manifest = {**base, "bootProfilePath": "README.md", "rootPath": "docs/"}
    sidebar = build_sidebar(
        manifest,
        [
            SidebarGroup(
                label="💰 Finance",
                entries=[
                    SidebarEntry(rel="domain/glossary.md", title="Glossary"),
                    SidebarEntry(rel="records/status.md", title="Status"),
                ],
            ),
            SidebarGroup(label="Empty group", entries=[]),
        ],
    )
    assert "Boot profile" not in sidebar
    # The group label is the index-file H1, verbatim, bold; entries render as
    # plain links.
    assert "- **💰 Finance**" in sidebar
    assert "  - [Glossary](domain/glossary.md)" in sidebar
    # No record badges in the sidebar: kind and date are page-chip metadata now.
    assert "lj-rec" not in sidebar
    assert "Empty group" not in sidebar


def test_viewer_seeds_overview_with_layer_map(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest
    generate_viewer(str(layer), manifest)
    overview = layer / "docs" / "overview.md"
    assert overview.is_file()
    text = overview.read_text()
    assert "# acme-billing-context" in text
    assert "<!-- leji:generated-map:start -->" in text
    assert "```mermaid\nflowchart LR" in text
    assert "boot --> cat_domain" in text
    # Categories carry counts, never per-doc nodes (unreadable at scale).
    assert 'cat_domain["📖 Domain · 1 doc"]' in text
    assert "n_glossary" not in text


def test_viewer_overview_seeded_once(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest
    generate_viewer(str(layer), manifest)
    overview = layer / "docs" / "overview.md"
    edited = (
        "# My own title\n\nHand-written intro.\n\n"
        "<!-- leji:generated-map:start -->\nstale\n<!-- leji:generated-map:end -->\n\n"
        "More prose.\n"
    )
    overview.write_text(edited)
    result = generate_viewer(str(layer), manifest)
    after = overview.read_text()
    assert "# My own title" in after
    assert "More prose." in after
    assert "```mermaid\nflowchart LR" in after
    assert "\nstale\n" not in after
    assert not any(f.rule == "overview-markers-missing" for f in result.findings)


def test_viewer_overview_without_markers_warns(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest
    generate_viewer(str(layer), manifest)
    overview = layer / "docs" / "overview.md"
    custom = "# Fully custom\n\nNo markers here at all.\n"
    overview.write_text(custom)
    result = generate_viewer(str(layer), manifest)
    assert overview.read_text() == custom
    assert any(
        f.rule == "overview-markers-missing" and f.severity == "warning" for f in result.findings
    )


def test_viewer_mermaid_disabled(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest
    manifest["viewer"] = {"mermaid": False}
    result = generate_viewer(str(layer), manifest)
    viewer = layer / "docs" / ".leji" / "viewer"
    html = (viewer / "index.html").read_text()
    assert "mermaid.min.js" not in html
    assert "docsify-mermaid.js" not in html
    assert not (viewer / "assets" / "mermaid.min.js").exists()
    assert not any("mermaid" in w for w in result.written)
    # The non-mermaid polish plugins still ship.
    assert "docsify-copy-code.min.js" in html


def test_viewer_after_init(tmp_path: Path) -> None:
    from leji import init_layer

    init_layer(str(tmp_path), yes=True, name="demo-context")
    manifest = load_manifest(str(tmp_path)).manifest
    result = generate_viewer(str(tmp_path), manifest)
    assert result.entries == 3
    assert (tmp_path / "docs" / ".leji" / "viewer" / "index.html").is_file()


def test_viewer_serve_localhost(tmp_path: Path) -> None:
    import threading
    import urllib.error
    import urllib.request

    from leji import serve_viewer

    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest
    generate_viewer(str(layer), manifest)
    server = serve_viewer(str(layer), 0, manifest["rootPath"])
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def status(path: str) -> int:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}") as resp:
                return resp.status
        except urllib.error.HTTPError as err:
            return err.code

    try:
        # The viewer chrome is served at the web root, no redirect needed.
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/") as page:
            assert page.status == 200
            assert b"viewer-boot.js" in page.read()
        # Viewer assets are served from the root.
        assert status("/assets/docsify.min.js") == 200
        # The layer's markdown is mounted under /content/.
        assert status("/content/domain/glossary.md") == 200
        # The generated sidebar is served as if at the content root.
        assert status("/content/_sidebar.md") == 200
        # The internal .leji path is not reachable by a direct URL.
        assert status("/content/.leji/viewer/index.html") == 404
        # Path traversal is refused.
        assert status("/..%2f..%2fetc%2fpasswd") != 200
    finally:
        server.shutdown()


def test_viewer_build_refuses_out_inside_the_context_root(tmp_path: Path) -> None:
    """The reported reproduction: exporting into a governed directory used to rm -rf
    it and then recurse into its own output until the paths grew too long."""
    import pytest

    from leji import build_viewer

    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest
    glossary = layer / "docs" / "domain" / "glossary.md"
    before = glossary.read_text()
    for bad in ("docs/domain", "docs", "."):
        with pytest.raises(RuntimeError, match="refusing to build the viewer"):
            build_viewer(str(layer), manifest, bad)
    assert glossary.read_text() == before, "governed content survives the refusal"


def test_viewer_build_clears_only_its_own_export(tmp_path: Path) -> None:
    """A previous export is recognized by its own marker comment and rebuilt clean;
    any other occupied directory is somebody's content and is refused."""
    import pytest

    from leji import build_viewer

    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest
    build_viewer(str(layer), manifest, "out")
    stale = layer / "out" / "stale.txt"
    stale.write_text("from the previous export")
    build_viewer(str(layer), manifest, "out")
    assert not stale.exists(), "a previous export is rebuilt clean"

    occupied = layer / "notes"
    occupied.mkdir()
    keep = occupied / "keep.md"
    keep.write_text("# keep")
    with pytest.raises(RuntimeError, match="neither empty nor a previous viewer export"):
        build_viewer(str(layer), manifest, "notes")
    assert keep.exists(), "the occupied target is untouched"

    (layer / "empty").mkdir()
    build_viewer(str(layer), manifest, "empty")  # an empty directory is a fine target


def test_viewer_build_excludes_active_content_types(tmp_path: Path) -> None:
    """A static host would serve exported HTML/SVG as same-origin documents, so the
    export leaves them out. The viewer's own vendored chrome is unaffected."""
    from leji import build_viewer

    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest
    (layer / "docs" / "evil.html").write_text("<script>alert(1)</script>")
    (layer / "docs" / "evil.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    build_viewer(str(layer), manifest, "out")
    out = layer / "out"
    assert not (out / "content" / "evil.html").exists()
    # SVG stays a first-class asset: viewer.logo/viewer.favicon may point at one
    # under the context root, and an SVG in an <img> never executes script.
    assert (out / "content" / "evil.svg").is_file()
    assert (out / "assets" / "docsify.min.js").is_file()
    # Only the prepended warning comment, not the page below it (whose favicon link
    # legitimately names the vendored leji-logo.svg).
    warning = (out / "index.html").read_text().split("-->")[0]
    assert "Active file types" in warning
    assert ".svg" not in warning, "the warning must not claim SVG is excluded"


def test_viewer_hostile_manifest_cannot_break_out_of_its_substitution_site(
    tmp_path: Path,
) -> None:
    """Both values name other placeholders: with sequential substitution passes they
    were expanded a second time, injecting a literal </script> into the JSON island
    and breaking out of the favicon's href attribute."""
    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest
    manifest["viewer"] = {"title": "{{MERMAID_SCRIPTS}}", "favicon": "{{DOCSIFY_CONFIG}}"}
    generate_viewer(str(layer), manifest)
    html = (layer / "docs" / ".leji" / "viewer" / "index.html").read_text()
    assert "<title>{{MERMAID_SCRIPTS}}</title>" in html
    assert 'href="/content/{{DOCSIFY_CONFIG}}"' in html
    assert html.count("<script") == 14, "nothing injected into the page"


def test_viewer_rejects_an_unusable_theme_color(tmp_path: Path) -> None:
    """The accent reaches a stylesheet as a custom-property value, so a value with
    punctuation in it is refused with a warning rather than interpolated."""
    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest
    manifest["viewer"] = {"theme": {"primary": "red; } body { display: none } /*"}}
    result = generate_viewer(str(layer), manifest)
    html = (layer / "docs" / ".leji" / "viewer" / "index.html").read_text()
    assert '"themeColor":"#223F93"' in html
    assert any(
        f.rule == "viewer-theme-invalid" and f.severity == "warning" for f in result.findings
    )
    manifest["viewer"] = {"theme": {"primary": "#ff0000"}}
    generate_viewer(str(layer), manifest)
    assert (
        '"themeColor":"#ff0000"' in (layer / "docs" / ".leji" / "viewer" / "index.html").read_text()
    )


def test_viewer_escapes_html_in_sidebar_labels(tmp_path: Path) -> None:
    """A manifest label reaches the generated sidebar verbatim, so its angle
    brackets are escaped rather than landing as live HTML."""
    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest
    manifest["viewer"] = {"agentsLabel": "<img src=x onerror=alert(1)>"}
    generate_viewer(str(layer), manifest)
    sidebar = (layer / "docs" / ".leji" / "viewer" / "_sidebar.md").read_text()
    assert "\\<img src=x onerror=alert(1)\\>" in sidebar


def test_viewer_serve_policy_headers_and_inert_content_types(tmp_path: Path) -> None:
    """Same-origin execution of governed content was the reported blocker: every
    response carries the policy headers, and the layer's own files never come back
    with an active content type."""
    import http.client
    import threading

    from leji import serve_viewer

    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest
    (layer / "docs" / "evil.html").write_text("<script>alert(1)</script>")
    (layer / "docs" / "evil.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    generate_viewer(str(layer), manifest)
    server = serve_viewer(str(layer), 0, manifest["rootPath"])
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def get(path: str, method: str = "GET"):
        conn = http.client.HTTPConnection("127.0.0.1", port)
        conn.request(method, path)
        resp = conn.getresponse()
        body = resp.read()
        conn.close()
        return resp, body

    try:
        resp, _ = get("/content/evil.html")
        assert resp.getheader("content-type") == "text/plain; charset=utf-8"
        # SVG keeps its real type so a configured logo/favicon still renders. Its
        # inertness is the policy's job, not the content type's: the sandbox puts a
        # navigated or framed SVG in an opaque origin with scripting off.
        svg, _ = get("/content/evil.svg")
        assert svg.status == 200
        assert svg.getheader("content-type") == "image/svg+xml"
        assert "sandbox" in svg.getheader("content-security-policy")
        assert svg.getheader("x-content-type-options") == "nosniff"
        for path in (
            "/",
            "/assets/docsify.min.js",
            "/content/domain/glossary.md",
            "/content/nope.md",
        ):
            resp, _ = get(path)
            assert resp.getheader("x-content-type-options") == "nosniff", path
            assert resp.getheader("content-security-policy"), path
        shell, _ = get("/")
        assert "script-src 'self'" in shell.getheader("content-security-policy")
        assert "frame-src 'none'" in shell.getheader("content-security-policy")
        doc, _ = get("/content/domain/glossary.md")
        assert "sandbox" in doc.getheader("content-security-policy")
        # A NUL in the path is a clean 404, matching Node and Go, not a 500.
        assert get("/content/%00")[0].status == 404
        # HEAD answers like GET with the body suppressed, rather than 501.
        head, head_body = get("/", method="HEAD")
        assert head.status == 200
        assert head_body == b""
    finally:
        server.shutdown()


def test_viewer_serve_rejects_a_foreign_host(tmp_path: Path) -> None:
    """Loopback binding alone does not stop DNS rebinding: only the names the viewer
    is actually addressed by are answered."""
    import socket
    import threading

    from leji import serve_viewer

    layer = _copy(EXAMPLE, tmp_path)
    manifest = load_manifest(str(layer)).manifest
    generate_viewer(str(layer), manifest)
    server = serve_viewer(str(layer), 0, manifest["rootPath"])
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def status(host: str) -> int:
        with socket.create_connection(("127.0.0.1", port)) as sock:
            sock.sendall(f"GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n".encode())
            head = b""
            while b"\r\n" not in head:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                head += chunk
        return int(head.split(b" ")[1])

    try:
        for host in ("localhost", "localhost:5354", "127.0.0.1", "[::1]:5354"):
            assert status(host) == 200, host
        for host in ("evil.example", "rebound.example:5354"):
            assert status(host) == 403, host
    finally:
        server.shutdown()


def test_viewer_port_precedence(tmp_path: Path) -> None:
    from leji import resolve_viewer_port

    base = json.loads((EXAMPLE / "leji.json").read_text())
    assert resolve_viewer_port(base) == 5354
    assert resolve_viewer_port({**base, "viewer": {"port": 21300}}) == 21300
    assert resolve_viewer_port({**base, "viewer": {"port": 21300}}, 4000) == 4000
    assert resolve_viewer_port({**base, "viewer": {"port": 21300}}, 0) == 0


def test_viewer_block_in_manifest_validates(tmp_path: Path) -> None:
    layer = _copy(EXAMPLE, tmp_path)
    manifest_path = layer / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["viewer"] = {"port": 21300}
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


# --- in-place manifest text edits (byte-exact, the cross-SDK parity contract) ---

_MANIFEST_NO_AGENTS = """{
  "leji": "1.0",
  "categories": {},
  "owners": {
    "primary": { "name": "x" }
  }
}
"""


def test_bind_agent_creates_map_in_schema_position() -> None:
    text, changed = bind_agent_in_manifest_text(
        _MANIFEST_NO_AGENTS, "reviewer", "docs/agents/reviewer.md"
    )
    assert changed is True
    assert (
        text
        == """{
  "leji": "1.0",
  "categories": {},
  "agents": {
    "reviewer": "docs/agents/reviewer.md"
  },
  "owners": {
    "primary": { "name": "x" }
  }
}
"""
    )


def test_bind_agent_prepends_second_and_is_idempotent() -> None:
    one, _ = bind_agent_in_manifest_text(_MANIFEST_NO_AGENTS, "reviewer", "docs/agents/reviewer.md")
    two, changed = bind_agent_in_manifest_text(
        one, "thought-partner", "docs/agents/thought-partner.md"
    )
    assert changed is True
    assert (
        '"agents": {\n'
        '    "thought-partner": "docs/agents/thought-partner.md",\n'
        '    "reviewer": "docs/agents/reviewer.md"\n'
        "  },"
    ) in two
    again, changed_again = bind_agent_in_manifest_text(two, "reviewer", "docs/agents/reviewer.md")
    assert changed_again is False
    assert again == two


# --- intent/records ---


def test_records_valid_records_fixture_resolves_kinds() -> None:
    # Kinds resolve by block and file-selector override (read-only scan, so the
    # shared fixture is used in place).
    layer = FIXTURES / "valid-records"
    manifest = load_manifest(str(layer)).manifest
    assert manifest is not None
    scan = scan_categories(str(layer), manifest)
    kinds = {d.rel_path: d.kind for d in scan.docs}
    assert kinds["docs/domain/overview.md"] == "intent"
    assert kinds["docs/records/2026-07-03-status.md"] == "record"
    assert kinds["docs/records/ledger.md"] == "record"
    # The file selector beats the record directory selector.
    assert kinds["docs/records/escalation-policy.md"] == "intent"
    # Decision-category documents are inherently records.
    assert kinds["docs/decisions/0001-adopt-leji.md"] == "record"


def test_records_frontmatter_kind_overrides_block_kind_invalid_is_error(tmp_path: Path) -> None:
    layer = tmp_path / "layer"
    shutil.copytree(FIXTURES / "valid-records", layer)
    (layer / "docs" / "records" / "pinned.md").write_text(
        "---\nkind: intent\n---\n\n# Pinned\n\nA record-directory file declaring itself intent.\n",
        encoding="utf-8",
    )
    (layer / "docs" / "domain" / "bad.md").write_text(
        "---\nkind: sometimes\n---\n\n# Bad\n\nInvalid kind value.\n", encoding="utf-8"
    )
    manifest = load_manifest(str(layer)).manifest
    assert manifest is not None
    scan = scan_categories(str(layer), manifest)
    kinds = {d.rel_path: d.kind for d in scan.docs}
    assert kinds["docs/records/pinned.md"] == "intent"
    assert any(f.rule == "kind-invalid" and f.path == "docs/domain/bad.md" for f in scan.findings)


def test_records_route_separates_intent_documents_from_record_candidates() -> None:
    layer = FIXTURES / "valid-records"
    manifest = load_manifest(str(layer)).manifest
    assert manifest is not None
    result = route(
        str(layer), manifest, RouteInput(paths=["docs/records/ledger.md"], categories=["domain"])
    )
    doc_paths = [d.path for d in result.documents]
    assert "docs/domain/overview.md" in doc_paths
    # The intent-overridden file routes as required context.
    assert "docs/records/escalation-policy.md" in doc_paths
    # Records never route as documents.
    assert not any(p.startswith("docs/records/2") for p in doc_paths)
    by_path = {r.path: r for r in result.records}
    assert by_path["docs/records/2026-07-03-status.md"] == RoutedRecord(
        path="docs/records/2026-07-03-status.md",
        category="domain",
        date="2026-07-03",
        required=False,
    )
    assert by_path["docs/records/ledger.md"] == RoutedRecord(
        path="docs/records/ledger.md", category="domain", date=None, required=True
    )
    # Decision records route via `decisions`, never as generic records.
    assert "docs/decisions/0001-adopt-leji.md" not in by_path


def test_records_freshness_skips_records_index_carries_kind_and_dates(tmp_path: Path) -> None:
    # Copy before write_index so the shared fixture stays pristine.
    layer = tmp_path / "layer"
    shutil.copytree(FIXTURES / "valid-records", layer)
    manifest = load_manifest(str(layer)).manifest
    assert manifest is not None
    report = freshness_report(str(layer), manifest)
    assert report.declared == 0, "no intent doc in the fixture declares a horizon"
    result = write_index(str(layer), manifest)
    assert result.index is not None
    entries = {e["path"]: e for e in result.index["entries"]}
    assert entries["docs/records/2026-07-03-status.md"]["kind"] == "record"
    assert entries["docs/records/2026-07-03-status.md"]["date"] == "2026-07-03"
    assert entries["docs/records/ledger.md"]["kind"] == "record"
    assert "date" not in entries["docs/records/ledger.md"]
    assert entries["docs/records/escalation-policy.md"]["kind"] == "intent"


def test_records_fully_displaced_broad_selector_is_shadowed_in_status(tmp_path: Path) -> None:
    layer = tmp_path / "layer"
    shutil.copytree(FIXTURES / "valid-records", layer)
    # Shrink the record directory to only the file the intent selector steals.
    (layer / "docs" / "records" / "2026-07-03-status.md").unlink()
    (layer / "docs" / "records" / "ledger.md").unlink()
    manifest = load_manifest(str(layer)).manifest
    assert manifest is not None
    report = status_report(str(layer), manifest)
    assert report.shadowed == [
        ShadowedSelector(index_file="docs/context/domain.md", path="docs/records/")
    ]
