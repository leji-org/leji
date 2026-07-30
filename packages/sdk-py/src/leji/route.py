"""The reference implementation of the Task routing algorithm
(spec/machine-readable-surface.md, "Task routing"): given a task's scope (the
repo-relative POSIX paths it reads or changes, plus any categories and topics it
names), compute the slice of governed context that scope selects. Composes the
existing category-assignment and decision-record scans; adds no new I/O."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Optional

from .fsx import under_path
from .layer import scan_categories, scan_decision_records
from .manifest import CATEGORY_IDS, Manifest

# Decision-record statuses that bind as routable current guidance: ``accepted`` is
# current, ``deprecated`` binds with a stale posture. ``superseded``, ``proposed``,
# and ``rejected`` never bind (Task routing, status filter).
LIVE_STATUSES = ["accepted", "deprecated"]


@dataclass
class RouteInput:
    # Normalized on the way in (``normalize_task_path``); a path with no
    # root-relative form is an input error, never a silent non-match.
    paths: list[str] = field(default_factory=list)
    categories: list[str] = field(default_factory=list)
    # Topics the task explicitly names. Caller-supplied routing signals, never
    # derived here from paths, categories, prose, or content. Matched against a
    # mount's declared ``topics`` by exact string equality; duplicates collapse to
    # one signal, and an invalid entry raises rather than being dropped.
    topics: list[str] = field(default_factory=list)
    as_of: str = ""


@dataclass
class RoutedDecision:
    id: str
    path: str
    status: str
    matched_by: str
    # Decisions carry no review horizon (their schema forbids freshness), so these
    # are always None/False; present for a uniform routed shape.
    review_after: Optional[str] = None
    expired: bool = False


@dataclass
class RoutedDocument:
    path: str
    category: str
    review_after: Optional[str] = None
    expired: bool = False


@dataclass
class RoutedRecord:
    """A governed record routed as a dated candidate, never as current intent. A
    record is ``required`` only when the task's path scope selects it directly;
    being a category match (or the newest by date) never makes it required."""

    path: str
    category: str
    # The record's frontmatter date, or None when it declares none.
    date: Optional[str] = None
    required: bool = False


_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z)?$")


def _freshness_of(fm: Any, as_of: str) -> tuple[Optional[str], bool]:
    """A document's freshness.reviewAfter and whether it has passed as_of."""
    fr = fm.get("freshness") if isinstance(fm, dict) else None
    ra = fr.get("reviewAfter") if isinstance(fr, dict) else None
    if not isinstance(ra, str):
        return None, False
    expired = bool(as_of) and ra < as_of
    return ra, expired


@dataclass
class RoutedMount:
    """A federated sibling mount matched by the supplied category or topic signals.
    Both are machine-decidable: categories by the signalled set, ``topics`` by exact
    string equality against the topics the task names. ``requiredWhen`` stays
    free-text the agent judges, so absence here does not prove a mount irrelevant or
    not required. distribution.md, "Reading a federated context layer"."""

    name: str
    pin: str


@dataclass
class RouteResult:
    path_scoped: bool
    categories: list[str]
    category_signals: list[str]
    # Governed INTENT documents in an expanded category, plus any the task's paths
    # select directly (the required context), sorted by path. Records never appear here.
    documents: list[RoutedDocument]
    # Record candidates: dated entries the agent
    # loads by judgment, sorted by path. Decision records route via ``decisions``,
    # never here.
    records: list[RoutedRecord]
    decisions: list[RoutedDecision]
    mounts: list[RoutedMount]


def _paths_overlap(a: str, b: str) -> bool:
    """Overlap-aware, bidirectional path containment: equal, or one an ancestor of
    the other (the ``under_path`` relation in both directions)."""
    return under_path(a, b) or under_path(b, a)


def normalize_task_path(p: str) -> Optional[str]:
    """Normalize one task-scope path (spec: Requirement 6 and Task routing items
    1-2): POSIX-style, root-relative, no leading ``./``, any trailing ``/``
    removed, and ``.`` and ``..`` segments resolved lexically. Never consults the
    filesystem. The repository root normalizes to ``.``, which the containment
    relation treats as matching everything.

    Returns None for a path with no root-relative form: an absolute path, or one
    whose ``..`` segments climb above the root. Callers reject those rather than
    pass them through - an unnormalized task path silently fails to match the
    declared side, which is how ``--federation=required`` used to pass open on
    ``./docs/x.md`` and on ``docs/x.md/`` while failing correctly on
    ``docs/x.md``.

    Deliberately not ``posixpath.normpath``: it maps an escaping ``../x`` to
    ``../x`` and an absolute path to itself, so it cannot report the rejection
    this owes its caller."""
    if p.startswith("/"):
        return None
    out: list[str] = []
    for seg in p.split("/"):
        if seg == "" or seg == ".":
            continue
        if seg == "..":
            if not out:
                return None
            out.pop()
            continue
        out.append(seg)
    return "/".join(out) if out else "."


def _as_str_list(v: Any) -> list[str]:
    if not isinstance(v, list):
        return []
    return [x for x in v if isinstance(x, str)]


def _topic_defect(t: Any) -> Optional[str]:
    """Why a value is not a valid topic, or None when it is one. A topic is a
    non-empty string of Unicode scalar values, so an unpaired surrogate (which has
    no UTF-8 encoding) is as invalid as an empty string. In Python a lone surrogate
    arrives through a JSON ``\\uD800`` escape or a surrogatepass decode; a matched
    pair has already been combined into one astral scalar value, so only a lone
    surrogate is seen here."""
    if not isinstance(t, str):
        return "not a string"
    if len(t) == 0:
        return "empty string"
    return "lone surrogate" if any(0xD800 <= ord(c) <= 0xDFFF for c in t) else None


def _task_topic_set(scope: RouteInput, manifest: Manifest) -> set[str]:
    """The effective task topic set, after validating BOTH sides of the comparison
    (spec: Task routing, Topic match). An invalid topic is an input error on either
    side, never a silent filter: dropping one would return a plausible empty match
    the caller cannot tell from a real one, and dropping the same lone surrogate
    from both sides would let two invalid values appear to match. A set dedupes by
    exact equality, which for valid topics is equality of their UTF-8 encodings."""
    for t in scope.topics:
        defect = _topic_defect(t)
        if defect is not None:
            raise ValueError(f"invalid task topic: {defect}")
    for mt in (manifest.get("federation") or {}).get("mounts") or []:
        for t in mt.get("topics") or []:
            defect = _topic_defect(t)
            if defect is not None:
                raise ValueError(f'invalid mount topic on "{mt["name"]}": {defect}')
    return set(scope.topics)


def route(root: str, manifest: Manifest, scope: RouteInput) -> RouteResult:
    """Compute the routed slice for a task's scope. Raises on an unnormalizable
    task path, and on an invalid topic on either side of the comparison: a caller
    topic or a declared mount topic that
    is not a non-empty string of Unicode scalar values is an input error. Everything
    else is tolerant as before (malformed records simply do not bind). Topics are
    matched as exact strings: no case conversion, no Unicode normalization, no
    locale, no trimming."""
    # Both sides of the comparison normalize, or the matching is not the spec's.
    # An unnormalizable path is an input error, never a silent non-match: the
    # caller cannot tell a scope that routes nothing from one it spelled wrongly,
    # and a federation gate reading the second as the first fails open.
    task_paths: list[str] = []
    for raw in scope.paths:
        if not raw:
            continue
        normalized = normalize_task_path(raw)
        if normalized is None:
            raise ValueError(
                f"invalid task path {json.dumps(raw, ensure_ascii=False)}: must be "
                'repository-root-relative POSIX (no leading "/", no ".." above the root)'
            )
        task_paths.append(normalized)
    path_scoped = len(task_paths) > 0
    task_topics = _task_topic_set(scope, manifest)

    scan = scan_categories(root, manifest)
    assignments: dict[str, str] = {}
    kind_by_path: dict[str, str] = {}
    fm_by_path: dict[str, Any] = {}
    for d in scan.docs:
        assignments[d.rel_path] = d.category
        kind_by_path[d.rel_path] = d.kind
        fm_by_path[d.rel_path] = d.frontmatter

    # Two category sets (spec: Task routing, item 3). A category the task NAMES is
    # expanded: it loads its intent documents and record candidates. A task path that
    # is itself a governed document contributes its category to signalled only - a
    # matching signal for decisions and mounts that loads nothing. The governed-document
    # test is exact equality, never containment: an ancestor directory of a governed
    # document is not itself governed, and inferring from one would reopen the corpus
    # fan-out this split exists to close.
    expanded: set[str] = set()
    for c in scope.categories:
        if c in CATEGORY_IDS:
            expanded.add(c)
    signalled: set[str] = set(expanded)
    for p in task_paths:
        cat = assignments.get(p)
        if cat:
            signalled.add(cat)

    def _directly_selected(path: str) -> bool:
        # A record or document is DIRECTLY selected when a task path contains it under
        # the lexical rule - evaluated independently of category, because a path scope
        # selects no category at all and the entry would otherwise be dropped below.
        return any(_paths_overlap(tp, path) for tp in task_paths)

    # Routing separation: intent documents are the required context; records are
    # returned separately as dated candidates. A record is required only when the
    # task's paths select it directly.
    documents: list[RoutedDocument] = []
    records: list[RoutedRecord] = []
    for p, category in assignments.items():
        if category not in expanded and not _directly_selected(p):
            continue
        if kind_by_path.get(p) == "record":
            # Decision records route via `decisions`, never as generic records.
            if category == "decisions":
                continue
            fm = fm_by_path.get(p)
            raw_date = fm.get("date") if isinstance(fm, dict) else None
            date = raw_date if isinstance(raw_date, str) and _DATE.fullmatch(raw_date) else None
            records.append(
                RoutedRecord(
                    path=p,
                    category=category,
                    date=date,
                    required=_directly_selected(p),
                )
            )
            continue
        review_after, expired = _freshness_of(fm_by_path.get(p), scope.as_of)
        documents.append(
            RoutedDocument(path=p, category=category, review_after=review_after, expired=expired)
        )
    documents.sort(key=lambda x: x.path)
    records.sort(key=lambda x: x.path)

    decisions: list[RoutedDecision] = []
    for rec in scan_decision_records(root, manifest):
        fm = rec.frontmatter
        if not fm:
            continue
        status = fm.get("status")
        if not isinstance(status, str) or status not in LIVE_STATUSES:
            continue
        affected_paths = _as_str_list(fm.get("affectedPaths"))
        affected_categories = _as_str_list(fm.get("affectedCategories"))
        fm_id = fm.get("id")
        rid = fm_id if isinstance(fm_id, str) else ""

        matched_by: Optional[str] = None
        if not affected_paths and not affected_categories:
            matched_by = "unscoped"
        elif any(_paths_overlap(tp, ap) for tp in task_paths for ap in affected_paths):
            matched_by = "path"
        elif any(c in signalled for c in affected_categories):
            matched_by = "category"
        if matched_by:
            decisions.append(
                RoutedDecision(id=rid, path=rec.rel_path, status=status, matched_by=matched_by)
            )

    # Mounts matched by the supplied signals: a sibling whose `categories` overlap
    # the SIGNALLED set, or whose declared `topics` contain one the task named.
    # Signals match without expanding, so a path-scoped task still sees its mounts,
    # and a topic match selects the mount and nothing else: it never enters the
    # category sets, loads no document or record, and routes no decision. The agent
    # still applies the mount's free-text requiredWhen.
    mounts: list[RoutedMount] = []
    for mt in (manifest.get("federation") or {}).get("mounts") or []:
        if any(c in signalled for c in (mt.get("categories") or [])) or any(
            t in task_topics for t in (mt.get("topics") or [])
        ):
            mounts.append(RoutedMount(name=mt["name"], pin=mt["pin"]))
    mounts.sort(key=lambda x: x.name)

    categories = [c for c in CATEGORY_IDS if c in expanded]
    category_signals = [c for c in CATEGORY_IDS if c in signalled]
    return RouteResult(
        path_scoped=path_scoped,
        categories=categories,
        category_signals=category_signals,
        documents=documents,
        records=records,
        decisions=sorted(decisions, key=lambda d: d.path),
        mounts=mounts,
    )
