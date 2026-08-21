"""Conformance scoring against the four-level checklist."""

from __future__ import annotations

import re
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
from .mounts import MountDecl, check_pin_reachability, normalize_source
from .validate import check_changelog_append_only, mount_surfacing_findings, validate_layer


@dataclass
class ChecklistItem:
    """One conformance check and its outcome. ``unknown`` is a machine item whose
    evidence was unobtainable in this run (e.g. pin reachability without source
    access): it never awards a level and is distinct from ``manual``."""

    id: str
    level: str
    description: str
    status: str  # pass | fail | manual | unknown
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
    # process_attested counts the fixed set the spec tags (process-attested): review
    # gate, CI, external consumption, stale-pin. Those are now the only items ever
    # reported ``manual``: unobtainable evidence is ``unknown`` and a requirement that
    # does not apply to this layer is ``not-applicable``.
    process_attested: int = 0
    items: list[ChecklistItem] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)


# Checklist items the spec tags (process-attested): no tool can confirm them from the
# repository alone, so they never block a level.
_PROCESS_ATTESTED_IDS = {
    "review-gate",
    "ci-validates",
    "consumed-externally",
    "stale-pin-reporting",
}

# `mount-discovery` states what it verifies and what it leaves to the team: the
# enumeration, identity, and presence are machine-checked; the fidelity of the
# authored free text to the declaration is not, and saying so is the honest claim.
MOUNT_DISCOVERY = (
    "the boot profile carries a mount-surfacing block entry for every declared "
    "sibling, and the generated index carries the `mounts` routing array (enforced "
    "by index currency); what each sibling carries and when to read it are authored "
    "task language, whose fidelity to the declaration is the team's to attest"
)


def _count_attested(items: list[ChecklistItem]) -> int:
    return sum(1 for it in items if it.id in _PROCESS_ATTESTED_IDS)


def conformance_report(root: str, federation: bool = False) -> ConformanceResult:
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

    # Git is a hard core MUST (context-layer.md). Conformance evaluates the directory
    # it was given, so "not in a repository" is gathered evidence, not missing
    # evidence: a "fail". validate says the same thing in its git-required finding;
    # the two no longer contradict each other.
    in_git = git_toplevel(root) is not None
    add(
        "git",
        "core",
        "the context layer lives in a git repository, versioned with the work it describes",
        "pass" if in_git else "fail",
        None if in_git else "not a git repository here; a degraded copy cannot verify conformance",
    )

    if manifest is None:
        findings.extend(f for f in validation.findings if f.severity == "error")
        return ConformanceResult(
            claimed_level=None,
            verified_level=None,
            process_attested=_count_attested(items),
            items=items,
            findings=sort_findings(findings),
        )

    boot_errors = errors_by(
        ["missing-declared-file", "path-escapes-root"], lambda p: p == manifest["bootProfilePath"]
    )
    add(
        "boot-profile",
        "core",
        "a boot profile at the declared path covering identity, loading, and posture",
        "pass" if not boot_errors else "fail",
        boot_errors[0].message if boot_errors else None,
    )

    category_errors = errors_by(
        [
            "categories-minimum",
            "categories-intent-minimum",
            "category-index-missing",
            "index-file-missing",
            "index-file-parse",
            "category-conflict",
            "kind-invalid",
            "freshness-on-record",
            "index-entry-missing",
            "index-entry-not-markdown",
            "category-empty",
            "decisions-empty",
        ]
    )
    add(
        "categories",
        "core",
        "at least domain or system mapped and populated with at least one intent document, "
        "plus decisions with a real record",
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
                "unknown",
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
        "the context layer is consumed by at least one other repository as a pinned mount",
        "manual",
    )
    add("stale-pin-reporting", "federated", "stale-pin reporting is in place", "manual")
    mounts = (manifest.get("federation") or {}).get("mounts") or []
    if mounts:
        # A mount's declaration is complete when it carries a normalized source and a
        # full commit pin (schema-required; re-verified here so conformance stands
        # alone). Materialization is deliberately NOT a conformance input: an
        # unhydrated mount is honest degraded availability, never a failed claim.
        # Pin reachability from the source's advertised witness ref is the networked
        # check (`mounts status`); it reports `unknown` without source access and
        # unknown never awards the level.
        # "Normalized source" is checked with the resolver's own predicate, not with a
        # truthiness test standing in for it: a source that is merely nonempty is not
        # the thing the checklist line and distribution.md name, and an item that
        # passes on one claims evidence it never gathered.
        def _declaration_defect(m: dict) -> Optional[str]:
            source = m.get("source")
            if not isinstance(source, str) or normalize_source(source) is None:
                return "declares a source that is not a normalizable locator"
            if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", str(m.get("pin") or "")):
                return "lacks a full commit pin"
            return None

        bad_decl = next(((m, d) for m in mounts if (d := _declaration_defect(m)) is not None), None)
        add(
            "sibling-mounts",
            "federated",
            "sibling layers are declared as pinned mounts: a normalized source and a full commit pin, ownership intact",
            "fail" if bad_decl else "pass",
            f'mount "{bad_decl[0]["name"]}" {bad_decl[1]}' if bad_decl else None,
        )
        # Pin reachability needs source access (the networked `--federation` probe);
        # without it the result is unknown, and unknown never awards the level.
        if federation:
            bad: Optional[tuple[str, str, Optional[str]]] = None
            for m in mounts:
                r = check_pin_reachability(
                    root,
                    MountDecl(
                        name=m["name"],
                        source=m["source"],
                        pin=m["pin"],
                        tracking_ref=m.get("trackingRef"),
                    ),
                )
                if r.state != "reachable":
                    bad = (m["name"], r.state, r.detail)
                    break
            add(
                "pin-reachable",
                "federated",
                "each mount's pin is reachable from an advertised ref of its source",
                ("fail" if bad[1] == "unreachable" else "unknown") if bad else "pass",
                f'mount "{bad[0]}": {bad[2] if bad[2] is not None else bad[1]}' if bad else None,
            )
        else:
            add(
                "pin-reachable",
                "federated",
                "each mount's pin is reachable from an advertised ref of its source",
                "unknown",
                "needs source access; run `leji conformance --federation=verify`",
            )
        unrouted = [
            m
            for m in mounts
            if not m.get("categories") or not (m.get("topics") or m.get("requiredWhen"))
        ]
        add(
            "mount-routing",
            "federated",
            "each mount carries routing metadata: categories, plus topics or requiredWhen",
            "pass" if not unrouted else "fail",
            (
                f'mount "{unrouted[0]["name"]}" lacks categories and/or topics or requiredWhen'
                if unrouted
                else None
            ),
        )
        # Surfacing is read from the block scan, not from a substring test: a mount
        # name mentioned in unrelated prose or in an example used to count as
        # surfaced. The findings arrive in the check's own deterministic order, so
        # the detail below is the same first finding in every SDK.
        surfacing = mount_surfacing_findings(root, manifest)
        add(
            "mount-discovery",
            "federated",
            MOUNT_DISCOVERY,
            "pass" if not surfacing else "fail",
            surfacing[0].message if surfacing else None,
        )
    else:
        # All four conditional mount items, in the same order as the branch above:
        # reporting two of them and dropping the other two made the checklist read as
        # though ``pin-reachable`` and ``mount-routing`` had simply not been
        # considered. ``not-applicable`` is not scored either way, so this changes the
        # report, not the level.
        add(
            "sibling-mounts",
            "federated",
            "sibling layers are mounted with ownership intact",
            "not-applicable",
            "no federation.mounts declared",
        )
        add(
            "pin-reachable",
            "federated",
            "each mount's pin is reachable from an advertised ref of its source",
            "not-applicable",
            "no federation.mounts declared",
        )
        add(
            "mount-routing",
            "federated",
            "each mount carries routing metadata: categories, plus topics or requiredWhen",
            "not-applicable",
            "no federation.mounts declared",
        )
        add(
            "mount-discovery",
            "federated",
            MOUNT_DISCOVERY,
            "not-applicable",
            "no federation.mounts declared",
        )

    # --- scoring ---
    verified: Optional[str] = None
    for level in CONFORMANCE_LEVELS:
        machine_items = [
            i for i in items if i.level == level and i.status not in ("manual", "not-applicable")
        ]
        # A level is machine-verified only on real machine evidence: every machine item
        # passes AND there is at least one. A level whose items are all process-attested
        # (federated with no mounts) cannot be machine-verified, so it never lifts it,
        # and ``unknown`` never awards a level (evidence absent is not evidence).
        if not machine_items or any(i.status in ("fail", "unknown") for i in machine_items):
            break
        verified = level

    claimed = claimed_level(manifest)
    # Verification answers "does the claim hold?", not "what could be claimed":
    # never report a verified level above the claim.
    if verified is not None and CONFORMANCE_LEVELS.index(verified) > CONFORMANCE_LEVELS.index(
        claimed
    ):
        verified = claimed
    # The claim gate matches the self-attestation posture: a claim is dishonest
    # when a machine item at or below it FAILS, or when a claimed level carries no
    # machine-evaluated evidence at all (the vacuity trap: e.g. federated with zero
    # mounts). ``manual`` never blocks a claim, and neither does ``unknown``: absent
    # evidence caps the verified level, but an offline run does not refute a claim
    # the networked probe could confirm.
    claimed_idx = CONFORMANCE_LEVELS.index(claimed)
    claim_problem = False
    for level in CONFORMANCE_LEVELS[: claimed_idx + 1]:
        evaluated = [
            i for i in items if i.level == level and i.status not in ("manual", "not-applicable")
        ]
        if not evaluated or any(i.status == "fail" for i in evaluated):
            claim_problem = True
            break
    if claim_problem:
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
        process_attested=_count_attested(items),
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
    # "not-applicable" is not a blocker: there is nothing to do about a requirement
    # that does not apply to this layer.
    blockers = [
        i for i in result.items if i.level == nxt and i.status not in ("pass", "not-applicable")
    ]
    lines.extend(["", f'To reach "{nxt}":'])
    if not blockers:
        lines.append(
            f'   - all "{nxt}" checks already pass; '
            f'set conformance.claimedLevel to "{nxt}" in leji.json'
        )
    else:
        for b in blockers:
            if b.status == "manual":
                how = " (process step; tooling cannot verify)"
            elif b.status == "unknown":
                how = " (evidence unobtainable in this run; unknown never awards the level)"
            else:
                how = ""
            detail = f": {b.detail}" if b.detail else ""
            lines.append(f"   - {b.description}{detail}{how}")
    lines.extend(
        [
            "",
            "Content quality (not a conformance gate): run `leji validate --content` "
            "for placeholder and thin-content warnings.",
        ]
    )
    return "\n".join(lines)
