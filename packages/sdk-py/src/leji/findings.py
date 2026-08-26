"""Findings: the shared result shape of every check, mirrored by the Node SDK."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional

Severity = Literal["error", "warning"]


@dataclass(frozen=True)
class Finding:
    rule: str
    severity: Severity
    message: str
    path: Optional[str] = None
    #: 1-based line within ``path`` when the rule locates one (the rendering
    #: lint); None when it does not, and then omitted from the JSON.
    line: Optional[int] = None
    #: The closed-token construct a rule names, when it carries one: what the
    #: three SDKs compare on for ``render-unsupported``, message text being
    #: outside the contract. None when the rule names none, and then omitted.
    construct: Optional[str] = None
    #: Which act a rule with more than one failed at, and the resolver's own
    #: reason for it: ``"<act>: <reason>"``. Serialized immediately after
    #: ``message``, so the three SDKs emit the same bytes; None for every rule
    #: that names no act, and then omitted.
    detail: Optional[str] = None

    def to_dict(self) -> dict:
        out: dict = {"rule": self.rule, "severity": self.severity}
        if self.path is not None:
            out["path"] = self.path
        if self.line is not None:
            out["line"] = self.line
        if self.construct is not None:
            out["construct"] = self.construct
        out["message"] = self.message
        if self.detail is not None:
            out["detail"] = self.detail
        return out


def sort_findings(findings: list[Finding]) -> list[Finding]:
    """Findings in canonical order: (path, line, rule, construct), message last as
    the final tie-break. The line and construct keys carry the rendering lint's
    ordering — two constructs reported on one line stay in the same order in all
    three SDKs — and change nothing for a rule that locates neither."""
    return sorted(
        findings,
        key=lambda f: (f.path or "", f.line or 0, f.rule, f.construct or "", f.message),
    )


def summarize(findings: list[Finding]) -> dict:
    errors = sum(1 for f in findings if f.severity == "error")
    return {"errors": errors, "warnings": len(findings) - errors}


def has_errors(findings: list[Finding]) -> bool:
    return any(f.severity == "error" for f in findings)
