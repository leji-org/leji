"""Single-level agent-profile inheritance: resolution, findings, and the viewer.

Mirrors packages/sdk/test/inherits.test.ts. Composition, the four resolution error
findings, the profile set that includes agents-bound out-of-directory profiles, the
schema's conditional requirement, and the viewer's fail-closed rendering.
"""

from __future__ import annotations

import json
import shutil
import threading
import urllib.request
from pathlib import Path
from typing import Any, Optional

from leji.findings import Finding
from leji.layer import (
    ScannedProfile,
    profile_inheritance_findings,
    resolve_agent_profile,
    scan_profile_set,
)
from leji.manifest import load_manifest
from leji.schemas import schema_errors
from leji.validate import validate_layer
from leji.serve_cmd import serve_viewer
from leji.viewer_cmd import generate_viewer, resolved_profile_page

REPO_ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = REPO_ROOT / "examples" / "monorepo"

# Minimal posture a base must supply for a resolved profile to be complete.
BASE_POSTURE = {"requiredRead": ["docs/boot-profile.md"], "mustAskWhen": ["ask"]}

# Frontmatter lines every valid profile in these fixtures carries.
POSTURE_YAML = "requiredRead:\n  - docs/boot-profile.md\nmustAskWhen:\n  - always\n"


def copy_example(tmp_path: Path, name: str = "layer") -> Path:
    dest = tmp_path / name
    shutil.copytree(EXAMPLE, dest)
    return dest


def write_profile(directory: Path, name: str, frontmatter: str, body: Optional[str] = None) -> None:
    text = f"---\n{frontmatter}---\n{body if body is not None else f'{chr(10)}# {name}{chr(10)}'}"
    (directory / "docs" / "agents" / f"{name}.md").write_text(text, encoding="utf-8")


def write_out_of_dir_profile(
    directory: Path, name: str, frontmatter: str, body: Optional[str] = None
) -> str:
    """Write a profile OUTSIDE the declared agentProfilesPath and return its rel."""
    (directory / "docs" / "roles").mkdir(parents=True, exist_ok=True)
    text = f"---\n{frontmatter}---\n{body if body is not None else f'{chr(10)}# {name}{chr(10)}'}"
    (directory / "docs" / "roles" / f"{name}.md").write_text(text, encoding="utf-8")
    return f"docs/roles/{name}.md"


def bind_agent(directory: Path, role: str, rel: str) -> None:
    p = directory / "leji.json"
    manifest = json.loads(p.read_text(encoding="utf-8"))
    manifest["agents"] = {**(manifest.get("agents") or {}), role: rel}
    p.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def profile(rel_path: str, frontmatter: Optional[dict[str, Any]], body: str = "") -> ScannedProfile:
    return ScannedProfile(rel_path=rel_path, frontmatter=frontmatter, body=body, findings=[])


# --- resolution: composition ---


def test_posture_unions_base_first_dropping_derived_duplicates() -> None:
    base = profile(
        "docs/agents/core.md",
        {
            "id": "core",
            "name": "Core",
            "role": "core",
            "requiredRead": ["docs/boot-profile.md", "docs/system/invariants.md"],
            "mustAskWhen": ["b-first", "b-second"],
            "defaultContext": ["system"],
        },
    )
    derived = profile(
        "docs/agents/reviewer.md",
        {
            "id": "reviewer",
            "name": "Reviewer",
            "role": "reviewer",
            "inherits": "core",
            # 'docs/boot-profile.md' repeats the base; 'zzz' sorts last but is first.
            "requiredRead": ["zzz.md", "docs/boot-profile.md", "aaa.md"],
            "mustAskWhen": ["d-only", "b-second"],
            "defaultContext": ["decisions", "system"],
            "mustRefuseWhen": ["refuse-this"],
        },
    )
    r = resolve_agent_profile(derived, [base, derived])
    assert r.findings == []
    assert r.source_ids == ["core", "reviewer"]
    assert r.frontmatter is not None
    assert r.frontmatter["requiredRead"] == [
        "docs/boot-profile.md",
        "docs/system/invariants.md",
        "zzz.md",
        "aaa.md",
    ]
    assert r.frontmatter["mustAskWhen"] == ["b-first", "b-second", "d-only"]
    assert r.frontmatter["defaultContext"] == ["system", "decisions"]
    # No cross-array dedup: the reader rule handles ask/refuse overlap, not resolution.
    assert r.frontmatter["mustRefuseWhen"] == ["refuse-this"]


def test_every_non_posture_field_is_derived_local() -> None:
    base = profile(
        "docs/agents/core.md",
        {
            "id": "core",
            "name": "Core",
            "role": "core",
            "purpose": "base purpose",
            "version": "1.0",
            "host": "codex",
            "invocation": {"command": "codex exec <prompt>"},
            "escalation": "base escalation",
            "owners": ["base-owner"],
            "freshness": {"reviewAfter": "2030-01-01"},
            "requiredRead": ["docs/boot-profile.md"],
            "mustAskWhen": ["ask"],
        },
    )
    derived = profile(
        "docs/agents/reviewer.md",
        {"id": "reviewer", "name": "Reviewer", "role": "reviewer", "inherits": "core"},
    )
    fm = resolve_agent_profile(derived, [base, derived]).frontmatter
    assert fm is not None
    assert "inherits" not in fm
    for key in ("purpose", "version", "host", "invocation", "escalation", "owners", "freshness"):
        assert key not in fm, f"{key} must never be inherited"
    assert [fm["id"], fm["name"], fm["role"]] == ["reviewer", "Reviewer", "reviewer"]
    # Posture the derived profile omits entirely still comes from the base.
    assert fm["requiredRead"] == ["docs/boot-profile.md"]
    assert fm["mustAskWhen"] == ["ask"]


def test_both_bodies_are_operative_base_first_behind_source_markers() -> None:
    base = profile(
        "docs/agents/core.md",
        {"id": "core", "name": "Core", "role": "core", **BASE_POSTURE},
        "\n# Core\n\nBase text.\r\n",
    )
    derived = profile(
        "docs/agents/reviewer.md",
        {"id": "reviewer", "name": "Reviewer", "role": "reviewer", "inherits": "core"},
        "\n# Reviewer\n\nDerived text.\n",
    )
    body = resolve_agent_profile(derived, [base, derived]).body
    assert body == (
        "<!-- inherited from: core -->\n\n# Core\n\nBase text.\n\n"
        "<!-- reviewer -->\n\n# Reviewer\n\nDerived text.\n"
    )
    assert "\r" not in body
    assert body.endswith("\n") and not body.endswith("\n\n")


def test_composition_alters_neither_body_only_endings_and_the_boundary() -> None:
    # A leading indented code block and a trailing hard break are both
    # body-significant markdown that a strip() would destroy.
    base = profile(
        "docs/agents/core.md",
        {"id": "core", "name": "Core", "role": "core", **BASE_POSTURE},
        "\n    indented code\n\n> quoted\r\n\ttabbed\n",
    )
    derived = profile(
        "docs/agents/reviewer.md",
        {"id": "reviewer", "name": "Reviewer", "role": "reviewer", "inherits": "core"},
        "\nline with a hard break  \n\n\n",
    )
    body = resolve_agent_profile(derived, [base, derived]).body
    assert body is not None
    assert "<!-- inherited from: core -->\n\n    indented code\n" in body
    assert "\n\ttabbed\n" in body
    assert "> quoted\n" in body and "\r" not in body
    assert body.endswith("line with a hard break  \n")


def test_duplicates_within_one_authored_array_survive() -> None:
    base = profile(
        "docs/agents/core.md",
        {
            "id": "core",
            "name": "Core",
            "role": "core",
            "requiredRead": ["a.md", "a.md"],
            "mustAskWhen": ["ask", "ask"],
        },
    )
    derived = profile(
        "docs/agents/reviewer.md",
        {
            "id": "reviewer",
            "name": "Reviewer",
            "role": "reviewer",
            "inherits": "core",
            "requiredRead": ["b.md", "b.md", "a.md"],
            "mustAskWhen": ["own", "own"],
        },
    )
    fm = resolve_agent_profile(derived, [base, derived]).frontmatter
    assert fm is not None
    # First-occurrence dedup applies across the edge only: the base's own repeat and
    # the derived profile's own repeat are authored intent and stay.
    assert fm["requiredRead"] == ["a.md", "a.md", "b.md", "b.md"]
    assert fm["mustAskWhen"] == ["ask", "ask", "own", "own"]


def test_a_profile_with_no_inherits_resolves_to_itself() -> None:
    solo = profile(
        "docs/agents/core.md", {"id": "core", "name": "Core", "role": "core"}, "\n# Core\n"
    )
    r = resolve_agent_profile(solo, [solo])
    assert r.findings == []
    assert r.source_ids == ["core"]
    assert r.body == "# Core\n"


# --- resolution: the four error findings ---


def test_an_unresolvable_inheritance_yields_findings_and_no_partial_profile() -> None:
    core = profile("docs/agents/core.md", {"id": "core", "name": "Core", "role": "core"})
    other = profile("docs/agents/other.md", {"id": "other", "name": "Other", "role": "other"})
    dupe = profile("docs/agents/dupe.md", {"id": "core", "name": "Dupe", "role": "core"})
    grand = profile(
        "docs/agents/grand.md", {"id": "grand", "name": "Grand", "role": "core", **BASE_POSTURE}
    )
    inheriting_core = profile(
        "docs/agents/core.md",
        {"id": "core", "name": "Core", "role": "core", "inherits": "grand", **BASE_POSTURE},
    )

    cases = [
        (
            "unknown target",
            profile("docs/agents/a.md", {"id": "a", "name": "A", "role": "a", "inherits": "ghost"}),
            [core],
            "inherits-unknown",
        ),
        (
            "ambiguous target",
            profile("docs/agents/b.md", {"id": "b", "name": "B", "role": "b", "inherits": "core"}),
            [core, dupe],
            "inherits-ambiguous-target",
        ),
        (
            "target is not core",
            profile("docs/agents/c.md", {"id": "c", "name": "C", "role": "c", "inherits": "other"}),
            [other],
            "inherits-target-not-core",
        ),
        (
            "self-reference by a non-core profile",
            profile("docs/agents/d.md", {"id": "d", "name": "D", "role": "d", "inherits": "d"}),
            [],
            "inherits-target-not-core",
        ),
        (
            "core declares inherits",
            profile(
                "docs/agents/e.md", {"id": "e", "name": "E", "role": "core", "inherits": "core"}
            ),
            [core],
            "inherits-on-core",
        ),
        (
            "core inherits itself",
            profile("docs/agents/f.md", {"id": "f", "name": "F", "role": "core", "inherits": "f"}),
            [],
            "inherits-on-core",
        ),
        (
            # Without this rule a derived profile would resolve through an inheriting
            # core and get an effective profile the single-level rule forbids.
            "the base itself declares inherits",
            profile("docs/agents/g.md", {"id": "g", "name": "G", "role": "g", "inherits": "core"}),
            [grand, inheriting_core],
            "inherits-on-core",
        ),
    ]

    for name, derived, profile_set, rule in cases:
        r = resolve_agent_profile(derived, [*profile_set, derived])
        assert len(r.findings) == 1, name
        assert r.findings[0].rule == rule, name
        assert r.findings[0].severity == "error", name
        assert r.findings[0].path == derived.rel_path, name
        # No partial effective profile survives a resolution error.
        assert r.frontmatter is None, name
        assert r.body is None, name
        assert r.source_ids == [], name


def test_each_resolution_error_surfaces_on_the_profile_scan(tmp_path: Path) -> None:
    cases = [
        ("ghost", "id: ghosted\nname: G\nrole: g\ninherits: ghost\n", "inherits-unknown"),
        (
            "notcore",
            "id: notcore\nname: N\nrole: n\ninherits: thought-partner\n",
            "inherits-target-not-core",
        ),
        ("oncore", "id: oncore\nname: O\nrole: core\ninherits: core\n", "inherits-on-core"),
    ]
    for i, (name, frontmatter, rule) in enumerate(cases):
        directory = copy_example(tmp_path, f"layer-{i}")
        write_profile(directory, name, frontmatter)
        findings = [
            f for f in validate_layer(str(directory)).findings if f.path == f"docs/agents/{name}.md"
        ]
        assert any(f.rule == rule and f.severity == "error" for f in findings), (name, findings)


def test_two_profiles_declaring_the_target_id_are_an_ambiguous_target(tmp_path: Path) -> None:
    directory = copy_example(tmp_path)
    write_profile(directory, "core-twin", f"id: core\nname: Twin\nrole: core\n{POSTURE_YAML}")
    findings = validate_layer(str(directory)).findings
    assert any(
        f.rule == "inherits-ambiguous-target"
        and f.severity == "error"
        and f.path == "docs/agents/thought-partner.md"
        for f in findings
    ), findings


def test_a_base_that_declares_inherits_breaks_every_profile_that_names_it(tmp_path: Path) -> None:
    directory = copy_example(tmp_path)
    write_profile(directory, "grand", f"id: grand\nname: Grand\nrole: core\n{POSTURE_YAML}")
    # Make the example's core profile inherit, so the single-level rule is violated
    # one hop above the profile that actually uses it.
    core_rel = directory / "docs" / "agents" / "core.md"
    core_rel.write_text(
        core_rel.read_text(encoding="utf-8").replace(
            "role: core\n", "role: core\ninherits: grand\n"
        ),
        encoding="utf-8",
    )
    findings = validate_layer(str(directory)).findings
    # The base is flagged on its own account...
    assert any(
        f.rule == "inherits-on-core" and f.path == "docs/agents/core.md" for f in findings
    ), findings
    # ...and so is the derived profile that can no longer resolve through it.
    assert any(
        f.rule == "inherits-on-core"
        and f.severity == "error"
        and f.path == "docs/agents/thought-partner.md"
        and "itself declares inherits" in f.message
        for f in findings
    ), findings


# --- resolution: source findings and the effective result ---


def test_an_error_on_either_source_refuses_resolution_and_carries_forward() -> None:
    schema_error = Finding(
        "profile-frontmatter", "error", "/requiredRead must NOT have fewer than 1 items"
    )
    ok_base = profile(
        "docs/agents/core.md", {"id": "core", "name": "Core", "role": "core", **BASE_POSTURE}
    )
    ok_derived = profile(
        "docs/agents/reviewer.md",
        {"id": "reviewer", "name": "Reviewer", "role": "reviewer", "inherits": "core"},
    )
    bad_base = ScannedProfile(ok_base.rel_path, ok_base.frontmatter, ok_base.body, [schema_error])
    bad_derived = ScannedProfile(
        ok_derived.rel_path, ok_derived.frontmatter, ok_derived.body, [schema_error]
    )
    for name, base, derived in (
        ("the base is invalid", bad_base, ok_derived),
        ("the derived profile is invalid", ok_base, bad_derived),
    ):
        r = resolve_agent_profile(derived, [base, derived])
        assert r.findings == [schema_error], name
        assert r.frontmatter is None, name
        assert r.body is None, name
        assert r.source_ids == [], name

    # A validator that already reported the scan's findings does not see them twice.
    assert profile_inheritance_findings([bad_base, ok_derived]) == []


def test_an_effective_profile_missing_required_posture_is_refused() -> None:
    for missing, base_posture in (
        ("requiredRead", {"mustAskWhen": ["ask"]}),
        ("mustAskWhen", {"requiredRead": ["docs/boot-profile.md"]}),
    ):
        base = profile(
            "docs/agents/core.md", {"id": "core", "name": "Core", "role": "core", **base_posture}
        )
        derived = profile(
            "docs/agents/reviewer.md",
            {"id": "reviewer", "name": "Reviewer", "role": "reviewer", "inherits": "core"},
        )
        r = resolve_agent_profile(derived, [base, derived])
        assert len(r.findings) == 1, missing
        assert r.findings[0].rule == "profile-frontmatter", missing
        assert f"no {missing}" in r.findings[0].message, missing
        assert r.frontmatter is None, missing
        assert r.body is None, missing


def test_an_id_that_is_not_identifier_shaped_never_reaches_the_body_markers() -> None:
    injected = "x --> <script>alert(1)</script> <!-- y"
    ok_base = profile(
        "docs/agents/core.md", {"id": "core", "name": "Core", "role": "core", **BASE_POSTURE}
    )
    bad_derived = profile(
        "docs/agents/evil.md",
        {"id": injected, "name": "Evil", "role": "evil", "inherits": "core"},
    )
    from_derived = resolve_agent_profile(bad_derived, [ok_base, bad_derived])
    assert from_derived.body is None
    assert from_derived.findings[0].rule == "profile-frontmatter"
    assert from_derived.findings[0].path == "docs/agents/evil.md"

    bad_base = profile(
        "docs/agents/core.md", {"id": injected, "name": "Core", "role": "core", **BASE_POSTURE}
    )
    derived = profile(
        "docs/agents/reviewer.md",
        {"id": "reviewer", "name": "Reviewer", "role": "reviewer", "inherits": injected},
    )
    from_base = resolve_agent_profile(derived, [bad_base, derived])
    assert from_base.body is None
    assert from_base.findings[0].rule == "profile-frontmatter"
    assert from_base.findings[0].path == "docs/agents/core.md"


# --- the profile set: agents-bound profiles outside agentProfilesPath ---


def test_an_out_of_directory_profile_is_validated_like_a_directory_one(tmp_path: Path) -> None:
    directory = copy_example(tmp_path)
    rel = write_out_of_dir_profile(
        directory, "outbase", f"id: outbase\nname: Out\nrole: core\nhost: 5\n{POSTURE_YAML}"
    )
    bind_agent(directory, "outbase", rel)
    manifest = load_manifest(str(directory)).manifest
    assert manifest is not None
    base = next(p for p in scan_profile_set(str(directory), manifest) if p.rel_path == rel)
    assert any(
        f.rule == "profile-frontmatter" and f.severity == "error" and "host" in f.message
        for f in base.findings
    ), base.findings


def test_an_invalid_out_of_directory_base_refuses_resolution(tmp_path: Path) -> None:
    directory = copy_example(tmp_path)
    rel = write_out_of_dir_profile(
        directory, "outbase", f"id: outbase\nname: Out\nrole: core\nhost: 5\n{POSTURE_YAML}"
    )
    bind_agent(directory, "outbase", rel)
    write_profile(directory, "derived", "id: derived\nname: D\nrole: d\ninherits: outbase\n")
    manifest = load_manifest(str(directory)).manifest
    assert manifest is not None
    profiles = scan_profile_set(str(directory), manifest)
    base = next(p for p in profiles if p.rel_path == rel)
    derived = next(p for p in profiles if p.rel_path == "docs/agents/derived.md")
    r = resolve_agent_profile(derived, profiles)
    assert r.frontmatter is None
    assert r.body is None
    assert r.source_ids == []
    assert r.findings == base.findings


def test_an_invalid_out_of_directory_derived_profile_refuses_resolution(tmp_path: Path) -> None:
    directory = copy_example(tmp_path)
    rel = write_out_of_dir_profile(
        directory, "outderived", "id: outderived\nname: Out\nrole: out\ninherits: core\nhost: 5\n"
    )
    bind_agent(directory, "outderived", rel)
    manifest = load_manifest(str(directory)).manifest
    assert manifest is not None
    profiles = scan_profile_set(str(directory), manifest)
    derived = next(p for p in profiles if p.rel_path == rel)
    assert derived.findings
    r = resolve_agent_profile(derived, profiles)
    assert r.frontmatter is None
    assert r.body is None
    assert r.findings == derived.findings


def test_a_valid_out_of_directory_base_still_resolves(tmp_path: Path) -> None:
    directory = copy_example(tmp_path)
    rel = write_out_of_dir_profile(
        directory,
        "outbase",
        f"id: outbase\nname: Out\nrole: core\n{POSTURE_YAML}",
        "\nBASE PROSE\n",
    )
    bind_agent(directory, "outbase", rel)
    write_profile(
        directory,
        "derived",
        "id: derived\nname: D\nrole: d\ninherits: outbase\n",
        "\nDERIVED PROSE\n",
    )
    manifest = load_manifest(str(directory)).manifest
    assert manifest is not None
    profiles = scan_profile_set(str(directory), manifest)
    derived = next(p for p in profiles if p.rel_path == "docs/agents/derived.md")
    r = resolve_agent_profile(derived, profiles)
    assert r.findings == []
    assert r.source_ids == ["outbase", "derived"]
    assert r.frontmatter is not None and r.frontmatter["requiredRead"] == ["docs/boot-profile.md"]
    assert r.body is not None and "BASE PROSE" in r.body and "DERIVED PROSE" in r.body


def test_an_invalid_out_of_directory_profile_is_reported_once(tmp_path: Path) -> None:
    directory = copy_example(tmp_path)
    rel = write_out_of_dir_profile(
        directory, "outbase", f"id: outbase\nname: Out\nrole: core\nhost: 5\n{POSTURE_YAML}"
    )
    bind_agent(directory, "outbase", rel)
    write_profile(directory, "derived", "id: derived\nname: D\nrole: d\ninherits: outbase\n")
    findings = validate_layer(str(directory)).findings
    assert any(
        f.path == rel and f.rule == "profile-frontmatter" and f.severity == "error"
        for f in findings
    ), findings
    # The agents-map check and resolution both validate this file; their findings are
    # byte-identical, so the pair collapses instead of double-reporting.
    keys = [f"{f.path or ''}|{f.rule}|{f.severity}|{f.message}" for f in findings]
    assert [k for i, k in enumerate(keys) if keys.index(k) != i] == []


# --- schema: the conditional requirement ---


def test_posture_arrays_are_required_only_without_inherits() -> None:
    without = {"id": "a", "name": "A", "role": "a"}
    assert schema_errors("agent-profile", without)
    assert schema_errors("agent-profile", {**without, "inherits": "core"}) == []
    assert (
        schema_errors(
            "agent-profile", {**without, "requiredRead": ["docs/x.md"], "mustAskWhen": ["ask"]}
        )
        == []
    )


def test_an_explicitly_empty_posture_array_stays_invalid() -> None:
    base = {"id": "a", "name": "A", "role": "a", "inherits": "core"}
    assert schema_errors("agent-profile", {**base, "requiredRead": []})
    assert schema_errors("agent-profile", {**base, "mustAskWhen": []})


def test_a_profile_omitting_both_arrays_under_inherits_validates(tmp_path: Path) -> None:
    directory = copy_example(tmp_path)
    write_profile(directory, "lean", "id: lean\nname: Lean\nrole: lean\ninherits: core\n")
    assert [
        f for f in validate_layer(str(directory)).findings if f.path == "docs/agents/lean.md"
    ] == []


def test_an_explicitly_empty_array_under_inherits_is_still_rejected(tmp_path: Path) -> None:
    directory = copy_example(tmp_path)
    write_profile(
        directory,
        "empty",
        "id: empty\nname: Empty\nrole: empty\ninherits: core\nrequiredRead: []\n",
    )
    findings = [
        f for f in validate_layer(str(directory)).findings if f.path == "docs/agents/empty.md"
    ]
    assert any(f.rule == "profile-frontmatter" and f.severity == "error" for f in findings), (
        findings
    )


# --- viewer ---


def test_an_inheriting_profile_renders_resolved_naming_both_sources(tmp_path: Path) -> None:
    directory = copy_example(tmp_path)
    manifest = load_manifest(str(directory)).manifest
    assert manifest is not None
    page = resolved_profile_page(str(directory), manifest, "docs/agents/thought-partner.md")
    assert page is not None
    assert "<!-- inherited from: core -->" in page
    assert "<!-- thought-partner -->" in page
    assert "docs/agents/core.md" in page
    assert "docs/agents/thought-partner.md" in page
    # Posture entries are labelled with the profile that supplied them.
    assert "`docs/system/invariants.md` (from `core`)" in page
    assert "from `thought-partner`" in page
    # A profile with no inherits is served from disk as authored.
    assert resolved_profile_page(str(directory), manifest, "docs/agents/core.md") is None
    assert resolved_profile_page(str(directory), manifest, "docs/domain/glossary.md") is None


def test_an_unresolvable_profile_shows_findings_never_the_derived_file(tmp_path: Path) -> None:
    directory = copy_example(tmp_path)
    write_profile(
        directory,
        "broken",
        "id: broken\nname: Broken\nrole: broken\ninherits: ghost\n",
        "\nDERIVED BODY MARKER\n",
    )
    manifest = load_manifest(str(directory)).manifest
    assert manifest is not None
    page = resolved_profile_page(str(directory), manifest, "docs/agents/broken.md")
    assert page is not None
    assert "does not resolve" in page
    assert "inherits-unknown" in page
    assert "DERIVED BODY MARKER" not in page


def test_a_resolution_that_raises_still_refuses_the_derived_file(tmp_path: Path) -> None:
    directory = copy_example(tmp_path)
    write_profile(
        directory,
        "broken",
        "id: broken\nname: Broken\nrole: broken\ninherits: core\n",
        "\nDERIVED BODY MARKER\n",
    )
    # Binds the file (so it classifies as a profile) but makes the profile scan
    # raise: the branch that must never fall through to the file on disk.
    hostile: Any = {"rootPath": 5, "agents": {"x": "docs/agents/broken.md"}}
    page = resolved_profile_page(str(directory), hostile, "docs/agents/broken.md")
    assert page is not None
    assert "unresolved profile" in page
    assert "DERIVED BODY MARKER" not in page
    # A document that is not half a profile is still handed back to the file on disk.
    assert resolved_profile_page(str(directory), hostile, "docs/domain/glossary.md") is None


def test_the_http_route_never_serves_an_unresolvable_profile_as_authored(tmp_path: Path) -> None:
    directory = copy_example(tmp_path)
    write_profile(
        directory,
        "broken",
        "id: broken\nname: Broken\nrole: broken\ninherits: ghost\n",
        "\nDERIVED BODY MARKER\n",
    )
    manifest = load_manifest(str(directory)).manifest
    assert manifest is not None
    generate_viewer(str(directory), manifest)
    server = serve_viewer(str(directory), 0, manifest["rootPath"])
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_address[1]

        def get(p: str) -> str:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}{p}") as res:
                return res.read().decode("utf-8")

        broken = get("/content/agents/broken.md")
        assert "DERIVED BODY MARKER" not in broken
        assert "inherits-unknown" in broken
        # The resolved and the untouched cases still behave.
        assert "resolved profile" in get("/content/agents/thought-partner.md")
        assert get("/content/agents/core.md").startswith("---")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


# --- live evidence: this repository's own profiles ---


def test_this_layers_own_inheriting_profiles_resolve_cleanly() -> None:
    manifest = load_manifest(str(REPO_ROOT)).manifest
    assert manifest is not None
    profiles = scan_profile_set(str(REPO_ROOT), manifest)
    inheriting = [p for p in profiles if isinstance((p.frontmatter or {}).get("inherits"), str)]
    assert any(p.rel_path == "docs/agents/reviewer.md" for p in inheriting)
    for p in inheriting:
        r = resolve_agent_profile(p, profiles)
        assert r.findings == [], p.rel_path
        assert r.source_ids[0] == "core", p.rel_path
        assert r.frontmatter is not None and isinstance(r.frontmatter["requiredRead"], list)
        assert r.body is not None and r.body.startswith("<!-- inherited from: core -->")
