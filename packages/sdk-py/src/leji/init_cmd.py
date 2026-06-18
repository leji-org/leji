"""Interactive bootstrap of a context layer from the vendored templates."""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .detect import HOST_SPECS, adapter_content, detect_hosts, resolve_host_id
from .fsx import resolved_within_root
from .indexgen import write_index
from .manifest import Manifest, effective_changelog_path, effective_index_path
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
    excluded from the index, the docs viewer, and the changelog."""
    return f"{root_path}.leji/onboarding-brief.md"


def build_ci_workflow() -> str:
    """The governed on-ramp: a CI job that runs ``leji validate`` on every change."""
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


def _resolve_adapter(root: Path, agent: Optional[str]) -> Optional[str]:
    """Resolve the file-style vendor adapter to create, honoring ``agent`` (a
    host id/alias, ``auto`` for the top detected host, or ``none``/unset for
    nothing). Never targets an existing entrypoint -- those are migrated with
    consent during adoption, never overwritten here -- so it returns ``None``
    when the file is present."""
    if not agent or agent == "none":
        return None
    if agent == "auto":
        top = next((h for h in detect_hosts(str(root)) if h.adapter), None)
        if not top:
            return None
        spec = next((s for s in HOST_SPECS if s.id == top.id), None)
    else:
        host_id = resolve_host_id(agent)
        spec = next((s for s in HOST_SPECS if s.id == host_id), None) if host_id else None
        if not spec:
            known = ", ".join(s.id for s in HOST_SPECS)
            raise RuntimeError(f'unknown agent "{agent}"; known: {known}')
        if not spec.adapter:
            raise RuntimeError(
                f"{spec.name} uses a directory-style adapter; wiring it is not yet supported"
            )
    if spec is None or not spec.adapter:
        return None
    if (root / spec.adapter).is_file():
        return None
    return spec.adapter


def build_role_profile(role: str, host_id: str, root_path: str) -> str:
    """An agent profile for a named role bound to a specific host (multi-agent)."""
    title = role[:1].upper() + role[1:]
    return f"""---
id: {role}
name: {title}
role: {role}
host: {host_id}
inherits: core
purpose: Independent review of proposed context-layer changes before a person approves.
requiredRead:
  - {root_path}boot-profile.md
  - {root_path}agents/core.md
mustAskWhen:
  - a proposal weakens an invariant or guardrail
  - a change to settled behavior lacks a decision record
---

# {title}

A second agent (host `{host_id}`) that reviews context-layer proposals against the spec and this
layer's own rules before a person approves. Inherits the core posture; it never loosens it.

## Review focus

- The proposal matches how this team actually works (domain, system, governance).
- Placeholders are gone and claims are grounded in the repository.
- A change to settled behavior carries a decision record.
"""


def wire_reviewer(root: Path, reviewer: str, manifest: Manifest, r: str) -> list[PlannedWrite]:
    """Designate a secondary host as the ``reviewer`` role: write its agent
    profile, bind it in ``manifest["agents"]``, and wire its vendor adapter when
    absent. Mutates the manifest (agents + vendorAdapters) and returns the files
    to write."""
    host_id = resolve_host_id(reviewer)
    spec = next((s for s in HOST_SPECS if s.id == host_id), None) if host_id else None
    if not spec:
        known = ", ".join(s.id for s in HOST_SPECS)
        raise RuntimeError(f'unknown agent "{reviewer}"; known: {known}')
    out: list[PlannedWrite] = []
    profile_rel = f"{r}agents/reviewer.md"
    out.append(PlannedWrite(profile_rel, build_role_profile("reviewer", spec.id, r)))
    agents = {**manifest.get("agents", {}), "reviewer": profile_rel}
    manifest["agents"] = agents
    if spec.adapter and not (root / spec.adapter).is_file():
        adapters = manifest.get("vendorAdapters", [])
        if spec.adapter not in adapters:
            adapters.append(spec.adapter)
        manifest["vendorAdapters"] = adapters
        out.append(PlannedWrite(spec.adapter, adapter_content(manifest["bootProfilePath"])))
    return out


def init_layer(
    directory: str,
    yes: bool = False,
    name: Optional[str] = None,
    level: Optional[str] = None,
    dry_run: bool = False,
    agent: Optional[str] = None,
    reviewer: Optional[str] = None,
    ci: bool = False,
) -> InitResult:
    """Bootstrap a context layer. Interactive unless ``yes``. Refuses to run
    when leji.json already exists; never overwrites existing files."""
    root = Path(directory).resolve()
    if (root / "leji.json").exists():
        raise RuntimeError(
            "leji.json already exists here; init refuses to overwrite an existing layer"
        )
    answers = _default_answers(directory, name, level) if yes else _prompt(directory, name, level)
    # Validate the chosen root and every derived write path against the schema
    # relative-path rule and assert containment, BEFORE writing anything.
    _reject_unsafe_rel(answers.root_path, "context root")
    _safe_target(root, answers.root_path, "context root")
    manifest = _build_manifest(answers)
    adapter = _resolve_adapter(root, agent)
    if adapter:
        manifest["vendorAdapters"] = [adapter]
    for key in ("bootProfilePath",):
        _safe_target(root, manifest[key], f"manifest.{key}")
    for category in answers.categories:
        for cpath in manifest["categories"][category]["paths"]:
            _safe_target(root, cpath, f"categories.{category}")
    r = answers.root_path
    # Multi-agent: a reviewer role bound to a second host (mutates the manifest
    # before leji.json is serialized below).
    reviewer_writes = wire_reviewer(root, reviewer, manifest, r) if reviewer else []

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
    if adapter:
        writes.append(PlannedWrite(adapter, adapter_content(manifest["bootProfilePath"])))
    writes.extend(reviewer_writes)
    if ci:
        writes.append(PlannedWrite(".github/workflows/leji.yml", build_ci_workflow()))
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
        return InitResult(written=[], manifest=manifest, plan=plan, dry_run=True)

    written: list[str] = []
    root.mkdir(parents=True, exist_ok=True)
    # leji.json is written directly (the guard above already proved it absent);
    # every other file goes through _write_file_once so nothing is overwritten.
    _assert_no_symlink_escape(root, root / "leji.json", "leji.json")
    (root / "leji.json").write_text(writes[0].content, encoding="utf-8")
    written.append("leji.json")
    for w in writes[1:]:
        _write_file_once(root, w.rel, w.content, written)

    if answers.level == "indexed":
        write_index(str(root), manifest)
        written.append(effective_index_path(manifest))

    return InitResult(written=sorted(written), manifest=manifest, plan=plan, dry_run=False)


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
    # shown verbatim, never rendered (no stored XSS in the Docsify local preview).
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
    new_adapter = _resolve_adapter(root, agent)
    r = answers.root_path

    # Convert only files that aren't already the canonical redirect; each has
    # been captured in to_migrate above, so the overwrite never loses content.
    to_convert = (
        [rel for rel in vendor_present if _read_text(root / rel).strip() != canonical_redirect]
        if wire_adapters
        else []
    )
    adapters: list[str] = []
    if new_adapter:
        adapters.append(new_adapter)
    for rel in to_convert:
        if rel not in adapters:
            adapters.append(rel)
    if adapters:
        manifest["vendorAdapters"] = adapters

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

    if new_adapter:
        writes.append(PlannedWrite(new_adapter, adapter_content(manifest["bootProfilePath"])))
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
            detected_root=detected_root,
            migrated=migrated,
            draft=draft,
        )

    written: list[str] = []
    root.mkdir(parents=True, exist_ok=True)
    _assert_no_symlink_escape(root, root / "leji.json", "leji.json")
    (root / "leji.json").write_text(writes[0].content, encoding="utf-8")
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

    return AdoptResult(
        written=sorted(written),
        manifest=manifest,
        plan=plan,
        dry_run=False,
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
