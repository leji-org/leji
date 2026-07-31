"""Static viewer generation and local preview, mirroring the Node SDK.

Presentation is non-normative; this is the reference projection of
context-index.json into a browsable surface (Docsify), plus a localhost-only
static server so `leji viewer serve` works the same in both ecosystems.
"""

from __future__ import annotations

import json
import os
import posixpath
import threading
import unicodedata
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, Optional

import re

from .findings import Finding
from .frontmatter import parse_frontmatter
from .fsx import resolved_within_root, strip_slash, under_path, walk_tree
from .indexgen import generate_index, serialize_index
from .layer import (
    ScannedProfile,
    resolve_agent_profile,
    resolve_category_assignments,
    scan_agent_profiles,
    scan_profile_set,
)
from .manifest import (
    CATEGORY_IDS,
    Manifest,
    effective_agent_profiles_path,
    effective_index_path,
    load_manifest,
)
from .mounts import mount_status, read_text_within
from .schemas import templates_dir

CATEGORY_LABELS = {
    "domain": "Domain",
    "system": "System",
    "practice": "Practice",
    "governance": "Governance",
    "decisions": "Decisions",
}

# Boot profile's emoji, matching the emoji'd category groups below it.
BOOT_EMOJI = "🤖"

# The derived agents group label unless viewer.agentsLabel curates it.
DEFAULT_AGENTS_LABEL = "🤖 Agents"

# Default per-category sidebar emoji; overridable via manifest viewer.categoryEmojis.
# Baked identically into every SDK so the generated sidebar stays byte-identical.
CATEGORY_EMOJI = {
    "domain": "📖",
    "system": "⚙️",
    "practice": "🛠️",
    "governance": "🛡️",
    "decisions": "🧭",
}

# Vendored assets loaded only when mermaid is enabled; skipped otherwise.
MERMAID_ASSETS = frozenset({"mermaid.min.js", "docsify-mermaid.js"})

# The Leji brand blue, the viewer's default accent when no viewer.theme.primary is
# set. DEFAULT_LOGO is the vendored Leji mark.
DEFAULT_THEME_COLOR = "#223F93"
DEFAULT_LOGO = "/assets/leji-logo.svg"

# A CSS color safe to hand to the page: a hex color or a bare color keyword. The
# accent reaches a stylesheet as a custom-property value, so anything with
# punctuation in it is a CSS-injection sink rather than a color.
SAFE_CSS_COLOR = re.compile(r"^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)$")

# The template's `{{NAME}}` substitution sites.
PLACEHOLDER_RE = re.compile(r"\{\{([A-Z_]+)\}\}")

# Extensions a browser would run as an active, same-origin document. Under
# `/content/` they are served as text/plain instead of their active type, and they
# are left out of the static export entirely: everything under the content mount is
# layer material, and layer material is read, never executed.
#
# `.svg` is deliberately NOT here. It stays a first-class asset (viewer.logo and
# viewer.favicon may point at one under the context root) because the inertness
# comes from the policy, not the content type: every /content/ response carries the
# CSP_CONTENT sandbox below, so an SVG navigated to or framed lands in an opaque
# origin with scripting off, and an SVG loaded as an <img> never runs script
# whatever its type.
ACTIVE_EXTENSIONS = frozenset({".html", ".htm", ".js", ".mjs", ".xhtml"})

# The SPA shell's policy, sent as a response header on every chrome response so it
# holds for documents reached outside the shell too. Mirrors the meta in
# templates/viewer/index.html; keep the two in step.
CSP_CHROME = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; "
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; frame-src 'none'"
)

# The policy for everything served out of the layer itself. `sandbox` with no
# tokens puts a /content/ document in an opaque origin with scripting off, so a
# governed file framed or opened directly is inert rather than same-origin code.
CSP_CONTENT = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox"

# The host names the local preview answers to.
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "[::1]"})

# C0/C1 control characters, stripped from anything attacker-controlled before it
# reaches an operator's terminal through the access log.
_LOG_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def _log_safe(s: str) -> str:
    """Neutralize control bytes in a logged request line: a raw request target can
    carry terminal escape sequences, and the access log prints straight to a TTY."""
    return _LOG_CONTROL_RE.sub("?", s)


def _loopback_host(host: Optional[str]) -> bool:
    """True when the Host header names the loopback interface: hostname only, since
    the port a request arrives on is already fixed by the loopback bind. A missing
    Host is accepted (an HTTP/1.0 client omits it)."""
    if not host:
        return True
    name = host[: host.find("]") + 1] if host.startswith("[") else host.split(":")[0]
    return name.lower() in LOOPBACK_HOSTS


def _resolve_theme_color(manifest: Manifest, findings: list[Finding]) -> str:
    """The viewer accent: viewer.theme.primary when it is a plain CSS color, else
    the Leji default with a warning. Never the authored value unchecked."""
    configured = ((manifest.get("viewer") or {}).get("theme") or {}).get("primary")
    if not configured:
        return DEFAULT_THEME_COLOR
    if SAFE_CSS_COLOR.match(configured):
        return configured
    findings.append(
        Finding(
            "viewer-theme-invalid",
            "warning",
            f'viewer.theme.primary "{configured}" is not a plain CSS color '
            f"(hex or keyword); using {DEFAULT_THEME_COLOR}",
        )
    )
    return DEFAULT_THEME_COLOR


def _resolve_viewer_rel(root: str, root_path: str, value: str) -> Optional[str]:
    """Resolve a viewer-configured file path to a rootPath-relative rel. The
    canonical form is rootPath-relative, but a repository-root-relative path
    under the context root is accepted too (`docs/README.md` for `README.md`):
    the manifest's pins are repo-relative, so authors mix the forms. Returns
    None when neither form names an existing file."""
    clean = re.sub(r"^\./", "", strip_slash(value))
    base = strip_slash(root_path)
    joined = Path(root) / base / clean if base and base != "." else Path(root) / clean
    if joined.is_file():
        return clean
    stripped = _relative_to_root(clean, root_path)
    if stripped is not None and (Path(root) / clean).is_file():
        return stripped
    return None


def _effective_homepage(root: str, manifest: Manifest, findings: list[Finding]) -> str:
    """The homepage rel served by the viewer: viewer.homepage in either path form,
    defaulting to the seeded overview. An unresolvable configured value is kept
    as authored (Docsify will 404 it) and reported as a warning."""
    configured = (manifest.get("viewer") or {}).get("homepage")
    if not configured:
        return "overview.md"
    rel = _resolve_viewer_rel(root, manifest["rootPath"], configured)
    if rel is not None:
        return rel
    findings.append(
        Finding(
            "viewer-path-missing",
            "warning",
            f'viewer.homepage "{configured}" does not resolve to a file under the context root',
            configured,
        )
    )
    return strip_slash(configured)


def _resolve_logo(root: str, root_path: str, logo: Optional[str]) -> str:
    """Resolve the viewer logo URL: a configured path is served from the content
    mount (or used as-is when absolute); unset falls back to the vendored mark."""
    if not logo:
        return DEFAULT_LOGO
    if logo.startswith("/") or re.match(r"^https?://", logo):
        return logo
    rel = _resolve_viewer_rel(root, root_path, logo)
    return f"/content/{rel if rel is not None else strip_slash(logo)}"


def resolve_viewer_port(manifest: Manifest, flag_port: Optional[int] = None) -> int:
    """Preview-port precedence: explicit --port, then manifest viewer.port, then 5354 (LEJI on a phone keypad)."""
    if flag_port is not None:
        return flag_port
    viewer_cfg = manifest.get("viewer") or {}
    port = viewer_cfg.get("port")
    return port if isinstance(port, int) else 5354


@dataclass
class ViewerResult:
    written: list[str] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)
    entries: int = 0


def _relative_to_root(rel_path: str, root_path: str) -> Optional[str]:
    base = strip_slash(root_path)
    if base in ("", "."):
        return rel_path
    if rel_path.startswith(base + "/"):
        return rel_path[len(base) + 1 :]
    return None  # outside the context root: not servable from the viewer


def _html_escape(s: str) -> str:
    """Escape text for HTML element/attribute content, matching the Node SDK's
    htmlEscape byte-for-byte (& < > " '). Python's html.escape emits &#x27; for
    the apostrophe where Node emits &#39;, so we cannot use it here."""
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def _json_for_script(value: object) -> str:
    """JSON safe to embed in a `<script type="application/json">` block: neutralize
    a closing tag and the JS line terminators U+2028/U+2029. Matches the Node
    SDK's jsonForScript (JSON.stringify then the five replacements)."""
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
        .replace(" ", "\\u2028")
        .replace(" ", "\\u2029")
    )


def _md_link_text(s: str) -> str:
    """Escape a string for Markdown link text (`[...]`): backslash, brackets, and
    the angle brackets that would otherwise land as live HTML (a manifest label or
    a frontmatter title reaches the generated sidebar verbatim)."""
    return re.sub(r"[\\\[\]<>]", lambda m: "\\" + m.group(0), s)


def _md_link_dest(s: str) -> str:
    """Escape a string for a Markdown link destination (`(...)`): backslash, parens."""
    return re.sub(r"[\\()]", lambda m: "\\" + m.group(0), s)


@dataclass
class TreeNode:
    rel: str
    title: str


def _is_js_word_char(ch: str) -> bool:
    """A JS regex word char ([A-Za-z0-9_]), the boundary set Node's \\b uses."""
    return ch == "_" or ("0" <= ch <= "9") or ("a" <= ch <= "z") or ("A" <= ch <= "Z")


def _prettify_dir_name(name: str) -> str:
    """Prettify a directory segment for a non-link label: separators to spaces,
    title-cased so derived labels read like curated ones. Mirrors Node's
    `\\b\\p{Ll}` upper-casing: the boundary uses JS word chars ([A-Za-z0-9_])
    while the cased char is any Unicode lowercase letter."""
    s = re.sub(r"[-_]+", " ", name).strip()
    out: list[str] = []
    for i, ch in enumerate(s):
        cur_word = _is_js_word_char(ch)
        boundary = cur_word if i == 0 else _is_js_word_char(s[i - 1]) != cur_word
        if boundary and unicodedata.category(ch) == "Ll":
            out.append(ch.upper())
        else:
            out.append(ch)
    return "".join(out)


def _build_tree_section(nodes: list[TreeNode]) -> list[str]:
    """Render reference docs as a nested list mirroring the directory tree: folders
    are bold non-link labels, files are links; sorted by name within each
    directory. Single-child folder chains are path-compressed ("Wood Badge /
    Ticket"), so a lone reference file never sits under a stack of single-child
    bold labels."""
    root: dict = {"dirs": {}, "files": []}
    for node in sorted(nodes, key=lambda n: n.rel):
        parts = node.rel.split("/")
        cur = root
        for seg in parts[:-1]:
            child = cur["dirs"].get(seg)
            if child is None:
                child = {"dirs": {}, "files": []}
                cur["dirs"][seg] = child
            cur = child
        cur["files"].append(node)

    lines: list[str] = []

    def render(node: dict, depth: int) -> None:
        indent = "  " * depth
        merged = [{"name": name, "dir": d} for name, d in node["dirs"].items()] + [
            {"name": f.rel.split("/")[-1], "file": f} for f in node["files"]
        ]
        merged.sort(key=lambda e: e["name"])
        for e in merged:
            if "dir" in e:
                # Path-compress single-child chains: a folder holding nothing but
                # one subfolder merges its label.
                names = [e["name"]]
                d = e["dir"]
                while not d["files"] and len(d["dirs"]) == 1:
                    child_name, child = next(iter(d["dirs"].items()))
                    names.append(child_name)
                    d = child
                label = " / ".join(_prettify_dir_name(n) for n in names)
                lines.append(f"{indent}- **{label}**")
                render(d, depth + 1)
            else:
                f = e["file"]
                lines.append(f"{indent}- [{_md_link_text(f.title)}]({_md_link_dest(f.rel)})")

    render(root, 0)
    return lines


@dataclass
class SidebarEntry:
    """A sidebar entry: rootPath-relative link target and display title. A
    document's kind and record date are page-level metadata (the classification
    chip), not sidebar decoration."""

    rel: str
    title: str


@dataclass
class SidebarGroup:
    """A spine group: one curated index file's winners, labeled by its H1."""

    label: str
    entries: list[SidebarEntry]


def _entry_line(indent: str, e: SidebarEntry) -> str:
    """Render one sidebar link line."""
    return f"{indent}- [{_md_link_text(e.title)}]({_md_link_dest(e.rel)})"


def build_sidebar(
    manifest: Manifest,
    groups: list[SidebarGroup],
    tree: Optional[list[TreeNode]] = None,
    pins: Optional[list[SidebarEntry]] = None,
    boot_pinned: bool = False,
) -> str:
    """Project a deterministic Docsify sidebar, two zones: the governed spine on
    top (boot profile, then any pinned pages, then one group per curated index
    file, labeled by the index file's own H1 in manifest order), and below a
    divider the reference-docs directory tree (browse zone). Membership follows
    selector resolution: a document appears in the group of the index file whose
    selector won it. Paths relative to rootPath."""
    if tree is None:
        tree = []
    if pins is None:
        pins = []
    # Boot profile and pins above a divider, then index-file groups, then the tree.
    top_lines: list[str] = []
    boot = _relative_to_root(manifest["bootProfilePath"], manifest["rootPath"])
    # Emoji inside the link text so the label stays on one line (links render as
    # block elements; an emoji outside would wrap above). A pinned boot profile
    # replaces this default line with the team's own label and position.
    if boot and not boot_pinned:
        top_lines.append(f"- [{BOOT_EMOJI} Boot profile]({_md_link_dest(boot)})")
    for pin in pins:
        top_lines.append(_entry_line("", pin))
    group_lines: list[str] = []
    for group in groups:
        if not group.entries:
            continue
        # Bold labels: the sidebar-collapse plugin treats a strong label with a
        # nested list as a collapsible folder, matching hand-built sidebars.
        group_lines.append(f"- **{_md_link_text(group.label)}**")
        group_lines.extend(_build_group_tree(group.entries, group.label))
    # The browse zone renders as one collapsed "Reference" folder, not a bare
    # spill of links: a curated layer reads as pins + governed groups, with the
    # ungoverned tier behind a single, deliberately-named drawer.
    raw_tree = _build_tree_section(tree)
    tree_lines = ["- **Reference**", *(f"  {line}" for line in raw_tree)] if raw_tree else []
    sections = ["\n".join(s) for s in (top_lines, group_lines, tree_lines) if s]
    return "\n\n---\n\n".join(sections) + "\n"


def _group_label(root: str, index_rel: str) -> str:
    """An index file's group label: its first H1 (frontmatter title wins), else a
    prettified filename. The author's H1 carries any emoji or phrasing."""
    return _doc_title(root, index_rel)


def _build_group_tree(entries: list[SidebarEntry], label: str = "") -> list[str]:
    """Render a group's members as a nested tree mirroring their real directory
    structure: the members' longest common directory prefix is stripped (so a
    group whose content lives under one directory doesn't repeat it), deeper
    directories become bold sub-labels, and files render as links. Real
    repositories are not flat; the sidebar shouldn't be."""

    # Longest common directory prefix across all members.
    def dir_of(rel: str) -> list[str]:
        return rel.split("/")[:-1]

    prefix = dir_of(entries[0].rel)
    for e in entries[1:]:
        d = dir_of(e.rel)
        i = 0
        while i < len(prefix) and i < len(d) and prefix[i] == d[i]:
            i += 1
        prefix = prefix[:i]
    strip = len(prefix)

    root_node: dict = {"dirs": {}, "files": []}
    for e in sorted(entries, key=lambda x: x.rel):
        parts = e.rel.split("/")[strip:]
        cur = root_node
        for seg in parts[:-1]:
            child = cur["dirs"].get(seg)
            if child is None:
                child = {"dirs": {}, "files": []}
                cur["dirs"][seg] = child
            cur = child
        cur["files"].append(e)

    # Hoist a top-level directory whose name matches the group's own label (the
    # emoji-stripped comparison), so "💼 Business" never wraps a redundant
    # "Business" level while outlier members stay as siblings. Mirrors Node's
    # /[^\p{L}\p{N} ]/gu strip via unicodedata categories.
    label_key = (
        "".join(ch for ch in label if unicodedata.category(ch)[0] in ("L", "N") or ch == " ")
        .strip()
        .lower()
    )

    def merge_into(target: dict, src: dict) -> None:
        target["files"].extend(src["files"])
        for name, d in src["dirs"].items():
            existing = target["dirs"].get(name)
            if existing is not None:
                merge_into(existing, d)
            else:
                target["dirs"][name] = d

    for name in list(root_node["dirs"].keys()):
        if label_key != "" and _prettify_dir_name(name).lower() == label_key:
            d = root_node["dirs"].pop(name)
            merge_into(root_node, d)

    lines: list[str] = []

    def render(node: dict, depth: int) -> None:
        indent = "  " * (depth + 1)
        merged = [{"name": name, "dir": d} for name, d in node["dirs"].items()] + [
            {"name": f.rel.split("/")[-1], "file": f} for f in node["files"]
        ]
        merged.sort(key=lambda e: e["name"])
        for e in merged:
            if "dir" in e:
                lines.append(f"{indent}- **{_md_link_text(_prettify_dir_name(e['name']))}**")
                render(e["dir"], depth + 1)
            else:
                lines.append(_entry_line(indent, e["file"]))

    render(root_node, 0)
    return lines


def build_sidebar_groups(root: str, manifest: Manifest, entries: list[dict]) -> list[SidebarGroup]:
    """Compute the spine groups: one per curated index file, in manifest order
    (categories in canonical order, index files in their declared array order),
    containing the governed documents whose winning selector that file declared.
    Index files that share the same H1 label MERGE into one group: a topical
    group (a product area, a program) spans categories by splitting into
    per-category index files under one shared label. Documents outside rootPath
    are not servable and are skipped."""
    assignments, _findings, _shadowed = resolve_category_assignments(root, manifest)
    by_path = {e["path"]: e for e in entries}
    groups: list[SidebarGroup] = []
    seen: set[str] = set()
    for category in CATEGORY_IDS:
        for index_rel in (manifest["categories"].get(category) or {}).get("indexes", []):
            if index_rel in seen:
                continue
            seen.add(index_rel)
            members: list[SidebarEntry] = []
            for rel_path in sorted(assignments):
                if assignments[rel_path].index_rel != index_rel:
                    continue
                entry = by_path.get(rel_path)
                if not entry:
                    continue
                rel = _relative_to_root(rel_path, manifest["rootPath"])
                if rel is None:
                    continue
                members.append(SidebarEntry(rel=rel, title=_sidebar_label(root, rel_path, rel)))
            if not members:
                continue
            groups.append(SidebarGroup(label=_group_label(root, index_rel), entries=members))
    # Agent profiles are artifacts outside category content, so the sidebar
    # surfaces them from the profile scan as their own group (label curated via
    # viewer.agentsLabel; first in derived order, reorderable by groupOrder).
    agent_members: list[SidebarEntry] = []
    for p in scan_agent_profiles(root, manifest):
        rel = _relative_to_root(p.rel_path, manifest["rootPath"])
        if rel is None:
            continue
        name = (p.frontmatter or {}).get("name")
        title = (
            name.strip()
            if isinstance(name, str) and name.strip() != ""
            else _sidebar_label(root, p.rel_path, rel)
        )
        agent_members.append(SidebarEntry(rel=rel, title=title))
    if agent_members:
        label = (manifest.get("viewer") or {}).get("agentsLabel")
        groups.insert(
            0,
            SidebarGroup(
                label=label if label is not None else DEFAULT_AGENTS_LABEL,
                entries=agent_members,
            ),
        )
    # Merge same-labeled groups, keeping first-occurrence order.
    merged: list[SidebarGroup] = []
    by_label: dict[str, SidebarGroup] = {}
    for g in groups:
        existing = by_label.get(g.label)
        if existing is not None:
            existing.entries.extend(g.entries)
        else:
            by_label[g.label] = g
            merged.append(g)
    for g in merged:
        g.entries.sort(key=lambda e: e.rel)
    # viewer.groupOrder curates group sequence by exact label: listed groups come
    # first in the given order; unlisted groups follow in derived order.
    order = (manifest.get("viewer") or {}).get("groupOrder") or []
    if order:
        ranks = {
            id(g): (order.index(g.label) if g.label in order else len(order) + i)
            for i, g in enumerate(merged)
        }
        merged.sort(key=lambda g: ranks[id(g)])
    return merged


def _doc_title(root: str, rel_path: str) -> str:
    """Display title for a reference doc: frontmatter title, else first body
    heading, else a prettified filename."""
    text = (Path(root) / rel_path).read_text(encoding="utf-8")
    fm = parse_frontmatter(text)
    title = (fm.data or {}).get("title")
    if isinstance(title, str) and title.strip() != "":
        return title.strip()
    m = re.search(r"^#\s+(.+)$", fm.body, re.MULTILINE)
    if m:
        return m.group(1).strip()
    base = posixpath.basename(rel_path)
    base = base[:-3] if base.endswith(".md") else base
    return re.sub(r"[-_]+", " ", base).strip()


def _filename_label(root_rel: str) -> str:
    """A filename-derived sidebar label: all-caps stems stay as-is (TODO, ICP),
    a root README reads "Home", a nested README reads "Overview", everything else
    prettifies to title case."""
    stem = re.sub(r"\.md$", "", posixpath.basename(root_rel), flags=re.IGNORECASE)
    if stem.lower() == "readme":
        return "Overview" if "/" in root_rel else "Home"
    if re.match(r"^[A-Z0-9]+([-_][A-Z0-9]+)*$", stem) and re.search(r"[A-Z]", stem):
        return re.sub(r"[-_]+", " ", stem)
    return _prettify_dir_name(stem)


def _sidebar_label(root: str, rel_path: str, root_rel: str) -> str:
    """Sidebar label for a document: the declared frontmatter `title` wins;
    otherwise the filename, cleaned up. Deliberately NOT the H1: hand-built
    sidebars use short curated labels, and filenames are the curated short name a
    repository already has. The H1 stays the document's title everywhere else
    (page, index)."""
    text = (Path(root) / rel_path).read_text(encoding="utf-8")
    fm = parse_frontmatter(text)
    title = (fm.data or {}).get("title")
    if isinstance(title, str) and title.strip() != "":
        return title.strip()
    return _filename_label(root_rel)


def _reference_tree(root: str, manifest: Manifest, governed_paths: set[str]) -> list[TreeNode]:
    """The browse zone: every markdown file under rootPath that is NOT governed
    (in the index), NOT viewer/layer chrome (boot profile, agent profiles, the
    category index files, overview.md, the generated _sidebar.md), and stays under
    rootPath. The `.leji` viewer dir is skipped by the walk itself."""
    root_dir_rel = strip_slash(manifest["rootPath"]) or "."
    profiles_dir = effective_agent_profiles_path(manifest)
    index_files: set[str] = set()
    for cat in CATEGORY_IDS:
        for f in (manifest["categories"].get(cat) or {}).get("indexes", []):
            index_files.add(f)
    overview_rel = "overview.md" if root_dir_rel == "." else f"{root_dir_rel}/overview.md"
    sidebar_rel = "_sidebar.md" if root_dir_rel == "." else f"{root_dir_rel}/_sidebar.md"
    manifest_page_rel = "_manifest.md" if root_dir_rel == "." else f"{root_dir_rel}/_manifest.md"
    nodes: list[TreeNode] = []
    for rel in walk_tree(root, root_dir_rel):
        if rel in governed_paths:
            continue
        if rel == manifest["bootProfilePath"]:
            continue
        if under_path(rel, profiles_dir):
            continue
        if rel in index_files:
            continue
        if rel in (overview_rel, sidebar_rel, manifest_page_rel):
            continue
        r = _relative_to_root(rel, manifest["rootPath"])
        if r is None:
            continue
        nodes.append(TreeNode(rel=r, title=_sidebar_label(root, rel, r)))
    return nodes


# The overview homepage is seeded once and then user-owned. The layer map lives
# between these markers; `leji viewer` regenerates only the marked block, leaving
# the surrounding prose untouched.
MAP_START = "<!-- leji:generated-map:start -->"
MAP_END = "<!-- leji:generated-map:end -->"


def build_layer_map(manifest: Manifest, entries: list[dict]) -> str:
    """A deterministic mermaid map of the layer: boot profile -> populated
    categories with document counts. Deliberately category-altitude: per-document
    nodes turn unreadable past a handful of docs, so the map never lists
    documents (the sidebar already does that legibly)."""
    lines = ["flowchart LR", f'  boot["{BOOT_EMOJI} Boot profile"]']
    for category in CATEGORY_IDS:
        count = sum(1 for e in entries if e.get("category") == category)
        if count == 0:
            continue
        viewer_cfg = manifest.get("viewer") or {}
        configured = (viewer_cfg.get("categoryEmojis") or {}).get(category)
        emoji = configured if configured is not None else CATEGORY_EMOJI[category]
        cat_id = "cat_" + category
        docs = "1 doc" if count == 1 else f"{count} docs"
        lines.append(f'  {cat_id}["{emoji} {CATEGORY_LABELS[category]} · {docs}"]')
        lines.append(f"  boot --> {cat_id}")
    return "\n".join(lines)


def _map_block(manifest: Manifest, entries: list[dict]) -> str:
    return MAP_START + "\n```mermaid\n" + build_layer_map(manifest, entries) + "\n```\n" + MAP_END


def _build_overview_seed(manifest: Manifest, entries: list[dict]) -> str:
    """The starter overview/home page: a short explainer the owner can edit freely,
    plus the auto-generated layer map inside the regen markers."""
    name = manifest["name"]
    return (
        f"# {name}\n"
        "\n"
        f"This is the **Leji context layer** for `{name}`: the shared, validated context\n"
        "people and coding agents read before working in this repository. Start with the boot\n"
        "profile, then browse the categories in the sidebar.\n"
        "\n"
        "This page is yours to edit. The map below is regenerated by `leji viewer` between the\n"
        "markers; the prose around it is left untouched.\n"
        "\n"
        f"{_map_block(manifest, entries)}\n"
        "\n"
        "- Write a ```mermaid code block in any document and it renders as a diagram here.\n"
        "- Run `leji conformance` to see the level this layer claims and verifies.\n"
    )


# The characters JS String.prototype.trim strips (WhiteSpace + LineTerminator),
# matched exactly so the manifest page's trimming stays byte-identical with Node.
_JS_WS = (
    "\t\n\x0b\x0c\r \xa0"
    + "\u1680"
    + "".join(chr(c) for c in range(0x2000, 0x200B))
    + "\u2028\u2029\u202f\u205f\u3000\ufeff"
)
_MANIFEST_CTRL_RE = re.compile("[\u0000-\u001f\u007f-\u009f]+")
_MANIFEST_WS_RE = re.compile("[ \t\n\r\f\x0b]+")
_MERMAID_STRUCT_RE = re.compile(r"[\[\]{}()<>|`]")
_SHORT_PIN_RE = re.compile(r"^[0-9a-fA-F]{7,}$")


def _manifest_normalize(s: str) -> str:
    """Collapse control chars and whitespace runs to single spaces, then trim — the
    shared prefix of _esc, _code_span, and _mermaid_label."""
    s = _MANIFEST_CTRL_RE.sub(" ", s)
    s = _MANIFEST_WS_RE.sub(" ", s)
    return s.strip(_JS_WS)


def _esc(s: str) -> str:
    """Normalize a value to one safe markdown-inline token: strip control chars,
    collapse whitespace, trim, then neutralize the characters that could break
    markdown structure or inject HTML (backslash, backtick, pipe, angle brackets),
    in that order. Mirrors the Node SDK's esc."""
    s = _manifest_normalize(s)
    return (
        s.replace("\\", "\\\\")
        .replace("`", "\\`")
        .replace("|", "\\|")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _code_span(s: str) -> str:
    """Render a value as a code span when safe (no backtick after control
    normalization), escaping the pipe so it survives a table cell; otherwise fall
    back to plain escaped text so a stray backtick can never corrupt the row."""
    norm = _manifest_normalize(s)
    if "`" in norm:
        return _esc(s)
    return "`" + norm.replace("|", "\\|") + "`"


def _short_pin(pin: str) -> str:
    """A hex commit pin shown short; any other locator shown verbatim."""
    return pin[:12] if _SHORT_PIN_RE.match(pin) else pin


def _pin_drift_label(r: dict) -> str:
    """Human-readable pin drift, from git-derived counts only (never a wall-clock
    value) so the page stays byte-deterministic across the three SDKs."""
    state = r.get("state")
    ahead = r.get("ahead")
    behind = r.get("behind")
    a = ahead if ahead is not None else "?"
    b = behind if behind is not None else "?"
    if state == "up-to-date":
        return "up-to-date"
    if state == "ahead":
        return f"ahead {a}"
    if state == "behind":
        return f"behind {b}"
    if state == "diverged":
        return f"diverged (ahead {a}, behind {b})"
    if state == "unrelated":
        return "unrelated"
    return "unknown"


def _mermaid_label(s: str) -> str:
    """Escape a string for a quoted mermaid node label `["..."]`: collapse
    control/whitespace, map `"` to the mermaid entity, and replace the structural
    characters that break mermaid parsing. Empty maps to `?`."""
    t = _manifest_normalize(s)
    t = t.replace('"', "#quot;")
    t = _MERMAID_STRUCT_RE.sub(" ", t)
    t = re.sub(r" +", " ", t)
    t = t.strip(_JS_WS)
    return t if t != "" else "?"


def build_manifest_page(manifest: Manifest, statuses: list[dict]) -> str:
    """The generated "Manifest" page: a human-friendly view of `leji.json` plus the
    local federation diagnostics (hydration + pin drift). Written as generated chrome
    to the gitignored `.leji/viewer/`, regenerated every run, never committed.
    Declaration-driven (the manifest is truth; mount status is joined by name).
    Deterministic by construction — declared values plus git-derived (never
    wall-clock, never networked) state — so the three SDKs emit identical bytes."""
    viewer_cfg = manifest.get("viewer") or {}
    title = viewer_cfg.get("title") or manifest["name"]
    lines: list[str] = [
        f"# {_esc(title)} — Manifest",
        "",
        "A human-readable view of this layer's `leji.json`.",
        "",
        "> **Declared** values come straight from the manifest. **Observed** values "
        "(mount availability and drift) are read from local projections and Git objects "
        "— no network fetch is performed.",
        "",
        "## Identity",
        "",
        "| Field | Declared |",
        "| --- | --- |",
        f"| Name | {_code_span(manifest['name'])} |",
    ]
    if manifest.get("description"):
        lines.append(f"| Description | {_esc(manifest['description'])} |")
    lines.append(f"| Spec line | {_code_span(manifest['leji'])} |")
    owner = (manifest.get("owners") or {}).get("primary")
    if owner:
        owner_line = f"| Owner | {_esc(owner['name'])}"
        if owner.get("contact"):
            owner_line += f" ({_code_span(owner['contact'])})"
        owner_line += " |"
        lines.append(owner_line)
    claimed = (manifest.get("conformance") or {}).get("claimedLevel")
    if claimed:
        lines.append(
            f"| Conformance | claims `{_esc(claimed)}` — run `leji conformance` to verify |"
        )
    else:
        lines.append("| Conformance | no level claimed |")

    lines.extend(["", "## Entrypoints", "", "| Purpose | Path |", "| --- | --- |"])
    lines.append(f"| Boot profile | {_code_span(manifest['bootProfilePath'])} |")
    lines.append(f"| Context root | {_code_span(manifest['rootPath'])} |")
    machine = manifest.get("machine") or {}
    if machine.get("indexPath"):
        lines.append(f"| Context index | {_code_span(machine['indexPath'])} |")
    if machine.get("changelogPath"):
        lines.append(f"| Changelog | {_code_span(machine['changelogPath'])} |")
    if machine.get("agentProfilesPath"):
        lines.append(f"| Agent profiles | {_code_span(machine['agentProfilesPath'])} |")
    if machine.get("decisionRecordsPath"):
        lines.append(f"| Decision records | {_code_span(machine['decisionRecordsPath'])} |")

    # Categories: a count summary of the declared index files. The documents
    # themselves are enumerated by the sidebar (grouped by category), so listing
    # their paths here would only duplicate that; the fact worth surfacing is shape.
    def _index_count(c: str) -> int:
        return len((manifest["categories"].get(c) or {}).get("indexes") or [])

    populated = [c for c in CATEGORY_IDS if _index_count(c) > 0]
    if populated:
        summary = " · ".join(f"{CATEGORY_LABELS[c]} {_index_count(c)}" for c in populated)
        lines.extend(
            [
                "",
                "## Categories",
                "",
                f"**Declared index files:** {summary}. The documents themselves are in "
                "the sidebar, grouped by category.",
            ]
        )

    agents = manifest.get("agents") or {}
    roles = sorted(agents.keys(), key=lambda s: s.encode("utf-8"))
    if roles:
        lines.extend(["", "## Agents", "", "| Role | Profile |", "| --- | --- |"])
        for role in roles:
            lines.append(f"| {_code_span(role)} | {_code_span(agents[role])} |")

    # Actors, when declared: this page renders the manifest, so a declared top-level
    # key that it silently omitted would make the page wrong for the layers using it.
    # One row per (actor, role), because the command is keyed by the pair.
    actors = manifest.get("actors") or {}
    actor_ids = sorted(actors.keys(), key=lambda s: s.encode("utf-8"))
    if actor_ids:
        lines.extend(["", "## Actors", "", "| Actor | Role | Command |", "| --- | --- | --- |"])
        for actor_id in actor_ids:
            actor = actors[actor_id]
            for role in sorted(actor.get("roles") or [], key=lambda s: s.encode("utf-8")):
                command = (actor.get("commands") or {}).get(role)
                rendered = _code_span(command) if command else "—"
                lines.append(f"| {_code_span(actor_id)} | {_code_span(role)} | {rendered} |")

    # Federation gets the visual weight: it is the operational view unique to this
    # page. Graph first (composition at a glance), then an observed-state summary,
    # then the evidence table. Declaration-driven and byte-sorted by name; a mount
    # with no matching status is `unknown`, an absent optional field an em dash.
    mounts_list = sorted(
        (manifest.get("federation") or {}).get("mounts") or [],
        key=lambda d: d["name"].encode("utf-8"),
    )
    lines.extend(["", "## Federation", ""])
    if not mounts_list:
        lines.append("No federated mounts are declared for this layer.")
    else:
        status_by_name = {s["name"]: s for s in statuses}
        if viewer_cfg.get("mermaid") is not False:
            graph = ["```mermaid", "flowchart LR", f'   host["{_mermaid_label(title)}"]']
            for i, d in enumerate(mounts_list):
                graph.append(f'   m{i}["{_mermaid_label(d["name"])}"]')
                graph.append(f"   host --> m{i}")
            graph.extend(["```", ""])
            lines.extend(graph)
        hydrated = sum(
            1 for d in mounts_list if (status_by_name.get(d["name"]) or {}).get("present")
        )
        # Drift = any known non-current relationship to the pin (ahead/behind/diverged/
        # unrelated); only `unknown` (uncomputable locally) is left out of the count.
        drifting = sum(
            1
            for d in mounts_list
            if ((status_by_name.get(d["name"]) or {}).get("pinReport") or {}).get("state")
            in ("ahead", "behind", "diverged", "unrelated")
        )
        summary = (
            f"**Observed:** {hydrated}/{len(mounts_list)} mounts hydrated locally "
            f"· {drifting} drifting from pin."
        )
        lines.extend([summary, ""])
        # The table stays operational (status + provenance); the descriptive Role is a
        # sentence per mount, so it reads as a list below rather than widening a cell.
        lines.append("| Mount | Availability | Drift | Owner | Pin | Source |")
        lines.append("| --- | --- | --- | --- | --- | --- |")
        for d in mounts_list:
            s = status_by_name.get(d["name"])
            if s is not None:
                availability = "hydrated" if s.get("present") else "not hydrated"
                drift = _pin_drift_label(s["pinReport"])
            else:
                availability = "unknown"
                drift = "unknown"
            owner_cell = _esc(d["owner"]["name"]) if (d.get("owner") or {}).get("name") else "—"
            source_cell = _code_span(d["source"]) if d.get("source") else "—"
            if d.get("pin"):
                pin_cell = _code_span(_short_pin(d["pin"]))
                if d.get("trackingRef"):
                    pin_cell += f" @ {_code_span(d['trackingRef'])}"
            else:
                pin_cell = "—"
            lines.append(
                f"| {_esc(d['name'])} | {availability} | {drift} | {owner_cell} | "
                f"{pin_cell} | {source_cell} |"
            )
        lines.append("")
        lines.append(
            "> `not hydrated` / `unknown` are normal degraded reads — ordinary "
            "validation never fails just because a mount is unavailable (opt-in "
            "federation enforcement is separate). Run `leji mounts hydrate`, then "
            "regenerate the viewer to refresh."
        )
        roled = [d for d in mounts_list if d.get("role")]
        if roled:
            lines.extend(["", "**Roles**", ""])
            for d in roled:
                lines.append(f"- **{_esc(d['name'])}** — {_esc(d['role'])}")
    lines.append("")
    return "\n".join(lines)


def _json_value(value: object) -> str:
    """JSON-encode a frontmatter value the way JS ``JSON.stringify`` does (an
    integral float collapses: YAML ``1.0`` reads back as the number 1)."""

    def normalize(v: object) -> object:
        if isinstance(v, float) and v.is_integer():
            return int(v)
        if isinstance(v, dict):
            return {k: normalize(x) for k, x in v.items()}
        if isinstance(v, list):
            return [normalize(x) for x in v]
        return v

    return json.dumps(normalize(value), separators=(",", ":"), ensure_ascii=False)


def _profile_value(value: object) -> str:
    """One frontmatter scalar as a markdown-safe inline value."""
    if isinstance(value, str):
        return _code_span(value)
    if value is None:
        return "—"
    return _code_span(_json_value(value))


def _unresolved_profile_page(rel_path: str, findings: list[Finding]) -> str:
    """The page for an agent profile that does not resolve: its findings, never the
    authored file. There is no effective profile to show, and presenting the derived
    file as if there were would be the error the finding names."""
    lines = [
        f"# {_esc(rel_path)} — unresolved profile",
        "",
        f"> **This profile does not resolve.** {_code_span(rel_path)} declares "
        "`inherits`, and the inheritance cannot be resolved, so the layer has no "
        "effective profile for this role. The file on disk is only its own half and "
        "is not shown here: a consumer that cannot resolve an inherited profile must "
        "not apply the derived file alone.",
        "",
        "| Rule | Where | Problem |",
        "| --- | --- | --- |",
    ]
    for f in findings:
        where = "—" if f.path is None else _code_span(f.path)
        lines.append(f"| {_code_span(f.rule)} | {where} | {_esc(f.message)} |")
    if not findings:
        lines.append(f"| — | {_code_span(rel_path)} | the profile could not be resolved |")
    lines.append("")
    return "\n".join(lines)


def _render_resolved_profile(profiles: list[ScannedProfile], derived: ScannedProfile) -> str:
    """The page for an agent profile that declares ``inherits``: the effective
    profile after resolution, never the authored file, which is only its own half.
    Sources are named, each posture entry is labelled with the profile that supplied
    it, and the composite body keeps the resolver's source markers."""
    fm = derived.frontmatter or {}
    raw_id = fm.get("id")
    derived_id = raw_id if isinstance(raw_id, str) else derived.rel_path
    resolved = resolve_agent_profile(derived, profiles)
    if resolved.frontmatter is None or resolved.body is None:
        return _unresolved_profile_page(derived.rel_path, resolved.findings)

    base_id = resolved.source_ids[0]
    base = next((p for p in profiles if (p.frontmatter or {}).get("id") == base_id), None)
    base_rel = base.rel_path if base is not None else base_id
    base_fm = (base.frontmatter if base is not None else None) or {}
    effective = resolved.frontmatter
    raw_title = effective.get("name")
    title = raw_title if isinstance(raw_title, str) else derived_id
    lines: list[str] = [
        f"# {_esc(title)} — resolved profile",
        "",
        f"> **Resolved profile.** {_code_span(derived.rel_path)} declares "
        f"`inherits: {_esc(base_id)}`, so this page is the effective profile: posture "
        f"from {_code_span(base_rel)} first, then this profile's own, with exact "
        "duplicates dropped. Every other field is this profile's own; both bodies are "
        "operative, base first. The file on disk carries only its own half.",
        "",
        f"**Sources**, base first: {_code_span(base_rel)} (`{_esc(base_id)}`), then "
        f"{_code_span(derived.rel_path)} (`{_esc(derived_id)}`).",
        "",
        "## Effective frontmatter",
        "",
    ]
    for key, value in effective.items():
        if not isinstance(value, list):
            lines.append(f"- **{_esc(key)}** — {_profile_value(value)}")
            continue
        # Composed posture: label every entry with the profile that supplied it.
        base_value = base_fm.get(key)
        from_base = {_json_value(v) for v in (base_value if isinstance(base_value, list) else [])}
        lines.append(f"- **{_esc(key)}**")
        if len(value) == 0:
            lines.append("   - (empty)")
        for entry in value:
            source = base_id if _json_value(entry) in from_base else derived_id
            lines.append(f"   - {_profile_value(entry)} — from `{_esc(source)}`")
    lines.extend(["", "## Effective body", ""])
    # The resolver's markers stay in the page (they are what a consumer reads); each
    # gets a visible line beside it so the rendered view names its source too.
    labelled = resolved.body.replace(
        f"<!-- inherited from: {base_id} -->",
        f"<!-- inherited from: {base_id} -->\n\n*Inherited from {_code_span(base_rel)}.*",
        1,
    ).replace(
        f"<!-- {derived_id} -->",
        f"<!-- {derived_id} -->\n\n*From {_code_span(derived.rel_path)}.*",
        1,
    )
    lines.append(labelled)
    return "\n".join(lines)


def _declares_inherits(root: str, repo_rel: str) -> bool:
    """True when the file at ``repo_rel`` declares ``inherits``, so it is one half of
    a profile and must never reach a reader as the effective one. Manifest-free and
    total, so the serve path can still classify when nothing else is readable."""
    try:
        text = read_text_within(root, Path(root) / repo_rel)
        if text is None:
            return False
        data = parse_frontmatter(text).data
        return isinstance((data or {}).get("inherits"), str)
    except Exception:  # noqa: BLE001 - a total classifier: unreadable is "not one"
        return False


def resolved_profile_page(root: str, manifest: Manifest, repo_rel: str) -> Optional[str]:
    """The page for ``repo_rel`` when it is an agent profile that declares
    ``inherits``, else None (every other document is served from disk as authored).

    Fails closed. Once the file is known to be an inheriting profile, this function
    owns the response: any failure below that point returns a findings page, never
    None, because returning None hands the caller back to the raw derived file, and
    serving half a profile as if it were the whole one is the exact outcome the spec
    forbids."""
    committed = False
    try:
        # Cheap rejects before the profile scan: the viewer calls this per markdown
        # fetch. Path first (an ordinary document is never a profile), then the
        # file's own frontmatter (a profile that inherits nothing is served as-is).
        bound = repo_rel in ((manifest.get("agents") or {}).values())
        if not bound and not under_path(repo_rel, effective_agent_profiles_path(manifest)):
            return None
        if not _declares_inherits(root, repo_rel):
            return None
        committed = True
        profiles = scan_profile_set(root, manifest)
        derived = next((p for p in profiles if p.rel_path == repo_rel), None)
        if derived is None:
            return _unresolved_profile_page(
                repo_rel,
                [
                    Finding(
                        "artifact-parse",
                        "error",
                        "the profile scan did not reach this file",
                        repo_rel,
                    )
                ],
            )
        return _render_resolved_profile(profiles, derived)
    except Exception as e:  # noqa: BLE001 - fail closed, never back to the raw file
        if not committed:
            return None  # not established as a profile: not this page's file
        return _unresolved_profile_page(
            repo_rel,
            [Finding("artifact-parse", "error", f"resolving this profile failed: {e}", repo_rel)],
        )


def _resolved_profile_pages(root: str, manifest: Manifest) -> list[tuple[str, str]]:
    """Every inheriting profile as its rootPath-relative viewer path and resolved
    page, so a static export carries what the local server renders."""
    profiles = scan_profile_set(root, manifest)
    out: list[tuple[str, str]] = []
    for p in profiles:
        if not isinstance((p.frontmatter or {}).get("inherits"), str):
            continue
        rel = _relative_to_root(p.rel_path, manifest["rootPath"])
        if rel is None:
            continue  # outside the context root: not servable
        out.append((rel, _render_resolved_profile(profiles, p)))
    return out


def _docsify_config(root: str, manifest: Manifest, name_html: str, findings: list[Finding]) -> str:
    """The Docsify config blob in the Node SDK's exact key order, script-escaped.
    Appends the homepage viewer-path-missing warning when the configured homepage
    does not resolve."""
    viewer_cfg = manifest.get("viewer") or {}
    agents_label = viewer_cfg.get("agentsLabel")
    category_emojis = viewer_cfg.get("categoryEmojis") or {}

    def emoji_for(c: str) -> str:
        configured = category_emojis.get(c)
        return configured if configured is not None else CATEGORY_EMOJI[c]

    return _json_for_script(
        {
            "name": name_html,
            # Hash navigation for the logo/title link: #/ re-routes to the
            # homepage inside the SPA instead of a full page reload.
            "nameLink": "#/",
            # Per-page classification badge (top-right chip): the boot script
            # resolves the current route against the served index using these.
            "lejiIndexRel": _relative_to_root(effective_index_path(manifest), manifest["rootPath"]),
            "lejiBootPath": _relative_to_root(manifest["bootProfilePath"], manifest["rootPath"]),
            "lejiAgentsPrefix": _relative_to_root(
                effective_agent_profiles_path(manifest), manifest["rootPath"]
            ),
            "lejiAgentsLabel": agents_label if agents_label is not None else DEFAULT_AGENTS_LABEL,
            "lejiCategories": {c: f"{emoji_for(c)} {CATEGORY_LABELS[c]}" for c in CATEGORY_IDS},
            # The homepage is rootPath-relative; teams whose layer has a real
            # landing page point at it instead of the seeded overview.
            "homepage": _effective_homepage(root, manifest, findings),
            # After the homepage above, so the two warnings land in the Node order.
            "themeColor": _resolve_theme_color(manifest, findings),
            # Read by the boot script's powered-by plugin; false removes the mark.
            "lejiPoweredBy": viewer_cfg.get("poweredBy") is not False,
        }
    )


def _assemble_sidebar(
    root: str, manifest: Manifest, entries: list[dict], findings: list[Finding]
) -> str:
    """Assemble the current sidebar for a layer entirely in memory: pins (with
    boot-pin replacement), pin-filtered groups, and the homepage-excluded
    reference tree. Used by generation and by the serve path, which rebuilds it
    per fetch so a long-running viewer never shows a deleted or moved document."""
    governed_paths = {e["path"] for e in entries}

    # Pinned pages: resolved to servable rels. A pin is a path string (label
    # derived) or `{ path, label }` (a curated label, emoji welcome). Missing or
    # out-of-root pins are surfaced, never silently dropped. Pinning the boot
    # profile replaces its default line, so its label is the team's to curate.
    viewer_cfg = manifest.get("viewer") or {}
    pins: list[SidebarEntry] = []
    pinned_root_rel: set[str] = set()
    boot_pinned = False
    for pin in viewer_cfg.get("pins") or []:
        pin_path = pin if isinstance(pin, str) else pin["path"]
        pin_label = None if isinstance(pin, str) else pin.get("label")
        # Pins are repo-relative canonically; a rootPath-relative pin under the
        # context root is accepted too (same tolerance as homepage/logo/favicon).
        # repo_rel tracks where the file actually lives for reads and comparisons.
        rel = _relative_to_root(pin_path, manifest["rootPath"])
        repo_rel = pin_path
        if rel is None or not (Path(root) / pin_path).is_file():
            base = strip_slash(manifest["rootPath"])
            alt = re.sub(r"^\./", "", strip_slash(pin_path))
            alt_repo = f"{base}/{alt}" if base and base != "." else alt
            if (Path(root) / alt_repo).is_file():
                rel = alt
                repo_rel = alt_repo
            else:
                rel = None
        if rel is None:
            findings.append(
                Finding(
                    "viewer-pin-missing",
                    "warning",
                    f'viewer.pins entry "{pin_path}" does not resolve to a markdown file under rootPath',
                    pin_path,
                )
            )
            continue
        if repo_rel == manifest["bootProfilePath"]:
            boot_pinned = True
        pinned_root_rel.add(rel)
        pins.append(
            SidebarEntry(
                rel=rel,
                title=pin_label if pin_label is not None else _sidebar_label(root, repo_rel, rel),
            )
        )

    # The generated Manifest page is always pinned as system chrome, ahead of the
    # user's own pins. Served via a dedicated route from the viewer dir under a
    # reserved underscore name (see the serve handler / build_viewer), so its rel is
    # the literal "_manifest.md" and it needs no on-disk existence check under root.
    if "_manifest.md" not in pinned_root_rel:
        pins.insert(0, SidebarEntry(rel="_manifest.md", title="📄 Manifest"))
        pinned_root_rel.add("_manifest.md")

    # A pin replaces the doc's default sidebar position: pinned docs render in
    # the top zone only, dropped from their group listing like the tree below.
    groups = [
        SidebarGroup(label=g.label, entries=[e for e in g.entries if e.rel not in pinned_root_rel])
        for g in build_sidebar_groups(root, manifest, entries)
    ]
    # The homepage already has a fixed entry point (the sidebar title links to it),
    # so like a pin it never re-lists in the reference tree.
    homepage_rel = _effective_homepage(root, manifest, [])
    tree = [
        n
        for n in _reference_tree(root, manifest, governed_paths)
        if n.rel not in pinned_root_rel and n.rel != homepage_rel
    ]
    return build_sidebar(manifest, groups, tree, pins, boot_pinned=boot_pinned)


def generate_viewer(root: str, manifest: Manifest) -> ViewerResult:
    """Write the Docsify index.html (frontmatter-stripping hook included) and
    the projected _sidebar.md into the context root."""
    result = generate_index(root, manifest)
    # Don't project a viewer from a tree that can't be indexed cleanly (a
    # category-conflict, a malformed or dangling index entry): surface the errors
    # and write nothing, the same refusal write_index makes.
    if any(f.severity == "error" for f in result.findings):
        return ViewerResult(written=[], findings=result.findings, entries=0)
    entries = (result.index or {}).get("entries", [])
    findings_early: list[Finding] = []

    viewer_cfg = manifest.get("viewer") or {}
    # Display title: viewer.title override, else the context layer name.
    display_title = viewer_cfg.get("title") or manifest["name"]
    # The sidebar header. A configured brand logo renders as a centered block (the
    # wordmark IS the title, the way hand-built dashboards do it); the default Leji
    # mark renders small and inline beside the title text. Raw <img> HTML inside
    # `name` rather than Docsify's `logo` option (which prepends basePath /content/
    # and 404s). Title is HTML-escaped; the strict CSP (script-src 'self') kills handlers.
    logo = viewer_cfg.get("logo")
    logo_url = _html_escape(_resolve_logo(root, manifest["rootPath"], logo))
    if logo:
        name_html = (
            f'<img src="{logo_url}" alt="{_html_escape(display_title)}" '
            'style="max-width:180px;margin:10px auto;display:block;" />'
        )
    else:
        name_html = (
            f'<img src="{logo_url}" alt="" '
            'style="height:1.7rem;vertical-align:middle;margin-right:0.45rem" />'
            + _html_escape(display_title)
        )
    # Favicon: a configured path is served from the content mount; unset falls back
    # to the vendored Leji mark.
    favicon = viewer_cfg.get("favicon")
    if favicon:
        favicon_rel = _resolve_viewer_rel(root, manifest["rootPath"], favicon)
        favicon_url = _html_escape(
            "/content/" + (favicon_rel if favicon_rel is not None else strip_slash(favicon))
        )
    else:
        favicon_url = _html_escape(DEFAULT_LOGO)
    config = _docsify_config(root, manifest, name_html, findings_early)
    # Mermaid is on unless explicitly disabled. When off, the two mermaid scripts
    # are omitted from the page and their assets are not copied (a leaner viewer).
    mermaid_enabled = viewer_cfg.get("mermaid") is not False
    mermaid_scripts = (
        '\n      <script src="assets/mermaid.min.js"></script>'
        '\n      <script src="assets/docsify-mermaid.js"></script>'
        if mermaid_enabled
        else ""
    )
    # One pass over the template with a resolver map, never four sequential
    # replaces: a sequential pass re-scans what the previous one substituted, so a
    # manifest string like "{{DOCSIFY_CONFIG}}" in viewer.title or viewer.favicon
    # would be expanded a second time and break out of the element it landed in.
    substitutions = {
        "LEJI_NAME_HTML": _html_escape(display_title),
        "FAVICON_URL": favicon_url,
        "DOCSIFY_CONFIG": config,
        "MERMAID_SCRIPTS": mermaid_scripts,
    }
    doc_html = PLACEHOLDER_RE.sub(
        lambda m: substitutions.get(m.group(1), m.group(0)),
        (templates_dir() / "viewer" / "index.html").read_text(encoding="utf-8"),
    )
    sidebar = _assemble_sidebar(root, manifest, entries, findings_early)

    root_dir = strip_slash(manifest["rootPath"]) or "."
    findings: list[Finding] = [*result.findings, *findings_early]
    written: list[str] = []

    # Refuse to write through a symlink that escapes the layer root (a symlinked
    # content root, or a pre-placed target file). resolved_within_root resolves the
    # nearest existing ancestor, so a not-yet-existing target under a symlinked
    # directory is caught before mkdir/write can escape.
    def write_within(rel: str, content: bytes | str) -> None:
        abs_path = Path(root) / rel
        if not resolved_within_root(root, abs_path):
            findings.append(
                Finding(
                    "artifact-parse",
                    "error",
                    f"viewer path {rel} resolves outside the layer root",
                    rel,
                )
            )
            return
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            abs_path.write_bytes(content)
        else:
            abs_path.write_text(content, encoding="utf-8")
        written.append(rel)

    # The viewer is contained under rootPath/.leji/viewer/ (gitignored), so it never
    # collides with the user's own files in the context root and keeps the layer clean.
    viewer_dir = ".leji/viewer" if root_dir == "." else f"{root_dir}/.leji/viewer"
    for name, content in (("index.html", doc_html), ("_sidebar.md", sidebar)):
        write_within(f"{viewer_dir}/{name}", content)

    # Copy every vendored viewer asset (Docsify core, theme, the plugins, and the
    # webfonts) alongside index.html (no remote CDN). The provenance note is
    # documentation, never shipped.
    assets_src = templates_dir() / "viewer" / "assets"
    assets_rel_dir = f"{viewer_dir}/assets"
    for asset_path in sorted(p for p in assets_src.iterdir() if p.is_file()):
        if asset_path.name == "PROVENANCE.txt" or asset_path.name.startswith("."):
            continue
        if not mermaid_enabled and asset_path.name in MERMAID_ASSETS:
            continue
        write_within(f"{assets_rel_dir}/{asset_path.name}", asset_path.read_bytes())

    # The overview/home page is committed, user-owned content (not viewer chrome):
    # seeded once and never overwritten. On regeneration, only the marked map block
    # is refreshed; if the owner removed the markers, the page is left entirely alone.
    overview_rel = "overview.md" if root_dir == "." else f"{root_dir}/overview.md"
    overview_abs = Path(root) / overview_rel
    if not overview_abs.is_file():
        write_within(overview_rel, _build_overview_seed(manifest, entries))
    elif resolved_within_root(root, overview_abs):
        existing = overview_abs.read_text(encoding="utf-8")
        start = existing.find(MAP_START)
        end = existing.find(MAP_END)
        if start >= 0 and end > start:
            updated = (
                existing[:start] + _map_block(manifest, entries) + existing[end + len(MAP_END) :]
            )
            if updated != existing:
                overview_abs.write_text(updated, encoding="utf-8")
        else:
            findings.append(
                Finding(
                    "overview-markers-missing",
                    "warning",
                    "overview.md has no generated-map markers; left as-is (map not refreshed)",
                    overview_rel,
                )
            )

    # The Manifest page: generated chrome, exactly like _sidebar.md. Written into the
    # gitignored viewer dir under a reserved underscore name (collision-free with the
    # user's own files) and served via a dedicated content route (never a committed
    # file at the context root, so no diff churn). Regenerated every run; pinned.
    write_within(
        f"{viewer_dir}/_manifest.md", build_manifest_page(manifest, mount_status(root, manifest))
    )

    return ViewerResult(written=written, findings=findings, entries=len(entries))


# The protect-your-context warning surfaced by `leji viewer build` (in stdout and
# as a comment in the exported index.html): a context layer is sensitive and the
# static export should not be hosted somewhere public.
PROTECT_WARNING = (
    "This is your context layer (identity, invariants, decisions, sometimes sensitive "
    "internal knowledge). Host the exported folder behind internal authentication, not a "
    "public or shared bucket where it could be indexed or leaked. Active file types "
    "(.htm, .html, .js, .mjs, .xhtml) are left out of the exported content: a static "
    "host would serve them as same-origin documents that execute with no policy."
)

# The first bytes `viewer build` writes into an exported index.html. A target
# directory carrying this marker is a previous export and may be cleared; any other
# non-empty directory is somebody's content and is never removed.
EXPORT_MARKER = "<!--\n  Leji viewer (leji viewer build).\n"


def _clearable_export(out_abs: Path) -> bool:
    """True when the export may clear out_abs: it is absent, an empty directory, or a
    previous export. Anything else (a file, a populated directory the exporter did not
    write) is content the tool has no business deleting."""
    if not out_abs.exists():
        return True
    if not out_abs.is_dir():
        return False
    if not any(out_abs.iterdir()):
        return True
    index = out_abs / "index.html"
    if not index.is_file():
        return False
    try:
        return index.read_text(encoding="utf-8").startswith(EXPORT_MARKER)
    except (OSError, UnicodeDecodeError):
        return False


@dataclass
class BuildResult:
    out: str
    findings: list[Finding] = field(default_factory=list)


def build_viewer(root: str, manifest: Manifest, out_rel: Optional[str] = None) -> BuildResult:
    """Export a self-contained static viewer into out_rel using the same URL contract
    the server materializes (chrome at the web root, markdown under /content/), so any
    static host serves it as-is. Regenerates first, then copies chrome and content docs
    into a clean output dir; the exported index.html carries the protect warning as a
    comment."""
    import shutil

    gen = generate_viewer(root, manifest)
    root_abs = Path(root).resolve()
    root_dir = strip_slash(manifest["rootPath"]) or "."
    content_abs = root_abs if root_dir == "." else root_abs / root_dir
    if out_rel is None:
        out_abs = content_abs / ".leji" / "viewer-dist"
    elif Path(out_rel).is_absolute():
        out_abs = Path(out_rel)
    else:
        out_abs = (root_abs / out_rel).resolve()
    out_display = os.path.relpath(out_abs, root_abs)

    # Never run the destructive export when generation failed (e.g. a symlinked
    # rootPath escaping the layer): the viewer was not written, and the rmtree
    # below would otherwise delete an escaped output path.
    if any(f.severity == "error" for f in gen.findings):
        return BuildResult(out=out_display, findings=gen.findings)
    # Contain the output (custom or default) before the rmtree: it must stay inside
    # the repo and clear of the context root in BOTH directions. Exporting into
    # governed content deletes it, and exporting into a directory that holds the
    # context root deletes the layer itself. The default output lives under the
    # dot-dir the walk skips, so only a caller-supplied --out is measured against
    # the context root.
    ref = out_rel if out_rel is not None else out_display
    collides = out_rel is not None and (
        str(out_abs).startswith(str(content_abs) + os.sep)
        or str(content_abs).startswith(str(out_abs) + os.sep)
    )
    if (
        out_abs == root_abs
        or out_abs == content_abs
        or not resolved_within_root(str(root_abs), out_abs)
        or collides
    ):
        raise RuntimeError(
            f'refusing to build the viewer into "{ref}": --out must be a path inside '
            "the repository, and must not be the repository root, the context root, "
            "inside the context root, or a directory containing the context root"
        )
    # Never remove a directory this command did not write: the export clears a
    # previous export, and refuses anything else that is already occupied.
    if not _clearable_export(out_abs):
        raise RuntimeError(
            f'refusing to build the viewer into "{ref}": the target exists and is '
            "neither empty nor a previous viewer export; remove it or pick another --out"
        )
    viewer_abs = content_abs / ".leji" / "viewer"
    out_content = out_abs / "content"

    # Clean rebuild so a removed source file never lingers in the export.
    shutil.rmtree(out_abs, ignore_errors=True)
    out_content.mkdir(parents=True, exist_ok=True)

    # Copy the content root to /content, skipping dotfiles/dot-dirs and symlinks: an
    # export is a self-contained snapshot, so .git/.env/.secret.md could leak and a
    # symlink could pull in outside content. Mirrors the Node/Go export (skip any
    # dot-prefixed segment at every level).
    def _ignore(directory: str, names: list[str]) -> set[str]:
        skip: set[str] = set()
        for name in names:
            full = Path(directory) / name
            if name.startswith(".") or full.is_symlink():
                skip.add(name)
            # Second line of defense behind the --out containment above: the export
            # never walks into itself, whatever the output path turns out to be.
            elif full == out_abs:
                skip.add(name)
            # Active types never ride along: the export is meant to be hosted, and a
            # static host would serve them as same-origin documents with no policy.
            elif full.is_file() and full.suffix.lower() in ACTIVE_EXTENSIONS:
                skip.add(name)
        return skip

    shutil.copytree(content_abs, out_content, ignore=_ignore, dirs_exist_ok=True)
    # An inheriting agent profile exports resolved, exactly as the local server
    # renders it: the copied file is only its own half of the profile.
    for rel, page in _resolved_profile_pages(str(root_abs), manifest):
        target = out_content / rel
        if not resolved_within_root(str(out_content), target):
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(page, encoding="utf-8")
    # The generated sidebar is served as if at the content root.
    shutil.copy2(viewer_abs / "_sidebar.md", out_content / "_sidebar.md")
    # The generated Manifest page, likewise served as if at the content root.
    shutil.copy2(viewer_abs / "_manifest.md", out_content / "_manifest.md")
    # The viewer assets at the web root.
    shutil.copytree(viewer_abs / "assets", out_abs / "assets", dirs_exist_ok=True)
    # index.html at the web root, with the protect-your-context warning prepended.
    index_html = (viewer_abs / "index.html").read_text(encoding="utf-8")
    (out_abs / "index.html").write_text(
        f"<!--\n  Leji viewer (leji viewer build).\n  {PROTECT_WARNING}\n-->\n{index_html}",
        encoding="utf-8",
    )

    return BuildResult(out=out_display, findings=gen.findings)


CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}


def _url_path_to_rel(url_path: str) -> str:
    """A request URL path as a clean relative route key.

    Separators fold to "/" and the path is cleaned against a root, so one request
    has one route key on any platform — os.path.normpath follows the host and
    answered differently on Windows, missing every "content/" route test.
    Canonicalization only; the mount enforces containment.
    """
    return posixpath.normpath("/" + url_path.replace("\\", "/")).lstrip("/")


class _SafeViewerHandler(BaseHTTPRequestHandler):
    """Virtual-mount handler, no symlinks: the contained viewer chrome
    (rootPath/.leji/viewer/) is served at `/`, and the layer's markdown
    (rootPath/) under `/content/`. The internal .leji path is reachable only
    through these mounts, never by a direct URL. A local preview, not a host.

    The generated sidebar and the stored context index are served live from the
    tree behind a fingerprint cache, so a long-running viewer never shows a
    deleted or moved document."""

    root_abs: str = ""
    base: str = ""
    content_abs: str = ""
    viewer_abs: str = ""
    access_log: Optional[Callable[[str], None]] = None
    # Live-sidebar cache shared across requests (class attribute on the bound
    # subclass), guarded by a lock: ThreadingHTTPServer handles concurrently.
    _cache: Optional[dict] = None
    _cache_lock: threading.Lock = threading.Lock()

    def log_message(self, *args):  # type: ignore[override]
        pass

    _status_code: int = 200
    # The policy sent with the current response: the shell policy by default, the
    # inert one once the route is known to be under the content mount.
    _csp: str = CSP_CHROME

    def send_response(self, code, message=None):  # type: ignore[override]
        self._status_code = code
        super().send_response(code, message)

    def end_headers(self) -> None:  # type: ignore[override]
        """Policy headers ride every response, not just the SPA shell: a document
        served straight out of /content/ is same-origin and would otherwise run with
        no policy at all. Overridden here so no response path can forget them."""
        self.send_header("x-content-type-options", "nosniff")
        self.send_header("content-security-policy", self._csp)
        super().end_headers()

    def _write_body(self, body: bytes) -> None:
        """Write a response body, except on HEAD, which carries headers only. Node
        and Go suppress the body themselves; BaseHTTPRequestHandler does not."""
        if self.command != "HEAD":
            self.wfile.write(body)

    def _serve_from(self, mount_root: str, sub: str, inert: bool = False) -> None:
        # Reject absolute/drive/parent-traversal paths, then realpath + commonpath-contain
        # before any filesystem access. `inert` marks the layer's own content mount,
        # whose files are never given an active content type however they are named.
        #
        # An embedded NUL (e.g. GET /content/%00) makes every path call below raise
        # ValueError; Node and Go answer a clean 404, so answer one here rather than
        # letting the handler blow up.
        if "\x00" in sub:
            self.send_response(404)
            self.end_headers()
            self._write_body(b"not found")
            return
        root_real = os.path.realpath(mount_root)
        norm = os.path.normpath(sub).replace(os.sep, "/") if sub else ""
        if norm in (".", "/"):
            norm = ""
        if norm and (
            os.path.isabs(sub)
            or sub.startswith(("/", "\\"))
            or re.match(r"^[A-Za-z]:", sub) is not None
            or norm == ".."
            or norm.startswith("../")
        ):
            self.send_response(403)
            self.end_headers()
            self._write_body(b"forbidden")
            return
        target = (
            os.path.join(root_real, "index.html") if norm == "" else os.path.join(root_real, norm)
        )
        real = os.path.realpath(target)
        try:
            inside = os.path.commonpath([root_real, real]) == root_real
        except ValueError:
            inside = False
        if not inside:
            self.send_response(403)
            self.end_headers()
            self._write_body(b"forbidden")
            return
        if os.path.isdir(real):
            real = os.path.realpath(os.path.join(real, "index.html"))
            try:
                inside = os.path.commonpath([root_real, real]) == root_real
            except ValueError:
                inside = False
        if not inside:
            self.send_response(403)
            self.end_headers()
            self._write_body(b"forbidden")
            return
        try:
            with open(real, "rb") as fh:
                body = fh.read()
        except OSError:
            self.send_response(404)
            self.end_headers()
            self._write_body(b"not found")
            return
        ext = os.path.splitext(real)[1].lower()
        ct = CONTENT_TYPES.get(ext, "application/octet-stream")
        if inert and ext in ACTIVE_EXTENSIONS:
            ct = "text/plain; charset=utf-8"
        self.send_response(200)
        self.send_header("content-type", ct)
        self.end_headers()
        self._write_body(body)

    def _serve_text(self, content_type: str, body: str) -> None:
        self.send_response(200)
        self.send_header("content-type", content_type)
        self.end_headers()
        self._write_body(body.encode("utf-8"))

    def _tree_fingerprint(self) -> str:
        """One stat pass over leji.json + every markdown file under the content
        root (paths, mtimes, sizes — no content reads). walk_tree skips dotdirs,
        so the viewer's own artifacts never invalidate the cache."""
        parts: list[str] = []

        def add(rel: str) -> None:
            try:
                st = os.stat(os.path.join(self.root_abs, rel))
                parts.append(f"{rel}\x00{st.st_mtime_ns}\x00{st.st_size}")
            except OSError:
                parts.append(f"{rel}\x00gone")

        add("leji.json")
        for rel in walk_tree(self.root_abs, self.base or "."):
            add(rel)
        return "\n".join(parts)

    def _refresh_cache(self, key: str) -> Optional[dict]:
        """Rebuild the live cache for key; None when the manifest is missing or
        the tree will not index cleanly (callers then fall back to the generated
        artifact)."""
        load = load_manifest(self.root_abs)
        if load.manifest is None:
            return None
        idx = generate_index(self.root_abs, load.manifest)
        if any(f.severity == "error" for f in idx.findings):
            return None
        entries = (idx.index or {}).get("entries", [])
        body = _assemble_sidebar(self.root_abs, load.manifest, entries, [])
        cache = {
            "key": key,
            "body": body,
            "index_json": serialize_index(idx.index) if idx.index is not None else None,
        }
        type(self)._cache = cache
        return cache

    def do_GET(self) -> None:  # noqa: N802
        from urllib.parse import unquote, urlsplit

        try:
            self._do_get_inner(unquote, urlsplit)
        finally:
            if self.access_log is not None:
                log = type(self).access_log
                if log is not None:
                    # The method and request target are attacker-controlled bytes;
                    # sanitized so terminal escapes never reach the operator's
                    # console. Node's parser rejects them outright and Go re-encodes
                    # the target, so this is the Python leg of the same guarantee.
                    log(f"{_log_safe(self.command)} {_log_safe(self.path)} {self._status_code}")

    # HEAD answers exactly like GET with the body suppressed (see _write_body), the
    # way the Node and Go servers do; the default handler would 501 instead.
    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def _do_get_inner(self, unquote, urlsplit) -> None:
        # One handler instance serves every request on a kept-alive connection, so
        # the per-response policy starts from the shell default each time.
        self._csp = CSP_CHROME
        # Loopback binding alone does not stop DNS rebinding: a hostile page whose
        # name resolves to 127.0.0.1 reaches this server with its own Host. Only the
        # loopback names the viewer is actually addressed by are answered. The port is
        # deliberately not part of the test: a rebound request carries the right port
        # anyway, so matching it adds nothing. Don't "fix" this by checking it.
        if not _loopback_host(self.headers.get("Host")):
            self.send_response(403)
            self.end_headers()
            self._write_body(b"forbidden")
            return
        try:
            # A malformed percent-encoding throws; answer 400 rather than crash.
            url_path = unquote(urlsplit(self.path).path, errors="strict")
        except (ValueError, UnicodeDecodeError):
            self.send_response(400)
            self.end_headers()
            self._write_body(b"bad request")
            return
        rel = _url_path_to_rel(url_path)
        # The content mount serves the layer's own files; they get the inert policy.
        if rel == "content" or rel.startswith("content/"):
            self._csp = CSP_CONTENT
        # Refuse any dotfile or VCS-internal segment in the REQUEST path: the .leji
        # viewer dir is reached only through the mounts below, never by direct URL.
        for seg in re.split(r"[/\\]", rel):
            if seg == ".git" or (seg.startswith(".") and seg not in (".", "")):
                self.send_response(404)
                self.end_headers()
                self._write_body(b"not found")
                return
        # The generated sidebar lives in the viewer dir but is served as if at the
        # content root, so Docsify's basePath /content/ + _sidebar alias resolve it.
        # Docsify fetches it once per page load, so it is rebuilt from the live tree
        # on every request: a long-running server never shows a deleted or moved
        # document. When the tree is mid-edit and will not index cleanly, fall back
        # to the last generated artifact rather than failing the dashboard.
        if rel == "content/_sidebar.md":
            try:
                with type(self)._cache_lock:
                    key = self._tree_fingerprint()
                    cache = type(self)._cache
                    if cache is None or cache["key"] != key:
                        cache = self._refresh_cache(key)
                if cache is not None:
                    self._serve_text("text/markdown; charset=utf-8", cache["body"])
                    return
            except Exception:  # noqa: BLE001 - fall through to the generated artifact
                pass
            self._serve_from(self.viewer_abs, "_sidebar.md")
            return
        # The stored context index is served live (same fingerprint cache as the
        # sidebar), so per-page classification badges never disagree with the tree.
        if rel.startswith("content/"):
            try:
                load = load_manifest(self.root_abs)
                idx_rel = (
                    _relative_to_root(
                        effective_index_path(load.manifest), load.manifest["rootPath"]
                    )
                    if load.manifest is not None
                    else None
                )
                if (
                    load.manifest is not None
                    and idx_rel is not None
                    and rel == f"content/{idx_rel}"
                ):
                    with type(self)._cache_lock:
                        key = self._tree_fingerprint()
                        cache = type(self)._cache
                        if cache is None or cache["key"] != key:
                            cache = self._refresh_cache(key)
                    if (
                        cache is not None
                        and cache["key"] == key
                        and cache["index_json"] is not None
                    ):
                        self._serve_text("application/json; charset=utf-8", cache["index_json"])
                        return
            except Exception:  # noqa: BLE001 - fall through to the stored artifact
                pass
        # The generated Manifest page lives in the viewer dir (gitignored chrome) but
        # is linked from the sidebar and fetched under the content root, like
        # _sidebar.md. Reserved underscore name; served from the last generation.
        if rel == "content/_manifest.md":
            self._serve_from(self.viewer_abs, "_manifest.md")
            return
        if rel == "content" or rel.startswith("content/"):
            sub = "" if rel == "content" else rel[len("content/") :]
            # An agent profile that declares `inherits` is served resolved: the file
            # on disk is one half, and presenting it as the effective profile is the
            # thing a consumer must not do. So this branch fails closed. If anything
            # at all goes wrong, a file that declares `inherits` still gets a findings
            # page; only a file that is not half a profile falls through to disk.
            if sub.endswith(".md"):
                repo_rel = f"{self.base}/{sub}" if self.base and self.base != "." else sub
                page: Optional[str] = None
                try:
                    load = load_manifest(self.root_abs)
                    page = (
                        None
                        if load.manifest is None
                        else resolved_profile_page(self.root_abs, load.manifest, repo_rel)
                    )
                    if (
                        page is None
                        and load.manifest is None
                        and _declares_inherits(self.root_abs, repo_rel)
                    ):
                        page = _unresolved_profile_page(
                            repo_rel,
                            [
                                Finding(
                                    "artifact-parse",
                                    "error",
                                    "the layer manifest could not be read",
                                    "leji.json",
                                )
                            ],
                        )
                except Exception as e:  # noqa: BLE001 - fail closed, never the raw file
                    page = (
                        _unresolved_profile_page(
                            repo_rel,
                            [
                                Finding(
                                    "artifact-parse",
                                    "error",
                                    f"the viewer could not resolve this profile: {e}",
                                    repo_rel,
                                )
                            ],
                        )
                        if _declares_inherits(self.root_abs, repo_rel)
                        else None
                    )
                if page is not None:
                    self._serve_text("text/markdown; charset=utf-8", page)
                    return
            self._serve_from(self.content_abs, sub, inert=True)
            return
        # Everything else (`/`, /index.html, /assets/*) is viewer chrome.
        self._serve_from(self.viewer_abs, rel)


def serve_viewer(
    root: str,
    port: int,
    root_rel: str = "",
    log: Optional[Callable[[str], None]] = None,
) -> ThreadingHTTPServer:
    """Serve the viewer at the web root, bound to 127.0.0.1 (local preview, never
    hosting): viewer chrome (rootPath/.leji/viewer/) at `/`, the layer's markdown
    (rootPath/) under `/content/`, no symlinks. `log`, when set, receives one
    terse access-log line per request. Caller runs serve_forever() / shutdown()."""
    root_abs = os.path.realpath(str(Path(root).resolve()))
    base = strip_slash(root_rel)
    content_abs = os.path.join(root_abs, base) if base and base != "." else root_abs
    # The CLI passes a schema-validated rootPath, but a direct SDK caller could pass
    # an escaping root_rel (e.g. ".."); refuse to mount content outside the layer root.
    if not resolved_within_root(root_abs, Path(content_abs)):
        raise ValueError(f'viewer root "{root_rel}" escapes the layer root')
    viewer_abs = os.path.join(content_abs, ".leji", "viewer")
    handler_cls = type(
        "_BoundSafeViewerHandler",
        (_SafeViewerHandler,),
        {
            "root_abs": root_abs,
            "base": base if base != "." else "",
            "content_abs": content_abs,
            "viewer_abs": viewer_abs,
            "access_log": staticmethod(log) if log is not None else None,
            "_cache": None,
            "_cache_lock": threading.Lock(),
        },
    )
    return ThreadingHTTPServer(("127.0.0.1", port), handler_cls)


def open_browser(url: str) -> None:
    """Best-effort open of url in the default browser (--open / `leji view`). Never
    raises or blocks: opening is a convenience, not part of serving. Mirrors the Node
    opener (open / cmd start / xdg-open), spawned detached."""
    import subprocess
    import sys

    if sys.platform == "darwin":
        cmd = ["open", url]
    elif sys.platform.startswith("win"):
        cmd = ["cmd", "/c", "start", "", url]
    else:
        cmd = ["xdg-open", url]
    try:
        subprocess.Popen(  # noqa: S603 - fixed opener, url is local
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        pass  # opening the browser is best-effort
