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

    def to_dict(self) -> dict:
        out: dict = {"rule": self.rule, "severity": self.severity}
        if self.path is not None:
            out["path"] = self.path
        out["message"] = self.message
        return out


def sort_findings(findings: list[Finding]) -> list[Finding]:
    return sorted(findings, key=lambda f: (f.path or "", f.rule, f.message))


def summarize(findings: list[Finding]) -> dict:
    errors = sum(1 for f in findings if f.severity == "error")
    return {"errors": errors, "warnings": len(findings) - errors}


def has_errors(findings: list[Finding]) -> bool:
    return any(f.severity == "error" for f in findings)
