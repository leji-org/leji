"""Freshness horizons report (reviewAfter), mirroring the Node SDK."""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass

from .findings import Finding, sort_findings
from .layer import scan_agent_profiles, scan_categories
from .manifest import Manifest

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@dataclass
class FreshnessReport:
    expired: list[dict]
    upcoming: list[dict]
    declared: int
    findings: list[Finding]


def _review_after_of(fm: dict | None) -> str | None:
    freshness = (fm or {}).get("freshness")
    if not isinstance(freshness, dict):
        return None
    v = freshness.get("reviewAfter")
    return v if isinstance(v, str) and _DATE.fullmatch(v) else None


def freshness_report(root: str, manifest: Manifest, strict: bool = False) -> FreshnessReport:
    """Report-only by default (warnings); --strict raises expired horizons to
    errors. Scans documents directly so it works at any conformance level."""
    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
    horizon = (dt.datetime.now(dt.timezone.utc).date() + dt.timedelta(days=30)).isoformat()

    items: list[dict] = []
    for doc in scan_categories(root, manifest):
        review_after = _review_after_of(doc.frontmatter)
        if review_after:
            items.append({"path": doc.rel_path, "reviewAfter": review_after})
    for profile in scan_agent_profiles(root, manifest):
        review_after = _review_after_of(profile.frontmatter)
        if review_after:
            items.append({"path": profile.rel_path, "reviewAfter": review_after})
    items.sort(key=lambda i: (i["reviewAfter"], i["path"]))

    expired = [i for i in items if i["reviewAfter"] < today]
    upcoming = [i for i in items if today <= i["reviewAfter"] <= horizon]
    findings = [
        Finding(
            "freshness-expired",
            "error" if strict else "warning",
            f"review horizon {i['reviewAfter']} has passed",
            i["path"],
        )
        for i in expired
    ]
    return FreshnessReport(
        expired=expired, upcoming=upcoming, declared=len(items), findings=sort_findings(findings)
    )
