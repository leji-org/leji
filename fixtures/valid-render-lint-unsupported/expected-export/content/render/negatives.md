<!--
   The boundary and negative families: constructs that look linted and are not.
   This file plants one case per family and reports NO finding at all, which is
   the assertion. A detector that fires here cries wolf, and a lint that cries
   wolf gets ignored.

   Families, in order below: code spans, fenced blocks, escaped delimiters, and an
   unpaired `$$`.

   The escape rule covers all three constructs, footnote syntax included.

   Editing note: the last line of this file is the one bare `$$` in it. A second
   one anywhere outside a code span or a fence would pair with it and turn this
   file into a positive case.
-->

# Negatives

## Inside a code span

The tag `<div>` names a construct without being one. So do `</section>`,
`<img src="x.svg" />`, `[^ref]`, `[^ref]: text`, and `$$x$$`: a code span is an
excluded region, scanned before anything else.

A span may be spelled with two backticks when its content carries one: ``a `<b>` span``.

## Inside a fenced block

A fence is an excluded region too, whatever its info string:

```html
<div class="callout">
   <p>Raw HTML as the subject of the documentation, not as markup.</p>
</div>
```

```markdown
A reference[^one] and its definition.

[^one]: The definition.

$$
a^2 + b^2 = c^2
$$
```

````markdown
A fence nested inside a longer fence stays excluded:

```html
<span>still not markup</span>
```
````

## Escaped delimiters

An escaped angle bracket is a literal character, not a tag: \<div> and
\<b>bold\</b> are prose.

An escaped bracket is not a footnote reference: \[^one] in a sentence. The
definition form is prose too when its bracket is escaped:

\[^one]: not a definition, because the bracket is escaped.

Escaped delimiters are not math: \$\$ a^2 + b^2 = c^2 \$\$ is prose about the
notation.

## An unpaired delimiter

A single delimiter with no closing partner is prose, and the lint requires a
pair, so the line below reports nothing.

$$
