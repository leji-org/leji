"""Onboarding overhaul tests, mirroring packages/sdk/test/onboarding.test.ts."""

import os
import re
import subprocess
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
from leji.init_cmd import add_agent


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
    assert "docs/.leji/onboarding-brief.md" in creates
    # The existing vendor file is detected and explicitly left untouched.
    untouched = next((e for e in result.plan if e.rel == "CLAUDE.md"), None)
    assert untouched is not None and untouched.status == "wont-modify"


def test_init_writes_brief_under_dot_dir_excluded_from_index(tmp_path: Path) -> None:
    init_layer(str(tmp_path), yes=True, level="indexed", name="acme-context")

    brief = tmp_path / "docs" / ".leji" / "onboarding-brief.md"
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


def test_init_agent_rejects_unknown_host(tmp_path: Path) -> None:
    # init --agent no longer resolves a vendor adapter, so a bogus --agent no
    # longer errors from adapter resolution: the layer scaffolds with no vendor file.
    res = init_layer(str(tmp_path), yes=True, agent="frobnicate")
    assert "leji.json" in res.written
    manifest = load_manifest(str(tmp_path)).manifest
    assert manifest is not None
    assert "vendorAdapters" not in manifest
    assert not (tmp_path / "CLAUDE.md").exists()


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
    # The agent's binding; no vendor adapter is created.
    assert manifest["agents"]["reviewer"] == "docs/agents/reviewer.md"
    assert "vendorAdapters" not in manifest
    assert not (tmp_path / "AGENTS.md").exists()
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


def test_init_agent_cursor_wires_directory_style_adapter_validates_clean(
    tmp_path: Path,
) -> None:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    res = init_layer(str(tmp_path), yes=True, agent="cursor")
    assert ".cursor/rules/leji.md" not in res.written, "init --agent no longer creates an adapter"
    assert not (tmp_path / ".cursor" / "rules" / "leji.md").exists()
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


def test_render_detect_handles_no_hosts_case_and_ranked_case() -> None:
    assert "No coding-agent hosts detected" in render_detect([])
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
        ]
    )
    assert re.search(r"confirmed.*Claude Code.*binary on PATH.*CLAUDE\.md", ranked)
    assert "leji init --agent" in ranked


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
        f.rule == "content-thin" and f.path == "docs/domain/"
        for f in validate_layer(str(two), content=True).findings
    ), "two concrete bullets is still thin"

    three = tmp_path / "three"
    init_layer(str(three), yes=True)
    (three / "docs" / "domain" / "glossary.md").write_text(
        "# Glossary\n\n- One.\n- Two.\n- Three.\n", encoding="utf-8"
    )
    assert not any(
        f.rule == "content-thin" and f.path == "docs/domain/"
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
