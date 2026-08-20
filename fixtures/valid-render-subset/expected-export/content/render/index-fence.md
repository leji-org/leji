<!--
   Leji-specific semantics: a ```leji-index fence is data, and a renderer shows it
   as a code block rather than interpreting it. Inside the supported rendering
   subset, never a lint finding.

   This document is reference content, not a declared category index, so the block
   below declares nothing: only the index files named in leji.json are parsed
   (docs/context/domain.md and docs/context/decisions.md carry the live blocks).
   The fence is here so a renderer has the construct to render.
-->

# Index blocks

An intent block, the default kind:

```leji-index
- path: docs/domain/
```

A record block, and an entry carrying a trailing comment:

```leji-index record
- path: docs/decisions/ # every record in the directory
```

Both render as code. A renderer that highlighted the block, or hid it, would
still be conforming: the requirement is that the bytes reach the reader as data
and not as interpreted markup.
