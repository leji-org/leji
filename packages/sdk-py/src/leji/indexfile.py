"""Parser for a category index file's ``leji-index`` block.

An index file is curated markdown (prose and grouping are allowed) carrying one
or more fenced code blocks tagged ``leji-index``. Each block lists the content
that belongs to the category, one entry per line, in a deliberately small,
dependency-free mini-format so all three SDKs can parse it identically::

    ```leji-index
    - path: docs/invariants.md          # a single file
    - path: docs/Wood-Badge/            # a whole directory (recursed)
    ```

The fence info string carries the block's kind. Exactly three forms are
valid: ``leji-index`` (intent, the default), ``leji-index intent``, and
``leji-index record``. Any other token after ``leji-index`` is a targeted parse
error, never silently ignored: the grammar is finite by design.

Rules: an entry line is exactly ``- path: <repo-relative-posix-path>`` with an
optional trailing ` # comment` (the ``#`` must be preceded by whitespace, so a
``#`` inside a path is preserved). Blank lines and full-line ``#`` comments
inside a block are ignored. No quoting, nesting, or extra keys. A path may be a
directory (recursed for markdown) or a single ``.md`` file; resolution happens
in the layer.

Whitespace anywhere in this grammar is ASCII space or tab, and nothing else, and a
leading UTF-8 byte order mark is stripped before parsing. The three runtimes' own
whitespace classes disagree (U+0085, U+00A0, U+FEFF), so a grammar spelled in them
is not one grammar; see ``scan_fenced_blocks``.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Optional

# A document's kind: maintained present truth ("intent"), or dated
# evidence ("record").
DOC_KINDS = ("intent", "record")


@dataclass
class IndexFileEntry:
    path: str
    # The block's declared kind ("intent" when the fence carries none).
    kind: str = "intent"


@dataclass
class ParsedIndexFile:
    entries: list[IndexFileEntry] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


# ASCII-only fence recognition: indent and padding are space and tab, nothing else.
_FENCE_CLOSE = re.compile(r"^[ \t]*`{3,}[ \t]*\Z")
# An entry line on the same ASCII alphabet: ``\s`` is a different set of characters
# in JavaScript, Go's regexp, and Python's re, and a grammar three SDKs parse cannot
# be spelled in a class they disagree about.
_ENTRY = re.compile(r"^-[ \t]+path:[ \t]+(.*)\Z")
# A trailing comment opens on a whitespace-preceded ``#``, whitespace again meaning
# space or tab and nothing else, so a ``#`` inside a path is kept.
_TRAILING_COMMENT = re.compile(r"[ \t]#")
_DOTDOT = re.compile(r"(^|/)\.\.(/|$)")
# U+FEFF as a leading character: a UTF-8 byte order mark, decoded.
_BOM = "\ufeff"


def strip_ascii_pad(s: str) -> str:
    """Strip leading and trailing ASCII space/tab, and nothing else. The one
    padding rule every grammar frozen on the ASCII alphabet uses, scanner and
    parser alike. Never ``str.strip()``: Python strips Unicode whitespace
    (U+0085, U+00A0, ...) that JavaScript's ``trim`` and Go's scanners do not
    agree on."""
    return s.strip(" \t")


@dataclass
class FencedBlock:
    """One fenced block a scan found: its info-string remainder and its body."""

    # 1-based line number of the opening fence.
    open_line: int
    # Body lines verbatim (never trimmed), each with its 1-based line number.
    lines: list[tuple[str, int]] = field(default_factory=list)
    # The complete padding-stripped remainder of the info string, when it carries
    # anything. A fence opens on the tag alone and whatever follows it is handed to
    # the grammar to accept or reject, so a fence carrying junk is a reportable
    # block rather than a silently ignored one.
    token: Optional[str] = None


@dataclass
class FenceScan:
    blocks: list[FencedBlock] = field(default_factory=list)
    # True when a block ran to end of file with no closing fence.
    unterminated: bool = False


def scan_fenced_blocks(text: str, tag: str) -> FenceScan:
    """Scan every fenced block whose info string names ``tag``, in document order.

    One scanner for every leji block grammar (``leji-index`` here, ``leji-mounts``
    in the boot profile), so backtick counts, an optional info remainder, closing
    fences, unclosed fences, and a block nested inside a longer markdown example all
    behave identically wherever a block grammar is added. The scan is line based and
    markdown structure blind by design.

    Lines split on LF with a trailing CR stripped (CRLF tolerated). ``tag`` is a
    fixed literal supplied by the caller, never user input.

    The whitespace alphabet is ASCII space and tab, scanned explicitly, and it is the
    porting contract. JavaScript's ``\\s``/``trim``, Python's ``strip``/``re``, and
    Go's ``unicode.IsSpace``/``regexp`` disagree about characters like U+0085 and
    U+00A0, so a literal port of a ``\\s`` scanner can disagree about whether a fence
    is even there: a U+00A0 before a closing fence, or a BOM before an opening one,
    used to decide the answer differently in each SDK. A fence opens on the tag
    followed by end of line or by whitespace, and the whole remainder goes to the
    grammar. The tag boundary is respected either way: ``leji-mountsx`` names a
    different tag and opens nothing.

    A leading UTF-8 byte order mark is stripped first, identically everywhere. It can
    only ever precede the first line, and letting it decide whether that line is a
    fence is the same portability hazard one character further left."""
    open_re = re.compile(rf"^[ \t]*`{{3,}}[ \t]*{tag}([ \t].*)?\Z", re.DOTALL)
    blocks: list[FencedBlock] = []
    lines = re.split(r"\r?\n", text[len(_BOM) :] if text.startswith(_BOM) else text)
    current: Optional[FencedBlock] = None
    for i, raw in enumerate(lines):
        if current is None:
            m = open_re.match(raw)
            if m:
                # The captured remainder is a token only once its padding is off.
                rest = strip_ascii_pad(m.group(1) or "") or None
                current = FencedBlock(open_line=i + 1, lines=[], token=rest)
                blocks.append(current)
            continue
        if _FENCE_CLOSE.match(raw):
            current = None
            continue
        current.lines.append((raw, i + 1))
    return FenceScan(blocks=blocks, unterminated=current is not None)


def parse_index_file(text: str) -> ParsedIndexFile:
    """Parse every ``leji-index`` block in an index file's markdown text. Multiple
    blocks in one file are intentional and concatenated in document order (so
    entries can be grouped under prose headings), each entry carrying its block's
    kind; this matches the Node and Go ports' multi-block concatenation."""
    entries: list[IndexFileEntry] = []
    errors: list[str] = []
    seen: set[str] = set()
    scan = scan_fenced_blocks(text, "leji-index")

    for block in scan.blocks:
        # The kind token is validated here rather than in the scanner, so an unknown
        # token is a targeted error and the block is still consumed (its entries must
        # not fall back to parsing as prose).
        block_kind = "intent"
        if block.token is not None and block.token not in DOC_KINDS:
            errors.append(
                f'line {block.open_line}: unknown leji-index block kind "{block.token}" '
                "(expected intent or record)"
            )
        elif block.token == "record":
            block_kind = "record"
        for raw, line in block.lines:
            # Every padding rule inside a block is the scanner's ASCII alphabet too,
            # so one U+00A0 cannot make an entry parse in one SDK and not in another.
            trimmed = strip_ascii_pad(raw)
            if trimmed == "" or trimmed.startswith("#"):
                continue
            m = _ENTRY.match(trimmed)
            if not m:
                errors.append(
                    f"line {line}: unparseable entry "
                    f'{json.dumps(raw, ensure_ascii=False)} (expected "- path: <path>")'
                )
                continue
            # Strip a trailing comment only when the `#` is whitespace-preceded, so a
            # `#` that is part of the path itself is kept.
            p = m.group(1)
            cm = _TRAILING_COMMENT.search(p)
            if cm:
                p = p[: cm.start()]
            p = strip_ascii_pad(p)
            if p == "":
                errors.append(f"line {line}: empty path")
                continue
            if p.startswith("/") or _DOTDOT.search(p) or "\\" in p:
                errors.append(
                    f'line {line}: invalid path "{p}" (must be a repository-relative POSIX path)'
                )
                continue
            if p in seen:
                errors.append(f'line {line}: duplicate path "{p}"')
                continue
            seen.add(p)
            entries.append(IndexFileEntry(path=p, kind=block_kind))

    if scan.unterminated:
        errors.append("unterminated leji-index block (no closing fence)")
    if not scan.blocks:
        errors.append("no leji-index block found in this index file")
    return ParsedIndexFile(entries=entries, errors=errors)
