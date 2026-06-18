"""Conformance scoring against the four-level checklist."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .findings import Finding, sort_findings
from .freshness import freshness_report
from .gitutil import git_toplevel
from .indexgen import check_index
from .layer import scan_agent_profiles
from .manifest import (
    CONFORMANCE_LEVELS,
    claimed_level,
    effective_changelog_path,
    load_manifest,
)
from .validate import check_changelog_append_only, validate_layer


@dataclass
class ChecklistItem:
    id: str
    level: str
    description: str
    status: str  # pass | fail | manual
    detail: Optional[str] = None

    def to_dict(self) -> dict:
        out = {
            "id": self.id,
            "level": self.level,
            "description": self.description,
            "status": self.status,
        }
        if self.detail is not None:
            out["detail"] = self.detail
        return out


@dataclass
class ConformanceResult:
    claimed_level: Optional[str]
    verified_level: Optional[str]
    items: list[ChecklistItem] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)


def conformance_report(root: str) -> ConformanceResult:
    """Machine-checkable items pass or fail; process items (review gate, CI,
    federation consumers) are reported as `manual` and never block a level.
    A claim above the verified level is an error."""
    items: list[ChecklistItem] = []
    findings: list[Finding] = []
    manifest = load_manifest(root).manifest

    validation = validate_layer(root)

    def errors_by(rules: list[str], path_filter=None) -> list[Finding]:
        out = [f for f in validation.findings if f.severity == "error" and f.rule in rules]
        if path_filter is not None:
            out = [f for f in out if path_filter(f.path)]
        return out

    def add(
        item_id: str, level: str, description: str, status: str, detail: Optional[str] = None
    ) -> None:
        items.append(ChecklistItem(item_id, level, description, status, detail))

    # --- core ---
    manifest_errors = errors_by(
        ["manifest-missing", "manifest-parse", "manifest-schema", "manifest-line"]
    )
    add(
        "manifest-valid",
        "core",
        "leji.json at the repository root, valid against the manifest schema",
        "pass" if not manifest_errors else "fail",
        manifest_errors[0].message if manifest_errors else None,
    )

    # Git is a hard core MUST (context-layer.md). Reported as "manual" (not "fail")
    # when git can't be resolved, so the scorer stays usable on copies/detached
    # checkouts; enforcement lives in validate's git-required finding.
    in_git = git_toplevel(root) is not None
    add(
        "git",
        "core",
        "the context layer lives in a git repository, versioned with the work it describes",
        "pass" if in_git else "manual",
        None
        if in_git
        else "not resolvable to a git repository here; verify in the canonical repository",
    )

    if manifest is None:
        findings.extend(f for f in validation.findings if f.severity == "error")
        return ConformanceResult(
            claimed_level=None, verified_level=None, items=items, findings=sort_findings(findings)
        )

    boot_errors = errors_by(["missing-declared-file"], lambda p: p == manifest["bootProfilePath"])
    add(
        "boot-profile",
        "core",
        "a boot profile at the declared path covering identity, loading, and posture",
        "pass" if not boot_errors else "fail",
        boot_errors[0].message if boot_errors else None,
    )

    category_errors = errors_by(
        ["categories-minimum", "category-path-missing", "category-empty", "decisions-empty"]
    )
    add(
        "categories",
        "core",
        "at least domain or system mapped and populated, plus decisions with a real record",
        "pass" if not category_errors else "fail",
        category_errors[0].message if category_errors else None,
    )

    owner = ((manifest.get("owners") or {}).get("primary") or {}).get("name")
    add("owner", "core", "a named primary owner", "pass" if owner else "fail")

    declared_adapters = manifest.get("vendorAdapters") or []
    vendor_errors = errors_by(["vendor-adapter-redirect"]) + errors_by(
        ["missing-declared-file"], lambda p: p in declared_adapters
    )
    add(
        "vendor-redirects",
        "core",
        "vendor entrypoint files, if present, redirect to the boot profile",
        "pass" if not vendor_errors else "fail",
        vendor_errors[0].message if vendor_errors else None,
    )

    # --- indexed ---
    index_result = check_index(root, manifest)
    add(
        "index-current",
        "indexed",
        "a generated context index, current with the tree",
        "pass" if index_result.stale is False else "fail",
        index_result.findings[0].message if index_result.findings else None,
    )

    changelog_rel = effective_changelog_path(manifest)
    changelog_desc = "a machine-readable changelog; layer changes append entries"
    if (Path(root) / changelog_rel).is_file():
        changelog = check_changelog_append_only(root, changelog_rel)
        changelog_errors = [f for f in changelog.findings if f.severity == "error"]
        if changelog_errors:
            add("changelog", "indexed", changelog_desc, "fail", changelog_errors[0].message)
        elif not changelog.verified:
            add(
                "changelog",
                "indexed",
                changelog_desc,
                "manual",
                "append-only discipline unverifiable without a git baseline",
            )
        else:
            add("changelog", "indexed", changelog_desc, "pass")
    else:
        add(
            "changelog",
            "indexed",
            changelog_desc,
            "fail",
            f"changelog {changelog_rel} does not exist",
        )

    # --- governed ---
    add(
        "review-gate",
        "governed",
        "layer changes ride the repository's review gate; people approve",
        "manual",
    )

    valid_profiles = [p for p in scan_agent_profiles(root, manifest) if not p.findings]
    add(
        "agent-profiles",
        "governed",
        "agent profiles (at least a core profile) valid against the profile schema",
        "pass" if valid_profiles else "fail",
        None if valid_profiles else "no valid agent profile found",
    )

    add(
        "ci-validates",
        "governed",
        "CI validates the surface: manifest, index currency, changelog discipline, profiles",
        "manual",
    )

    freshness = freshness_report(root, manifest)
    add(
        "freshness-declared",
        "governed",
        "freshness horizons are declared and checked (report-only is acceptable)",
        "pass" if freshness.declared > 0 else "fail",
        "no freshness.reviewAfter declared anywhere"
        if freshness.declared == 0
        else f"{freshness.declared} horizon(s) declared, {len(freshness.expired)} expired",
    )

    # --- federated ---
    add(
        "consumed-externally",
        "federated",
        "the context layer is consumed by at least one other repository as a pinned docs-only mount",
        "manual",
    )
    add("stale-pin-reporting", "federated", "stale-pin reporting is in place", "manual")
    mounts = (manifest.get("federation") or {}).get("mounts") or []
    if mounts:
        missing = [m for m in mounts if not (Path(root) / m["path"]).exists()]
        add(
            "sibling-mounts",
            "federated",
            "sibling layers are mounted with ownership intact",
            "pass" if not missing else "fail",
            f"mount path {missing[0]['path']} does not exist" if missing else None,
        )
    else:
        add(
            "sibling-mounts",
            "federated",
            "sibling layers are mounted with ownership intact",
            "manual",
            "no federation.mounts declared",
        )

    # --- scoring ---
    verified: Optional[str] = None
    for level in CONFORMANCE_LEVELS:
        machine_items = [i for i in items if i.level == level and i.status != "manual"]
        if any(i.status == "fail" for i in machine_items):
            break
        verified = level

    claimed = claimed_level(manifest)
    # Verification answers "does the claim hold?", not "what could be claimed":
    # never report a verified level above the claim.
    if verified is not None and CONFORMANCE_LEVELS.index(verified) > CONFORMANCE_LEVELS.index(
        claimed
    ):
        verified = claimed
    if verified is None or CONFORMANCE_LEVELS.index(claimed) > CONFORMANCE_LEVELS.index(verified):
        findings.append(
            Finding(
                "conformance-claim",
                "error",
                f'claimed level "{claimed}" exceeds the verified level "{verified or "none"}"',
                "leji.json",
            )
        )

    return ConformanceResult(
        claimed_level=claimed,
        verified_level=verified,
        items=items,
        findings=sort_findings(findings),
    )


def render_explain(result: ConformanceResult) -> str:
    """Actionable guidance (`conformance --explain`): what it would take to reach
    the next level above the one currently verified, listing the not-yet-passing
    items (manual ones flagged as process steps), plus a pointer to the content
    lint."""
    levels = CONFORMANCE_LEVELS
    verified_idx = levels.index(result.verified_level) if result.verified_level else -1
    lines = [
        f"Verified level: {result.verified_level or 'none'} "
        f"(claimed: {result.claimed_level or 'none'})."
    ]
    next_idx = verified_idx + 1
    if next_idx >= len(levels):
        lines.append(
            "This layer is at the top conformance level (federated). Nothing further to reach."
        )
        return "\n".join(lines)
    nxt = levels[next_idx]
    blockers = [i for i in result.items if i.level == nxt and i.status != "pass"]
    lines.extend(["", f'To reach "{nxt}":'])
    if not blockers:
        lines.append(
            f'   - all "{nxt}" checks already pass; '
            f'set conformance.claimedLevel to "{nxt}" in leji.json'
        )
    else:
        for b in blockers:
            how = " (process step; tooling cannot verify)" if b.status == "manual" else ""
            detail = f" — {b.detail}" if b.detail else ""
            lines.append(f"   - {b.description}{detail}{how}")
    lines.extend(
        [
            "",
            "Content quality (not a conformance gate): run `leji validate --content` "
            "for placeholder and thin-content warnings.",
        ]
    )
    return "\n".join(lines)
