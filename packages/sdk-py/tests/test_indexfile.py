"""Direct unit coverage for the ``leji-index`` block parser, mirroring
packages/sdk/test/indexfile.test.ts and the Go parser tests. The shared fixtures
exercise it end to end; what is pinned here is the whitespace alphabet, which is the
porting contract and the one thing three runtimes cannot be trusted to agree on by
themselves."""

from __future__ import annotations

from leji.indexfile import parse_index_file


def _paths(parsed) -> list[str]:
    return [e.path for e in parsed.entries]


def test_a_leading_bom_does_not_decide_whether_the_fence_exists() -> None:
    # Reproduced divergence: the BOM survived into the first line, and each runtime's
    # own trim disagreed about whether it was whitespace, so the same file parsed in
    # Node and failed with ``index-file-parse`` here and in Go.
    parsed = parse_index_file("\ufeff```leji-index\n- path: docs/a.md\n```\n")
    assert parsed.errors == []
    assert _paths(parsed) == ["docs/a.md"]


def test_whitespace_in_the_grammar_is_ascii_space_and_tab_only() -> None:
    # Reproduced divergence: an NBSP before a trailing ``#`` opened a comment under
    # JavaScript's and Python's ``\s`` but not Go's, so one entry named two different
    # paths depending on which SDK read it. Under the ASCII alphabet all three keep
    # the ``#`` in the path, and the layer reports it missing rather than inventing
    # one.
    nbsp = parse_index_file("```leji-index\n- path: docs/a.md\u00a0# note\n```\n")
    assert nbsp.errors == []
    assert _paths(nbsp) == ["docs/a.md\u00a0# note"]
    # A space-preceded ``#`` is still a comment, and padding is still stripped.
    ascii_line = parse_index_file("```leji-index\n   - path: docs/a.md \t# note\t \n```\n")
    assert _paths(ascii_line) == ["docs/a.md"]
    # Non-ASCII padding around an entry is not padding: the line does not parse.
    padded = parse_index_file("```leji-index\n\u00a0- path: docs/a.md\n```\n")
    assert padded.entries == []
    assert len(padded.errors) == 1
    assert padded.errors[0].startswith("line 2: unparseable entry ")
    # A fence line padded with U+00A0 is not a fence line either, in any SDK.
    assert parse_index_file("\u00a0```leji-index\n- path: docs/a.md\n```\n").errors == [
        "no leji-index block found in this index file"
    ]


def test_a_fence_carrying_junk_after_the_tag_is_a_reportable_block() -> None:
    # The ``leji-mounts`` behavior, now shared: the fence opens and the grammar
    # rejects what follows, instead of the whole block vanishing from the scan.
    parsed = parse_index_file("```leji-index record extra\n- path: docs/a.md\n```\n")
    assert parsed.errors == [
        'line 1: unknown leji-index block kind "record extra" (expected intent or record)'
    ]
    assert _paths(parsed) == ["docs/a.md"]
    assert parsed.entries[0].kind == "intent"
