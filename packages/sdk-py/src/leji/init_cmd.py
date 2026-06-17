"""Interactive bootstrap of a context layer from the vendored templates."""

from __future__ import annotations

import datetime as dt
import json
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .indexgen import write_index
from .manifest import Manifest
from .schemas import templates_dir

CATEGORY_STUBS = {
    "domain": {
        "file": "glossary.md",
        "title": "Glossary",
        "summary": "What the core terms of this product mean, in our own words.",
        "body": "- **<Term>**: <what it means here, including what it does not mean>.\n",
    },
    "system": {
        "file": "invariants.md",
        "title": "System Invariants",
        "summary": "The constraints every change lives with.",
        "body": '- <An invariant every change must respect, e.g. "money values are integer minor units">.\n',
    },
    "practice": {
        "file": "conventions.md",
        "title": "Conventions",
        "summary": "Conventions and patterns applied automatically.",
        "body": "- <A convention that has proven out at least twice (the proven-twice gate)>.\n",
    },
    "governance": {
        "file": "operating-rules.md",
        "title": "Operating Rules",
        "summary": "What agents may do unprompted and what needs a human gate.",
        "body": "- Proceed without asking when: <defaults>.\n- Stop and ask when: <escalation triggers>.\n",
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
    """Validate ``rel`` against the schema rule and assert the resolved target
    stays under ``root``. Raises InitPathError otherwise."""
    _reject_unsafe_rel(rel, what)
    target = (root / rel).resolve()
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


def _write_file_once(root: Path, rel: str, content: str, written: list[str]) -> None:
    abs_path = _safe_target(root, rel, "write path")
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
        "machine": {
            "agentProfilesPath": f"{r}agents/",
            "decisionRecordsPath": f"{r}decisions/",
        },
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
    if answers.level == "indexed":
        manifest["machine"] = {
            "indexPath": f"{r}context-index.json",
            "changelogPath": f"{r}context-changelog.json",
            **manifest["machine"],
        }
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


def init_layer(
    directory: str,
    yes: bool = False,
    name: Optional[str] = None,
    level: Optional[str] = None,
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
    for key in ("bootProfilePath",):
        _safe_target(root, manifest[key], f"manifest.{key}")
    for key, mrel in (manifest.get("machine") or {}).items():
        if isinstance(mrel, str):
            _safe_target(root, mrel, f"machine.{key}")
    for category in answers.categories:
        for cpath in manifest["categories"][category]["paths"]:
            _safe_target(root, cpath, f"categories.{category}")
    written: list[str] = []
    r = answers.root_path

    _write_file_once(root, manifest["bootProfilePath"], _build_boot_profile(answers), written)
    for category in answers.categories:
        if category == "decisions":
            continue
        stub = CATEGORY_STUBS[category]
        _write_file_once(
            root,
            f"{r}{category}/{stub['file']}",
            _category_stub(stub["title"], stub["summary"], stub["body"]),
            written,
        )
    _write_file_once(
        root, f"{r}decisions/0001-adopt-leji.md", _build_first_decision(answers), written
    )
    _write_file_once(root, f"{r}agents/core.md", _build_core_profile(answers), written)

    if answers.level == "indexed":
        _write_file_once(
            root,
            manifest["machine"]["changelogPath"],
            _build_changelog(answers, [*written, "leji.json"]),
            written,
        )

    root.mkdir(parents=True, exist_ok=True)
    (root / "leji.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    written.append("leji.json")

    if answers.level == "indexed":
        write_index(str(root), manifest)
        written.append(manifest["machine"]["indexPath"])

    return InitResult(written=sorted(written), manifest=manifest)


def entering_the_layer(manifest: Manifest) -> str:
    """Post-init guidance, printed by the CLI."""
    boot = manifest["bootProfilePath"]
    return "\n".join(
        [
            "",
            "Enter the layer by direct invocation, so the boot profile is the agent's first context:",
            "",
            f'   claude "Read ./{boot}, follow all instructions, and tell me when you are ready to begin."',
            f'   codex "Read ./{boot} and follow it before doing anything else."',
            "",
            "Package the invocation for the whole team (package.json):",
            "",
            f'   "start": "claude \'Read ./{boot}, follow all instructions, and tell me when you are ready to begin.\'"',
            "",
            "Next: fill in the seeded documents, then run `leji validate` and `leji conformance`.",
        ]
    )
