"""Behavioral tests mirroring packages/sdk/test/sdk.test.ts."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from leji import (
    check_index,
    conformance_report,
    freshness_report,
    init_layer,
    load_manifest,
    validate_layer,
    write_index,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = REPO_ROOT / "examples" / "monorepo"


@pytest.fixture()
def example_copy(tmp_path: Path) -> Path:
    dest = tmp_path / "layer"
    shutil.copytree(EXAMPLE, dest)
    return dest


def test_example_monorepo_validates_clean() -> None:
    result = validate_layer(str(EXAMPLE))
    assert [f for f in result.findings if f.severity == "error"] == []


def test_index_round_trip(example_copy: Path) -> None:
    manifest = load_manifest(str(example_copy)).manifest
    assert manifest is not None
    write_index(str(example_copy), manifest)
    assert check_index(str(example_copy), manifest).stale is False


def test_index_goes_stale_on_doc_change(example_copy: Path) -> None:
    manifest = load_manifest(str(example_copy)).manifest
    write_index(str(example_copy), manifest)
    glossary = example_copy / "docs" / "domain" / "glossary.md"
    glossary.write_text(glossary.read_text() + "\n- **Refund**: a reversal.\n")
    result = check_index(str(example_copy), manifest)
    assert result.stale is True
    assert any(f.rule == "index-stale" for f in result.findings)


def test_index_ids_stable_across_move(example_copy: Path) -> None:
    manifest = load_manifest(str(example_copy)).manifest
    write_index(str(example_copy), manifest)
    (example_copy / "docs" / "domain" / "glossary.md").rename(
        example_copy / "docs" / "domain" / "terms.md"
    )
    result = write_index(str(example_copy), manifest)
    moved = next(e for e in result.index["entries"] if e["path"] == "docs/domain/terms.md")
    assert moved["id"] == "glossary"


def test_init_yes_core_validates_clean(tmp_path: Path) -> None:
    result = init_layer(str(tmp_path), yes=True)
    assert "leji.json" in result.written
    # init does not `git init`, so a freshly scaffolded layer in a bare temp dir
    # carries exactly the not-in-git warning; its content is otherwise clean.
    findings = validate_layer(str(tmp_path)).findings
    assert [f.rule for f in findings] == ["git-required"]


def test_init_yes_indexed_verifies_claim(tmp_path: Path) -> None:
    init_layer(str(tmp_path), yes=True, level="indexed", name="acme-context")
    validation = validate_layer(str(tmp_path))
    assert [f for f in validation.findings if f.severity == "error"] == []
    conformance = conformance_report(str(tmp_path))
    assert conformance.claimed_level == "indexed"
    assert conformance.verified_level == "indexed"


def test_init_refuses_overwrite(tmp_path: Path) -> None:
    init_layer(str(tmp_path), yes=True)
    with pytest.raises(RuntimeError, match="refuses to overwrite"):
        init_layer(str(tmp_path), yes=True)


def test_init_emits_no_machine_block_core(tmp_path: Path) -> None:
    result = init_layer(str(tmp_path), yes=True)
    assert "machine" not in result.manifest, "in-memory manifest carries no machine key"
    written = json.loads((tmp_path / "leji.json").read_text())
    assert "machine" not in written, "leji.json on disk has no machine key"
    # Decisions and agents still resolve to their defaults under rootPath.
    assert (tmp_path / "docs" / "decisions" / "0001-adopt-leji.md").is_file()
    assert (tmp_path / "docs" / "agents" / "core.md").is_file()


def test_indexed_init_no_machine_key_yet_writes_index_and_changelog(tmp_path: Path) -> None:
    result = init_layer(str(tmp_path), yes=True, level="indexed", name="acme-context")
    assert "machine" not in result.manifest, "no machine key even at indexed level"
    written = json.loads((tmp_path / "leji.json").read_text())
    assert "machine" not in written, "leji.json on disk has no machine key"
    # The files are still created at their default locations.
    assert (tmp_path / "docs" / "context-index.json").is_file(), "index at default path"
    assert (tmp_path / "docs" / "context-changelog.json").is_file(), "changelog at default path"
    assert "docs/context-index.json" in result.written
    # The resolvers find them: validate reports no errors, conformance verifies indexed.
    validation = validate_layer(str(tmp_path))
    assert [f for f in validation.findings if f.severity == "error"] == []
    conformance = conformance_report(str(tmp_path))
    assert conformance.verified_level == "indexed"


def test_changelog_append_only_detects_modified_entry(tmp_path: Path) -> None:
    layer = tmp_path / "layer"
    shutil.copytree(EXAMPLE, layer)
    subprocess.run(["git", "init", "-q"], cwd=layer, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=layer, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=layer, check=True)
    subprocess.run(["git", "add", "-A"], cwd=layer, check=True)
    subprocess.run(["git", "commit", "-qm", "seed"], cwd=layer, check=True)

    changelog_path = layer / "docs" / "context-changelog.json"
    changelog = json.loads(changelog_path.read_text())
    changelog["entries"][0]["summary"] = "Rewritten history."
    changelog_path.write_text(json.dumps(changelog, indent=2) + "\n")

    result = validate_layer(str(layer))
    assert any(f.rule == "changelog-append-only" and f.severity == "error" for f in result.findings)


def test_freshness_reports_expired(example_copy: Path) -> None:
    invariants = example_copy / "docs" / "system" / "invariants.md"
    invariants.write_text(
        invariants.read_text().replace("reviewAfter: 2026-12-10", "reviewAfter: 2020-01-01")
    )
    manifest = load_manifest(str(example_copy)).manifest
    report = freshness_report(str(example_copy), manifest)
    assert len(report.expired) == 1
    assert report.findings[0].rule == "freshness-expired"
    assert report.findings[0].severity == "warning"
    strict = freshness_report(str(example_copy), manifest, strict=True)
    assert strict.findings[0].severity == "error"


def test_conformance_fails_overclaim(example_copy: Path) -> None:
    manifest_path = example_copy / "leji.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["conformance"]["claimedLevel"] = "governed"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    invariants = example_copy / "docs" / "system" / "invariants.md"
    import re

    invariants.write_text(
        re.sub(r"freshness:\n  reviewAfter: [0-9-]+\n", "", invariants.read_text())
    )
    write_index(str(example_copy), manifest)
    result = conformance_report(str(example_copy))
    assert result.verified_level == "indexed"
    assert any(f.rule == "conformance-claim" for f in result.findings)


def test_yaml_dates_stay_strings(tmp_path: Path) -> None:
    """PyYAML 1.1 would coerce the unquoted date; the Leji loader must not."""
    from leji.frontmatter import parse_frontmatter

    fm = parse_frontmatter("---\ndate: 2026-06-12\nflag: no\n---\n\nbody\n")
    assert fm.data["date"] == "2026-06-12"
    assert fm.data["flag"] == "no"
    assert parse_frontmatter("---\nok: true\n---\n\nbody\n").data["ok"] is True
