"""Static viewer generation and local preview, mirroring the Node SDK.

Presentation is non-normative; this is the reference projection of
context-index.json into a browsable surface (Docsify), plus a localhost-only
static server so `leji viewer serve` works the same in both ecosystems.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional

import re

from .findings import Finding
from .fsx import resolved_within_root, strip_slash
from .indexgen import generate_index
from .manifest import CATEGORY_IDS, Manifest
from .schemas import templates_dir

CATEGORY_LABELS = {
    "domain": "Domain",
    "system": "System",
    "practice": "Practice",
    "governance": "Governance",
    "decisions": "Decisions",
}

# Default emoji shown beside each category group in the sidebar; overridable per
# group via manifest viewer.categoryEmojis. Baked identically into every SDK so the
# generated sidebar stays byte-identical.
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


def _resolve_logo(logo: Optional[str]) -> str:
    """Resolve the viewer logo URL: a configured path is served from the content
    mount (or used as-is when absolute); unset falls back to the vendored mark."""
    if not logo:
        return DEFAULT_LOGO
    if logo.startswith("/") or re.match(r"^https?://", logo):
        return logo
    return "/content/" + strip_slash(logo)


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


def _md_link_text(s: str) -> str:
    """Escape a string for Markdown link text (`[...]`): backslash, brackets."""
    return re.sub(r"[\\\[\]]", lambda m: "\\" + m.group(0), s)


def _md_link_dest(s: str) -> str:
    """Escape a string for a Markdown link destination (`(...)`): backslash, parens."""
    return re.sub(r"[\\()]", lambda m: "\\" + m.group(0), s)


def build_sidebar(manifest: Manifest, entries: list[dict]) -> str:
    """Deterministic Docsify sidebar: categories in canonical order, entries
    sorted by path, paths relative to rootPath. Ungrouped entries (the boot
    profile) sit above a divider; the category groups follow below it, giving
    the viewer a two-tier sidebar."""
    top_lines: list[str] = []
    boot = _relative_to_root(manifest["bootProfilePath"], manifest["rootPath"])
    if boot:
        top_lines.append(f"- [🤖 Boot profile]({_md_link_dest(boot)})")
    group_lines: list[str] = []
    for category in CATEGORY_IDS:
        in_category = []
        for entry in entries:
            if entry.get("category") != category:
                continue
            rel = _relative_to_root(entry["path"], manifest["rootPath"])
            if rel is not None:
                in_category.append((entry["title"], rel))
        if not in_category:
            continue
        viewer_cfg = manifest.get("viewer") or {}
        emoji = (viewer_cfg.get("categoryEmojis") or {}).get(category) or CATEGORY_EMOJI[category]
        group_lines.append(f"- {emoji} {CATEGORY_LABELS[category]}")
        for title, rel in in_category:
            group_lines.append(f"  - [{_md_link_text(title)}]({_md_link_dest(rel)})")
    sections = ["\n".join(s) for s in (top_lines, group_lines) if s]
    return "\n\n---\n\n".join(sections) + "\n"


# The overview homepage is seeded once and then user-owned. The layer map lives
# between these markers; `leji viewer` regenerates only the marked block, leaving
# the surrounding prose untouched.
MAP_START = "<!-- leji:generated-map:start -->"
MAP_END = "<!-- leji:generated-map:end -->"


def _mermaid_id(slug: str) -> str:
    """A mermaid id from a slug: safe characters only, never colliding with `boot`."""
    return "n_" + re.sub(r"[^a-zA-Z0-9]", "_", slug)


def _mermaid_label(text: str) -> str:
    """A mermaid node label: drop the characters that would break `["..."]`, and
    collapse newlines so a multi-line title can't break out of the node."""
    return re.sub(r"[\r\n]+", " ", re.sub(r'["\[\]]', "", text))


def build_layer_map(manifest: Manifest, entries: list[dict]) -> str:
    """A deterministic mermaid flowchart of the layer: boot profile -> categories
    -> documents, derived from the live index in canonical order. The node id is
    the stable index id (not the path)."""
    lines = ["flowchart TD", '  boot["🤖 Boot profile"]']
    for category in CATEGORY_IDS:
        in_category = [e for e in entries if e.get("category") == category]
        if not in_category:
            continue
        viewer_cfg = manifest.get("viewer") or {}
        emoji = (viewer_cfg.get("categoryEmojis") or {}).get(category) or CATEGORY_EMOJI[category]
        cat_id = "cat_" + category
        lines.append(f'  {cat_id}["{emoji} {CATEGORY_LABELS[category]}"]')
        lines.append(f"  boot --> {cat_id}")
        for entry in in_category:
            node_id = _mermaid_id(entry["id"])
            lines.append(f'  {node_id}["{_mermaid_label(entry["title"])}"]')
            lines.append(f"  {cat_id} --> {node_id}")
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


def generate_viewer(root: str, manifest: Manifest) -> ViewerResult:
    """Write the Docsify index.html (frontmatter-stripping hook included) and
    the projected _sidebar.md into the context root."""
    result = generate_index(root, manifest)
    entries = (result.index or {}).get("entries", [])

    # The logo + name render as the Docsify sidebar title. The logo is raw HTML
    # inside `name` (an <img> resolved relative to the served page) rather than
    # Docsify's own `logo` option, which prepends basePath (/content/) and would
    # 404 the asset. The name is HTML-escaped; the strict CSP neutralizes handlers.
    viewer_cfg = manifest.get("viewer") or {}
    logo_url = _html_escape(_resolve_logo(viewer_cfg.get("logo")))
    name_html = (
        f'<img src="{logo_url}" alt="" '
        'style="height:1.7rem;vertical-align:middle;margin-right:0.45rem" />'
        + _html_escape(manifest["name"])
    )
    theme_color = (viewer_cfg.get("theme") or {}).get("primary") or DEFAULT_THEME_COLOR
    config = json.dumps(
        {"name": name_html, "homepage": "overview.md", "themeColor": theme_color},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    # Script-safe: the blob lives inside a <script type="application/json"> tag,
    # so neutralize sequences that could break out of it (a layer name can never
    # break the script context). Matches the reference SDK's injection.
    config = (
        config.replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )
    # Mermaid is on unless explicitly disabled. When off, the two mermaid scripts
    # are omitted from the page and their assets are not copied (a leaner viewer).
    mermaid_enabled = viewer_cfg.get("mermaid") is not False
    mermaid_scripts = (
        '\n      <script src="assets/mermaid.min.js"></script>'
        '\n      <script src="assets/docsify-mermaid.js"></script>'
        if mermaid_enabled
        else ""
    )
    doc_html = (
        (templates_dir() / "viewer" / "index.html")
        .read_text(encoding="utf-8")
        .replace("{{LEJI_NAME_HTML}}", _html_escape(manifest["name"]))
        .replace("{{DOCSIFY_CONFIG}}", config)
        .replace("{{MERMAID_SCRIPTS}}", mermaid_scripts)
    )
    sidebar = build_sidebar(manifest, entries)

    root_dir = strip_slash(manifest["rootPath"]) or "."
    findings: list[Finding] = [*result.findings]
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

    # Copy every vendored viewer asset (Docsify core, theme, and the search +
    # sidebar-collapse plugins) alongside index.html (no remote CDN). The
    # provenance note is documentation, never shipped.
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

    return ViewerResult(written=written, findings=findings, entries=len(entries))


# The protect-your-context warning surfaced by `leji viewer build` (in stdout and
# as a comment in the exported index.html): a context layer is sensitive and the
# static export should not be hosted somewhere public.
PROTECT_WARNING = (
    "This is your context layer (identity, invariants, decisions, sometimes sensitive "
    "internal knowledge). Host the exported folder behind internal authentication, not a "
    "public or shared bucket where it could be indexed or leaked."
)


@dataclass
class BuildResult:
    out: str
    findings: list[Finding] = field(default_factory=list)


def build_viewer(root: str, manifest: Manifest, out_rel: Optional[str] = None) -> BuildResult:
    """Export a self-contained static viewer into out_rel: the same URL contract the
    local server materializes (chrome at the web root, the layer's markdown under
    /content/), so any static host serves it as-is. Regenerates the viewer first,
    then copies the contained chrome and the content docs into a clean output dir.
    The exported index.html carries the protect-your-context warning as a comment."""
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
    # the repo and not be the repo or context root.
    if (
        out_abs == root_abs
        or out_abs == content_abs
        or not resolved_within_root(str(root_abs), out_abs)
    ):
        ref = out_rel if out_rel is not None else out_display
        raise RuntimeError(
            f'refusing to build the viewer into "{ref}": --out must be a path '
            "inside the repository, and not the repository root or the context root"
        )
    viewer_abs = content_abs / ".leji" / "viewer"
    out_content = out_abs / "content"

    # Clean rebuild so a removed source file never lingers in the export.
    shutil.rmtree(out_abs, ignore_errors=True)
    out_content.mkdir(parents=True, exist_ok=True)

    # Copy the content root to /content, skipping .leji and symlinks (an export is a
    # self-contained snapshot; a symlink could pull in outside content).
    def _ignore(directory: str, names: list[str]) -> set[str]:
        skip: set[str] = set()
        # Exclude the top-level .leji directory (the one directly under the content
        # root), mirroring Node's filter on the first path segment.
        if Path(directory) == content_abs and ".leji" in names:
            skip.add(".leji")
        for name in names:
            if (Path(directory) / name).is_symlink():
                skip.add(name)
        return skip

    shutil.copytree(content_abs, out_content, ignore=_ignore, dirs_exist_ok=True)
    # The generated sidebar is served as if at the content root.
    shutil.copy2(viewer_abs / "_sidebar.md", out_content / "_sidebar.md")
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


class _SafeViewerHandler(BaseHTTPRequestHandler):
    """Virtual-mount handler, no symlinks: the contained viewer chrome
    (rootPath/.leji/viewer/) is served at `/`, and the layer's markdown
    (rootPath/) under `/content/`. The internal .leji path is reachable only
    through these mounts, never by a direct URL. A local preview, not a host."""

    content_abs: str = ""
    viewer_abs: str = ""

    def log_message(self, *args):  # type: ignore[override]
        pass

    def _serve_from(self, mount_root: str, sub: str) -> None:
        # Serve `sub` (a clean relative path) from under `mount_root`; '' -> index.html.
        # realpath-contains the resolved target under its mount so a symlink can't escape.
        abs_path = (
            os.path.join(mount_root, "index.html") if sub == "" else os.path.join(mount_root, sub)
        )
        if abs_path != mount_root and not abs_path.startswith(mount_root + os.sep):
            self.send_response(403)
            self.end_headers()
            self.wfile.write(b"forbidden")
            return
        try:
            if os.path.isdir(abs_path):
                abs_path = os.path.join(abs_path, "index.html")
            real = os.path.realpath(abs_path)
            if real != mount_root and not real.startswith(mount_root + os.sep):
                self.send_response(403)
                self.end_headers()
                self.wfile.write(b"forbidden")
                return
            with open(abs_path, "rb") as fh:
                body = fh.read()
        except OSError:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"not found")
            return
        ct = CONTENT_TYPES.get(os.path.splitext(abs_path)[1].lower(), "application/octet-stream")
        self.send_response(200)
        self.send_header("content-type", ct)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        from urllib.parse import unquote, urlsplit

        try:
            # A malformed percent-encoding throws; answer 400 rather than crash.
            url_path = unquote(urlsplit(self.path).path, errors="strict")
        except (ValueError, UnicodeDecodeError):
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"bad request")
            return
        # Mirror Node's path.normalize + strip leading slashes/backslashes.
        rel = os.path.normpath(url_path).replace(os.sep, "/")
        rel = re.sub(r"^[/\\]+", "", rel)
        if rel == ".":
            rel = ""
        # Refuse any dotfile or VCS-internal segment in the REQUEST path: the .leji
        # viewer dir is reached only through the mounts below, never by direct URL.
        for seg in re.split(r"[/\\]", rel):
            if seg == ".git" or (seg.startswith(".") and seg not in (".", "")):
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b"not found")
                return
        # The generated sidebar lives in the viewer dir but is served as if at the
        # content root, so Docsify's basePath /content/ + _sidebar alias resolve it.
        if rel == "content/_sidebar.md":
            self._serve_from(self.viewer_abs, "_sidebar.md")
            return
        if rel == "content" or rel.startswith("content/"):
            self._serve_from(self.content_abs, "" if rel == "content" else rel[len("content/") :])
            return
        # Everything else (`/`, /index.html, /assets/*) is viewer chrome.
        self._serve_from(self.viewer_abs, rel)


def serve_viewer(root: str, port: int, root_rel: str = "") -> ThreadingHTTPServer:
    """Serve the viewer at the web root, bound to 127.0.0.1 (a local preview, never
    hosting). A virtual mount, no symlinks: the contained viewer chrome
    (rootPath/.leji/viewer/) is served at `/`, and the layer's markdown (rootPath/)
    under `/content/`. Caller runs serve_forever() / shutdown()."""
    root_abs = os.path.realpath(str(Path(root).resolve()))
    base = strip_slash(root_rel)
    content_abs = os.path.join(root_abs, base) if base and base != "." else root_abs
    viewer_abs = os.path.join(content_abs, ".leji", "viewer")
    handler_cls = type(
        "_BoundSafeViewerHandler",
        (_SafeViewerHandler,),
        {"content_abs": content_abs, "viewer_abs": viewer_abs},
    )
    return ThreadingHTTPServer(("127.0.0.1", port), handler_cls)


def open_browser(url: str) -> None:
    """Best-effort open of url in the default browser, used by --open / `leji view`.
    Never raises and never blocks: a missing opener is a silent no-op, since opening
    the browser is a convenience, not part of serving. Matches the Node platform
    opener for consistency (open / cmd start / xdg-open), spawned detached."""
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
