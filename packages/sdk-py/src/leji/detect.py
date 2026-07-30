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
    # Argv (after the host bin) that registers the local Leji MCP server, or None
    # for a host with no known `mcp add` command. Run from the layer root so a
    # project-scoped write (Claude's `.mcp.json`) lands in the right repository.
    # Defaulted so existing keyword constructions stay valid and no positional call
    # breaks when the field is added (parity with the Node/Go registries).
    mcp_add: Optional[list[str]] = None
    # Argv that reports whether the Leji MCP server is already registered (exit 0 =
    # present); used to skip the install offer when it's already there.
    mcp_check: Optional[list[str]] = None


# The registered server name and the npm package behind the local Leji MCP server.
MCP_SERVER_NAME = "leji"
MCP_PACKAGE = "@leji-org/mcp"


# The portable discovery adapter. `AGENTS.md` is a cross-host entrypoint
# convention (stewarded by the Linux Foundation's Agentic AI Foundation, read
# natively by Codex, Copilot, Cursor, Gemini CLI, and others), not any one
# vendor's file, so `init`/`adopt` generate it as the default pointer-only
# redirect to the boot profile. Hosts with their own entrypoint (`CLAUDE.md`)
# are wired individually via `--wire-adapters` / `--agent`.
PORTABLE_ADAPTER = "AGENTS.md"


HOST_SPECS: list[HostSpec] = [
    HostSpec(
        id="claude-code",
        name="Claude Code",
        bins=["claude"],
        repo_files=["CLAUDE.md"],
        user_dirs=[".claude", ".config/claude"],
        adapter="CLAUDE.md",
        # Project scope writes a committed `.mcp.json` so the whole team gets the server.
        mcp_add=[
            "mcp",
            "add",
            MCP_SERVER_NAME,
            "--scope",
            "project",
            "--",
            "npx",
            "-y",
            MCP_PACKAGE,
        ],
        mcp_check=["mcp", "get", MCP_SERVER_NAME],
    ),
    HostSpec(
        id="codex",
        name="Codex",
        bins=["codex"],
        # AGENTS.md is a detection signal for Codex but is not Codex's file: it is
        # the portable adapter (PORTABLE_ADAPTER) many hosts read.
        repo_files=["AGENTS.md"],
        user_dirs=[".codex"],
        adapter="AGENTS.md",
        # Codex registers at user level (~/.codex/config.toml); no project scope.
        mcp_add=["mcp", "add", MCP_SERVER_NAME, "--", "npx", "-y", MCP_PACKAGE],
        mcp_check=["mcp", "get", MCP_SERVER_NAME],
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
    handoff and (on explicit request) adapter wiring."""
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
    # --agent names the host Leji launches, and only claude-code and codex accept
    # an inline prompt; suggesting `--agent <name>` for every detected host offered
    # a command the flag rejects.
    lines.extend(
        [
            "",
            "--agent takes a launchable host, claude-code or codex: "
            "leji init --agent claude-code, leji start --agent codex.",
            "Any other host above enters the layer through its vendor-file redirect.",
        ]
    )
    return "\n".join(lines)
