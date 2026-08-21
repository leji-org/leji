"""The rendering-subset scan: given one markdown document, the constructs in it
that render differently across renderers. The Node SDK's ``lib/renderlint.ts`` is
the executable contract this port follows rule for rule — the rules are stated
there and here in the order they are applied, because a second statement of them (a
grammar, a spec paragraph) would be a source that drifts.

The rules, in application order:

1. **Excluded regions are found first.** YAML frontmatter (a leading block only, by
   the SDK's own boundary), fenced code blocks, and HTML comments are scanned
   before anything else, and nothing inside one is ever reported — text that merely
   names a construct is not that construct. Code spans are excluded the same way,
   inline, as the scan reaches them.
2. **Three constructs are reported**, and only these three: ``raw-html``
   (CommonMark HTML blocks and inline raw HTML; comments excepted, since Leji's own
   generated-block markers are comments), ``footnote`` (the definition and
   reference forms alike), and ``math-block`` (a PAIRED ``$$`` delimiter — a lone
   one is prose).
3. **Backslash escapes are honored** for all three, per CommonMark: an escaped
   ASCII punctuation character is a literal, so ``\\<div>`` is prose.
4. **Overlapping constructs resolve to the earliest-starting match**, which the
   single left-to-right scan below produces by construction, and each match is
   attributed to the line it OPENS on — a multi-line HTML block or ``$$`` block
   reports once, at its opening line.
5. **One hit per (line, construct)**: the line is the unit, so a line carrying two
   inline tags reports ``raw-html`` once.

What is deliberately NOT reported: inline ``$`` (a currency amount spells it),
unknown fence info strings (the unhighlighted fallback is conforming), and loose
prose shapes. ``adoption/rendering.md`` is the profile these rules serve.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

from .findings import Finding
from .frontmatter import parse_frontmatter

# The closed token set. Findings compare on it across the three SDKs; the message
# text does not.
RAW_HTML = "raw-html"
FOOTNOTE = "footnote"
MATH_BLOCK = "math-block"

#: The one rule this scan produces. ``--strict`` promotes it (see export_cmd).
RENDER_UNSUPPORTED_RULE = "render-unsupported"


def render_unsupported_message(construct: str) -> str:
    """The shared message template. Identical bytes in all three SDKs by
    convention, outside the fixture contract by design."""
    return f"`{construct}` is outside the supported rendering subset; see adoption/rendering.md"


@dataclass(frozen=True)
class RenderHit:
    """One reported construct: the token, and the 1-based line it opens on."""

    line: int
    construct: str


# CommonMark HTML block type 6: a line opening with one of these tags starts a
# block that runs to the next blank line, whatever else the line carries. The list
# is CommonMark's, verbatim, so a `</div>` closing a block on a later line is block
# content rather than a second construct.
_BLOCK_TAGS = frozenset(
    (
        "address article aside base basefont blockquote body caption center col colgroup dd "
        "details dialog dir div dl dt fieldset figcaption figure footer form frame frameset "
        "h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav "
        "noframes ol optgroup option p param search section summary table tbody td tfoot th "
        "thead title tr track ul"
    ).split(" ")
)

# CommonMark HTML block type 1: these run to a line carrying a closing tag rather
# than to a blank line, because their content is raw text.
_RAW_TEXT_OPEN = re.compile(r"<(script|pre|style|textarea)([ \t>]|$)", re.IGNORECASE)
_RAW_TEXT_CLOSE = re.compile(r"</(script|pre|style|textarea)>", re.IGNORECASE)

# Inline raw HTML, as CommonMark defines it: an open tag, a closing tag, a
# processing instruction, a declaration, or a CDATA section. (A comment is the
# sixth form and the excepted one, handled as an excluded region.) Each is matched
# at exactly the scan position. A declaration takes an ASCII letter of either case
# after `<!`: `<!DOCTYPE html>` and `<!foo bar>` alike disappear into the renderer,
# which is precisely what the lint exists to warn about.
_OPEN_TAG = re.compile(
    r"<[A-Za-z][A-Za-z0-9-]*"
    r"(?:[ \t\r\n]+[A-Za-z_:][A-Za-z0-9_.:-]*"
    r"(?:[ \t\r\n]*=[ \t\r\n]*(?:[^ \t\r\n\"'=<>`]+|'[^']*'|\"[^\"]*\"))?)*"
    r"[ \t\r\n]*/?>"
)
_CLOSE_TAG = re.compile(r"</[A-Za-z][A-Za-z0-9-]*[ \t\r\n]*>")
_CDATA = re.compile(r"<!\[CDATA\[[\s\S]*?\]\]>")
_DECLARATION = re.compile(r"<![A-Za-z][\s\S]*?>")
_PROCESSING = re.compile(r"<\?[\s\S]*?\?>")
# Both footnote forms: the reference `[^id]`, and the definition `[^id]:`, whose
# opening bracket the same match covers. An unclosed `[^` is prose.
_FOOTNOTE_RE = re.compile(r"\[\^[^\][\n]+\]")

# A fence opener: three or more backticks or tildes. A backtick fence's info string
# may carry no backtick, which is what keeps a code span off this path.
_FENCE_OPEN = re.compile(r"(`{3,}|~{3,})(.*)$")
# A fence closer: the same character, at least as long, alone on its line.
_FENCE_CLOSE = re.compile(r"(`{3,}|~{3,})[ \t]*$")
# A line opening with a tag name, for the type-6/type-7 block test.
_LINE_TAG = re.compile(r"</?([A-Za-z][A-Za-z0-9-]*)([ \t]|/?>|$)")
# Escapable per CommonMark: ASCII punctuation, and nothing else.
_ESCAPABLE = re.compile(r"[!-/:-@\[-`{-~]")
# A declaration opener, `<!` plus an ASCII letter of either case.
_DECL_OPEN = re.compile(r"<![A-Za-z]")


@dataclass
class _Region:
    """A span the scan treats as one unit: an excluded region (``construct`` None),
    or a block-level construct reported at its opening line. Regions are produced in
    document order and never overlap."""

    start: int
    end: int
    construct: Optional[str] = None


def _line_starts_of(text: str) -> list[int]:
    """Offsets at which each line begins, so an offset resolves to a line number."""
    starts = [0]
    for i, ch in enumerate(text):
        if ch == "\n":
            starts.append(i + 1)
    return starts


def _line_of(starts: list[int], offset: int) -> int:
    """The 0-based line an offset falls on."""
    lo, hi = 0, len(starts) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if starts[mid] <= offset:
            lo = mid
        else:
            hi = mid - 1
    return lo


def _line_text_at(text: str, starts: list[int], li: int) -> str:
    """One line's text, without its line terminator (CRLF included)."""
    end = starts[li + 1] if li + 1 < len(starts) else len(text)
    line = text[starts[li] : end]
    if line.endswith("\n"):
        line = line[:-1]
    return line[:-1] if line.endswith("\r") else line


def _line_end_of(text: str, starts: list[int], li: int) -> int:
    """The offset just past a line's terminator."""
    return starts[li + 1] if li + 1 < len(starts) else len(text)


def _indent_of(line: str) -> int:
    """Leading spaces, capped at the four that would make the line indented code."""
    n = 0
    while n < 4 and n < len(line) and line[n] in (" ", "\t"):
        n += 1
    return n


def _escapable(text: str, i: int) -> bool:
    """True when the character at ``i`` exists and is CommonMark-escapable."""
    return i < len(text) and _ESCAPABLE.match(text, i) is not None


def _block_regions(text: str, starts: list[int]) -> list[_Region]:
    """The block pass: frontmatter, fenced code, HTML comments (all excluded), and
    the HTML blocks that report as ``raw-html`` at their opening line. Line-based
    and in document order, so a fence inside a comment is comment text and a comment
    inside a fence is code — whichever opens first wins."""
    regions: list[_Region] = []
    n = len(text)
    li = 0

    # Frontmatter, by the SDK's own boundary (a LEADING block only; a `---` later in
    # the document is a thematic break, and an unterminated block is prose).
    fm = parse_frontmatter(text)
    if len(fm.body) != n:
        end = n - len(fm.body)
        regions.append(_Region(start=0, end=end))
        li = len(starts) if end >= n else _line_of(starts, end)

    while li < len(starts):
        line = _line_text_at(text, starts, li)
        indent = _indent_of(line)
        if indent >= 4:
            li += 1
            continue
        rest = line[indent:]
        at = starts[li] + indent

        fence = _FENCE_OPEN.match(rest)
        if fence is not None and (fence.group(1)[0] == "~" or "`" not in fence.group(2)):
            close = li + 1
            while close < len(starts):
                candidate = _line_text_at(text, starts, close)
                m = _FENCE_CLOSE.match(candidate[_indent_of(candidate) :])
                if (
                    m is not None
                    and m.group(1)[0] == fence.group(1)[0]
                    and len(m.group(1)) >= len(fence.group(1))
                ):
                    break
                close += 1
            last = min(close, len(starts) - 1)
            regions.append(_Region(start=starts[li], end=_line_end_of(text, starts, last)))
            li = last + 1
            continue

        # A comment opening a line is CommonMark HTML block type 2: it runs to the
        # line carrying `-->`, and the whole of that line belongs to it. Comments are
        # the one HTML form the profile excepts, so the region reports nothing.
        if rest.startswith("<!--"):
            close_at = text.find("-->", at + 4)
            last = len(starts) - 1 if close_at == -1 else _line_of(starts, close_at + 3)
            regions.append(_Region(start=starts[li], end=_line_end_of(text, starts, last)))
            li = last + 1
            continue

        # CommonMark HTML blocks 3, 4 and 5: a processing instruction, a declaration,
        # or a CDATA section opening a line is a BLOCK, running to the line carrying
        # its terminator (`?>`, `>`, `]]>`) and ending with that whole line — so what
        # follows the terminator on it is block content, never a second construct. An
        # unterminated one runs to the end of the document, as the comment form does.
        # Type 4 takes an ASCII letter of either case, so `<!foo` opens a block
        # exactly as `<!DOCTYPE` does — everything through the next `>` disappears
        # from the page.
        terminator: Optional[str] = None
        if rest.startswith("<?"):
            terminator = "?>"
        elif rest.startswith("<![CDATA["):
            terminator = "]]>"
        elif _DECL_OPEN.match(rest) is not None:
            terminator = ">"
        if terminator is not None:
            close_at = text.find(terminator, at)
            last = len(starts) - 1 if close_at == -1 else _line_of(starts, close_at)
            regions.append(
                _Region(start=starts[li], end=_line_end_of(text, starts, last), construct=RAW_HTML)
            )
            li = last + 1
            continue

        if _RAW_TEXT_OPEN.match(rest) is not None:
            found = _RAW_TEXT_CLOSE.search(text, at)
            last = len(starts) - 1 if found is None else _line_of(starts, found.start())
            regions.append(
                _Region(start=starts[li], end=_line_end_of(text, starts, last), construct=RAW_HTML)
            )
            li = last + 1
            continue

        # Type 6 (a known block tag opens the line) and type 7 (any complete tag
        # alone on a line, which cannot interrupt a paragraph). Both run to the next
        # blank line, so the tags closing them are block content.
        tag = _LINE_TAG.match(rest)
        previous_blank = li == 0 or _line_text_at(text, starts, li - 1).strip() == ""
        is_block = (tag is not None and tag.group(1).lower() in _BLOCK_TAGS) or (
            previous_blank and _whole_line_is_tag(rest)
        )
        if is_block:
            close = li + 1
            while close < len(starts) and _line_text_at(text, starts, close).strip() != "":
                close += 1
            regions.append(
                _Region(
                    start=starts[li], end=_line_end_of(text, starts, close - 1), construct=RAW_HTML
                )
            )
            li = close
            continue
        li += 1
    return regions


def _whole_line_is_tag(rest: str) -> bool:
    """True when the line is one complete open or closing tag and nothing else."""
    for pattern in (_OPEN_TAG, _CLOSE_TAG):
        m = pattern.match(rest)
        if m is not None and rest[m.end() :].strip() == "":
            return True
    return False


def _skip_region(regions: list[_Region], i: int) -> int:
    """The end of the region containing ``i``, or ``i`` when it is outside every
    one."""
    for r in regions:
        if r.start <= i < r.end:
            return r.end
    return i


def _run_length(text: str, i: int, ch: str) -> int:
    """The length of the run of ``ch`` starting at ``i``."""
    n = 0
    while i + n < len(text) and text[i + n] == ch:
        n += 1
    return n


def _after_code_span(text: str, regions: list[_Region], i: int) -> int:
    """A code span: a backtick run closed by a run of exactly the same length. An
    unclosed run is literal text, so the scan resumes just past it. Inline state
    never crosses a block boundary: a candidate whose closer would lie beyond an
    excluded or block region is unclosed AT that boundary, because the region ends
    the paragraph the run opened in — so constructs after the region still report."""
    open_run = _run_length(text, i, "`")
    j = i + open_run
    while j < len(text):
        if _skip_region(regions, j) != j:
            break
        if text[j] == "`":
            run = _run_length(text, j, "`")
            if run == open_run:
                return j + run
            j += run
            continue
        j += 1
    return i + open_run


def _next_math_delimiter(text: str, regions: list[_Region], start: int) -> int:
    """The next unescaped ``$$`` at or after ``start``, or -1. A delimiter is a
    closer only where a delimiter can be read: not inside a code span, not inside a
    comment, and not on the far side of a block boundary — a pair no more bridges a
    region than a code span does, so an open whose apparent mate sits in one of them
    is unpaired, which is prose."""
    j = start
    while j < len(text) - 1:
        if _skip_region(regions, j) != j:
            return -1
        if text[j] == "\\" and _escapable(text, j + 1):
            j += 2
            continue
        if text[j] == "`":
            j = _after_code_span(text, regions, j)
            continue
        if text.startswith("<!--", j):
            close_at = text.find("-->", j + 4)
            j = len(text) if close_at == -1 else close_at + 3
            continue
        if text[j] == "$" and text[j + 1] == "$":
            return j
        j += 1
    return -1


def _inline_html_end(text: str, i: int) -> int:
    """An inline raw-HTML form at ``i``, as its end offset, or -1."""
    for pattern in (_CDATA, _PROCESSING, _DECLARATION, _CLOSE_TAG, _OPEN_TAG):
        m = pattern.match(text, i)
        if m is not None:
            return m.end()
    return -1


def scan_render_constructs(text: str) -> list[RenderHit]:
    """Every reported construct in one markdown document, ordered by (line,
    construct) — the order the export's findings carry, and the tie-breaker that
    keeps two constructs on one line deterministic across the three SDKs."""
    starts = _line_starts_of(text)
    regions = _block_regions(text, starts)
    seen: set[tuple[int, str]] = set()
    hits: list[RenderHit] = []

    def record(offset: int, construct: str) -> None:
        line = _line_of(starts, offset) + 1
        key = (line, construct)
        if key in seen:
            return
        seen.add(key)
        hits.append(RenderHit(line=line, construct=construct))

    for r in regions:
        if r.construct is not None:
            record(r.start, r.construct)

    # The inline pass: one left-to-right walk, so the earliest-starting match wins
    # every overlap and each match is consumed whole.
    i = 0
    while i < len(text):
        skip = _skip_region(regions, i)
        if skip != i:
            i = skip
            continue
        c = text[i]
        if c == "\\" and _escapable(text, i + 1):
            i += 2
            continue
        if c == "`":
            i = _after_code_span(text, regions, i)
            continue
        if c == "<":
            if text.startswith("<!--", i):
                close_at = text.find("-->", i + 4)
                i = len(text) if close_at == -1 else close_at + 3
                continue
            end = _inline_html_end(text, i)
            if end != -1:
                record(i, RAW_HTML)
                i = end
                continue
            i += 1
            continue
        if c == "[" and i + 1 < len(text) and text[i + 1] == "^":
            m = _FOOTNOTE_RE.match(text, i)
            if m is not None:
                record(i, FOOTNOTE)
                i = m.end()
                continue
            i += 1
            continue
        if c == "$" and i + 1 < len(text) and text[i + 1] == "$":
            close_at = _next_math_delimiter(text, regions, i + 2)
            if close_at != -1:
                record(i, MATH_BLOCK)
                i = close_at + 2
                continue
            # Unpaired: prose, and the scan carries on past it.
            i += 2
            continue
        i += 1

    return sorted(hits, key=lambda h: (h.line, h.construct))


def render_lint_findings(rel_path: str, text: str) -> list[Finding]:
    """The scan as findings for one document: ``warning`` severity, the repository-
    relative path the export carries it at, the opening line, and the token."""
    return [
        Finding(
            rule=RENDER_UNSUPPORTED_RULE,
            severity="warning",
            message=render_unsupported_message(hit.construct),
            path=rel_path,
            line=hit.line,
            construct=hit.construct,
        )
        for hit in scan_render_constructs(text)
    ]
