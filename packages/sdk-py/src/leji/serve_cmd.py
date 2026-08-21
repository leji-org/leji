"""The viewer's local preview server: the virtual mounts, the route table, and the
policy headers a browser sees. Every network import the CLI makes lives here and
nowhere else — the static export is a separate module whose transitive imports carry
none of them, which is what makes the export's no-network guarantee checkable rather
than asserted. Mirrors the Node SDK's `commands/serve.ts`.
"""

from __future__ import annotations

import os
import posixpath
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, Optional

from .findings import Finding
from .fsx import resolved_within_root, strip_slash, walk_tree
from .indexgen import generate_index, serialize_index
from .layout import VIEWER_REL, role_abs, servable_path
from .manifest import effective_index_path, load_manifest

# The chrome generation and the layer helpers the served responses compose, shared
# with the export exactly as the reference's serve.ts shares them with export.ts.
from .viewer_cmd import (
    ACTIVE_EXTENSIONS,
    _assemble_sidebar,
    _declares_inherits,
    _relative_to_root,
    _unresolved_profile_page,
    resolved_profile_page,
)

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

# A percent sign that does not begin a complete escape: the malformed form Node and
# Go reject with a 400 and Python's unquote silently keeps as a literal.
_BAD_PERCENT_RE = re.compile(r"%(?![0-9A-Fa-f]{2})")


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
    """Virtual-mount handler, no symlinks: the generated viewer chrome
    (`.leji/viewer/`) is served at `/`, and the layer's markdown (rootPath/) under
    `/content/`. Everything else under `.leji/` is denied by name, so the private
    roles are reachable by no URL at all. A local preview, not a host.

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
        # The servable-roots whitelist: under `.leji/`, only `viewer/` is servable.
        # Judged by name on the requested path and again on the resolved one, so a
        # symlink under the content root cannot reach a private role either.
        if not servable_path(self.root_abs, target):
            self.send_response(404)
            self.end_headers()
            self._write_body(b"not found")
            return
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
        if not servable_path(self.root_abs, real):
            self.send_response(404)
            self.end_headers()
            self._write_body(b"not found")
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
            # A malformed percent-encoding throws; answer 400 rather than crash. A
            # `%` not followed by two hex digits is malformed too — Node's
            # decodeURIComponent and Go's PathUnescape both reject it, while Python's
            # unquote passes it through as a literal, so it is rejected explicitly.
            raw_path = urlsplit(self.path).path
            if _BAD_PERCENT_RE.search(raw_path):
                raise ValueError("malformed percent-encoding")
            url_path = unquote(raw_path, errors="strict")
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
    hosting). Two virtual mounts and nothing else — the servable roots: chrome
    (`.leji/viewer/`) at `/`, the layer's markdown (rootPath/) under `/content/`.
    Everything else under `.leji/` is denied by name, so the private roles are
    unreachable however the request is spelled and whatever a symlink under the
    content root points at. `log`, when set, receives one terse access-log line per
    request. Caller runs serve_forever() / shutdown()."""
    root_abs = os.path.realpath(str(Path(root).resolve()))
    base = strip_slash(root_rel)
    content_abs = os.path.join(root_abs, base) if base and base != "." else root_abs
    # The CLI passes a schema-validated rootPath, but a direct SDK caller could pass
    # an escaping root_rel (e.g. ".."); refuse to mount content outside the layer root.
    if not resolved_within_root(root_abs, Path(content_abs)):
        raise ValueError(f'viewer root "{root_rel}" escapes the layer root')
    viewer_abs = role_abs(root_abs, VIEWER_REL)
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
