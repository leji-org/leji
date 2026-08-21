---
title: Frontmatter that looks like markup
summary: A YAML value carrying <div> is metadata, never raw HTML.
note: 'A value may carry $$ and [^ref] too, and stays metadata'
banner: <section class="hero">
---

<!--
   The frontmatter boundary, planted as a negative: the block above carries a
   tag, a footnote-looking token, and a math delimiter, and this file reports NO
   finding. Frontmatter is metadata that no renderer shows, so nothing in it can
   diverge across renderers.

   The boundary is the closing `---` of a leading block only. A `---` anywhere
   else in a document is a thematic break, which is why the break below is not
   read as an opening delimiter.
-->

# Frontmatter is an excluded region

The block at the top of this file is scanned as metadata and skipped.

---

Prose after a thematic break, which the excluded-region pass must not mistake for
a second frontmatter block. Nothing here is a linted construct.
