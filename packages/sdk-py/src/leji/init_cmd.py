"""Interactive bootstrap of a context layer from the vendored templates."""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from .detect import HOST_SPECS, DetectedHost, adapter_content, detect_hosts, resolve_host_id
from .fsx import resolved_within_root
from .gitutil import working_tree_clean
from .indexgen import write_index
from .manifest import (
    Manifest,
    bind_agent_in_manifest_text,
    effective_agent_profiles_path,
    effective_changelog_path,
    effective_index_path,
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
    """Validate ``rel`` against the schema rule and assert the lexically
    resolved target stays under ``root``. Raises InitPathError otherwise.

    Resolution is purely lexical (it does not follow symlinks); a symlinked
    ancestor that escapes root is caught separately by
    :func:`_assert_no_symlink_escape`, mirroring the Node split between
    ``safeResolve`` and ``resolvedWithinRoot``."""
    _reject_unsafe_rel(rel, what)
    target = Path(os.path.normpath(root / rel))
    if target != root and not target.is_relative_to(root):
        raise InitPathError(f"{what} {rel!r} resolves outside the target directory")
    return target


_CATEGORY_PURPOSE = {
    "domain": "what our core terms mean",
    "system": "architecture and the invariants every change lives with",
    "practice": "conventions and patterns applied automatically",
    "governance": "agent guardrails and operating rules",
    "decisions": "why things are the way they are (check before proposing a reversal)",
}


@dataclass
class InitAnswers:
    name: str
    description: str
    root_path: str
    owner_name: str
    owner_contact: str
    categories: list[str]
    level: str


@dataclass
class InitResult:
    written: list[str] = field(default_factory=list)
    manifest: Manifest = field(default_factory=dict)
    # The classified write plan (always populated; the only output under dry_run).
    plan: list[PlanEntry] = field(default_factory=list)
    dry_run: bool = False
    # Coding-agent hosts detected for this repo, ranked; informs the handoff offer.
    detected: list[DetectedHost] = field(default_factory=list)


def _git_config(key: str) -> Optional[str]:
    try:
        out = subprocess.run(
            ["git", "config", "--get", key], capture_output=True, text=True, check=True
        ).stdout.strip()
        return out or None
    except (subprocess.CalledProcessError, OSError):
        return None


def _default_answers(directory: str, name: Optional[str], level: Optional[str]) -> InitAnswers:
    base = re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", Path(directory).resolve().name.lower()))
    return InitAnswers(
        name=name or f"{base}-context",
        description="Shared context layer for this repository.",
        root_path="docs/",
        owner_name=_git_config("user.name") or "<named owner>",
        owner_contact=_git_config("user.email") or "",
        categories=["domain", "system", "decisions"],
        level=level or "core",
    )


def _prompt(directory: str, name: Optional[str], level: Optional[str]) -> InitAnswers:
    defaults = _default_answers(directory, name, level)

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
    root_path = ask("Context root", defaults.root_path)
    if not root_path.endswith("/"):
        root_path += "/"
    owner_name = ask("Primary owner (name)", defaults.owner_name)
    owner_contact = ask("Primary owner (contact)", defaults.owner_contact)

    categories: list[str] = []
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

    indexed = ask_yes_no("Generate the machine index and changelog now (indexed level)?", False)
    return InitAnswers(
        name=answers_name,
        description=description,
        root_path=root_path,
        owner_name=owner_name,
        owner_contact=owner_contact,
        categories=categories,
        level="indexed" if indexed else "core",
    )


def _read_template(name: str) -> str:
    return (templates_dir() / name).read_text(encoding="utf-8")


def _assert_no_symlink_escape(root: Path, abs_path: Path, rel: str) -> None:
    """Refuse a write whose resolved path (following symlinks, including a
    not-yet-existing target under a symlinked ancestor) escapes ``root``."""
    if not resolved_within_root(str(root), abs_path):
        raise InitPathError(f'refusing to write through a symlink that escapes the target: "{rel}"')


def _write_manifest_exclusive(abs_path: Path, content: str, mode: str) -> None:
    """Create leji.json with O_EXCL ("x") so the entry point's existence check and
    the write are atomic: a concurrent run, or a symlink planted between check and
    write, cannot be overwritten or followed. FileExistsError is surfaced as the
    same "already exists" error each entry point uses for its initial guard."""
    try:
        with open(abs_path, "x", encoding="utf-8") as f:
            f.write(content)
    except FileExistsError as e:
        if mode == "adopt":
            raise RuntimeError(
                "leji.json already exists here; this repository already has a Leji layer"
            ) from e
        raise RuntimeError(
            "leji.json already exists here; init refuses to overwrite an existing layer"
        ) from e


def _ensure_leji_gitignored(root_abs: Path) -> None:
    """Ensure the repository-root .gitignore ignores `.leji/` (the generated viewer
    and the transient onboarding brief, neither of which belongs in version control).
    Idempotent: creates the file if absent, appends the line (adding a leading newline
    when the file lacks a trailing one) only when the exact line is not already
    present. Matches the line exactly, so it never treats a comment or `docs/.leji/`
    as equivalent."""
    abs_path = root_abs / ".gitignore"
    entry = ".leji/"
    text = abs_path.read_text(encoding="utf-8") if abs_path.is_file() else ""
    if entry in text.split("\n"):
        return
    if text == "":
        abs_path.write_text(entry + "\n", encoding="utf-8")
    else:
        abs_path.write_text(
            text + ("" if text.endswith("\n") else "\n") + entry + "\n", encoding="utf-8"
        )


def _write_file_once(root: Path, rel: str, content: str, written: list[str]) -> None:
    abs_path = _safe_target(root, rel, "write path")
    _assert_no_symlink_escape(root, abs_path, rel)
    if abs_path.exists():
        return
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    abs_path.write_text(content, encoding="utf-8")
    written.append(rel)


def _category_stub(title: str, summary: str, body: str) -> str:
    return f"---\nsummary: {summary}\n---\n\n# {title}\n\n{body}"


def _build_manifest(answers: InitAnswers) -> Manifest:
    template = json.loads(_read_template("leji.json"))
    r = answers.root_path
    manifest: Manifest = {
        "$schema": template.get("$schema"),
        "leji": "1.0",
        "name": answers.name,
        "description": answers.description,
        "rootPath": r,
        "bootProfilePath": f"{r}boot-profile.md",
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
    # No `machine` block: every machine-surface path resolves to its spec
    # default under rootPath/, so init writes a minimal leji.json and the
    # resolvers (effective_*_path) find the files at their default locations.
    for category in answers.categories:
        manifest["categories"][category] = {"paths": [f"{r}{category}/"]}
    return manifest


def _build_boot_profile(answers: InitAnswers) -> str:
    text = _read_template("boot-profile.md")
    # The template speaks in docs/ defaults; rewrite for the chosen root.
    if answers.root_path != "docs/":
        text = text.replace("docs/", answers.root_path)
    text = text.replace(
        "<One paragraph: what this repository/product is, who it serves, what stage it is at.>",
        answers.description,
    )
    r = answers.root_path

    load_lines = "\n".join(f"- `{r}{c}/`: {_CATEGORY_PURPOSE[c]}" for c in answers.categories)
    text = re.sub(
        r"- `[^`]+domain/`[^\n]*\n- `[^`]+system/`[^\n]*\n- `[^`]+decisions/`[^\n]*",
        load_lines,
        text,
    )

    if answers.level == "core":
        text = re.sub(r"\nThe generated map of this layer is `[^`]+`\.\n", "\n", text)
        text = re.sub(r"- Append an entry to `[^`]+context-changelog\.json`[^\n]*\n", "", text)
        text = re.sub(r"- Regenerate `[^`]+context-index\.json`[^\n]*\n", "", text)
    return text


def _build_core_profile(answers: InitAnswers) -> str:
    text = _read_template("agents/core.md")
    if answers.root_path != "docs/":
        text = text.replace("docs/", answers.root_path)
    if "governance" not in answers.categories:
        text = re.sub(
            r"^ {2}- .*governance/\n",
            f"  - {answers.root_path}decisions/\n",
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

Engineering knowledge lived in heads, chat threads, and per-tool config files. People and agents had no single place to read how this team thinks.

## Decision

Adopt Leji at the `{answers.level}` level: {indexed_line}.

## Consequences

Vendor config files become one-line redirects. Context fixes ride the same review gate as the work that surfaces them. {answers.owner_name} owns the layer.
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
    """The transient onboarding brief, rewritten for the chosen root."""
    return _read_template("onboarding-brief.md").replace("<root>/", answers.root_path)


def brief_path(root_path: str) -> str:
    """Path of the transient onboarding brief, under a dot-directory so it is
    excluded from the index, the viewer, and the changelog."""
    return f"{root_path}.leji/onboarding-brief.md"


#: The CI workflow paths, relative to the repository root.
CI_WORKFLOW_PATH = ".github/workflows/leji.yml"
GITLAB_CI_PATH = ".gitlab-ci.yml"
CIRCLECI_CONFIG_PATH = ".circleci/config.yml"
AZURE_PIPELINE_PATH = ".azure-pipelines/leji.yml"

_GITLAB_MARKER_START = "# >>> leji ci (managed) >>>"
_GITLAB_MARKER_END = "# <<< leji ci (managed) <<<"

# Azure Pipelines does not auto-discover a YAML file (unlike the other three), so
# the file is written but the pipeline still has to be created in Azure DevOps.
AZURE_ACTIVATION_NOTE = (
    "Azure Pipelines does not auto-run this file. Create a pipeline that points at "
    "it (e.g. `az pipelines create --yml-path .azure-pipelines/leji.yml`), and on "
    "Azure Repos add a build-validation branch policy on main for pull-request checks."
)

#: The CI providers targeted by ``leji ci``.
CiProvider = str
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


def build_github_workflow() -> str:
    """The GitHub Actions workflow: a standalone file under .github/workflows/."""
    return (
        "name: leji\n"
        "on: [push, pull_request]\n"
        "jobs:\n"
        "  validate:\n"
        "    runs-on: ubuntu-latest\n"
        "    steps:\n"
        "      - uses: actions/checkout@v4\n"
        "      - uses: actions/setup-node@v4\n"
        "        with:\n"
        "          node-version: '22'\n"
        "      - run: npx -y @leji-org/leji@latest validate\n"
    )


def build_gitlab_block() -> str:
    """The GitLab CI marker-delimited job merged into the shared .gitlab-ci.yml."""
    return (
        f"{_GITLAB_MARKER_START}\n"
        "leji-validate:\n"
        "  image: node:22\n"
        "  script:\n"
        "    - npx -y @leji-org/leji@latest validate\n"
        f"{_GITLAB_MARKER_END}\n"
    )


def build_circleci_config() -> str:
    """The CircleCI config written when .circleci/config.yml is absent."""
    return (
        "version: 2.1\n"
        "jobs:\n"
        "  leji-validate:\n"
        "    docker:\n"
        "      - image: node:22\n"
        "    steps:\n"
        "      - checkout\n"
        "      - run: npx -y @leji-org/leji@latest validate\n"
        "workflows:\n"
        "  leji:\n"
        "    jobs:\n"
        "      - leji-validate\n"
    )


def build_circleci_snippet() -> str:
    """The jobs + workflows fragment to add by hand to an existing CircleCI config."""
    return (
        "jobs:\n"
        "  leji-validate:\n"
        "    docker:\n"
        "      - image: node:22\n"
        "    steps:\n"
        "      - checkout\n"
        "      - run: npx -y @leji-org/leji@latest validate\n"
        "workflows:\n"
        "  leji:\n"
        "    jobs:\n"
        "      - leji-validate\n"
    )


def build_azure_pipeline() -> str:
    """The Azure Pipelines config: a dedicated .azure-pipelines/leji.yml the user wires to a pipeline."""
    return (
        "trigger:\n"
        "  - main\n"
        "pool:\n"
        "  vmImage: ubuntu-latest\n"
        "steps:\n"
        "  - task: NodeTool@0\n"
        "    inputs:\n"
        "      versionSpec: '22.x'\n"
        "  - script: npx -y @leji-org/leji@latest validate\n"
        "    displayName: leji validate\n"
    )


def _managed_block_span(text: str) -> tuple[int, int] | None:
    """The ``[start, end)`` span of the first managed block in ``text``, or ``None`` if none."""
    start = text.find(_GITLAB_MARKER_START)
    if start == -1:
        return None
    end_marker = text.find(_GITLAB_MARKER_END, start)
    if end_marker == -1:
        return None
    nl = text.find("\n", end_marker)
    end = len(text) if nl == -1 else nl + 1
    return (start, end)


def _strip_managed_blocks(text: str) -> str:
    """Remove every managed block from ``text`` (drops duplicates left after the first)."""
    out: list[str] = []
    rest = text
    while True:
        span = _managed_block_span(rest)
        if span is None:
            out.append(rest)
            return "".join(out)
        start, end = span
        out.append(rest[:start])
        rest = rest[end:]


def _merge_gitlab_block(text: str, block: str) -> str:
    """Insert/replace the managed block in an existing ``.gitlab-ci.yml``, byte-exactly.
    Replaces the first managed block and drops any later duplicate managed blocks, so
    the file is left with exactly one."""
    span = _managed_block_span(text)
    if span is not None:
        start, end = span
        return text[:start] + block + _strip_managed_blocks(text[end:])
    if text == "":
        return block
    return text + ("\n" if text.endswith("\n") else "\n\n") + block


def _write_failure_message(rel: str, e: OSError) -> str:
    """A deterministic, OS-text-free message for a failed CI-file write, keeping stderr
    byte-identical across the Node, Go, and Python SDKs."""
    if isinstance(e, PermissionError):
        return f'cannot write "{rel}": permission denied'
    return f'cannot write "{rel}"'


def _write_file_atomic(root_abs: Path, abs_path: Path, rel: str, contents: str) -> None:
    """Write ``contents`` to ``abs_path`` atomically: a sibling temp file, then a rename
    over the target, so an interrupted or failed write can never leave a partial file.
    On any failure the temp file is removed (no repo-visible artifact) and a deterministic,
    OS-text-free InitPathError is raised so the three SDKs report I/O failures byte-identically."""
    tmp = abs_path.with_name(abs_path.name + ".leji-tmp")
    # The sibling temp path must not escape the root either (a planted
    # ``<target>.leji-tmp`` symlink would otherwise be written through before the rename).
    _assert_no_symlink_escape(root_abs, tmp, rel)
    try:
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(contents, encoding="utf-8")
        _maybe_inject_write_failure()
        tmp.replace(abs_path)
    except OSError as e:
        tmp.unlink(missing_ok=True)
        raise InitPathError(_write_failure_message(rel, e)) from e


def _maybe_inject_write_failure() -> None:
    """Test-only fault injection: when LEJI_TEST_FAIL_RENAME is set, simulate a write that
    fails after the temp file exists but before the rename commits, so the cleanup and
    normalized-error path can be exercised identically across the three SDKs."""
    if os.environ.get("LEJI_TEST_FAIL_RENAME"):
        raise OSError("injected write failure")


# Legacy aliases retained for any external callers of the original single-provider API.
build_ci_workflow = build_github_workflow


def ensure_ci_workflow(root: str, provider: str) -> CiResult:
    """Add a CI workflow that runs ``leji validate`` on every change (the ``leji ci``
    command), so CI can be added to a layer created without it. GitHub gets its own
    workflow file; GitLab is create-or-merge into the shared ``.gitlab-ci.yml`` via a
    marker-delimited managed block; CircleCI is created if absent, else left untouched
    (a snippet to add by hand is returned). All operations are deterministic text, so
    the three reference SDKs stay byte-identical. Refuses a symlink that escapes root."""
    root_abs = Path(root).resolve()
    if provider == "github":
        abs_path = root_abs / CI_WORKFLOW_PATH
        _assert_no_symlink_escape(root_abs, abs_path, CI_WORKFLOW_PATH)
        if abs_path.exists():
            return CiResult(provider=provider, path=CI_WORKFLOW_PATH, action="unchanged")
        _write_file_atomic(root_abs, abs_path, CI_WORKFLOW_PATH, build_github_workflow())
        return CiResult(provider=provider, path=CI_WORKFLOW_PATH, action="created")
    if provider == "gitlab":
        abs_path = root_abs / GITLAB_CI_PATH
        _assert_no_symlink_escape(root_abs, abs_path, GITLAB_CI_PATH)
        block = build_gitlab_block()
        if not abs_path.exists():
            _write_file_atomic(root_abs, abs_path, GITLAB_CI_PATH, block)
            return CiResult(provider=provider, path=GITLAB_CI_PATH, action="created")
        text = abs_path.read_text(encoding="utf-8")
        merged = _merge_gitlab_block(text, block)
        if merged == text:
            return CiResult(provider=provider, path=GITLAB_CI_PATH, action="unchanged")
        _write_file_atomic(root_abs, abs_path, GITLAB_CI_PATH, merged)
        return CiResult(provider=provider, path=GITLAB_CI_PATH, action="updated")
    if provider == "circleci":
        abs_path = root_abs / CIRCLECI_CONFIG_PATH
        _assert_no_symlink_escape(root_abs, abs_path, CIRCLECI_CONFIG_PATH)
        if abs_path.exists():
            return CiResult(
                provider=provider,
                path=CIRCLECI_CONFIG_PATH,
                action="manual",
                snippet=build_circleci_snippet(),
            )
        _write_file_atomic(root_abs, abs_path, CIRCLECI_CONFIG_PATH, build_circleci_config())
        return CiResult(provider=provider, path=CIRCLECI_CONFIG_PATH, action="created")
    if provider != "azure":
        # Unreachable from the CLI (it validates first); guards direct helper callers so
        # an unknown provider errors consistently across the three SDKs.
        raise InitPathError(f'unknown provider "{provider}"')
    # azure
    abs_path = root_abs / AZURE_PIPELINE_PATH
    _assert_no_symlink_escape(root_abs, abs_path, AZURE_PIPELINE_PATH)
    # The activation note is intentionally created-only: a re-run on an existing
    # pipeline file stays quiet (no note) rather than repeating the setup guidance.
    if abs_path.exists():
        return CiResult(provider=provider, path=AZURE_PIPELINE_PATH, action="unchanged")
    _write_file_atomic(root_abs, abs_path, AZURE_PIPELINE_PATH, build_azure_pipeline())
    return CiResult(
        provider=provider,
        path=AZURE_PIPELINE_PATH,
        action="created",
        note=AZURE_ACTIVATION_NOTE,
    )


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
    """A starter agent profile for a named agent. The body is keyed off the role:
    ``reviewer`` (the default) keeps the review-focused posture; any other role
    gets a neutral template the author fills in. ``host`` is optional: it is
    omitted for a host-agnostic resident agent. The frontmatter satisfies the
    agent-profile schema (id/name/role/requiredRead/mustAskWhen)."""
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
  - {root_path}boot-profile.md
  - {root_path}agents/core.md
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
  - {root_path}boot-profile.md
  - {root_path}agents/core.md
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


@dataclass
class AgentResult:
    """What :func:`add_agent` did, for the command to report. Each artifact is
    independently idempotent: a ``*_created``/``manifest_changed`` of False means
    it was already there."""

    name: str
    role: str
    host_id: Optional[str]  # None for a host-agnostic resident agent (no --host)
    profile_path: str
    profile_created: bool
    manifest_changed: bool


def add_agent(
    root: str,
    manifest: Manifest,
    host: Optional[str],
    name: str,
    role: Optional[str] = None,
) -> AgentResult:
    """Wire a named agent into an existing layer (the ``leji agent`` command):
    write a starter profile under the agent-profiles path and bind the agent in
    leji.json via an in-place text edit that preserves the rest of the file.
    --host is optional: a host pins the profile to a specific external CLI; with
    none, this is a host-agnostic resident agent any host can run. Either way we
    never write a vendor file; those are migrated from an existing entrypoint,
    never created. Never overwrites an existing profile; re-running is a no-op."""
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
    profile_created = False
    if not profile_abs.is_file():
        _assert_no_symlink_escape(root_abs, profile_abs, profile_rel)
        profile_abs.parent.mkdir(parents=True, exist_ok=True)
        profile_abs.write_text(
            build_agent_profile(name, role, host_id, manifest["rootPath"]), encoding="utf-8"
        )
        profile_created = True

    manifest_abs = root_abs / "leji.json"
    original = manifest_abs.read_text(encoding="utf-8")
    text, _ = bind_agent_in_manifest_text(original, name, profile_rel)
    manifest_changed = text != original
    if manifest_changed:
        manifest_abs.write_text(text, encoding="utf-8")

    return AgentResult(
        name=name,
        role=role,
        host_id=host_id,
        profile_path=profile_rel,
        profile_created=profile_created,
        manifest_changed=manifest_changed,
    )


def _assert_clean_working_tree(root: str) -> None:
    """Refuse to mutate a dirty working tree. init/adopt write (and adopt moves)
    many files; the "git restore cleanly undoes Leji's writes" safety net only holds
    if the tree was clean to begin with, so a dirty tree is refused outright rather
    than entangling Leji's writes with the user's uncommitted work. A non-git
    directory has no such net and is allowed: that is how a fresh layer is
    bootstrapped before ``git init``. Callers skip this under dry_run."""
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
) -> InitResult:
    """Bootstrap a context layer. Interactive unless ``yes``. Refuses to run
    when leji.json already exists; never overwrites existing files."""
    root = Path(directory).resolve()
    if (root / "leji.json").exists():
        raise RuntimeError(
            "leji.json already exists here; init refuses to overwrite an existing layer"
        )
    if not dry_run:
        _assert_clean_working_tree(str(root))
    detected = detect_hosts(str(root))
    answers = _default_answers(directory, name, level) if yes else _prompt(directory, name, level)
    # Validate the chosen root and every derived write path against the schema
    # relative-path rule and assert containment, BEFORE writing anything.
    _reject_unsafe_rel(answers.root_path, "context root")
    _safe_target(root, answers.root_path, "context root")
    manifest = _build_manifest(answers)
    for key in ("bootProfilePath",):
        _safe_target(root, manifest[key], f"manifest.{key}")
    for category in answers.categories:
        for cpath in manifest["categories"][category]["paths"]:
            _safe_target(root, cpath, f"categories.{category}")
    r = answers.root_path

    # Assemble the files init owns, in write order. leji.json comes first so the
    # overwrite guard is effective on a retry after an interrupted run.
    writes: list[PlannedWrite] = [
        PlannedWrite("leji.json", json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    ]
    writes.append(PlannedWrite(manifest["bootProfilePath"], _build_boot_profile(answers)))
    for category in answers.categories:
        if category == "decisions":
            continue
        stub = CATEGORY_STUBS[category]
        writes.append(
            PlannedWrite(
                f"{r}{category}/{stub['file']}",
                _category_stub(stub["title"], stub["summary"], stub["body"]),
            )
        )
    writes.append(PlannedWrite(f"{r}decisions/0001-adopt-leji.md", _build_first_decision(answers)))
    writes.append(PlannedWrite(f"{r}agents/core.md", _build_core_profile(answers)))
    writes.append(PlannedWrite(brief_path(r), _build_brief(answers)))
    if answers.level == "indexed":
        # The changelog records the paths seeded; compute from the planned set
        # (everything except the changelog and the generated index).
        seeded = sorted(w.rel for w in writes)
        writes.append(
            PlannedWrite(effective_changelog_path(manifest), _build_changelog(answers, seeded))
        )

    # Foreign entrypoint files Leji detects but will never modify.
    wont_modify = [rel for rel in KNOWN_VENDOR_FILES if (root / rel).is_file()]
    index_rel = effective_index_path(manifest) if answers.level == "indexed" else None
    plan_writes = [*writes, PlannedWrite(index_rel, "")] if index_rel else writes
    plan = build_write_plan(str(root), plan_writes, wont_modify)

    if dry_run:
        return InitResult(written=[], manifest=manifest, plan=plan, dry_run=True, detected=detected)

    written: list[str] = []
    root.mkdir(parents=True, exist_ok=True)
    # leji.json is created exclusively ("x" / O_EXCL): it closes the check-then-write
    # race and refuses to follow a symlink at the final component, so a concurrent
    # init or a planted symlink cannot be overwritten or escaped.
    _assert_no_symlink_escape(root, root / "leji.json", "leji.json")
    _write_manifest_exclusive(root / "leji.json", writes[0].content, "init")
    written.append("leji.json")
    for w in writes[1:]:
        _write_file_once(root, w.rel, w.content, written)

    if answers.level == "indexed":
        write_index(str(root), manifest)
        written.append(effective_index_path(manifest))
    _ensure_leji_gitignored(root)

    return InitResult(
        written=sorted(written), manifest=manifest, plan=plan, dry_run=False, detected=detected
    )


# --- adoption (existing repositories) ---

DOCS_CANDIDATES = ["docs/", "doc/", "documentation/"]


def _read_text(path: Path) -> str:
    """Vendor-file contents, or empty string when the file cannot be read."""
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


@dataclass
class AdoptResult(InitResult):
    detected_root: str = ""
    # Vendor files whose content was migrated into the layer.
    migrated: list[str] = field(default_factory=list)
    # A non-redirecting vendor file remains, so the layer is not yet
    # core-conformant.
    draft: bool = False


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
    # Wrap the migrated content in a fenced code block so raw HTML/Markdown is
    # shown verbatim, never rendered: the fenced migration cannot inject script into
    # the Docsify preview. (That preview is a local, trusted-content viewer, not a
    # sandbox; other layer documents are still rendered as authored.)
    # The fence is one backtick longer than the longest run in the content.
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

Its content was migrated into the layer (see `{answers.root_path}governance/`). The original file(s) were left unchanged; converting them to one-line redirects is a separate, consented step (`leji adopt --wire-adapters`).

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
) -> AdoptResult:
    """Bring Leji into an existing repository: reuse an existing docs root,
    migrate the content of any vendor entrypoints into the layer (originals
    untouched), and seed the standard scaffold. Refuses when a layer already
    exists. With ``wire_adapters``, converts the present entrypoints to
    redirects (a consented overwrite, after their content has been migrated);
    otherwise the result is an adoption draft that is not yet core-conformant."""
    root = Path(directory).resolve()
    if (root / "leji.json").exists():
        raise RuntimeError(
            "leji.json already exists here; this repository already has a Leji layer"
        )
    if not dry_run:
        _assert_clean_working_tree(str(root))
    detected = detect_hosts(str(root))
    detected_root = next((d for d in DOCS_CANDIDATES if (root / d).is_dir()), "docs/")
    _reject_unsafe_rel(detected_root, "context root")

    boot_rel = f"{detected_root}boot-profile.md"
    canonical_redirect = adapter_content(boot_rel).strip()
    # A vendor file that is a symlink resolving outside root is neither read,
    # migrated, nor converted: it is treated as absent.
    vendor_present = [
        rel
        for rel in KNOWN_VENDOR_FILES
        if (root / rel).is_file() and resolved_within_root(str(root), root / rel)
    ]
    # Migrate any vendor file that is not already exactly Leji's redirect, so its
    # content (whether on its own lines or sharing a line with the boot-path
    # reference) is archived before --wire-adapters overwrites it. A file that is
    # already the canonical redirect, or empty, has nothing to preserve.
    to_migrate = [
        rel
        for rel in vendor_present
        if _read_text(root / rel).strip() not in ("", canonical_redirect)
    ]

    base = re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", root.name.lower()))
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
        categories=categories,
        level="core",
    )

    manifest = _build_manifest(answers)
    r = answers.root_path

    # Convert only EXISTING vendor entrypoints (never create new ones) that aren't
    # already the canonical redirect; each has been captured in to_migrate above, so
    # the overwrite never loses content.
    to_convert = (
        [rel for rel in vendor_present if _read_text(root / rel).strip() != canonical_redirect]
        if wire_adapters
        else []
    )
    if to_convert:
        manifest["vendorAdapters"] = to_convert

    writes: list[PlannedWrite] = [
        PlannedWrite("leji.json", json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    ]
    writes.append(PlannedWrite(manifest["bootProfilePath"], _build_boot_profile(answers)))
    for category in answers.categories:
        if category == "decisions":
            continue
        stub = CATEGORY_STUBS[category]
        writes.append(
            PlannedWrite(
                f"{r}{category}/{stub['file']}",
                _category_stub(stub["title"], stub["summary"], stub["body"]),
            )
        )
    writes.append(PlannedWrite(f"{r}decisions/0001-adopt-leji.md", _build_first_decision(answers)))
    writes.append(PlannedWrite(f"{r}agents/core.md", _build_core_profile(answers)))
    writes.append(PlannedWrite(brief_path(r), _build_brief(answers)))

    migrated: list[str] = []
    used_slugs: set[str] = set()
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
        # Disambiguate when two source files would collide on the same slug.
        slug = base_slug
        n = 2
        while slug in used_slugs:
            slug = f"{base_slug}-{n}"
            n += 1
        used_slugs.add(slug)
        writes.append(
            PlannedWrite(
                f"{r}governance/imported-{slug}.md",
                _migration_doc(rel, _read_text(root / rel)),
            )
        )
        migrated.append(rel)
    if migrated:
        writes.append(
            PlannedWrite(
                f"{r}decisions/0002-adopt-existing-agent-context.md",
                _adopt_existing_decision(answers, migrated),
            )
        )

    for rel in to_convert:
        writes.append(PlannedWrite(rel, adapter_content(manifest["bootProfilePath"])))

    wont_modify = [rel for rel in vendor_present if rel not in to_convert]
    plan = build_write_plan(str(root), writes, wont_modify, to_convert)
    draft = any(boot_rel not in _read_text(root / rel) for rel in wont_modify)

    if dry_run:
        return AdoptResult(
            written=[],
            manifest=manifest,
            plan=plan,
            dry_run=True,
            detected=detected,
            detected_root=detected_root,
            migrated=migrated,
            draft=draft,
        )

    written: list[str] = []
    root.mkdir(parents=True, exist_ok=True)
    _assert_no_symlink_escape(root, root / "leji.json", "leji.json")
    _write_manifest_exclusive(root / "leji.json", writes[0].content, "adopt")
    written.append("leji.json")
    convert = set(to_convert)
    for w in writes[1:]:
        if w.rel in convert:
            abs_path = _safe_target(root, w.rel, "write path")
            _assert_no_symlink_escape(root, abs_path, w.rel)
            abs_path.write_text(w.content, encoding="utf-8")
            written.append(w.rel)
        else:
            _write_file_once(root, w.rel, w.content, written)
    _ensure_leji_gitignored(root)

    return AdoptResult(
        written=sorted(written),
        manifest=manifest,
        plan=plan,
        dry_run=False,
        detected=detected,
        detected_root=detected_root,
        migrated=migrated,
        draft=draft,
    )


def entering_adopted(result: AdoptResult) -> str:
    """Post-adopt guidance, printed by the CLI."""
    lines = [entering_the_layer(result.manifest)]
    if result.migrated:
        lines.extend(
            [
                "",
                f"Migrated {', '.join(result.migrated)} into {result.manifest['rootPath']}governance/ "
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


# --- handoff offer (post-scaffold) ---

# CLI hosts that accept an inline prompt argument, so Leji can launch the handoff
# for the user (`claude "..."`, `codex "..."`). Directory-style IDE hosts (Cursor,
# Windsurf) and prompt syntaxes we have not verified (Gemini) are deliberately left
# out; when only those are present the offer is skipped and the printed
# instructions stand. Mirrors the two commands documented in entering_the_layer.
PROMPT_HOST_IDS = ("claude-code", "codex")


@dataclass
class LaunchResult:
    """Outcome of spawning an agent: ``started`` is False when the process never
    started (e.g. binary not found); a non-None ``error`` with ``started`` True
    means it ran but did not finish cleanly (non-zero exit or signal)."""

    started: bool
    error: Optional[str] = None


@dataclass
class HandoffIO:
    """Injectable I/O for the handoff offer, so the interactive flow (prompting
    and launching a child process) is deterministically testable."""

    read_line: Callable[[str, str], str]
    # launch(bin, prompt_arg, cwd): cwd anchors the agent at the layer root so a
    # relative prompt path resolves (matters for `leji start --root <dir>`); a
    # None cwd uses the current directory.
    launch: Callable[[str, str, Optional[str]], LaunchResult]


@dataclass
class _PromptHost:
    id: str
    bin: str
    name: str


def _default_handoff_io() -> HandoffIO:
    """Real handoff I/O: a stdin prompt and a stdio-inherit subprocess."""

    def read_line(question: str, fallback: str) -> str:
        try:
            return input(f"{question} [{fallback}]: ").strip()
        except EOFError:
            return ""

    def launch(bin_name: str, prompt_arg: str, cwd: Optional[str] = None) -> LaunchResult:
        try:
            proc = subprocess.run([bin_name, prompt_arg], cwd=cwd)  # noqa: S603 (no shell)
        except OSError as e:
            return LaunchResult(started=False, error=str(e))
        return LaunchResult(
            started=True, error=None if proc.returncode == 0 else f"exit {proc.returncode}"
        )

    return HandoffIO(read_line=read_line, launch=launch)


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


def _pick_from_multiple(hosts: list[_PromptHost], io: HandoffIO) -> Optional[_PromptHost]:
    """Ask which of several detected hosts to launch (numbered), or None. Launching
    an agent is a side effect, so it requires an explicit, in-range number. Empty /
    n / junk / out-of-range all skip and fall back to the printed instructions; we
    never launch an agent the user did not pick."""
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
    host: _PromptHost, prompt_arg: str, io: HandoffIO, cwd: Optional[str] = None
) -> bool:
    """Launch a chosen host with ``prompt_arg`` from ``cwd``. Returns True only on a
    clean exit; a spawn failure or a non-zero/signalled exit returns False so the
    caller can fall back to printed instructions."""
    print(f'\nStarting {host.name}: {host.bin} "{prompt_arg}"\n')
    res = io.launch(host.bin, prompt_arg, cwd)
    if not res.started:
        print(f"\nleji: could not start {host.bin} ({res.error}).", file=sys.stderr)
        return False
    # Started but exited non-zero or was killed (e.g. Ctrl-C): did not finish
    # cleanly, so fall back to the printed instructions.
    return res.error is None


def handoff_offer(
    manifest: Manifest,
    detected: list[DetectedHost],
    interactive: bool,
    io: Optional[HandoffIO] = None,
    agent: Optional[str] = None,
) -> bool:
    """Offer to hand the scaffold to a detected agent and launch it directly.
    Interactive only: fires when ``interactive`` is set (a TTY and not --yes).
    ``agent`` forces a specific launchable host (skipping the prompt); otherwise
    the detected hosts drive the offer. Returns True when an agent was launched
    and finished cleanly, False to fall back to the printed instructions. Never
    fires non-interactively, so scripted/CI output and cross-SDK parity are
    unchanged."""
    if not interactive:
        return False
    io = io or _default_handoff_io()
    prompt_arg = f"Read ./{brief_path(manifest['rootPath'])} and follow it."
    if agent:
        host_id = resolve_host_id(agent)
        spec = (
            next((s for s in HOST_SPECS if s.id == host_id), None)
            if host_id and host_id in PROMPT_HOST_IDS
            else None
        )
        if spec is None:
            launchable = ", ".join(PROMPT_HOST_IDS)
            raise RuntimeError(f'--agent must be a launchable host ({launchable}); got "{agent}"')
        chosen: Optional[_PromptHost] = _PromptHost(spec.id, spec.bins[0], spec.name)
    else:
        hosts = _prompt_capable_hosts(detected)
        if not hosts:
            return False
        chosen = _choose_host(hosts, prompt_arg, io)
    if chosen is None:
        return False
    return _launch_host(chosen, prompt_arg, io)


def entering_the_layer(manifest: Manifest) -> str:
    """Post-init guidance, printed by the CLI."""
    brief = brief_path(manifest["rootPath"])
    return "\n".join(
        [
            "",
            "The scaffold is in place, but the content is still placeholder. Hand it to your agent",
            "to populate from your actual repository:",
            "",
            f'   claude "Read ./{brief} and follow it."',
            f'   codex "Read ./{brief} and follow it."',
            "",
            "The brief teaches the agent the Leji spec and points it at this repo: it reads your",
            "code, asks what it cannot infer, and fills in real context. Prefer to do it yourself?",
            "Edit the seeded documents directly. Either way, check progress with:",
            "",
            "   leji validate --content   # placeholder / thin-content warnings",
            "   leji conformance          # the level reached and what is next",
        ]
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
    io: Optional[HandoffIO] = None


def _boot_prompt(boot_rel: str) -> str:
    """The prompt `leji start` hands the agent: point it at the boot profile."""
    return f"Read ./{boot_rel}, follow it, and tell me when you're ready."


def enter_layer(opts: StartOptions) -> StartOutcome:
    """`leji start`: boot a coding agent into an existing layer, pointed at the boot
    profile. One detected host launches directly; several prompt; --agent forces a
    specific launchable host. Launches from the layer root so the relative boot path
    resolves. Returns 'launched' on a clean run, 'fallback' when there is nothing to
    launch (no host, non-interactive, or the launch failed), or 'boot-missing' when
    the boot profile path is unsafe or absent. Raises on an unknown/non-launchable
    --agent (a usage error → exit 2)."""
    root = os.path.abspath(opts.root)
    boot_rel = opts.manifest["bootProfilePath"]
    if not _REL_PATH_RE.match(boot_rel) or not os.path.isfile(os.path.join(root, boot_rel)):
        return "boot-missing"
    io = opts.io or _default_handoff_io()
    prompt_arg = _boot_prompt(boot_rel)

    host: Optional[_PromptHost] = None
    if opts.agent:
        host_id = resolve_host_id(opts.agent)
        spec = (
            next((s for s in HOST_SPECS if s.id == host_id), None)
            if host_id and host_id in PROMPT_HOST_IDS
            else None
        )
        if spec is None:
            launchable = ", ".join(PROMPT_HOST_IDS)
            raise RuntimeError(
                f'--agent must be a launchable host ({launchable}); got "{opts.agent}"'
            )
        host = _PromptHost(spec.id, spec.bins[0], spec.name)
    else:
        hosts = _prompt_capable_hosts(opts.detected)
        if len(hosts) == 1:
            host = hosts[0]
        elif len(hosts) > 1 and opts.interactive:
            host = _pick_from_multiple(hosts, io)

    if host is None or not opts.interactive:
        return "fallback"
    return "launched" if _launch_host(host, prompt_arg, io, root) else "fallback"


def entering_via_boot(manifest: Manifest) -> str:
    """Printed when `leji start` launches nothing (no agent, non-interactive, or a
    failed launch): the copy-paste commands to enter the layer via the boot
    profile."""
    prompt_arg = _boot_prompt(manifest["bootProfilePath"])
    return "\n".join(
        [
            "",
            "No coding agent was launched. To enter this context layer, run one of:",
            "",
            f'   claude "{prompt_arg}"',
            f'   codex "{prompt_arg}"',
            "",
            "Each points the agent at the boot profile, which loads the team context before any work.",
        ]
    )
