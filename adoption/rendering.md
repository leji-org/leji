# Rendering a Leji context layer

A Leji context layer is markdown, and markdown renderers disagree. This document
fixes which constructs a context layer may rely on, so that a document written
once reads the same in the reference viewer, on a git host, in an editor preview,
and in any other renderer that claims Leji view compatibility.

## What this document is

It is the **compatibility profile** for rendering: binding on any renderer that
claims to display a Leji context layer faithfully, and on any tool that generates
documents into one.

It is **not** part of the specification. It does not live in `spec/`, it defines
no conformance requirement, and it changes nothing about what `leji conformance`
reports. Conformance never requires rendering at all: a context layer is read by
people in an editor, by agents through the file system, and only sometimes by a
browser. What this profile governs is the compatibility claim, not the standard.

Two audiences use it. A **writer** learns which constructs are safe. A **renderer
author** learns what to support, what to leave alone, and what a Leji context
layer does not depend on.

## The supported subset

### CommonMark core

| Construct | Notes |
| --- | --- |
| ATX headings (`#` to `######`) | the H1 of a document is its title in generated navigation |
| Setext headings (`===`, `---` underlines) | equivalent to ATX levels one and two |
| Paragraphs and soft breaks | a single newline inside a paragraph is a space |
| Hard breaks | two trailing spaces, or a trailing backslash |
| Emphasis and strong emphasis | both the `*` and `_` spellings |
| Inline code spans | including the multiple-backtick form |
| Links | inline, reference, and relative paths between documents |
| Images | relative paths, resolved against the document that carries them |
| Blockquotes | including nested quotes |
| Lists | ordered, unordered, nested, tight and loose |
| Fenced code blocks | with or without an info string |
| Indented code blocks | four spaces |
| Thematic breaks | `---`, `***`, `___` |

### GFM extensions

| Construct | Notes |
| --- | --- |
| Tables | with per-column alignment; a leading empty header row is the metadata-block convention |
| Strikethrough | `~~text~~` |
| Task lists | `- [ ]` and `- [x]` |

Everything else is outside the subset. Being outside it is not a prohibition, and
nothing rejects a document for it. It means the rendering is the renderer's
choice, so a context layer that depends on it reads differently for different
readers.

## Leji semantics

Five behaviors belong to Leji rather than to markdown, and only this document
states them.

**YAML frontmatter is metadata and is never rendered.** Agent profiles and
decision records carry frontmatter as their machine contract. A renderer strips a
leading `---` block and shows the body; the first visible element of such a
document is its heading. Only a leading block is frontmatter: a `---` line later
in a document is a thematic break.

**A `mermaid` fence renders as a diagram where the renderer supports mermaid, and
as a code block where it does not.** Both are conforming. Diagram support is
therefore never a compatibility requirement, and a writer can use a diagram
without stranding a reader whose renderer has none. The layer map on an overview
page uses this fence: the seeded page leaves its markers empty, and the viewer and
`leji export` render the map between them when the page is read.

**A `leji-index` fence is data and renders as code.** The block is the curated
category map that tooling parses; a renderer displays it and never interprets it.
Highlighting it or leaving it plain are both fine. What matters is that the bytes
reach the reader as data rather than as interpreted markup.

**HTML comments are legal and invisible.** They are the one HTML form a context
layer uses, because Leji's own markers are comments: a generated block is
delimited by comment markers so what sits between them can be rewritten, or
substituted at render time, and the surrounding prose left alone. A renderer shows
nothing for a comment, and keeps the comment in the bytes it serves so the next
pass still finds its markers. Invisible does not mean structurally inert: a comment that opens a line
absorbs the rest of that line into an HTML block (the CommonMark type-2 rule), so
prose after it on the same line ends up outside the surrounding paragraph. A
comment meant to sit mid-paragraph goes after text on its line, never first.

**A fence whose info string is outside the renderer's highlight set renders as
unhighlighted code, and that is conforming.** The reference viewer vendors a small
set (`bash`, `json`, `markdown`, `typescript`, plus what the vendored highlighter
carries by default). A fence tagged with anything else, `toml` or `zsh` or a
language nobody highlights, still renders as a code block. Highlighting is
decoration, so no context layer depends on it and no renderer owes any particular
set.

## Outside the subset, and reported

Three constructs are outside the subset and are reported by `leji export`, which
walks every markdown document the export carries:

| Construct token | What it matches |
| --- | --- |
| `raw-html` | raw HTML elements, in block or inline position; comments are excepted |
| `footnote` | footnote definitions and references (`[^id]:` and `[^id]`) |
| `math-block` | a paired `$$` display-math delimiter |

Each is reported as a `render-unsupported` finding at `warning` severity, with the
document path, the line the construct opens on, and the construct token. Warnings
never gate a run: the export is written and the command exits `0`, because a
context layer's build does not break on prose. `leji export --strict` promotes any
such finding to a failing exit and writes no export, which is the form for a
pipeline that wants the profile enforced.

### Why only these three

Each of the three is **mechanically detectable** and **genuinely divergent**.
Detectable means a small scanner finds it with no false alarms once code spans,
fenced blocks, and frontmatter are excluded. Divergent means renderers really do
disagree: raw HTML is passed through by some renderers, sanitized by others, and
stripped by the rest, and the sanitizing ones disagree about which elements and
attributes survive; footnote syntax is neither CommonMark nor GFM core, so it
becomes a linked marker in one renderer and literal brackets in another; `$$` math
needs a math runtime, and a renderer without one shows the delimiters.

Three constructs the profile deliberately does **not** report:

- **Inline `$`.** A currency amount and a shell variable both spell it. Detection
  would be ambiguous, so the report would be noise.
- **Unknown fence info strings.** The fallback is already conforming, as stated
  above, so there is nothing to warn about.
- **Definition-list and other loosely conventional prose shapes.** No agreed
  syntax exists to detect, and the plain-paragraph fallback reads fine.

A report that fires on the ambiguous cases gets switched off, and then it protects
nothing. The closed set of three is what keeps it worth reading.

## The fixtures are the enumeration

Prose fixes the intent; the shared fixtures fix the edges. Three of them carry
this profile:

- `fixtures/valid-render-subset` is a sample context layer exercising every
  construct named above, one document per family. Its exported bytes are the
  canonical served form, so an independent renderer can read exactly what the
  reference viewer reads. They are committed with the fixture: the content tree as
  real bytes under `expected-export/`, the chrome and vendored assets as sha256
  digests in `expected-export.manifest.json`.
- `fixtures/valid-render-lint-unsupported` plants each reported construct at a
  known line, together with the boundary cases that must stay quiet: HTML-looking
  text inside code spans and fences, an unpaired `$$`, escaped delimiters, and
  frontmatter carrying a tag. Its export bytes are committed the same way.
- `fixtures/valid-render-lint-strict` drives the same context layer with
  `--strict`, which writes no export, so that fixture has no bytes to pin.

All three reference SDKs run these fixtures, and they report identically. A
renderer that wants to check itself against this profile finds what it needs in
the same public repository: the sample documents, this document, and the
committed export bytes.

## Versioning

This profile travels with the reference tooling that implements it, not with the
specification: the specification stays still while the tooling releases, and this
document and the fixtures beside it state what a given tooling release supports.
A renderer checking itself against the profile therefore checks itself against a
release, and the fixtures in that release are the exact statement.
