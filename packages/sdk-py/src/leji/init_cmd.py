"""Interactive bootstrap of a context layer from the vendored templates."""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import signal
import subprocess
import threading
import sys
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Callable, Optional

from .detect import (
    HOST_SPECS,
    PORTABLE_ADAPTER,
    DetectedHost,
    adapter_content,
    detect_hosts,
    resolve_host_id,
)
from .fsx import (
    chmod_guarded,
    guard_root,
    join_under_root,
    nothing_stands_at,
    resolved_within_root,
    strip_slash,
    to_posix,
    verified_target_read,
    write_file_atomic_guarded,
    write_file_guarded,
)
from .cigen import (
    GITLAB_MARKER_END,
    GITLAB_MARKER_START,
    HOOK_MARKER,
    HUSKY_MARKER_END,
    HUSKY_MARKER_START,
    build_azure_pipeline,
    build_ci_file,
    build_circleci_snippet,
    build_github_workflow,
    build_gitlab_block,
    hook_body,
    husky_block,
    is_leji_generated,
    resolve_ci_job,
)
from .ecosystem import EcosystemReport, detect_ecosystem, runner_argv
from .findings import Finding, has_errors
from .gitutil import tracked_under, working_tree_clean
from .indexgen import write_index
from .layout import LEJI_DIR, LEJI_IGNORE_REL, WORK_REL, TargetVerdict
from .leji_ignore import LejiIgnoreContext, ensure_leji_ignore_file
from .manifest import (
    Manifest,
    bind_agent_in_manifest_text,
    effective_agent_profiles_path,
    effective_changelog_path,
    effective_index_path,
    load_manifest,
)
from .schemas import templates_dir
from .validate import KNOWN_VENDOR_FILES
from .writeplan import PlanEntry, PlannedWrite, build_write_plan

CATEGORY_STUBS = {
    "domain": {
        "file": "glossary.md",
        "title": "Glossary",
        "summary": "What the core terms of this product mean, in our own words.",
        "body": "- TODO: define a core term in your own words, including what it does not mean.\n",
    },
    "system": {
        "file": "invariants.md",
        "title": "System Invariants",
        "summary": "The constraints every change lives with.",
        "body": "- TODO: state an invariant every change must respect (e.g. money values are integer minor units).\n",
    },
    "practice": {
        "file": "conventions.md",
        "title": "Conventions",
        "summary": "Conventions and patterns applied automatically.",
        "body": "- TODO: record a convention that has proven out at least twice (the proven-twice gate).\n",
    },
    "governance": {
        "file": "operating-rules.md",
        "title": "Operating Rules",
        "summary": "What agents may do unprompted and what needs a human gate.",
        "body": "- TODO: list what an agent may do without asking.\n- TODO: list what requires a human gate.\n",
    },
}

# The layer's working modes: a team of one ("solo") or a team ("team").
_WORKING_MODES = ("solo", "team")


def _assert_mode(mode: str) -> str:
    """Validate a mode value from a direct SDK caller before any filesystem work."""
    if mode not in _WORKING_MODES:
        raise RuntimeError(f'--mode must be solo or team; got "{mode}"')
    return mode


# Canonical category order for manifests and scaffolds.
_CATEGORY_ORDER = ("domain", "system", "practice", "governance", "decisions")


def _normalize_categories(categories: list[str], mode: str) -> list[str]:
    """Normalize a category set: ``decisions`` always; solo forces ``domain`` +
    ``practice``; the spec minimum (domain or system) holds; canonical order
    regardless of input."""
    chosen = set(categories)
    chosen.add("decisions")
    if mode == "solo":
        chosen.add("domain")
        chosen.add("practice")
    if "domain" not in chosen and "system" not in chosen:
        chosen.add("domain")
    return [c for c in _CATEGORY_ORDER if c in chosen]


# Manifest schema relative-path rule (context-manifest.schema.json): no leading
# slash, no "./", no ".." segment, no backslash. Applied to rootPath and every
# derived write path before anything touches the filesystem, so an interactive
# answer like "../../etc/" cannot escape the target directory.
_REL_PATH_RE = re.compile(r"^(?!/)(?!\./)(?!.*(^|/)\.\.(/|$))(?!.*\\).*$")


class InitPathError(RuntimeError):
    """A requested path is absolute, escapes the target, or is otherwise unsafe."""


def _reject_unsafe_rel(rel: str, what: str) -> None:
    if not rel or not _REL_PATH_RE.match(rel):
        raise InitPathError(
            f"{what} {rel!r} is not a safe relative path "
            "(no absolute paths, '..', './', or backslashes)"
        )


def _safe_target(root: Path, rel: str, what: str) -> Path:
    """Validate ``rel`` against the schema rule and assert the lexically resolved
    target stays under ``root``; raises InitPathError otherwise. Lexical only (no
    symlink following); symlink escapes are caught separately by
    :func:`_assert_no_symlink_escape`."""
    _reject_unsafe_rel(rel, what)
    target = Path(os.path.normpath(root / rel))
    if target != root and not target.is_relative_to(root):
        raise InitPathError(f"{what} {rel!r} resolves outside the target directory")
    return target


@dataclass
class ScaffoldLayout:
    """The repository-relative paths the scaffolder writes. Defaults derive from
    rootPath; ``adopt`` resolves each against the existing tree to avoid clobbering."""

    boot_profile_path: str
    # Directory holding the category index files, trailing slash.
    context_dir: str
    # Agent-profiles directory, trailing slash.
    agents_dir: str
    index_path: str
    changelog_path: str


def default_layout(root_path: str) -> ScaffoldLayout:
    """The spec-default layout under a context root (no collision resolution)."""
    return ScaffoldLayout(
        boot_profile_path=join_under_root(root_path, "boot-profile.md"),
        context_dir=join_under_root(root_path, "context/"),
        agents_dir=join_under_root(root_path, "agents/"),
        index_path=join_under_root(root_path, "context-index.json"),
        changelog_path=join_under_root(root_path, "context-changelog.json"),
    )


def _resolve_scaffold_path(
    root: str, root_path: str, name: str, alternates: list[str], is_dir: bool
) -> str:
    """Pick the first candidate name (under root_path) that is free, so ``adopt``
    never writes its scaffold over a repo's existing content. Occupancy is decided on
    the standing entry rather than by ``Path.exists()``, so a dangling candidate link
    is occupied and the next name is tried, exactly as an existing file has always
    been."""

    def free(rel: str) -> bool:
        return nothing_stands_at(str(Path(root) / strip_slash(rel)))

    suffix = "/" if is_dir else ""
    for candidate in [name, *alternates]:
        rel = join_under_root(root_path, candidate + suffix)
        if free(rel):
            return rel
    n = 2
    while True:
        rel = join_under_root(root_path, f"{name}-{n}{suffix}")
        if free(rel):
            return rel
        n += 1


def _resolve_layout(root: str, root_path: str) -> ScaffoldLayout:
    """Resolve a full scaffold layout against an existing repository: each default
    path that collides with existing content falls back to a safe alternate."""
    return ScaffoldLayout(
        boot_profile_path=_resolve_scaffold_path(
            root, root_path, "boot-profile.md", ["leji-boot-profile.md"], False
        ),
        context_dir=_resolve_scaffold_path(
            root, root_path, "context", ["leji-context", "context-layer"], True
        ),
        agents_dir=_resolve_scaffold_path(
            root, root_path, "agents", ["agent-profiles", "leji-agents"], True
        ),
        index_path=_resolve_scaffold_path(
            root, root_path, "context-index.json", ["leji-context-index.json"], False
        ),
        changelog_path=_resolve_scaffold_path(
            root, root_path, "context-changelog.json", ["leji-context-changelog.json"], False
        ),
    )


@dataclass
class InitAnswers:
    name: str
    description: str
    root_path: str
    owner_name: str
    owner_contact: str
    categories: list[str]
    level: str
    mode: str = "team"
    # Resolved scaffold paths. None means the spec defaults under rootPath;
    # ``adopt`` fills this with collision-resolved alternates.
    layout: Optional[ScaffoldLayout] = None


@dataclass
class InitResult:
    written: list[str] = field(default_factory=list)
    # Index-generation findings. Errors mean no index was written, and the caller
    # reports them and fails, the same way `leji index` does.
    findings: list[Finding] = field(default_factory=list)
    manifest: Manifest = field(default_factory=dict)
    # The working mode the layer was scaffolded with.
    mode: str = "team"
    # The classified write plan (always populated; the only output under dry_run).
    plan: list[PlanEntry] = field(default_factory=list)
    dry_run: bool = False
    # Coding-agent hosts detected for this repo, ranked; informs the handoff offer.
    detected: list[DetectedHost] = field(default_factory=list)
    # Absolute layer root (resolved directory); the cwd for the handoff launch and
    # the MCP-install offer.
    root: str = ""


def _git_config(key: str) -> Optional[str]:
    try:
        out = subprocess.run(
            ["git", "config", "--get", key], capture_output=True, text=True, check=True
        ).stdout.strip()
        return out or None
    except (subprocess.CalledProcessError, OSError):
        return None


def _default_answers(
    directory: str, name: Optional[str], level: Optional[str], mode: Optional[str] = None
) -> InitAnswers:
    base = re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", Path(directory).resolve().name.lower()))
    return InitAnswers(
        name=name or f"{base}-context",
        description="Shared context layer for this repository.",
        root_path="docs/",
        owner_name=_git_config("user.name") or "<named owner>",
        owner_contact=_git_config("user.email") or "",
        categories=["domain", "system", "decisions"],
        level=level or "core",
        mode=_assert_mode(mode) if mode else "team",
    )


def _stdin_is_tty() -> bool:
    """Whether stdin is an interactive terminal (gates the TTY-only mode question).
    False under piped/redirected stdin, mirroring Node's process.stdin.isTTY."""
    try:
        return sys.stdin.isatty()
    except (ValueError, OSError):
        return False


def _prompt(
    directory: str, name: Optional[str], level: Optional[str], mode_option: Optional[str] = None
) -> InitAnswers:
    defaults = _default_answers(directory, name, level, mode_option)

    def ask(q: str, fallback: str) -> str:
        suffix = f" ({fallback}): " if fallback else ": "
        return input(f"{q}{suffix}").strip() or fallback

    def ask_yes_no(q: str, fallback: bool) -> bool:
        a = input(f"{q} [{'Y/n' if fallback else 'y/N'}]: ").strip().lower()
        if a == "":
            return fallback
        return a in ("y", "yes")

    answers_name = ask("Layer name", defaults.name)
    description = ask("One-line description", defaults.description)
    root_path = ask("Context root", defaults.root_path).strip()
    # Repo-root layer is canonical "." (not "./", which the path guard rejects, nor
    # "", which later concatenation turns into a hidden ".context/"). Subdir root gets
    # a trailing slash.
    if root_path in ("", ".", "./"):
        root_path = "."
    elif not root_path.endswith("/"):
        root_path += "/"
    owner_name = ask("Primary owner (name)", defaults.owner_name)
    owner_contact = ask("Primary owner (contact)", defaults.owner_contact)

    # The mode question is TTY-only so the piped-stdin protocol keeps its exact
    # line count; piped runs stay `team` and select solo via --mode solo.
    mode = defaults.mode
    if not mode_option and _stdin_is_tty():
        a = ask("Working mode (team/solo)", "team").lower()
        mode = "solo" if a == "solo" else "team"

    categories: list[str] = []
    if mode == "solo":
        # Solo forces domain + practice (identity and writing-style live there);
        # system and governance stay the repository's call.
        categories.append("domain")
        if ask_yes_no("Map system (architecture, invariants)?", True):
            categories.append("system")
        categories.append("practice")
        if ask_yes_no("Map governance (agent guardrails, operating rules)?", False):
            categories.append("governance")
    else:
        if ask_yes_no("Map domain (business language, product semantics)?", True):
            categories.append("domain")
        if ask_yes_no("Map system (architecture, invariants)?", True):
            categories.append("system")
        if ask_yes_no("Map practice (conventions, proven patterns)?", False):
            categories.append("practice")
        if ask_yes_no("Map governance (agent guardrails, operating rules)?", False):
            categories.append("governance")
    categories.append("decisions")
    if "domain" not in categories and "system" not in categories:
        # The spec minimum: at least domain or system, plus decisions.
        categories.insert(0, "domain")
        print("At least domain or system is required; mapping domain.")

    indexed = ask_yes_no("Claim the indexed level (adds the machine changelog)?", False)
    return InitAnswers(
        name=answers_name,
        description=description,
        root_path=root_path,
        owner_name=owner_name,
        owner_contact=owner_contact,
        categories=categories,
        level="indexed" if indexed else "core",
        mode=mode,
    )


def _read_template(name: str) -> str:
    return (templates_dir() / name).read_text(encoding="utf-8")


def _assert_no_symlink_escape(root: Path, abs_path: Path, rel: str) -> None:
    """Refuse a write whose resolved path (following symlinks, including a
    not-yet-existing target under a symlinked ancestor) escapes ``root``."""
    if not resolved_within_root(str(root), abs_path):
        raise InitPathError(f'refusing to write through a symlink that escapes the target: "{rel}"')


def _ensure_leji_ignore_or_refuse(
    root: str, ignore_context: Optional[LejiIgnoreContext] = None
) -> None:
    """The transient onboarding workspace is a ``.leji/`` role, so these commands ensure
    the tool's own ignore file exactly as every other role establisher does. A refusal is
    the refusal this command has always raised for an escaping target."""
    if ensure_leji_ignore_file(root, ignore_context) == "refused":
        raise InitPathError(
            f'refusing to write through a symlink that escapes the target: "{LEJI_IGNORE_REL}"'
        )


def _init_role(rel: str) -> Optional[str]:
    """The ``.leji/`` role an init or adopt write legitimately lands in: the transient
    onboarding workspace is the tool's own ``work`` role, and everything else these
    commands write is user content with no ``.leji/`` role at all."""
    return WORK_REL if rel == WORK_REL or rel.startswith(f"{WORK_REL}/") else None


def _guarded_or_refuse(rel: str, verdict: TargetVerdict) -> None:
    """Every init/adopt write goes through the chokepoint, and a refused verdict is the
    one error this command has always raised for an escaping target: the layer is
    scaffolded inside the repository it was pointed at, or not at all."""
    if not verdict.ok:
        raise InitPathError(f'refusing to write through a symlink that escapes the target: "{rel}"')


def _verified_vendor_files(root: Path) -> dict[str, str]:
    """The present vendor entrypoints and their VERIFIED bytes, read once. The same
    bytes decide whether an entrypoint is converted, are archived under
    ``governance/``, and are compared for the draft report, so no act rests on a second
    read by pathname of a file this command then rewrites. An entry that cannot be
    verified as a regular file inside the repository is treated as absent, exactly as
    an escaping symlink already was."""
    root_real = guard_root(str(root))
    present: dict[str, str] = {}
    for rel in KNOWN_VENDOR_FILES:
        read = verified_target_read(root_real, str(root / rel), None)
        if read.status == "regular":
            present[rel] = read.text()
    return present


def _read_merge_source(root_real: str, abs_path: Path, rel: str) -> Optional[str]:
    """Read a file this command is about to merge and rewrite, through the verified
    read rather than by pathname: the bytes that decide the merge come from the
    descriptor the rule cleared, so the file that was judged is the file that is read
    and then written. None when nothing stands there (the create path); a standing
    entry that cannot be verified as a regular file inside the repository is the same
    refusal a write to it would be."""
    read = verified_target_read(root_real, str(abs_path), _init_role(rel))
    if read.status == "refused":
        raise InitPathError(f'refusing to write through a symlink that escapes the target: "{rel}"')
    return read.text() if read.status == "regular" else None


def _write_manifest_exclusive(root_abs: Path, abs_path: Path, content: str, mode: str) -> None:
    """Create leji.json with O_EXCL so the existence check and write are atomic: a
    concurrent run, or a symlink planted between check and write, cannot be overwritten
    or followed. The ``exists`` verdict surfaces as the same "already exists" error the
    entry point's initial guard raises."""
    verdict = write_file_guarded(
        guard_root(str(root_abs)), str(abs_path), None, content, exclusive=True
    )
    if verdict.exists:
        raise RuntimeError(
            "leji.json already exists here; this repository already has a Leji layer"
            if mode == "adopt"
            else "leji.json already exists here; init refuses to overwrite an existing layer"
        )
    _guarded_or_refuse("leji.json", verdict)


def _ensure_leji_gitignored(root_abs: Path) -> None:
    """Ensure the repository-root .gitignore ignores `.leji/` — the one line that
    covers every role of the unified tree (chrome, export output, onboarding
    workspace, mounts) and any role added later. Idempotent: creates the file if
    absent, appends the line only when not already present. Matches the line exactly,
    so a comment or `docs/.leji/` is not treated as equivalent."""
    abs_path = root_abs / ".gitignore"
    entry = f"{LEJI_DIR}/"
    root_real = guard_root(str(root_abs))
    text = _read_merge_source(root_real, abs_path, ".gitignore") or ""
    if entry in text.split("\n"):
        return
    nxt = (
        entry + "\n" if text == "" else text + ("" if text.endswith("\n") else "\n") + entry + "\n"
    )
    _guarded_or_refuse(".gitignore", write_file_guarded(root_real, str(abs_path), None, nxt))


def _assert_leji_workspace_private(root: str) -> None:
    """Refuse to write the transient onboarding workspace while any file under the
    root ``.leji/`` is tracked by git: tracked means the ignore boundary is not
    intact, and private artifacts could land in history. The fix is the owner's call
    (git rm --cached), never run silently."""
    tracked = tracked_under(root, LEJI_DIR)
    if tracked:
        raise RuntimeError(
            f"{len(tracked)} file(s) under {LEJI_DIR}/ are tracked by git; "
            "untrack them (git rm --cached) so onboarding artifacts stay private"
        )


def _write_file_once(root: Path, rel: str, content: str, written: list[str]) -> None:
    """Write a file this command owns, once: never over an existing one, and never
    through a standing entry it cannot verify. The skip is decided by the verified read
    rather than a pathname check, because ``Path.exists()`` follows symlinks — a
    dangling link at the target reads as absent and the guarded write then lands at the
    link's destination, a name this command never planned. Only ``absent`` is free; a
    regular file is the never-overwrite skip; anything else standing there is the
    escape refusal, with nothing written."""
    abs_path = _safe_target(root, rel, "write path")
    root_real = guard_root(str(root))
    standing = verified_target_read(root_real, str(abs_path), _init_role(rel))
    if standing.status == "regular":
        return
    if standing.status == "refused":
        raise InitPathError(f'refusing to write through a symlink that escapes the target: "{rel}"')
    _guarded_or_refuse(rel, write_file_guarded(root_real, str(abs_path), _init_role(rel), content))
    written.append(rel)


def _category_stub(title: str, summary: str, body: str) -> str:
    return f"---\nsummary: {summary}\n---\n\n# {title}\n\n{body}"


# Solo-mode starters: owner identity (domain) and writing style (practice),
# scaffolded from canonical templates so the interview has real homes to fill.
_SOLO_STARTERS = (
    ("domain", "identity.md", "identity.md"),
    ("practice", "writing-style.md", "writing-style.md"),
)

_CATEGORY_INDEX_TITLES = {
    "domain": "📖 Domain",
    "system": "⚙️ System",
    "practice": "🛠️ Practice",
    "governance": "🛡️ Governance",
    "decisions": "🧭 Decisions",
}


def _category_index_file(root_path: str, category: str) -> str:
    """Stub category index: a ``leji-index`` block declaring the category's source
    directory as the governed content."""
    title = _CATEGORY_INDEX_TITLES.get(category, category)
    return (
        f"# {title}\n\n"
        f"This index lists the {category} content of the layer. Content lives where it sits; "
        f"this file declares what counts as {category} context.\n\n"
        "```leji-index\n"
        f"- path: {join_under_root(root_path, category + '/')}\n"
        "```\n"
    )


def _build_manifest(answers: InitAnswers) -> Manifest:
    template = json.loads(_read_template("leji.json"))
    r = answers.root_path
    layout = answers.layout or default_layout(r)
    manifest: Manifest = {
        "$schema": template.get("$schema"),
        "leji": "1.0",
        "name": answers.name,
        "description": answers.description,
        "rootPath": r,
        "bootProfilePath": layout.boot_profile_path,
        "categories": {},
        "owners": {
            "primary": (
                {"name": answers.owner_name, "contact": answers.owner_contact}
                if answers.owner_contact
                else {"name": answers.owner_name}
            )
        },
        "conformance": {
            "claimedLevel": answers.level,
            "claimedAt": dt.datetime.now(dt.timezone.utc).date().isoformat(),
        },
    }
    # Emit a machine block only for paths that differ from their spec default (a
    # collision-resolved alternate from `adopt`); otherwise resolvers find files at the
    # defaults. A fresh init, or an adopt with no collisions, emits none.
    default = default_layout(r)
    machine: dict[str, str] = {}
    if layout.index_path != default.index_path:
        machine["indexPath"] = layout.index_path
    if layout.changelog_path != default.changelog_path:
        machine["changelogPath"] = layout.changelog_path
    if layout.agents_dir != default.agents_dir:
        machine["agentProfilesPath"] = layout.agents_dir
    if machine:
        manifest["machine"] = machine
    for category in answers.categories:
        manifest["categories"][category] = {"indexes": [f"{layout.context_dir}{category}.md"]}
    return manifest


def _build_boot_profile(answers: InitAnswers) -> str:
    text = _read_template("boot-profile.md")
    text = text.replace(
        "<One paragraph: what this repository/product is, who it serves, what stage it is at.>",
        answers.description,
    )
    r = answers.root_path

    # Rewrite the template's docs/ prefixes for the chosen root (join_under_root('.', '')
    # is '', so a "." root yields context-index.json, not .context-index.json).
    text = text.replace("docs/", join_under_root(r, ""))

    if answers.level == "core":
        # The index ships at every level, so its routing sentence and its regenerate
        # duty both stay: a core scaffold that denied the index would leave the
        # adopter no instruction for the `leji index --check` gate `leji ci` writes.
        # Only the changelog line goes, since the changelog is an `indexed` artifact.
        text = re.sub(r"- Append an entry to `[^`]*context-changelog\.json`[^\n]*\n", "", text)
    if answers.mode == "solo":
        # Route identity and writing work to the solo starters. Inserted after the
        # root rewrite (the routes carry final paths); one placeholder line stays
        # for the task types the onboarding discovers. Count 1 mirrors Node's
        # first-occurrence String.replace.
        identity_route = f"- identity, positioning, or public claims → `{join_under_root(r, 'domain/')}identity.md`"
        style_route = (
            "- writing or outward-facing communication → "
            f"`{join_under_root(r, 'practice/')}writing-style.md`"
        )
        text = text.replace(
            "- <task type> → <paths or category>\n- <task type> → <paths or category>\n",
            f"{identity_route}\n{style_route}\n- <task type> → <paths or category>\n",
            1,
        )
    return text


def _build_core_profile(answers: InitAnswers) -> str:
    text = _read_template("agents/core.md")
    text = text.replace("docs/", join_under_root(answers.root_path, ""))
    # The escalation line names a person, so the scaffold fills it: a profile that
    # shipped `<ownerName>` would be the placeholder the lint exists to catch.
    text = text.replace("<ownerName>", answers.owner_name)
    if "governance" not in answers.categories:
        text = re.sub(
            r"^ {2}- .*governance/\n",
            f"  - {join_under_root(answers.root_path, 'decisions/')}\n",
            text,
            flags=re.MULTILINE,
        )
    return text


def _build_first_decision(answers: InitAnswers) -> str:
    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
    indexed_line = (
        "manifest, boot profile, category content, decision records, generated index, machine changelog"
        if answers.level == "indexed"
        else "manifest, boot profile, category content, decision records"
    )
    return f"""---
id: adopt-leji
title: Adopt the Leji context layer
status: accepted
date: {today}
deciders:
  - {answers.owner_name}
---

# Adopt the Leji context layer

## Context

This repository takes a shared, versioned context layer: one record of how it works, kept in the repository and read by people and agents alike.

## Decision

Adopt Leji at the `{answers.level}` level: {indexed_line}.

## Consequences

Context changes ride the same review gate as the work that surfaces them, and {answers.owner_name} owns the layer. Agent entrypoints point at the context layer rather than carrying their own copy: the portable `AGENTS.md` pointer where the scaffold writes one, and vendor entrypoints only where `leji adopt --wire-adapters` converts them with your consent.
"""


def _build_changelog(answers: InitAnswers, written: list[str]) -> str:
    changelog = {
        "$schema": "https://leji.org/schemas/v1.0/context-changelog.schema.json",
        "schemaVersion": "1.0",
        "entries": [
            {
                "id": "seed-layer",
                "date": dt.datetime.now(dt.timezone.utc).date().isoformat(),
                "type": "added",
                "summary": "Seeded the context layer with leji init.",
                "paths": written,
                "proposedBy": "leji init",
                "approvedBy": answers.owner_name,
            }
        ],
    }
    return json.dumps(changelog, indent=2, ensure_ascii=False) + "\n"


def _build_brief(answers: InitAnswers) -> str:
    """The transient onboarding brief, rewritten for the chosen root
    (join_under_root('.', '') is '', so a "." root yields `context/...`, never
    `.context/`) and stamped with the working mode so the agent runs the right
    interview without re-asking. The workspace paths it names are root-relative
    already and need no rewriting."""
    return (
        _read_template("onboarding-brief.md")
        .replace("<root>/", join_under_root(answers.root_path, ""))
        .replace("<mode>", answers.mode)
    )


#: Path of the transient onboarding brief: the workspace role of the unified root
#: ``.leji/``, under a dot-directory so it is excluded from the index, the viewer,
#: and the changelog. Root-relative whatever rootPath is.
BRIEF_PATH = f"{WORK_REL}/onboarding-brief.md"


#: The CI workflow paths, relative to the repository root.
CI_WORKFLOW_PATH = ".github/workflows/leji.yml"
GITLAB_CI_PATH = ".gitlab-ci.yml"
CIRCLECI_CONFIG_PATH = ".circleci/config.yml"
AZURE_PIPELINE_PATH = ".azure-pipelines/leji.yml"

_GITLAB_MARKER_START = "# >>> leji ci (managed) >>>"
_GITLAB_MARKER_END = "# <<< leji ci (managed) <<<"

# The npm package name; its presence in the repo's package.json selects the
# local-first CI and hook variants over the `npx @leji-org/leji@1` fallback.
_DEP_NAME = "@leji-org/leji"

# Azure Pipelines does not auto-discover a YAML file (unlike the other three), so
# the file is written but the pipeline still has to be created in Azure DevOps.
AZURE_ACTIVATION_NOTE = (
    "Azure Pipelines does not auto-run this file. Create a pipeline that points at "
    "it (e.g. `az pipelines create --yml-path .azure-pipelines/leji.yml`), and on "
    "Azure Repos add a build-validation branch policy on main for pull-request checks."
)


@dataclass
class HookResult:
    """Result of :func:`ensure_local_hook`: created/updated our managed hook, left an
    unmanaged hook untouched ("manual", with the snippet to add), or unchanged.
    ``managed`` says whether the writer owns a standalone hook file (".git/hooks" or
    a custom core.hooksPath dir) or a marker-delimited block inside a husky hook."""

    path: str
    action: str  # "created" | "updated" | "unchanged" | "manual"
    snippet: Optional[str] = None  # set only when action == "manual"
    managed: str = "file"  # "file" | "block"
    # Why a "manual" result was returned: "foreign-hook" (an existing unmanaged hook)
    # or "outside-root" (a hooks dir resolving outside the repo). None otherwise.
    reason: Optional[str] = None


# The hook body, the husky block and their markers live in the shared generator
# module, so the CI job and the hook transcribe one table.
_HOOK_MARKER = HOOK_MARKER
_HUSKY_MARKER_START = HUSKY_MARKER_START
_HUSKY_MARKER_END = HUSKY_MARKER_END


def _hooks_path_config(root: str) -> Optional[str]:
    """The configured ``core.hooksPath`` for the repo at ``root``, or ``None`` when
    unset. Run from the repo root (git -C) so local, global, and system scopes
    resolve; an argv array, never a shell string. Used ONLY to decide husky-shape;
    the write location comes from ``_git_hooks_dir``."""
    try:
        out = subprocess.run(
            ["git", "-C", root, "config", "core.hooksPath"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        return out or None
    except (subprocess.CalledProcessError, OSError):
        return None


def _git_hooks_dir(root_abs: Path) -> Optional[Path]:
    """The effective hooks directory git would run, resolved absolute against
    ``root_abs``, or ``None`` when this is not a git repository. ``git rev-parse
    --git-path hooks`` is authoritative: it honors core.hooksPath scoping and tilde
    expansion (``~/hooks`` -> ``$HOME/hooks``), and works in linked worktrees where
    ``.git`` is a file."""
    try:
        out = subprocess.run(
            ["git", "-C", str(root_abs), "rev-parse", "--git-path", "hooks"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except (subprocess.CalledProcessError, OSError):
        return None
    if out == "":
        return None
    hooks = Path(out)
    if not hooks.is_absolute():
        hooks = root_abs / hooks
    # Lexical normalization only (matches Node path.resolve / Go filepath.Clean);
    # os.path.normpath, never Path.resolve() which touches the filesystem.
    return Path(os.path.normpath(str(hooks)))


def _husky_shape(root_abs: Path, hooks_path: Optional[str]) -> Optional[str]:
    """The husky shape of the configured hooks path: ``"underscore"`` for husky v9
    (``.husky/_``), ``"direct"`` for husky v8 (``.husky``), or ``None`` when not
    husky-shaped or unset. Decides block-vs-file routing and (with the resolved hooks
    dir) the ``.husky/pre-commit`` user-file target."""
    if hooks_path is None:
        return None
    resolved = Path(hooks_path)
    if not resolved.is_absolute():
        resolved = root_abs / hooks_path
    resolved = Path(os.path.normpath(str(resolved)))
    if resolved.name == "_" and resolved.parent.name == ".husky":
        return "underscore"
    if resolved.name == ".husky":
        return "direct"
    return None


def _git_dirs(root_abs: Path) -> Optional[tuple[Path, Path]]:
    """Git's own directories for the repo at ``root_abs``, resolved absolute: this
    working tree's git dir and the common dir it shares with every linked worktree.
    Both are read-only queries, and together they are what decides whether a hook
    target is clone-local (personal) rather than committed (shared). ``None`` when
    this is not a git repository."""
    try:
        out = subprocess.run(
            ["git", "-C", str(root_abs), "rev-parse", "--git-dir", "--git-common-dir"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    except (subprocess.CalledProcessError, OSError):
        return None
    lines = [line.strip() for line in out.split("\n") if line.strip()]
    if len(lines) < 2:
        return None

    def absolute(value: str) -> Path:
        p = Path(value)
        if not p.is_absolute():
            p = root_abs / p
        return Path(os.path.normpath(str(p)))

    return absolute(lines[0]), absolute(lines[1])


@dataclass
class HookReport:
    """The read-only answer `leji start` reports and :func:`ensure_local_hook` would
    act on.

    ``ownership`` says who owns the pre-commit hook this repository would get, decided
    by where the write would actually land rather than by the mechanism that would
    perform it: "personal" under git's own directories AND inside this working tree
    (``.git/hooks``, a ``core.hooksPath`` resolving inside them) — per clone, never
    committed, and safe to write; "shared" inside the working tree but not under git's
    directories (husky, a ``githooks/`` hooks path) — committed, so a maintainer's call;
    "outside-root" under git's directories but OUTSIDE this working tree (a linked
    worktree, whose hooks live in the common git directory) — per clone, but the writer
    refuses to write outside the repository root, so it is reported; "external" anywhere
    else (a global or ``$HOME`` hooks path, a symlink escaping the repository) —
    reported, never written; "no-git" when there is no repository to hang a hook on. ``state`` is what stands at that
    target: leji's own managed hook or block ("current"), nothing ("absent"), or a
    hook this tool did not write ("foreign")."""

    ownership: str
    state: str
    # The target, repository-relative when it lies inside the repository, else the
    # absolute path git resolved; empty when there is no repository.
    path: str
    managed: str  # "file" | "block"
    # What a person adds by hand where leji must not write.
    snippet: str


def _hook_text(abs_path: Path) -> Optional[str]:
    """The hook file's text, or None when nothing readable stands there. Read-only:
    this answers a question, and every write still goes through
    :func:`ensure_local_hook`."""
    try:
        if not abs_path.is_file():
            return None
        return abs_path.read_text(encoding="utf-8")
    except OSError:
        return None


def hook_status(root: str, runner: Optional[list[str]] = None) -> HookReport:
    """:func:`ensure_local_hook`'s resolve step, without the write: where the managed
    pre-commit hook would go for this repository, who owns that location, and what
    stands there now. The whole point is that a report can be produced without touching
    anything — `leji start` prints it, and only a consented repair goes on to
    :func:`ensure_local_hook`."""
    root_abs = Path(root).resolve()
    argv = runner if runner is not None else runner_argv(detect_ecosystem(str(root_abs)))
    hooks_dir = _git_hooks_dir(root_abs)
    dirs = _git_dirs(root_abs)
    if hooks_dir is None or dirs is None:
        return HookReport(
            ownership="no-git", state="absent", path="", managed="file", snippet=hook_body(argv)
        )
    git_dir, common_dir = dirs
    shape = _husky_shape(root_abs, _hooks_path_config(str(root_abs)))
    target = hooks_dir.parent / "pre-commit" if shape == "underscore" else hooks_dir / "pre-commit"
    managed = "block" if shape else "file"
    snippet = husky_block(argv) if shape else hook_body(argv)
    marker = HUSKY_MARKER_START if shape else HOOK_MARKER
    # Git's directories are tested FIRST: an ordinary .git/hooks also lies inside the
    # working tree, and it is per-clone state, not something a commit can carry. A
    # clone-local target that nonetheless falls outside this working tree (a linked
    # worktree's shared hooks directory) is reported rather than offered: the writer
    # refuses everything outside the repository root, so offering it would promise a
    # write that cannot happen.
    in_repo = resolved_within_root(str(root_abs), target)
    clone_local = resolved_within_root(str(git_dir), target) or resolved_within_root(
        str(common_dir), target
    )
    if clone_local:
        ownership = "personal" if in_repo else "outside-root"
    elif in_repo:
        ownership = "shared"
    else:
        ownership = "external"
    existing = _hook_text(target)
    if existing is None:
        state = "absent"
    else:
        state = "current" if marker in existing else "foreign"
    shown = str(PurePosixPath(target.relative_to(root_abs))) if in_repo else to_posix(str(target))
    return HookReport(
        ownership=ownership, state=state, path=shown, managed=managed, snippet=snippet
    )


def ensure_local_hook(root: str, runner: Optional[list[str]] = None) -> HookResult:
    """Write a managed pre-commit hook running the same checks CI runs, so drift is
    caught before a commit instead of at the pipeline. The write location is git's
    effective hooks dir (``rev-parse --git-path hooks``); core.hooksPath decides
    whether a husky repo gets a managed block in the user-editable ``.husky/pre-commit``
    (v8/v9) or a standalone managed hook is written. A hooks dir resolving outside the
    repo (a global core.hooksPath) is never written — the snippet comes back for a
    manual hand-add, as does an existing unmanaged hook."""
    root_abs = Path(root).resolve()
    hooks_dir = _git_hooks_dir(root_abs)
    if hooks_dir is None:
        raise RuntimeError("not a git repository (no .git directory); hooks need one")
    # The hook runs what a clean install of THIS repository provides: the detected
    # manager's runner when the CLI is actually declared, else the plain binary on
    # PATH. Injectable so a test pins a runner without planting a manifest.
    argv = runner if runner is not None else runner_argv(detect_ecosystem(str(root_abs)))
    shape = _husky_shape(root_abs, _hooks_path_config(str(root_abs)))
    # Husky's user-editable hook is .husky/pre-commit: the hooks dir itself for v8
    # (.husky), its parent for v9 (.husky/_). Only a direct v8 hook is run by git
    # itself, so only it must stay executable.
    if shape == "underscore":
        target = hooks_dir.parent / "pre-commit"
    else:
        target = hooks_dir / "pre-commit"
    # Never write outside the repository; report the computed target for a hand-add.
    if not resolved_within_root(str(root_abs), target):
        return HookResult(
            path=to_posix(str(target)),
            action="manual",
            snippet=husky_block(argv) if shape else hook_body(argv),
            managed="block" if shape else "file",
            reason="outside-root",
        )
    rel = str(PurePosixPath(target.relative_to(root_abs)))

    # The hook is written through the chokepoint, judged on the resolved path at the
    # act; a target that stopped resolving inside the repository between the check
    # above and the write comes back as the same hand-add result that check returns.
    def manual(managed: str) -> HookResult:
        return HookResult(
            path=to_posix(str(target)),
            action="manual",
            snippet=husky_block(argv) if managed == "block" else hook_body(argv),
            managed=managed,
            reason="outside-root",
        )

    guard_root_abs = guard_root(str(root_abs))
    if shape:
        return _ensure_husky_block(guard_root_abs, target, rel, shape == "direct", manual, argv)
    return _ensure_hook_file(guard_root_abs, target, rel, manual, argv)


def _ensure_hook_file(
    root_abs: str,
    hook_abs: Path,
    rel: str,
    manual: Callable[[str], HookResult],
    runner: list[str],
) -> HookResult:
    """Write/refresh the standalone managed pre-commit hook at ``hook_abs``. Ours
    (marker present) is created/updated; an existing unmanaged hook is never touched
    and its replacement snippet comes back for a manual merge. A standalone hook is
    run by git itself, so a byte-current but non-executable managed hook is a mode-only
    correction reported ``updated``.

    The hook's own bytes decide whether it is ours to rewrite, so they come from the
    verified read: an entry standing at the hook path that cannot be verified as a
    regular file inside the repository is reported for a hand-add, never merged."""
    body = hook_body(runner)
    hook_read = verified_target_read(root_abs, str(hook_abs), None)
    if hook_read.status == "refused":
        return manual("file")
    existing = hook_read.text() if hook_read.status == "regular" else None
    if existing is not None and _HOOK_MARKER not in existing:
        return HookResult(
            path=rel, action="manual", snippet=body, managed="file", reason="foreign-hook"
        )
    if existing == body:
        if not _is_executable(hook_abs):
            if not chmod_guarded(root_abs, str(hook_abs), None, 0o755).ok:
                return manual("file")
            return HookResult(path=rel, action="updated", managed="file")
        return HookResult(path=rel, action="unchanged", managed="file")
    if not write_file_guarded(root_abs, str(hook_abs), None, body, mode=0o755).ok:
        return manual("file")
    return HookResult(path=rel, action="created" if existing is None else "updated", managed="file")


def _is_executable(abs_path: Path) -> bool:
    """Whether the file has any executable bit set."""
    try:
        return bool(abs_path.stat().st_mode & 0o111)
    except OSError:
        return False


def _ensure_husky_block(
    root_abs: str,
    hook_abs: Path,
    rel: str,
    require_exec: bool,
    manual: Callable[[str], HookResult],
    runner: list[str],
) -> HookResult:
    """Merge the managed block into a husky hook file at ``hook_abs``, following the
    GitLab managed-block rules: replace an existing block in place (unchanged if
    byte-identical), append it after one blank line to a file without it, or create
    the file as ``#!/bin/sh`` + block (mode 0755) when absent. The rest of a
    user-authored husky hook is left untouched. ``require_exec`` (a direct ``.husky``
    hook git runs itself) forces mode 0755: a byte-current but non-executable file is
    a mode-only correction reported ``updated``.

    The user's own hook is merged, so its bytes come from the verified read: what the
    merge judged is what the rewrite is based on."""
    block = husky_block(runner)
    hook_read = verified_target_read(root_abs, str(hook_abs), None)
    if hook_read.status == "refused":
        return manual("block")
    existing = hook_read.text() if hook_read.status == "regular" else None
    if existing is None:
        if not write_file_guarded(
            root_abs, str(hook_abs), None, "#!/bin/sh\n" + block, mode=0o755
        ).ok:
            return manual("block")
        return HookResult(path=rel, action="created", managed="block")
    merged = _merge_managed_block(existing, block, _HUSKY_MARKER_START, _HUSKY_MARKER_END)
    if merged != existing:
        if not write_file_guarded(root_abs, str(hook_abs), None, merged).ok:
            return manual("block")
        if require_exec and not chmod_guarded(root_abs, str(hook_abs), None, 0o755).ok:
            return manual("block")
        return HookResult(path=rel, action="updated", managed="block")
    if require_exec and not _is_executable(hook_abs):
        if not chmod_guarded(root_abs, str(hook_abs), None, 0o755).ok:
            return manual("block")
        return HookResult(path=rel, action="updated", managed="block")
    return HookResult(path=rel, action="unchanged", managed="block")


#: The CI providers targeted by ``leji ci``.
CiProvider = str


def ci_provider_from_remote(url: Optional[str]) -> Optional[str]:
    """Infer the CI provider from a git remote URL: github.com hosts GitHub Actions,
    any gitlab host (gitlab.com or self-managed) GitLab CI, Azure DevOps hosts
    Azure Pipelines. Returns None when the remote names none of them (CircleCI is
    not remote-inferable)."""
    if not url:
        return None
    u = url.lower()
    if "github.com" in u:
        return "github"
    if "gitlab" in u:
        return "gitlab"
    if "dev.azure.com" in u or "visualstudio.com" in u:
        return "azure"
    return None


#: What :func:`ensure_ci_workflow` did.
CiAction = str


@dataclass
class CiResult:
    """What :func:`ensure_ci_workflow` did, for the command to report."""

    provider: str
    path: str
    action: str  # "created" | "updated" | "unchanged" | "manual"
    snippet: Optional[str] = None  # set only when action == "manual"
    note: Optional[str] = None  # set only when action == "created" for azure


# Local-first CI: a repo that declares @leji-org/leji installs its lockfile-pinned
# deps and runs the local bin (`npx --no-install` fails loudly rather than fetch a
# floating version); a repo without one falls back to `npx @leji-org/leji@1`, which
# pins the SDK to its current major (@1): additive-only within a major so a valid
# layer stays valid, and a breaking major never reaches adopter CI without a bump.


def _managed_block_span(text: str, start_marker: str, end_marker: str) -> tuple[int, int] | None:
    """The ``[start, end)`` span of the first managed block in ``text``, or ``None`` if none."""
    start = text.find(start_marker)
    if start == -1:
        return None
    end_idx = text.find(end_marker, start)
    if end_idx == -1:
        return None
    nl = text.find("\n", end_idx)
    end = len(text) if nl == -1 else nl + 1
    return (start, end)


def _strip_managed_blocks(text: str, start_marker: str, end_marker: str) -> str:
    """Remove every managed block from ``text`` (drops duplicates left after the first)."""
    out: list[str] = []
    rest = text
    while True:
        span = _managed_block_span(rest, start_marker, end_marker)
        if span is None:
            out.append(rest)
            return "".join(out)
        start, end = span
        out.append(rest[:start])
        rest = rest[end:]


def _merge_managed_block(text: str, block: str, start_marker: str, end_marker: str) -> str:
    """Insert/replace a marker-delimited managed block, byte-exactly. Replaces the
    first managed block and drops any later duplicate managed blocks, so the file is
    left with exactly one; a block-less file gets the block appended after one blank
    line; an empty file becomes the block."""
    span = _managed_block_span(text, start_marker, end_marker)
    if span is not None:
        start, end = span
        return text[:start] + block + _strip_managed_blocks(text[end:], start_marker, end_marker)
    if text == "":
        return block
    return text + ("\n" if text.endswith("\n") else "\n\n") + block


def _merge_gitlab_block(text: str, block: str) -> str:
    """Insert/replace the managed block in an existing ``.gitlab-ci.yml``, byte-exactly."""
    return _merge_managed_block(text, block, GITLAB_MARKER_START, GITLAB_MARKER_END)


def _write_failure_message(rel: str, e: OSError) -> str:
    """A deterministic, OS-text-free message for a failed CI-file write, keeping stderr
    byte-identical across the Node, Go, and Python SDKs."""
    if isinstance(e, PermissionError):
        return f'cannot write "{rel}": permission denied'
    return f'cannot write "{rel}"'


def _write_file_atomic(root_abs: Path, abs_path: Path, rel: str, contents: str) -> None:
    """Write ``contents`` to ``abs_path`` atomically (sibling temp file then rename,
    both ends judged by the write chokepoint), so a failed write never leaves a partial
    file. On failure the temp file is removed and a deterministic, OS-text-free
    InitPathError is raised (byte-identical across SDKs)."""
    try:
        verdict = write_file_atomic_guarded(
            guard_root(str(root_abs)), str(abs_path), _init_role(rel), contents
        )
    except OSError as e:
        raise InitPathError(_write_failure_message(rel, e)) from e
    _guarded_or_refuse(rel, verdict)


# Legacy aliases retained for any external callers of the original single-provider API.
build_ci_workflow = build_github_workflow


def ensure_ci_workflow(
    root: str, provider: str, report: Optional[EcosystemReport] = None
) -> CiResult:
    """Add a CI workflow running ``leji validate`` (the ``leji ci`` command), with the
    job the repository's own package manager needs. GitHub, CircleCI and Azure own
    whole files: created when absent, REPLACED when the file standing there is one leji
    generated (this release or an earlier one), and left untouched with a hand-add
    snippet when it is foreign or was edited. GitLab owns a marker-delimited block
    inside the shared ``.gitlab-ci.yml`` and merges it. Deterministic text
    (byte-identical across SDKs). Refuses a symlink that escapes root."""
    root_abs = Path(root).resolve()
    # Local-first: a repository that DECLARES the CLI and carries its manager's lock
    # evidence installs its own locked dependencies and runs the local binary; every
    # other state takes the fallback that needs no manifest.
    detected = report if report is not None else detect_ecosystem(str(root_abs))
    job = resolve_ci_job(detected, provider)
    # Every arm decides what stands at its target through the verified read, never
    # through a pathname check: ``Path.exists()`` follows symlinks, so a dangling link
    # at the workflow path reads as absent and the create lands at the link's
    # destination. None is the create path; a verified regular file is judged by its
    # bytes; a standing entry that cannot be verified is the same refusal a write to it
    # would be.
    root_real = guard_root(str(root_abs))

    def whole_file(rel: str, snippet: str, note: Optional[str] = None) -> CiResult:
        """Create, replace what we own, or hand back a snippet."""
        abs_path = root_abs / rel
        _assert_no_symlink_escape(root_abs, abs_path, rel)
        content = build_ci_file(provider, job)
        existing = _read_merge_source(root_real, abs_path, rel)
        if existing is None:
            _write_file_atomic(root_abs, abs_path, rel, content)
            return CiResult(provider=provider, path=rel, action="created", note=note)
        if existing == content:
            return CiResult(provider=provider, path=rel, action="unchanged")
        if not is_leji_generated(provider, existing):
            return CiResult(provider=provider, path=rel, action="manual", snippet=snippet)
        _write_file_atomic(root_abs, abs_path, rel, content)
        return CiResult(provider=provider, path=rel, action="updated")

    if provider == "github":
        return whole_file(CI_WORKFLOW_PATH, build_github_workflow(job))
    if provider == "gitlab":
        abs_path = root_abs / GITLAB_CI_PATH
        _assert_no_symlink_escape(root_abs, abs_path, GITLAB_CI_PATH)
        block = build_gitlab_block(job)
        # The merge is a read-then-write of one target, so the bytes come from the
        # verified read: the file the rule judged is the file that is read and then
        # rewritten.
        text = _read_merge_source(root_real, abs_path, GITLAB_CI_PATH)
        if text is None:
            _write_file_atomic(root_abs, abs_path, GITLAB_CI_PATH, block)
            return CiResult(provider=provider, path=GITLAB_CI_PATH, action="created")
        merged = _merge_gitlab_block(text, block)
        if merged == text:
            return CiResult(provider=provider, path=GITLAB_CI_PATH, action="unchanged")
        _write_file_atomic(root_abs, abs_path, GITLAB_CI_PATH, merged)
        return CiResult(provider=provider, path=GITLAB_CI_PATH, action="updated")
    if provider == "circleci":
        return whole_file(CIRCLECI_CONFIG_PATH, build_circleci_snippet(job))
    if provider != "azure":
        # Unreachable from the CLI (it validates first); guards direct helper callers so
        # an unknown provider errors consistently across the three SDKs.
        raise InitPathError(f'unknown provider "{provider}"')
    # The activation note is created-only: a re-run on an existing file stays quiet.
    return whole_file(AZURE_PIPELINE_PATH, build_azure_pipeline(job), AZURE_ACTIVATION_NOTE)


def _reject_non_finite(_: str) -> object:
    """parse_constant hook: reject NaN/Infinity/-Infinity so the strict JSON parse
    matches TS (JSON.parse) and Go (encoding/json), which forbid non-finite constants
    Python's json.loads would otherwise accept."""
    raise ValueError("non-finite JSON constant")


# A name (also the agent-profile `id` and the agents-map key) and a role must be
# kebab identifiers: matches the agent-profile schema's id pattern, is safe as a
# path segment, and is safe to interpolate into YAML frontmatter and JSON.
_AGENT_TOKEN_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def _assert_agent_token(label: str, value: str) -> None:
    if not _AGENT_TOKEN_RE.match(value):
        raise RuntimeError(
            f"{label} must be lowercase letters, digits, and single dashes "
            f'(e.g. "thought-partner"); got "{value}"'
        )


def build_agent_profile(name: str, role: str, host_id: Optional[str], root_path: str) -> str:
    """Starter agent profile. Body keyed off role: ``reviewer`` (default) keeps the
    review posture; any other role gets a neutral template. ``host`` is optional (omitted
    for a host-agnostic resident agent). Frontmatter satisfies the agent-profile schema
    (id/name/role/requiredRead/mustAskWhen)."""
    host_line = f"host: {host_id}\n" if host_id else ""
    host_note = f" (host `{host_id}`)" if host_id else ""
    head = f"""---
id: {name}
name: {name}
role: {role}
{host_line}inherits: core
"""
    if role == "reviewer":
        return (
            head
            + f"""purpose: Independent review of proposed context-layer changes before a person approves.
requiredRead:
  - {join_under_root(root_path, "boot-profile.md")}
  - {join_under_root(root_path, "agents/core.md")}
mustAskWhen:
  - a proposal weakens an invariant or guardrail
  - a change to settled behavior lacks a decision record
---

# {name}

A second agent{host_note} that reviews context-layer proposals against the spec and this
layer's own rules before a person approves. Inherits the core posture; it never loosens it.

## Review focus

- The proposal matches how this team actually works (domain, system, governance).
- Placeholders are gone and claims are grounded in the repository.
- A change to settled behavior carries a decision record.
"""
        )
    return (
        head
        + f"""requiredRead:
  - {join_under_root(root_path, "boot-profile.md")}
  - {join_under_root(root_path, "agents/core.md")}
mustAskWhen:
  - a change would weaken an invariant or guardrail
  - a change to settled behavior lacks a decision record
---

# {name}

The `{role}` agent{host_note} bound to this context layer. Inherits the core posture
from the boot profile and core profile; it never loosens it.

## Responsibilities

- TODO: describe what this agent is responsible for.
- TODO: list what it may do unprompted and what needs a human gate.
"""
    )


# Guidance for the `default` binding: selecting a role profile there is not the same
# as loading it, a distinction the key's name invites readers to miss. Written-only,
# like the CI activation note: a re-run that binds nothing stays terse.
AGENTS_DEFAULT_NOTE = (
    "agents.default selects a role profile; it does not load it. If its instructions "
    "must apply before every task, fold them into the boot profile; otherwise keep the "
    "profile role-scoped and engage it through the relevant protocol."
)


@dataclass
class AgentResult:
    """What :func:`add_agent` did, for the command to report. Each artifact is
    independently idempotent: a ``*_created``/``manifest_changed`` of False means
    it was already there. ``note`` is advisory text the caller surfaces verbatim
    (set when the ``default`` binding is written)."""

    name: str
    role: str
    host_id: Optional[str]  # None for a host-agnostic resident agent (no --host)
    profile_path: str
    profile_created: bool
    manifest_changed: bool
    note: Optional[str] = None


def add_agent(
    root: str,
    manifest: Manifest,
    host: Optional[str],
    name: str,
    role: Optional[str] = None,
) -> AgentResult:
    """Wire a named agent into an existing layer (the ``leji agent`` command): write a
    starter profile and bind the agent in leji.json via an in-place text edit. --host
    pins the profile to an external CLI; without it, a host-agnostic resident agent.
    Never writes a vendor file (those are migrated, never created). Never overwrites an
    existing profile; re-running is a no-op."""
    root_abs = Path(root).resolve()
    role = role or "reviewer"
    _assert_agent_token("agent name", name)
    _assert_agent_token("agent role", role)
    host_id: Optional[str] = None
    if host:
        host_id_resolved = resolve_host_id(host)
        spec = (
            next((s for s in HOST_SPECS if s.id == host_id_resolved), None)
            if host_id_resolved
            else None
        )
        if not spec:
            known = ", ".join(s.id for s in HOST_SPECS)
            raise RuntimeError(f'unknown host "{host}"; known: {known}')
        host_id = spec.id

    base = effective_agent_profiles_path(manifest)
    profile_rel = (base if base.endswith("/") else f"{base}/") + f"{name}.md"
    profile_abs = root_abs / profile_rel
    root_real = guard_root(str(root_abs))

    # Both halves of this command are judged BEFORE either is written: binding an agent
    # means a profile file and a manifest edit, and a run that can only do one of them
    # must do neither. The manifest is read through the verified read (its bytes are
    # spliced and written straight back), so a target that cannot be verified as a
    # regular file inside the repository refuses the whole command with nothing written.
    # ``absent`` refuses too: this command edits a manifest, it never creates one.
    manifest_abs = root_abs / "leji.json"
    manifest_read = verified_target_read(root_real, str(manifest_abs), None)
    if manifest_read.status != "regular":
        raise InitPathError(
            'refusing to write through a symlink that escapes the target: "leji.json"'
        )
    original = manifest_read.text()
    text, _ = bind_agent_in_manifest_text(original, name, profile_rel)
    manifest_changed = text != original

    # The profile half is judged next, still before either write: a pathname check
    # follows symlinks, so a dangling link at the profile name reads as absent and the
    # write lands at the link's destination. Only ``absent`` is written; a verified
    # regular file is the never-overwrite skip this command has always made; anything
    # else standing there refuses the whole command with nothing written.
    profile_read = verified_target_read(root_real, str(profile_abs), None)
    if profile_read.status == "refused":
        raise InitPathError(
            f'refusing to write through a symlink that escapes the target: "{profile_rel}"'
        )
    profile_created = profile_read.status == "absent"

    if profile_created:
        profile = build_agent_profile(name, role, host_id, manifest["rootPath"])
        _guarded_or_refuse(
            profile_rel, write_file_guarded(root_real, str(profile_abs), None, profile)
        )
    if manifest_changed:
        _guarded_or_refuse(
            "leji.json", write_file_guarded(root_real, str(manifest_abs), None, text)
        )

    return AgentResult(
        name=name,
        role=role,
        host_id=host_id,
        profile_path=profile_rel,
        profile_created=profile_created,
        manifest_changed=manifest_changed,
        note=AGENTS_DEFAULT_NOTE if name == "default" and manifest_changed else None,
    )


def _plan_with_index_truth(plan: list[PlanEntry], index_rel: str) -> list[PlanEntry]:
    """Leji owns the generated index and regenerates it, so an existing one is
    replaced rather than skipped. ``build_write_plan`` classifies any existing path as
    ``skip-exists``, which would promise a file is left alone that ``write_index``
    then rewrites; this restates that one entry truthfully."""
    return [
        PlanEntry(
            rel=e.rel,
            status="overwrite",
            note="regenerated from the category index files",
        )
        if e.rel == index_rel and e.status == "skip-exists"
        else e
        for e in plan
    ]


def _assert_clean_working_tree(root: str) -> None:
    """Refuse to mutate a dirty working tree: the "git restore cleanly undoes Leji's
    writes" safety net only holds if the tree started clean, so a dirty tree is refused
    rather than entangling our writes with the user's uncommitted work. A non-git
    directory has no such net and is allowed (how a fresh layer bootstraps before
    ``git init``). Callers skip this under dry_run."""
    if working_tree_clean(root) is False:
        raise RuntimeError(
            "the working tree has uncommitted changes; commit or stash them first "
            "so this stays cleanly reversible (preview with --dry-run)"
        )


def init_layer(
    directory: str,
    yes: bool = False,
    name: Optional[str] = None,
    level: Optional[str] = None,
    dry_run: bool = False,
    agent: Optional[str] = None,
    mode: Optional[str] = None,
    # Skip generating the portable `AGENTS.md` pointer (written by default when
    # absent; an existing file is never touched).
    no_agents: bool = False,
    # The invocation's notice state for the self-managed `.leji/.gitignore`, which this
    # command ensures when it creates the onboarding workspace. None means a context
    # local to this call.
    ignore_context: Optional[LejiIgnoreContext] = None,
) -> InitResult:
    """Bootstrap a context layer. Interactive unless ``yes``. Refuses to run
    when leji.json already exists; never overwrites existing files."""
    # Flag values are checked before anything on disk is read, the way the CLI
    # parser rejects --mode/--level.
    if agent:
        _assert_agent_host(agent)
    root = Path(directory).resolve()
    if (root / "leji.json").exists():
        raise RuntimeError(
            "leji.json already exists here; init refuses to overwrite an existing layer"
        )
    if not dry_run:
        _assert_clean_working_tree(str(root))
    detected = detect_hosts(str(root))
    answers = (
        _default_answers(directory, name, level, mode)
        if yes
        else _prompt(directory, name, level, mode)
    )
    answers.categories = _normalize_categories(answers.categories, answers.mode)
    # Validate the chosen root and every derived write path against the schema
    # relative-path rule and assert containment, BEFORE writing anything.
    _reject_unsafe_rel(answers.root_path, "context root")
    _safe_target(root, answers.root_path, "context root")
    manifest = _build_manifest(answers)
    for key in ("bootProfilePath",):
        _safe_target(root, manifest[key], f"manifest.{key}")
    for category in answers.categories:
        for cpath in manifest["categories"][category]["indexes"]:
            _safe_target(root, cpath, f"categories.{category}")
    r = answers.root_path
    layout = answers.layout or default_layout(r)

    # Assemble the files init owns, in write order. leji.json comes first so the
    # overwrite guard is effective on a retry after an interrupted run.
    writes: list[PlannedWrite] = [
        PlannedWrite("leji.json", json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    ]
    writes.append(PlannedWrite(manifest["bootProfilePath"], _build_boot_profile(answers)))
    # The portable discovery adapter: a pointer-only AGENTS.md so any host that
    # auto-loads it cold-starts into the boot profile. Default-on; --no-agents
    # skips it, and an existing file is never touched (it stays in wont_modify).
    if not no_agents and not (root / PORTABLE_ADAPTER).is_file():
        writes.append(PlannedWrite(PORTABLE_ADAPTER, adapter_content(manifest["bootProfilePath"])))
    for category in answers.categories:
        if category == "decisions":
            continue
        stub = CATEGORY_STUBS[category]
        writes.append(
            PlannedWrite(
                f"{join_under_root(r, category + '/')}{stub['file']}",
                _category_stub(stub["title"], stub["summary"], stub["body"]),
            )
        )
    if answers.mode == "solo":
        # Solo starters live in their category directories, so the existing
        # category index files govern them with no extra wiring.
        for category, starter_file, template in _SOLO_STARTERS:
            writes.append(
                PlannedWrite(
                    f"{join_under_root(r, category + '/')}{starter_file}",
                    _read_template(template),
                )
            )
    writes.append(
        PlannedWrite(
            f"{join_under_root(r, 'decisions/')}0001-adopt-leji.md",
            _build_first_decision(answers),
        )
    )
    # Write a stub index file per category so the manifest's `indexes` resolve to
    # real, populated content.
    for category in answers.categories:
        writes.append(
            PlannedWrite(f"{layout.context_dir}{category}.md", _category_index_file(r, category))
        )
    writes.append(PlannedWrite(f"{layout.agents_dir}core.md", _build_core_profile(answers)))
    writes.append(PlannedWrite(BRIEF_PATH, _build_brief(answers)))
    if answers.level == "indexed":
        # The changelog records the paths seeded; compute from the planned set
        # (everything except the changelog and the generated index). Dot-paths
        # (the transient `.leji/` brief) are excluded from the governed machine
        # surface, so they never seed the changelog.
        seeded = sorted(
            w.rel for w in writes if not any(seg.startswith(".") for seg in w.rel.split("/"))
        )
        writes.append(
            PlannedWrite(effective_changelog_path(manifest), _build_changelog(answers, seeded))
        )

    # Foreign entrypoint files Leji detects but will never modify.
    wont_modify = [rel for rel in KNOWN_VENDOR_FILES if (root / rel).is_file()]
    # The index is generated at every level, not only at `indexed`. `leji index
    # --check` is a CI gate for any layer, so a scaffold that omits the index hands
    # the adopter a red first run on the documented happy path. The changelog stays
    # gated: it is an `indexed` requirement, and seeding one at `core` over-scaffolds.
    index_rel = effective_index_path(manifest)
    plan = _plan_with_index_truth(
        build_write_plan(str(root), [*writes, PlannedWrite(index_rel, "")], wont_modify),
        index_rel,
    )

    if dry_run:
        return InitResult(
            written=[],
            manifest=manifest,
            mode=answers.mode,
            plan=plan,
            dry_run=True,
            detected=detected,
            root=str(root),
        )

    written: list[str] = []
    root.mkdir(parents=True, exist_ok=True)
    # The tracked-file preflight and the `.leji/` ignore run BEFORE any write at
    # all, so the private onboarding workspace can never land in git and a failed
    # preflight leaves the tree untouched.
    _assert_leji_workspace_private(str(root))
    _ensure_leji_gitignored(root)
    # leji.json is created exclusively ("x" / O_EXCL): it closes the check-then-write
    # race and refuses to follow a symlink at the final component, so a concurrent
    # init or a planted symlink cannot be overwritten or escaped.
    _write_manifest_exclusive(root, root / "leji.json", writes[0].content, "init")
    written.append("leji.json")
    # The changelog is held back until the index generates cleanly. Seeding it off a
    # tree that cannot be indexed would leave a layer claiming `indexed` with a
    # changelog, no index, and a `leji.json` that blocks re-running `init`.
    changelog_rel = effective_changelog_path(manifest) if answers.level == "indexed" else None
    for w in writes[1:]:
        if w.rel == changelog_rel:
            continue
        _write_file_once(root, w.rel, w.content, written)
    # The onboarding workspace is a `.leji/` role and now exists, so the tool ignores its
    # own tree from inside: the nested counterpart to the root `.gitignore` line above,
    # and the one that covers a layer whose root file never received it.
    _ensure_leji_ignore_or_refuse(str(root), ignore_context)

    # The whole of the `leji index` rule, not half of it: write_index declines to
    # write on a hard generation finding, so the file is not claimed, the dependent
    # changelog is not seeded, and the findings travel out for the caller to report.
    index = write_index(str(root), manifest)
    if not has_errors(index.findings):
        written.append(index_rel)
        changelog = next((w for w in writes[1:] if w.rel == changelog_rel), None)
        if changelog is not None:
            _write_file_once(root, changelog.rel, changelog.content, written)

    return InitResult(
        written=sorted(written),
        findings=index.findings,
        manifest=manifest,
        mode=answers.mode,
        plan=plan,
        dry_run=False,
        detected=detected,
        root=str(root),
    )


# --- adoption (existing repositories) ---

DOCS_CANDIDATES = ["docs/", "doc/", "documentation/"]


def pick_docs_root(dir_names: "list[str]") -> "str | None":
    """Choose the docs root from a set of directory names, as a pure function of it.

    Exact spelling first, then the lowest remaining name. Both halves are needed: a
    case-sensitive filesystem may hold several variants at once, and directory-entry
    order is not guaranteed, so taking the first match found would make the recorded
    rootPath depend on the order a read happened to return. Kept separate from the
    filesystem so the ordering rule is testable against an injected set.
    """
    for candidate in DOCS_CANDIDATES:
        want = candidate.rstrip("/")
        matches = sorted(n for n in dir_names if n.lower() == want.lower())
        if not matches:
            continue
        hit = next((n for n in matches if n == want), matches[0])
        return f"{hit}/"
    return None


def _detect_docs_root(root: Path) -> "str | None":
    """The existing docs directory named as it is on disk, or None.

    Matching is case-insensitive and the answer is the real entry, which are two
    halves of one defect: testing ``(root / "docs").is_dir()`` succeeds on a
    case-insensitive filesystem when the directory is actually ``Docs``, and
    returning the candidate rather than the entry then recorded a rootPath that does
    not match disk. ``is_dir()`` follows symlinks, because a documentation root is
    allowed to be a directory symlink. Each entry is guarded separately because
    ``is_dir()`` propagates a permission error, which would abort detection where
    the other SDKs skip the entry.
    """

    def _is_dir(p: Path) -> bool:
        try:
            return p.is_dir()
        except OSError:
            return False

    try:
        entries = list(root.iterdir())
    except OSError:
        return None
    return pick_docs_root([e.name for e in entries if _is_dir(e)])


@dataclass
class AdoptResult(InitResult):
    detected_root: str = ""
    # Vendor files whose content was migrated into the layer.
    migrated: list[str] = field(default_factory=list)
    # A non-redirecting vendor file remains, so the layer is not yet
    # core-conformant.
    draft: bool = False
    # The run wired adapters into a layer that already existed (--wire-adapters on
    # a repository with a leji.json) instead of adopting a new one.
    wired_only: bool = False
    # Vendor entrypoints converted to redirects by this run.
    wired: list[str] = field(default_factory=list)


def _longest_backtick_run(content: str) -> int:
    """Longest run of consecutive backticks anywhere in ``content`` (0 if none)."""
    longest = 0
    for run in re.findall(r"`+", content):
        longest = max(longest, len(run))
    return longest


def _migration_doc(source_rel: str, content: str) -> str:
    summary = (
        f"Agent instructions migrated verbatim from {source_rel}; refine into the right categories."
    )
    # Fence the migrated content so raw HTML/Markdown is shown verbatim, never rendered:
    # the migration cannot inject script into the Docsify preview (a local trusted-content
    # viewer, not a sandbox; other layer docs are still rendered as authored).
    # Fence is one backtick longer than the longest run in the content.
    fence = "`" * max(3, _longest_backtick_run(content) + 1)
    return (
        f"---\nsummary: {summary}\n---\n\n# Imported agent instructions ({source_rel})\n\n"
        f"<!-- Migrated by `leji adopt` from {source_rel}. Split this into "
        "domain/system/practice/governance "
        f"as appropriate; the original file is unchanged. -->\n\n"
        f"{fence}\n{content.strip()}\n{fence}\n"
    )


def _adopt_existing_decision(answers: InitAnswers, migrated: list[str]) -> str:
    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
    return f"""---
id: adopt-existing-agent-context
title: Adopt existing agent instructions into the context layer
status: accepted
date: {today}
deciders:
  - {answers.owner_name}
---

# Adopt existing agent instructions into the context layer

## Context

This repository already carried agent configuration ({", ".join(migrated)}). That content is team knowledge that belonged in the context layer, not in a per-tool file.

## Decision

Its content was migrated into the layer (see `{join_under_root(answers.root_path, "governance/")}`). The original file(s) were left unchanged; converting them to one-line redirects is a separate, consented step (`leji adopt --wire-adapters`).

## Consequences

The context layer is the single source of truth. Until the vendor entrypoints redirect, the layer does not claim core conformance.
"""


def adopt_layer(
    directory: str,
    yes: bool = False,
    dry_run: bool = False,
    wire_adapters: bool = False,
    agent: Optional[str] = None,
    name: Optional[str] = None,
    mode: Optional[str] = None,
    # Skip generating the portable `AGENTS.md` pointer (written by default when
    # absent; an existing file keeps the migrate/--wire-adapters flow).
    no_agents: bool = False,
    # The invocation's notice state for the self-managed `.leji/.gitignore`, which this
    # command ensures when it creates the onboarding workspace. None means a context
    # local to this call.
    ignore_context: Optional[LejiIgnoreContext] = None,
) -> AdoptResult:
    """Bring Leji into an existing repository: reuse an existing docs root, migrate any
    vendor entrypoints into the layer (originals untouched), and seed the scaffold.
    Refuses when a layer already exists. With ``wire_adapters``, converts the present
    entrypoints to redirects (a consented overwrite after migration); otherwise the
    result is an adoption draft, not yet core-conformant."""
    if agent:
        _assert_agent_host(agent)
    root = Path(directory).resolve()
    if (root / "leji.json").exists():
        # `adopt --yes` prints `leji adopt --wire-adapters` as the step that finishes
        # an adoption draft, and by then the layer exists. Refusing the flag here left
        # that repository non-conformant with no command that could fix it, so the
        # flag wires adapters into the layer already on disk and scaffolds nothing.
        if wire_adapters:
            return _wire_adapters_into_layer(root, dry_run)
        raise RuntimeError(
            "leji.json already exists here; this repository already has a Leji layer"
        )
    if not dry_run:
        _assert_clean_working_tree(str(root))
    detected = detect_hosts(str(root))
    detected_root = _detect_docs_root(root) or "docs/"
    _reject_unsafe_rel(detected_root, "context root")

    boot_rel = f"{detected_root}boot-profile.md"
    canonical_redirect = adapter_content(boot_rel).strip()
    # A vendor file that cannot be verified as a regular file inside the repository is
    # neither read, migrated, nor converted: it is treated as absent.
    vendor = _verified_vendor_files(root)
    vendor_present = list(vendor.keys())
    # Migrate any vendor file not already exactly Leji's redirect, so its content is
    # archived before --wire-adapters overwrites it. An already-canonical or empty file
    # has nothing to preserve.
    to_migrate = [
        rel for rel in vendor_present if vendor[rel].strip() not in ("", canonical_redirect)
    ]

    base = re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", root.name.lower()))
    # Working mode is flag-only for adopt (adopt never reads stdin); omitted
    # means `team`.
    working_mode = _assert_mode(mode) if mode else "team"
    categories: list[str] = ["domain", "system"]
    if to_migrate:
        categories.append("governance")
    categories.append("decisions")
    answers = InitAnswers(
        name=name or f"{base}-context",
        description="Shared context layer for this repository.",
        root_path=detected_root,
        owner_name=_git_config("user.name") or "<named owner>",
        owner_contact=_git_config("user.email") or "",
        categories=_normalize_categories(categories, working_mode),
        level="core",
        mode=working_mode,
        # Resolve every scaffold path against existing content so adopt never clobbers.
        # The viewer dir (.leji/, reserved and gitignored) is generated by `leji viewer`,
        # not scaffolded here, so nothing collides at adopt time.
        layout=_resolve_layout(str(root), detected_root),
    )

    manifest = _build_manifest(answers)
    r = answers.root_path
    layout = answers.layout or default_layout(r)

    # Convert only EXISTING vendor entrypoints (never create new) that aren't already the
    # canonical redirect; each was captured in to_migrate above, so no content is lost.
    to_convert = (
        [rel for rel in vendor_present if vendor[rel].strip() != canonical_redirect]
        if wire_adapters
        else []
    )
    if to_convert:
        manifest["vendorAdapters"] = to_convert

    writes: list[PlannedWrite] = [
        PlannedWrite("leji.json", json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    ]
    writes.append(PlannedWrite(manifest["bootProfilePath"], _build_boot_profile(answers)))
    # The portable discovery adapter, only when no AGENTS.md exists: a present one
    # keeps the migrate/--wire-adapters flow (its content is archived first).
    if not no_agents and not (root / PORTABLE_ADAPTER).is_file():
        writes.append(PlannedWrite(PORTABLE_ADAPTER, adapter_content(manifest["bootProfilePath"])))
    for category in answers.categories:
        if category == "decisions":
            continue
        stub = CATEGORY_STUBS[category]
        writes.append(
            PlannedWrite(
                f"{join_under_root(r, category + '/')}{stub['file']}",
                _category_stub(stub["title"], stub["summary"], stub["body"]),
            )
        )
    if answers.mode == "solo":
        # Solo starters are collision-safe: an existing identity.md or
        # writing-style.md is skipped (skip-exists), never overwritten.
        for category, starter_file, template in _SOLO_STARTERS:
            writes.append(
                PlannedWrite(
                    f"{join_under_root(r, category + '/')}{starter_file}",
                    _read_template(template),
                )
            )
    writes.append(
        PlannedWrite(
            f"{join_under_root(r, 'decisions/')}0001-adopt-leji.md",
            _build_first_decision(answers),
        )
    )
    # Write a stub index file per category so the manifest's `indexes` resolve to
    # real, populated content.
    for category in answers.categories:
        writes.append(
            PlannedWrite(f"{layout.context_dir}{category}.md", _category_index_file(r, category))
        )
    writes.append(PlannedWrite(f"{layout.agents_dir}core.md", _build_core_profile(answers)))
    writes.append(PlannedWrite(BRIEF_PATH, _build_brief(answers)))

    migrated: list[str] = []
    migration_doc_by_vendor: dict[str, str] = {}
    planned_rels = {w.rel for w in writes}
    for rel in to_migrate:
        base_slug = re.sub(
            r"^-|-$",
            "",
            re.sub(
                r"[^a-z0-9]+",
                "-",
                re.sub(r"\.md$", "", Path(rel).name, flags=re.IGNORECASE).lower(),
            ),
        )
        # Disambiguate against both the planned write set and disk, so the migrated copy
        # is never skipped by _write_file_once (a skip then --wire-adapters overwrite would
        # lose the original). The on-disk half is decided on the standing entry, never by
        # ``Path.exists()``, which follows symlinks: a dangling candidate would read as a
        # free name and the archive would be written at the link's missing destination.
        # Any standing entry is occupied and the next name is tried (the rule
        # ``_archive_path`` mirrors).
        slug = base_slug
        doc_rel = f"{join_under_root(r, 'governance/')}imported-{slug}.md"
        n = 2
        while doc_rel in planned_rels or not nothing_stands_at(str(root / strip_slash(doc_rel))):
            slug = f"{base_slug}-{n}"
            doc_rel = f"{join_under_root(r, 'governance/')}imported-{slug}.md"
            n += 1
        planned_rels.add(doc_rel)
        writes.append(PlannedWrite(doc_rel, _migration_doc(rel, vendor[rel])))
        migration_doc_by_vendor[rel] = doc_rel
        migrated.append(rel)
    if migrated:
        writes.append(
            PlannedWrite(
                f"{join_under_root(r, 'decisions/')}0002-adopt-existing-agent-context.md",
                _adopt_existing_decision(answers, migrated),
            )
        )

    for rel in to_convert:
        writes.append(PlannedWrite(rel, adapter_content(manifest["bootProfilePath"])))

    wont_modify = [rel for rel in vendor_present if rel not in to_convert]
    # Same reasoning as `init`: the generated index ships with every adoption so the
    # `leji ci` gate passes on the first run.
    index_rel = effective_index_path(manifest)
    plan = _plan_with_index_truth(
        build_write_plan(
            str(root), [*writes, PlannedWrite(index_rel, "")], wont_modify, to_convert
        ),
        index_rel,
    )
    draft = any(boot_rel not in vendor[rel] for rel in wont_modify)

    if dry_run:
        return AdoptResult(
            written=[],
            manifest=manifest,
            mode=answers.mode,
            plan=plan,
            dry_run=True,
            detected=detected,
            root=str(root),
            detected_root=detected_root,
            migrated=migrated,
            draft=draft,
            wired=to_convert,
        )

    written: list[str] = []
    root.mkdir(parents=True, exist_ok=True)
    # The tracked-file preflight and the `.leji/` ignore run BEFORE any write at
    # all, so the private onboarding workspace can never land in git and a failed
    # preflight leaves the tree untouched.
    _assert_leji_workspace_private(str(root))
    _ensure_leji_gitignored(root)
    _write_manifest_exclusive(root, root / "leji.json", writes[0].content, "adopt")
    written.append("leji.json")
    convert = set(to_convert)
    for w in writes[1:]:
        if w.rel in convert:
            # Never overwrite a vendor entrypoint until its migrated copy is on disk:
            # if the migration write was skipped, leave the original untouched rather
            # than replacing it with a redirect and losing its content.
            vendor_doc_rel = migration_doc_by_vendor.get(w.rel)
            if vendor_doc_rel is not None and vendor_doc_rel not in written:
                continue
            abs_path = _safe_target(root, w.rel, "write path")
            _guarded_or_refuse(
                w.rel,
                write_file_guarded(
                    guard_root(str(root)), str(abs_path), _init_role(w.rel), w.content
                ),
            )
            written.append(w.rel)
        else:
            _write_file_once(root, w.rel, w.content, written)
    # The onboarding workspace is a `.leji/` role and now exists, so the tool ignores its
    # own tree from inside: the nested counterpart to the root `.gitignore` line above,
    # and the one that covers a layer whose root file never received it.
    _ensure_leji_ignore_or_refuse(str(root), ignore_context)

    # Same rule as `leji index`: the file is claimed only when it was written, and
    # the findings travel out so the caller reports them and fails.
    index = write_index(str(root), manifest)
    if not has_errors(index.findings):
        written.append(index_rel)

    return AdoptResult(
        written=sorted(written),
        findings=index.findings,
        manifest=manifest,
        mode=answers.mode,
        plan=plan,
        dry_run=False,
        detected=detected,
        root=str(root),
        detected_root=detected_root,
        migrated=migrated,
        draft=draft,
        wired=to_convert,
    )


def _archive_path(root: Path, root_path: str, vendor_rel: str, doc: str) -> Optional[str]:
    """Where a vendor entrypoint's content is archived under ``governance/``: the
    first free ``imported-<slug>.md``, or None when this exact migration doc is
    already on disk — the normal case, ``adopt`` having archived it on the first
    pass. Mirrors the slug and disambiguation rules ``adopt_layer`` uses."""
    base_slug = re.sub(
        r"^-|-$",
        "",
        re.sub(
            r"[^a-z0-9]+",
            "-",
            re.sub(r"\.md$", "", Path(vendor_rel).name, flags=re.IGNORECASE).lower(),
        ),
    )
    root_real = guard_root(str(root))
    n = 1
    while True:
        slug = base_slug if n == 1 else f"{base_slug}-{n}"
        rel = f"{join_under_root(root_path, 'governance/')}imported-{slug}.md"
        abs_path = root / strip_slash(rel)
        # The candidate is judged on the standing entry and, when one stands, on its
        # verified bytes: a pathname existence check follows symlinks, so a dangling
        # candidate link would read as free and the write would follow it to its missing
        # destination. Nothing standing is free; the identical archive is already on
        # disk; anything else — different bytes, or a standing entry this run cannot
        # verify — is occupied, and the next name is tried.
        if nothing_stands_at(str(abs_path)):
            return rel
        standing = verified_target_read(root_real, str(abs_path), None)
        if standing.status == "regular" and standing.text() == doc:
            return None
        n += 1


def _wire_adapters_into_layer(root: Path, dry_run: bool) -> AdoptResult:
    """``leji adopt --wire-adapters`` against a repository that already has a layer:
    the second half of the two-step adoption whose first half prints this command.
    Converts every present vendor entrypoint that does not already redirect to the
    boot profile, archiving its content under ``governance/`` first (the same
    never-lose-content guarantee ``adopt`` gives) and skipping the archive when the
    identical migration doc is already there. Scaffolds nothing, rewrites no
    manifest, and touches no other file.

    The clean-tree check ``adopt`` runs is deliberately skipped: the ``adopt`` run
    this finishes is what left the tree dirty, so requiring a clean tree would
    reinstate the dead end. Content safety comes from the archive, not from git."""
    manifest = load_manifest(str(root)).manifest
    if manifest is None:
        raise RuntimeError(
            "leji.json is not a readable layer manifest; run `leji validate` for detail"
        )
    r = manifest["rootPath"]
    boot_rel = manifest["bootProfilePath"]
    redirect = adapter_content(boot_rel)
    # A vendor entrypoint that cannot be verified is treated as absent, as in `adopt`.
    vendor = _verified_vendor_files(root)
    vendor_present = list(vendor.keys())
    to_convert = [rel for rel in vendor_present if vendor[rel].strip() != redirect.strip()]

    # Archives first, so a vendor entrypoint is never overwritten before its content
    # is on disk; an empty file has nothing to preserve.
    writes: list[PlannedWrite] = []
    archived: list[str] = []
    for rel in to_convert:
        content = vendor[rel]
        if not content.strip():
            continue
        doc = _migration_doc(rel, content)
        doc_rel = _archive_path(root, r, rel, doc)
        if doc_rel is None:
            continue
        writes.append(PlannedWrite(doc_rel, doc))
        archived.append(rel)
    for rel in to_convert:
        writes.append(PlannedWrite(rel, redirect))

    wont_modify = [rel for rel in vendor_present if rel not in to_convert]
    plan = build_write_plan(str(root), writes, wont_modify, to_convert)
    # `detected` is empty by construction: wiring finishes an adoption rather than
    # starting one, so this run makes no MCP-install or agent-launch offer.
    if dry_run:
        return AdoptResult(
            written=[],
            manifest=manifest,
            mode="team",
            plan=plan,
            dry_run=True,
            detected=[],
            root=str(root),
            detected_root=r,
            migrated=archived,
            draft=False,
            wired_only=True,
            wired=to_convert,
        )

    written: list[str] = []
    root_real = guard_root(str(root))
    for w in writes:
        abs_path = _safe_target(root, w.rel, "write path")
        _guarded_or_refuse(
            w.rel, write_file_guarded(root_real, str(abs_path), _init_role(w.rel), w.content)
        )
        written.append(w.rel)
    # Only an archive lands inside the layer, so only an archive can stale the stored
    # index; a plain wiring run leaves the generated index (and its timestamp) alone.
    index_findings: list[Finding] = []
    if archived:
        index = write_index(str(root), manifest)
        index_findings = index.findings
        if not has_errors(index.findings):
            written.append(effective_index_path(manifest))
    return AdoptResult(
        written=sorted(written),
        findings=index_findings,
        manifest=manifest,
        mode="team",
        plan=plan,
        dry_run=False,
        detected=[],
        root=str(root),
        detected_root=r,
        migrated=archived,
        draft=False,
        wired_only=True,
        wired=to_convert,
    )


def entering_adopted(result: AdoptResult) -> str:
    """Post-adopt guidance, printed by the CLI."""
    if result.wired_only:
        return _entering_wired(result)
    lines = [entering_the_layer(result.manifest, result.mode)]
    if result.migrated:
        lines.extend(
            [
                "",
                f"Migrated {', '.join(result.migrated)} into "
                f"{join_under_root(result.manifest['rootPath'], 'governance/')} "
                "(originals untouched); refine into the right categories.",
            ]
        )
    if result.draft:
        lines.extend(
            [
                "",
                "This is an adoption draft: NOT yet core-conformant, because an existing vendor entrypoint",
                "does not redirect to the boot profile (the spec requires it). Finish with:",
                "",
                "   leji adopt --wire-adapters   # convert them to redirects (their content is already migrated)",
            ]
        )
    return "\n".join(lines)


def _entering_wired(result: AdoptResult) -> str:
    """What ``adopt --wire-adapters`` reports when it wired an existing layer."""
    if not result.wired:
        return "Every vendor entrypoint already redirects to the boot profile; nothing to wire."
    lines = [
        f"Wired {', '.join(result.wired)} to redirect to {result.manifest['bootProfilePath']}."
    ]
    if result.migrated:
        lines.extend(
            [
                "",
                "Archived their previous content in "
                f"{join_under_root(result.manifest['rootPath'], 'governance/')}; "
                "refine into the right categories.",
            ]
        )
    lines.extend(
        ["", "The layer should now be core-conformant. Confirm with:", "", "   leji validate"]
    )
    return "\n".join(lines)


# --- handoff offer (post-scaffold) ---

# CLI hosts that accept an inline prompt argument, so Leji can launch the handoff
# (`claude "..."`, `codex "..."`). Directory-style IDE hosts (Cursor, Windsurf) and
# unverified prompt syntaxes (Gemini) are left out; when only those are present the
# offer is skipped. Mirrors the commands in entering_the_layer.
PROMPT_HOST_IDS = ("claude-code", "codex")


@dataclass
class LaunchResult:
    """Outcome of spawning an agent: ``started`` is False when the process never
    started (e.g. binary not found); a non-None ``error`` with ``started`` True
    means it ran but did not finish cleanly (non-zero exit or signal)."""

    started: bool
    error: Optional[str] = None
    # The child's captured standard output, set only for a captured run
    # (``RunOptions.capture``); empty otherwise.
    stdout: str = ""


@dataclass(frozen=True)
class RunOptions:
    """Bounds for one child run. ``quiet`` suppresses child output (the MCP presence
    check); ``capture`` reads stdout back instead — bounded by ``timeout_ms`` and
    ``max_bytes``, with stdin closed and stderr discarded — which is what the preflight
    version probe needs; ``env`` adds the read-only, offline variables a probe runs
    under."""

    quiet: bool = False
    capture: bool = False
    timeout_ms: int = 0
    max_bytes: int = 0
    env: Optional[dict[str, str]] = None


@dataclass
class HandoffIO:
    """Injectable I/O for the handoff offer, so the interactive flow (prompting
    and launching a child process) is deterministically testable."""

    read_line: Callable[[str, str], str]
    # launch(bin, prompt_arg, cwd, host_args): cwd anchors the agent at the layer
    # root so a relative prompt path resolves (matters for `leji start --root
    # <dir>`); a None cwd uses the current directory. Host flags (from
    # `leji start -- <flags>`) go before the prompt argument.
    launch: Callable[[str, str, Optional[str], Optional[list[str]]], LaunchResult]
    # run(bin, args, cwd, opts): run a host subcommand (the MCP presence check /
    # register) or a bounded probe from cwd, per RunOptions. Defaulted so the
    # handoff-only flow (and its test fakes) need not supply it; production wiring
    # sets it in _default_handoff_io.
    run: Optional[Callable[[str, list[str], Optional[str], RunOptions], LaunchResult]] = None


@dataclass
class _PromptHost:
    id: str
    bin: str
    name: str


@dataclass(frozen=True)
class StartHost:
    """The host `leji start` targets, resolved before the preflight runs so the report
    can name it before the launch takes the terminal."""

    id: str
    bin: str
    name: str


def _exported(host: Optional[_PromptHost]) -> Optional[StartHost]:
    return None if host is None else StartHost(id=host.id, bin=host.bin, name=host.name)


def _internal(host: Optional[StartHost]) -> Optional[_PromptHost]:
    return None if host is None else _PromptHost(id=host.id, bin=host.bin, name=host.name)


# How much the probe reads at a time when the cap still allows it.
_PROBE_READ_CHUNK = 4096


def _end_probe(proc: "subprocess.Popen[bytes]") -> None:
    """Stop the probe and everything it started, then reap it. The whole session goes,
    not just the direct child: the cap and the timeout are only real if nothing the probe
    spawned survives them holding the pipe."""
    if proc.poll() is not None:
        return
    try:
        if os.name != "nt":
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        else:
            proc.kill()
    except (OSError, ProcessLookupError):
        proc.kill()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:  # pragma: no cover - the kill above is unconditional
        pass


def _capture_run(
    bin_name: str, args: list[str], cwd: Optional[str], opts: RunOptions
) -> LaunchResult:
    """The bounded probe: stdin closed so nothing can prompt, stderr discarded, output
    and wall time bounded. Both bounds are enforced WHILE the child runs, not after it
    finishes: the reader stops at the cap and the child is killed on the spot, so a
    program that streams forever can neither fill this process's memory nor sit on the
    pipe until the deadline. Exceeding either bound comes back as a failed run, which
    every caller treats as a failed probe."""
    # ``env`` REPLACES the environment; nothing of this process's is inherited.
    env = dict(opts.env) if opts.env is not None else None
    try:
        proc = subprocess.Popen(  # noqa: S603 (no shell)
            [bin_name, *args],
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
            # Its own session, so ending the probe ends everything it started: a shim
            # that backgrounds a child would otherwise hold the pipe open (and keep
            # running) after the run is cut off.
            start_new_session=os.name != "nt",
        )
    except OSError as e:
        return LaunchResult(started=False, error=str(e))

    captured = bytearray()
    capped = False

    def reader() -> None:
        """Read UNBUFFERED, never more than one byte past what the cap still allows.

        A buffered read waits for a full chunk or for EOF, so a child that prints one
        byte past the cap and then holds stdout open would not be seen as overflowing
        until the deadline. Reading the remaining allowance plus one byte means the
        first byte past the cap arrives on its own, the cap is decided the moment it is
        passed, and the main loop ends the child immediately."""
        nonlocal capped
        stream = proc.stdout
        if stream is None:
            return
        fd = stream.fileno()
        while True:
            allowance = _PROBE_READ_CHUNK
            if opts.max_bytes:
                allowance = min(allowance, opts.max_bytes - len(captured) + 1)
            try:
                chunk = os.read(fd, allowance)
            except (OSError, ValueError):
                return
            if not chunk:
                return
            # Exactly ``max_bytes`` is not overflow: the cap is the most that may be
            # held, and the whole read that would pass it is refused, as in the other
            # two SDKs.
            if opts.max_bytes and len(captured) + len(chunk) > opts.max_bytes:
                capped = True
                return
            captured.extend(chunk)

    pump = threading.Thread(target=reader, daemon=True)
    pump.start()
    timed_out = False
    deadline = (opts.timeout_ms / 1000) if opts.timeout_ms else None
    try:
        # The reader owns the pipe; this only waits for the process itself, so the cap
        # can end the run before the deadline does.
        while True:
            try:
                # Always polled, deadline or not: the cap has to be able to end the run
                # on its own, as it does in the other two SDKs.
                proc.wait(timeout=0.05)
                break
            except subprocess.TimeoutExpired:
                if capped:
                    break
                if deadline is not None:
                    deadline -= 0.05
                    if deadline <= 0:
                        timed_out = True
                        break
    finally:
        _end_probe(proc)
        pump.join(timeout=1)
        if proc.stdout is not None and not pump.is_alive():
            proc.stdout.close()

    if capped:
        return LaunchResult(started=True, error="probe output exceeded the cap")
    if timed_out:
        return LaunchResult(started=True, error="timed out")
    code = proc.returncode
    return LaunchResult(
        started=True,
        error=None if code == 0 else f"exit {code}",
        stdout=captured.decode("utf-8", errors="replace"),
    )


def _default_handoff_io() -> HandoffIO:
    """Real handoff I/O: a stdin prompt and a stdio-inherit subprocess."""

    def read_line(question: str, fallback: str) -> str:
        try:
            return input(f"{question} [{fallback}]: ").strip()
        except EOFError:
            return ""

    def launch(
        bin_name: str,
        prompt_arg: str,
        cwd: Optional[str] = None,
        host_args: Optional[list[str]] = None,
    ) -> LaunchResult:
        # cwd anchors the agent at the layer root so a relative prompt path
        # resolves (matters for `leji start --root <dir>`). Host flags (from
        # `leji start -- <flags>`) go before the prompt argument.
        try:
            proc = subprocess.run(  # noqa: S603 (no shell)
                [bin_name, *(host_args or []), prompt_arg], cwd=cwd
            )
        except OSError as e:
            return LaunchResult(started=False, error=str(e))
        return LaunchResult(
            started=True, error=None if proc.returncode == 0 else f"exit {proc.returncode}"
        )

    def run(
        bin_name: str,
        args: list[str],
        cwd: Optional[str] = None,
        opts: RunOptions = RunOptions(),
    ) -> LaunchResult:
        if opts.capture:
            return _capture_run(bin_name, args, cwd, opts)
        stdio = subprocess.DEVNULL if opts.quiet else None
        try:
            proc = subprocess.run(  # noqa: S603 (no shell)
                [bin_name, *args], cwd=cwd, stdin=stdio, stdout=stdio, stderr=stdio
            )
        except OSError as e:
            return LaunchResult(started=False, error=str(e))
        return LaunchResult(
            started=True, error=None if proc.returncode == 0 else f"exit {proc.returncode}"
        )

    return HandoffIO(read_line=read_line, launch=launch, run=run)


def _prompt_capable_hosts(detected: list[DetectedHost]) -> list[_PromptHost]:
    """Detected hosts (on PATH) that can be launched with an inline prompt, ranked
    (``detected`` is already strongest-first)."""
    out: list[_PromptHost] = []
    for h in detected:
        if not h.on_path or h.id not in PROMPT_HOST_IDS:
            continue
        spec = next((s for s in HOST_SPECS if s.id == h.id), None)
        if spec:
            out.append(_PromptHost(h.id, spec.bins[0], spec.name))
    return out


def _resolve_prompt_host(agent: str) -> Optional[_PromptHost]:
    """The launchable host an ``--agent`` value names (id or alias), or None when it
    names none. Detection state is irrelevant: the value is either a host Leji can
    launch or it is not."""
    host_id = resolve_host_id(agent)
    spec = (
        next((s for s in HOST_SPECS if s.id == host_id), None)
        if host_id and host_id in PROMPT_HOST_IDS
        else None
    )
    return _PromptHost(spec.id, spec.bins[0], spec.name) if spec else None


def _assert_agent_host(agent: str) -> _PromptHost:
    """Reject an ``--agent`` value naming no launchable host, the way ``--mode`` and
    ``--level`` reject unknown values: the accepted set is named and the command
    fails. Silently accepting it made ``--agent nosuchhost`` behave as if the flag
    were never passed."""
    host = _resolve_prompt_host(agent)
    if host is None:
        launchable = ", ".join(PROMPT_HOST_IDS)
        raise RuntimeError(f'--agent must be a launchable host ({launchable}); got "{agent}"')
    return host


def _pick_from_multiple(hosts: list[_PromptHost], io: HandoffIO) -> Optional[_PromptHost]:
    """Ask which of several detected hosts to launch (numbered), or None. Launching is a
    side effect, so it requires an explicit in-range number; empty/n/junk/out-of-range all
    skip and fall back to the printed instructions."""
    print("\nDetected coding agents on your PATH:")
    for i, h in enumerate(hosts, 1):
        print(f"   {i}) {h.name}")
    a = io.read_line("Which agent? (number, or Enter to skip)", "skip").lower()
    if a in ("", "n", "no"):
        return None
    if a.isdigit() and 1 <= int(a) <= len(hosts):
        return hosts[int(a) - 1]
    return None


def _choose_host(hosts: list[_PromptHost], prompt_arg: str, io: HandoffIO) -> Optional[_PromptHost]:
    """Ask which detected host to hand off to (or None): a single host confirms
    [Y/n]; several are numbered via :func:`_pick_from_multiple`."""
    if len(hosts) == 1:
        h = hosts[0]
        a = io.read_line(
            f'Hand the scaffold to {h.name} now ({h.bin} "{prompt_arg}")?', "Y/n"
        ).lower()
        return h if a in ("", "y", "yes") else None
    return _pick_from_multiple(hosts, io)


def _launch_host(
    host: _PromptHost,
    prompt_arg: str,
    io: HandoffIO,
    cwd: Optional[str] = None,
    host_args: Optional[list[str]] = None,
) -> bool:
    """Launch a chosen host with ``prompt_arg`` from ``cwd``. Returns True only on a
    clean exit; a spawn failure or a non-zero/signalled exit returns False so the
    caller can fall back to printed instructions."""
    args_shown = f"{' '.join(host_args)} " if host_args else ""
    print(f'\nStarting {host.name}: {host.bin} {args_shown}"{prompt_arg}"\n')
    res = io.launch(host.bin, prompt_arg, cwd, host_args)
    if not res.started:
        print(f"\nleji: could not start {host.bin} ({res.error}).", file=sys.stderr)
        return False
    # Started but exited non-zero or was killed (e.g. Ctrl-C): did not finish
    # cleanly, so fall back to the printed instructions.
    return res.error is None


@dataclass
class McpOfferOutcome:
    """How the handoff should proceed after the MCP offer resolved its target host:
    follow its own flow (``"default"``), launch the host the user already picked there
    (``"launch"``), or suppress the handoff entirely (``"skip"``, the user declined
    the pick)."""

    next: str = "default"  # "default" | "launch" | "skip"
    host: Optional[_PromptHost] = None  # the picked host when next == "launch"


def handoff_offer(
    manifest: Manifest,
    detected: list[DetectedHost],
    interactive: bool,
    io: Optional[HandoffIO] = None,
    agent: Optional[str] = None,
    cwd: Optional[str] = None,
    mcp: Optional[McpOfferOutcome] = None,
) -> bool:
    """Offer to hand the scaffold to a detected agent and launch it. Interactive only
    (a TTY and not --yes). ``agent`` forces a specific launchable host, else detected
    hosts drive the offer. ``cwd`` anchors the launch at the layer root so the brief's
    relative path resolves under `leji init/adopt --dir <x>` run from elsewhere. ``mcp``
    is the offer's outcome: a pick that already happened there is honored here, so the
    registered MCP server and the launched agent never diverge. Returns True when an
    agent launched and finished cleanly, else False to fall back to the printed
    instructions."""
    if not interactive:
        return False
    io = io or _default_handoff_io()
    mcp = mcp or McpOfferOutcome()
    prompt_arg = f"Read ./{BRIEF_PATH} and follow it."
    if agent:
        chosen: Optional[_PromptHost] = _assert_agent_host(agent)
    elif mcp.next == "skip":
        # The user declined the host pick during the MCP offer; don't re-ask.
        return False
    elif mcp.next == "launch":
        # The pick already happened during the MCP offer; launch the same host.
        chosen = mcp.host
    else:
        hosts = _prompt_capable_hosts(detected)
        if not hosts:
            return False
        chosen = _choose_host(hosts, prompt_arg, io)
    if chosen is None:
        return False
    return _launch_host(chosen, prompt_arg, io, cwd)


@dataclass
class McpOfferOptions:
    """Options for :func:`offer_mcp_install`, the pre-handoff MCP registration offer."""

    # Absolute layer root: the cwd for the check/register, so a project-scoped write
    # (Claude's `.mcp.json`) lands in this repository.
    root: str
    detected: list[DetectedHost]
    # A real TTY and not --yes; the offer never fires otherwise.
    interactive: bool
    io: Optional[HandoffIO] = None
    # --agent: force a specific launchable host (claude-code/codex); None detects.
    agent: Optional[str] = None


def offer_mcp_install(opts: McpOfferOptions) -> McpOfferOutcome:
    """Before the init/adopt handoff launches an agent, offer to register the local Leji
    MCP server for the launchable host, so the launched session gains native spec +
    validation tools. Interactive only, and skipped when the server is already registered
    (a quiet presence check), so it never nags or fires in scripts/CI. With several hosts
    detected the pick happens ONCE, here, and the returned outcome carries it into
    :func:`handoff_offer`, so the registered MCP server and the launched agent never
    diverge. Never raises: a failed check or register falls back to a printed manual
    command."""
    default = McpOfferOutcome()
    if not opts.interactive:
        return default
    io = opts.io or _default_handoff_io()
    # Resolve the one host this session targets: --agent forces it, a single
    # detected host is it, several ask (numbered, same as the handoff pick).
    target: Optional[_PromptHost] = None
    picked = False
    if opts.agent:
        target = _resolve_prompt_host(opts.agent)
        # An unknown --agent stays default: handoff_offer raises the proper error.
        if target is None:
            return default
    else:
        hosts = _prompt_capable_hosts(opts.detected)
        if not hosts:
            return default
        if len(hosts) == 1:
            target = hosts[0]
        else:
            target = _pick_from_multiple(hosts, io)
            if target is None:
                return McpOfferOutcome(next="skip")
            picked = True
    outcome = McpOfferOutcome(next="launch", host=target) if picked else default
    spec = next((s for s in HOST_SPECS if s.id == target.id), None)
    if spec is None or not spec.mcp_add:
        return outcome
    if io.run is None:
        # A handoff-only IO can't run the check/register. Skip the offer rather than
        # raise (the "never raises" contract); production always wires run.
        return outcome
    # Skip the offer when already registered (clean exit), so re-running init/adopt never
    # re-nags — but say so: a silent skip is indistinguishable from the offer being
    # broken. A failed check (e.g. an older host CLI) falls through to the offer.
    if spec.mcp_check:
        chk = io.run(target.bin, spec.mcp_check, opts.root, RunOptions(quiet=True))
        if chk.started and chk.error is None:
            print(
                f"Leji MCP server already registered for {target.name}; skipping the install offer."
            )
            return outcome
    scope_note = (
        " (writes ~/.codex config, user-level)"
        if target.id == "codex"
        else " (writes .mcp.json here; commit it to share with your team)"
    )
    answer = io.read_line(
        f"Register the Leji MCP server for {target.name} so the agent can retrieve "
        f"the spec and validate natively?{scope_note}",
        "Y/n",
    ).lower()
    if answer not in ("", "y", "yes"):
        return outcome
    res = io.run(target.bin, spec.mcp_add, opts.root, RunOptions())
    argv = f"{target.bin} {' '.join(spec.mcp_add)}"
    if not res.started:
        print(
            f"\nleji: could not run {target.bin} ({res.error}); register it manually:\n   {argv}",
            file=sys.stderr,
        )
        return outcome
    if res.error is None:
        print(f"Registered the Leji MCP server for {target.name}.")
    else:
        print(
            f"{target.bin} did not register cleanly; it may already be present, "
            f"or add it manually:\n   {argv}"
        )
    return outcome


def entering_the_layer(manifest: Manifest, mode: str = "team") -> str:
    """Post-init guidance, printed by the CLI. The team copy is unchanged from
    pre-mode releases; solo swaps one sentence to name the interview."""
    brief = BRIEF_PATH
    how = (
        [
            "The brief teaches the agent the Leji spec and points it at this repo: it reads your",
            "code, interviews you for identity and writing style (answer in text or drop files),",
            "and fills in real context. Prefer to do it yourself?",
        ]
        if mode == "solo"
        else [
            "The brief teaches the agent the Leji spec and points it at this repo: it reads your",
            "code, asks what it cannot infer, and fills in real context. Prefer to do it yourself?",
        ]
    )
    return "\n".join(
        [
            "",
            "The scaffold is in place, but the content is still placeholder. Hand it to your agent",
            "to populate from your actual repository:",
            "",
            f'   claude "Read ./{brief} and follow it."',
            f'   codex "Read ./{brief} and follow it."',
            "",
            *how,
            "Edit the seeded documents directly. Either way, check progress with:",
            "",
            "   leji validate --content   # placeholder / thin-content warnings",
            "   leji conformance          # the level reached and what is next",
        ]
    )


# --- the onboarding approval guard ---

# The onboarding approval guard: a transient Claude Code PreToolUse hook that
# counters the ask-prompt pattern. AskUserQuestion stays blocked until the
# proposal is written to .leji/work/proposal.md AND printed as message
# text; the corrective message lands at the action boundary, where instruction
# reliably reaches the model. Self-disabling once the onboarding brief is gone;
# the finalize step removes it entirely.
PROPOSAL_MARKER = "# Proposal for approval"


def _approval_guard_script(leji_rel: str) -> str:
    """The guard script, byte-identical to the Node SDK's."""
    leji_json = json.dumps(leji_rel)
    marker_json = json.dumps(PROPOSAL_MARKER)
    return (
        "#!/usr/bin/env node\n"
        "// Leji onboarding approval guard (transient; Claude Code PreToolUse hook on\n"
        "// AskUserQuestion). The approval prompt stays blocked until the proposal is\n"
        "// written to " + leji_rel + "/proposal.md AND printed as plain message text.\n"
        "// Self-disabling: once the onboarding brief is gone it always allows.\n"
        "// Removed at finalize; safe to delete at any time.\n"
        "import fs from 'node:fs';\n"
        "import path from 'node:path';\n"
        "\n"
        "const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };\n"
        "const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();\n"
        "const lejiDir = path.join(root, " + leji_json + ");\n"
        "if (read(path.join(lejiDir, 'onboarding-brief.md')) === null) process.exit(0);\n"
        "const MARKER = " + marker_json + ";\n"
        "const proposal = read(path.join(lejiDir, 'proposal.md'));\n"
        "let printed = false;\n"
        "if (proposal !== null && proposal.includes(MARKER)) {\n"
        "   let stdin = '';\n"
        "   try { stdin = fs.readFileSync(0, 'utf8'); } catch { /* no hook input */ }\n"
        "   let transcriptPath = null;\n"
        "   try { transcriptPath = JSON.parse(stdin).transcript_path ?? null; } catch { /* not json */ }\n"
        "   const transcript = transcriptPath ? read(transcriptPath) : null;\n"
        "   if (transcript === null) {\n"
        "      printed = true; // no transcript to inspect: the artifact stands as evidence\n"
        "   } else {\n"
        '      // "Printed" means the reply itself carries the proposal: the marker must\n'
        "      // appear in one of the last few assistant text blocks, not in a plan,\n"
        "      // a file diff, or the artifact alone.\n"
        "      const texts = [];\n"
        "      for (const line of transcript.trim().split('\\n')) {\n"
        "         let entry;\n"
        "         try { entry = JSON.parse(line); } catch { continue; }\n"
        "         if (entry.type !== 'assistant') continue;\n"
        "         const chunk = (entry.message?.content ?? [])\n"
        "            .filter((b) => b.type === 'text')\n"
        "            .map((b) => b.text)\n"
        "            .join('\\n');\n"
        "         if (chunk.trim() !== '') texts.push(chunk);\n"
        "      }\n"
        "      printed = texts.slice(-3).some((c) => c.includes(MARKER));\n"
        "   }\n"
        "}\n"
        "if (printed) process.exit(0);\n"
        "console.error(\n"
        "   'Approval blocked by the Leji onboarding guard: write the full proposal to ' +\n"
        "   "
        + leji_json
        + " + '/proposal.md (first line \"' + MARKER + '\"), print that same ' +\n"
        "   'content as plain text in your reply, then retry this question unchanged.',\n"
        ");\n"
        "process.exit(2);\n"
    )


#: What :func:`ensure_approval_guard` did.
GuardAction = str  # "installed" | "unchanged"


def ensure_approval_guard(
    root: str, root_path: str, ignore_context: Optional[LejiIgnoreContext] = None
) -> GuardAction:
    """Write the guard script under the onboarding workspace (`.leji/work/hooks/`)
    and merge its PreToolUse entry into .claude/settings.json (created if absent,
    other settings preserved). Idempotent: an existing guard entry is left untouched.
    ``root_path`` no longer selects the workspace — it is one root-relative tree —
    and is kept only so the exported signature holds. ``ignore_context`` is the
    invocation's notice state for the self-managed `.leji/.gitignore`, which this
    function ensures because it creates `.leji/work/hooks/`; None means a context local
    to this call."""
    del root_path
    root_abs = Path(root).resolve()
    leji_rel = WORK_REL
    script_rel = f"{leji_rel}/hooks/approval-guard.mjs"
    script_abs = root_abs / script_rel
    _assert_no_symlink_escape(root_abs, script_abs, script_rel)

    settings_rel = ".claude/settings.json"
    settings_abs = root_abs / settings_rel
    _assert_no_symlink_escape(root_abs, settings_abs, settings_rel)
    settings: dict[str, object] = {}
    # The settings file is parsed, merged, and written back, so its bytes come from the
    # verified read rather than from the pathname the merge later writes to.
    existing = _read_merge_source(guard_root(str(root_abs)), settings_abs, settings_rel)
    if existing is not None and existing.strip() != "":
        try:
            parsed = json.loads(existing)
        except ValueError:
            parsed = None
        if not isinstance(parsed, dict):
            raise RuntimeError(
                f"{settings_rel} is not valid JSON; fix it before installing the onboarding guard"
            )
        settings = parsed
    hooks = settings.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        hooks = {}
        settings["hooks"] = hooks
    pre = hooks.setdefault("PreToolUse", [])
    if not isinstance(pre, list):
        pre = []
        hooks["PreToolUse"] = pre
    present = any(
        "approval-guard.mjs" in str(h.get("command", ""))
        for e in pre
        if isinstance(e, dict)
        for h in (e.get("hooks") or [])
        if isinstance(h, dict)
    )
    _write_file_atomic(root_abs, script_abs, script_rel, _approval_guard_script(leji_rel))
    # `.leji/work/hooks/` now exists: this is a role establisher like any other.
    _ensure_leji_ignore_or_refuse(str(root_abs), ignore_context)
    if present:
        return "unchanged"
    pre.append(
        {
            "matcher": "AskUserQuestion",
            "hooks": [{"type": "command", "command": f'node "$CLAUDE_PROJECT_DIR/{script_rel}"'}],
        }
    )
    _write_file_atomic(
        root_abs,
        settings_abs,
        settings_rel,
        json.dumps(settings, indent=2, ensure_ascii=False) + "\n",
    )
    return "installed"


@dataclass
class GuardOfferOptions:
    """Options for :func:`offer_approval_guard`: the consent-gated install offer,
    made only when the resolved launch host is Claude Code (the host whose prompt
    pattern the guard counters)."""

    root: str
    root_path: str
    detected: list[DetectedHost]
    interactive: bool
    agent: Optional[str] = None
    io: Optional[HandoffIO] = None
    #: The invocation's notice state for the self-managed ``.leji/.gitignore``, passed
    #: through to the install this offer nests.
    ignore_context: Optional[LejiIgnoreContext] = None


def offer_approval_guard(opts: GuardOfferOptions) -> None:
    """Offer the onboarding approval guard for a Claude Code handoff. Silent when
    non-interactive or the host is not Claude Code; says so when already installed
    (a silent skip is indistinguishable from broken)."""
    if not opts.interactive:
        return
    host_id: Optional[str] = None
    if opts.agent:
        host_id = resolve_host_id(opts.agent)
    else:
        hosts = _prompt_capable_hosts(opts.detected)
        if len(hosts) == 1:
            host_id = hosts[0].id
        elif len(hosts) > 1 and any(h.id == "claude-code" for h in hosts):
            host_id = "claude-code"
    if host_id != "claude-code":
        return
    io = opts.io or _default_handoff_io()
    answer = io.read_line(
        "Add the temporary onboarding guard for Claude Code, in this repository only? "
        "It has the agent print its proposal before asking for approval. Writes two "
        "project-local files (a hook entry in this repo’s .claude/settings.json, "
        "a script in the gitignored .leji/work/ workspace); nothing outside this repository "
        "is touched, and the finalize step removes both",
        "Y/n",
    ).lower()
    if answer not in ("", "y", "yes"):
        return
    action = ensure_approval_guard(opts.root, opts.root_path, opts.ignore_context)
    print(
        "Onboarding guard added (this repository only: .claude/settings.json hook + "
        ".leji/work/hooks/approval-guard.mjs; removed at finalize)."
        if action == "installed"
        else "Onboarding guard already present in this repository; refreshed the script."
    )


# --- start (enter an existing layer) ---

# Outcome of `enter_layer`: an agent launched cleanly, fell back to the printed
# commands (nothing to launch), or the boot profile is missing/invalid.
StartOutcome = str  # "launched" | "fallback" | "boot-missing"


@dataclass
class StartOptions:
    """Options for :func:`enter_layer` (the `leji start` command)."""

    root: str
    manifest: Manifest
    detected: list[DetectedHost]
    # --agent: force a specific launchable host (claude-code/codex); empty/None detects.
    agent: Optional[str] = None
    # A real TTY and not --yes; required to launch an interactive agent.
    interactive: bool = False
    # Extra arguments passed verbatim to the launched host binary, before the
    # prompt (from `leji start -- <flags>`, e.g. Claude Code's --chrome).
    host_args: Optional[list[str]] = None
    io: Optional[HandoffIO] = None
    # The host the caller already resolved, so the preflight report can name it before
    # the launch takes the terminal. Used only when ``host_resolved`` is True;
    # otherwise :func:`enter_layer` resolves one itself, as before. A None ``host``
    # with ``host_resolved`` True is an explicit "no host", which falls back to the
    # printed commands.
    host: Optional[StartHost] = None
    host_resolved: bool = False


def boot_profile_ready(root: str, manifest: Manifest) -> bool:
    """Whether the manifest's boot profile is a safe relative path that actually
    exists: the one condition `leji start` refuses to run under, checked before
    anything is reported or launched."""
    boot_rel = manifest["bootProfilePath"]
    return bool(_REL_PATH_RE.match(boot_rel)) and os.path.isfile(
        os.path.join(os.path.abspath(root), boot_rel)
    )


def resolve_start_host(
    detected: list[DetectedHost],
    agent: Optional[str] = None,
    interactive: bool = False,
    io: Optional[HandoffIO] = None,
) -> Optional[StartHost]:
    """Which host `leji start` targets: ``--agent`` forces one, a single detected
    prompt-capable host is it, and several ask (interactive only). Split out of
    :func:`enter_layer` so the preflight can report on the host this run has actually
    selected. Raises on an unknown or non-launchable ``--agent``, as before."""
    if agent:
        return _exported(_assert_agent_host(agent))
    hosts = _prompt_capable_hosts(detected)
    if len(hosts) == 1:
        return _exported(hosts[0])
    if len(hosts) > 1 and interactive:
        return _exported(_pick_from_multiple(hosts, io or _default_handoff_io()))
    return None


def start_hosts(detected: list[DetectedHost]) -> list[StartHost]:
    """The detected hosts `leji start` could launch, ranked — what the preflight names
    when several are present and none was picked."""
    return [h for h in (_exported(p) for p in _prompt_capable_hosts(detected)) if h is not None]


def _boot_prompt(boot_rel: str) -> str:
    """The prompt `leji start` hands the agent: point it at the boot profile."""
    return f"Read ./{boot_rel}, follow it, and tell me when you're ready."


def enter_layer(opts: StartOptions) -> StartOutcome:
    """`leji start`: boot a coding agent into an existing layer, pointed at the boot
    profile. One host launches directly; several prompt; --agent forces a launchable
    host. Launches from the layer root so the relative boot path resolves. Returns
    'launched' on a clean run, 'fallback' when nothing launches (no host, non-interactive,
    or launch failed), or 'boot-missing' when the boot path is unsafe or absent. Raises on
    an unknown/non-launchable --agent (usage error → exit 2)."""
    root = os.path.abspath(opts.root)
    if not boot_profile_ready(root, opts.manifest):
        return "boot-missing"
    io = opts.io or _default_handoff_io()
    prompt_arg = _boot_prompt(opts.manifest["bootProfilePath"])

    # A caller that already resolved the host (the preflight names it before the
    # launch) passes it in; otherwise it is resolved here, as before.
    if opts.host_resolved:
        host = _internal(opts.host)
    else:
        host = _internal(resolve_start_host(opts.detected, opts.agent, opts.interactive, io))

    if host is None or not opts.interactive:
        return "fallback"
    return "launched" if _launch_host(host, prompt_arg, io, root, opts.host_args) else "fallback"


def entering_via_boot(manifest: Manifest, host_args: Optional[list[str]] = None) -> str:
    """Printed when `leji start` launches nothing (no agent, non-interactive, or a
    failed launch): the copy-paste commands to enter the layer via the boot
    profile."""
    prompt_arg = _boot_prompt(manifest["bootProfilePath"])
    # Host flags the user asked for (leji start -- <flags>) stay in the printed
    # commands, so the copy-paste path launches what the direct path would have.
    flags_shown = f"{' '.join(host_args)} " if host_args else ""
    return "\n".join(
        [
            "",
            "No coding agent was launched. To enter this context layer, run one of:",
            "",
            f'   claude {flags_shown}"{prompt_arg}"',
            f'   codex {flags_shown}"{prompt_arg}"',
            "",
            "Each points the agent at the boot profile, which loads the team context before any work.",
        ]
    )
