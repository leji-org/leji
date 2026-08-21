<!--
   Feature family: GFM tables, the subject of this file and so the heaviest part
   of the fixture — every alignment, ragged delimiter rows, inline constructs in
   cells, an escaped pipe, and the metadata-header convention this repository's
   own documents use. GFM strikethrough rides along, in cells and in prose.
   All inside the supported rendering subset.
-->

# Tables

## Default alignment

| Field | Meaning |
| --- | --- |
| `rule` | the finding's rule identifier |
| `severity` | `error` or `warning` |
| `path` | repository-root-relative POSIX path |

## Every alignment

| Left | Centered | Right |
| :--- | :-----: | ----: |
| one | two | 3 |
| four | five | 60 |
| seven | eight | 900 |

## Inline constructs in cells

| Cell | Content |
| --- | --- |
| Emphasis | *emphasis*, **strong**, `code` |
| Link | [the boot profile](../boot-profile.md) |
| Strikethrough | ~~withdrawn~~, replaced |
| Escaped pipe | a \| inside a cell |
| Empty | |

## Ragged source rows

A delimiter row sets the column count; the body rows need not line up in the
source, and a short row is padded.

| Command | Writes | Reads |
| --- | --- | --- |
| `leji export` | `.leji/dist/` | the context root |
| `leji validate` | nothing |
| `leji index` | `context-index.json` | the index files | ignored |

## The metadata-header convention

An empty header row carries a two-column metadata block. The viewer hides the
blank header; other renderers show it, and both are conforming.

| | |
|---|---|
| **Tier** | Public |
| **Status** | Fixture |

## Strikethrough in prose

The old name is ~~`viewer build --dist`~~ and the current spelling is
`leji export --out`.
