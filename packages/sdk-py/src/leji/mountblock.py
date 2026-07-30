"""Parser for a boot profile's ``leji-mounts`` blocks: the machine-checkable half
of the federated-siblings requirement (spec ``boot-profile.md``, requirement 9).

Mirrors packages/sdk/src/lib/mountblock.ts byte-for-byte in behavior and output.

A host that declares ``federation.mounts`` surfaces each sibling in its boot
profile, in the author's task language, through a constrained block::

    ```leji-mounts
    - mount: acme-product-context
      owner: Product team
      carries: product-side domain language and the decisions behind it
      read-when: a task touches product behavior, product terminology, or billing
    ```

Grammar, frozen so the Go and Python ports parse it identically:

- Fence recognition is the shared ``leji-index`` scanner (``scan_fenced_blocks``)
  in its ASCII mode: three or more backticks, then the tag, then end of line or
  whitespace and any remainder, and any closing fence of three or more backticks.
  The info string is the tag ALONE, so a nonempty remainder (one token or several)
  is an error naming it, never an ignored fence; a fence whose tag merely prefixes
  another word (``leji-mountsx``) names a different grammar and opens nothing. One
  or MORE blocks may appear anywhere in the document; their entries concatenate in
  document order.
- Whitespace, everywhere in this grammar, is ASCII space (U+0020) and tab
  (U+0009) and nothing else: fence indent, fence padding, the blank-line and
  comment tests, and field indentation are all scanned with an explicit ``[ \\t]``
  alphabet, never a runtime whitespace class. This is the porting contract:
  JavaScript ``trim``/``\\s``, Python ``strip``, and Go's ``unicode.IsSpace``
  disagree on characters such as U+0085 and U+00A0, so a ``\\s`` port could
  disagree about whether a fence or a field line is even there.
- A record begins at column 1 with ``- mount: ``; its fields are indented exactly
  two ASCII spaces. Within a record ``owner``, ``carries``, and ``read-when`` each
  appear exactly once, in any order. Unknown fields, duplicate fields, missing
  fields, and misindented lines are errors.
- A value is the nonempty remainder of its physical line after the ``key: ``
  prefix, with no leading or trailing space/tab and no control or line/paragraph
  separator character (which is what makes a value single-line by construction).
- Blank lines and full lines starting ``#`` are ignored, matching ``leji-index``.
- Errors are returned sorted by source line (stable within a line), so a reader
  and every port see them in the order the file reads, not in the order the parser
  happened to detect them (a record's missing-field errors are raised at its
  closing boundary but belong to its ``- mount:`` line).
- Lines split on LF with a trailing CR stripped (CRLF tolerated); a CR anywhere
  else lands inside a value and is rejected as a control character. Never
  ``str.splitlines()``, which recognizes U+2028 and friends as line breaks where
  JavaScript and Go do not. File content is UTF-8 (decoded by the reader before it
  reaches this parser).

The parser reports grammar only. Whether an entry names a declared mount, and
whether its owner matches the declaration, is the validator's cross-check against
the manifest; the fidelity of ``carries`` and ``read-when`` to what the sibling
actually holds is authored task language and is not machine-checked.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Optional

from .indexfile import scan_fenced_blocks, strip_ascii_pad

# DOTALL so a stray CR (or any other line terminator a split on LF left behind) is
# captured into the value and rejected there, rather than making the line itself
# unparseable and reporting the wrong thing.
_RECORD = re.compile(r"^- mount: (.*)\Z", re.DOTALL)
_FIELD = re.compile(r"^ {2}([^ \t:]+): (.*)\Z", re.DOTALL)
# Any line that looks like a `key: value` field, whatever its indentation.
_FIELD_ANY = re.compile(r"^[ \t]*[^ \t:]+: ")
# C0 and C1 controls (CR, LF, and tab among them) plus the Unicode line and
# paragraph separators. Splitting on these differs across runtimes (Python's
# `splitlines` recognizes U+2028; JavaScript and Go do not), so a value carrying
# one is rejected rather than parsed differently by each port.
_CONTROL = re.compile("[\\x00-\\x1f\\x7f-\\x9f\\u2028\\u2029]")
_EDGE_PAD = re.compile(r"^[ \t]|[ \t]\Z")

FIELDS = ("owner", "carries", "read-when")


@dataclass
class MountBlockEntry:
    """One surfaced sibling, as authored in the block."""

    mount: str
    owner: str
    carries: str
    read_when: str
    # 1-based line of the record's `- mount:` line, for diagnostics.
    line: int


@dataclass
class MountBlockError:
    # 1-based line the error points at.
    line: int
    message: str


@dataclass
class ParsedMountBlocks:
    # Entries from every block, concatenated in document order.
    entries: list[MountBlockEntry] = field(default_factory=list)
    # Grammar errors sorted by source line; parsing never stops at the first.
    errors: list[MountBlockError] = field(default_factory=list)
    # True when the document carries at least one `leji-mounts` fence, empty or not.
    saw_block: bool = False


def value_representation_error(value: str) -> Optional[str]:
    """Why a string cannot be carried as a block value, or None when it can.
    Shared with the validator so a manifest identity the block could never express
    (an empty, padded, or multi-line ``owner.name``) is reported against the
    manifest rather than surfacing as an unfixable mismatch."""
    if value == "":
        return "the value is empty"
    if _EDGE_PAD.search(value):
        return "the value has leading or trailing whitespace"
    if _CONTROL.search(value):
        return "the value carries a control or line-separator character"
    return None


@dataclass
class _OpenRecord:
    mount: str
    line: int
    valid: bool
    fields: dict[str, str] = field(default_factory=dict)


def parse_mount_blocks(text: str) -> ParsedMountBlocks:
    """Parse every ``leji-mounts`` block in a boot profile."""
    entries: list[MountBlockEntry] = []
    errors: list[MountBlockError] = []
    scan = scan_fenced_blocks(text, "leji-mounts")

    open_record: Optional[_OpenRecord] = None

    def close_record() -> None:
        nonlocal open_record
        record = open_record
        if record is None:
            return
        open_record = None
        for name in FIELDS:
            if name not in record.fields:
                errors.append(
                    MountBlockError(
                        line=record.line,
                        message=f'mount "{record.mount}" is missing the "{name}" field',
                    )
                )
                record.valid = False
        if record.valid:
            entries.append(
                MountBlockEntry(
                    mount=record.mount,
                    owner=record.fields["owner"],
                    carries=record.fields["carries"],
                    read_when=record.fields["read-when"],
                    line=record.line,
                )
            )

    for block in scan.blocks:
        # The info string is the tag alone. Whatever follows it, one token or
        # several, arrives here as the block's remainder and is a targeted error
        # naming it in full; the block is consumed either way, so a typo never
        # degrades to prose.
        if block.token is not None:
            errors.append(
                MountBlockError(
                    line=block.open_line,
                    message="the leji-mounts info string carries nothing after the tag, "
                    f'but this fence declares "{block.token}"',
                )
            )
        for raw, line in block.lines:
            trimmed = strip_ascii_pad(raw)
            if trimmed == "" or trimmed.startswith("#"):
                continue
            record = _RECORD.match(raw)
            if record:
                close_record()
                name = record.group(1)
                bad = value_representation_error(name)
                if bad:
                    errors.append(
                        MountBlockError(line=line, message=f"mount name is unusable: {bad}")
                    )
                open_record = _OpenRecord(mount=name, line=line, valid=bad is None)
                continue
            if trimmed.startswith("- mount:"):
                errors.append(
                    MountBlockError(
                        line=line,
                        message='a "- mount:" record must start at column 1, followed by one space',
                    )
                )
                if open_record is not None:
                    open_record.valid = False
                continue
            f = _FIELD.match(raw)
            if not f:
                errors.append(
                    MountBlockError(
                        line=line,
                        message="a field line must be indented exactly two spaces, as "
                        '"  <key>: <value>"'
                        if _FIELD_ANY.match(raw)
                        else f"unparseable line {json.dumps(raw, ensure_ascii=False)} "
                        '(expected "- mount: <name>" or "  <key>: <value>")',
                    )
                )
                if open_record is not None:
                    open_record.valid = False
                continue
            key, value = f.group(1), f.group(2)
            if open_record is None:
                errors.append(
                    MountBlockError(
                        line=line,
                        message=f'field "{key}" appears before any "- mount:" record',
                    )
                )
                continue
            if key not in FIELDS:
                errors.append(
                    MountBlockError(
                        line=line,
                        message=f'mount "{open_record.mount}" carries the unknown field "{key}"',
                    )
                )
                open_record.valid = False
                continue
            if key in open_record.fields:
                errors.append(
                    MountBlockError(
                        line=line,
                        message=f'mount "{open_record.mount}" declares the "{key}" field twice',
                    )
                )
                open_record.valid = False
                continue
            bad = value_representation_error(value)
            if bad:
                errors.append(
                    MountBlockError(
                        line=line,
                        message=f'mount "{open_record.mount}" field "{key}" is unusable: {bad}',
                    )
                )
                open_record.valid = False
                continue
            open_record.fields[key] = value
        # A block boundary closes the record it opened: records never span blocks.
        close_record()

    if scan.unterminated:
        errors.append(
            MountBlockError(
                line=scan.blocks[-1].open_line,
                message="unterminated leji-mounts block (no closing fence)",
            )
        )
    # Source-line order, stable within a line (Python's sorted/list.sort is stable,
    # as are JavaScript's Array.prototype.sort and Go's SliceStable).
    errors.sort(key=lambda e: e.line)
    return ParsedMountBlocks(entries=entries, errors=errors, saw_block=len(scan.blocks) > 0)
