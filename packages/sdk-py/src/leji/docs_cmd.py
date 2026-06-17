"""Static docs viewer generation and local preview, mirroring the Node SDK.

Presentation is non-normative; this is the reference projection of
context-index.json into a browsable surface (Docsify), plus a localhost-only
static server so `leji docs --serve` works the same in both ecosystems.
"""

from __future__ import annotations

import functools
import html
import json
import os
from dataclasses import dataclass, field
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional

from .findings import Finding
from .fsx import strip_slash
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


def resolve_docs_port(manifest: Manifest, flag_port: Optional[int] = None) -> int:
    """Preview-port precedence: explicit --port, then manifest docs.port, then 5354 (LEJI on a phone keypad)."""
    if flag_port is not None:
        return flag_port
    docs = manifest.get("docs") or {}
    port = docs.get("port")
    return port if isinstance(port, int) else 5354


@dataclass
class DocsResult:
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


def build_sidebar(manifest: Manifest, entries: list[dict]) -> str:
    """Deterministic Docsify sidebar: categories in canonical order, entries
    sorted by path, paths relative to rootPath. Ungrouped entries (the boot
    profile) sit above a divider; the category groups follow below it, giving
    the viewer a two-tier sidebar."""
    top_lines: list[str] = []
    boot = _relative_to_root(manifest["bootProfilePath"], manifest["rootPath"])
    if boot:
        top_lines.append(f"- [Boot profile]({boot})")
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
        group_lines.append(f"- {CATEGORY_LABELS[category]}")
        for title, rel in in_category:
            group_lines.append(f"  - [{title}]({rel})")
    sections = ["\n".join(s) for s in (top_lines, group_lines) if s]
    return "\n\n---\n\n".join(sections) + "\n"


def generate_docs(root: str, manifest: Manifest) -> DocsResult:
    """Write the Docsify index.html (frontmatter-stripping hook included) and
    the projected _sidebar.md into the context root."""
    result = generate_index(root, manifest)
    entries = (result.index or {}).get("entries", [])

    boot = _relative_to_root(manifest["bootProfilePath"], manifest["rootPath"]) or "boot-profile.md"
    config = json.dumps({"name": manifest["name"], "homepage": boot}, ensure_ascii=False)
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
    doc_html = (
        (templates_dir() / "docs-viewer.html")
        .read_text(encoding="utf-8")
        .replace("{{LEJI_NAME_HTML}}", html.escape(manifest["name"], quote=True))
        .replace("{{DOCSIFY_CONFIG}}", config)
    )
    sidebar = build_sidebar(manifest, entries)

    root_dir = strip_slash(manifest["rootPath"]) or "."
    written: list[str] = []
    for name, content in (("index.html", doc_html), ("_sidebar.md", sidebar)):
        rel = name if root_dir == "." else f"{root_dir}/{name}"
        abs_path = Path(root) / rel
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        abs_path.write_text(content, encoding="utf-8")
        written.append(rel)

    # Copy every vendored viewer asset (Docsify core, theme, and the search +
    # sidebar-collapse plugins) alongside index.html (no remote CDN). The
    # provenance note is documentation, never shipped.
    assets_src = templates_dir() / "docs-viewer-assets"
    assets_rel_dir = "docs-viewer-assets" if root_dir == "." else f"{root_dir}/docs-viewer-assets"
    for asset_path in sorted(p for p in assets_src.iterdir() if p.is_file()):
        if asset_path.name == "PROVENANCE.txt" or asset_path.name.startswith("."):
            continue
        rel = f"{assets_rel_dir}/{asset_path.name}"
        abs_path = Path(root) / rel
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        abs_path.write_bytes(asset_path.read_bytes())
        written.append(rel)

    return DocsResult(written=written, findings=result.findings, entries=len(entries))


class _SafeDocsHandler(SimpleHTTPRequestHandler):
    """Static handler that refuses to serve anything outside the served root,
    any dotfile, or any `.git` segment, and never follows a symlink that escapes
    the root. A local preview, not a host: containment over convenience."""

    served_root: str = ""

    def send_head(self):  # type: ignore[override]
        path = self.translate_path(self.path)
        served = self.served_root
        # Refuse dotfiles / .git segments by name (before touching the FS).
        rel = os.path.relpath(path, served)
        for segment in rel.split(os.sep):
            if segment in ("", os.curdir, os.pardir):
                continue
            if segment.startswith(".") or segment == ".git":
                self.send_error(404, "Not Found")
                return None
        # Refuse anything whose real path escapes the served root (symlinks).
        try:
            real = os.path.realpath(path)
        except OSError:
            self.send_error(404, "Not Found")
            return None
        if real != served and not real.startswith(served + os.sep):
            self.send_error(403, "Forbidden")
            return None
        return super().send_head()


def serve_docs(root: str, port: int) -> ThreadingHTTPServer:
    """Serve the repository root as a static site, bound to 127.0.0.1 (a local
    preview, never hosting). Caller runs serve_forever() / shutdown()."""
    served_root = os.path.realpath(str(Path(root).resolve()))
    handler_cls = type(
        "_BoundSafeDocsHandler",
        (_SafeDocsHandler,),
        {"served_root": served_root},
    )
    handler = functools.partial(handler_cls, directory=served_root)
    return ThreadingHTTPServer(("127.0.0.1", port), handler)
