"""Onboarding overhaul tests, mirroring packages/sdk/test/onboarding.test.ts."""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from leji import (
    ConformanceResult,
    DetectedHost,
    PlanEntry,
    adapter_content,
    adopt_layer,
    conformance_report,
    detect_hosts,
    init_layer,
    load_manifest,
    render_detect,
    render_explain,
    render_write_plan,
    validate_layer,
    write_index,
)
from leji.conformance import ChecklistItem
from leji.ecosystem import detect_ecosystem
from leji.init_cmd import add_agent, ensure_local_hook, entering_adopted


def _git_init(dir_: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=dir_, check=True)


def _git_commit_all(dir_: Path) -> None:
    """Stage and commit everything so the working tree is clean before init/adopt
    runs (the dirty-tree guard refuses an uncommitted tree)."""
    subprocess.run(["git", "add", "-A"], cwd=dir_, check=True)
    subprocess.run(
        ["git", "-c", "user.name=T", "-c", "user.email=t@e.com", "commit", "-q", "-m", "seed"],
        cwd=dir_,
        check=True,
    )


def test_init_dry_run_writes_nothing_and_reports_plan(tmp_path: Path) -> None:
    (tmp_path / "CLAUDE.md").write_text("some existing agent config\n", encoding="utf-8")
    result = init_layer(str(tmp_path), yes=True, dry_run=True)

    assert result.dry_run is True
    assert result.written == []
    assert not (tmp_path / "leji.json").exists(), "dry-run creates no manifest"

    creates = [e.rel for e in result.plan if e.status == "create"]
    assert "leji.json" in creates
    assert ".leji/work/onboarding-brief.md" in creates
    # The existing vendor file is detected and explicitly left untouched.
    untouched = next((e for e in result.plan if e.rel == "CLAUDE.md"), None)
    assert untouched is not None and untouched.status == "wont-modify"


def test_init_writes_brief_in_workspace_role_excluded_from_index(tmp_path: Path) -> None:
    init_layer(str(tmp_path), yes=True, level="indexed", name="acme-context")

    brief = tmp_path / ".leji" / "work" / "onboarding-brief.md"
    assert brief.is_file(), "brief is written"

    manifest = load_manifest(str(tmp_path)).manifest
    assert manifest is not None
    result = write_index(str(tmp_path), manifest)
    indexed_paths = [e["path"] for e in result.index["entries"]]
    assert not any(".leji" in p for p in indexed_paths), (
        "the transient brief never appears in the generated index"
    )


def test_validate_content_warns_on_fresh_scaffold_never_errors(tmp_path: Path) -> None:
    init_layer(str(tmp_path), yes=True)
    result = validate_layer(str(tmp_path), content=True)

    rules = [f.rule for f in result.findings]
    assert "content-identity" in rules, "flags the generic identity"
    assert "content-placeholder" in rules, "flags placeholder text"
    assert "content-thin" in rules, "flags thin categories"
    # Content findings are warning-only; the layer remains error-free.
    assert [f for f in result.findings if f.severity == "error"] == []


def test_validate_without_content_emits_no_content_findings(tmp_path: Path) -> None:
    init_layer(str(tmp_path), yes=True)
    result = validate_layer(str(tmp_path))
    assert not any(f.rule.startswith("content-") for f in result.findings)


def test_populated_layer_passes_content_lint_clean(tmp_path: Path) -> None:
    init_layer(str(tmp_path), yes=True)
    # Replace the placeholder scaffold with real, repo-specific content.
    (tmp_path / "docs" / "boot-profile.md").write_text(
        "\n".join(
            [
                "# Boot Profile",
                "",
                "## Identity",
                "",
                "Acme is a B2B invoicing platform in production since 2024.",
                "",
                "## Loading",
                "",
                "- docs/system/invariants.md: the rules every change lives with",
                "",
                "## Posture",
                "",
                "- Proceed without asking: doc fixes.",
                "- Stop and ask: settlement math.",
                "- Never: bypass the ledger.",
                "",
                "## Maintenance",
                "",
                "Append to docs/decisions when you change this layer.",
                "",
            ]
        ),
        encoding="utf-8",
    )
    (tmp_path / "docs" / "domain" / "glossary.md").write_text(
        "---\nsummary: terms\n---\n\n# Glossary\n\n"
        "- Invoice: a request for payment.\n"
        "- Credit note: reduces an invoice.\n"
        "- Settlement: matching funds to invoices.\n",
        encoding="utf-8",
    )
    (tmp_path / "docs" / "system" / "invariants.md").write_text(
        "---\nsummary: rules\n---\n\n# System Invariants\n\n"
        "- Money is integer minor units.\n"
        "- Invoices are immutable once sent.\n"
        "- The ledger is the source of truth.\n",
        encoding="utf-8",
    )
    result = validate_layer(str(tmp_path), content=True)
    leftover = [f.rule for f in result.findings if f.rule.startswith("content-")]
    assert not leftover, f"expected no content findings, got: {leftover}"


def test_detect_hosts_ranks_by_signal_strength(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "AGENTS.md").write_text("codex config\n", encoding="utf-8")  # codex: project-present
    home = tmp_path / "home"
    (home / ".gemini").mkdir(parents=True)  # gemini: installed-likely
    hosts = detect_hosts(
        str(repo),
        homedir=str(home),
        platform="linux",
        has_binary=lambda b: b == "claude",  # claude: confirmed
    )
    assert [h.id for h in hosts] == ["claude-code", "codex", "gemini"]
    assert hosts[0].strength == "confirmed"
    assert next(h for h in hosts if h.id == "codex").strength == "project-present"
    assert next(h for h in hosts if h.id == "gemini").strength == "installed-likely"


def test_detect_hosts_requires_executable_bit_on_posix(tmp_path: Path) -> None:
    # Mirrors 'detectHosts requires an executable bit on POSIX' in
    # packages/sdk/test/onboarding.test.ts: a non-executable file on PATH is not
    # a confirmed host. Drives the real PATH probe (no has_binary injection).
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    claude = bin_dir / "claude"
    claude.write_text("#!/bin/sh\n", encoding="utf-8")
    claude.chmod(0o755)  # executable
    codex = bin_dir / "codex"
    codex.write_text("plain text\n", encoding="utf-8")
    codex.chmod(0o644)  # NOT executable
    home = tmp_path / "home"
    home.mkdir()
    hosts = detect_hosts(
        str(tmp_path / "root"),
        env={"PATH": str(bin_dir)},
        homedir=str(home),
        platform="linux",
    )
    by_id = {h.id: h for h in hosts}
    assert by_id["claude-code"].on_path is True, "executable claude is confirmed on PATH"
    # codex has no executable on PATH and no repo/user signal, so it is absent.
    assert "codex" not in by_id, "a non-executable file named codex is not a confirmed host"


def test_init_agent_wires_redirect_and_validates_clean(tmp_path: Path) -> None:
    res = init_layer(str(tmp_path), yes=True, agent="claude-code")
    assert "CLAUDE.md" not in res.written, "init --agent no longer creates a vendor adapter"
    assert not (tmp_path / "CLAUDE.md").exists()
    manifest = load_manifest(str(tmp_path)).manifest
    assert manifest is not None
    assert "vendorAdapters" not in manifest
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    result = validate_layer(str(tmp_path))
    assert [f for f in result.findings if f.severity == "error"] == []


def test_init_agent_never_overwrites_existing_entrypoint(tmp_path: Path) -> None:
    (tmp_path / "CLAUDE.md").write_text("my own config\n", encoding="utf-8")
    res = init_layer(str(tmp_path), yes=True, agent="claude-code")
    assert "CLAUDE.md" not in res.written
    assert (tmp_path / "CLAUDE.md").read_text(encoding="utf-8") == "my own config\n"
    manifest = load_manifest(str(tmp_path)).manifest
    assert manifest is not None
    assert "vendorAdapters" not in manifest


def test_init_agent_rejects_unlaunchable_host(tmp_path: Path) -> None:
    # --agent names the handoff host, so an unknown value is a usage error naming
    # the accepted set, the way --mode and --level reject theirs. It is checked
    # before any filesystem work, so the directory is left untouched.
    with pytest.raises(RuntimeError) as excinfo:
        init_layer(str(tmp_path), yes=True, agent="frobnicate")
    assert str(excinfo.value) == (
        '--agent must be a launchable host (claude-code, codex); got "frobnicate"'
    )
    assert not (tmp_path / "leji.json").exists()


def test_init_writes_portable_agents_pointer_by_default_and_validates_clean(
    tmp_path: Path,
) -> None:
    res = init_layer(str(tmp_path), yes=True)
    assert "AGENTS.md" in res.written
    assert (tmp_path / "AGENTS.md").read_text(encoding="utf-8") == (
        "Read ./docs/boot-profile.md first. "
        "It is the canonical context entrypoint for this repository.\n"
    )
    # The pointer is the well-known portable adapter; no manifest declaration needed.
    manifest = load_manifest(str(tmp_path)).manifest
    assert manifest is not None
    assert "vendorAdapters" not in manifest
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    v = validate_layer(str(tmp_path))
    assert [f for f in v.findings if f.severity == "error"] == []


def test_init_no_agents_skips_portable_agents_pointer(tmp_path: Path) -> None:
    res = init_layer(str(tmp_path), yes=True, no_agents=True)
    assert "AGENTS.md" not in res.written
    assert not (tmp_path / "AGENTS.md").exists()


def test_init_never_touches_existing_agents_md(tmp_path: Path) -> None:
    (tmp_path / "AGENTS.md").write_text("my own instructions\n", encoding="utf-8")
    res = init_layer(str(tmp_path), yes=True)
    assert "AGENTS.md" not in res.written
    assert (tmp_path / "AGENTS.md").read_text(encoding="utf-8") == "my own instructions\n"
    entry = next((e for e in res.plan if e.rel == "AGENTS.md"), None)
    assert entry is not None and entry.status == "wont-modify"


def test_adopt_writes_portable_agents_pointer_only_when_absent(tmp_path: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "README.md").write_text("# Docs\n", encoding="utf-8")
    _git_commit_all(tmp_path)
    res = adopt_layer(str(tmp_path), yes=True)
    assert "AGENTS.md" in res.written
    assert (tmp_path / "AGENTS.md").read_text(encoding="utf-8") == (
        "Read ./docs/boot-profile.md first. "
        "It is the canonical context entrypoint for this repository.\n"
    )


def test_adopt_no_agents_skips_pointer_existing_agents_md_keeps_migrate_flow(
    tmp_path: Path,
) -> None:
    skip_dir = tmp_path / "skip"
    skip_dir.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=skip_dir, check=True)
    skipped = adopt_layer(str(skip_dir), yes=True, no_agents=True)
    assert "AGENTS.md" not in skipped.written
    assert not (skip_dir / "AGENTS.md").exists()

    dir_ = tmp_path / "present"
    dir_.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=dir_, check=True)
    (dir_ / "AGENTS.md").write_text("Team instructions here.\n", encoding="utf-8")
    _git_commit_all(dir_)
    res = adopt_layer(str(dir_), yes=True)
    # Present file: content migrated, original untouched, no pointer overwrite.
    assert "AGENTS.md" not in res.written
    assert res.migrated == ["AGENTS.md"]
    assert (dir_ / "AGENTS.md").read_text(encoding="utf-8") == "Team instructions here.\n"


def test_adopt_reuses_docs_root_and_migrates_vendor_content_draft(tmp_path: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "README.md").write_text("# Docs\n", encoding="utf-8")
    (tmp_path / "CLAUDE.md").write_text("Always run tests. Use 3-space indent.\n", encoding="utf-8")
    _git_commit_all(tmp_path)

    res = adopt_layer(str(tmp_path), yes=True)
    assert res.detected_root == "docs/"
    assert res.migrated == ["CLAUDE.md"]
    assert res.draft is True, "a non-redirecting vendor file makes it a draft"

    # Original is untouched; content migrated into a Leji-owned governance doc.
    assert (tmp_path / "CLAUDE.md").read_text(
        encoding="utf-8"
    ) == "Always run tests. Use 3-space indent.\n"
    imported = tmp_path / "docs" / "governance" / "imported-claude.md"
    assert imported.is_file(), "migrated file exists with a single .md extension"
    assert "Always run tests" in imported.read_text(encoding="utf-8")
    assert (tmp_path / "docs" / "decisions" / "0002-adopt-existing-agent-context.md").exists()

    # Draft is honest: the non-redirecting entrypoint makes validate error.
    v = validate_layer(str(tmp_path))
    assert any(f.rule == "vendor-adapter-redirect" and f.severity == "error" for f in v.findings)


def test_adopt_wire_adapters_converts_entrypoint_and_validates_clean(tmp_path: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    (tmp_path / "CLAUDE.md").write_text("Always run tests.\n", encoding="utf-8")
    _git_commit_all(tmp_path)

    res = adopt_layer(str(tmp_path), yes=True, wire_adapters=True)
    assert res.draft is False
    assert "docs/boot-profile.md" in (tmp_path / "CLAUDE.md").read_text(encoding="utf-8")
    manifest = load_manifest(str(tmp_path)).manifest
    assert manifest is not None
    assert manifest["vendorAdapters"] == ["CLAUDE.md"]
    v = validate_layer(str(tmp_path))
    assert [f for f in v.findings if f.severity == "error"] == []


def test_adopt_wire_adapters_migrates_mixed_redirect_and_instructions(tmp_path: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    # A vendor file that mentions the boot path AND carries real instructions --
    # including an instruction that shares a line with the boot-path reference.
    (tmp_path / "CLAUDE.md").write_text(
        "Read docs/boot-profile.md first. Never deploy on Fridays.\n"
        "Always run the full test suite before committing.\n",
        encoding="utf-8",
    )
    _git_commit_all(tmp_path)
    res = adopt_layer(str(tmp_path), yes=True, wire_adapters=True)
    assert "CLAUDE.md" in res.migrated, "mixed file is migrated, not silently overwritten"
    imported = (tmp_path / "docs" / "governance" / "imported-claude.md").read_text(encoding="utf-8")
    assert "Never deploy on Fridays" in imported, (
        "instructions sharing a line with the boot path are preserved"
    )
    assert "Always run the full test suite" in imported, (
        "the extra instructions are preserved in the layer"
    )
    assert "docs/boot-profile.md" in (tmp_path / "CLAUDE.md").read_text(encoding="utf-8")


def test_adopt_wire_adapters_skips_file_already_canonical_redirect(tmp_path: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    # A vendor file that is already exactly Leji's canonical redirect.
    (tmp_path / "CLAUDE.md").write_text(adapter_content("docs/boot-profile.md"), encoding="utf-8")
    _git_commit_all(tmp_path)
    res = adopt_layer(str(tmp_path), yes=True, wire_adapters=True)
    assert "CLAUDE.md" not in res.migrated, (
        "a file already equal to the canonical redirect is not migrated"
    )
    assert not (tmp_path / "docs" / "governance" / "imported-claude.md").exists()


def test_adopt_dry_run_shows_convert_vs_leave_as_is_writes_nothing(tmp_path: Path) -> None:
    (tmp_path / "CLAUDE.md").write_text("x\n", encoding="utf-8")
    res = adopt_layer(str(tmp_path), yes=True, dry_run=True, wire_adapters=True)
    assert res.written == []
    assert not (tmp_path / "leji.json").exists()
    entry = next((e for e in res.plan if e.rel == "CLAUDE.md"), None)
    assert entry is not None and entry.status == "overwrite"


def test_adopt_refuses_when_layer_exists(tmp_path: Path) -> None:
    init_layer(str(tmp_path), yes=True)
    with pytest.raises(RuntimeError, match="already has a Leji layer"):
        adopt_layer(str(tmp_path), yes=True)


def test_agent_wires_named_reviewer_into_existing_layer(tmp_path: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    init_layer(str(tmp_path), yes=True, agent="claude-code")
    m = load_manifest(str(tmp_path)).manifest
    assert m is not None
    res = add_agent(str(tmp_path), m, host="codex", name="reviewer")
    assert (res.profile_created, res.manifest_changed) == (True, True)
    assert res.host_id == "codex"
    manifest = load_manifest(str(tmp_path)).manifest
    assert manifest is not None
    # The agent's binding; add_agent creates no vendor adapter. The AGENTS.md on
    # disk is init's portable pointer (default-on), not add_agent's work.
    assert manifest["agents"]["reviewer"] == "docs/agents/reviewer.md"
    assert "vendorAdapters" not in manifest
    assert (tmp_path / "AGENTS.md").read_text(encoding="utf-8") == (
        "Read ./docs/boot-profile.md first. "
        "It is the canonical context entrypoint for this repository.\n"
    )
    reviewer = (tmp_path / "docs" / "agents" / "reviewer.md").read_text(encoding="utf-8")
    assert "\nid: reviewer\n" in reviewer
    assert "\nrole: reviewer\n" in reviewer
    assert "\nhost: codex\n" in reviewer
    v = validate_layer(str(tmp_path))
    assert [f for f in v.findings if f.severity == "error"] == []


def test_agent_binds_resident_without_host(tmp_path: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    init_layer(str(tmp_path), yes=True)
    m = load_manifest(str(tmp_path)).manifest
    assert m is not None
    res = add_agent(str(tmp_path), m, host=None, name="reviewer")
    assert (res.profile_created, res.manifest_changed) == (True, True)
    assert res.host_id is None
    manifest = load_manifest(str(tmp_path)).manifest
    assert manifest is not None
    assert manifest["agents"]["reviewer"] == "docs/agents/reviewer.md"
    assert "vendorAdapters" not in manifest
    reviewer = (tmp_path / "docs" / "agents" / "reviewer.md").read_text(encoding="utf-8")
    assert "\nhost:" not in reviewer, "resident agent must not pin a host"
    assert "(host " not in reviewer, "resident agent prose must not mention a host"
    assert "\nid: reviewer\n" in reviewer
    assert "\nrole: reviewer\n" in reviewer


def test_agent_is_idempotent(tmp_path: Path) -> None:
    init_layer(str(tmp_path), yes=True)
    m = load_manifest(str(tmp_path)).manifest
    assert m is not None
    add_agent(str(tmp_path), m, host="codex", name="reviewer")
    after = (tmp_path / "leji.json").read_text(encoding="utf-8")
    res2 = add_agent(str(tmp_path), m, host="codex", name="reviewer")
    assert (res2.profile_created, res2.manifest_changed) == (False, False)
    assert (tmp_path / "leji.json").read_text(encoding="utf-8") == after


def test_agent_appends_second_binding_without_disturbing_first(tmp_path: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    init_layer(str(tmp_path), yes=True)
    add_agent(str(tmp_path), load_manifest(str(tmp_path)).manifest, host="codex", name="reviewer")
    add_agent(
        str(tmp_path),
        load_manifest(str(tmp_path)).manifest,
        host="claude-code",
        name="thought-partner",
        role="advisor",
    )
    manifest = load_manifest(str(tmp_path)).manifest
    assert manifest is not None
    assert manifest["agents"]["reviewer"] == "docs/agents/reviewer.md"
    assert manifest["agents"]["thought-partner"] == "docs/agents/thought-partner.md"
    profile = (tmp_path / "docs" / "agents" / "thought-partner.md").read_text(encoding="utf-8")
    assert "\nrole: advisor\n" in profile
    v = validate_layer(str(tmp_path))
    assert [f for f in v.findings if f.severity == "error"] == []


def test_agent_rejects_unknown_host_and_non_kebab_name(tmp_path: Path) -> None:
    m = init_layer(str(tmp_path), yes=True).manifest
    with pytest.raises(RuntimeError, match="unknown host"):
        add_agent(str(tmp_path), m, host="frobnicate", name="reviewer")
    with pytest.raises(RuntimeError, match="lowercase letters"):
        add_agent(str(tmp_path), m, host="codex", name="Bad Name")


def test_conformance_explain_guides_toward_the_next_level(tmp_path: Path) -> None:
    init_layer(str(tmp_path), yes=True)  # core, not indexed
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    explain = render_explain(conformance_report(str(tmp_path)))
    assert 'To reach "indexed"' in explain
    assert "validate --content" in explain


def test_init_agent_creates_no_vendor_adapter_and_validates_clean(
    tmp_path: Path,
) -> None:
    # --agent selects the handoff host and nothing else: no vendor entrypoint file,
    # no `vendorAdapters` manifest key. Only the portable AGENTS.md pointer is written.
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    res = init_layer(str(tmp_path), yes=True, agent="claude-code")
    assert "CLAUDE.md" not in res.written, "init --agent creates no vendor adapter"
    assert not (tmp_path / "CLAUDE.md").exists()
    manifest = load_manifest(str(tmp_path)).manifest
    assert manifest is not None
    assert "vendorAdapters" not in manifest
    result = validate_layer(str(tmp_path))
    assert [f for f in result.findings if f.severity == "error"] == []


def test_init_refuses_symlinked_context_root_that_escapes_dir(tmp_path: Path) -> None:
    dir_ = tmp_path / "repo"
    dir_.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    # The context root `docs/` is a symlink to a real directory outside `dir`.
    os.symlink(outside, dir_ / "docs", target_is_directory=True)

    with pytest.raises(RuntimeError, match="escapes the target"):
        init_layer(str(dir_), yes=True)

    # Nothing leaked into the outside directory through the escaping symlink.
    assert list(outside.iterdir()) == [], "no files written outside the target"


def test_adopt_wire_adapters_refuses_symlinked_outside_vendor_file(tmp_path: Path) -> None:
    dir_ = tmp_path / "repo"
    dir_.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=dir_, check=True)
    secret = outside / "secret.txt"
    secret.write_text("OUTSIDE SECRET CONTENT\n", encoding="utf-8")
    # CLAUDE.md is a symlink pointing at a file outside the repository.
    os.symlink(secret, dir_ / "CLAUDE.md")
    _git_commit_all(dir_)

    adopt_layer(str(dir_), yes=True, wire_adapters=True)

    # The outside file is untouched and CLAUDE.md still points out (not overwritten).
    assert secret.read_text(encoding="utf-8") == "OUTSIDE SECRET CONTENT\n"
    assert (dir_ / "CLAUDE.md").is_symlink(), "the symlink was not replaced"


def test_adopt_does_not_migrate_symlinked_outside_vendor_file(tmp_path: Path) -> None:
    dir_ = tmp_path / "repo"
    dir_.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=dir_, check=True)
    secret = outside / "secret.txt"
    secret.write_text("TOP SECRET DO NOT MIGRATE\n", encoding="utf-8")
    os.symlink(secret, dir_ / "CLAUDE.md")
    _git_commit_all(dir_)

    res = adopt_layer(str(dir_), yes=True)

    assert "CLAUDE.md" not in res.migrated, "an escaping symlink is treated as absent"
    imported_dir = dir_ / "docs" / "governance"
    if imported_dir.exists():
        for f in imported_dir.iterdir():
            if f.name.startswith("imported-"):
                assert "TOP SECRET" not in f.read_text(encoding="utf-8"), (
                    "the outside secret was never read into an imported doc"
                )


def test_migration_doc_fences_script_payload(tmp_path: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    (tmp_path / "CLAUDE.md").write_text(
        "Instructions.\n<script>alert(1)</script>\n", encoding="utf-8"
    )
    _git_commit_all(tmp_path)

    adopt_layer(str(tmp_path), yes=True)

    imported = (tmp_path / "docs" / "governance" / "imported-claude.md").read_text(encoding="utf-8")
    assert "```" in imported, "the migrated content is wrapped in a fenced code block"
    # The script text is present, inside the fence (not as a bare rendered line).
    fence_match = re.search(r"(`{3,})\n([\s\S]*?)\n\1", imported)
    assert fence_match is not None, "a fenced code block delimits the imported content"
    assert "<script>alert(1)</script>" in fence_match.group(2), (
        "the raw script lives inside the fence"
    )


# --- dirty-tree guard on init / adopt ---


def test_init_refuses_on_dirty_git_working_tree_and_writes_nothing(tmp_path: Path) -> None:
    _git_init(tmp_path)
    (tmp_path / "NOTES.md").write_text("wip\n", encoding="utf-8")  # untracked => dirty
    with pytest.raises(RuntimeError, match="uncommitted changes"):
        init_layer(str(tmp_path), yes=True)
    assert not (tmp_path / "leji.json").exists(), "nothing written on refusal"


def test_init_proceeds_on_clean_committed_git_tree(tmp_path: Path) -> None:
    _git_init(tmp_path)
    (tmp_path / "README.md").write_text("# repo\n", encoding="utf-8")
    _git_commit_all(tmp_path)
    res = init_layer(str(tmp_path), yes=True)
    assert "leji.json" in res.written


def test_init_dry_run_is_allowed_on_dirty_git_tree(tmp_path: Path) -> None:
    _git_init(tmp_path)
    (tmp_path / "NOTES.md").write_text("wip\n", encoding="utf-8")
    res = init_layer(str(tmp_path), yes=True, dry_run=True)
    assert res.dry_run is True
    assert not (tmp_path / "leji.json").exists()


def test_init_is_allowed_in_a_non_git_directory(tmp_path: Path) -> None:
    res = init_layer(str(tmp_path), yes=True)  # not a git repo
    assert "leji.json" in res.written


def test_adopt_refuses_on_dirty_git_working_tree(tmp_path: Path) -> None:
    _git_init(tmp_path)
    (tmp_path / "NOTES.md").write_text("wip\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="uncommitted changes"):
        adopt_layer(str(tmp_path), yes=True)


def test_init_does_not_write_a_ci_workflow(tmp_path: Path) -> None:
    res = init_layer(str(tmp_path), yes=True)
    assert ".github/workflows/leji.yml" not in res.written, "init no longer creates CI; use leji ci"
    assert not (tmp_path / ".github" / "workflows" / "leji.yml").exists()


# --- render-function unit coverage (these were only exercised via CLI dispatch) ---


def test_render_write_plan_labels_every_status_and_summarizes_counts() -> None:
    out = render_write_plan(
        [
            PlanEntry(rel="leji.json", status="create"),
            PlanEntry(rel="docs/boot-profile.md", status="skip-exists"),
            PlanEntry(rel="CLAUDE.md", status="overwrite", note="convert"),
            PlanEntry(rel="AGENTS.md", status="wont-modify", note="read-only"),
        ]
    )
    assert re.search(r"create .*leji\.json", out)
    assert re.search(r"skip .*docs/boot-profile\.md", out)
    assert re.search(r"overwrite .*CLAUDE\.md", out)
    assert "Will NOT modify" in out
    assert "AGENTS.md" in out
    assert re.search(r"1 to create, 1 already present.*1 to convert \(with your consent\)", out)


def test_render_detect_handles_no_hosts_case_and_ranked_case(tmp_path) -> None:
    # A root with no manifest: the ecosystem line is present in both shapes and says
    # so, without changing what the host list reports.
    eco = detect_ecosystem(str(tmp_path))
    assert "No coding-agent hosts detected" in render_detect([], eco)
    assert "Ecosystem: none detected" in render_detect([], eco)
    ranked = render_detect(
        [
            DetectedHost(
                id="claude-code",
                name="Claude Code",
                strength="confirmed",
                on_path=True,
                in_repo=False,
                user_config=False,
                adapter="CLAUDE.md",
            ),
            DetectedHost(
                id="cursor",
                name="Cursor",
                strength="project-present",
                on_path=False,
                in_repo=True,
                user_config=False,
                adapter=".cursor/rules/leji.md",
            ),
        ],
        eco,
    )
    assert re.search(r"confirmed.*Claude Code.*binary on PATH.*CLAUDE\.md", ranked)
    assert "leji init --agent" in ranked
    assert "Ecosystem: none detected" in ranked


def test_render_explain_covers_federated_top_and_all_pass_branches() -> None:
    top = render_explain(
        ConformanceResult(
            claimed_level="federated",
            verified_level="federated",
            items=[],
            findings=[],
        )
    )
    assert "top conformance level" in top
    # verified core, all indexed items pass -> "set conformance.claimedLevel"
    all_pass = render_explain(
        ConformanceResult(
            claimed_level="core",
            verified_level="core",
            items=[
                ChecklistItem(
                    id="index-current", level="indexed", description="index", status="pass"
                ),
                ChecklistItem(
                    id="changelog", level="indexed", description="changelog", status="pass"
                ),
            ],
            findings=[],
        )
    )
    assert 'all "indexed" checks already pass' in all_pass


def test_content_lint_thin_category_boundary(tmp_path: Path) -> None:
    two = tmp_path / "two"
    init_layer(str(two), yes=True)
    (two / "docs" / "domain" / "glossary.md").write_text(
        "# Glossary\n\n- Real term one.\n- Real term two.\n", encoding="utf-8"
    )
    assert any(
        f.rule == "content-thin" and f.path == "docs/context/domain.md"
        for f in validate_layer(str(two), content=True).findings
    ), "two concrete bullets is still thin"

    three = tmp_path / "three"
    init_layer(str(three), yes=True)
    (three / "docs" / "domain" / "glossary.md").write_text(
        "# Glossary\n\n- One.\n- Two.\n- Three.\n", encoding="utf-8"
    )
    assert not any(
        f.rule == "content-thin" and f.path == "docs/context/domain.md"
        for f in validate_layer(str(three), content=True).findings
    ), "three concrete bullets clears the thin threshold"


def test_content_lint_flags_angle_bracket_placeholder_not_just_todo(tmp_path: Path) -> None:
    init_layer(str(tmp_path), yes=True)
    (tmp_path / "docs" / "system" / "invariants.md").write_text(
        "# Invariants\n\n- <describe an invariant here>\n", encoding="utf-8"
    )
    placeholders = [
        f
        for f in validate_layer(str(tmp_path), content=True).findings
        if f.rule == "content-placeholder"
    ]
    assert any(f.path == "docs/system/invariants.md" for f in placeholders)


def test_validate_content_flags_unconfirmed_inferences_and_proposed_decisions(
    tmp_path: Path,
) -> None:
    init_layer(str(tmp_path), yes=True)
    # An agent-drafted, owner-unconfirmed invariant marker.
    (tmp_path / "docs" / "system" / "invariants.md").write_text(
        "# System Invariants\n\n- TODO(confirm-invariant): money is integer minor units\n",
        encoding="utf-8",
    )
    # An agent-proposed decision, not yet owner-accepted.
    (tmp_path / "docs" / "decisions" / "0002-proposed.md").write_text(
        "---\nid: use-postgres\ntitle: Use Postgres\nstatus: proposed\ndate: 2026-06-18\n---\n\n"
        "# Use Postgres\n\n## Context\nx\n## Decision\ny\n## Consequences\nz\n",
        encoding="utf-8",
    )
    result = validate_layer(str(tmp_path), content=True)
    unconfirmed = [f for f in result.findings if f.rule == "content-unconfirmed"]
    assert any(f.path == "docs/system/invariants.md" for f in unconfirmed), (
        "flags the TODO(confirm-…) marker"
    )
    assert any("proposed" in f.message for f in unconfirmed), "flags the status: proposed decision"
    # Warning-only: an unconfirmed layer is not an error.
    assert [f for f in result.findings if f.severity == "error"] == []
    # The TODO(confirm-…) marker must NOT also trip the plain content-placeholder rule.
    assert not any(
        f.rule == "content-placeholder" and f.path == "docs/system/invariants.md"
        for f in result.findings
    )


# --- working mode (solo / team) ---


def _file_tree(dir_: Path) -> dict[str, str]:
    """Every file under dir (repo-relative POSIX), sorted, with contents."""
    out: dict[str, str] = {}
    for p in sorted(dir_.rglob("*")):
        if ".git" in p.parts or not p.is_file():
            continue
        out[str(p.relative_to(dir_)).replace(os.sep, "/")] = p.read_text(encoding="utf-8")
    return out


def test_init_mode_solo_scaffolds_identity_and_writing_style_starters(tmp_path: Path) -> None:
    result = init_layer(str(tmp_path), yes=True, mode="solo")

    assert result.mode == "solo"
    assert "docs/domain/identity.md" in result.written
    assert "docs/practice/writing-style.md" in result.written
    assert "## Source basis" in (tmp_path / "docs" / "domain" / "identity.md").read_text(
        encoding="utf-8"
    )
    assert "## Source basis" in (tmp_path / "docs" / "practice" / "writing-style.md").read_text(
        encoding="utf-8"
    )

    manifest = load_manifest(str(tmp_path)).manifest
    assert manifest is not None
    # Solo forces domain + practice; canonical category order in the manifest.
    assert list(manifest["categories"]) == ["domain", "system", "practice", "decisions"]


def test_solo_boot_profile_routes_identity_and_writing_work_by_task(tmp_path: Path) -> None:
    init_layer(str(tmp_path), yes=True, mode="solo")
    boot = (tmp_path / "docs" / "boot-profile.md").read_text(encoding="utf-8")

    unconditional = boot[: boot.index("Load by task type")]
    routed = boot[boot.index("Load by task type") :]
    assert "`docs/domain/identity.md`" in routed, "identity routed by task"
    assert "`docs/practice/writing-style.md`" in routed, "writing style routed by task"
    assert "identity.md" not in unconditional, "identity never in the unconditional set"
    assert "writing-style.md" not in unconditional, "writing style never in the unconditional set"


def test_solo_brief_is_mode_stamped_and_carries_interview_and_artifact_rules(
    tmp_path: Path,
) -> None:
    init_layer(str(tmp_path), yes=True, mode="solo")
    brief = (tmp_path / ".leji" / "work" / "onboarding-brief.md").read_text(encoding="utf-8")

    assert "**Working mode:** solo" in brief
    assert ".leji/work/onboarding-inputs/" in brief, "drop folder sits in the workspace role"
    assert "untrusted data" in brief, "artifact consent rules present"
    assert "<mode>" not in brief, "no unreplaced mode marker"
    assert "<root>/" not in brief, "no unreplaced root marker"


def test_omitted_mode_and_explicit_mode_team_are_byte_identical(tmp_path: Path) -> None:
    a = tmp_path / "a"
    b = tmp_path / "b"
    init_layer(str(a), yes=True, name="acme-context")
    result = init_layer(str(b), yes=True, name="acme-context", mode="team")

    assert result.mode == "team"
    tree_a = _file_tree(a)
    tree_b = _file_tree(b)
    assert list(tree_a.keys()) == list(tree_b.keys())

    # The scaffold now writes a context index at every level, and its `generatedAt`
    # is wall-clock: two runs a millisecond apart differ there and nowhere else.
    # Null it the way the cross-SDK parity harness does, so this stays a byte
    # comparison of everything the two modes actually control.
    def _stable(rel: str, content: str) -> str:
        if rel.endswith("context-index.json"):
            return re.sub(r'("generatedAt": ")[^"]*"', r"\1<GENERATED_AT>\"", content)
        return content

    for rel, content in tree_a.items():
        assert _stable(rel, content) == _stable(rel, tree_b.get(rel) or ""), (
            f"{rel} differs between omitted and explicit team"
        )
    assert not (a / "docs" / "domain" / "identity.md").exists(), (
        "team scaffolds no identity starter"
    )
    brief = (a / ".leji" / "work" / "onboarding-brief.md").read_text(encoding="utf-8")
    assert "**Working mode:** team" in brief, "team brief carries a concrete stamp"


def test_invalid_mode_fails_before_any_filesystem_mutation(tmp_path: Path) -> None:
    # Direct SDK callers can pass arbitrary strings; validation happens pre-write.
    with pytest.raises(RuntimeError, match="--mode must be solo or team"):
        init_layer(str(tmp_path), yes=True, mode="squad")
    assert list(tmp_path.iterdir()) == [], "nothing written"


def test_init_mode_solo_dry_run_writes_nothing_and_plans_both_starters(tmp_path: Path) -> None:
    result = init_layer(str(tmp_path), yes=True, mode="solo", dry_run=True)

    assert result.dry_run is True
    assert result.mode == "solo"
    assert result.written == []
    assert list(tmp_path.iterdir()) == [], "dry-run touches nothing"
    creates = [e.rel for e in result.plan if e.status == "create"]
    assert "docs/domain/identity.md" in creates
    assert "docs/practice/writing-style.md" in creates


def test_indexed_solo_init_seeds_changelog_with_starters_and_no_dot_paths(tmp_path: Path) -> None:
    init_layer(str(tmp_path), yes=True, mode="solo", level="indexed")
    changelog = json.loads(
        (tmp_path / "docs" / "context-changelog.json").read_text(encoding="utf-8")
    )
    paths = changelog["entries"][0]["paths"]

    assert "docs/domain/identity.md" in paths
    assert "docs/practice/writing-style.md" in paths
    assert not any(seg.startswith(".") for p in paths for seg in p.split("/")), (
        "the transient brief and other dot-paths never seed the machine changelog"
    )


def test_adopt_mode_solo_scaffolds_the_starters_and_maps_practice(tmp_path: Path) -> None:
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "notes.md").write_text("# Notes\n", encoding="utf-8")
    result = adopt_layer(str(tmp_path), yes=True, mode="solo")

    assert result.mode == "solo"
    assert "docs/domain/identity.md" in result.written
    assert "docs/practice/writing-style.md" in result.written
    manifest = load_manifest(str(tmp_path)).manifest
    assert manifest is not None
    assert list(manifest["categories"]) == ["domain", "system", "practice", "decisions"]


def test_adopt_mode_solo_never_overwrites_existing_identity_or_writing_style(
    tmp_path: Path,
) -> None:
    (tmp_path / "docs" / "domain").mkdir(parents=True)
    (tmp_path / "docs" / "domain" / "identity.md").write_text("# Mine already\n", encoding="utf-8")
    result = adopt_layer(str(tmp_path), yes=True, mode="solo")

    assert (tmp_path / "docs" / "domain" / "identity.md").read_text(
        encoding="utf-8"
    ) == "# Mine already\n"
    assert "docs/domain/identity.md" not in result.written, "existing file is skipped, not written"
    planned = next((e for e in result.plan if e.rel == "docs/domain/identity.md"), None)
    assert planned is not None and planned.status == "skip-exists"


def test_adopt_mode_solo_dry_run_writes_nothing_and_plans_the_starters(tmp_path: Path) -> None:
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "notes.md").write_text("# Notes\n", encoding="utf-8")
    result = adopt_layer(str(tmp_path), yes=True, mode="solo", dry_run=True)

    assert result.dry_run is True
    assert result.written == []
    assert not (tmp_path / "leji.json").exists()
    creates = [e.rel for e in result.plan if e.status == "create"]
    assert "docs/domain/identity.md" in creates
    assert "docs/practice/writing-style.md" in creates


def test_init_refuses_while_leji_files_are_tracked_leaving_tree_untouched(tmp_path: Path) -> None:
    _git_init(tmp_path)
    (tmp_path / ".leji").mkdir(parents=True)
    (tmp_path / ".leji" / "stale.md").write_text("tracked artifact\n", encoding="utf-8")
    _git_commit_all(tmp_path)

    with pytest.raises(RuntimeError, match="tracked by git"):
        init_layer(str(tmp_path), yes=True, mode="solo")
    assert not (tmp_path / "leji.json").exists(), "no scaffold written"
    assert not (tmp_path / ".gitignore").exists(), "not even the ignore file is written"


# Mirrors onboarding.test.ts "approval guard: installs idempotently and
# preserves existing settings".
def test_approval_guard_installs_idempotently_preserving_settings(tmp_path: Path) -> None:
    from leji.init_cmd import ensure_approval_guard

    (tmp_path / ".claude").mkdir()
    settings_path = tmp_path / ".claude" / "settings.json"
    settings_path.write_text(
        json.dumps(
            {
                "existing": True,
                "hooks": {
                    "PreToolUse": [
                        {"matcher": "Bash", "hooks": [{"type": "command", "command": "echo hi"}]}
                    ]
                },
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    assert ensure_approval_guard(str(tmp_path), "docs/") == "installed"
    assert ensure_approval_guard(str(tmp_path), "docs/") == "unchanged"
    raw = settings_path.read_text(encoding="utf-8")
    # Byte parity with Node's JSON.parse -> mutate -> JSON.stringify(_, null, 2).
    assert raw == (
        "{\n"
        '  "existing": true,\n'
        '  "hooks": {\n'
        '    "PreToolUse": [\n'
        "      {\n"
        '        "matcher": "Bash",\n'
        '        "hooks": [\n'
        "          {\n"
        '            "type": "command",\n'
        '            "command": "echo hi"\n'
        "          }\n"
        "        ]\n"
        "      },\n"
        "      {\n"
        '        "matcher": "AskUserQuestion",\n'
        '        "hooks": [\n'
        "          {\n"
        '            "type": "command",\n'
        '            "command": "node \\"$CLAUDE_PROJECT_DIR/.leji/work/hooks/approval-guard.mjs\\""\n'
        "          }\n"
        "        ]\n"
        "      }\n"
        "    ]\n"
        "  }\n"
        "}\n"
    )
    settings = json.loads(raw)
    assert settings["existing"] is True, "unrelated settings preserved"
    matchers = [e["matcher"] for e in settings["hooks"]["PreToolUse"]]
    assert matchers == ["Bash", "AskUserQuestion"]
    assert (tmp_path / ".leji" / "work" / "hooks" / "approval-guard.mjs").is_file()


# Mirrors onboarding.test.ts "approval guard: blocks until written and printed,
# inert after onboarding".
def test_approval_guard_blocks_until_written_and_printed_inert_after_onboarding(
    tmp_path: Path,
) -> None:
    import shutil

    from leji.init_cmd import ensure_approval_guard

    if shutil.which("node") is None:
        pytest.skip("node not on PATH")
    ensure_approval_guard(str(tmp_path), "docs/")
    leji_dir = tmp_path / ".leji" / "work"
    script = leji_dir / "hooks" / "approval-guard.mjs"
    (leji_dir / "onboarding-brief.md").write_text("brief", encoding="utf-8")

    def run_guard(transcript: str) -> int:
        proc = subprocess.run(
            ["node", str(script)],
            input=json.dumps({"transcript_path": transcript}),
            text=True,
            capture_output=True,
            env={**os.environ, "CLAUDE_PROJECT_DIR": str(tmp_path)},
        )
        return proc.returncode

    assert run_guard("/nonexistent") == 2, "no proposal: blocked"
    (leji_dir / "proposal.md").write_text("# Proposal for approval\n\nbody\n", encoding="utf-8")
    t1 = tmp_path / "t1.jsonl"
    t1.write_text(
        json.dumps(
            {
                "type": "assistant",
                "message": {"content": [{"type": "text", "text": "about to ask"}]},
            }
        )
        + "\n",
        encoding="utf-8",
    )
    assert run_guard(str(t1)) == 2, "written but not printed: blocked"
    t2 = tmp_path / "t2.jsonl"
    t2.write_text(
        json.dumps(
            {
                "type": "assistant",
                "message": {"content": [{"type": "text", "text": "# Proposal for approval\nbody"}]},
            }
        )
        + "\n",
        encoding="utf-8",
    )
    assert run_guard(str(t2)) == 0, "written and printed: allowed"
    (leji_dir / "onboarding-brief.md").unlink()
    assert run_guard("/nonexistent") == 0, "brief gone: guard inert"


def test_adopt_then_printed_wire_adapters_reaches_clean_layer(tmp_path: Path) -> None:
    _git_init(tmp_path)
    (tmp_path / "CLAUDE.md").write_text(
        "# Claude instructions\n\nNever deploy on Fridays.\n", encoding="utf-8"
    )
    _git_commit_all(tmp_path)

    adopted = adopt_layer(str(tmp_path), yes=True)
    assert adopted.draft, "a non-redirecting vendor file leaves an adoption draft"
    assert "leji adopt --wire-adapters" in entering_adopted(adopted)

    # The command it printed has to run against the layer it just created.
    wired = adopt_layer(str(tmp_path), yes=True, wire_adapters=True)
    assert wired.wired_only is True
    assert wired.wired == ["CLAUDE.md"]
    # The content was archived on the first pass, so wiring re-archives nothing.
    assert wired.migrated == []
    assert not (tmp_path / "docs" / "governance" / "imported-claude-2.md").exists()
    assert (tmp_path / "CLAUDE.md").read_text(encoding="utf-8") == (
        "Read ./docs/boot-profile.md first. "
        "It is the canonical context entrypoint for this repository.\n"
    )
    assert [f for f in validate_layer(str(tmp_path)).findings if f.severity == "error"] == []

    # Idempotent: everything already redirects, so there is nothing left to wire.
    again = adopt_layer(str(tmp_path), yes=True, wire_adapters=True)
    assert again.wired == []
    assert again.written == []
    assert "already redirects to the boot profile" in entering_adopted(again)


def test_wire_adapters_archives_vendor_file_edited_since_adoption(tmp_path: Path) -> None:
    _git_init(tmp_path)
    (tmp_path / "CLAUDE.md").write_text("original instructions\n", encoding="utf-8")
    _git_commit_all(tmp_path)
    adopt_layer(str(tmp_path), yes=True)
    (tmp_path / "CLAUDE.md").write_text(
        "hand-written rules added after adoption\n", encoding="utf-8"
    )

    wired = adopt_layer(str(tmp_path), yes=True, wire_adapters=True)
    assert wired.migrated == ["CLAUDE.md"], "the newer content is archived, never dropped"
    newer = (tmp_path / "docs" / "governance" / "imported-claude-2.md").read_text(encoding="utf-8")
    assert "hand-written rules added after adoption" in newer
    older = (tmp_path / "docs" / "governance" / "imported-claude.md").read_text(encoding="utf-8")
    assert "original" in older
    assert [f for f in validate_layer(str(tmp_path)).findings if f.severity == "error"] == []


def test_adopt_refuses_existing_layer_without_wire_adapters(tmp_path: Path) -> None:
    _git_init(tmp_path)
    (tmp_path / "README.md").write_text("# repo\n", encoding="utf-8")
    _git_commit_all(tmp_path)
    adopt_layer(str(tmp_path), yes=True)
    with pytest.raises(RuntimeError, match="already has a Leji layer"):
        adopt_layer(str(tmp_path), yes=True)


def test_hook_stale_index_message_is_literal_not_executed(tmp_path: Path) -> None:
    # Mirrors packages/sdk/test/onboarding.test.ts ("ci --hooks: the stale-index
    # message is literal text, not a command the hook runs").
    _git_init(tmp_path)
    init_layer(str(tmp_path), yes=True)
    _git_commit_all(tmp_path)
    ensure_local_hook(str(tmp_path))
    # A repo-local `leji` the hook prefers, so the run is hermetic.
    bin_dir = tmp_path / "node_modules" / ".bin"
    bin_dir.mkdir(parents=True)
    shim = bin_dir / "leji"
    shim.write_text(f'#!/bin/sh\nexec "{sys.executable}" -m leji.cli "$@"\n', encoding="utf-8")
    shim.chmod(0o755)
    # Stale the stored index, the exact condition the message describes.
    index_abs = tmp_path / "docs" / "context-index.json"
    before = index_abs.read_text(encoding="utf-8")
    (tmp_path / "docs" / "domain" / "extra.md").write_text(
        "---\nsummary: An extra domain doc.\n---\n\n# Extra\n", encoding="utf-8"
    )

    run = subprocess.run(
        ["sh", str(Path(".git") / "hooks" / "pre-commit")],
        cwd=tmp_path,
        capture_output=True,
        text=True,
    )
    assert run.returncode == 1, "the hook rejects the commit"
    # The backticks reach the message as literal characters; a double-quoted echo
    # would have run `leji index` and spliced its stdout in here instead.
    assert "leji: stored index is stale; run `leji index` and stage the result." in run.stderr, (
        f"message was not literal: {run.stderr}"
    )
    assert index_abs.read_text(encoding="utf-8") == before, (
        "the hook regenerated a governed artifact"
    )


def _tree_snapshot(directory: Path) -> dict[str, str]:
    """Every entry under `directory` as `path -> bytes` (symlinks by their target), so a
    run that must write nothing can be held to the whole tree rather than to one file."""
    out: dict[str, str] = {}

    def walk(rel: str) -> None:
        base = directory if rel == "" else directory / rel
        for entry in sorted(base.iterdir(), key=lambda p: p.name):
            child = entry.name if rel == "" else f"{rel}/{entry.name}"
            if entry.is_symlink():
                out[child] = f"link:{os.readlink(entry)}"
            elif entry.is_dir():
                walk(child)
            elif entry.is_file():
                out[child] = entry.read_bytes().hex()

    walk("")
    return out


# Mirrors units.test.ts "init: a .gitignore symlinked out of the repository is refused".
def test_init_refuses_a_gitignore_symlinked_out_of_the_repository(
    tmp_path: Path, tmp_path_factory: pytest.TempPathFactory
) -> None:
    # Previously the one unguarded write in init: the `.leji/` ignore line went out
    # through whatever `.gitignore` resolved to. It now goes through the chokepoint,
    # so a planted link out of the tree is a refusal with nothing written through it.
    away = Path(os.path.realpath(tmp_path_factory.mktemp("leji-ignore-away")))
    target = away / "gitignore"
    target.write_text("node_modules/\n", encoding="utf-8")
    (tmp_path / ".gitignore").symlink_to(target)

    with pytest.raises(
        RuntimeError, match="refusing to write through a symlink that escapes the target"
    ):
        init_layer(str(tmp_path), yes=True, name="demo-context")

    assert target.read_text(encoding="utf-8") == "node_modules/\n", (
        "the out-of-tree file is byte-untouched"
    )
    assert not (tmp_path / "leji.json").exists(), "the refusal came before any layer write"


# Mirrors units.test.ts "agent: a leji.json rewrite that would escape the repository is
# refused, and NOTHING is written".
def test_agent_refuses_an_escaping_manifest_and_writes_nothing(
    tmp_path: Path, tmp_path_factory: pytest.TempPathFactory
) -> None:
    # The other formerly unguarded write: the in-place manifest edit that binds the
    # agent. Binding is two writes (a profile file and the manifest edit), so the
    # manifest is judged through the verified read BEFORE either happens: a run that
    # cannot finish must not half-finish. Nothing is written, anywhere.
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    init_layer(str(tmp_path), yes=True, name="demo-context")
    m = load_manifest(str(tmp_path)).manifest
    assert m is not None
    away = Path(os.path.realpath(tmp_path_factory.mktemp("leji-agent-away")))
    manifest_abs = tmp_path / "leji.json"
    target = away / "leji.json"
    manifest_abs.rename(target)
    manifest_abs.symlink_to(target)
    before = target.read_text(encoding="utf-8")
    profile_abs = tmp_path / "docs" / "agents" / "reviewer.md"
    assert not profile_abs.exists(), "the profile does not exist before the run"
    snapshot = _tree_snapshot(tmp_path)

    with pytest.raises(
        RuntimeError,
        match='refusing to write through a symlink that escapes the target: "leji.json"',
    ):
        add_agent(str(tmp_path), m, host=None, name="reviewer")

    assert target.read_text(encoding="utf-8") == before, "the out-of-tree manifest is untouched"
    assert not profile_abs.exists(), "the profile was never written"
    assert _tree_snapshot(tmp_path) == snapshot, "the whole tree is byte-identical"


# Mirrors onboarding.test.ts "leji agent: a dangling profile name refuses the command,
# writing neither half".
def test_agent_dangling_profile_name_refuses_both_halves(tmp_path: Path) -> None:
    # An existence check follows symlinks, so a dangling profile link read as absent and
    # the profile was written at the link's destination. Both halves are judged before
    # either is written, so a refused profile leaves the manifest binding unwritten too.
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    init_layer(str(tmp_path), yes=True, name="demo-context")
    m = load_manifest(str(tmp_path)).manifest
    assert m is not None
    link = tmp_path / "docs" / "agents" / "reviewer.md"
    link.parent.mkdir(parents=True, exist_ok=True)
    link.symlink_to("never-created.md")
    before = (tmp_path / "leji.json").read_text(encoding="utf-8")

    with pytest.raises(
        RuntimeError, match="refusing to write through a symlink that escapes the target"
    ):
        add_agent(str(tmp_path), m, host="codex", name="reviewer")

    assert not (tmp_path / "docs" / "agents" / "never-created.md").exists(), (
        "the dangling link's destination is never created"
    )
    assert (tmp_path / "leji.json").read_text(encoding="utf-8") == before, (
        "the manifest is not rewritten"
    )
    assert link.is_symlink(), "the planted link is left exactly as it was"


# Mirrors onboarding.test.ts "adopt: a dangling scaffold name is occupied, and the
# alternate name is scaffolded".
def test_adopt_dangling_scaffold_name_is_occupied_and_falls_back(tmp_path: Path) -> None:
    # The scaffold names were picked with an existence check, which follows symlinks: a
    # dangling boot-profile link read as a free name, and the scaffold would have been
    # written at the link's missing destination. The standing entry makes the name
    # occupied, so the alternate is taken exactly as it is for an ordinary existing file.
    _git_init(tmp_path)
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "notes.md").write_text("# Notes\n", encoding="utf-8")
    link = tmp_path / "docs" / "boot-profile.md"
    link.symlink_to("never-created.md")
    _git_commit_all(tmp_path)

    res = adopt_layer(str(tmp_path), yes=True)

    assert res.manifest["bootProfilePath"] == "docs/leji-boot-profile.md", (
        "the alternate name is scaffolded"
    )
    assert not (tmp_path / "docs" / "never-created.md").exists(), (
        "the dangling link's destination is never created"
    )
    assert link.is_symlink(), "the planted link is left exactly as it was"
