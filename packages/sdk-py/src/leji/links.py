"""The in-layer link scan: given one markdown document, the link destinations in it
and, for each, whether it resolves to something the layer actually carries. The Node
SDK's ``lib/links.ts`` is the executable contract this port follows, so the grammar
is stated there and here in the order it is applied.

Only prose is scanned (:func:`~leji.renderlint.prose_regions`), so a destination
inside a fenced block, a code span, or the frontmatter is text rather than a link.
Within prose::

    link   := "!"? "[" label "]" "(" dest title? ")"
    refdef := line-start(<= 3 spaces) "[" label "]" ":" spaces dest (spaces title)? line-end
    label  := any run up to the first unescaped "]"
    dest   := "<" any run without "<", ">" or a newline ">"      (the brackets are stripped)
            | run
    run    := ( "\\" punctuation | "(" run ")" | not(space, tab, newline, "(", ")") )+
    title  := '"' no-newline '"' | "'" no-newline "'" | "(" no-newline ")"

``](`` is one token: a link whose bracket and parenthesis are split across a line
break is not a link, and neither is one whose destination carries a newline. The
parentheses in a bare destination nest exactly one level (``dir/(x).md``), the title
is read only to find the closing ``)`` and is then discarded, and autolinks and raw
HTML are not links at all: ``<a href>`` is outside the rendering subset, and an
autolink is a URL, which this rule never judges.
"""

from __future__ import annotations

import os
import posixpath
import re
from pathlib import Path
from typing import NamedTuple, Optional
from urllib.parse import unquote

from .findings import Finding
from .fsx import resolved_within_root
from .renderlint import escapable, prose_regions

#: The one rule this scan produces.
LINK_UNRESOLVED_RULE = "link-unresolved"


def link_unresolved_message(target: str) -> str:
    """The shared message template. Identical bytes in all three SDKs by convention,
    outside the fixture contract by design."""
    return f'link target "{target}" does not resolve'


class ScannedLink(NamedTuple):
    """One link found in a document: the destination exactly as written (the angle
    brackets of the ``<...>`` form excepted, which are delimiters), and the 1-based
    line the link opens on."""

    target: str
    line: int


# A URI scheme, which is what makes a destination somebody else's to resolve:
# `https:`, `mailto:`, `data:` and every other.
_SCHEME = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*:")
# A reference definition's opening: a label carrying no bracket of its own, and the
# colon. Its position on the line is checked by the scan, which knows where the line
# began; the indent a definition may carry is up to three spaces.
_REFERENCE_OPEN = re.compile(r"\[[^\]\n]+\]:[ \t]*")
# The most a line may be indented before it is code rather than prose.
_REFERENCE_INDENT = re.compile(r" {0,3}$")


class _Span(NamedTuple):
    """A destination as written, and the offset just past it."""

    target: str
    end: int


def _is_space(text: str, i: int) -> bool:
    return i < len(text) and text[i] in (" ", "\t")


def _skip_spaces(text: str, i: int) -> int:
    """The offset just past the run of spaces and tabs at ``i``."""
    j = i
    while _is_space(text, j):
        j += 1
    return j


def _destination_at(text: str, i: int) -> Optional[_Span]:
    """A destination at ``i``, as written, and the offset just past it; None when
    none can be read there — an empty run, an unterminated angle form, a newline
    inside either, or parentheses nested past the one level a destination may
    carry."""
    if i < len(text) and text[i] == "<":
        j = i + 1
        while j < len(text):
            c = text[j]
            if c == "\\" and escapable(text, j + 1):
                j += 2
                continue
            if c in ("\n", "<"):
                return None
            if c == ">":
                return _Span(target=text[i + 1 : j], end=j + 1)
            j += 1
        return None
    j = i
    depth = 0
    while j < len(text):
        c = text[j]
        if c == "\\" and escapable(text, j + 1):
            j += 2
            continue
        if c == "\n" or c in (" ", "\t"):
            break
        if c == "(":
            if depth == 1:
                return None
            depth += 1
        elif c == ")":
            if depth == 0:
                break
            depth -= 1
        j += 1
    return None if depth != 0 or j == i else _Span(target=text[i:j], end=j)


def _title_end(text: str, i: int) -> int:
    """The offset just past a title at ``i``, or -1 when none stands there."""
    if i >= len(text):
        return -1
    opener = text[i]
    if opener not in ('"', "'", "("):
        return -1
    closer = ")" if opener == "(" else opener
    j = i + 1
    while j < len(text):
        c = text[j]
        if c == "\\" and escapable(text, j + 1):
            j += 2
            continue
        if c == "\n":
            return -1
        if c == closer:
            return j + 1
        j += 1
    return -1


def _inline_close_at(text: str, i: int) -> int:
    """The offset just past the optional title and the ``)`` closing an inline link
    at ``i``, or -1 when the link does not close there."""
    j = _skip_spaces(text, i)
    if j > i:
        t = _title_end(text, j)
        if t != -1:
            j = _skip_spaces(text, t)
    return j + 1 if j < len(text) and text[j] == ")" else -1


def _label_end(text: str, i: int) -> int:
    """The offset just past the unescaped ``]`` closing a label opened at ``i``, or
    -1."""
    j = i + 1
    while j < len(text):
        c = text[j]
        if c == "\\" and escapable(text, j + 1):
            j += 2
            continue
        if c == "]":
            return j + 1
        j += 1
    return -1


def _inline_link_at(text: str, i: int) -> Optional[_Span]:
    """An inline link (or image) opening at the ``[`` at ``i``: its destination and
    the offset just past the whole construct, or None when nothing there is a link."""
    label = _label_end(text, i)
    if label == -1 or label >= len(text) or text[label] != "(":
        return None
    dest = _destination_at(text, label + 1)
    if dest is None:
        return None
    end = _inline_close_at(text, dest.end)
    return None if end == -1 else _Span(target=dest.target, end=end)


def _reference_definition_at(text: str, i: int) -> Optional[_Span]:
    """A reference definition opening at ``i``, which is known to be a line start:
    its destination and the offset just past the line, or None. The remainder of the
    line must be empty or one title — ``[^1]: a footnote's prose`` is neither, and is
    prose."""
    newline = text.find("\n", i)
    line = text[i:] if newline == -1 else text[i:newline]
    open_match = _REFERENCE_OPEN.match(line)
    if open_match is None:
        return None
    dest = _destination_at(text, i + open_match.end())
    if dest is None:
        return None
    j = _skip_spaces(text, dest.end)
    if j > dest.end:
        t = _title_end(text, j)
        if t != -1:
            j = _skip_spaces(text, t)
    return _Span(target=dest.target, end=j) if j == i + len(line) else None


def scan_links(text: str) -> list[ScannedLink]:
    """Every link destination in one markdown document, in document order."""
    links: list[ScannedLink] = []
    for region in prose_regions(text):
        body = region.text
        line = region.line
        # Where the current line began, or -1 while the region resumes one that
        # started outside it (after a code span), where no definition can open.
        line_start = 0 if region.column == 0 else -1
        i = 0
        while i < len(body):
            if body[i] == "[":
                definition = (
                    _reference_definition_at(body, i)
                    if line_start != -1 and _REFERENCE_INDENT.match(body[line_start:i]) is not None
                    else None
                )
                # A label at a line start that no definition closes may still open an
                # inline link, so both forms are tried at the same bracket.
                found = definition or _inline_link_at(body, i)
                if found is not None:
                    links.append(ScannedLink(target=found.target, line=line))
                    for k in range(i, found.end):
                        if body[k] == "\n":
                            line += 1
                            line_start = k + 1
                    i = found.end
                    continue
            if body[i] == "\n":
                line += 1
                line_start = i + 1
            i += 1
    return links


def _unescape_markdown(target: str) -> str:
    """Markdown backslash escapes removed: ``\\(`` is a literal ``(`` on disk, and the
    generated links the viewer emits carry that spelling. Only ASCII punctuation is
    escapable, so every other backslash is itself a character of the path."""
    out: list[str] = []
    i = 0
    while i < len(target):
        if target[i] == "\\" and escapable(target, i + 1):
            out.append(target[i + 1])
            i += 2
            continue
        out.append(target[i])
        i += 1
    return "".join(out)


def resolve_link_target(
    root_abs: str, layer_root_abs: str, from_rel_path: str, target: str
) -> Optional[str]:
    """The absolute path a destination points at, or None when this rule does not
    judge it: a URI scheme (``mailto:`` and ``data:`` included), a bare fragment, or
    an empty destination. A leading ``/`` resolves against the layer's ``rootPath``,
    which is how the viewer resolves one; everything else resolves against the
    linking document's own directory. Escapes come off first, then ``#fragment`` and
    ``?query``, then percent-encoding — an undecodable target stays as written rather
    than being dropped, so a mistyped escape is reported rather than silently
    passed."""
    if target == "" or target.startswith("#") or _SCHEME.match(target) is not None:
        return None
    cleaned = _unescape_markdown(target).split("#")[0].split("?")[0]
    if cleaned == "":
        return None
    try:
        cleaned = unquote(cleaned, errors="strict")
    except UnicodeDecodeError:
        # Not valid percent-encoding: judge the target exactly as it was written.
        pass
    if cleaned.startswith("/"):
        return os.path.abspath(os.path.join(layer_root_abs, f".{cleaned}"))
    return os.path.abspath(os.path.join(root_abs, posixpath.dirname(from_rel_path), cleaned))


def _target_resolves(root_abs: str, abs_path: Path) -> bool:
    """A directory resolves only when it carries a ``README.md`` (nothing else tells
    a reader which document the directory stands for); a file of any kind resolves by
    existing, a dangling symlink therefore not at all.

    The README is a SECOND target, so it is contained before it is examined, by the
    same rule and the same realpath-aware primitive the directory itself passed: a
    directory inside the layer whose ``README.md`` links out of it stands for a
    document this layer does not carry, and no existence test may be the first thing
    to touch an outside-root path."""
    if not abs_path.is_dir():
        return abs_path.exists()
    readme = abs_path / "README.md"
    return resolved_within_root(root_abs, readme) and readme.is_file()


def link_findings(root_abs: str, layer_root_abs: str, rel_path: str, text: str) -> list[Finding]:
    """The scan as findings for one governed document. Containment is checked before
    existence and with the same realpath-aware primitive the write guards use, so a
    target reaching outside the layer — by ``..``, or through a symlink inside it —
    is unresolved whether or not something happens to sit there."""
    findings: list[Finding] = []
    for target, line in scan_links(text):
        abs_target = resolve_link_target(root_abs, layer_root_abs, rel_path, target)
        if abs_target is None:
            continue
        candidate = Path(abs_target)
        if resolved_within_root(root_abs, candidate) and _target_resolves(root_abs, candidate):
            continue
        findings.append(
            Finding(
                rule=LINK_UNRESOLVED_RULE,
                severity="error",
                message=link_unresolved_message(target),
                path=rel_path,
                line=line,
                construct=target,
            )
        )
    return findings
