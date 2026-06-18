"""Best-effort detection of the coding-agent hosts available to this user.

Mirrors packages/sdk/src/lib/detect.ts: same host ids, aliases, ranking, and
adapter redirect text. Probes (PATH scan, homedir, platform) are injectable so
the result is deterministic under test.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional


@dataclass(frozen=True)
class HostSpec:
    """A coding-agent host Leji knows how to wire. ``adapter`` is the vendor
    entrypoint file Leji would create (a one-line redirect to the boot profile);
    ``None`` marks a directory-style host (Cursor, Windsurf) whose adapter wiring
    is deferred until validation grows directory semantics."""

    id: str
    name: str
    bins: list[str]
    repo_files: list[str]
    user_dirs: list[str]
    adapter: Optional[str]


HOST_SPECS: list[HostSpec] = [
    HostSpec(
        id="claude-code",
        name="Claude Code",
        bins=["claude"],
        repo_files=["CLAUDE.md"],
        user_dirs=[".claude", ".config/claude"],
        adapter="CLAUDE.md",
    ),
    HostSpec(
        id="codex",
        name="Codex",
        bins=["codex"],
        repo_files=["AGENTS.md"],
        user_dirs=[".codex"],
        adapter="AGENTS.md",
    ),
    HostSpec(
        id="copilot",
        name="GitHub Copilot",
        bins=["gh", "code"],
        repo_files=[".github/copilot-instructions.md"],
        user_dirs=[],
        adapter=".github/copilot-instructions.md",
    ),
    HostSpec(
        id="gemini",
        name="Gemini CLI",
        bins=["gemini"],
        repo_files=["GEMINI.md", ".gemini"],
        user_dirs=[".gemini"],
        adapter="GEMINI.md",
    ),
    HostSpec(
        id="cursor",
        name="Cursor",
        bins=["cursor"],
        repo_files=[".cursor/rules", ".cursorrules"],
        user_dirs=[],
        adapter=".cursor/rules/leji.md",
    ),
    HostSpec(
        id="windsurf",
        name="Windsurf",
        bins=["windsurf"],
        repo_files=[".windsurf/rules", ".windsurfrules"],
        user_dirs=[],
        adapter=".windsurf/rules/leji.md",
    ),
]

# Common aliases users type for a host id.
_HOST_ALIASES: dict[str, str] = {
    "claude": "claude-code",
    "claude-code": "claude-code",
    "codex": "codex",
    "copilot": "copilot",
    "github-copilot": "copilot",
    "gemini": "gemini",
    "cursor": "cursor",
    "windsurf": "windsurf",
}


def resolve_host_id(name: str) -> Optional[str]:
    return _HOST_ALIASES.get(name.lower())


# Signal strength, strongest first: a runnable binary beats a repo config file
# beats a user-level config directory.
_STRENGTH_RANK = {"confirmed": 0, "project-present": 1, "installed-likely": 2}


@dataclass
class DetectedHost:
    id: str
    name: str
    strength: str
    on_path: bool
    in_repo: bool
    user_config: bool
    adapter: Optional[str]

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "name": self.name,
            "strength": self.strength,
            "onPath": self.on_path,
            "inRepo": self.in_repo,
            "userConfig": self.user_config,
            "adapter": self.adapter,
        }


def _on_path_factory(env: dict[str, str], platform: str) -> Callable[[str], bool]:
    """Manual, dependency-free ``which``: scan PATH entries for an executable."""
    raw = env.get("PATH") or env.get("Path") or ""
    sep = ";" if platform == "win32" else ":"
    dirs = [d for d in raw.split(sep) if d]
    exts = [".exe", ".cmd", ".bat", ""] if platform == "win32" else [""]

    def has_binary(bin_name: str) -> bool:
        for d in dirs:
            for ext in exts:
                candidate = Path(d) / (bin_name + ext)
                if not candidate.is_file():
                    continue
                # On POSIX a "confirmed" host means a runnable binary: require an
                # executable bit. On Windows the extension implies executability.
                if platform == "win32" or os.access(candidate, os.X_OK):
                    return True
        return False

    return has_binary


def detect_hosts(
    root: str,
    env: Optional[dict[str, str]] = None,
    homedir: Optional[str] = None,
    platform: Optional[str] = None,
    has_binary: Optional[Callable[[str], bool]] = None,
) -> list[DetectedHost]:
    """Detect the coding-agent hosts available to this user, ranked by signal
    strength. Never launches anything and never writes; purely informs the
    handoff and (on explicit request) adapter wiring. Probes are injectable so
    the result is deterministic under test."""
    env = env if env is not None else dict(os.environ)
    platform = (
        platform if platform is not None else ("win32" if sys.platform == "win32" else sys.platform)
    )
    home = Path(homedir) if homedir is not None else Path.home()
    probe = has_binary if has_binary is not None else _on_path_factory(env, platform)

    root_path = Path(root)
    out: list[DetectedHost] = []
    for spec in HOST_SPECS:
        on_path = any(probe(b) for b in spec.bins)
        in_repo = any((root_path / f).exists() for f in spec.repo_files)
        user_config = any((home / d).exists() for d in spec.user_dirs)
        if not on_path and not in_repo and not user_config:
            continue
        strength = "confirmed" if on_path else "project-present" if in_repo else "installed-likely"
        out.append(
            DetectedHost(
                id=spec.id,
                name=spec.name,
                strength=strength,
                on_path=on_path,
                in_repo=in_repo,
                user_config=user_config,
                adapter=spec.adapter,
            )
        )
    out.sort(key=lambda h: (_STRENGTH_RANK[h.strength], h.id))
    return out


def adapter_content(boot_profile_path: str) -> str:
    """The one-line vendor redirect Leji writes for a file-style host."""
    return (
        f"Read ./{boot_profile_path} first. "
        "It is the canonical context entrypoint for this repository.\n"
    )


@dataclass
class DetectResult:
    hosts: list[DetectedHost]


def detect_layer(root: str) -> DetectResult:
    """Result of ``detect``: the agent hosts available to this user, ranked."""
    return DetectResult(hosts=detect_hosts(root))


def render_detect(hosts: list[DetectedHost]) -> str:
    """Human-readable detection report."""
    if not hosts:
        return (
            "No coding-agent hosts detected. Leji works without one; the onboarding "
            "brief still guides any agent you point at it."
        )
    lines = ["Detected agent hosts (strongest signal first):"]
    for h in hosts:
        signals = ", ".join(
            s
            for s in (
                "binary on PATH" if h.on_path else None,
                "config in repo" if h.in_repo else None,
                "user config" if h.user_config else None,
            )
            if s
        )
        adapter = (
            f"adapter {h.adapter}" if h.adapter else "directory-style adapter (wiring deferred)"
        )
        lines.append(f"   {h.strength.ljust(16)} {h.name} — {signals}; {adapter}")
    lines.extend(["", "Wire one into a fresh layer with: leji init --agent <name>"])
    return "\n".join(lines)
