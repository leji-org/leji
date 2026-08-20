"""Shared layer scanning: category docs, agent profiles, decision records."""

from __future__ import annotations

import json
import posixpath
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from .findings import Finding
from .frontmatter import parse_frontmatter
from .fsx import is_contained, resolved_within_root, under_path, walk_md
from .indexfile import DOC_KINDS, parse_index_file
from .manifest import (
    CATEGORY_IDS,
    Manifest,
    effective_agent_profiles_path,
    effective_decision_records_path,
)
from .schemas import schema_errors


@dataclass
class ScannedDoc:
    rel_path: str
    category: str
    # The document's resolved kind (winning selector, then frontmatter
    # override; decision-category documents are inherently records).
    kind: str
    frontmatter: Optional[dict[str, Any]]
    body: str


@dataclass
class ScannedProfile:
    rel_path: str
    frontmatter: Optional[dict[str, Any]]
    # Document body after the frontmatter block; inheritance composes it.
    body: str = ""
    findings: list[Finding] = field(default_factory=list)


@dataclass
class CategoryScan:
    docs: list[ScannedDoc]
    findings: list[Finding]


def excluded_from_categories(manifest: Manifest) -> Callable[[str], bool]:
    """Files validate/index must not treat as category content (layer chrome).
    READMEs are NOT chrome: a directory expansion skips them (repo furniture by
    default), but an explicit file selector governs one deliberately, because in
    real repositories section READMEs are often the section's landing document."""
    profiles_dir = effective_agent_profiles_path(manifest)

    def excluded(rel_path: str) -> bool:
        if rel_path == manifest["bootProfilePath"]:
            return True
        if under_path(rel_path, profiles_dir):
            return True
        return False

    return excluded


def _read_text_within(root: str, abs_path: Path) -> Optional[str]:
    """Read a file only when it resolves (following symlinks) within the layer
    root; mirrors Node's readTextWithin (returns None on escape or missing).

    Read-side, behind an existence check, so it takes the lenient containment form:
    see :func:`~leji.fsx.is_contained` for why this port cannot use the fail-closed
    one here without refusing layers the reference SDK reads."""
    if not abs_path.is_file():
        return None
    if not is_contained(root, abs_path):
        return None
    try:
        return abs_path.read_text(encoding="utf-8")
    except OSError:
        return None


@dataclass(eq=False)
class _Selector:
    """An index entry as a selector: what it covers, and what the covered documents
    are assigned (category from the manifest's index-file binding, kind from the
    entry's block). Specificity: a direct file selector beats any directory
    selector; between directory selectors, deeper beats shallower."""

    path: str
    category: str
    kind: str
    index_rel: str
    is_file_selector: bool
    depth: int
    # Markdown paths this selector resolves to.
    covered: list[str]


# JavaScript's Number.MAX_SAFE_INTEGER, the Node SDK's file-selector rank.
_FILE_SELECTOR_RANK = 2**53 - 1


def _rank(s: _Selector) -> int:
    """Ordered specificity rank; higher wins. File selectors outrank every
    directory selector regardless of depth."""
    return _FILE_SELECTOR_RANK if s.is_file_selector else s.depth


def _expand_entry(
    root: str, index_rel: str, entry_path: str, findings: list[Finding]
) -> Optional[tuple[list[str], bool, list[str]]]:
    """Expand one parsed entry to its markdown paths, with per-entry diagnostics
    (a typo, a non-markdown file, and an empty directory each get a distinct
    finding instead of collapsing to one warning)."""
    abs_path = Path(root) / entry_path
    if not abs_path.exists():
        findings.append(
            Finding(
                "index-entry-missing",
                "error",
                f'entry "{entry_path}" does not exist',
                index_rel,
            )
        )
        return None
    if abs_path.is_file():
        if not entry_path.endswith(".md"):
            findings.append(
                Finding(
                    "index-entry-not-markdown",
                    "error",
                    f'entry "{entry_path}" is not a markdown file',
                    index_rel,
                )
            )
            return None
        md = walk_md(root, entry_path)  # [entry_path] unless a symlink escapes root
        if not md:
            findings.append(
                Finding(
                    "index-entry-missing",
                    "error",
                    f'entry "{entry_path}" escapes the layer root',
                    index_rel,
                )
            )
            return None
        return md, True, []
    if abs_path.is_dir():
        # Directory expansion skips READMEs (repo furniture by default); an
        # explicit file selector includes one deliberately. The skips are reported
        # so the carve-out is never silent (leji status surfaces them).
        all_md = walk_md(root, entry_path)
        md = [p for p in all_md if posixpath.basename(p).lower() != "readme.md"]
        skipped_readmes = [p for p in all_md if posixpath.basename(p).lower() == "readme.md"]
        if not md:
            findings.append(
                Finding(
                    "index-entry-empty",
                    "warning",
                    f'directory entry "{entry_path}" contains no markdown',
                    index_rel,
                )
            )
        return md, False, skipped_readmes
    findings.append(
        Finding(
            "index-entry-missing",
            "error",
            f'entry "{entry_path}" is neither a file nor a directory',
            index_rel,
        )
    )
    return None


def _collect_selectors(
    root: str, manifest: Manifest
) -> tuple[list[_Selector], list[Finding], list[tuple[str, str]]]:
    """Collect every selector across every mapped category, with parse/expansion
    findings. Category order (CATEGORY_IDS) and entry order are preserved so
    diagnostics are deterministic across the three SDKs."""
    selectors: list[_Selector] = []
    findings: list[Finding] = []
    skipped_readmes: list[tuple[str, str]] = []
    for category in CATEGORY_IDS:
        mapping = manifest["categories"].get(category)
        if not mapping:
            continue
        for index_rel in mapping["indexes"]:
            text = _read_text_within(root, Path(root) / index_rel)
            if text is None:
                findings.append(
                    Finding(
                        "index-file-missing",
                        "error",
                        f"{category} index file is missing or escapes the layer root",
                        index_rel,
                    )
                )
                continue
            parsed = parse_index_file(text)
            for err in parsed.errors:
                findings.append(Finding("index-file-parse", "error", err, index_rel))
            for entry in parsed.entries:
                expanded = _expand_entry(root, index_rel, entry.path, findings)
                if expanded is None:
                    continue
                covered, is_file_selector, skipped = expanded
                selectors.append(
                    _Selector(
                        path=entry.path,
                        category=category,
                        kind=entry.kind,
                        index_rel=index_rel,
                        is_file_selector=is_file_selector,
                        depth=len(entry.path.rstrip("/").split("/")),
                        covered=covered,
                    )
                )
                for rel in skipped:
                    skipped_readmes.append((index_rel, rel))
    return selectors, findings, skipped_readmes


def resolve_category_paths(
    root: str, manifest: Manifest, category: str
) -> tuple[list[str], list[Finding]]:
    """Resolve one category's index files to the repo-relative markdown paths they
    include, honoring selector specificity: a document covered by this category's
    selectors but won by a more-specific selector of another category is excluded.
    Problems surface as findings, never raises."""
    assignments, findings, _shadowed = resolve_category_assignments(
        root, manifest, include_excluded=True
    )
    paths = [rel_path for rel_path, a in assignments.items() if a.category == category]
    return paths, findings


@dataclass
class Assignment:
    """A document's resolved assignment: its single category, the winning
    selector's kind (before any frontmatter override), and the index file that
    declared the winning selector (the viewer groups by it)."""

    category: str
    kind: str
    index_rel: str


def resolve_category_assignments_with_skips(
    root: str, manifest: Manifest, include_excluded: bool = False
) -> tuple[dict[str, Assignment], list[Finding], list[tuple[str, str]], list[tuple[str, str]]]:
    """Resolve the governed set without reading document frontmatter: each governed
    path mapped to its single category and block kind by the most-specific
    selector (file beats directory, deeper directory beats ancestor). Selectors of
    equal specificity that disagree on category or kind are hard errors; identical
    assignments resolve once. Broad selectors fully displaced by more-specific
    ones are reported as ``(index_rel, path)`` shadowed pairs (informational;
    ``leji status`` surfaces them), and READMEs skipped by directory expansion as
    ``(index_rel, path)`` skipped pairs. ``scan_categories`` adds frontmatter on
    top."""
    excluded = excluded_from_categories(manifest)
    selectors, findings, raw_skips = _collect_selectors(root, manifest)

    # Group candidate selectors per document.
    by_doc: dict[str, list[_Selector]] = {}
    for s in selectors:
        for rel_path in s.covered:
            if not include_excluded and excluded(rel_path):
                continue
            by_doc.setdefault(rel_path, []).append(s)

    assignments: dict[str, Assignment] = {}
    winners: set[_Selector] = set()
    for rel_path in sorted(by_doc):
        cands = by_doc[rel_path]
        top = max(_rank(s) for s in cands)
        best = [s for s in cands if _rank(s) == top]
        first = best[0]
        conflicting = [s for s in best if s.category != first.category or s.kind != first.kind]
        if conflicting:
            # Deterministic message: name the two clashing assignments in category order.
            other = conflicting[0]
            findings.append(
                Finding(
                    "category-conflict",
                    "error",
                    f"{rel_path} is selected with equal specificity as "
                    f"{first.category}/{first.kind} ({first.index_rel}) and "
                    f"{other.category}/{other.kind} ({other.index_rel}); "
                    "a document resolves to exactly one category and kind",
                    rel_path,
                )
            )
            continue
        for s in best:
            winners.add(s)
        assignments[rel_path] = Assignment(
            category=first.category, kind=first.kind, index_rel=first.index_rel
        )

    # A selector that covered documents but won none is fully shadowed by
    # more-specific selectors: dead weight worth surfacing, never an error.
    shadowed: list[tuple[str, str]] = []
    for s in selectors:
        covered_governed = [p for p in s.covered if include_excluded or not excluded(p)]
        if not covered_governed:
            continue
        if s not in winners:
            shadowed.append((s.index_rel, s.path))

    # A README skipped by directory expansion is only reportable while it stays
    # ungoverned: an explicit file selector elsewhere resolves the carve-out.
    seen_skip: set[tuple[str, str]] = set()
    skipped_readmes: list[tuple[str, str]] = []
    for index_rel, rel in raw_skips:
        if rel in assignments:
            continue
        key = (index_rel, rel)
        if key in seen_skip:
            continue
        seen_skip.add(key)
        skipped_readmes.append(key)

    return assignments, findings, shadowed, skipped_readmes


def resolve_category_assignments(
    root: str, manifest: Manifest, include_excluded: bool = False
) -> tuple[dict[str, Assignment], list[Finding], list[tuple[str, str]]]:
    """The assignment resolution without the skipped-README report; see
    ``resolve_category_assignments_with_skips`` (kept as a stable 3-tuple for
    callers that only need assignments/findings/shadowed)."""
    assignments, findings, shadowed, _skipped = resolve_category_assignments_with_skips(
        root, manifest, include_excluded=include_excluded
    )
    return assignments, findings, shadowed


def _json_stringify(value: Any) -> str:
    """JSON-encode a frontmatter value the way JS ``JSON.stringify`` does (an
    integral float collapses: YAML ``1.0`` reads back as the number 1)."""

    def normalize(v: Any) -> Any:
        if isinstance(v, float) and v.is_integer():
            return int(v)
        if isinstance(v, dict):
            return {k: normalize(x) for k, x in v.items()}
        if isinstance(v, list):
            return [normalize(x) for x in v]
        return v

    return json.dumps(normalize(value), separators=(",", ":"), ensure_ascii=False)


def scan_categories(root: str, manifest: Manifest) -> CategoryScan:
    """Collect governed category documents with their resolved kind: the
    winning selector's block kind, overridden by valid frontmatter ``kind``
    (decision-category documents are inherently records)."""
    assignments, findings, _shadowed = resolve_category_assignments(root, manifest)
    docs: list[ScannedDoc] = []
    for rel_path in sorted(assignments):
        a = assignments[rel_path]
        text = (Path(root) / rel_path).read_text(encoding="utf-8")
        fm = parse_frontmatter(text)
        # Decision-category documents are inherently records; their (closed)
        # schema rejects an explicit `kind`, so no override applies.
        kind = "record" if a.category == "decisions" else a.kind
        if fm.data is not None and "kind" in fm.data and a.category != "decisions":
            fm_kind = fm.data["kind"]
            if isinstance(fm_kind, str) and fm_kind in DOC_KINDS:
                # Frontmatter overrides the block kind, never the category.
                kind = fm_kind
            else:
                findings.append(
                    Finding(
                        "kind-invalid",
                        "error",
                        "frontmatter kind must be intent or record; "
                        f"got {_json_stringify(fm_kind)}",
                        rel_path,
                    )
                )
        docs.append(
            ScannedDoc(
                rel_path=rel_path,
                category=a.category,
                kind=kind,
                frontmatter=fm.data,
                body=fm.body,
            )
        )
    return CategoryScan(docs=docs, findings=findings)


def _scan_frontmatter_artifact(
    text: str, rel_path: str, schema_name: str, rule: str
) -> ScannedProfile:
    """One frontmatter artifact's text parsed and validated: an unparseable block,
    a missing block, and every schema violation, each under the caller's rule name.
    The single per-file path, so every scan that produces a ``ScannedProfile``
    produces the same findings for the same bytes and no caller can hand back an
    artifact whose validity was never established."""
    fm = parse_frontmatter(text)
    findings: list[Finding] = []
    if fm.error:
        findings.append(Finding(rule, "error", fm.error, rel_path))
    elif fm.data is None:
        findings.append(Finding(rule, "error", "missing YAML frontmatter", rel_path))
    else:
        for err in schema_errors(schema_name, fm.data):
            findings.append(Finding(rule, "error", err, rel_path))
    return ScannedProfile(rel_path=rel_path, frontmatter=fm.data, body=fm.body, findings=findings)


#: How a scan gets one artifact's bytes, and whether it may have them at all. The
#: default reads by path; a caller composing something it will serve or export
#: passes a reader that binds the check to the read (check-before-act), and returns None for a
#: source it refuses — missing, not a regular file, or resolving somewhere it may
#: not be read from. A refused artifact is dropped from the scan, exactly as the
#: whitelist filter it replaces dropped it, so validation (which passes no reader)
#: is unaffected.
ArtifactReader = Callable[[str], Optional[str]]


def _scan_frontmatter_artifacts(
    root: str,
    directory: str,
    schema_name: str,
    rule: str,
    read: Optional[ArtifactReader] = None,
) -> list[ScannedProfile]:
    out: list[ScannedProfile] = []
    for rel_path in walk_md(root, directory):
        if posixpath.basename(rel_path).lower() == "readme.md":
            continue
        text = (
            (Path(root) / rel_path).read_text(encoding="utf-8") if read is None else read(rel_path)
        )
        if text is None:
            continue
        out.append(_scan_frontmatter_artifact(text, rel_path, schema_name, rule))
    return out


def scan_agent_profiles(
    root: str, manifest: Manifest, read: Optional[ArtifactReader] = None
) -> list[ScannedProfile]:
    directory = effective_agent_profiles_path(manifest)
    return _scan_frontmatter_artifacts(
        root, directory, "agent-profile", "profile-frontmatter", read
    )


def scan_profile_set(root: str, manifest: Manifest) -> list[ScannedProfile]:
    """The profile set inheritance resolves against: the ``agentProfilesPath`` scan
    plus any ``agents``-bound profile living outside that directory (a bound profile
    is part of the layer's roster wherever it sits, so it can be an inheritance
    target and it counts toward target ambiguity). Sorted by path so ambiguity
    messages and finding order are deterministic.

    Out-of-directory entries are validated here, by the same per-file path the
    directory scan uses, so every profile in the set carries its own findings. A
    profile whose validity was never established is exactly the one a resolver
    would compose into an effective profile and a viewer would render as governing
    posture. The agents-map check validates these files too and emits
    byte-identical findings, so ``profile_inheritance_findings`` collapses the pair
    rather than reporting either twice."""
    return scan_profile_set_with(root, manifest)


def scan_profile_set_with(
    root: str, manifest: Manifest, read: Optional[ArtifactReader] = None
) -> list[ScannedProfile]:
    """The same scan through a caller's reader — the seam a viewer or export needs
    and nobody else does. A None reader is :func:`scan_profile_set`'s own
    read-by-path behavior."""
    profiles = scan_agent_profiles(root, manifest, read)
    directory = effective_agent_profiles_path(manifest)
    seen = {p.rel_path for p in profiles}
    for rel in (manifest.get("agents") or {}).values():
        if rel in seen or under_path(rel, directory):
            continue
        text = _read_text_within(root, Path(root) / rel) if read is None else read(rel)
        if text is None:
            continue  # missing or escaping: the agents-map check owns that
        seen.add(rel)
        profiles.append(
            _scan_frontmatter_artifact(text, rel, "agent-profile", "profile-frontmatter")
        )
    # Encoding to UTF-8 makes the sort key the one byte order every ordered
    # canonical surface uses across the three SDKs.
    return sorted(profiles, key=lambda p: p.rel_path.encode("utf-8"))


# Frontmatter arrays that compose across an inheritance edge. Every other field is
# the derived profile's own; none of them is ever inherited.
POSTURE_KEYS = ("requiredRead", "defaultContext", "mustAskWhen", "mustRefuseWhen")


@dataclass
class ResolvedProfile:
    """The effective profile after single-level inheritance resolution. On a
    resolution error ``frontmatter`` and ``body`` are None: there is no partial
    effective profile to apply, only findings."""

    frontmatter: Optional[dict[str, Any]]
    body: Optional[str]
    # ``[base_id, derived_id]`` when inheritance resolved, ``[id]`` when the
    # profile stands alone, empty on a resolution error.
    source_ids: list[str]
    findings: list[Finding]


def _body_half(raw: str) -> str:
    """One body as the effective profile carries it. Both bodies are normative, so
    only two things are canonicalized: line endings become LF, and the boundary
    blank lines (the newline the frontmatter fence leaves in front, any run of
    newlines at the end) collapse to one trailing newline. Nothing else is touched:
    no whitespace is stripped from a line, so a leading indented code block and a
    trailing hard break both survive resolution byte for byte."""
    return raw.replace("\r\n", "\n").lstrip("\n").rstrip("\n") + "\n"


# A profile id as the schema patterns it. Resolution interpolates ids into the
# effective body's comment markers, so an id that is not identifier-shaped is
# refused before interpolation rather than allowed to close or forge a marker.
_PROFILE_ID = re.compile(r"[a-z0-9]+(-[a-z0-9]+)*")


# U+001F (ASCII UNIT SEPARATOR), written as an escape so every source file stays
# plain ASCII text: three literal NUL bytes used to sit in the Node reference, which
# made every ``grep`` treat the whole file as binary and skip it without saying so.
# It is also why the relation has to be spelled the same in all three SDKs, where a
# space stood in for it. A control character cannot appear in a governed path, a rule
# id, or a severity, so unlike any graphic character it cannot make two different
# findings key alike.
_FINDING_KEY_SEP = "\u001f"


def finding_key(f: Finding) -> str:
    """Identity of a finding, so resolution never re-reports one a scan carries."""
    return _FINDING_KEY_SEP.join([f.path or "", f.rule, f.severity, f.message])


def _posture_key(value: Any) -> str:
    """A posture entry's identity for duplicate removal: the decoded string
    compared by its UTF-8 encoding (Python string equality is the same relation for
    scalar strings). Non-string entries are schema violations; key them
    structurally so resolution stays total rather than raising on an invalid
    profile."""
    return f"s{value}" if isinstance(value, str) else f"j{_json_stringify(value)}"


def _compose_posture(base_value: Any, derived_value: Any) -> Any:
    """Base entries in their authored order, then the derived entries that the base
    does not already carry, in theirs. No sorting: authored order is loading intent.
    A derived value that is not an array is a schema violation the
    authored-frontmatter check already reports; it contributes nothing here rather
    than replacing the base."""
    if not isinstance(derived_value, list):
        return list(base_value) if isinstance(base_value, list) else derived_value
    if not isinstance(base_value, list):
        return derived_value
    in_base = {_posture_key(v) for v in base_value}
    return [*base_value, *[v for v in derived_value if _posture_key(v) not in in_base]]


def resolve_agent_profile(
    derived: ScannedProfile, profiles: list[ScannedProfile]
) -> ResolvedProfile:
    """Resolve one agent profile's ``inherits`` against the layer's profile set:
    single level, to exactly one ``role: core`` base that itself inherits nothing.
    Posture arrays union base-first with exact duplicates dropped; every other
    field, ``inherits`` included, is the derived profile's own; both bodies are
    operative, base first, each behind a marker naming its source. A profile that
    declares no ``inherits`` resolves to itself.

    Resolution is all-or-nothing. A source profile carrying an error finding, an
    inheritance that does not satisfy the single-level rules, or an effective
    profile that would still lack ``requiredRead`` or ``mustAskWhen`` all come back
    as findings with ``frontmatter`` and ``body`` None: there is no half-resolved
    profile for a caller to apply. Never raises."""
    fm = derived.frontmatter
    raw_id = fm.get("id") if fm else None
    derived_id = raw_id if isinstance(raw_id, str) else ""
    inherits = fm.get("inherits") if fm else None

    def refuse(findings: list[Finding]) -> ResolvedProfile:
        return ResolvedProfile(frontmatter=None, body=None, source_ids=[], findings=findings)

    def unresolved(rule: str, message: str, at: Optional[str] = None) -> ResolvedProfile:
        return refuse([Finding(rule, "error", message, at or derived.rel_path)])

    # A source the scan already found invalid is not resolvable material: its
    # findings carry forward rather than being restated in resolution's own words.
    def errors_on(p: ScannedProfile) -> list[Finding]:
        return [f for f in p.findings if f.severity == "error"]

    if fm is None:
        return refuse(errors_on(derived))
    if not isinstance(inherits, str):
        own = errors_on(derived)
        if own:
            return refuse(own)
        return ResolvedProfile(
            frontmatter=fm, body=_body_half(derived.body), source_ids=[derived_id], findings=[]
        )
    derived_errors = errors_on(derived)
    if derived_errors:
        return refuse(derived_errors)

    # A core profile is the base of the single level, so it inherits nothing. This
    # also covers a core profile naming itself.
    if fm.get("role") == "core":
        return unresolved(
            "inherits-on-core",
            f'role is core but inherits "{inherits}"; a core profile is the base of '
            "the single inheritance level and inherits nothing",
        )
    targets = [p for p in profiles if (p.frontmatter or {}).get("id") == inherits]
    if not targets:
        return unresolved(
            "inherits-unknown", f'inherits "{inherits}" but no profile declares that id'
        )
    if len(targets) > 1:
        joined = ", ".join(t.rel_path for t in targets)
        return unresolved(
            "inherits-ambiguous-target",
            f'inherits "{inherits}" but {len(targets)} profiles declare that id '
            f"({joined}); the target must be unique",
        )
    base = targets[0]
    base_fm = base.frontmatter or {}
    # Covers a non-core profile naming itself: its own role is not core.
    if base_fm.get("role") != "core":
        return unresolved(
            "inherits-target-not-core",
            f'inherits "{inherits}" ({base.rel_path}), whose role is '
            f'{_json_stringify(base_fm.get("role"))}, not "core"; a profile may only '
            "extend a core profile",
        )
    # The base must be a leaf of the single level. Without this, a derived profile
    # would resolve through an inheriting core and get an effective profile that the
    # single-level rule says cannot exist. The base carries its own
    # `inherits-on-core` from its own resolution; this one says why the derived
    # profile is unusable, so both files are flagged.
    base_inherits = base_fm.get("inherits")
    if isinstance(base_inherits, str):
        return unresolved(
            "inherits-on-core",
            f'inherits "{inherits}" ({base.rel_path}), which itself declares inherits '
            f'"{base_inherits}"; resolution is single level, so the base of an '
            "inheritance declares none",
        )
    base_errors = errors_on(base)
    if base_errors:
        return refuse(base_errors)
    for p in (base, derived):
        pid = (p.frontmatter or {}).get("id")
        if not isinstance(pid, str) or not _PROFILE_ID.fullmatch(pid):
            return unresolved(
                "profile-frontmatter",
                f"id {_json_stringify(pid)} is not a valid profile identifier; the "
                "resolved profile interpolates ids into its body's source markers",
                p.rel_path,
            )

    effective: dict[str, Any] = {}
    for key, value in fm.items():
        if key == "inherits":
            continue  # a resolution directive, never effective frontmatter
        effective[key] = _compose_posture(base_fm.get(key), value) if key in POSTURE_KEYS else value
    # Posture the derived profile omits entirely still comes from the base.
    for key in POSTURE_KEYS:
        if key in effective or not isinstance(base_fm.get(key), list):
            continue
        effective[key] = list(base_fm[key])
    # The resolved profile is what the spec's requirement binds, so it is checked
    # here too: a base that supplies neither leaves the role without the two fields
    # every profile must carry, and half a posture is worse than a refusal.
    for key in ("requiredRead", "mustAskWhen"):
        value = effective.get(key)
        if not isinstance(value, list) or len(value) == 0:
            return unresolved(
                "profile-frontmatter",
                f"the resolved profile has no {key}: this profile omits it and its "
                f"base {base.rel_path} does not supply it",
            )
    return ResolvedProfile(
        frontmatter=effective,
        body=f"<!-- inherited from: {inherits} -->\n\n{_body_half(base.body)}\n"
        f"<!-- {derived_id} -->\n\n{_body_half(derived.body)}",
        source_ids=[inherits, derived_id],
        findings=[],
    )


def profile_inheritance_findings(profiles: list[ScannedProfile]) -> list[Finding]:
    """Resolution findings for every profile in the set that declares ``inherits``.
    Findings the scan already carries are dropped: resolution propagates a source's
    errors to its own callers, but a validator has reported those from the scan."""
    already_reported = {finding_key(f) for p in profiles for f in p.findings}
    findings: list[Finding] = []
    for p in profiles:
        if not isinstance((p.frontmatter or {}).get("inherits"), str):
            continue
        for f in resolve_agent_profile(p, profiles).findings:
            if finding_key(f) not in already_reported:
                findings.append(f)
    return findings


def scan_decision_records(root: str, manifest: Manifest) -> list[ScannedProfile]:
    # Decision records are scanned from the declared records path and from the
    # decisions category's resolved index entries; a layer may use either or both.
    rel_paths: set[str] = set()
    for rel in walk_md(root, effective_decision_records_path(manifest)):
        rel_paths.add(rel)
    for rel in resolve_category_paths(root, manifest, "decisions")[0]:
        rel_paths.add(rel)
    out: list[ScannedProfile] = []
    for rel_path in sorted(rel_paths):
        if posixpath.basename(rel_path).lower() == "readme.md":
            continue
        text = (Path(root) / rel_path).read_text(encoding="utf-8")
        fm = parse_frontmatter(text)
        findings: list[Finding] = []
        if fm.error:
            findings.append(Finding("decision-frontmatter", "error", fm.error, rel_path))
        elif fm.data is None:
            findings.append(
                Finding("decision-frontmatter", "error", "missing YAML frontmatter", rel_path)
            )
        else:
            for err in schema_errors("decision-record", fm.data):
                findings.append(Finding("decision-frontmatter", "error", err, rel_path))
        out.append(
            ScannedProfile(rel_path=rel_path, frontmatter=fm.data, body=fm.body, findings=findings)
        )
    return out


def duplicate_id_findings(items: list[tuple[Any, str]], scope: str) -> list[Finding]:
    """Duplicate-id findings across (id, rel_path) pairs."""
    seen: dict[str, str] = {}
    findings: list[Finding] = []
    for item_id, rel_path in items:
        if not isinstance(item_id, str) or item_id == "":
            continue
        first = seen.get(item_id)
        if first is not None and first != rel_path:
            findings.append(
                Finding(
                    "id-duplicate",
                    "error",
                    f'{scope} id "{item_id}" already used by {first}',
                    rel_path,
                )
            )
        else:
            seen[item_id] = rel_path
    return findings


def read_json_artifact(root: str, rel_path: str) -> tuple[Optional[object], Optional[Finding]]:
    abs_path = Path(root) / rel_path
    if not abs_path.is_file():
        return None, None
    if not resolved_within_root(root, abs_path):
        return None, Finding(
            "artifact-parse",
            "error",
            f"artifact {rel_path} resolves outside the layer root",
            rel_path,
        )
    try:
        return json.loads(abs_path.read_text(encoding="utf-8")), None
    except json.JSONDecodeError as e:
        return None, Finding("artifact-parse", "error", f"invalid JSON: {e}", rel_path)
