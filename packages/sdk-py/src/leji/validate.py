"""Full layer validation, mirroring the Node SDK's validate command."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Optional, cast

from .findings import Finding, sort_findings
from .frontmatter import parse_frontmatter
from .fsx import resolved_within_root, under_path
from .gitutil import git_show_head, git_toplevel
from .indexgen import check_index
from .mounts import read_text_within
from .layer import (
    ScannedProfile,
    duplicate_id_findings,
    finding_key,
    profile_inheritance_findings,
    read_json_artifact,
    scan_agent_profiles,
    scan_categories,
    scan_decision_records,
    scan_profile_set,
)
from .manifest import (
    CATEGORY_IDS,
    Manifest,
    claimed_level,
    effective_agent_profiles_path,
    effective_changelog_path,
    effective_decision_records_path,
    effective_index_path,
    level_at_least,
    load_manifest,
)
from .mountblock import parse_mount_blocks, value_representation_error
from .mounts import cache_key_for, normalize_source, valid_tracking_ref
from .schemas import SUPPORTED_LINES, schema_errors

KNOWN_VENDOR_FILES = [
    "CLAUDE.md",
    "AGENTS.md",
    "GEMINI.md",
    ".cursorrules",
    ".cursor/rules",
    ".windsurfrules",
    ".github/copilot-instructions.md",
]


@dataclass
class ValidateResult:
    findings: list[Finding]
    manifest: Optional[Manifest]


@dataclass
class ChangelogCheckResult:
    findings: list[Finding]
    verified: bool


def _check_declared_file(root: str, rel: str, what: str, findings: list[Finding]) -> bool:
    if not (Path(root) / rel).is_file():
        findings.append(
            Finding(
                "missing-declared-file",
                "error",
                f"{what} declared in leji.json does not exist",
                rel,
            )
        )
        return False
    return True


def _check_boot_profile(root: str, manifest: Manifest, findings: list[Finding]) -> None:
    rel = manifest["bootProfilePath"]
    if not _check_declared_file(root, rel, "boot profile", findings):
        return
    boot_abs = Path(root) / rel
    if not resolved_within_root(root, boot_abs):
        findings.append(
            Finding(
                "path-escapes-root", "error", "boot profile resolves outside the layer root", rel
            )
        )
        return
    text = boot_abs.read_text(encoding="utf-8")

    headings = [m.group(1).lower() for m in re.finditer(r"^#{1,6}\s+(.+)$", text, re.MULTILINE)]
    for section in ["identity", "loading", "posture"]:
        if not any(section in h for h in headings):
            findings.append(
                Finding(
                    "boot-profile-sections",
                    "warning",
                    f'boot profile has no "{section}" heading; it must cover identity, loading, and posture',
                    rel,
                )
            )

    changelog_path = (manifest.get("machine") or {}).get("changelogPath")
    decisions_path = effective_decision_records_path(manifest)

    def mentions(p: Optional[str]) -> bool:
        if not p:
            return False
        base = p[:-1] if p.endswith("/") else p
        return base in text

    if not mentions(changelog_path) and not mentions(decisions_path):
        findings.append(
            Finding(
                "boot-profile-maintenance",
                "warning",
                "boot profile references neither the declared changelog nor the decision-records "
                "location; state the maintenance duties",
                rel,
            )
        )


def _check_categories(root: str, manifest: Manifest, findings: list[Finding]) -> None:
    mapped = [c for c in CATEGORY_IDS if manifest["categories"].get(c)]
    if not (("domain" in mapped) or ("system" in mapped)) or "decisions" not in mapped:
        findings.append(
            Finding(
                "categories-minimum",
                "error",
                "a layer must map at least domain or system, plus decisions, to claim any conformance level",
                "leji.json",
            )
        )
    for category in mapped:
        for index_rel in manifest["categories"][category]["indexes"]:
            if not (Path(root) / index_rel).is_file():
                findings.append(
                    Finding(
                        "category-index-missing",
                        "error",
                        f"{category} index file does not exist",
                        index_rel,
                    )
                )
            elif not under_path(index_rel, manifest["rootPath"]):
                findings.append(
                    Finding(
                        "paths-outside-root",
                        "warning",
                        f"{category} index file falls outside rootPath {manifest['rootPath']}",
                        index_rel,
                    )
                )
    # Surface index parse/resolution/conflict findings, and enforce every mapped
    # category resolves to >=1 governed document (an empty or unresolving index
    # block is not a populated category).
    scan = scan_categories(root, manifest)
    findings.extend(scan.findings)
    populated = {d.category for d in scan.docs}
    for category in mapped:
        if category not in populated:
            findings.append(
                Finding(
                    "category-empty",
                    "error",
                    f"{category} resolves to no governed documents; map index entries that "
                    "exist, or remove the category",
                    manifest["categories"][category]["indexes"][0],
                )
            )
    # The domain/system minimum needs at least one intent document: a layer of
    # records alone preserves history but carries no operating context.
    minimum_mapped = [c for c in mapped if c in ("domain", "system")]
    minimum_populated = any(c in populated for c in minimum_mapped)
    if minimum_populated and not any(
        d.category in ("domain", "system") and d.kind == "intent" for d in scan.docs
    ):
        findings.append(
            Finding(
                "categories-intent-minimum",
                "error",
                "domain/system must include at least one intent document; "
                "records alone carry no operating context",
                "leji.json",
            )
        )
    # Freshness horizons are an intent mechanism; on a record they promise a
    # currency the document cannot have.
    for doc in scan.docs:
        if doc.kind != "record":
            continue
        fresh = (doc.frontmatter or {}).get("freshness")
        if isinstance(fresh, dict) and "reviewAfter" in fresh:
            findings.append(
                Finding(
                    "freshness-on-record",
                    "error",
                    "a record carries no review horizon (its date is its currency); "
                    "remove freshness.reviewAfter or reclassify the document as intent",
                    doc.rel_path,
                )
            )
    for key, rel in (manifest.get("machine") or {}).items():
        if isinstance(rel, str) and not under_path(rel, manifest["rootPath"]):
            findings.append(
                Finding(
                    "paths-outside-root",
                    "warning",
                    f"machine.{key} falls outside rootPath {manifest['rootPath']}",
                    rel,
                )
            )


def _check_vendor_adapters(root: str, manifest: Manifest, findings: list[Finding]) -> None:
    declared = manifest.get("vendorAdapters") or []
    for rel in declared:
        _check_declared_file(root, rel, "vendor adapter", findings)
    for rel in sorted(set(declared) | set(KNOWN_VENDOR_FILES)):
        abs_path = Path(root) / rel
        if not abs_path.is_file():
            continue
        # A vendor entrypoint that is a symlink resolving outside the layer root is
        # not read (matches adopt, which treats such files as absent).
        if not resolved_within_root(root, abs_path):
            continue
        if manifest["bootProfilePath"] not in abs_path.read_text(encoding="utf-8"):
            findings.append(
                Finding(
                    "vendor-adapter-redirect",
                    "error",
                    f"vendor entrypoint does not redirect to the boot profile ({manifest['bootProfilePath']})",
                    rel,
                )
            )


def _check_owners(manifest: Manifest, findings: list[Finding]) -> None:
    # A continuity owner exists to cover the primary's absence (governance.md
    # req 4), so naming the same person provides no continuity.
    owners = manifest.get("owners") or {}
    primary = (owners.get("primary") or {}).get("name")
    continuity = (owners.get("continuity") or {}).get("name")
    if primary and continuity and primary == continuity:
        findings.append(
            Finding(
                "continuity-self",
                "warning",
                "continuity owner exists to cover the primary's absence; naming the same person provides none",
                "leji.json",
            )
        )


def _check_actors(root: str, manifest: Manifest, findings: list[Finding]) -> None:
    """Semantic checks the manifest schema cannot express: the cross-field relation
    between an actor's declared roles and its per-role commands, and the collision
    between an actor-role command and a bound profile's own invocation. Both are
    structural contradictions, not policy: nothing here judges how many actors a role
    should have or whether it needs a profile."""
    actors = manifest.get("actors")
    if not actors:
        return
    actor_backed: set[str] = set()
    # Sorted, not insertion order: Go's map iteration is random so it must sort, and
    # raw SDK finding order is part of what the three implementations agree on.
    for actor_id in sorted(actors):
        actor = actors[actor_id]
        roles = actor.get("roles") or []
        command_roles = sorted((actor.get("commands") or {}).keys())
        actor_backed.update(roles)
        for role in roles:
            if role not in command_roles:
                findings.append(
                    Finding(
                        "actor-command-missing",
                        "error",
                        f'actor "{actor_id}" declares role "{role}" with no command for it',
                        "leji.json",
                    )
                )
        for role in command_roles:
            if role not in roles:
                findings.append(
                    Finding(
                        "actor-command-unclaimed",
                        "error",
                        f'actor "{actor_id}" has a command for role "{role}", which it does '
                        "not declare in roles",
                        "leji.json",
                    )
                )
    for role, rel in (manifest.get("agents") or {}).items():
        if role not in actor_backed:
            continue
        abs_path = Path(root) / rel
        if not abs_path.is_file():
            continue
        text = read_text_within(str(Path(root).resolve()), abs_path)
        if text is None:
            continue
        fm = parse_frontmatter(text)
        data = fm.data
        if isinstance(data, dict) and "invocation" in data:
            findings.append(
                Finding(
                    "actor-profile-invocation",
                    "error",
                    f'role "{role}" is actor-backed, but its profile also declares '
                    "invocation; declare the command in one place",
                    rel,
                )
            )


def _check_agents_map(root: str, manifest: Manifest, findings: list[Finding]) -> None:
    profiles_dir = effective_agent_profiles_path(manifest)
    for role, rel in (manifest.get("agents") or {}).items():
        if not _check_declared_file(root, rel, f"agents.{role} profile", findings):
            continue
        # Targets under agentProfilesPath are validated by the directory scan;
        # targets outside it still owe a valid agent-profile frontmatter.
        if under_path(rel, profiles_dir):
            continue
        agent_abs = Path(root) / rel
        if not resolved_within_root(root, agent_abs):
            findings.append(
                Finding(
                    "path-escapes-root",
                    "error",
                    f"agents.{role} profile resolves outside the layer root",
                    rel,
                )
            )
            continue
        fm = parse_frontmatter(agent_abs.read_text(encoding="utf-8"))
        if fm.error:
            findings.append(Finding("profile-frontmatter", "error", fm.error, rel))
        elif fm.data is None:
            findings.append(
                Finding("profile-frontmatter", "error", "missing YAML frontmatter", rel)
            )
        else:
            for err in schema_errors("agent-profile", fm.data):
                findings.append(Finding("profile-frontmatter", "error", err, rel))


def _check_boot_agents_default(root: str, manifest: Manifest, findings: list[Finding]) -> None:
    """Warn when agents.default is bound AND the boot profile references that profile's
    declared path. Binding a profile at the "default" key never causes it to load (only
    the boot profile's own instructions do), so a boot profile that unconditionally
    loads it is indirection, not routing: the two should be one canonical boot document."""
    default_rel = (manifest.get("agents") or {}).get("default")
    if not default_rel:
        return
    boot_abs = Path(root) / manifest["bootProfilePath"]
    if not boot_abs.is_file() or not resolved_within_root(root, boot_abs):
        return
    if default_rel not in boot_abs.read_text(encoding="utf-8"):
        return
    findings.append(
        Finding(
            "boot-agents-default",
            "warning",
            "agents.default is bound but never auto-loaded; a boot profile that "
            "unconditionally loads it should be one canonical boot document (fold the "
            "default profile in)",
            "leji.json",
        )
    )


def _check_federation_mounts(root: str, manifest: Manifest, findings: list[Finding]) -> None:
    mounts = (manifest.get("federation") or {}).get("mounts") or []
    # Three separated concerns (distribution.md pattern 3): declaration validity is
    # an error (the manifest lies); local availability is a warning (degraded
    # knowledge, never the build); materialization integrity belongs to
    # `mounts status`, not ordinary validation. Schema requiredness already
    # guarantees name/source/pin on every declared mount.
    seen_names: set[str] = set()
    bad_names: set[str] = set()
    for mount in mounts:
        if mount["name"] in seen_names:
            findings.append(
                Finding(
                    "mount-duplicate",
                    "error",
                    f'two mounts declare the same name "{mount["name"]}"',
                    mount["name"],
                )
            )
            bad_names.add(mount["name"])
        else:
            seen_names.add(mount["name"])
        if mount["name"] == manifest["name"]:
            findings.append(
                Finding(
                    "mount-self",
                    "error",
                    f'mount "{mount["name"]}" reuses the host layer\'s own name',
                    mount["name"],
                )
            )
            bad_names.add(mount["name"])
        # The resolver's own predicates, not a second reading of them: a source the
        # resolver cannot normalize and a trackingRef it will not follow are exactly
        # the "malformed source or pin" distribution.md calls a manifest error. Left
        # as availability, an unnormalizable source read as a mount that merely is
        # not hydrated here, which is a warning, and the lie went out as degraded
        # weather.
        source = mount.get("source")
        if not isinstance(source, str) or normalize_source(source) is None:
            findings.append(
                Finding(
                    "mount-source",
                    "error",
                    f'mount "{mount["name"]}" declares a source that is not a normalizable '
                    "locator; use an https://, ssh://, or SCP-style remote URL",
                    mount["name"],
                )
            )
            bad_names.add(mount["name"])
        tracking_ref = mount.get("trackingRef")
        if tracking_ref is not None and not valid_tracking_ref(str(tracking_ref)):
            findings.append(
                Finding(
                    "mount-tracking-ref",
                    "error",
                    f'mount "{mount["name"]}" declares a trackingRef that is not a fully '
                    "qualified branch or tag (refs/heads/... or refs/tags/...)",
                    mount["name"],
                )
            )
            bad_names.add(mount["name"])
    # Availability is reported only for cleanly declared mounts (never for a name
    # the manifest lies about), once per name.
    warned: set[str] = set()
    for mount in mounts:
        if mount["name"] in bad_names or mount["name"] in warned:
            continue
        warned.add(mount["name"])
        if mount_projection_dir(root, mount) is None:
            findings.append(
                Finding(
                    "mount-unavailable",
                    "warning",
                    f'mount "{mount["name"]}" is not hydrated here; sibling knowledge is degraded, '
                    "never the build. Run `leji mounts hydrate`.",
                    mount["name"],
                )
            )


def _mount_owner_name(mount: Mapping[str, object]) -> object:
    """A mount's declared ``owner.name``, or None when the declaration has none."""
    owner = mount.get("owner")
    return owner.get("name") if isinstance(owner, dict) else None


def mount_surfacing_findings(root: str, manifest: Manifest) -> list[Finding]:
    """Mount surfacing (boot-profile.md requirement 9): a host that declares
    ``federation.mounts`` surfaces each sibling in its boot profile through a
    ``leji-mounts`` block, so an agent discovers siblings in the task-language
    entrypoint without reading the manifest. Every condition below is an error, and
    findings accumulate; nothing stops at the first.

    | Condition | Code |
    |---|---|
    | mounts declared, boot profile carries no ``leji-mounts`` block | ``mount-surfacing-block`` |
    | no mounts declared, any ``leji-mounts`` block (an empty one included) | ``mount-surfacing-block`` |
    | malformed line, unknown/duplicate/missing field, empty or padded value | ``mount-surfacing-syntax`` |
    | an entry naming a mount the manifest does not declare | ``mount-surfacing-unknown`` |
    | more than one entry for one declared mount | ``mount-surfacing-duplicate`` |
    | a declared mount with no entry | ``mount-surfacing-missing`` |
    | an entry whose ``owner`` differs from the declared ``owner.name`` | ``mount-surfacing-owner`` |
    | a declared ``name`` no block value could carry | ``mount-name-line`` |
    | a declared ``owner.name`` no block value could carry | ``mount-owner-name-line`` |

    Order is deterministic and independent of the finding sort applied downstream:
    the block finding, then syntax findings in document order, then entry findings
    in document order, then missing/owner findings in declared-mount order, then the
    manifest-side identity findings in declared-mount order, ``mount-name-line``
    before ``mount-owner-name-line`` for the same mount. ``conformance`` reports the
    first of them.

    What is deliberately not checked: whether ``carries`` and ``read-when``
    faithfully describe the sibling. That is authored task language; presence is
    machine-checked and fidelity is the team's to attest."""
    mounts = (manifest.get("federation") or {}).get("mounts") or []
    rel = manifest["bootProfilePath"]
    findings: list[Finding] = []
    text = read_text_within(root, Path(root) / rel)
    if text is None:
        # The structural pass already reports the missing or escaping boot profile;
        # with mounts declared it is also a surfacing failure, which conformance reads.
        if mounts:
            findings.append(
                Finding(
                    "mount-surfacing-block",
                    "error",
                    "boot profile is missing or unreadable, so it surfaces none of "
                    "the declared mounts",
                    rel,
                )
            )
        return findings

    parsed = parse_mount_blocks(text)
    if not mounts:
        if parsed.saw_block:
            findings.append(
                Finding(
                    "mount-surfacing-block",
                    "error",
                    "this layer declares no federation.mounts; remove the leji-mounts block",
                    rel,
                )
            )
        return findings

    # Declared order, first occurrence per name: a repeated name is `mount-duplicate`
    # in the manifest check, and must not also cascade through surfacing.
    declared: list[Mapping[str, object]] = []
    declared_names: set[str] = set()
    for mount in mounts:
        if mount["name"] in declared_names:
            continue
        declared_names.add(mount["name"])
        declared.append(mount)

    if not parsed.saw_block:
        findings.append(
            Finding(
                "mount-surfacing-block",
                "error",
                f"{len(declared)} mount(s) declared but the boot profile carries no "
                "leji-mounts block; surface each sibling there",
                rel,
            )
        )
    for err in parsed.errors:
        findings.append(
            Finding("mount-surfacing-syntax", "error", f"line {err.line}: {err.message}", rel)
        )

    surfaced: dict[str, str] = {}  # mount name -> the owner its first entry names
    for entry in parsed.entries:
        if entry.mount not in declared_names:
            findings.append(
                Finding(
                    "mount-surfacing-unknown",
                    "error",
                    f'line {entry.line}: entry names "{entry.mount}", which this layer '
                    "does not declare as a mount",
                    rel,
                )
            )
            continue
        if entry.mount in surfaced:
            findings.append(
                Finding(
                    "mount-surfacing-duplicate",
                    "error",
                    f'line {entry.line}: mount "{entry.mount}" is surfaced more than '
                    "once; each declared mount gets exactly one entry",
                    rel,
                )
            )
            continue
        surfaced[entry.mount] = entry.owner

    for mount in declared:
        name = cast("str", mount["name"])
        declared_owner = _mount_owner_name(mount)
        owner = surfaced.get(name)
        if owner is None:
            if parsed.saw_block:
                findings.append(
                    Finding(
                        "mount-surfacing-missing",
                        "error",
                        f'declared mount "{name}" has no entry in the leji-mounts block',
                        rel,
                    )
                )
        elif owner != declared_owner:
            findings.append(
                Finding(
                    "mount-surfacing-owner",
                    "error",
                    f'mount "{name}" is surfaced with owner "{owner}" but is declared '
                    f'with owner "{declared_owner if declared_owner is not None else ""}"',
                    rel,
                )
            )

    # An identity the block could never carry: the declaration itself is at fault, so
    # the finding points at the manifest rather than at the boot profile. Both
    # identity fields are free strings in the schema (`name` and `owner.name` carry
    # only minLength), so both are checked, name first for the same mount.
    for mount in declared:
        name = cast("str", mount["name"])
        bad_name = value_representation_error(name)
        if bad_name:
            findings.append(
                Finding(
                    "mount-name-line",
                    "error",
                    f'mount "{name}" declares a name no leji-mounts entry could carry: {bad_name}',
                    "leji.json",
                )
            )
        declared_owner = _mount_owner_name(mount)
        bad_owner = value_representation_error(
            cast("str", declared_owner) if declared_owner is not None else ""
        )
        if bad_owner:
            findings.append(
                Finding(
                    "mount-owner-name-line",
                    "error",
                    f'mount "{name}" declares an owner name no leji-mounts entry could '
                    f"carry: {bad_owner}",
                    "leji.json",
                )
            )
    return findings


def mount_projection_dir(root: str, mount: Mapping[str, object]) -> str | None:
    """Resolve a mount's hydrated projection directory, or None when it is not
    materialized here. The cache key is derived from the declaration itself, so
    there is no state file to read and nothing to fall out of step with the
    manifest; a projection counts only when it carries its completion marker, since
    a directory without one is an entry that was never published."""
    source, pin = mount.get("source"), mount.get("pin")
    if not isinstance(source, str) or not isinstance(pin, str):
        return None
    identity = normalize_source(source)
    if identity is None:
        return None
    key = cache_key_for(identity, pin)
    projection = Path(root) / ".leji" / "mounts" / "cache" / key / "projection"
    return str(projection) if (projection / "complete").is_file() else None


def _check_profiles_and_decisions(root: str, manifest: Manifest, findings: list[Finding]) -> None:
    profiles = scan_agent_profiles(root, manifest)
    ids: list[tuple[object, str]] = []
    for p in profiles:
        findings.extend(p.findings)
        ids.append(((p.frontmatter or {}).get("id"), p.rel_path))
    findings.extend(duplicate_id_findings(ids, "agent profile"))
    # Authored frontmatter validates against the schema above; `inherits` is
    # operative, so every profile that declares one is also resolved, and a
    # resolution that cannot complete is an error (the derived file alone is not
    # the profile). Resolved against the whole roster, bound out-of-directory
    # profiles included.
    findings.extend(profile_inheritance_findings(scan_profile_set(root, manifest)))

    decisions = scan_decision_records(root, manifest)
    decision_ids: list[tuple[object, str]] = []
    for d in decisions:
        findings.extend(d.findings)
        decision_ids.append(((d.frontmatter or {}).get("id"), d.rel_path))
    findings.extend(duplicate_id_findings(decision_ids, "decision record"))
    _check_supersession(decisions, findings)

    if not [d for d in decisions if not d.findings]:
        where = effective_decision_records_path(manifest)
        findings.append(
            Finding(
                "decisions-empty",
                "error",
                "no valid decision record found; core conformance requires at least one",
                where,
            )
        )


def _check_supersession(decisions: list[ScannedProfile], findings: list[Finding]) -> None:
    """Across-record supersession integrity (decisions.md); the schema covers the
    within-record half. "B supersedes A": A must exist, be superseded, and point
    supersededBy back at B. A superseded record's supersededBy: B must exist and
    declare supersedes back. supersededBy on a non-superseded record is rejected;
    cycles are reported. Without this both A and B route as live."""

    @dataclass
    class _Rec:
        id: str
        status: str
        supersedes: Optional[str]
        superseded_by: Optional[str]
        rel_path: str

    recs: list[_Rec] = []
    by_id: dict[str, _Rec] = {}
    for d in decisions:
        fm = d.frontmatter
        if not fm or not isinstance(fm.get("id"), str):
            continue
        sup = fm.get("supersedes")
        supby = fm.get("supersededBy")
        status = fm.get("status")
        rec = _Rec(
            id=fm["id"],
            status=status if isinstance(status, str) else "",
            supersedes=sup if isinstance(sup, str) else None,
            superseded_by=supby if isinstance(supby, str) else None,
            rel_path=d.rel_path,
        )
        recs.append(rec)
        by_id.setdefault(rec.id, rec)

    def emit(msg: str, rel_path: str) -> None:
        findings.append(Finding("decision-supersession", "error", msg, rel_path))

    def status_or(s: str) -> str:
        return s if s else "unset"

    for r in recs:
        if r.superseded_by is not None and r.status != "superseded":
            emit(
                f'supersededBy is set but status is "{status_or(r.status)}", not "superseded"',
                r.rel_path,
            )
        if r.supersedes is not None:
            target = by_id.get(r.supersedes)
            if target is None:
                emit(f'supersedes "{r.supersedes}" but no decision record has that id', r.rel_path)
            else:
                if target.status != "superseded":
                    emit(
                        f'is superseded by "{r.id}", so its status must be "superseded" '
                        f'but is "{status_or(target.status)}"',
                        target.rel_path,
                    )
                if target.superseded_by != r.id:
                    emit(
                        f'is superseded by "{r.id}", but its supersededBy does not point back to "{r.id}"',
                        target.rel_path,
                    )
        if r.superseded_by is not None:
            successor = by_id.get(r.superseded_by)
            if successor is None:
                emit(
                    f'supersededBy "{r.superseded_by}" but no decision record has that id',
                    r.rel_path,
                )
            elif successor.supersedes != r.id:
                emit(
                    f'supersededBy "{r.superseded_by}", but that record does not declare supersedes "{r.id}"',
                    r.rel_path,
                )

    # Cycle detection over supersedes edges (id -> the id it supersedes).
    color: dict[str, int] = {}  # 0 unvisited, 1 in-progress, 2 done
    on_cycle: set[str] = set()

    def visit(node_id: str, stack: list[str]) -> None:
        c = color.get(node_id, 0)
        if c == 2:
            return
        if c == 1:
            for sid in reversed(stack):
                on_cycle.add(sid)
                if sid == node_id:
                    break
            return
        color[node_id] = 1
        r = by_id.get(node_id)
        if r is not None and r.supersedes is not None and r.supersedes in by_id:
            visit(r.supersedes, stack + [node_id])
        color[node_id] = 2

    for r in recs:
        visit(r.id, [])
    for r in recs:
        if r.id in on_cycle:
            emit(f'decision "{r.id}" is part of a supersession cycle', r.rel_path)


def _check_schema_version(rel: str, data: object, findings: list[Finding]) -> None:
    v = data.get("schemaVersion") if isinstance(data, dict) else None
    if isinstance(v, str) and v not in SUPPORTED_LINES:
        findings.append(
            Finding(
                "schema-version", "error", f'schemaVersion "{v}" is not supported by this SDK', rel
            )
        )


def _date_id_key(entry: dict) -> tuple[str, str]:
    """Canonical changelog order (machine-readable-surface.md req 3): ascending by
    ``date``, then ``id``. ``date`` is UTC so lexical compare is chronological; ``id``
    is unique, so the pair is a total order. Mirrors TS ``compareByDateId``."""
    return (str(entry.get("date") or ""), str(entry.get("id") or ""))


def _canonical_json(value: object) -> str:
    """Key-order-insensitive, numeric-spelling-insensitive serialization.

    JS JSON collapses 1.0 to 1; mirror that so reformatting a number's
    spelling is not flagged as a changelog modification."""

    def normalize(v: object) -> object:
        if isinstance(v, float) and v.is_integer():
            return int(v)
        if isinstance(v, dict):
            return {k: normalize(x) for k, x in v.items()}
        if isinstance(v, list):
            return [normalize(x) for x in v]
        return v

    return json.dumps(normalize(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def check_changelog_append_only(root: str, rel: str, strict: bool = False) -> ChangelogCheckResult:
    """Append-only discipline against the git HEAD baseline.

    Every entry present at HEAD must be unchanged and in the same position;
    new entries only append. Without a git baseline the property is
    unverifiable and reported as a warning (error under --strict).
    """
    findings: list[Finding] = []
    data, parse_finding = read_json_artifact(root, rel)
    if parse_finding:
        return ChangelogCheckResult(findings=[parse_finding], verified=False)
    if data is None:
        return ChangelogCheckResult(
            findings=[
                Finding("changelog-required", "error", f"changelog {rel} does not exist", rel)
            ],
            verified=False,
        )
    for err in schema_errors("context-changelog", data):
        findings.append(Finding("artifact-schema", "error", err, rel))
    _check_schema_version(rel, data, findings)
    # Schema findings above cover malformed shapes; guard so they can't crash us.
    raw_entries = data.get("entries") if isinstance(data, dict) else None
    entries = (
        [e for e in raw_entries if isinstance(e, dict)] if isinstance(raw_entries, list) else []
    )
    dup = duplicate_id_findings(
        [(e.get("id"), f"{rel}#{i}") for i, e in enumerate(entries)], "changelog"
    )
    findings.extend(Finding(f.rule, f.severity, f.message, rel) for f in dup)

    if git_toplevel(root) is None:
        findings.append(
            Finding(
                "changelog-unverifiable",
                "error" if strict else "warning",
                "not a git repository; append-only discipline cannot be verified",
                rel,
            )
        )
        return ChangelogCheckResult(findings=findings, verified=False)
    head_text = git_show_head(root, rel)
    if head_text is None:
        # No committed state to compare against: an unborn repository, or a changelog
        # not yet in HEAD. Append-only discipline is unverifiable here, not satisfied.
        return ChangelogCheckResult(findings=findings, verified=False)
    try:
        raw_head = json.loads(head_text).get("entries")
        head_entries = (
            [e for e in raw_head if isinstance(e, dict)] if isinstance(raw_head, list) else []
        )
    except (json.JSONDecodeError, AttributeError):
        # The HEAD blob is unparseable, so it yields no baseline to compare against.
        return ChangelogCheckResult(findings=findings, verified=False)
    # Discipline is set-keyed by `id` (machine-readable-surface.md req 3): order
    # is derived from (date, id), not array position, so reordering is fine.
    # Every entry present at HEAD must survive unchanged unless it was compacted
    # from the OLDEST end of the canonical order, with a `compaction` entry added.
    if head_entries and not entries:
        findings.append(
            Finding(
                "changelog-append-only",
                "error",
                "changelog compacted to empty; the compaction entry must survive",
                rel,
            )
        )
        return ChangelogCheckResult(findings=findings, verified=True)

    new_ids = {e.get("id") for e in entries}
    head_by_id = {e.get("id"): e for e in head_entries}
    new_by_id = {e.get("id"): e for e in entries}

    # Surviving entries (present in both) are immutable. Key-order-insensitive:
    # reformatting an entry is not a change.
    for entry_id, head_entry in head_by_id.items():
        cur = new_by_id.get(entry_id)
        if cur is not None and _canonical_json(cur) != _canonical_json(head_entry):
            findings.append(
                Finding(
                    "changelog-append-only",
                    "error",
                    f'entry "{entry_id if entry_id is not None else "?"}" modified since HEAD; '
                    "surviving entries are immutable",
                    rel,
                )
            )
            return ChangelogCheckResult(findings=findings, verified=True)

    # Any ids dropped since HEAD must be a contiguous run from the oldest end of
    # the canonical (date, id) order, never from the middle or the newest end.
    head_canonical = sorted(head_entries, key=_date_id_key)
    dropped_ids = [e.get("id") for e in head_canonical if e.get("id") not in new_ids]
    if dropped_ids:
        oldest_prefix = {e.get("id") for e in head_canonical[: len(dropped_ids)]}
        from_oldest_end = all(i in oldest_prefix for i in dropped_ids)
        if not from_oldest_end:
            n = len(dropped_ids)
            findings.append(
                Finding(
                    "changelog-append-only",
                    "error",
                    f"{n} {'entry' if n == 1 else 'entries'} removed from other than the oldest end "
                    "since HEAD; only the oldest entries may be compacted",
                    rel,
                )
            )
            return ChangelogCheckResult(findings=findings, verified=True)
        n = len(dropped_ids)
        appended_compactions = [
            e for e in entries if e.get("id") not in head_by_id and e.get("type") == "compaction"
        ]
        if not appended_compactions:
            findings.append(
                Finding(
                    "changelog-append-only",
                    "error",
                    f"{n} {'entry' if n == 1 else 'entries'} removed since HEAD without a compaction "
                    "entry recording the drop",
                    rel,
                )
            )
        elif len(appended_compactions) > 1:
            findings.append(
                Finding(
                    "changelog-append-only",
                    "error",
                    f"{len(appended_compactions)} compaction entries were appended for one drop; "
                    "a drop records exactly one",
                    rel,
                )
            )
        else:
            # The single appended compaction must accurately record the dropped run.
            c = appended_compactions[0].get("compacted")
            c = c if isinstance(c, dict) else {}
            c_entries = str(c["entries"]) if isinstance(c.get("entries"), int) else "?"
            c_first = c["firstId"] if isinstance(c.get("firstId"), str) else "?"
            c_last = c["lastId"] if isinstance(c.get("lastId"), str) else "?"
            first_dropped, last_dropped = dropped_ids[0], dropped_ids[n - 1]
            if c_entries != str(n) or c_first != first_dropped or c_last != last_dropped:
                findings.append(
                    Finding(
                        "changelog-append-only",
                        "error",
                        f"compaction entry records {c_entries} entries ({c_first}..{c_last}) "
                        f"but {n} were dropped ({first_dropped}..{last_dropped})",
                        rel,
                    )
                )
    return ChangelogCheckResult(findings=findings, verified=True)


# Placeholder markers a scaffolded layer carries until populated: init's `TODO:`
# seeds, or any `<…>` angle-bracket stub.
_PLACEHOLDER_RE = re.compile(r"\bTODO:|<[A-Za-z][^>\n]*>")
# Inferences an agent drafted but the owner hasn't confirmed: `TODO(confirm-…): …`
# or `UNCONFIRMED:`. The `TODO(confirm-…)` form deliberately does not match
# _PLACEHOLDER_RE's `TODO:`.
_UNCONFIRMED_RE = re.compile(r"TODO\(confirm[-:][^)\n]*\)|UNCONFIRMED:")
# The generic identity init writes by default; real layers replace it.
_GENERIC_IDENTITY = "Shared context layer for this repository."
_BULLET_RE = re.compile(r"^\s*-\s+\S")


# Heading lines via a linear pattern; the title is substring-tested in code,
# not interpolated into a `\s+.*…*` regex that backtracks on long whitespace.
_HEADING_LINE_RE = re.compile(r"^#{1,6}[ \t]+(.*)$", re.MULTILINE)


def _section_body(text: str, heading: str) -> str:
    """Body text of the first heading whose title contains ``heading``, up to
    the next heading."""
    needle = heading.lower()
    body_start = -1
    for m in _HEADING_LINE_RE.finditer(text):
        if body_start == -1:
            if needle in m.group(1).lower():
                body_start = m.end()
        else:
            return text[body_start : m.start()].strip()
    return "" if body_start == -1 else text[body_start:].strip()


def content_findings(root: str, manifest: Manifest) -> list[Finding]:
    """Opt-in content lint (``validate --content``): warning-only signals a layer is
    still a scaffold rather than real context — placeholder text, generic boot
    identity, thin domain/system categories. Never errors, never affects a conformance
    level; guidance toward a layer worth reading."""
    out: list[Finding] = []
    boot_rel = manifest["bootProfilePath"]
    boot_abs = Path(root) / boot_rel
    # Confine the read: a symlinked boot profile escaping root is skipped (the
    # structural pass already flags it). Content lint is advisory.
    if boot_abs.is_file() and resolved_within_root(root, boot_abs):
        boot = boot_abs.read_text(encoding="utf-8")
        if _PLACEHOLDER_RE.search(boot):
            out.append(
                Finding(
                    "content-placeholder",
                    "warning",
                    "boot profile still contains placeholder text (TODO: or <…>)",
                    boot_rel,
                )
            )
        identity = _section_body(boot, "identity")
        if identity == "" or _GENERIC_IDENTITY in identity or _PLACEHOLDER_RE.search(identity):
            out.append(
                Finding(
                    "content-identity",
                    "warning",
                    "boot profile Identity is empty or generic; say what this repository is, "
                    "who it serves, and its stage",
                    boot_rel,
                )
            )
        if _UNCONFIRMED_RE.search(boot):
            out.append(
                Finding(
                    "content-unconfirmed",
                    "warning",
                    "boot profile has inferences awaiting owner confirmation",
                    boot_rel,
                )
            )
    docs_by_cat: dict[str, list[tuple[str, str]]] = {}
    for doc in scan_categories(root, manifest).docs:
        docs_by_cat.setdefault(doc.category, []).append(
            (doc.rel_path, (Path(root) / doc.rel_path).read_text(encoding="utf-8"))
        )
    for cat in ("domain", "system", "practice", "governance"):
        mapping = manifest["categories"].get(cat)
        if not mapping:
            continue
        concrete = 0
        for rel, text in docs_by_cat.get(cat, []):
            if _PLACEHOLDER_RE.search(text):
                out.append(
                    Finding(
                        "content-placeholder",
                        "warning",
                        f"{cat} document still contains placeholder text",
                        rel,
                    )
                )
            if _UNCONFIRMED_RE.search(text):
                out.append(
                    Finding(
                        "content-unconfirmed",
                        "warning",
                        f"{cat} document has inferences awaiting owner confirmation",
                        rel,
                    )
                )
            for line in text.split("\n"):
                if _BULLET_RE.search(line) and not _PLACEHOLDER_RE.search(line):
                    concrete += 1
        if cat in ("domain", "system") and concrete < 3:
            plural = "" if concrete == 1 else "s"
            out.append(
                Finding(
                    "content-thin",
                    "warning",
                    f"{cat} has {concrete} concrete bullet{plural}; "
                    "aim for at least 3 repository-specific ones",
                    mapping["indexes"][0],
                )
            )
    # Decisions an agent proposed but the owner has not yet accepted.
    for d in scan_decision_records(root, manifest):
        fm = d.frontmatter or {}
        if fm.get("status") == "proposed":
            out.append(
                Finding(
                    "content-unconfirmed",
                    "warning",
                    f'decision "{fm.get("id") if fm.get("id") is not None else "?"}" '
                    "is proposed; awaiting owner confirmation",
                    d.rel_path,
                )
            )
    return out


def validate_layer(root: str, content: bool = False) -> ValidateResult:
    """Manifest, level-aware artifact requirements, schema checks, frontmatter
    contracts, lint rules. Index and changelog are required from ``indexed``;
    at least one valid agent profile from ``governed``. Artifacts present
    below their required level are still schema-validated. With ``content``,
    appends the warning-only content lint."""
    load = load_manifest(root)
    manifest, findings = load.manifest, load.findings
    if manifest is None:
        return ValidateResult(findings=sort_findings(findings), manifest=None)

    level = claimed_level(manifest)

    # Git is required at core conformance and above (context-layer.md, Requirements):
    # history, checkout currency, and append-only integrity all derive from it. A
    # non-git working copy is a degraded read, not a canonical layer; warn rather
    # than pass it silently.
    if git_toplevel(root) is None:
        findings.append(
            Finding(
                "git-required",
                "warning",
                "context layer is not in a git repository; core conformance requires git "
                "(a degraded, no-git copy cannot claim conformance)",
                "leji.json",
            )
        )

    _check_boot_profile(root, manifest, findings)
    _check_categories(root, manifest, findings)
    _check_vendor_adapters(root, manifest, findings)
    _check_owners(manifest, findings)
    _check_agents_map(root, manifest, findings)
    _check_actors(root, manifest, findings)
    _check_boot_agents_default(root, manifest, findings)
    _check_federation_mounts(root, manifest, findings)
    findings.extend(mount_surfacing_findings(root, manifest))
    _check_profiles_and_decisions(root, manifest, findings)

    index_rel = effective_index_path(manifest)
    index_exists = (Path(root) / index_rel).is_file()
    if level_at_least(level, "indexed") or index_exists:
        if not level_at_least(level, "indexed") and index_exists:
            data, parse_finding = read_json_artifact(root, index_rel)
            if parse_finding:
                findings.append(parse_finding)
            else:
                for err in schema_errors("context-index", data):
                    findings.append(Finding("artifact-schema", "error", err, index_rel))
                _check_schema_version(index_rel, data, findings)
        else:
            # check_index covers schema, schemaVersion, and currency. It re-runs the
            # category scan to generate the expected index, so every parse, conflict
            # and resolution finding the scan above already contributed comes back a
            # second time; one bad index-file line was reported twice. Deduplicated by
            # the same identity relation resolution uses, because two findings with
            # the same rule, severity, message and path are the same finding to every
            # reader.
            already_reported = {finding_key(f) for f in findings}
            for f in check_index(root, manifest).findings:
                if finding_key(f) not in already_reported:
                    findings.append(f)

    changelog_rel = effective_changelog_path(manifest)
    changelog_exists = (Path(root) / changelog_rel).is_file()
    if level_at_least(level, "indexed") and not changelog_exists:
        findings.append(
            Finding(
                "changelog-required",
                "error",
                f"changelog {changelog_rel} does not exist",
                changelog_rel,
            )
        )
    elif changelog_exists:
        findings.extend(check_changelog_append_only(root, changelog_rel).findings)

    if level_at_least(level, "governed"):
        profiles = scan_agent_profiles(root, manifest)
        if not [p for p in profiles if not p.findings]:
            findings.append(
                Finding(
                    "profile-required",
                    "error",
                    "governed conformance requires at least one valid agent profile",
                    effective_agent_profiles_path(manifest),
                )
            )

    if content:
        findings.extend(content_findings(root, manifest))

    return ValidateResult(findings=sort_findings(findings), manifest=manifest)
