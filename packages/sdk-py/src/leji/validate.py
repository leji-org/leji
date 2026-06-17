"""Full layer validation, mirroring the Node SDK's validate command."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .findings import Finding, sort_findings
from .frontmatter import parse_frontmatter
from .fsx import under_path, walk_md
from .gitutil import git_show_head, git_toplevel
from .indexgen import check_index
from .layer import (
    duplicate_id_findings,
    read_json_artifact,
    scan_agent_profiles,
    scan_decision_records,
)
from .manifest import (
    CATEGORY_IDS,
    Manifest,
    claimed_level,
    level_at_least,
    load_manifest,
)
from .schemas import SUPPORTED_LINES, schema_errors

KNOWN_VENDOR_FILES = [
    "CLAUDE.md",
    "AGENTS.md",
    ".cursorrules",
    ".cursor/rules",
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
    text = (Path(root) / rel).read_text(encoding="utf-8")

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

    machine = manifest.get("machine") or {}
    changelog_path = machine.get("changelogPath")
    decisions_path = machine.get("decisionRecordsPath") or _first_decisions_path(manifest)

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


def _first_decisions_path(manifest: Manifest) -> Optional[str]:
    decisions = manifest["categories"].get("decisions")
    return decisions["paths"][0] if decisions else None


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
        for declared in manifest["categories"][category]["paths"]:
            if not (Path(root) / declared).exists():
                findings.append(
                    Finding(
                        "category-path-missing",
                        "error",
                        f"{category} path does not exist",
                        declared,
                    )
                )
            elif not walk_md(root, declared):
                findings.append(
                    Finding(
                        "category-empty",
                        "error",
                        f"{category} path has no markdown content; an empty category must not be mapped",
                        declared,
                    )
                )
            if not under_path(declared, manifest["rootPath"]):
                findings.append(
                    Finding(
                        "paths-outside-root",
                        "warning",
                        f"{category} path falls outside rootPath {manifest['rootPath']}",
                        declared,
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


def _check_agents_map(root: str, manifest: Manifest, findings: list[Finding]) -> None:
    profiles_dir = (manifest.get("machine") or {}).get("agentProfilesPath")
    for role, rel in (manifest.get("agents") or {}).items():
        if not _check_declared_file(root, rel, f"agents.{role} profile", findings):
            continue
        # Targets under agentProfilesPath are validated by the directory scan;
        # targets outside it still owe a valid agent-profile frontmatter.
        if profiles_dir and under_path(rel, profiles_dir):
            continue
        fm = parse_frontmatter((Path(root) / rel).read_text(encoding="utf-8"))
        if fm.error:
            findings.append(Finding("profile-frontmatter", "error", fm.error, rel))
        elif fm.data is None:
            findings.append(
                Finding("profile-frontmatter", "error", "missing YAML frontmatter", rel)
            )
        else:
            for err in schema_errors("agent-profile", fm.data):
                findings.append(Finding("profile-frontmatter", "error", err, rel))


def _check_federation_mounts(root: str, manifest: Manifest, findings: list[Finding]) -> None:
    mounts = (manifest.get("federation") or {}).get("mounts") or []
    # Identity rules (distribution.md pattern 3): paths and names unique within
    # the manifest; a mount never reuses the host layer's own name.
    seen_paths: set[str] = set()
    seen_names: set[str] = set()
    for mount in mounts:
        if mount["path"] in seen_paths:
            findings.append(
                Finding(
                    "mount-duplicate",
                    "error",
                    f'two mounts declare the same path "{mount["path"]}"',
                    mount["path"],
                )
            )
        else:
            seen_paths.add(mount["path"])
        if mount["name"] in seen_names:
            findings.append(
                Finding(
                    "mount-duplicate",
                    "error",
                    f'two mounts declare the same name "{mount["name"]}"',
                    mount["path"],
                )
            )
        else:
            seen_names.add(mount["name"])
        if mount["name"] == manifest["name"]:
            findings.append(
                Finding(
                    "mount-self",
                    "error",
                    f'mount "{mount["name"]}" reuses the host layer\'s own name',
                    mount["path"],
                )
            )
    for mount in mounts:
        abs_path = Path(root) / mount["path"]
        if not abs_path.exists():
            findings.append(
                Finding(
                    "missing-declared-file",
                    "error",
                    f'federation mount "{mount["name"]}" declared in leji.json does not exist',
                    mount["path"],
                )
            )
            continue
        sibling_manifest = abs_path / "leji.json"
        if not sibling_manifest.is_file():
            findings.append(
                Finding(
                    "mount-not-a-layer",
                    "warning",
                    "mounted path carries no leji.json; a sibling layer brings its own manifest",
                    mount["path"],
                )
            )
            continue
        try:
            sibling = json.loads(sibling_manifest.read_text(encoding="utf-8"))
            name = sibling.get("name") if isinstance(sibling, dict) else None
            if isinstance(name, str) and name != mount["name"]:
                findings.append(
                    Finding(
                        "mount-name-mismatch",
                        "warning",
                        f'mount declares name "{mount["name"]}" but the sibling manifest says "{name}"',
                        mount["path"],
                    )
                )
        except json.JSONDecodeError:
            findings.append(
                Finding(
                    "mount-not-a-layer",
                    "warning",
                    "mounted leji.json is not valid JSON",
                    mount["path"],
                )
            )


def _check_profiles_and_decisions(root: str, manifest: Manifest, findings: list[Finding]) -> None:
    profiles = scan_agent_profiles(root, manifest)
    ids: list[tuple[object, str]] = []
    known_ids: set[str] = set()
    for p in profiles:
        findings.extend(p.findings)
        fm = p.frontmatter or {}
        ids.append((fm.get("id"), p.rel_path))
        if isinstance(fm.get("id"), str):
            known_ids.add(fm["id"])
    findings.extend(duplicate_id_findings(ids, "agent profile"))
    for p in profiles:
        inherits = (p.frontmatter or {}).get("inherits")
        if isinstance(inherits, str) and inherits not in known_ids:
            findings.append(
                Finding(
                    "inherits-unknown",
                    "warning",
                    f'inherits "{inherits}" but no profile declares that id',
                    p.rel_path,
                )
            )

    decisions = scan_decision_records(root, manifest)
    decision_ids: list[tuple[object, str]] = []
    for d in decisions:
        findings.extend(d.findings)
        decision_ids.append(((d.frontmatter or {}).get("id"), d.rel_path))
    findings.extend(duplicate_id_findings(decision_ids, "decision record"))

    if not [d for d in decisions if not d.findings]:
        machine = manifest.get("machine") or {}
        where = machine.get("decisionRecordsPath") or _first_decisions_path(manifest) or "leji.json"
        findings.append(
            Finding(
                "decisions-empty",
                "error",
                "no valid decision record found; core conformance requires at least one",
                where,
            )
        )


def _check_schema_version(rel: str, data: object, findings: list[Finding]) -> None:
    v = data.get("schemaVersion") if isinstance(data, dict) else None
    if isinstance(v, str) and v not in SUPPORTED_LINES:
        findings.append(
            Finding(
                "schema-version", "error", f'schemaVersion "{v}" is not supported by this SDK', rel
            )
        )


def _date_id_key(entry: dict) -> tuple[str, str]:
    """Canonical changelog order (machine-readable-surface.md req 3): ascending
    by ``date``, then ``id`` as the tiebreak. ``date`` is UTC, so a lexical
    compare of the string is chronological; ``id`` is unique, so the pair is a
    total order. Mirrors the TS ``compareByDateId`` comparator."""
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
                Finding(
                    "changelog-required", "error", f"declared changelog {rel} does not exist", rel
                )
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
        return ChangelogCheckResult(findings=findings, verified=True)
    try:
        raw_head = json.loads(head_text).get("entries")
        head_entries = (
            [e for e in raw_head if isinstance(e, dict)] if isinstance(raw_head, list) else []
        )
    except (json.JSONDecodeError, AttributeError):
        return ChangelogCheckResult(findings=findings, verified=True)
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
        appended = [e for e in entries if e.get("id") not in head_by_id]
        if not any(e.get("type") == "compaction" for e in appended):
            n = len(dropped_ids)
            findings.append(
                Finding(
                    "changelog-append-only",
                    "error",
                    f"{n} {'entry' if n == 1 else 'entries'} removed since HEAD without a compaction "
                    "entry recording the drop",
                    rel,
                )
            )
    return ChangelogCheckResult(findings=findings, verified=True)


def validate_layer(root: str) -> ValidateResult:
    """Manifest, level-aware artifact requirements, schema checks, frontmatter
    contracts, lint rules. Index and changelog are required from ``indexed``;
    at least one valid agent profile from ``governed``. Artifacts present
    below their required level are still schema-validated."""
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
    _check_federation_mounts(root, manifest, findings)
    _check_profiles_and_decisions(root, manifest, findings)

    machine = manifest.get("machine") or {}
    index_rel = machine.get("indexPath")
    index_exists = index_rel is not None and (Path(root) / index_rel).is_file()
    if level_at_least(level, "indexed") or index_exists:
        if not level_at_least(level, "indexed") and index_exists:
            assert index_rel is not None  # index_exists implies a declared path
            data, parse_finding = read_json_artifact(root, index_rel)
            if parse_finding:
                findings.append(parse_finding)
            else:
                for err in schema_errors("context-index", data):
                    findings.append(Finding("artifact-schema", "error", err, index_rel))
                _check_schema_version(index_rel, data, findings)
        else:
            # check_index covers schema, schemaVersion, and currency.
            findings.extend(check_index(root, manifest).findings)

    changelog_rel = machine.get("changelogPath")
    changelog_exists = changelog_rel is not None and (Path(root) / changelog_rel).is_file()
    if level_at_least(level, "indexed") and not changelog_exists:
        findings.append(
            Finding(
                "changelog-required",
                "error",
                f"declared changelog {changelog_rel} does not exist"
                if changelog_rel
                else "no machine.changelogPath declared; indexed conformance requires a machine changelog",
                changelog_rel or "leji.json",
            )
        )
    elif changelog_exists:
        assert changelog_rel is not None  # changelog_exists implies a declared path
        findings.extend(check_changelog_append_only(root, changelog_rel).findings)

    if level_at_least(level, "governed"):
        profiles = scan_agent_profiles(root, manifest)
        if not [p for p in profiles if not p.findings]:
            findings.append(
                Finding(
                    "profile-required",
                    "error",
                    "governed conformance requires at least one valid agent profile",
                    machine.get("agentProfilesPath") or "leji.json",
                )
            )

    return ValidateResult(findings=sort_findings(findings), manifest=manifest)
